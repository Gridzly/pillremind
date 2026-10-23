
import { importX509, importPKCS8, SignJWT, jwtVerify } from "jose";

const ALLOWED_ORIGINS = new Set([
  "https://nqhyqh-3000.csb.app",
  "https://3yk2g3.csb.app"
]);

const CODE_LIFETIME_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

function json(data, status, origin) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Vary": "Origin"
  };

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
  }

  return new Response(JSON.stringify(data), { status, headers });
}

function safeError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function sha256(value) {
  const result = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );

  return [...new Uint8Array(result)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyFirebaseToken(token, env) {
  const response = await fetch(
    "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com"
  );

  if (!response.ok) throw safeError("Authentication service unavailable.", 503);

  const certs = await response.json();

  let header;
  try {
    const encoded = token.split(".")[0];
    header = JSON.parse(
      atob(encoded.replace(/-/g, "+").replace(/_/g, "/"))
    );
  } catch {
    throw safeError("Invalid sign-in token.", 401);
  }

  if (header.alg !== "RS256" || !certs[header.kid]) {
    throw safeError("Invalid sign-in token.", 401);
  }

  const key = await importX509(certs[header.kid], "RS256");

  let payload;
  try {
    ({ payload } = await jwtVerify(token, key, {
      issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
      audience: env.FIREBASE_PROJECT_ID,
      algorithms: ["RS256"]
    }));
  } catch {
    throw safeError("Your session has expired. Please sign in again.", 401);
  }

  if (
    !payload.sub ||
    payload.sub.length > 128 ||
    !payload.iat ||
    !payload.exp
  ) {
    throw safeError("Invalid sign-in token.", 401);
  }

  return payload.sub;
}

async function getGoogleAccessToken(env) {
  if (!env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error("Worker service credentials are not configured.");
  }

  const account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const privateKey = await importPKCS8(account.private_key, "RS256");

  const assertion = await new SignJWT({
    scope: "https://www.googleapis.com/auth/firebase.database"
  })
    .setProtectedHeader({
      alg: "RS256",
      typ: "JWT",
      kid: account.private_key_id
    })
    .setIssuer(account.client_email)
    .setSubject(account.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });

  const result = await response.json();

  if (!response.ok || !result.access_token) {
    throw new Error("Database authorization failed.");
  }

  return result.access_token;
}

