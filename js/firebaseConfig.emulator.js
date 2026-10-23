
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

const emulatorConfig = {
  apiKey: "demo-medminder",
  authDomain: "localhost",
  databaseURL: "https://jubilant-dollop-7v745rpxwr6w2rvq9-9000.app.github.dev",
  projectId: "pillremind-e6294",
  appId: "1:234864452295:web:b6e5c193c0f497602bd4e2"
};

const app = initializeApp(emulatorConfig, "medminder-emulator");

export const auth = getAuth(app);
export const db = getDatabase(app);
export const functions = getFunctions(app, "us-central1");

connectAuthEmulator(
  auth,
  "https://jubilant-dollop-7v745rpxwr6w2rvq9-9099.app.github.dev",
  { disableWarnings: true }
);

connectDatabaseEmulator(
  db,
  "jubilant-dollop-7v745rpxwr6w2rvq9-9000.app.github.dev",
  443
);

connectFunctionsEmulator(
  functions,
  "jubilant-dollop-7v745rpxwr6w2rvq9-5001.app.github.dev",
  443
);
