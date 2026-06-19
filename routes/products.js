const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const router = express.Router();
const { db, getBucket } = require('../config/firebase');
const { requireAuth } = require('../middleware/auth');

const COLLECTION = 'products';
const VALID_DURATIONS = ['1j', '1s', '1m', '3m', 'lifetime'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 Mo max
  fileFilter: (req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Format non supporté. Utilise PNG, JPG, WEBP ou GIF.'));
    }
    cb(null, true);
  },
});

function validatePrices(prices) {
  if (typeof prices !== 'object' || prices === null || Array.isArray(prices)) {
    return ['prices doit être un objet { duration: prix }'];
  }
  const errors = [];
  const keys = Object.keys(prices);
  if (keys.length === 0) errors.push('Active au moins une durée avec un prix.');
  for (const k of keys) {
    if (!VALID_DURATIONS.includes(k)) errors.push(`Durée inconnue : ${k}`);
    if (isNaN(Number(prices[k])) || Number(prices[k]) < 0) errors.push(`Prix invalide pour ${k}`);
  }
  return errors;
}

function validateProductBody(body) {
  const errors = [];
  if (!body.name || typeof body.name !== 'string') errors.push('name requis');
  if (body.description !== undefined && typeof body.description !== 'string') errors.push('description doit être une chaîne');
  if (body.logo !== undefined && typeof body.logo !== 'string') errors.push('logo doit être une URL (chaîne)');
  if (body.features !== undefined && !Array.isArray(body.features)) errors.push('features doit être un tableau');
  if (body.status !== undefined && !['active', 'hidden'].includes(body.status)) errors.push("status doit être 'active' ou 'hidden'");
  errors.push(...validatePrices(body.prices || {}));
  return errors;
}

function toProduct(doc) {
  return { id: doc.id, ...doc.data() };
}

function priceRange(prices) {
  const values = Object.values(prices || {}).map(Number).filter(n => !isNaN(n));
  if (values.length === 0) return { min: 0, max: 0 };
  return { min: Math.min(...values), max: Math.max(...values) };
}

router.get('/', async (req, res) => {
  try {
    const snapshot = await db.collection(COLLECTION).where('status', '==', 'active').get();
    const products = snapshot.docs.map(toProduct).map(p => ({ ...p, ...priceRange(p.prices) }));
    res.json(products);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la récupération des produits.' });
  }
});

router.get('/all', requireAuth, async (req, res) => {
  try {
    const snapshot = await db.collection(COLLECTION).get();
    const products = snapshot.docs.map(toProduct).map(p => ({ ...p, ...priceRange(p.prices) }));
    res.json(products);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la récupération des produits.' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const doc = await db.collection(COLLECTION).doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Produit introuvable.' });
    const product = toProduct(doc);
    res.json({ ...product, ...priceRange(product.prices) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.post('/upload-image', requireAuth, (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu.' });

    try {
      const bucket = getBucket();
      const ext = path.extname(req.file.originalname) || '.png';
      const filename = `products/${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
      const fileRef = bucket.file(filename);

      await fileRef.save(req.file.buffer, {
        metadata: { contentType: req.file.mimetype },
        public: true,
      });

      await fileRef.makePublic();
      const url = `https://storage.googleapis.com/${bucket.name}/${filename}`;
      res.status(201).json({ url });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erreur lors de l'upload de l'image." });
    }
  });
});

router.post('/', requireAuth, async (req, res) => {
  const errors = validateProductBody(req.body);
  if (errors.length) return res.status(400).json({ errors });

  try {
    const prices = req.body.prices || {};
    const newProduct = {
      name: req.body.name,
      description: req.body.description || '',
      logo: req.body.logo || '',
      prices,
      keys: req.body.keys || {},
      status: req.body.status || 'active',
      featured: Boolean(req.body.featured),
      features: req.body.features || [],
      createdAt: new Date().toISOString(),
    };
    const ref = await db.collection(COLLECTION).add(newProduct);
    res.status(201).json({ id: ref.id, ...newProduct, ...priceRange(prices) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la création du produit.' });
  }
});

router.put('/:id', requireAuth, async (req, res) => {
  const errors = validateProductBody(req.body);
  if (errors.length) return res.status(400).json({ errors });

  try {
    const ref = db.collection(COLLECTION).doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Produit introuvable.' });

    const prices = req.body.prices || {};
    const updated = {
      name: req.body.name,
      description: req.body.description || '',
      logo: req.body.logo || '',
      prices,
      keys: req.body.keys || {},
      status: req.body.status || 'active',
      featured: Boolean(req.body.featured),
      features: req.body.features || [],
      updatedAt: new Date().toISOString(),
    };
    await ref.update(updated);
    res.json({ id: req.params.id, ...updated, ...priceRange(prices) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la mise à jour du produit.' });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const ref = db.collection(COLLECTION).doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Produit introuvable.' });

    await ref.delete();
    res.json({ success: true, id: req.params.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la suppression du produit.' });
  }
});

module.exports = router;
