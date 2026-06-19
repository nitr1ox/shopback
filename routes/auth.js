const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcrypt');

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;

if (!ADMIN_USERNAME || !ADMIN_PASSWORD_HASH) {
  console.warn('⚠️  ADMIN_USERNAME ou ADMIN_PASSWORD_HASH manquant dans .env — login admin désactivé.');
}

router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'username et password requis.' });
  }

  if (!ADMIN_USERNAME || !ADMIN_PASSWORD_HASH) {
    return res.status(503).json({ error: 'Auth admin non configurée sur ce serveur.' });
  }

  const usernameOk = crypto.timingSafeEqual(
    Buffer.from(username.padEnd(64).slice(0, 64)),
    Buffer.from(ADMIN_USERNAME.padEnd(64).slice(0, 64))
  );

  const passwordOk = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);

  if (!usernameOk || !passwordOk) {
    return res.status(401).json({ error: 'Identifiants incorrects.' });
  }

  const token = jwt.sign(
    { username: ADMIN_USERNAME },
    JWT_SECRET,
    { expiresIn: '24h' }
  );

  res.json({
    token,
    expiresIn: 86400,
    message: 'Connecté avec succès.',
  });
});

const { requireAuth } = require('../middleware/auth');
router.get('/me', requireAuth, (req, res) => {
  res.json({ username: req.admin.username, valid: true });
});

module.exports = router;
