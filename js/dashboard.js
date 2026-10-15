
import { auth } from "./firebaseConfig.js";

import {
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

const status = document.getElementById("status");
const dashboardContent = document.getElementById("dashboardContent");
const userEmail = document.getElementById("userEmail");
const logoutButton = document.getElementById("logoutButton");

onAuthStateChanged(auth, (user) => {
  if (!user) {
    // No logged-in user: return to the login page.
    window.location.replace("index.html");
    return;
  }

  // A Firebase user is signed in.
  status.textContent = "You are successfully logged in!";
  userEmail.textContent = user.email || "Email unavailable";
  dashboardContent.hidden = false;
});

logoutButton.addEventListener("click", async () => {
  logoutButton.disabled = true;

  try {
    await signOut(auth);
    window.location.replace("index.html");
  } catch (error) {
    console.error("Logout error:", error);
    status.textContent = "Unable to log out. Please try again.";
    logoutButton.disabled = false;
  }
});
