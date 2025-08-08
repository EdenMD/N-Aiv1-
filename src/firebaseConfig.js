const admin = require('firebase-admin');

function initializeFirebase() {
  if (!admin.apps.length) {
    try {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL,
        projectId: process.env.FIREBASE_PROJECT_ID // Added for Firestore
      });
      console.log('Firebase initialized successfully from GitHub Actions.');
    } catch (error) {
      console.error('Failed to initialize Firebase. Ensure secrets are set correctly:', error);
      process.exit(1); // Exit if Firebase cannot be initialized
    }
  }
  return admin;
}

module.exports = initializeFirebase;