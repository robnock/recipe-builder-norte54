// ═══════════════════════════════════════════
//  FIREBASE CONFIGURATION
//  Replace these values with your own from the Firebase Console.
//  See README.md for step-by-step instructions.
// ═══════════════════════════════════════════

import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

  const firebaseConfig = {
    apiKey: "AIzaSyDr_kWWGWu7j9SrSXgwR1DYRpd4WswiWh8",
    authDomain: "recipe-builder-57b93.firebaseapp.com",
    projectId: "recipe-builder-57b93",
    storageBucket: "recipe-builder-57b93.firebasestorage.app",
    messagingSenderId: "987187256248",
    appId: "1:987187256248:web:921f77059767afa7e14d4d",
    measurementId: "G-J6VYN1ZE2Z"
  };

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
