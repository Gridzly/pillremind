
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
    console.log(text);
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
      "Firebase denied access. Check your Realtime Database rules.",
    "permission-denied":
      "Firebase denied access. Check your Realtime Database rules."
  };

  return messages[error.code] ||
    `Something went wrong (${error.code || "unknown error"}). Check the browser console.`;
}

// SWITCH BETWEEN LOGIN AND SIGNUP
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

// SHOW / HIDE PASSWORD
document.querySelectorAll(".toggle-password").forEach((button) => {
  button.addEventListener("click", () => {
    const targetId = button.getAttribute("data-target");
    const input = document.getElementById(targetId);

    if (!input) {
      console.error("Password input not found:", targetId);
      return;
    }

    const isHidden = input.type === "password";

    input.type = isHidden ? "text" : "password";

    button.textContent = isHidden ? "Hide" : "Show";

    button.setAttribute(
      "aria-label",
      isHidden ? "Hide password" : "Show password"
    );

    button.setAttribute(
      "aria-pressed",
      String(isHidden)
    );
  });
});

// LOGIN
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

    const uid = credential.user.uid;

    console.log("Firebase login successful. UID:", uid);

    // READ THE USER'S PROFILE
    const profileSnapshot = await get(
      ref(db, `users/${uid}/profile`)
    );

    if (!profileSnapshot.exists()) {
      showMessage(
        "loginMessage",
        "Your Firebase account exists, but its profile is missing. Your profile needs to be repaired."
      );

      console.error("Missing profile for UID:", uid);
      return;
    }

    const profile = profileSnapshot.val();

    console.log("Loaded Medminder profile:", profile);

    // REDIRECT BASED ON ACCOUNT ROLE
    const destination = destinations[profile.role];

    if (!destination) {
      showMessage(
        "loginMessage",
        `Unrecognized account role: ${profile.role || "empty"}. Please check your Firebase profile.`
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

// SIGNUP
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
    // CREATE FIREBASE AUTHENTICATION ACCOUNT
    const credential = await createUserWithEmailAndPassword(
      auth,
      email,
      password
    );

    createdUser = credential.user;

    // SAVE DISPLAY NAME IN FIREBASE AUTHENTICATION
    await updateProfile(createdUser, {
      displayName: fullName
    });

    const nameParts = fullName.split(/\s+/);
    const firstName = nameParts.shift() || "";
    const lastName = nameParts.join(" ");

    // SAVE PROFILE TO USERS/{UID}/PROFILE
    // THIS MATCHES YOUR FIREBASE DATABASE RULES.
    const userProfile = {
      firstName,
      lastName,
      fullName,
      email,
      role,
      createdAt: new Date().toISOString()
    };

    await set(
      ref(db, `users/${createdUser.uid}/profile`),
      userProfile
    );

    console.log(
      "Medminder profile successfully saved:",
      createdUser.uid
    );

    showMessage(
      "signupMessage",
      "Account created successfully! Redirecting...",
      "success"
    );

    window.location.replace(destinations[role]);

  } catch (error) {
    console.error("Signup error:", error);

    if (createdUser) {
      console.error(
        "Authentication account created, but profile saving failed. UID:",
        createdUser.uid
      );

      showMessage(
        "signupMessage",
        "Your authentication account was created, but saving your profile failed. Do not register again. Check Firebase Database Rules. Your UID is: " +
          createdUser.uid
      );

    } else {
      showMessage("signupMessage", friendlyError(error));
    }

  } finally {
    setLoading("signupSubmit", false, "Create Account");
  }
});

// PASSWORD RESET
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