async function databaseRequest(env, path, options = {}) {
  const accessToken = await getGoogleAccessToken(env);
  const base = env.FIREBASE_DATABASE_URL.replace(/\/+$/, "");
  const cleanPath = path ? `${path}.json` : ".json";
  const url = `${base}/${cleanPath}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    throw new Error(`Database request failed (${response.status}).`);
  }

  return {
    value: response.status === 204 ? null : await response.json(),
    etag: response.headers.get("ETag")
  };
}

async function database(env, path, options = {}) {
  const result = await databaseRequest(env, path, options);
  return result.value;
}

function isPatient(role) {
  return ["patient", "medicine_taker", "medicine taker"].includes(role);
}

function isAuthorized(role) {
  return ["authorized", "caregiver", "authorized_person"].includes(role);
}

async function getUser(env, uid) {
  const user = await database(env, `users/${uid}`);

  if (!user) throw safeError("User profile not found.", 403);

  const role = String(user.profile?.role || user.role || "")
    .toLowerCase()
    .trim();

  return { user, role };
}

async function createCode(env, uid) {
  const { role } = await getUser(env, uid);

  if (!isPatient(role)) {
    throw safeError("Only patients can create connection codes.", 403);
  }

  const connections = await database(env, `connectionsByPatient/${uid}`);

  if (Object.values(connections || {}).some(c => c?.status === "active")) {
    throw safeError("This patient already has an active caregiver.", 409);
  }

  const old = await database(env, `activeConnectionCodes/${uid}`);

  if (old?.codeHash) {
    await database(env, `connectionCodes/${old.codeHash}`, {
      method: "DELETE"
    });
  }

  // Avoid modulo bias and keep the code to six digits.
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  const code = String(100000 + (random[0] % 900000));
  const codeHash = await sha256(code);
  const expiresAt = Date.now() + CODE_LIFETIME_MS;

  await database(env, `connectionCodes/${codeHash}`, {
    method: "PUT",
    body: JSON.stringify({
      patientUid: uid,
      expiresAt,
      attempts: 0,
      used: false
    })
  });

  await database(env, `activeConnectionCodes/${uid}`, {
    method: "PUT",
    body: JSON.stringify({ codeHash, expiresAt })
  });

  return {
    code,
    expiresAt,
    expiresInSeconds: 600,
    qrText: `MEDMINDER:${code}`
  };
}

async function redeemCode(env, caregiverUid, rawCode) {
  const { role } = await getUser(env, caregiverUid);

  if (!isAuthorized(role)) {
    throw safeError("Only an authorized person can connect to a patient.", 403);
  }

  const code = String(rawCode || "")
    .replace(/^MEDMINDER:/i, "")
    .trim();

  if (!/^\d{6}$/.test(code)) {
    throw safeError("Enter a valid six-digit code.");
  }

  const codeHash = await sha256(code);
  const path = `connectionCodes/${codeHash}`;

  // Read the record with its ETag so the claim can be conditional.
  const first = await databaseRequest(env, path, {
    headers: { "X-Firebase-ETag": "true" }
  });

  const record = first.value;

  if (
    !record ||
    record.used ||
    !record.patientUid ||
    Number(record.expiresAt) <= Date.now() ||
    Number(record.attempts || 0) >= MAX_CODE_ATTEMPTS
  ) {
    throw safeError("This code is invalid, expired, or already used.", 409);
  }

  const patientUid = record.patientUid;

  if (patientUid === caregiverUid) {
    throw safeError("You cannot connect an account to itself.", 403);
  }

  const { role: patientRole } = await getUser(env, patientUid);

  if (!isPatient(patientRole)) {
    throw safeError("The code owner is not a patient.", 409);
  }

  const connections = await database(env, `connectionsByPatient/${patientUid}`);

  if (Object.values(connections || {}).some(c => c?.status === "active")) {
    throw safeError("This patient already has an active caregiver.", 409);
  }

  const active = await database(env, `activeConnectionCodes/${patientUid}`);

  if (
    !active ||
    active.codeHash !== codeHash ||
    Number(active.expiresAt) <= Date.now()
  ) {
    throw safeError("This code is no longer active.", 409);
  }

  const connectedAt = Date.now();
  const connection = {
    patientUid,
    caregiverUid,
    connectedAt,
    status: "active"
  };

  const claimed = {
    ...record,
    used: true,
    caregiverUid,
    connectedAt
  };

  // Conditional write: only one request with this ETag can claim the code.
  const accessToken = await getGoogleAccessToken(env);
  const base = env.FIREBASE_DATABASE_URL.replace(/\/+$/, "");
  const claimResponse = await fetch(`${base}/${path}.json`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "If-Match": first.etag || "null_etag"
    },
    body: JSON.stringify(claimed)
  });

  if (claimResponse.status === 412) {
    throw safeError("This code has already been redeemed. Generate a new code.", 409);
  }

  if (!claimResponse.ok) {
    throw new Error("Could not safely claim the connection code.");
  }

  // The claim is now consumed. If this update fails, it must be reconciled
  // rather than allowing the code to be redeemed again.
  await database(env, "", {
    method: "PATCH",
    body: JSON.stringify({
      [`connectionsByPatient/${patientUid}/${caregiverUid}`]: connection,
      [`connectionsByCaregiver/${caregiverUid}/${patientUid}`]: connection,
      [`activeConnectionCodes/${patientUid}`]: null,
      [`connectionCodes/${codeHash}`]: null
    })
  });

  return {
    success: true,
    patientUid,
    message: "Patient connected successfully."
  };
}

async function getConnections(env, uid) {
  const { role } = await getUser(env, uid);
  let path;

  if (isPatient(role)) {
    path = `connectionsByPatient/${uid}`;
  } else if (isAuthorized(role)) {
    path = `connectionsByCaregiver/${uid}`;
  } else {
    throw safeError("Your account role cannot use patient connections.", 403);
  }

  return { connections: (await database(env, path)) || {} };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      if (!ALLOWED_ORIGINS.has(origin)) {
        return new Response(null, { status: 403 });
      }

      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
          "Vary": "Origin"
        }
      });
    }

    if (!ALLOWED_ORIGINS.has(origin)) {
      return json({ error: "Origin not allowed." }, 403, "");
    }

    if (request.method !== "POST") {
      return json({ error: "POST required." }, 405, origin);
    }

    try {
      const authorization = request.headers.get("Authorization") || "";
      const token = authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";

      if (!token) {
        return json({ error: "Please sign in first." }, 401, origin);
      }

      const uid = await verifyFirebaseToken(token, env);
      const body = await request.json();

      let result;

      switch (body.action) {
        case "createConnectionCode":
          result = await createCode(env, uid);
          break;
        case "redeemConnectionCode":
          result = await redeemCode(env, uid, body.code);
          break;
        case "getMyConnections":
          result = await getConnections(env, uid);
          break;
        default:
          return json({ error: "Unknown action." }, 400, origin);
      }

      return json({ success: true, data: result }, 200, origin);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;

      // Avoid exposing database or private-key details to the browser.
      const message = status === 500
        ? "The connection service encountered an error. Please try again."
        : error.message;

      return json({ error: message }, status, origin);
    }
  }
};
