
import { auth, db } from "./firebaseConfig.js";

import {
  ref,
  set
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

/**
 * Medminder Firebase Connection API
 *
 * Replaces the Cloudflare Worker.
 * Uses Firebase Authentication and Realtime Database.
 */

export async function callConnectionApi(action, payload = {}) {
  const user = auth.currentUser;

  if (!user) {
    throw new Error("Please sign in again.");
  }

  try {
    // Only support the patient UID connection action.
    if (action !== "connectPatientByUid") {
      throw new Error("Unsupported connection action.");
    }

    // Get and clean the patient UID.
    const patientUid = String(payload.patientUid || "")
      .trim()
      .replace(/^MEDMINDER:/i, "");

    const caregiverUid = user.uid;

    // Validate the UID.
    if (!patientUid) {
      throw new Error("Please enter the patient's UID.");
    }

    if (patientUid === caregiverUid) {
      throw new Error("You cannot connect your account to itself.");
    }

    if (!/^[A-Za-z0-9_-]{20,}$/.test(patientUid)) {
      throw new Error("Invalid patient UID. Please check the QR code or ID.");
    }

    // Get caregiver profile information.
    const caregiverName =
      user.displayName ||
      user.email ||
      "Authorized Caregiver";

    // Create a connection request in the patient's account.
    // Firebase rules will check the caregiver role and
    // whether the patient allows automatic connections.
    const requestRef = ref(
      db,
      `users/${patientUid}/connectionRequests/${caregiverUid}`
    );

    await set(requestRef, {
      caregiverUid,
      caregiverName,
      caregiverEmail: user.email || "",
      status: "pending",
      createdAt: Date.now()
    });

    return {
      success: true,
      patientUid,
      caregiverUid,
      message:
        "Connection request sent. Firebase will complete the automatic connection when the patient's dashboard processes it."
    };

  } catch (error) {
    console.error("Medminder Firebase connection error:", error);

    if (error.code === "PERMISSION_DENIED") {
      throw new Error(
        "Connection denied. Check that the patient has enabled automatic caregiver connections and that your account has the authorized role."
      );
    }

    throw error;
  }
}
