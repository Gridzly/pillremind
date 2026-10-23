
import { auth, db } from "./firebaseConfig.js";

import {
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
  ref,
  get
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const loginForm = document.getElementById("loginForm");
const loginEmail = document.getElementById("loginEmail");
const loginPassword = document.getElementById("loginPassword");
const loginMessage = document.getElementById("loginMessage");
const loginSubmit = document.getElementById("loginSubmit");
const forgotPasswordButton = document.getElementById("forgotPasswordButton");

function displayLoginMessage(message, type = "error") {
  if (!loginMessage) {
    console[type === "error" ? "error" : "log"](message);
    return;
  }

  loginMessage.textContent = message;
  loginMessage.className = `message ${type}`;
}

function dashboardForRole(role) {
  const normalizedRole = String(role || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (["authorized", "caregiver", "authorized_person"].includes(normalizedRole)) {
    return "dashboard.html";
  }

  if (["patient", "medicine_taker", "patient_user"].includes(normalizedRole)) {
    return "patient-dashboard.html";
  }

  return null;
}

function setLoginLoading(isLoading) {
  if (!loginSubmit) return;

  loginSubmit.disabled = isLoading;
  loginSubmit.textContent = isLoading ? "Logging in..." : "Log In";
}

if (loginForm) {
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const email = loginEmail?.value.trim();
    const password = loginPassword?.value;

    if (!email || !password) {
      displayLoginMessage("Please enter your email and password.");
      return;
    }

    setLoginLoading(true);
    displayLoginMessage("");

    let signedInUser = null;

    try {
      // Authenticate the user with Firebase Authentication.
      const credential = await signInWithEmailAndPassword(
        auth,
        email,
        password
      );

      signedInUser = credential.user;

      // Read the authenticated user's own database record.
      const userSnapshot = await get(
        ref(db, `users/${signedInUser.uid}`)
      );

      if (!userSnapshot.exists()) {
        await signOut(auth);
        signedInUser = null;

        displayLoginMessage(
          "Your account profile was not found in Firebase. Please check your signup process."
        );
        return;
      }

      const userData = userSnapshot.val();

      // Your database stores roles under profile/role.
      // The direct role field is also supported for compatibility.
      const role = userData.profile?.role || userData.role;
      const destination = dashboardForRole(role);

      if (!destination) {
        console.error("Missing or unsupported account role:", userData);

        await signOut(auth);
        signedInUser = null;

        displayLoginMessage(
          "Your account role is missing or invalid. Please check the role saved in Firebase."
        );
        return;
      }

      // Redirect only after authentication and role verification.
      window.location.replace(destination);

    } catch (error) {
      console.error("Login failed:", error);

      const errorMessages = {
        "auth/invalid-credential":
          "Incorrect email or password.",
        "auth/user-not-found":
          "No account was found with this email.",
        "auth/wrong-password":
          "Incorrect email or password.",
        "auth/invalid-email":
          "Please enter a valid email address.",
        "auth/too-many-requests":
          "Too many login attempts. Please try again later.",
        "auth/network-request-failed":
          "Network error. Please check your internet connection.",
        "PERMISSION_DENIED":
          "Firebase denied access to your account. Please check your Database Rules."
      };

      displayLoginMessage(
        errorMessages[error.code] ||
          "Unable to log in. Please try again. Check the browser console for details."
      );

      // If authentication succeeded but profile lookup failed,
      // sign out so the user does not remain partially logged in.
      if (signedInUser) {
        try {
          await signOut(auth);
        } catch (signOutError) {
          console.error("Sign-out failed:", signOutError);
        }
      }
    } finally {
      setLoginLoading(false);
    }
  });
} else {
  console.error(
    "Login form not found. Make sure login.html contains id=\"loginForm\"."
  );
}

// Forgot Password
if (forgotPasswordButton) {
  forgotPasswordButton.addEventListener("click", async () => {
    const email = loginEmail?.value.trim();

    if (!email) {
      displayLoginMessage("Enter your email address first.");
      loginEmail?.focus();
      return;
    }

    try {
      await sendPasswordResetEmail(auth, email);

      displayLoginMessage(
        "Password reset instructions have been sent to your email.",
        "success"
      );
    } catch (error) {
      console.error("Password reset failed:", error);

      const message =
        error.code === "auth/invalid-email"
          ? "Please enter a valid email address."
          : error.code === "auth/user-not-found"
            ? "No account was found with this email."
            : "Unable to send the reset email. Please try again.";

      displayLoginMessage(message);
    }
  });
}
