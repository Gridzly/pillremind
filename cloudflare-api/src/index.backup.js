
import { importX509, importPKCS8, SignJWT, jwtVerify } from "jose";

const ALLOWED_ORIGINS = [
  "https://nqhyqh-3000.csb.app",
  "https://3yk2g3.csb.app"
];

const CODE_LIFETIME_MS = 10 * 60 * 1000;

function json(data, status = 200, origin = "*") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Vary": "Origin"
    }
  });
}

function sha256(value) {
  return crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  ).then(buffer =>
    [...new Uint8Array(buffer)]
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("")
  );
}

async function verifyFirebaseToken(token, env) {
  const response = await fetch(
    "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com"
  );

  if (!response.ok) throw new Error("Could not load Firebase signing keys.");

  const certs = await response.json();
  const header = JSON.parse(
    atob(token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/"))
  );

  if (header.alg !== "RS256" || !certs[header.kid]) {
    throw new Error("Invalid Firebase token signing key.");
  }

  const key = await importX509(certs[header.kid], "RS256");
  const { payload } = await jwtVerify(token, key, {
    issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
    audience: env.FIREBASE_PROJECT_ID,
    algorithms: ["RS256"]
  });

  if (!payload.sub || payload.sub.length > 128) {
    throw new Error("Invalid Firebase user.");
  }

  return payload.sub;
}

async function getGoogleAccessToken(env) {
  const account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const privateKey = await importPKCS8(account.private_key, "RS256");

  const assertion = await new SignJWT({
    scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email"
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: account.private_key_id })
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
    throw new Error("Could not obtain database access.");
  }

  return result.access_token;
}

async function database(env, path, options = {}) {
  const accessToken = await getGoogleAccessToken(env);
  const url = `${env.FIREBASE_DATABASE_URL}/${path}.json`;

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (!response.ok) throw new Error("Database request failed.");
  return response.status === 204 ? null : response.json();
}

function isPatient(role) {
  return ["patient", "medicine_taker", "medicine taker"].includes(role);
}

function isAuthorized(role) {
  return ["authorized", "caregiver", "authorized_person"].includes(role);
}

async function getUser(env, uid) {
  const user = await database(env, `users/${uid}`);

  if (!user) throw new Error("User profile not found.");

  return {
    user,
    role: String(user.profile?.role || user.role || "")
      .toLowerCase()
      .trim()
  };
}

async function createCode(env, uid) {
  const { role } = await getUser(env, uid);

  if (!isPatient(role)) throw new Error("Only patients can create codes.");

  const connections = await database(env, `connectionsByPatient/${uid}`);

  if (Object.values(connections || {}).some(c => c?.status === "active")) {
    throw new Error("This patient already has an active caregiver.");
  }

  const old = await database(env, `activeConnectionCodes/${uid}`);

  if (old?.codeHash) {
    await database(env, `connectionCodes/${old.codeHash}`, {
      method: "DELETE"
    });
  }

  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 900000 + 100000);
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
    throw new Error("Only an authorized person can connect to a patient.");
  }

  const code = String(rawCode || "").replace(/^MEDMINDER:/, "").trim();

  if (!/^\d{6}$/.test(code)) throw new Error("Enter a valid six-digit code.");

  const codeHash = await sha256(code);
  const record = await database(env, `connectionCodes/${codeHash}`);

  if (!record || record.used || !record.patientUid ||
      Number(record.expiresAt) <= Date.now() ||
      Number(record.attempts || 0) >= 5) {
    throw new Error("This code is invalid, expired, or already used.");
  }

  const patientUid = record.patientUid;

  if (patientUid === caregiverUid) {
    throw new Error("You cannot connect an account to itself.");
  }

  const { role: patientRole } = await getUser(env, patientUid);

  if (!isPatient(patientRole)) throw new Error("The code owner is not a patient.");

  const existing = await database(env, `connectionsByPatient/${patientUid}`);

  if (Object.values(existing || {}).some(c => c?.status === "active")) {
    throw new Error("This patient already has an active caregiver.");
  }

  // Re-read before committing to reduce stale-code redemption.
  const current = await database(env, `connectionCodes/${codeHash}`);

  if (!current || current.used || current.expiresAt <= Date.now()) {
    throw new Error("This code has already been redeemed.");
  }

  const connectedAt = Date.now();
  const connection = {
    patientUid,
    caregiverUid,
    connectedAt,
    status: "active"
  };

  // Mark used before writing connection records.
  current.used = true;
  current.caregiverUid = caregiverUid;
  current.connectedAt = connectedAt;

  await database(env, `connectionCodes/${codeHash}`, {
    method: "PUT",
    body: JSON.stringify(current)
  });

  await database(env, "", {
    method: "PATCH",
    body: JSON.stringify({
      [`connectionsByPatient/${patientUid}/${caregiverUid}`]: connection,
      [`connectionsByCaregiver/${caregiverUid}/${patientUid}`]: connection,
      [`activeConnectionCodes/${patientUid}`]: null,
      [`connectionCodes/${codeHash}`]: null
    })
  });

  return { success: true, patientUid, message: "Patient connected successfully." };
}

async function getConnections(env, uid) {
  const { role } = await getUser(env, uid);
  let path;

  if (isPatient(role)) path = `connectionsByPatient/${uid}`;
  else if (isAuthorized(role)) path = `connectionsByCaregiver/${uid}`;
  else throw new Error("Your account role cannot use patient connections.");

  return { connections: (await database(env, path)) || {} };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
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

    if (!ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: "Origin not allowed." }, 403, origin);
    }

    if (request.method !== "POST") {
      return json({ error: "POST required." }, 405, origin);
    }

    try {
      const authorization = request.headers.get("Authorization") || "";
      const token = authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";

      if (!token) return json({ error: "Sign-in required." }, 401, origin);

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
      return json({
        error: error.message || "Request failed."
      }, 400, origin);
    }
  }
};
