const fetch = require('node-fetch');
require('dotenv').config();

const API = process.env.API_URL || 'http://localhost:3000/api';
const ADMIN_TOKEN = process.env.TEST_ADMIN_TOKEN;

if (!ADMIN_TOKEN) {
  console.error('TEST_ADMIN_TOKEN manquant dans .env');
  process.exit(1);
}

async function testStats() {
  console.log('\n📊 Test Stats API...');
  try {
    const res = await fetch(`${API}/admin/stats`, {
      headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` }
    });
    const data = await res.json();
    console.log('✓ Stats récupérées:', data);
  } catch (err) {
    console.error('✗ Erreur stats:', err.message);
  }
}

async function testSearch() {
  console.log('\n🔍 Test Recherche...');
  try {
    const res = await fetch(`${API}/products?search=script&limit=5`);
    const data = await res.json();
    console.log(`✓ ${data.data.length} produits trouvés`);
  } catch (err) {
    console.error('✗ Erreur recherche:', err.message);
  }
}

async function testPagination() {
  console.log('\n📄 Test Pagination...');
  try {
    const res = await fetch(`${API}/products?page=1&limit=3`);
    const data = await res.json();
    console.log(`✓ Page 1: ${data.data.length}/${data.total} produits, ${data.pages} pages total`);
  } catch (err) {
    console.error('✗ Erreur pagination:', err.message);
  }
}

async function testSort() {
  console.log('\n↕️ Test Tri par prix...');
  try {
    const res = await fetch(`${API}/products?sort=price_asc&limit=3`);
    const data = await res.json();
    if (data.data.length > 0) {
      const prices = data.data.map(p => Math.min(...Object.values(p.prices || {})));
      console.log(`✓ Tri ok, prix: ${prices.join(', ')}`);
    }
  } catch (err) {
    console.error('✗ Erreur tri:', err.message);
  }
}

async function testCategories() {
  console.log('\n◈ Test Catégories...');
  try {
    const res = await fetch(`${API}/products/categories`);
    const cats = await res.json();
    console.log(`✓ ${cats.length} catégories: ${cats.map(c => c.label).join(', ')}`);
  } catch (err) {
    console.error('✗ Erreur catégories:', err.message);
  }
}

async function runTests() {
  console.log('=== TEST SUITE ===');
  await testCategories();
  await testSearch();
  await testPagination();
  await testSort();
  await testStats();
  console.log('\n✓ Tests terminés\n');
}

runTests().catch(console.error);
