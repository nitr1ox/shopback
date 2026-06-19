const LTC_ADDRESS = process.env.LTC_ADDRESS;
const RATE_API_URL = process.env.LTC_RATE_API
  || 'https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=eur';
const BLOCKCYPHER_BASE = 'https://api.blockcypher.com/v1/ltc/main';

if (!LTC_ADDRESS) {
  console.warn('⚠️  LTC_ADDRESS manquant dans .env — le paiement Litecoin sera indisponible.');
}

async function getLtcEurRate() {
  const res = await fetch(RATE_API_URL);
  if (!res.ok) throw new Error('Impossible de récupérer le taux LTC/EUR.');
  const data = await res.json();
  const rate = data?.litecoin?.eur;
  if (!rate) throw new Error('Taux LTC/EUR introuvable dans la réponse.');
  return rate;
}

function eurToLtc(amountEur, rate) {
  return Number((amountEur / rate).toFixed(8));
}

async function getReceivedSince(sinceIso) {
  if (!LTC_ADDRESS) throw new Error('LTC_ADDRESS non configuré.');

  const res = await fetch(`${BLOCKCYPHER_BASE}/addrs/${LTC_ADDRESS}/full?limit=50`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Erreur BlockCypher: ${res.status} ${text}`);
  }
  const data = await res.json();
  const since = new Date(sinceIso).getTime();

  let totalLitoshis = 0;
  let confirmedTotalLitoshis = 0;

  for (const tx of data.txs || []) {
    const txTime = new Date(tx.confirmed || tx.received).getTime();
    if (txTime < since) continue;

    for (const out of tx.outputs || []) {
      if (out.addresses && out.addresses.includes(LTC_ADDRESS)) {
        totalLitoshis += out.value;
        if (tx.confirmations && tx.confirmations >= 1) {
          confirmedTotalLitoshis += out.value;
        }
      }
    }
  }

  return {
    totalLtc: totalLitoshis / 1e8,
    confirmedLtc: confirmedTotalLitoshis / 1e8,
  };
}

module.exports = { LTC_ADDRESS, getLtcEurRate, eurToLtc, getReceivedSince };
