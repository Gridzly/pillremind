const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");

initializeApp({
  databaseURL: "https://pillremind-e6294-default-rtdb.firebaseio.com"
});

const db = getDatabase();

async function getUser(uid) {
  const snapshot = await db.ref(`users/${uid}`).get();

  if (!snapshot.exists()) {
    throw new HttpsError("not-found", "The account profile was not found.");
  }

  const user = snapshot.val() || {};
  const role = String(user.profile?.role || user.role || "")
    .toLowerCase()
    .trim();

  return { user, role };
}

function isPatient(role) {
  return ["patient", "medicine_taker", "medicine taker"].includes(role);
}

function isAuthorized(role) {
  return [
    "authorized",
    "caregiver",
    "authorized_person",
    "authorized person"
  ].includes(role);
}

/**
 * The patient shares their Firebase Auth UID (also encoded in their QR).
 * The patient must first enable the one-time automatic connection permission
 * in their own dashboard. Knowing a UID alone never grants access.
 */
exports.connectPatientByUid = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Please sign in first.");
  }

  const caregiverUid = request.auth.uid;
  const { role: caregiverRole } = await getUser(caregiverUid);

  if (!isAuthorized(caregiverRole)) {
    throw new HttpsError(
      "permission-denied",
      "Only an authorized caregiver account can connect to a patient."
    );
  }

  const patientUid = String(request.data?.patientUid || "").trim();

  if (!patientUid || patientUid.length < 20 || patientUid.length > 128) {
    throw new HttpsError("invalid-argument", "Enter or scan a valid patient UID.");
  }

  if (patientUid === caregiverUid) {
    throw new HttpsError(
      "failed-precondition",
      "You cannot connect an account to itself."
    );
  }

  const { user: patient, role: patientRole } = await getUser(patientUid);

  if (!isPatient(patientRole)) {
    throw new HttpsError(
      "failed-precondition",
      "This UID does not belong to a patient account."
    );
  }

  if (patient.profile?.allowCaregiverConnections !== true) {
    throw new HttpsError(
      "permission-denied",
      "The patient has not enabled automatic caregiver connections. Ask them to enable it in their patient dashboard."
    );
  }

  const connection = {
    patientUid,
    caregiverUid,
    connectedAt: Date.now(),
    status: "active"
  };

  const patientConnectionsRef = db.ref(`connectionsByPatient/${patientUid}`);
  const existingSnapshot = await patientConnectionsRef.get();
  const existingConnections = existingSnapshot.val() || {};
  const activeConnection = Object.values(existingConnections).find(
    item => item?.status === "active"
  );

  if (activeConnection?.caregiverUid === caregiverUid) {
    // Idempotent retry: repair the reciprocal records if needed.
    await db.ref().update({
      [`users/${patientUid}/careConnection`]: {
        authorizedUid: caregiverUid,
        connectedAt: activeConnection.connectedAt || Date.now(),
        status: "active"
      },
      [`connectionsByCaregiver/${caregiverUid}/${patientUid}`]: {
        ...activeConnection,
        patientUid,
        caregiverUid
      }
    });

    return {
      success: true,
      patientUid,
      message: "This patient is already connected to your account."
    };
  }

  if (activeConnection) {
    throw new HttpsError(
      "already-exists",
      "This patient already has an active caregiver connection."
    );
  }

  // Claim the patient connection atomically to prevent two caregivers
  // from connecting to the same patient at the same time.
  const transaction = await patientConnectionsRef.transaction(current => {
    const links = current || {};
    const active = Object.values(links).some(
      item => item?.status === "active"
    );

    if (active) return;
    return { ...links, [caregiverUid]: connection };
  });

  if (!transaction.committed) {
    throw new HttpsError(
      "already-exists",
      "This patient has just been connected to another caregiver."
    );
  }

  // The server writes the patient's pointer and caregiver's reciprocal link.
  // The browser is never allowed to write another user's careConnection.
  await db.ref().update({
    [`users/${patientUid}/careConnection`]: {
      authorizedUid: caregiverUid,
      connectedAt: connection.connectedAt,
      status: "active"
    },
    [`connectionsByCaregiver/${caregiverUid}/${patientUid}`]: connection
  });

  return {
    success: true,
    patientUid,
    message: "Patient connected successfully. Their medicines and reminders will now sync."
  };
});

exports.getMyConnections = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Please sign in first.");
  }

  const uid = request.auth.uid;
  const { role } = await getUser(uid);

  let path;

  if (isPatient(role)) {
    path = `connectionsByPatient/${uid}`;
  } else if (isAuthorized(role)) {
    path = `connectionsByCaregiver/${uid}`;
  } else {
    throw new HttpsError(
      "permission-denied",
      "Your account role cannot use patient connections."
    );
  }

  const snapshot = await db.ref(path).get();

  return {
    connections: snapshot.exists() ? snapshot.val() : {}
  };
});
