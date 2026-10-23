
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getAuth,
  connectAuthEmulator
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  getDatabase,
  connectDatabaseEmulator
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import {
  getFunctions,
  connectFunctionsEmulator
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";

const firebaseConfig = {
  apiKey: "demo-medminder",
  authDomain: "pillremind-e6294.firebaseapp.com",
  databaseURL: "http://127.0.0.1:9000?ns=pillremind-e6294",
  projectId: "pillremind-e6294",
  storageBucket: "pillremind-e6294.firebasestorage.app",
  messagingSenderId: "234864452295",
  appId: "1:234864452295:web:b6e5c193c0f497602bd4e2"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getDatabase(app);
export const functions = getFunctions(app, "us-central1");

// Local emulators only — no live Firebase services are used by this config.
connectAuthEmulator(auth, "http://127.0.0.1:9099");
connectDatabaseEmulator(db, "127.0.0.1", 9000);
connectFunctionsEmulator(functions, "127.0.0.1", 5001);
