
import { auth, db } from "./firebaseConfig.js";

import {
  createUserWithEmailAndPassword,
  updateProfile
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
  ref,
  set
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const form = document.getElementById("signupForm");
const passwordInput = document.getElementById("password");
const confirmPasswordInput = document.getElementById("confirmPassword");
const strengthText = document.getElementById("passwordStrength");
const message = document.getElementById("formMessage");
const submitButton = document.getElementById("submitButton");

function showMessage(text, type = "error") {
  message.textContent = text;
  message.className = `message ${type}`;
}

passwordInput.addEventListener("input", () => {
  const password = passwordInput.value;
  let score = 0;

  if (password.length >= 8) score++;
  if (/[A-Z]/.test(password)) score++;
  if (/[a-z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  if (!password) {
    strengthText.textContent = "";
    return;
  }

  const strength = score <= 2
    ? { label: "Weak", color: "#b42318" }
    : score <= 4
      ? { label: "Medium", color: "#b7791f" }
      : { label: "Strong", color: "#175638" };

  strengthText.textContent = `Password strength: ${strength.label}`;
  strengthText.style.color = strength.color;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showMessage("");

  const firstName = document.getElementById("firstName").value.trim();
  const lastName = document.getElementById("lastName").value.trim();
  const email = document.getElementById("email").value.trim().toLowerCase();
  const role = document.getElementById("role").value;
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

  if (!["authorized", "patient"].includes(role)) {
    showMessage("Please select Caregiver or Patient.");
    return;
  }

  if (password.length < 8) {
    showMessage("Your password must contain at least 8 characters.");
    return;
  }

  if (password !== confirmPassword) {
    showMessage("Your passwords do not match.");
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = "Creating account...";

  let createdUser = null;

  try {
    const credential = await createUserWithEmailAndPassword(
      auth,
      email,
      password
    );

    const user = credential.user;
    createdUser = user;

    const fullName = `${firstName} ${lastName}`;

    await updateProfile(user, {
      displayName: fullName
    });

    await set(ref(db, `users/${user.uid}`), {
      role: role,
      profile: {
        firstName: firstName,
        lastName: lastName,
        fullName: fullName,
        email: email,
        createdAt: new Date().toISOString()
      }
    });

    showMessage("Account created! Opening your dashboard...", "success");

    window.location.replace("dashboard.html");

  } catch (error) {
    console.error("Signup error:", error);

    if (createdUser) {
      showMessage(
        "Your login account was created, but saving your profile failed. " +
        "Please check your Firebase Database URL and Rules. " +
        "Do not sign up again with the same email."
      );
    } else {
      const errors = {
        "auth/email-already-in-use": "This email already has an account. Please log in.",
        "auth/invalid-email": "Please enter a valid email address.",
        "auth/weak-password": "Please choose a stronger password.",
        "auth/operation-not-allowed": "Enable Email/Password in Firebase Authentication.",
        "auth/network-request-failed": "Check your internet connection and try again."
      };

      showMessage(errors[error.code] || error.message);
    }
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Create Account";
  }
});
