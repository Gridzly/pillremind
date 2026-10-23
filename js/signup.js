
import { auth, db } from "./firebaseConfig.js";

import {
  createUserWithEmailAndPassword,
  updateProfile,
  signOut
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
  const messages = {
    "auth/email-already-in-use":
      "This email already has a Firebase Authentication account. Please log in or reset your password.",
    "auth/invalid-email":
      "Please enter a valid email address.",
    "auth/weak-password":
      "Please choose a stronger password.",
    "auth/network-request-failed":
      "Network error. Check your internet connection and try again.",
    "auth/operation-not-allowed":
      "Email/Password sign-in is disabled. Enable it in Firebase Authentication → Sign-in method.",
    "PERMISSION_DENIED":
      "Firebase denied access to Realtime Database. Check your Database Rules."
  };

  return messages[error.code] ||
    `Account setup failed (${error.code || "unknown error"}). Check the browser console.`;
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
    showMessage("");

    const firstName =
      document.getElementById("firstName")?.value.trim() || "";

    const lastName =
      document.getElementById("lastName")?.value.trim() || "";

    const email =
      document.getElementById("email")?.value.trim().toLowerCase() || "";

    const role = document.getElementById("role")?.value || "";

    const password = passwordInput?.value || "";
    const confirmation = confirmPasswordInput?.value || "";

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
    let authenticationCreated = false;

    try {
      // 1. Create the Firebase Authentication account.
      const credential = await createUserWithEmailAndPassword(
        auth,
        email,
        password
      );

      createdUser = credential.user;
      authenticationCreated = true;

      const fullName = `${firstName} ${lastName}`;

      // 2. Set the user's display name.
      await updateProfile(createdUser, {
        displayName: fullName
      });

      // 3. Save the profile and role under this user's UID.
      // Keep the role in profile/role for compatibility with
      // the structure currently shown in your Firebase database.
      await set(ref(db, `users/${createdUser.uid}`), {
        profile: {
          role,
          firstName,
          lastName,
          fullName,
          email,
          createdAt: new Date().toISOString()
        }
      });

      showMessage(
        "Account created successfully! Redirecting...",
        "success"
      );

      window.location.replace(destinations[role]);

    } catch (error) {
      console.error("Signup error:", error);

      if (authenticationCreated && createdUser) {
        showMessage(
          "Your Firebase Authentication account was created, but profile setup failed. Do not register again with this email. Check the browser console and Realtime Database Rules, then repair the existing account profile."
        );

        // Keep the session active so the account can be repaired
        // without requiring the user to register a second time.
      } else {
        showMessage(getSignupError(error));
      }
    } finally {
      setLoading(false);
    }
  });
}
