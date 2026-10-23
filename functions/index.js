
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const crypto = require("crypto");

initializeApp();

const db = getDatabase();

const CODE_LIFETIME_MS = 10 * 60 * 1000;

function hashCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

async function getUser(uid) {
  const snapshot = await db.ref(`users/${uid}`).get();

  if (!snapshot.exists()) {
    throw new HttpsError("failed-precondition", "User profile not found.");
  }

  const user = snapshot.val();
  const role = user?.profile?.role || user?.role || "";

  return { user, role: String(role).toLowerCase().trim() };
}

function isPatient(role) {
  return ["patient", "medicine_taker", "medicine taker"].includes(role);
}

function isAuthorized(role) {
  return ["authorized", "caregiver", "authorized_person"].includes(role);
}

// Patient: generate a short-lived, one-time connection code.
exports.createConnectionCode = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Please sign in first.");
  }

  const patientUid = request.auth.uid;
  const { role } = await getUser(patientUid);

  if (!isPatient(role)) {
    throw new HttpsError(
      "permission-denied",
      "Only a patient can create a connection code."
    );
  }

  // Prevent creating a new code if this patient already has an active connection.
  const existingConnections = await db
    .ref(`connectionsByPatient/${patientUid}`)
    .get();

  if (existingConnections.exists()) {
    const active = Object.values(existingConnections.val()).some(
      connection => connection?.status === "active"
    );

    if (active) {
      throw new HttpsError(
        "failed-precondition",
        "Your account already has an active caregiver connection."
      );
    }
  }

  const code = String(crypto.randomInt(100000, 1000000));
  const codeHash = hashCode(code);
  const expiresAt = Date.now() + CODE_LIFETIME_MS;

  const activeRef = db.ref(`activeConnectionCodes/${patientUid}`);
  const previous = await activeRef.get();

  // Invalidate the patient's previous code.
  if (previous.exists() && previous.val()?.codeHash) {
    await db.ref(`connectionCodes/${previous.val().codeHash}`).remove();
  }

  await db.ref(`connectionCodes/${codeHash}`).set({
    patientUid,
    expiresAt,
    attempts: 0,
    used: false
  });

  await activeRef.set({ codeHash, expiresAt });

  return {
    code,
    expiresAt,
    expiresInSeconds: CODE_LIFETIME_MS / 1000,
    qrText: `MEDMINDER:${code}`
  };
});

// Authorized person: redeem the patient's code.
exports.redeemConnectionCode = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Please sign in first.");
  }

  const caregiverUid = request.auth.uid;
  const { role } = await getUser(caregiverUid);

  if (!isAuthorized(role)) {
    throw new HttpsError(
      "permission-denied",
      "Only an authorized person can connect to a patient."
    );
  }

  let code = String(request.data?.code || "").trim();

  if (code.startsWith("MEDMINDER:")) {
    code = code.slice("MEDMINDER:".length);
  }

  if (!/^\d{6}$/.test(code)) {
    throw new HttpsError(
      "invalid-argument",
      "Enter a valid six-digit connection code."
    );
  }

  const codeHash = hashCode(code);
  const codeRef = db.ref(`connectionCodes/${codeHash}`);

  // Reserve the code only if it is valid, unexpired and unused.
  const result = await codeRef.transaction(current => {
    if (
      !current ||
      current.used ||
      !current.patientUid ||
      Number(current.expiresAt) <= Date.now() ||
      Number(current.attempts || 0) >= 5
    ) {
      return;
    }

    current.attempts = Number(current.attempts || 0) + 1;
    current.used = true;
    current.caregiverUid = caregiverUid;
    current.connectedAt = Date.now();

    return current;
  });

  if (!result.committed) {
    throw new HttpsError(
      "not-found",
      "This code is invalid, expired, or already used. Ask the patient for a new code."
    );
  }

  const patientUid = result.snapshot.val().patientUid;

  // Validate that the code owner is not the caregiver's own account.
  if (patientUid === caregiverUid) {
    await codeRef.remove();
    await db.ref(`activeConnectionCodes/${patientUid}`).remove();

    throw new HttpsError(
      "failed-precondition",
      "You cannot connect an account to itself."
    );
  }

  // Confirm the patient still exists and has a patient role.
  const { role: patientRole } = await getUser(patientUid);

  if (!isPatient(patientRole)) {
    await codeRef.remove();
    await db.ref(`activeConnectionCodes/${patientUid}`).remove();

    throw new HttpsError(
      "failed-precondition",
      "The code does not belong to a patient account."
    );
  }

  // Prevent accidental replacement of an existing active caregiver.
  const existing = await db
    .ref(`connectionsByPatient/${patientUid}`)
    .get();

  if (existing.exists()) {
    const alreadyConnected = Object.values(existing.val()).some(
      connection => connection?.status === "active"
    );

    if (alreadyConnected) {
      await codeRef.remove();
      await db.ref(`activeConnectionCodes/${patientUid}`).remove();

      throw new HttpsError(
        "already-exists",
        "This patient already has an active caregiver connection."
      );
    }
  }

  const connectedAt = Date.now();

  const connection = {
    patientUid,
    caregiverUid,
    connectedAt,
    status: "active"
  };

  // The Admin SDK writes these records securely on the server.
  const updates = {};

  updates[`connectionsByPatient/${patientUid}/${caregiverUid}`] = connection;
  updates[`connectionsByCaregiver/${caregiverUid}/${patientUid}`] = connection;
  updates[`activeConnectionCodes/${patientUid}`] = null;
  updates[`connectionCodes/${codeHash}`] = null;

  await db.ref().update(updates);

  return {
    success: true,
    patientUid,
    message: "Patient connected successfully."
  };
});

// Return only the authenticated account's connection list.
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
