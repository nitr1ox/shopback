require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const productsRouter    = require('./routes/products');
const paymentsRouter    = require('./routes/payments');
const authRouter        = require('./routes/auth');
const adminRouter       = require('./routes/admin');
const errorHandler      = require('./middleware/errorHandler');
const { loginLimiter, uploadLimiter } = require('./middleware/rateLimiter');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());

app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.header('x-forwarded-proto') !== 'https') {
    res.redirect(`https://${req.header('host')}${req.url}`);
  } else {
    next();
  }
});

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : [];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origine non autorisée — ${origin}`));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'AK-47 Shop API en ligne' });
});

app.use('/api/auth', loginLimiter, authRouter);
app.use('/api/products', productsRouter);
app.use('/api/products/upload-image', uploadLimiter);
app.use('/api/payments', paymentsRouter);
app.use('/api/admin', adminRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Route introuvable.' });
});

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
});
