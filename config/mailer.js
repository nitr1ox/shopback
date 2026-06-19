const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    console.warn('⚠️  Configuration SMTP incomplète dans .env — les emails ne seront pas envoyés.');
    return null;
  }

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  return transporter;
}

async function sendOrderKeyEmail({ to, productName, key, orderId }) {
  const tr = getTransporter();
  if (!tr) return { sent: false, reason: 'SMTP non configuré' };

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;

  await tr.sendMail({
    from,
    to,
    subject: `Votre clé d'accès — ${productName}`,
    text: [
      `Merci pour votre commande (réf. ${orderId}).`,
      ``,
      `Produit : ${productName}`,
      `Votre clé d'accès : ${key}`,
      ``,
      `Conservez précieusement cette clé.`,
    ].join('\n'),
    html: `
      <p>Merci pour votre commande (réf. ${orderId}).</p>
      <p><strong>Produit :</strong> ${productName}</p>
      <p><strong>Votre clé d'accès :</strong></p>
      <p style="font-size:18px; font-family:monospace; background:#f4f4f4; padding:10px; border-radius:6px; display:inline-block;">${key}</p>
      <p>Conservez précieusement cette clé.</p>
    `,
  });

  return { sent: true };
}

module.exports = { sendOrderKeyEmail };
