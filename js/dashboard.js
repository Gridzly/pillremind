
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
const errorMessage = document.getElementById("error");
const logoutButton = document.getElementById("logoutButton");

const caregiverSection = document.getElementById("authorizedDashboard");
const patientSection = document.getElementById("patientDashboard");

const requiredRole = document.body.dataset.requiredRole;

const destinations = {
  authorized: "dashboard.html",
  patient: "patient-dashboard.html"
};

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.replace("login.html");
    return;
  }

  loading.hidden = false;
  app.hidden = true;
  errorMessage.textContent = "";

  try {
    const snapshot = await get(ref(db, `users/${user.uid}`));

    if (!snapshot.exists()) {
      throw new Error("Your account profile was not found.");
    }

    const account = snapshot.val();
    const role = account.role;

    if (!Object.prototype.hasOwnProperty.call(destinations, role)) {
      throw new Error("Your account has an invalid role.");
    }

    if (role !== requiredRole) {
      window.location.replace(destinations[role]);
      return;
    }

    const profile = account.profile || {};
    const name =
      profile.fullName ||
      `${profile.firstName || ""} ${profile.lastName || ""}`.trim() ||
      user.displayName ||
      "User";

    welcomeTitle.textContent = `Welcome, ${name}!`;
    accountEmail.textContent = user.email || profile.email || "";

    if (caregiverSection) {
      caregiverSection.hidden = role !== "authorized";
    }

    if (patientSection) {
      patientSection.hidden = role !== "patient";
    }

    app.hidden = false;
    loading.hidden = true;

  } catch (error) {
    console.error("Dashboard error:", error);
    loading.hidden = true;
    app.hidden = false;
    errorMessage.textContent =
      "Unable to load your dashboard: " + error.message;
  }
});

logoutButton?.addEventListener("click", async () => {
  logoutButton.disabled = true;

  try {
    await signOut(auth);
    window.location.replace("login.html");
  } catch (error) {
    console.error("Logout error:", error);
    errorMessage.textContent = "Unable to log out. Please try again.";
    logoutButton.disabled = false;
  }
});
