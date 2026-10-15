
import { auth, db } from "./firebaseConfig.js";

import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  sendPasswordResetEmail,
  signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
  ref,
  get,
  set
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const loginForm = document.getElementById("loginForm");
const signupForm = document.getElementById("signupForm");

const loginMessage = document.getElementById("loginMessage");
const signupMessage = document.getElementById("signupMessage");

const loginSubmit = document.getElementById("loginSubmit");
const signupSubmit = document.getElementById("signupSubmit");
const forgotButton = document.getElementById("forgotPasswordButton");

const destinations = {
  authorized: "dashboard.html",
  patient: "patient-dashboard.html"
};

function showMessage(element, text, type = "error") {
  element.textContent = text;
  element.className = `message ${type}`;
}

function clearMessages() {
  showMessage(loginMessage, "");
  showMessage(signupMessage, "");
}

function getRole(role) {
  if (role === "caregiver" || role === "authorized") {
    return "authorized";
  }

  if (role === "medicine_taker" || role === "patient") {
    return "patient";
  }

  return "";
}

async function redirectByRole(user) {
  const snapshot = await get(ref(db, `users/${user.uid}`));

  if (!snapshot.exists()) {
    throw new Error(
      "Your account profile is missing. Please contact support."
    );
  }

  const profile = snapshot.val();
  const role = getRole(profile.role);

  if (!role) {
    throw new Error(
      "Your account role is missing or invalid. Please contact support."
    );
  }

  window.location.replace(destinations[role]);
}

// If the user is already signed in, send them to their dashboard.
onAuthStateChanged(auth, async (user) => {
  if (!user) return;

  try {
    await redirectByRole(user);
  } catch (error) {
    console.error("Existing session error:", error);
    showMessage(loginMessage, error.message);
  }
});

// LOGIN
loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessages();

  const email = document.getElementById("loginEmail")
    .value.trim().toLowerCase();

  const password = document.getElementById("loginPassword").value;

  if (!email || !password) {
    showMessage(loginMessage, "Enter your email and password.");
    return;
  }

  loginSubmit.disabled = true;
  loginSubmit.textContent = "Logging in...";

  try {
    const result = await signInWithEmailAndPassword(
      auth, email, password
    );

    await redirectByRole(result.user);

  } catch (error) {
    console.error("Login error:", error);

    const messages = {
      "auth/invalid-credential": "Incorrect email or password.",
      "auth/invalid-email": "Enter a valid email address.",
      "auth/too-many-requests": "Too many attempts. Please try again later.",
      "auth/network-request-failed": "Check your internet connection.",
      "PERMISSION_DENIED":
        "Firebase denied access to your profile. Check your database rules."
    };

    showMessage(
      loginMessage,
      messages[error.code] || error.message
    );

    // Do not sign the user out here if their profile read failed.
    // The message will help diagnose the actual problem.
  } finally {
    loginSubmit.disabled = false;
    loginSubmit.textContent = "Log In";
  }
});

// SIGNUP FROM THE COMBINED LOGIN PAGE
signupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessages();

  const fullName = document.getElementById("signupName")
    .value.trim();

  const email = document.getElementById("signupEmail")
    .value.trim().toLowerCase();

  const selectedRole = document.getElementById("signupRole").value;
  const role = getRole(selectedRole);

  const password = document.getElementById("signupPassword").value;
  const confirmation = document.getElementById("confirmPassword").value;

  if (!fullName || !email || !role) {
    showMessage(signupMessage, "Complete all required fields.");
    return;
  }

  if (password.length < 8) {
    showMessage(signupMessage, "Use at least 8 characters for your password.");
    return;
  }

  if (password !== confirmation) {
    showMessage(signupMessage, "Your passwords do not match.");
    return;
  }

  signupSubmit.disabled = true;
  signupSubmit.textContent = "Creating account...";

  try {
    const result = await createUserWithEmailAndPassword(
      auth, email, password
    );

    const user = result.user;

    await updateProfile(user, { displayName: fullName });

    await set(ref(db, `users/${user.uid}`), {
      role,
      profile: {
        fullName,
        email,
        createdAt: new Date().toISOString()
      }
    });

    showMessage(
      signupMessage,
      "Account created! Opening your dashboard...",
      "success"
    );

    window.location.replace(destinations[role]);

  } catch (error) {
    console.error("Signup error:", error);

    showMessage(
      signupMessage,
      error.code === "auth/email-already-in-use"
        ? "This email already has an account. Please log in."
        : error.message
    );
  } finally {
    signupSubmit.disabled = false;
    signupSubmit.textContent = "Create Account";
  }
});

// FORGOT PASSWORD
forgotButton.addEventListener("click", async () => {
  const email = document.getElementById("loginEmail")
    .value.trim().toLowerCase();

  if (!email) {
    showMessage(loginMessage, "Enter your email address first.");
    document.getElementById("loginEmail").focus();
    return;
  }

  try {
    await sendPasswordResetEmail(auth, email);

    showMessage(
      loginMessage,
      "If the account exists, a password-reset email will be sent.",
      "success"
    );
  } catch (error) {
    console.error("Password reset error:", error);

    showMessage(
      loginMessage,
      "Unable to send the reset email. Check the address and try again."
    );
  }
});
