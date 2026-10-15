
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
const authorizedDashboard = document.getElementById("authorizedDashboard");
const patientDashboard = document.getElementById("patientDashboard");
const errorMessage = document.getElementById("error");
const logoutButton = document.getElementById("logoutButton");

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.replace("index.html");
    return;
  }

  loading.hidden = false;
  app.hidden = true;
  errorMessage.textContent = "";

  try {
    const snapshot = await get(ref(db, `users/${user.uid}`));

    if (!snapshot.exists()) {
      throw new Error(
        "No Medminder profile was found for this account. " +
        "Check your Firebase Realtime Database."
      );
    }

    const account = snapshot.val();
    const profile = account.profile || {};

    const fullName =
      profile.fullName ||
      `${profile.firstName || ""} ${profile.lastName || ""}`.trim() ||
      user.displayName ||
      "User";

    welcomeTitle.textContent = `Welcome, ${fullName}!`;
    accountEmail.textContent = user.email || profile.email || "";

    authorizedDashboard.hidden = true;
    patientDashboard.hidden = true;

    if (account.role === "authorized") {
      authorizedDashboard.hidden = false;
    } else if (account.role === "patient") {
      patientDashboard.hidden = false;
    } else {
      throw new Error(
        "Your account has no valid role. " +
        "Set its role to authorized or patient in Firebase."
      );
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
      "Unable to load your dashboard: " + error.message;
  }
});

logoutButton.addEventListener("click", async () => {
  logoutButton.disabled = true;

  try {
    await signOut(auth);
    window.location.replace("index.html");
  } catch (error) {
    console.error("Logout error:", error);
    errorMessage.textContent = "Unable to log out. Please try again.";
    logoutButton.disabled = false;
  }
});

document.getElementById("medicinesButton").addEventListener("click", () => {
  alert("Medicine management will be implemented next.");
});

document.getElementById("remindersButton").addEventListener("click", () => {
  alert("Reminder scheduling will be implemented next.");
});
