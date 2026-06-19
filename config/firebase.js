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
  });
}

const db = admin.firestore();

module.exports = { admin, db };
