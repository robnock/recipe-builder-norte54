// ═══════════════════════════════════════════
//  DATA STORAGE (Firebase Firestore)
//  Real-time sync across all devices.
// ═══════════════════════════════════════════

import { db } from "./firebase.js";
import { doc, getDoc, setDoc, onSnapshot } from "firebase/firestore";

const DOC_REF = doc(db, "app", "kitchen-data");
const PW_REF = doc(db, "app", "password");

const blank = () => ({ ingredients: [], recipes: [], dishes: [] });

// Load data once (used on initial mount)
export const loadData = async () => {
  try {
    const snap = await getDoc(DOC_REF);
    return snap.exists() ? snap.data() : blank();
  } catch (e) {
    console.error("Failed to load data:", e);
    return blank();
  }
};

// Save data (merges into the document)
export const saveData = async (data) => {
  try {
    await setDoc(DOC_REF, {
      ingredients: data.ingredients || [],
      recipes: data.recipes || [],
      dishes: data.dishes || [],
    });
  } catch (e) {
    console.error("Failed to save data:", e);
  }
};

// Subscribe to real-time updates (used to sync across devices)
// Returns an unsubscribe function.
export const subscribeToData = (callback) => {
  return onSnapshot(DOC_REF, (snap) => {
    if (snap.exists()) {
      callback(snap.data());
    }
  }, (error) => {
    console.error("Real-time listener error:", error);
  });
};

// Load password hash
export const loadPassword = async () => {
  try {
    const snap = await getDoc(PW_REF);
    return snap.exists() ? snap.data().hash : null;
  } catch (e) {
    console.error("Failed to load password:", e);
    return null;
  }
};

// Save password hash
export const savePassword = async (hash) => {
  try {
    await setDoc(PW_REF, { hash });
  } catch (e) {
    console.error("Failed to save password:", e);
  }
};
