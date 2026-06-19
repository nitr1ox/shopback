# AK-47 Shop — Backend (Express + Firebase)

API REST pour gérer les produits du shop, avec Firestore comme base de données.

## 1. Installation

```bash
cd backend
npm install
```

## 2. Configurer Firebase

1. Va sur [console.firebase.google.com](https://console.firebase.google.com), crée (ou ouvre) ton projet.
2. Active **Firestore Database** (mode production ou test, peu importe pour commencer).
3. Va dans **Paramètres du projet > Comptes de service > Générer une nouvelle clé privée**.
4. Un fichier JSON se télécharge. Renomme-le `serviceAccountKey.json` et place-le **à la racine du dossier `backend/`** (au même niveau que `server.js`).
   - Ce fichier est déjà dans `.gitignore`, ne le commit jamais.

Si tu déploies (Render, Railway, etc.), colle plutôt le contenu de ce JSON dans la variable d'environnement `FIREBASE_SERVICE_ACCOUNT` (voir `.env.example`).

## 3. Lancer le serveur

```bash
npm start
# ou en mode dev avec rechargement auto :
npm run dev
```

Le serveur tourne sur `http://localhost:3000`.

## 4. Endpoints disponibles

| Méthode | Route                  | Description                                  |
|---------|------------------------|-----------------------------------------------|
| GET     | `/api/products`        | Produits **actifs** uniquement (pour shop.html) |
| GET     | `/api/products/all`    | Tous les produits (pour admin.html)           |
| GET     | `/api/products/:id`    | Un produit précis                             |
| POST    | `/api/products`        | Créer un produit                              |
| PUT     | `/api/products/:id`    | Modifier un produit                           |
| DELETE  | `/api/products/:id`    | Supprimer un produit                          |
| POST    | `/api/payments/create-order`            | Crée une commande PayPal pour un produit (`{ productId }`) |
| POST    | `/api/payments/capture-order/:orderId`  | Capture le paiement après approbation par l'utilisateur |
| GET     | `/api/payments/orders`                  | Liste toutes les commandes/paiements (admin)  |

### Format d'un produit (body JSON pour POST/PUT)

```json
{
  "name": "Plan Mensuel",
  "price": 14.99,
  "duration": "1 mois",
  "status": "active",
  "featured": true,
  "features": ["Accès complet", "Support prioritaire"]
}
```

## 5. Configurer PayPal

1. Crée un compte développeur sur [developer.paypal.com](https://developer.paypal.com/dashboard/applications).
2. Dans **Apps & Credentials**, crée une app en mode **Sandbox** (pour tester avec de faux comptes PayPal).
3. Copie le **Client ID** et le **Secret** dans ton `.env` :

```
PAYPAL_CLIENT_ID=...
PAYPAL_CLIENT_SECRET=...
PAYPAL_MODE=sandbox
```

4. Quand tu es prêt pour la prod, crée une app **Live**, remplace les identifiants et passe `PAYPAL_MODE=live`.

### Flux de paiement

1. Le frontend appelle `POST /api/payments/create-order` avec `{ productId }` → reçoit un `orderId` PayPal.
2. Le frontend utilise ce `orderId` avec le **PayPal JS SDK** (boutons PayPal) côté `shop.html` pour que l'utilisateur approuve le paiement.
3. Une fois approuvé, le frontend appelle `POST /api/payments/capture-order/:orderId` → le serveur capture réellement les fonds et enregistre la commande comme `paid` dans Firestore (collection `orders`).

Exemple d'intégration des boutons PayPal côté `shop.html` :

```html
<script src="https://www.paypal.com/sdk/js?client-id=TON_CLIENT_ID_PUBLIC&currency=EUR"></script>
<div id="paypal-button-container"></div>

<script>
paypal.Buttons({
  createOrder: async () => {
    const res = await fetch('http://localhost:3000/api/payments/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: 'ID_DU_PRODUIT' })
    });
    const data = await res.json();
    return data.id;
  },
  onApprove: async (data) => {
    const res = await fetch(`http://localhost:3000/api/payments/capture-order/${data.orderID}`, {
      method: 'POST'
    });
    const result = await res.json();
    if (result.success) alert('Paiement réussi ✓');
  }
}).render('#paypal-button-container');
</script>
```

⚠️ Le `client-id` utilisé dans le `<script src="...">` est le **Client ID public** (sans risque à exposer côté frontend). Le **Secret**, lui, ne doit jamais quitter le serveur — il reste uniquement dans `.env`.

## 6. Brancher le frontend (produits)

Dans `shop.html` et `admin.html`, il faut remplacer les appels `localStorage` par des appels `fetch` vers l'API. Exemple pour `shop.html` :

```js
async function renderShop() {
  const res = await fetch('http://localhost:3000/api/products');
  const products = await res.json();
  // ... reste du code de rendu identique
}
```

Et pour `admin.html`, remplacer `save()` / chargement initial par des appels POST/PUT/DELETE vers `/api/products`. Dis-moi si tu veux que je fasse cette intégration directement dans les deux fichiers HTML.
