
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
  if (!message) {
    console[type === "error" ? "error" : "log"](text);
    return;
  }

  message.textContent = text;
  message.className = `message ${type}`;
}

function setLoading(loading) {
  if (!submitButton) return;

  submitButton.disabled = loading;
  submitButton.textContent = loading
    ? "Creating account..."
    : "Create Account";
}

function getSignupError(error) {
  console.error("Firebase signup error:", error);

  const messages = {
    "auth/email-already-in-use":
      "This email already has an account. Please log in instead.",

    "auth/invalid-email":
      "Please enter a valid email address.",

    "auth/weak-password":
      "Please choose a stronger password with at least 8 characters.",

    "auth/network-request-failed":
      "Cannot connect to Firebase. Check your internet connection and Firebase Emulator settings.",

    "auth/operation-not-allowed":
      "Email/password authentication is disabled. Enable it in Firebase Authentication settings.",

    "auth/invalid-api-key":
      "The Firebase API key is invalid. Check firebaseConfig.js.",

    "PERMISSION_DENIED":
      "Firebase denied the database write. Check your Realtime Database rules and emulator connection."
  };

  return messages[error.code] ||
    `Signup failed (${error.code || "unknown error"}). Check the browser console for details.`;
}

// Password strength indicator
if (passwordInput && strengthText) {
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
}

if (!form) {
  console.error(
    'Signup form not found. Check that signup.html contains id="signupForm".'
  );
} else {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const firstName =
      document.getElementById("firstName")?.value.trim() || "";

    const lastName =
      document.getElementById("lastName")?.value.trim() || "";

    const email =
      document.getElementById("email")?.value.trim().toLowerCase() || "";

    const role =
      document.getElementById("role")?.value || "";

    const password = passwordInput?.value || "";
    const confirmation = confirmPasswordInput?.value || "";

    showMessage("");

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

    setLoading(true);

    let createdUser = null;
    let profileSaved = false;

    try {
      // 1. Create the Authentication account.
      const credential = await createUserWithEmailAndPassword(
        auth,
        email,
        password
      );

      createdUser = credential.user;

      const fullName = `${firstName} ${lastName}`;

      // 2. Set the user's display name.
      await updateProfile(createdUser, {
        displayName: fullName
      });

      // 3. Save the profile using the exact Authentication UID.
      // Keep role under profile/role for compatibility with your
      // current Medminder database and Cloud Functions.
      const userProfile = {
        profile: {
          role,
          firstName,
          lastName,
          fullName,
          email,
          createdAt: new Date().toISOString()
        }
      };

      await set(ref(db, `users/${createdUser.uid}`), userProfile);
      profileSaved = true;

      showMessage(
        "Account created successfully! Redirecting...",
        "success"
      );

      // 4. Send the user to the dashboard matching their role.
      window.location.replace(destinations[role]);

    } catch (error) {
      console.error("Signup error:", error);

      if (createdUser && !profileSaved) {
        showMessage(
          "Your authentication account was created, but the profile could not be saved. Do not register again with this email. Check your Firebase connection and Realtime Database rules, then repair the profile for UID: " +
          createdUser.uid
        );
      } else {
        showMessage(getSignupError(error));
      }
    } finally {
      setLoading(false);
    }
  });
}
