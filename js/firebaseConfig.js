
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";

import {
  getAuth
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
  getDatabase
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

import {
  getFunctions
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";

const firebaseConfig = {
  apiKey: "AIzaSyClvnZ-4_I6d9Mp8G8onm6BJ9lg-CibG4M",
  authDomain: "pillremind-e6294.firebaseapp.com",
  databaseURL: "https://pillremind-e6294-default-rtdb.firebaseio.com",
  projectId: "pillremind-e6294",
  storageBucket: "pillremind-e6294.firebasestorage.app",
  messagingSenderId: "234864452295",
  appId: "1:234864452295:web:b6e5c193c0f497602bd4e2",
  measurementId: "G-78016SLGVL"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getDatabase(app);
export const functions = getFunctions(app, "us-central1");
