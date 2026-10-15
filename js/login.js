
import { auth, db } from "./firebaseConfig.js";

import {
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
  ref,
  get
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const loginForm = document.getElementById("loginForm");
const loginEmail = document.getElementById("loginEmail");
const loginPassword = document.getElementById("loginPassword");
const loginMessage = document.getElementById("loginMessage");
const loginSubmit = document.getElementById("loginSubmit");
const forgotPasswordButton = document.getElementById("forgotPasswordButton");

function displayLoginMessage(message, type = "error") {
  loginMessage.textContent = message;
  loginMessage.className = `message ${type}`;
}

function dashboardForRole(role) {
  const normalizedRole = String(role || "").trim().toLowerCase();

  if (["caregiver", "authorized"].includes(normalizedRole)) {
    return "dashboard.html";
  }

  if (["medicine_taker", "patient"].includes(normalizedRole)) {
    return "patient-dashboard.html";
  }

  return null;
}

// Login only when the user submits the login form.
loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const email = loginEmail.value.trim();
  const password = loginPassword.value;

  if (!email || !password) {
    displayLoginMessage("Please enter your email and password.");
    return;
  }

  loginSubmit.disabled = true;
  loginSubmit.textContent = "Logging in...";
  loginMessage.textContent = "";

  try {
    const result = await signInWithEmailAndPassword(
      auth,
      email,
      password
    );

    const user = result.user;
    const userSnapshot = await get(ref(db, `users/${user.uid}`));

    if (!userSnapshot.exists()) {
      await signOut(auth);
      displayLoginMessage(
        "Your account profile was not found in the database."
      );
      return;
    }

    const userData = userSnapshot.val();
    const destination = dashboardForRole(userData.role);

    if (!destination) {
      await signOut(auth);
      displayLoginMessage(
        "Your account role is missing or invalid. Please check your Firebase user record."
      );
      return;
    }

    // Redirect only after the user clicks Log In
    // and authentication plus role verification succeed.
    window.location.href = destination;

  } catch (error) {
    console.error("Login failed:", error);

    const errorMessages = {
      "auth/invalid-credential":
        "Incorrect email or password.",
      "auth/user-not-found":
        "No account was found with this email.",
      "auth/wrong-password":
        "Incorrect email or password.",
      "auth/invalid-email":
        "Please enter a valid email address.",
      "auth/too-many-requests":
        "Too many login attempts. Please try again later.",
      "auth/network-request-failed":
        "Network error. Please check your internet connection.",
      "PERMISSION_DENIED":
        "Unable to read your account role. Please check your Firebase Database Rules."
    };

    displayLoginMessage(
      errorMessages[error.code] ||
      error.message ||
      "Login failed. Please try again."
    );

  } finally {
    loginSubmit.disabled = false;
    loginSubmit.textContent = "Log In";
  }
});

// Password reset uses the existing Forgot Password button.
forgotPasswordButton.addEventListener("click", async () => {
  const email = loginEmail.value.trim();

  if (!email) {
    displayLoginMessage("Enter your email address first.");
    loginEmail.focus();
    return;
  }

  try {
    await sendPasswordResetEmail(auth, email);

    displayLoginMessage(
      "Password reset instructions have been sent to your email.",
      "success"
    );
  } catch (error) {
    console.error("Password reset failed:", error);

    displayLoginMessage(
      error.code === "auth/invalid-email"
        ? "Please enter a valid email address."
        : "Unable to send the reset email. Please try again."
    );
  }
});
