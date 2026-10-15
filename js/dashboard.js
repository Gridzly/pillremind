
import { auth, db } from "./firebaseConfig.js";

import {
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
  ref,
  get
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const loading = document.getElementById("loading");
const app = document.getElementById("app");
const welcomeTitle = document.getElementById("welcomeTitle");
const accountEmail = document.getElementById("accountEmail");
const authorizedDashboard =
  document.getElementById("authorizedDashboard");
const patientDashboard =
  document.getElementById("patientDashboard");
const errorMessage = document.getElementById("error");
const logoutButton = document.getElementById("logoutButton");

let currentUser = null;

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.replace("index.html");
    return;
  }

  currentUser = user;
  loading.hidden = false;
  app.hidden = true;
  errorMessage.textContent = "";

  try {
    // Retrieve this account's role from Realtime Database.
    const userRef = ref(db, `users/${user.uid}`);
    const snapshot = await get(userRef);

    if (!snapshot.exists()) {
      throw new Error("Your account role has not been configured.");
    }

    const profile = snapshot.val();

    welcomeTitle.textContent =
      `Welcome, ${profile.name || "User"}!`;

    accountEmail.textContent = user.email || "";

    if (profile.role === "authorized") {
      authorizedDashboard.hidden = false;
      patientDashboard.hidden = true;
    } else if (profile.role === "patient") {
      authorizedDashboard.hidden = true;
      patientDashboard.hidden = false;
    } else {
      throw new Error("Invalid account role.");
    }

    app.hidden = false;
    loading.hidden = true;

  } catch (error) {
    console.error("Dashboard error:", error);

    loading.hidden = true;
    app.hidden = false;

    authorizedDashboard.hidden = true;
    patientDashboard.hidden = true;

    errorMessage.textContent =
      "Unable to load your dashboard. " + error.message;
  }
});

logoutButton.addEventListener("click", async () => {
  logoutButton.disabled = true;

  try {
    await signOut(auth);
    window.location.replace("index.html");
  } catch (error) {
    console.error("Logout failed:", error);
    errorMessage.textContent = "Unable to log out. Try again.";
    logoutButton.disabled = false;
  }
});

// Temporary placeholders for the next development step.
document.getElementById("medicinesButton")
  .addEventListener("click", () => {
    alert("Next: build the medicine management page.");
  });

document.getElementById("remindersButton")
  .addEventListener("click", () => {
    alert("Next: build the reminder scheduling page.");
  });
