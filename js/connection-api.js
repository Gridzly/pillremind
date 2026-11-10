
import { auth, db } from "./firebaseConfig.js";

import {
  ref,
  get,
  set
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

/**
 * Medminder caregiver-to-patient connection API.
 * The caregiver can request a connection.
 * The patient must approve it from their own account.
 */

export async function callConnectionApi(action, payload = {}) {
  const user = auth.currentUser;

  if (!user) {
    throw new Error("Please sign in again.");
  }

  if (action !== "connectPatientByUid") {
    throw new Error("Unsupported connection action.");
  }

  const patientUid = String(payload.patientUid || "")
    .trim()
    .replace(/^MEDMINDER:/i, "");

  const caregiverUid = user.uid;

  if (!patientUid) {
    throw new Error("Please enter the patient's UID.");
  }

  if (patientUid === caregiverUid) {
    throw new Error("You cannot connect your account to itself.");
  }

  if (!/^[A-Za-z0-9_-]{20,128}$/.test(patientUid)) {
    throw new Error("Invalid patient UID.");
  }

  try {
    // Refresh authentication before making the request.
    await user.getIdToken(true);

    // Confirm the signed-in account is an authorized caregiver.
    const profileSnapshot = await get(
      ref(db, `users/${caregiverUid}/profile`)
    );

    const profile = profileSnapshot.val() || {};
    const role = String(profile.role || "")
      .trim()
      .toLowerCase();

    const allowedRoles = [
      "authorized",
      "caregiver",
      "authorized_person"
    ];

    if (!allowedRoles.includes(role)) {
      throw new Error(
        "Your account is not registered as an Authorized Person."
      );
    }

    const requestRef = ref(
      db,
      `users/${patientUid}/connectionRequests/${caregiverUid}`
    );

    // Prevent overwriting an existing request.
    const existingSnapshot = await get(requestRef);

    if (existingSnapshot.exists()) {
      const existing = existingSnapshot.val() || {};
      const status = String(existing.status || "").toLowerCase();

      if (status === "pending") {
        return {
          success: true,
          alreadyPending: true,
          patientUid,
          caregiverUid,
          message: "Your connection request is already pending."
        };
      }

      if (["active", "approved", "connected"].includes(status)) {
        return {
          success: true,
          alreadyConnected: true,
          patientUid,
          caregiverUid,
          message: "This connection has already been approved."
        };
      }

      throw new Error(
        "An existing request was found. Refresh your dashboard before trying again."
      );
    }

    const caregiverName =
      profile.fullName ||
      [profile.firstName, profile.lastName].filter(Boolean).join(" ") ||
      user.displayName ||
      user.email ||
      "Authorized Person";

    await set(requestRef, {
      caregiverUid,
      caregiverName,
      caregiverEmail: user.email || "",
      status: "pending",
      createdAt: Date.now()
    });

    console.log("MEDMINDER CONNECTION REQUEST SENT");
    console.log("Caregiver UID:", caregiverUid);
    console.log("Patient UID:", patientUid);

    return {
      success: true,
      patientUid,
      caregiverUid,
      message: "Request sent. Waiting for patient approval."
    };

  } catch (error) {
    console.error("Connection API error:", error);

    if (
      error.code === "PERMISSION_DENIED" ||
      error.code === "permission-denied"
    ) {
      throw new Error(
        "Firebase denied the request. Check the caregiver role, patient connection permission, and Database Rules."
      );
    }

    throw error;
  }
}
