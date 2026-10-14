
import { auth, db } from "./firebaseConfig.js";

import {
  createUserWithEmailAndPassword,
  updateProfile
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
  ref,
  set
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("signupForm");
  const passwordInput = document.getElementById("password");
  const confirmPasswordInput =
    document.getElementById("confirmPassword");

  const strengthText =
    document.getElementById("passwordStrength");

  const message = document.getElementById("formMessage");
  const submitButton =
    document.getElementById("submitButton");

  function showMessage(text, type = "error") {
    message.textContent = text;
    message.className = `message ${type}`;
  }

  function getPasswordStrength(password) {
    let score = 0;

    if (password.length >= 8) score++;
    if (/[A-Z]/.test(password)) score++;
    if (/[a-z]/.test(password)) score++;
    if (/[0-9]/.test(password)) score++;
    if (/[^A-Za-z0-9]/.test(password)) score++;

    if (score <= 2) {
      return { text: "Weak", color: "#dc2626" };
    }

    if (score <= 4) {
      return { text: "Medium", color: "#d97706" };
    }

    return { text: "Strong", color: "#16a34a" };
  }

  passwordInput.addEventListener("input", () => {
    const password = passwordInput.value;

    if (!password) {
      strengthText.textContent = "";
      return;
    }

    const result = getPasswordStrength(password);

    strengthText.textContent =
      `Password strength: ${result.text}`;

    strengthText.style.color = result.color;
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    showMessage("");

    const firstName =
      document.getElementById("firstName").value.trim();

    const lastName =
      document.getElementById("lastName").value.trim();

    const email =
      document.getElementById("email").value.trim().toLowerCase();

    const password = passwordInput.value;
    const confirmPassword = confirmPasswordInput.value;

    if (!firstName || !lastName) {
      showMessage("Please enter your first and last name.");
      return;
    }

    if (!email.endsWith("@gmail.com")) {
      showMessage("Please use a Gmail address.");
      return;
    }

    if (password.length < 8) {
      showMessage("Your password must have at least 8 characters.");
      return;
    }

    if (password !== confirmPassword) {
      showMessage("Your passwords do not match.");
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = "Creating account...";

    try {
      const credential =
        await createUserWithEmailAndPassword(
          auth,
          email,
          password
        );

      const user = credential.user;
      const fullName = `${firstName} ${lastName}`;

      await updateProfile(user, {
        displayName: fullName
      });

      await set(ref(db, `users/${user.uid}/profile`), {
        firstName: firstName,
        lastName: lastName,
        fullName: fullName,
        email: email,
        createdAt: new Date().toISOString()
      });

      showMessage(
        "Account created successfully!",
        "success"
      );

      setTimeout(() => {
        window.location.href = "index.html?created=1";
      }, 1000);

    } catch (error) {
      console.error("Signup error:", error);

      const errors = {
        "auth/email-already-in-use":
          "This email already has an account.",
        "auth/invalid-email":
          "Please enter a valid email address.",
        "auth/weak-password":
          "Please choose a stronger password.",
        "auth/operation-not-allowed":
          "Enable Email/Password in Firebase Authentication.",
        "auth/network-request-failed":
          "Check your internet connection and try again."
      };

      showMessage(
        errors[error.code] || error.message
      );

    } finally {
      submitButton.disabled = false;
      submitButton.textContent = "Create account";
    }
  });
});
