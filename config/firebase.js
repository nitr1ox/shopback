const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

function loadCredentials() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  }

  const localPath = path.join(__dirname, '..', 'serviceAccountKey.json');
  if (fs.existsSync(localPath)) {
    return require(localPath);
  }

  throw new Error(
    'Aucune credential Firebase trouvée. Définis FIREBASE_SERVICE_ACCOUNT ' +
    'ou place un fichier serviceAccountKey.json à la racine du projet.'
  );
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(loadCredentials()),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || undefined,
  });
}

const db = admin.firestore();

let bucket = null;
function getBucket() {
  if (!process.env.FIREBASE_STORAGE_BUCKET) {
    throw new Error(
      'FIREBASE_STORAGE_BUCKET manquant dans .env — nécessaire pour uploader des images.'
    );
  }
  if (!bucket) {
    bucket = admin.storage().bucket();
  }
  return bucket;
}

module.exports = { admin, db, getBucket };
