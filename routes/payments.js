const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const { getAccessToken, BASE_URL } = require('../config/paypal');
const { LTC_ADDRESS, getLtcEurRate, eurToLtc, getReceivedSince } = require('../config/litecoin');
const { sendOrderKeyEmail } = require('../config/mailer');
const { generateKey } = require('../utils/generateKey');
const { requireAuth } = require('../middleware/auth');
const { createOrderLimiter, captureOrderLimiter, checkLtcLimiter } = require('../middleware/rateLimiter');

const PRODUCTS_COLLECTION = 'products';
const ORDERS_COLLECTION = 'orders';

const LTC_ORDER_TTL_MS = 30 * 60 * 1000;

router.post('/create-order', createOrderLimiter, async (req, res) => {
  try {
    const { productId, email } = req.body;
    if (!productId) return res.status(400).json({ error: 'productId requis.' });
    if (!email) return res.status(400).json({ error: 'email requis pour recevoir la clé.' });

    const productDoc = await db.collection(PRODUCTS_COLLECTION).doc(productId).get();
    if (!productDoc.exists) return res.status(404).json({ error: 'Produit introuvable.' });

    const product = productDoc.data();
    if (product.status !== 'active') {
      return res.status(400).json({ error: 'Ce produit n\'est plus disponible.' });
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
            description: product.name,
            amount: {
              currency_code: 'EUR',
              value: Number(product.price).toFixed(2),
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
      amount: Number(product.price),
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

      accessKey = generateKey();
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

router.post('/create-order-ltc', createOrderLimiter, async (req, res) => {
  try {
    const { productId, email } = req.body;
    if (!productId) return res.status(400).json({ error: 'productId requis.' });
    if (!email) return res.status(400).json({ error: 'email requis pour recevoir la clé.' });
    if (!LTC_ADDRESS) return res.status(503).json({ error: 'Paiement Litecoin non configuré (LTC_ADDRESS manquant).' });

    const productDoc = await db.collection(PRODUCTS_COLLECTION).doc(productId).get();
    if (!productDoc.exists) return res.status(404).json({ error: 'Produit introuvable.' });

    const product = productDoc.data();
    if (product.status !== 'active') {
      return res.status(400).json({ error: 'Ce produit n\'est plus disponible.' });
    }

    const rate = await getLtcEurRate();
    const amountLtc = eurToLtc(Number(product.price), rate);
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + LTC_ORDER_TTL_MS).toISOString();

    const orderRef = await db.collection(ORDERS_COLLECTION).add({
      method: 'ltc',
      productId,
      productName: product.name,
      amountEur: Number(product.price),
      amountLtc,
      ltcEurRate: rate,
      address: LTC_ADDRESS,
      customerEmail: email,
      status: 'pending',
      createdAt,
      expiresAt,
    });

    res.status(201).json({
      id: orderRef.id,
      address: LTC_ADDRESS,
      amountLtc,
      amountEur: Number(product.price),
      rate,
      expiresAt,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur lors de la création de la commande LTC.' });
  }
});

router.get('/check-ltc/:orderId', checkLtcLimiter, async (req, res) => {
  try {
    const { orderId } = req.params;
    const orderRef = db.collection(ORDERS_COLLECTION).doc(orderId);
    const orderDoc = await orderRef.get();
    if (!orderDoc.exists) return res.status(404).json({ error: 'Commande introuvable.' });

    const order = orderDoc.data();
    if (order.method !== 'ltc') {
      return res.status(400).json({ error: 'Cette commande n\'est pas une commande Litecoin.' });
    }

    if (order.status === 'paid') {
      return res.json({ status: 'paid', orderId });
    }

    if (order.status === 'pending' || order.status === 'pending_confirmation') {
      const expiresAt = order.expiresAt ? new Date(order.expiresAt).getTime() : null;
      if (expiresAt && Date.now() > expiresAt) {
        await orderRef.update({ status: 'expired' });
        return res.status(410).json({
          status: 'expired',
          orderId,
          error: 'Commande expirée. Veuillez créer une nouvelle commande.',
        });
      }
    }

    if (order.status === 'expired') {
      return res.status(410).json({
        status: 'expired',
        orderId,
        error: 'Commande expirée. Veuillez créer une nouvelle commande.',
      });
    }

    const { totalLtc, confirmedLtc } = await getReceivedSince(order.createdAt);
    const expected = order.amountLtc * 0.99;

    if (confirmedLtc >= expected) {
      const accessKey = generateKey();
      await orderRef.update({
        status: 'paid',
        confirmedLtc,
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

      return res.json({ status: 'paid', orderId, confirmedLtc, accessKey });
    }

    if (totalLtc >= expected) {
      await orderRef.update({ status: 'pending_confirmation', totalLtc });
      return res.json({ status: 'pending_confirmation', orderId, totalLtc });
    }

    res.json({
      status: 'pending',
      orderId,
      totalLtc,
      confirmedLtc,
      expected: order.amountLtc,
      expiresAt: order.expiresAt,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur lors de la vérification du paiement LTC.' });
  }
});

module.exports = router;
