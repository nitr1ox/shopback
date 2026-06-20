const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const router = express.Router();
const { db, getBucket } = require('../config/firebase');
const { requireAuth } = require('../middleware/auth');

const COLLECTION = 'products';
const VALID_DURATIONS = ['1j', '1s', '1m', '3m', 'lifetime', 'custom'];

// ── Magic bytes pour validation MIME serveur ──
const MAGIC_NUMBERS = {
  '89504e47': 'image/png',
  'ffd8ffe0': 'image/jpeg',
  'ffd8ffe1': 'image/jpeg',
  'ffd8ffe2': 'image/jpeg',
  '47494638': 'image/gif',
  '52494646': 'image/webp',
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Format non supporté. Utilise PNG, JPG, WEBP ou GIF.'));
    }
    cb(null, true);
  },
});

function getMimeFromBuffer(buffer) {
  const hex = buffer.slice(0, 4).toString('hex');
  return MAGIC_NUMBERS[hex] || null;
}

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
  if (body.logo !== undefined && typeof body.logo !== 'string') errors.push('logo doit être une URL');
  if (body.images !== undefined) {
    if (!Array.isArray(body.images)) errors.push('images doit être un tableau');
    else if (body.images.some(img => typeof img !== 'string')) errors.push('chaque image doit être une URL');
  }
  if (body.features !== undefined && !Array.isArray(body.features)) errors.push('features doit être un tableau');
  if (body.status !== undefined && !['active', 'hidden'].includes(body.status)) errors.push("status doit être 'active' ou 'hidden'");
  if (body.category !== undefined && (typeof body.category !== 'string' || body.category.trim() === '')) errors.push('category doit être une chaîne non vide');
  errors.push(...validatePrices(body.prices || {}));
  return errors;
}

router.get('/', async (req, res) => {
  const { search, category, sort, page = 1, limit = 50 } = req.query;
  const pageNum = Math.max(1, parseInt(page) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 50));
  const skip = (pageNum - 1) * limitNum;

  try {
    let query = db.collection(COLLECTION).where('status', '==', 'active');

    const snap = await query.get();
    let products = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    if (category) {
      products = products.filter(p => (p.category || '') === category);
    }

    if (search) {
      const searchLower = search.toLowerCase();
      products = products.filter(p => 
        p.name.toLowerCase().includes(searchLower) || 
        (p.description || '').toLowerCase().includes(searchLower)
      );
    }

    if (sort === 'price_asc') {
      products.sort((a, b) => {
        const priceA = Math.min(...Object.values(a.prices || {}).map(Number));
        const priceB = Math.min(...Object.values(b.prices || {}).map(Number));
        return priceA - priceB;
      });
    } else if (sort === 'price_desc') {
      products.sort((a, b) => {
        const priceA = Math.max(...Object.values(a.prices || {}).map(Number));
        const priceB = Math.max(...Object.values(b.prices || {}).map(Number));
        return priceB - priceA;
      });
    } else if (sort === 'newest') {
      products.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    } else if (sort === 'featured') {
      products.sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0));
    }

    const total = products.length;
    const paginatedProducts = products.slice(skip, skip + limitNum);

    res.json({
      data: paginatedProducts,
      total,
      page: pageNum,
      limit: limitNum,
      pages: Math.ceil(total / limitNum),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lecture produits.' });
  }
});

router.get('/categories', async (req, res) => {
  try {
    const snap = await db.collection('categories').doc('_meta').get();
    const cats = snap.exists ? (snap.data().list || []) : [];
    res.json(cats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lecture catégories.' });
  }
});

router.post('/categories', requireAuth, async (req, res) => {
  const { list } = req.body;
  if (!Array.isArray(list)) return res.status(400).json({ error: 'list doit être un tableau.' });
  
  for (const cat of list) {
    if (!cat.id || typeof cat.id !== 'string') return res.status(400).json({ error: 'Chaque catégorie doit avoir un id.' });
    if (!cat.label || typeof cat.label !== 'string') return res.status(400).json({ error: 'Chaque catégorie doit avoir un label.' });
  }
  
  try {
    await db.collection('categories').doc('_meta').set({ list, updatedAt: new Date().toISOString() });
    res.json({ success: true, list });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur sauvegarde catégories.' });
  }
});

router.post('/upload-image', requireAuth, (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu.' });

    const realMime = getMimeFromBuffer(req.file.buffer);
    if (!realMime) return res.status(400).json({ error: 'Format image invalide (fichier corrompu).' });

    try {
      const bucket = getBucket();
      const ext = path.extname(req.file.originalname) || '.png';
      const filename = `products/${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
      const fileRef = bucket.file(filename);

      await fileRef.save(req.file.buffer, {
        metadata: { contentType: realMime },
        public: true,
      });

      await fileRef.makePublic();
      const url = `https://storage.googleapis.com/${bucket.name}/${filename}`;
      res.status(201).json({ url });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || 'Erreur upload.' });
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
      images: req.body.images || [],
      prices,
      keys: req.body.keys || {},
      status: req.body.status || 'active',
      featured: Boolean(req.body.featured),
      features: req.body.features || [],
      category: req.body.category || 'other',
      createdAt: new Date().toISOString(),
    };
    const snap = await db.collection(COLLECTION).add(newProduct);
    res.status(201).json({ id: snap.id, ...newProduct });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Erreur création.' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const doc = await db.collection(COLLECTION).doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Produit non trouvé.' });
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lecture.' });
  }
});

router.put('/:id', requireAuth, async (req, res) => {
  const errors = validateProductBody(req.body);
  if (errors.length) return res.status(400).json({ errors });

  try {
    const prices = req.body.prices || {};
    const updated = {
      name: req.body.name,
      description: req.body.description || '',
      logo: req.body.logo || '',
      images: req.body.images || [],
      prices,
      keys: req.body.keys || {},
      status: req.body.status || 'active',
      featured: Boolean(req.body.featured),
      features: req.body.features || [],
      category: req.body.category || 'other',
      updatedAt: new Date().toISOString(),
    };
    await db.collection(COLLECTION).doc(req.params.id).update(updated);
    res.json({ id: req.params.id, ...updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Erreur mise à jour.' });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await db.collection(COLLECTION).doc(req.params.id).delete();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur suppression.' });
  }
});

module.exports = router;
