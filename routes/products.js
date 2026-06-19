const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const { requireAuth } = require('../middleware/auth');

const COLLECTION = 'products';

function validateProductBody(body) {
  const errors = [];
  if (!body.name || typeof body.name !== 'string') errors.push('name requis');
  if (body.price === undefined || isNaN(Number(body.price))) errors.push('price requis (nombre)');
  if (body.duration !== undefined && typeof body.duration !== 'string') errors.push('duration doit être une chaîne');
  if (body.features !== undefined && !Array.isArray(body.features)) errors.push('features doit être un tableau');
  if (body.status !== undefined && !['active', 'hidden'].includes(body.status)) errors.push("status doit être 'active' ou 'hidden'");
  return errors;
}

function toProduct(doc) {
  return { id: doc.id, ...doc.data() };
}

router.get('/', async (req, res) => {
  try {
    const snapshot = await db.collection(COLLECTION).where('status', '==', 'active').get();
    const products = snapshot.docs.map(toProduct);
    res.json(products);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la récupération des produits.' });
  }
});

router.get('/all', requireAuth, async (req, res) => {
  try {
    const snapshot = await db.collection(COLLECTION).get();
    const products = snapshot.docs.map(toProduct);
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
    res.json(toProduct(doc));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.post('/', requireAuth, async (req, res) => {
  const errors = validateProductBody(req.body);
  if (errors.length) return res.status(400).json({ errors });

  try {
    const newProduct = {
      name: req.body.name,
      price: Number(req.body.price),
      duration: req.body.duration || '',
      status: req.body.status || 'active',
      featured: Boolean(req.body.featured),
      features: req.body.features || [],
      createdAt: new Date().toISOString(),
    };
    const ref = await db.collection(COLLECTION).add(newProduct);
    res.status(201).json({ id: ref.id, ...newProduct });
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

    const updated = {
      name: req.body.name,
      price: Number(req.body.price),
      duration: req.body.duration || '',
      status: req.body.status || 'active',
      featured: Boolean(req.body.featured),
      features: req.body.features || [],
      updatedAt: new Date().toISOString(),
    };
    await ref.update(updated);
    res.json({ id: req.params.id, ...updated });
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
