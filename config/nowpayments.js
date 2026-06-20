const crypto = require('crypto');

const API_KEY = process.env.NOWPAYMENTS_API_KEY;
const IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET;
const SANDBOX = process.env.NOWPAYMENTS_SANDBOX === 'true';

const BASE_URL = SANDBOX
  ? 'https://api-sandbox.nowpayments.io/v1'
  : 'https://api.nowpayments.io/v1';

if (!API_KEY) {
  console.warn('⚠️  NOWPAYMENTS_API_KEY manquant dans .env — le paiement crypto sera indisponible.');
}

async function npFetch(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'x-api-key': API_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok) {
    const message = data?.message || data?.error || `Erreur NOWPayments (${res.status})`;
    throw new Error(message);
  }
  return data;
}

async function createPayment({ priceAmount, priceCurrency, payCurrency, orderId, orderDescription, ipnCallbackUrl }) {
  return npFetch('/payment', {
    method: 'POST',
    body: JSON.stringify({
      price_amount: priceAmount,
      price_currency: priceCurrency,
      pay_currency: payCurrency,
      order_id: orderId,
      order_description: orderDescription,
      ipn_callback_url: ipnCallbackUrl,
    }),
  });
}

async function getPaymentStatus(paymentId) {
  return npFetch(`/payment/${paymentId}`, { method: 'GET' });
}

async function getAvailableCurrencies() {
  return npFetch('/currencies?fixed_rate=false', { method: 'GET' });
}

async function getMinimumAmount(currencyFrom, currencyTo = 'eur') {
  return npFetch(`/min-amount?currency_from=${currencyFrom}&currency_to=${currencyTo}`, { method: 'GET' });
}

const PAID_STATUSES = ['finished', 'confirmed'];
const PENDING_STATUSES = ['waiting', 'confirming', 'sending'];
const FAILED_STATUSES = ['failed', 'expired', 'refunded'];

function verifyIpnSignature(rawBody, signatureHeader) {
  if (!IPN_SECRET) {
    throw new Error('NOWPAYMENTS_IPN_SECRET manquant dans .env — impossible de vérifier la signature IPN.');
  }
  if (!signatureHeader) return false;

  const sorted = Object.keys(rawBody).sort().reduce((acc, key) => {
    acc[key] = rawBody[key];
    return acc;
  }, {});
  const payloadString = JSON.stringify(sorted);

  const expectedSig = crypto
    .createHmac('sha512', IPN_SECRET)
    .update(payloadString)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(signatureHeader));
}

module.exports = {
  createPayment,
  getPaymentStatus,
  getAvailableCurrencies,
  getMinimumAmount,
  verifyIpnSignature,
  PAID_STATUSES,
  PENDING_STATUSES,
  FAILED_STATUSES,
};
