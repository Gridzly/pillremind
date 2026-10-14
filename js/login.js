import { auth } from "./firebaseConfig.js";

import {
  signInWithEmailAndPassword,
  sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("loginForm");
  const emailInput = document.getElementById("email");
  const passwordInput = document.getElementById("password");
  const message = document.getElementById("formMessage");
  const submitButton = document.getElementById("submitButton");
  const forgotButton = document.getElementById("forgotPassword");
  const toggleButton = document.querySelector("[data-toggle-password]");

  function showMessage(text, type = "error") {
    message.textContent = text;
    message.className = `message ${type}`;

    message.style.background =
      type === "success" ? "#e7f4eb" : "#fef0f0";

    message.style.color =
      type === "success" ? "#175638" : "#b42318";
  }

  // Show or hide the password.
  if (toggleButton) {
    toggleButton.addEventListener("click", () => {
      const isHidden = passwordInput.type === "password";

      passwordInput.type = isHidden ? "text" : "password";
      toggleButton.textContent = isHidden ? "Hide" : "Show";

      toggleButton.setAttribute(
        "aria-label",
        isHidden ? "Hide password" : "Show password"
      );
    });
  }

  // Log in with Firebase Authentication.
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
      await signInWithEmailAndPassword(
        auth,
        email,
        password
      );

      showMessage("Login successful!", "success");

      // Change this to your actual dashboard filename.
      window.location.href = "dashboard.html";

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
          "Email and password login is not enabled in Firebase."
      };

      showMessage(
        errors[error.code] ||
        "Unable to log in. Please try again."
      );

    } finally {
      submitButton.disabled = false;
      submitButton.textContent = "Log In";
    }
  });

  // Send a password reset email.
  forgotButton.addEventListener("click", async () => {
    const email = emailInput.value.trim().toLowerCase();

    if (!email) {
      showMessage("Enter your email address first.");
      emailInput.focus();
      return;
    }

    forgotButton.disabled = true;

    try {
      await sendPasswordResetEmail(auth, email);

      showMessage(
        "If an account exists for this email, a password reset link will be sent.",
        "success"
      );

    } catch (error) {
      console.error("Password reset error:", error);

      if (error.code === "auth/invalid-email") {
        showMessage("Please enter a valid email address.");
      } else if (error.code === "auth/operation-not-allowed") {
        showMessage("Email/password authentication is not enabled.");
      } else if (error.code === "auth/too-many-requests") {
        showMessage("Too many attempts. Please try again later.");
      } else {
        showMessage(
          "Unable to send the reset email. Please try again."
        );
      }

    } finally {
      forgotButton.disabled = false;
    }
  });
});
