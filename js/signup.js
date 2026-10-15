
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

const destinations = {
  authorized: "dashboard.html",
  patient: "patient-dashboard.html"
};

function showMessage(text, type = "error") {
  message.textContent = text;
  message.className = `message ${type}`;
}

passwordInput.addEventListener("input", () => {
  const password = passwordInput.value;

  if (!password) {
    strengthText.textContent = "";
    return;
  }

  let score = 0;
  if (password.length >= 8) score++;
  if (/[A-Z]/.test(password)) score++;
  if (/[a-z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  const result = score <= 2
    ? { label: "Weak", color: "#b42318" }
    : score <= 4
      ? { label: "Medium", color: "#b7791f" }
      : { label: "Strong", color: "#175638" };

  strengthText.textContent = `Password strength: ${result.label}`;
  strengthText.style.color = result.color;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showMessage("");

  const firstName = document.getElementById("firstName").value.trim();
  const lastName = document.getElementById("lastName").value.trim();
  const email = document.getElementById("email").value.trim().toLowerCase();
  const role = document.getElementById("role").value;
  const password = passwordInput.value;
  const confirmation = confirmPasswordInput.value;

  if (!firstName || !lastName || !email) {
    showMessage("Please complete all required fields.");
    return;
  }

  if (!Object.hasOwn(destinations, role)) {
    showMessage("Please select Caregiver or Patient.");
    return;
  }

  if (password.length < 8) {
    showMessage("Your password must contain at least 8 characters.");
    return;
  }

  if (password !== confirmation) {
    showMessage("Your passwords do not match.");
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = "Creating account...";

  let user = null;

  try {
    // Step 1: Create the Firebase Authentication account.
    const credential = await createUserWithEmailAndPassword(
      auth,
      email,
      password
    );

    user = credential.user;

    const fullName = `${firstName} ${lastName}`;

    // Step 2: Save the display name.
    await updateProfile(user, { displayName: fullName });

    // Step 3: Save the role and profile under this exact user's UID.
    await set(ref(db, `users/${user.uid}`), {
      role,
      profile: {
        firstName,
        lastName,
        fullName,
        email,
        createdAt: new Date().toISOString()
      }
    });

    showMessage("Account created successfully! Redirecting...", "success");

    window.location.replace(destinations[role]);

  } catch (error) {
    console.error("Signup error:", error);

    if (user) {
      // Authentication succeeded; the failure may be in profile saving.
      showMessage(
        `Your authentication account exists, but setup did not finish. ` +
        `Error: ${error.code || error.message}. ` +
        `Do not sign up again with this email. Check Firebase Database ` +
        `rules and the database URL, then repair this user's profile.`
      );
    } else {
      const messages = {
        "auth/email-already-in-use":
          "This email already has an account. Please log in.",
        "auth/invalid-email":
          "Please enter a valid email address.",
        "auth/weak-password":
          "Please choose a stronger password.",
        "auth/operation-not-allowed":
          "Enable Email/Password in Firebase Authentication.",
        "auth/network-request-failed":
          "Check your internet connection and try again."
      };

      showMessage(messages[error.code] || error.message);
    }
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Create Account";
  }
});
