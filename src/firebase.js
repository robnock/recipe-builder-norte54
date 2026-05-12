// ═══════════════════════════════════════════
//  FIREBASE CONFIGURATION
//  Norte54 Recipe Builder
// ═══════════════════════════════════════════
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyA6gWELU0C9jdtln3JDQPOQtOYieupLxsc",
  authDomain: "norte54-recipes.firebaseapp.com",
  projectId: "norte54-recipes",
  storageBucket: "norte54-recipes.firebasestorage.app",
  messagingSenderId: "128567156616",
  appId: "1:128567156616:web:592ff9dc53903bf279643d"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
