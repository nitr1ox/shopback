const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const { getAccessToken, BASE_URL } = require('../config/paypal');
const nowpayments = require('../config/nowpayments');
const { sendOrderKeyEmail } = require('../config/mailer');
const { consumeKey } = require('../utils/stock');
const { requireAuth } = require('../middleware/auth');
const { createOrderLimiter, captureOrderLimiter, checkLtcLimiter } = require('../middleware/rateLimiter');

const PRODUCTS_COLLECTION = 'products';
const ORDERS_COLLECTION = 'orders';

const DURATION_LABELS = {
  '1j': '1 Jour',
  '1s': '1 Semaine',
  '1m': '1 Mois',
  '3m': '3 Mois',
  'lifetime': 'Lifetime',
};

function getPriceForDuration(product, duration) {
  const prices = product.prices || {};
  if (!duration || prices[duration] === undefined) return null;
  return Number(prices[duration]);
}

router.post('/create-order', createOrderLimiter, async (req, res) => {
  try {
    const { productId, email, duration } = req.body;
    if (!productId) return res.status(400).json({ error: 'productId requis.' });
    if (!email) return res.status(400).json({ error: 'email requis pour recevoir la clé.' });

    const productDoc = await db.collection(PRODUCTS_COLLECTION).doc(productId).get();
    if (!productDoc.exists) return res.status(404).json({ error: 'Produit introuvable.' });

    const product = productDoc.data();
    if (product.status !== 'active') {
      return res.status(400).json({ error: 'Ce produit n\'est plus disponible.' });
    }

    const price = getPriceForDuration(product, duration);
    if (price === null) {
      return res.status(400).json({ error: 'Offre (durée) invalide pour ce produit.' });
    }

    const accessToken = await getAccessToken();

    const orderRes = await fetch(`${BASE_URL}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: productId,
            description: `${product.name} — ${DURATION_LABELS[duration] || duration}`,
            amount: {
              currency_code: 'EUR',
              value: price.toFixed(2),
            },
          },
        ],
      }),
    });

    const orderData = await orderRes.json();
    if (!orderRes.ok) {
      console.error('Erreur création commande PayPal:', orderData);
      return res.status(502).json({ error: 'Erreur PayPal lors de la création de la commande.' });
    }

    await db.collection(ORDERS_COLLECTION).doc(orderData.id).set({
      paypalOrderId: orderData.id,
      productId,
      productName: product.name,
      duration,
      amount: price,
      currency: 'EUR',
      customerEmail: email,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });

    res.status(201).json({ id: orderData.id, paypalClientId: process.env.PAYPAL_CLIENT_ID });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur lors de la création de la commande.' });
  }
});

router.post('/capture-order/:orderId', captureOrderLimiter, async (req, res) => {
  try {
    const { orderId } = req.params;

    const orderRef = db.collection(ORDERS_COLLECTION).doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) {
      return res.status(404).json({ error: 'Commande introuvable.' });
    }
    const orderInfo = orderSnap.data();

    if (orderInfo.status === 'paid') {
      return res.json({
        success: true,
        status: 'COMPLETED',
        orderId,
        accessKey: orderInfo.accessKey,
      });
    }

    const accessToken = await getAccessToken();

    const captureRes = await fetch(`${BASE_URL}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    const captureData = await captureRes.json();
    if (!captureRes.ok) {
      console.error('Erreur capture PayPal:', captureData);
      await orderRef.update({ status: 'failed' });
      return res.status(502).json({ error: 'Erreur PayPal lors de la capture du paiement.' });
    }

    const isCompleted = captureData.status === 'COMPLETED';

    const updateData = {
      status: isCompleted ? 'paid' : captureData.status.toLowerCase(),
      payer: {
        email: captureData.payer?.email_address || null,
        payerId: captureData.payer?.payer_id || null,
        name: captureData.payer?.name
          ? `${captureData.payer.name.given_name || ''} ${captureData.payer.name.surname || ''}`.trim()
          : null,
      },
      capturedAt: new Date().toISOString(),
    };

    let accessKey = null;

    if (isCompleted) {
      const captureUnit = captureData.purchase_units?.[0]?.payments?.captures?.[0];
      const capturedAmount = Number(captureUnit?.amount?.value);
      const capturedCurrency = captureUnit?.amount?.currency_code;

      const expectedAmount = Number(orderInfo.amount);
      const expectedCurrency = orderInfo.currency || 'EUR';

      const amountOk = !Number.isNaN(capturedAmount) && Math.abs(capturedAmount - expectedAmount) < 0.01;
      const currencyOk = capturedCurrency === expectedCurrency;

      if (!amountOk || !currencyOk) {
        console.error(
          `⚠️ Incohérence de montant sur la commande ${orderId} : ` +
          `attendu ${expectedAmount} ${expectedCurrency}, capturé ${capturedAmount} ${capturedCurrency}`
        );

        updateData.status = 'amount_mismatch';
        updateData.amountMismatch = {
          expectedAmount,
          expectedCurrency,
          capturedAmount,
          capturedCurrency,
        };
        await orderRef.update(updateData);

        return res.status(409).json({
          success: false,
          status: 'AMOUNT_MISMATCH',
          orderId,
          error: 'Le montant capturé ne correspond pas à la commande. Paiement mis en attente de vérification, contactez le support.',
        });
      }

      try {
        accessKey = await consumeKey(orderInfo.productId, orderInfo.duration);
      } catch (stockErr) {
        console.error(`⚠️ Stock épuisé pour la commande ${orderId} (paiement déjà capturé) :`, stockErr.message);
        updateData.status = 'paid_no_stock';
        updateData.stockError = stockErr.message;
        await orderRef.update(updateData);
        return res.status(202).json({
          success: true,
          status: 'PAID_NO_STOCK',
          orderId,
          error: 'Paiement confirmé mais stock de clés épuisé. Le support va te contacter pour te fournir ta clé.',
        });
      }
      updateData.accessKey = accessKey;

      const recipient = orderInfo.customerEmail || captureData.payer?.email_address;
      if (recipient) {
        try {
          await sendOrderKeyEmail({
            to: recipient,
            productName: orderInfo.productName || 'votre produit',
            key: accessKey,
            orderId,
          });
        } catch (mailErr) {
          console.error('Erreur envoi email clé:', mailErr);
        }
      }
    }

    await orderRef.update(updateData);

    res.json({
      success: isCompleted,
      status: captureData.status,
      orderId,
      accessKey: isCompleted ? accessKey : undefined,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur lors de la capture du paiement.' });
  }
});

router.get('/orders', requireAuth, async (req, res) => {
  try {
    const snapshot = await db.collection(ORDERS_COLLECTION).orderBy('createdAt', 'desc').get();
    const orders = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la récupération des commandes.' });
  }
});

router.get('/crypto-currencies', async (req, res) => {
  try {
    const data = await nowpayments.getAvailableCurrencies();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message || 'Erreur lors de la récupération des cryptos disponibles.' });
  }
});

router.post('/create-order-crypto', createOrderLimiter, async (req, res) => {
  try {
    const { productId, email, duration, payCurrency } = req.body;
    if (!productId) return res.status(400).json({ error: 'productId requis.' });
    if (!email) return res.status(400).json({ error: 'email requis pour recevoir la clé.' });
    if (!payCurrency) return res.status(400).json({ error: 'payCurrency requis (ex: btc, ltc, usdttrc20).' });

    const productDoc = await db.collection(PRODUCTS_COLLECTION).doc(productId).get();
    if (!productDoc.exists) return res.status(404).json({ error: 'Produit introuvable.' });

    const product = productDoc.data();
    if (product.status !== 'active') {
      return res.status(400).json({ error: 'Ce produit n\'est plus disponible.' });
    }

    const priceEur = getPriceForDuration(product, duration);
    if (priceEur === null) {
      return res.status(400).json({ error: 'Offre (durée) invalide pour ce produit.' });
    }

    const createdAt = new Date().toISOString();
    const orderRef = await db.collection(ORDERS_COLLECTION).add({
      method: 'crypto',
      provider: 'nowpayments',
      productId,
      productName: product.name,
      duration,
      amountEur: priceEur,
      payCurrency,
      customerEmail: email,
      status: 'pending',
      createdAt,
    });

    const ipnCallbackUrl = process.env.NOWPAYMENTS_IPN_CALLBACK_URL || undefined;

    let payment;
    try {
      payment = await nowpayments.createPayment({
        priceAmount: priceEur,
        priceCurrency: 'eur',
        payCurrency,
        orderId: orderRef.id,
        orderDescription: `${product.name} — ${DURATION_LABELS[duration] || duration}`,
        ipnCallbackUrl,
      });
    } catch (npErr) {
      await orderRef.update({ status: 'failed', error: npErr.message });
      return res.status(502).json({ error: npErr.message || 'Erreur lors de la création du paiement crypto.' });
    }

    await orderRef.update({
      nowpaymentsId: String(payment.payment_id),
      payAddress: payment.pay_address,
      payAmount: payment.pay_amount,
      payCurrency: payment.pay_currency,
      expiresAt: payment.expiration_estimate_date || null,
    });

    res.status(201).json({
      id: orderRef.id,
      paymentId: payment.payment_id,
      address: payment.pay_address,
      payAmount: payment.pay_amount,
      payCurrency: payment.pay_currency,
      amountEur: priceEur,
      expiresAt: payment.expiration_estimate_date || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur lors de la création de la commande crypto.' });
  }
});

router.post('/webhook/nowpayments', async (req, res) => {
  try {
    const signature = req.headers['x-nowpayments-sig'];
    let isValid;
    try {
      isValid = nowpayments.verifyIpnSignature(req.body, signature);
    } catch (sigErr) {
      console.error('Vérification IPN impossible:', sigErr.message);
      return res.status(500).json({ error: sigErr.message });
    }

    if (!isValid) {
      console.warn('⚠️ Signature IPN NOWPayments invalide reçue.');
      return res.status(401).json({ error: 'Signature invalide.' });
    }

    const payload = req.body;
    const orderId = payload.order_id;
    if (!orderId) return res.status(400).json({ error: 'order_id manquant dans le callback.' });

    const orderRef = db.collection(ORDERS_COLLECTION).doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) {
      console.warn(`Commande introuvable pour le callback NOWPayments : ${orderId}`);
      return res.status(404).json({ error: 'Commande introuvable.' });
    }

    const order = orderSnap.data();
    const npStatus = payload.payment_status;

    if (order.status === 'paid') {
      return res.json({ received: true, alreadyPaid: true });
    }

    if (nowpayments.PAID_STATUSES.includes(npStatus)) {
      let accessKey;
      try {
        accessKey = await consumeKey(order.productId, order.duration);
      } catch (stockErr) {
        console.error(`⚠️ Stock épuisé pour la commande ${orderId} (paiement NOWPayments déjà reçu) :`, stockErr.message);
        await orderRef.update({
          status: 'paid_no_stock',
          npStatus,
          actuallyPaid: payload.actually_paid,
          paidAt: new Date().toISOString(),
          stockError: stockErr.message,
        });
        return res.json({ received: true, stockIssue: true });
      }

      await orderRef.update({
        status: 'paid',
        npStatus,
        actuallyPaid: payload.actually_paid,
        paidAt: new Date().toISOString(),
        accessKey,
      });

      if (order.customerEmail) {
        try {
          await sendOrderKeyEmail({
            to: order.customerEmail,
            productName: order.productName,
            key: accessKey,
            orderId,
          });
        } catch (mailErr) {
          console.error('Erreur envoi email clé:', mailErr);
        }
      }
    } else if (nowpayments.FAILED_STATUSES.includes(npStatus)) {
      await orderRef.update({ status: npStatus === 'expired' ? 'expired' : 'failed', npStatus });
    } else {
      await orderRef.update({ status: 'pending_confirmation', npStatus });
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Erreur traitement webhook NOWPayments:', err);
    res.status(500).json({ error: 'Erreur serveur webhook.' });
  }
});

router.get('/check-crypto/:orderId', checkLtcLimiter, async (req, res) => {
  try {
    const { orderId } = req.params;
    const orderRef = db.collection(ORDERS_COLLECTION).doc(orderId);
    const orderDoc = await orderRef.get();
    if (!orderDoc.exists) return res.status(404).json({ error: 'Commande introuvable.' });

    const order = orderDoc.data();
    if (order.method !== 'crypto') {
      return res.status(400).json({ error: 'Cette commande n\'est pas une commande crypto.' });
    }

    if (order.status === 'paid') {
      return res.json({ status: 'paid', orderId, accessKey: order.accessKey });
    }

    if (!order.nowpaymentsId) {
      return res.json({ status: order.status, orderId });
    }

    const payment = await nowpayments.getPaymentStatus(order.nowpaymentsId);
    const npStatus = payment.payment_status;

    if (nowpayments.PAID_STATUSES.includes(npStatus) && order.status !== 'paid') {
      let accessKey;
      try {
        accessKey = await consumeKey(order.productId, order.duration);
      } catch (stockErr) {
        console.error(`⚠️ Stock épuisé pour la commande ${orderId} (paiement crypto déjà reçu) :`, stockErr.message);
        await orderRef.update({
          status: 'paid_no_stock',
          npStatus,
          paidAt: new Date().toISOString(),
          stockError: stockErr.message,
        });
        return res.status(202).json({
          status: 'paid_no_stock',
          orderId,
          error: 'Paiement confirmé mais stock de clés épuisé. Le support va te contacter pour te fournir ta clé.',
        });
      }

      await orderRef.update({
        status: 'paid',
        npStatus,
        paidAt: new Date().toISOString(),
        accessKey,
      });

      if (order.customerEmail) {
        try {
          await sendOrderKeyEmail({
            to: order.customerEmail,
            productName: order.productName,
            key: accessKey,
            orderId,
          });
        } catch (mailErr) {
          console.error('Erreur envoi email clé:', mailErr);
        }
      }

      return res.json({ status: 'paid', orderId, accessKey });
    }

    if (nowpayments.FAILED_STATUSES.includes(npStatus)) {
      const newStatus = npStatus === 'expired' ? 'expired' : 'failed';
      await orderRef.update({ status: newStatus, npStatus });
      return res.status(410).json({ status: newStatus, orderId, error: 'Paiement expiré ou échoué.' });
    }

    await orderRef.update({ npStatus });
    res.json({ status: 'pending', orderId, npStatus });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur lors de la vérification du paiement crypto.' });
  }
});

module.exports = router;
