
import { auth, db } from "./firebaseConfig.js";

import {
  signInWithEmailAndPassword,
  sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
  ref,
  get
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("loginForm");
  const emailInput = document.getElementById("email");
  const passwordInput = document.getElementById("password");
  const message = document.getElementById("formMessage");
  const submitButton = document.getElementById("submitButton");
  const forgotButton = document.getElementById("forgotPassword");
  const toggleButton = document.querySelector("[data-toggle-password]");

  // Display a message on the login page.
  function showMessage(text, type = "error") {
    message.textContent = text;
    message.className = `message ${type}`;
  }

  // Show or hide password.
  toggleButton?.addEventListener("click", () => {
    const hidden = passwordInput.type === "password";

    passwordInput.type = hidden ? "text" : "password";
    toggleButton.textContent = hidden ? "Hide" : "Show";
  });

  // Handle login.
  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    showMessage("");

    const email = emailInput.value.trim().toLowerCase();
    const password = passwordInput.value;

    if (!email || !password) {
      showMessage("Please enter your email and password.");
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = "Logging in...";

    try {
      // Authenticate using Firebase.
      const credential = await signInWithEmailAndPassword(
        auth,
        email,
        password
      );

      const user = credential.user;

      // Retrieve this user's profile from Realtime Database.
      const profileRef = ref(db, `users/${user.uid}`);
      const profileSnapshot = await get(profileRef);

      if (!profileSnapshot.exists()) {
        showMessage(
          "Your account profile was not found. Please contact your caregiver or administrator."
        );

        await auth.signOut();
        return;
      }

      const profile = profileSnapshot.val();

      // Read the role saved in the user's Firebase profile.
      const role = String(profile.role || "")
        .trim()
        .toLowerCase();

      // Redirect according to the saved role.
      if (role === "caregiver" || role === "authorized") {
        window.location.replace("dashboard.html");
      } else if (role === "patient") {
        window.location.replace("patient-dashboard.html");
      } else {
        showMessage(
          "Your account role is not configured. Please contact your administrator."
        );

        console.error("Unknown account role:", profile.role);

        await auth.signOut();
      }

    } catch (error) {
      console.error("Login error:", error);

      const errors = {
        "auth/invalid-email":
          "Please enter a valid email address.",
        "auth/invalid-credential":
          "Incorrect email or password.",
        "auth/user-not-found":
          "Incorrect email or password.",
        "auth/wrong-password":
          "Incorrect email or password.",
        "auth/too-many-requests":
          "Too many attempts. Please try again later.",
        "auth/network-request-failed":
          "Check your internet connection and try again.",
        "auth/operation-not-allowed":
          "Email and password login is not enabled in Firebase.",
        "PERMISSION_DENIED":
          "Firebase denied access to your profile. Check your database rules."
      };

      showMessage(
        errors[error.code] ||
        "Unable to log in or load your profile. Check the browser console."
      );

    } finally {
      submitButton.disabled = false;
      submitButton.textContent = "Log In";
    }
  });

  // Password reset.
  forgotButton?.addEventListener("click", async () => {
    const email = emailInput.value.trim().toLowerCase();

    if (!email) {
      showMessage("Enter your email address first.");
      emailInput.focus();
      return;
    }

    try {
      await sendPasswordResetEmail(auth, email);

      showMessage(
        "If an account exists for this email, a reset link will be sent.",
        "success"
      );

    } catch (error) {
      console.error("Password reset error:", error);

      showMessage(
        "Unable to send the reset email. Check the email and try again."
      );
    }
  });
});
