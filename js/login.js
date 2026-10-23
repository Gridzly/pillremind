import { auth, db } from "./firebaseConfig.js";

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  updateProfile
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
  ref,
  set,
  get
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const $ = (id) => document.getElementById(id);

const destinations = {
  authorized: "dashboard.html",
  patient: "patient-dashboard.html"
};

function showMessage(id, text, type = "error") {
  const element = $(id);
  if (!element) {
    console[type === "error" ? "error" : "log"](text);
    return;
  }

  element.textContent = text;
  element.className = `message ${type}`;
}

function clearMessages() {
  ["loginMessage", "signupMessage"].forEach((id) => {
    const element = $(id);
    if (element) {
      element.textContent = "";
      element.className = "message";
    }
  });
}

function setLoading(buttonId, loading, defaultText) {
  const button = $(buttonId);
  if (!button) return;

  button.disabled = loading;
  button.textContent = loading ? "Please wait..." : defaultText;
}

function friendlyError(error) {
  console.error("Medminder authentication error:", error);

  const messages = {
    "auth/email-already-in-use":
      "This email already has an account. Please log in instead.",
    "auth/invalid-email":
      "Please enter a valid email address.",
    "auth/weak-password":
      "Choose a password with at least 8 characters.",
    "auth/invalid-credential":
      "Incorrect email or password.",
    "auth/user-not-found":
      "No account was found for this email.",
    "auth/wrong-password":
      "Incorrect email or password.",
    "auth/too-many-requests":
      "Too many attempts. Please wait and try again.",
    "auth/network-request-failed":
      "Network error. Check your internet connection.",
    "auth/operation-not-allowed":
      "Email/password sign-in is disabled in Firebase Authentication.",
    "PERMISSION_DENIED":
      "Firebase denied access to the database. Check your Realtime Database rules.",
    "permission-denied":
      "Firebase denied access to the database. Check your Realtime Database rules."
  };

  return messages[error.code] ||
    `Something went wrong (${error.code || "unknown error"}). Check the browser console.`;
}

// Switch between the login and signup panels.
$("showSignup")?.addEventListener("click", () => {
  $("loginSection")?.classList.add("hidden");
  $("signupSection")?.classList.remove("hidden");
  clearMessages();
});

$("showLogin")?.addEventListener("click", () => {
  $("signupSection")?.classList.add("hidden");
  $("loginSection")?.classList.remove("hidden");
  clearMessages();
});

// Show or hide password fields.
document.querySelectorAll(".toggle-password").forEach((button) => {
  button.addEventListener("click", () => {
    const input = $(button.dataset.target);
    if (!input) return;

    const show = input.type === "password";
    input.type = show ? "text" : "password";
    button.textContent = show ? "Hide" : "Show";
    button.setAttribute(
      "aria-label",
      show ? "Hide password" : "Show password"
    );
  });
});

// Login.
$("loginForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessages();

  const email = $("loginEmail")?.value.trim().toLowerCase() || "";
  const password = $("loginPassword")?.value || "";

  if (!email || !password) {
    showMessage("loginMessage", "Enter your email and password.");
    return;
  }

  setLoading("loginSubmit", true, "Log In");

  try {
    const credential = await signInWithEmailAndPassword(
      auth,
      email,
      password
    );

    // Read the saved role instead of trusting a role from the login form.
    const profileSnapshot = await get(
      ref(db, `users/${credential.user.uid}/profile`)
    );

    if (!profileSnapshot.exists()) {
      showMessage(
        "loginMessage",
        "Your account profile is missing. Please contact the app administrator."
      );
      return;
    }

    const profile = profileSnapshot.val();
    const destination = destinations[profile.role];

    if (!destination) {
      showMessage(
        "loginMessage",
        "Your account role is not recognized. Please contact the app administrator."
      );
      return;
    }

    window.location.replace(destination);
  } catch (error) {
    showMessage("loginMessage", friendlyError(error));
  } finally {
    setLoading("loginSubmit", false, "Log In");
  }
});

// Signup.
$("signupForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessages();

  const fullName = $("signupName")?.value.trim() || "";
  const email = $("signupEmail")?.value.trim().toLowerCase() || "";
  const role = $("signupRole")?.value || "";
  const password = $("signupPassword")?.value || "";
  const confirmation = $("confirmPassword")?.value || "";

  if (!fullName || !email || !role || !password || !confirmation) {
    showMessage("signupMessage", "Please complete all required fields.");
    return;
  }

  if (!Object.hasOwn(destinations, role)) {
    showMessage("signupMessage", "Please select a valid account role.");
    return;
  }

  if (password.length < 8) {
    showMessage(
      "signupMessage",
      "Your password must contain at least 8 characters."
    );
    return;
  }

  if (password !== confirmation) {
    showMessage("signupMessage", "Your passwords do not match.");
    return;
  }

  setLoading("signupSubmit", true, "Create Account");

  let createdUser = null;

  try {
    const credential = await createUserWithEmailAndPassword(
      auth,
      email,
      password
    );

    createdUser = credential.user;

    await updateProfile(createdUser, {
      displayName: fullName
    });

    const nameParts = fullName.split(/\s+/);
    const firstName = nameParts.shift() || "";
    const lastName = nameParts.join(" ");

    const userProfile = {
      profile: {
        firstName,
        lastName,
        fullName,
        email,
        role,
        createdAt: new Date().toISOString()
      }
    };

    // Save under the authenticated user's own UID.
    await set(ref(db, `users/${createdUser.uid}`), userProfile);

    showMessage(
      "signupMessage",
      "Account created successfully! Redirecting...",
      "success"
    );

    window.location.replace(destinations[role]);
  } catch (error) {
    if (createdUser) {
      console.error("Profile save failed for UID:", createdUser.uid, error);

      showMessage(
        "signupMessage",
        "Your authentication account was created, but saving your profile failed. Do not sign up again with this email. Check your database rules and repair the profile for UID: " +
          createdUser.uid
      );
    } else {
      showMessage("signupMessage", friendlyError(error));
    }
  } finally {
    setLoading("signupSubmit", false, "Create Account");
  }
});

// Password reset.
$("forgotPasswordButton")?.addEventListener("click", async () => {
  clearMessages();

  const email = $("loginEmail")?.value.trim().toLowerCase() || "";

  if (!email) {
    showMessage("loginMessage", "Enter your email address first.");
    $("loginEmail")?.focus();
    return;
  }

  try {
    await sendPasswordResetEmail(auth, email);
    showMessage(
      "loginMessage",
      "If an account exists for that email, a password reset email has been requested.",
      "success"
    );
  } catch (error) {
    showMessage("loginMessage", friendlyError(error));
  }
});
