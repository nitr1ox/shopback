const { db } = require('../config/firebase');

const PRODUCTS_COLLECTION = 'products';

async function consumeKey(productId, duration) {
  const productRef = db.collection(PRODUCTS_COLLECTION).doc(productId);

  return db.runTransaction(async (tx) => {
    const doc = await tx.get(productRef);
    if (!doc.exists) {
      throw new Error('Produit introuvable.');
    }

    const product = doc.data();
    const keys = (product.keys && product.keys[duration]) || [];

    if (keys.length === 0) {
      const err = new Error('Stock épuisé pour cette offre.');
      err.code = 'OUT_OF_STOCK';
      throw err;
    }

    const [consumedKey, ...remaining] = keys;
    const updatedKeys = { ...(product.keys || {}), [duration]: remaining };

    tx.update(productRef, { keys: updatedKeys });

    return consumedKey;
  });
}

module.exports = { consumeKey };
