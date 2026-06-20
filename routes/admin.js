const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const { requireAuth } = require('../middleware/auth');

router.get('/stats', requireAuth, async (req, res) => {
  try {
    const ordersSnap = await db.collection('orders').get();
    const productsSnap = await db.collection('products').get();
    
    let totalRevenue = 0;
    let totalOrders = 0;
    const productStats = {};
    
    ordersSnap.docs.forEach(doc => {
      const order = doc.data();
      if (order.status === 'completed') {
        totalRevenue += Number(order.amount || 0);
        totalOrders += 1;
        const productId = order.productId;
        productStats[productId] = (productStats[productId] || 0) + 1;
      }
    });

    const products = productsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const topProducts = Object.entries(productStats)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, count]) => {
        const prod = products.find(p => p.id === id);
        return { id, name: prod?.name || 'Inconnu', sales: count };
      });

    res.json({
      totalRevenue: totalRevenue.toFixed(2),
      totalOrders,
      totalProducts: products.length,
      topProducts,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur stats.' });
  }
});

router.get('/export/csv', requireAuth, async (req, res) => {
  try {
    const ordersSnap = await db.collection('orders').get();
    
    let csv = 'Order ID,Date,Product,Amount,Status,Payment Method\n';
    ordersSnap.docs.forEach(doc => {
      const order = doc.data();
      const date = new Date(order.createdAt).toLocaleString('fr-FR');
      csv += `"${doc.id}","${date}","${order.productName || 'N/A'}","${order.amount || 0}","${order.status || 'pending'}","${order.paymentMethod || 'N/A'}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="orders-export.csv"');
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur export.' });
  }
});

module.exports = router;
