
import { auth, db } from "./firebaseConfig.js";

import {
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
  ref,
  get,
  onValue,
  set,
  remove
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

/* =====================================================
   STATE
===================================================== */

const $ = id => document.getElementById(id);

const state = {
  user: null,
  profile: {},
  caregiverUid: null,
  connectionInfo: {},
  medicines: {},
  reminders: {},
  logs: {},
  connectionRequests: {},
  unsubscribers: [],
  connectionUnsubscribe: null,
  requestUnsubscribe: null,
  logUnsubscribe: null,
  recording: new Set(),
  processingRequests: new Set()
};

/* =====================================================
   HELPERS
===================================================== */

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function notice(type, message) {
  ["error", "success", "info"].forEach(id => {
    const element = $(id);
    if (element) {
      element.textContent = "";
      element.classList.remove("show");
    }
  });

  const element = $(type);
  if (element) {
    element.textContent = message;
    element.classList.add("show");
  }
}

function clearNotices() {
  ["error", "success", "info"].forEach(id => {
    const element = $(id);
    if (element) {
      element.textContent = "";
      element.classList.remove("show");
    }
  });
}

function setLoading(loading) {
  $("loading")?.classList.toggle("hidden", !loading);
  $("app")?.classList.toggle("ready", !loading);
}

function normalizeCollection(value) {
  if (!value || typeof value !== "object") return {};

  return Object.fromEntries(
    Object.entries(value).filter(([, item]) =>
      item && typeof item === "object"
    )
  );
}

function todayKey(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function formatDate(value) {
  if (!value) return "Date not specified";

  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return String(value);

  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

function formatTime(value) {
  if (!value) return "Time not set";

  const match = String(value).match(/^(\d{1,2}):(\d{2})/);
  if (!match) return String(value);

  const date = new Date();
  date.setHours(Number(match[1]), Number(match[2]), 0, 0);

  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit"
  });
}

function medicineName(medicine) {
  return medicine?.name ||
    medicine?.medicineName ||
    medicine?.medicationName ||
    medicine?.productName ||
    "Unnamed medicine";
}

function medicineDosage(medicine) {
  return medicine?.dosage ||
    medicine?.dose ||
    medicine?.strength ||
    medicine?.medicineDosage ||
    "Dosage not specified";
}

function isActiveMedicine(medicine) {
  return medicine?.active !== false &&
    medicine?.isActive !== false &&
    medicine?.archived !== true;
}

function reminderMedicineId(reminder) {
  return reminder?.medicineId ||
    reminder?.medicationId ||
    reminder?.medicineKey ||
    reminder?.medicine?.id ||
    reminder?.medicineSnapshot?.id ||
    "";
}

function reminderDate(reminder) {
  return reminder?.date ||
    reminder?.scheduledDate ||
    reminder?.startDate ||
    "";
}

function reminderTime(reminder) {
  return reminder?.time ||
    reminder?.scheduledTime ||
    reminder?.reminderTime ||
    "";
}

function dayName(dateString) {
  const date = new Date(`${dateString}T12:00:00`);
  if (Number.isNaN(date.getTime())) return "";

  return [
    "Sunday", "Monday", "Tuesday", "Wednesday",
    "Thursday", "Friday", "Saturday"
  ][date.getDay()].toLowerCase();
}

function reminderDays(reminder) {
  const days = reminder?.daysOfWeek ?? reminder?.days ?? [];

  if (Array.isArray(days)) {
    return days.map(day => String(day).toLowerCase());
  }

  if (typeof days === "string") {
    return days.split(",").map(day => day.trim().toLowerCase());
  }

  if (days && typeof days === "object") {
    return Object.keys(days)
      .filter(day => days[day])
      .map(day => day.toLowerCase());
  }

  return [];
}

function matchesDays(days, dateString) {
  if (!days.length) return true;

  const fullDay = dayName(dateString);
  const shortDay = fullDay.slice(0, 3);
  const date = new Date(`${dateString}T12:00:00`);
  const numberDay = String(date.getDay());

  return days.some(day =>
    day === fullDay ||
    day === shortDay ||
    day === numberDay ||
    day.slice(0, 3) === shortDay
  );
}

function isScheduled(reminder, dateString) {
  if (reminder?.active === false || reminder?.isActive === false) {
    return false;
  }

  const recurrence = String(
    reminder?.recurrence ||
    reminder?.repeat ||
    reminder?.frequency ||
    "once"
  ).toLowerCase();

  const days = reminderDays(reminder);
  const startDate = reminderDate(reminder);
  const endDate = reminder?.endDate || "";

  if (startDate && dateString < startDate) return false;
  if (endDate && dateString > endDate) return false;

  if (["daily", "everyday", "every day"].includes(recurrence)) {
    return true;
  }

  if (recurrence === "weekly" || days.length) {
    return matchesDays(days, dateString);
  }

  return !startDate || startDate === dateString;
}

function logKey(reminderId, date) {
  return `${reminderId}_${date}`;
}

function getLog(reminderId, date) {
  return state.logs[logKey(reminderId, date)] || null;
}

function isDoseCompleted(reminderId, date) {
  const status = String(
    getLog(reminderId, date)?.status || ""
  ).toLowerCase();

  return status === "taken" || status === "missed";
}

function getStatus(reminderId, date) {
  return String(
    getLog(reminderId, date)?.status || "pending"
  ).toLowerCase();
}

function getReminderEntries(date) {
  return Object.entries(state.reminders)
    .filter(([, reminder]) => isScheduled(reminder, date))
    .map(([id, reminder]) => ({
      id,
      reminder,
      date,
      time: reminderTime(reminder)
    }))
    .sort((a, b) =>
      String(a.time).localeCompare(String(b.time))
    );
}

function getReminderMedicine(reminder) {
  if (!reminder) return null;

  const snapshot =
    reminder.medicineSnapshot ||
    reminder.medicineDetails ||
    reminder.medicine;

  if (snapshot && typeof snapshot === "object") {
    return {
      ...snapshot,
      name:
        snapshot.name ||
        snapshot.medicineName ||
        reminder.medicineName ||
        reminder.name ||
        "Unnamed medicine",
      dosage:
        snapshot.dosage ||
        snapshot.dose ||
        snapshot.strength ||
        reminder.medicineDosage ||
        reminder.dosage ||
        reminder.dose ||
        ""
    };
  }

  if (
    reminder.medicineName ||
    reminder.medicineDosage ||
    reminder.name ||
    reminder.dosage
  ) {
    return {
      name: reminder.medicineName || reminder.name,
      dosage:
        reminder.medicineDosage ||
        reminder.dosage ||
        reminder.dose ||
        "",
      instructions:
        reminder.medicineInstructions ||
        reminder.instructions ||
        reminder.notes ||
        ""
    };
  }

  return null;
}

function findMedicine(reminder) {
  const id = reminderMedicineId(reminder);

  if (id && state.medicines[id]) {
    return state.medicines[id];
  }

  return getReminderMedicine(reminder);
}

function empty(containerId, title, message) {
  const container = $(containerId);
  if (!container) return;

  container.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">🌿</div>
      <strong>${escapeHTML(title)}</strong>
      <p>${escapeHTML(message)}</p>
    </div>
  `;
}

/* =====================================================
   PATIENT MEDICINE LIST
===================================================== */

function getPatientMedicineEntries() {
  const medicines = new Map();

  Object.entries(state.medicines).forEach(([id, medicine]) => {
    if (!isActiveMedicine(medicine)) return;

    medicines.set(`id:${id}`, {
      id,
      medicine,
      source: "medicine",
      reminders: []
    });
  });

  Object.entries(state.reminders).forEach(([reminderId, reminder]) => {
    if (
      reminder?.active === false ||
      reminder?.isActive === false
    ) return;

    const medicine = findMedicine(reminder);
    if (!medicine || !isActiveMedicine(medicine)) return;

    const medicineId = reminderMedicineId(reminder);
    const identity = medicineId
      ? `id:${medicineId}`
      : `name:${medicineName(medicine).trim().toLowerCase()}`;

    const existing = medicines.get(identity);

    if (existing) {
      existing.reminders.push({ id: reminderId, reminder });
    } else {
      medicines.set(identity, {
        id: medicineId || reminderId,
        medicine,
        source: "reminder",
        reminders: [{ id: reminderId, reminder }]
      });
    }
  });

  return Array.from(medicines.values());
}

/* =====================================================
   PATIENT PROFILE AND QR CODE
===================================================== */

function renderQRCode(uid) {
  const container = $("patientQrCode");
  if (!container) return;

  container.innerHTML = "";

  if (typeof QRCode === "undefined") {
    container.textContent =
      "QR library unavailable. You can still share your patient ID.";
    return;
  }

  new QRCode(container, {
    text: uid,
    width: 200,
    height: 200,
    colorDark: "#175638",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M
  });
}

function updateUserDisplay(profile, user) {
  const name = profile.firstName ||
    profile.fullName?.trim()?.split(/\s+/)[0] ||
    user.displayName?.split(/\s+/)[0] ||
    "Patient";

  if ($("welcomeTitle")) {
    $("welcomeTitle").textContent = `Hello, ${name}! 👋`;
  }

  if ($("sideUserName")) $("sideUserName").textContent = name;
  if ($("headerAccountName")) $("headerAccountName").textContent = name;
  if ($("userAvatar")) {
    $("userAvatar").textContent = name.charAt(0).toUpperCase();
  }

  if ($("headerUserName")) {
    $("headerUserName").textContent = name.charAt(0).toUpperCase();
    $("headerUserName").title = name;
  }

  if ($("patientUidDisplay")) {
    $("patientUidDisplay").textContent = user.uid;
  }

  renderQRCode(user.uid);
}

function updateConnectionStatus(connected, message) {
  const badge = $("connectionStatusBadge");

  if (badge) {
    badge.textContent = connected ? "Connected" : "Not connected";
    badge.classList.toggle("connected", connected);
  }

  if ($("connectionStatus")) {
    $("connectionStatus").textContent = message;
  }
}

/* =====================================================
   CONNECTION REQUEST PANEL
===================================================== */

function ensureConnectionRequestPanel() {
  let panel = $("connectionRequestsPanel");
  if (panel) return panel;

  const qrContainer = $("patientQrCode");
  if (!qrContainer) return null;

  const anchor =
    qrContainer.closest(".panel, .card, section") || qrContainer;

  panel = document.createElement("section");
  panel.id = "connectionRequestsPanel";
  panel.className = "panel";

  panel.style.cssText = `
    margin-top:20px;
    padding:22px;
    background:#ffffff;
    border:1px solid #e2ebe4;
    border-radius:18px;
    box-shadow:0 5px 18px rgba(23,86,56,.04);
  `;

  panel.innerHTML = `
    <div style="margin-bottom:20px;">
      <h2 style="margin:0;color:#175638;font-size:19px;font-weight:800;">
        Caregiver Connections
      </h2>
      <p style="margin:6px 0 0;color:#718078;font-size:13px;">
        Manage your caregiver and review connection requests.
      </p>
    </div>

    <div id="activeCaregiverCard"></div>

    <div style="
      display:flex;align-items:center;justify-content:space-between;
      gap:12px;flex-wrap:wrap;margin-top:22px;padding-top:18px;
      border-top:1px solid #edf1ee;
    ">
      <div>
        <h3 style="margin:0;color:#175638;font-size:16px;">
          Connection Requests
        </h3>
        <p style="margin:5px 0 0;color:#718078;font-size:12px;">
          Approve or reject caregiver requests.
        </p>
      </div>
      <span id="connectionRequestCount" style="
        background:#e7f4eb;color:#175638;padding:7px 12px;
        border-radius:20px;font-size:12px;font-weight:800;
      ">0 Pending</span>
    </div>

    <div id="connectionRequestsList" style="margin-top:15px;">
      <p style="color:#718078;font-size:14px;">
        Checking for connection requests...
      </p>
    </div>
  `;

  anchor.insertAdjacentElement("afterend", panel);
  return panel;
}

function renderConnectionRequests() {
  ensureConnectionRequestPanel();

  const list = $("connectionRequestsList");
  const count = $("connectionRequestCount");
  if (!list) return;

  const entries = Object.entries(state.connectionRequests)
    .filter(([, request]) =>
      request &&
      String(request.status || "").toLowerCase() === "pending"
    );

  if (count) count.textContent = `${entries.length} Pending`;

  if (!entries.length) {
    list.innerHTML = `
      <div style="
        padding:15px;background:#f6faf7;border-radius:12px;
        text-align:center;
      ">
        <div style="font-size:25px;margin-bottom:8px;">📭</div>
        <strong style="color:#175638;">No pending requests</strong>
        <p style="margin:6px 0 0;color:#718078;font-size:13px;">
          New caregiver requests will appear here.
        </p>
      </div>
    `;
    return;
  }

  list.innerHTML = entries.map(([caregiverUid, request]) => {
    const caregiverName = request.caregiverName || "Authorized caregiver";
    const caregiverEmail = request.caregiverEmail || "Email not provided";
    const createdAt = request.createdAt
      ? new Date(request.createdAt).toLocaleString()
      : "Date not available";

    const busy = state.processingRequests.has(caregiverUid);

    return `
      <article style="
        padding:16px;margin-bottom:12px;border:1px solid #e2ebe4;
        border-radius:13px;background:#ffffff;
      ">
        <div style="display:flex;align-items:flex-start;gap:12px;">
          <div style="
            width:44px;height:44px;flex-shrink:0;display:flex;
            align-items:center;justify-content:center;
            background:#e7f4eb;color:#175638;border-radius:50%;
            font-size:20px;
          ">👤</div>

          <div style="flex:1;min-width:0;">
            <strong style="display:block;color:#175638;font-size:15px;">
              ${escapeHTML(caregiverName)}
            </strong>
            <p style="margin:5px 0;color:#64736a;font-size:13px;">
              ${escapeHTML(caregiverEmail)}
            </p>
            <p style="margin:5px 0;color:#89958d;font-size:11px;">
              Request received: ${escapeHTML(createdAt)}
            </p>
            <p style="
              margin:7px 0 0;color:#89958d;font-size:11px;
              overflow-wrap:anywhere;
            ">
              Caregiver ID: ${escapeHTML(caregiverUid)}
            </p>
          </div>
        </div>

        <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:15px;">
          <button
            type="button"
            data-connection-action="approve"
            data-caregiver-uid="${escapeHTML(caregiverUid)}"
            ${busy ? "disabled" : ""}
            style="
              flex:1 1 120px;min-height:44px;border:0;border-radius:9px;
              padding:11px;background:#175638;color:white;
              font-weight:700;cursor:pointer;
            ">
            ${busy ? "Please wait..." : "✓ Approve"}
          </button>

          <button
            type="button"
            data-connection-action="reject"
            data-caregiver-uid="${escapeHTML(caregiverUid)}"
            ${busy ? "disabled" : ""}
            style="
              flex:1 1 120px;min-height:44px;
              border:1px solid #e2d7d7;border-radius:9px;
              padding:11px;background:white;color:#b33b3b;
              font-weight:700;cursor:pointer;
            ">
            ✕ Reject
          </button>
        </div>
      </article>
    `;
  }).join("");
}

/* =====================================================
   ACTIVE CAREGIVER
===================================================== */

function renderActiveCaregiver() {
  const container = $("activeCaregiverCard");
  if (!container) return;

  if (!state.caregiverUid) {
    container.innerHTML = `
      <div style="
        padding:18px;background:#f6faf7;border:1px dashed #cbdccf;
        border-radius:14px;text-align:center;
      ">
        <div style="font-size:30px;margin-bottom:9px;">🔗</div>
        <strong style="display:block;color:#175638;font-size:15px;">
          No caregiver connected
        </strong>
        <p style="margin:6px 0 0;color:#718078;font-size:13px;">
          Share your patient QR code or UID with your authorized caregiver.
          Their request will appear below.
        </p>
      </div>
    `;
    return;
  }

  const connection = state.connectionInfo || {};
  const caregiverName = connection.caregiverName || "Authorized Caregiver";
  const caregiverEmail = connection.caregiverEmail || "Email not available";

  container.innerHTML = `
    <div style="
      padding:18px;background:#f1f8f3;border:1px solid #d7e9dc;
      border-radius:15px;
    ">
      <div style="
        display:flex;align-items:center;justify-content:space-between;
        gap:10px;flex-wrap:wrap;margin-bottom:15px;
      ">
        <strong style="color:#175638;font-size:13px;">
          🟢 Active Connection
        </strong>
        <span style="
          padding:5px 10px;border-radius:20px;background:#dff2e5;
          color:#17643b;font-size:11px;font-weight:800;
        ">CONNECTED</span>
      </div>

      <div style="display:flex;align-items:center;gap:13px;">
        <div style="
          width:48px;height:48px;flex-shrink:0;display:flex;
          align-items:center;justify-content:center;border-radius:50%;
          background:#175638;color:white;font-size:20px;font-weight:800;
        ">
          ${escapeHTML(caregiverName.charAt(0).toUpperCase())}
        </div>
        <div style="min-width:0;flex:1;">
          <strong style="display:block;color:#175638;font-size:16px;">
            ${escapeHTML(caregiverName)}
          </strong>
          <p style="margin:4px 0 0;color:#64736a;font-size:13px;">
            ${escapeHTML(caregiverEmail)}
          </p>
        </div>
      </div>

      <div style="margin-top:15px;padding:12px;background:white;border-radius:10px;">
        <p style="margin:0 0 5px;color:#89958d;font-size:11px;font-weight:700;">
          CAREGIVER ID
        </p>
        <p style="margin:0;color:#526259;font-size:12px;overflow-wrap:anywhere;">
          ${escapeHTML(state.caregiverUid)}
        </p>
      </div>

      <button
        type="button"
        id="disconnectCaregiverButton"
        style="
          width:100%;min-height:44px;margin-top:15px;padding:12px;
          border:1px solid #efcaca;border-radius:10px;
          background:#fff5f5;color:#b42323;font-size:13px;
          font-weight:800;cursor:pointer;
        ">
        ✕ Disconnect Caregiver
      </button>
    </div>
  `;

  $("disconnectCaregiverButton")?.addEventListener(
    "click",
    disconnectCaregiver
  );
}


/* =====================================================
   APPROVE CONNECTION
   PATIENT MUST APPROVE THE CAREGIVER REQUEST
===================================================== */


async function approveConnectionRequest(caregiverUid) {
  if (!state.user || !caregiverUid) return;
  if (state.processingRequests.has(caregiverUid)) return;

  if (state.caregiverUid && state.caregiverUid !== caregiverUid) {
    notice("error", "Disconnect your current caregiver first.");
    return;
  }

  const request = state.connectionRequests[caregiverUid];

  if (
    !request ||
    String(request.status || "").toLowerCase() !== "pending"
  ) {
    notice("error", "This connection request is no longer pending.");
    return;
  }

  state.processingRequests.add(caregiverUid);
  renderConnectionRequests();

  const patientUid = auth.currentUser?.uid;

  if (!patientUid || patientUid !== state.user.uid) {
    state.processingRequests.delete(caregiverUid);
    renderConnectionRequests();
    notice("error", "Patient authentication has expired. Please sign in again.");
    return;
  }

  const patientConnectionPath =
    `users/${patientUid}/careConnection`;

  const caregiverPatientPath =
    `users/${caregiverUid}/connectedPatients/${patientUid}`;

  const requestPath =
    `users/${patientUid}/connectionRequests/${caregiverUid}`;

  const deviceIndexPath =
    `devicePatientIndex/${patientUid}`;

  try {
    console.log("====================================");
    console.log("PATIENT APPROVAL STARTED");
    console.log("Patient UID:", patientUid);
    console.log("Caregiver UID:", caregiverUid);
    console.log("====================================");

    // STEP 1: Read current connection and patient profile.
    const [connectionSnapshot, profileSnapshot, requestSnapshot] =
      await Promise.all([
        get(ref(db, patientConnectionPath)),
        get(ref(db, `users/${patientUid}/profile`)),
        get(ref(db, requestPath))
      ]);

    const currentConnection = connectionSnapshot.val() || {};
    const patientProfile = profileSnapshot.val() || {};
    const latestRequest = requestSnapshot.val();

    // STEP 2: Verify that the request is still pending.
    if (
      !latestRequest ||
      latestRequest.caregiverUid !== caregiverUid ||
      String(latestRequest.status || "").toLowerCase() !== "pending"
    ) {
      throw new Error("This request is no longer pending. Refresh and try again.");
    }

    // STEP 3: Do not overwrite another caregiver's active connection.
    if (
      currentConnection.status === "active" &&
      currentConnection.authorizedUid !== caregiverUid
    ) {
      throw new Error(
        "Another caregiver is already connected. Disconnect that caregiver first."
      );
    }

    const connectedAt = Date.now();

    // STEP 4: Prepare patient connection.
    const connectionData = {
      authorizedUid: caregiverUid,
      caregiverName: latestRequest.caregiverName || "Authorized Caregiver",
      caregiverEmail: latestRequest.caregiverEmail || "",
      status: "active",
      connectedAt
    };

    // STEP 5: Prepare caregiver's patient list entry.
    const patientData = {
      patientUid,
      patientName:
        patientProfile.firstName ||
        patientProfile.fullName ||
        state.user.displayName ||
        "Patient",
      status: "active",
      connectedAt
    };

    // STEP 6: Activate careConnection FIRST.
    // Firebase index rules require this record to exist and be active.
    await set(ref(db, patientConnectionPath), connectionData);

    console.log("STEP 6 SUCCESS: CARE CONNECTION ACTIVATED.");

    // STEP 7: Register the patient in the ESP32 index.
    // This must execute while the patient is authenticated.
    await set(ref(db, deviceIndexPath), {
      authorizedUid: caregiverUid,
      status: "active"
    });

    console.log("STEP 7 SUCCESS: DEVICE PATIENT INDEX CREATED.");

    // STEP 8: Add patient to caregiver's connected-patient list.
    await set(ref(db, caregiverPatientPath), patientData);

    console.log("STEP 8 SUCCESS: CAREGIVER PATIENT LIST UPDATED.");

    // STEP 9: Verify all three database records.
    const [
      patientCheck,
      indexCheck,
      caregiverCheck
    ] = await Promise.all([
      get(ref(db, patientConnectionPath)),
      get(ref(db, deviceIndexPath)),
      get(ref(db, caregiverPatientPath))
    ]);

    const patientConnection = patientCheck.val();
    const deviceIndex = indexCheck.val();
    const caregiverPatient = caregiverCheck.val();

    if (
      patientConnection?.status !== "active" ||
      patientConnection?.authorizedUid !== caregiverUid
    ) {
      throw new Error("Patient careConnection verification failed.");
    }

    if (
      deviceIndex?.status !== "active" ||
      deviceIndex?.authorizedUid !== caregiverUid
    ) {
      throw new Error("ESP32 device index verification failed.");
    }

    if (
      caregiverPatient?.status !== "active" ||
      caregiverPatient?.patientUid !== patientUid
    ) {
      throw new Error("Caregiver patient-list verification failed.");
    }

    console.log("====================================");
    console.log("ALL THREE CONNECTION RECORDS VERIFIED");
    console.log("Patient UID:", patientUid);
    console.log("Caregiver UID:", caregiverUid);
    console.log("ESP32 INDEX:", deviceIndexPath);
    console.log("====================================");

    // STEP 10: Remove pending request only after verification.
    await remove(ref(db, requestPath));

    delete state.connectionRequests[caregiverUid];

    // STEP 11: Update dashboard state.
    state.caregiverUid = caregiverUid;
    state.connectionInfo = connectionData;

    updateConnectionStatus(
      true,
      "Connected. Your caregiver's assigned medicines and reminders are syncing live."
    );

    renderActiveCaregiver();

    if (state.unsubscribers.length === 0) {
      listenToPatientData(patientUid);
    }

    renderAll();

    notice(
      "success",
      "Connection approved! Your caregiver is connected and your patient account is registered with the ESP32."
    );

  } catch (error) {
    console.error("====================================");
    console.error("CONNECTION APPROVAL ERROR:", error);
    console.error("Patient UID:", patientUid);
    console.error("Caregiver UID:", caregiverUid);
    console.error("Error code:", error.code);
    console.error("Error message:", error.message);
    console.error("====================================");

    notice(
      "error",
      error.message ||
      "Connection approval failed. Check Firebase Database Rules."
    );

  } finally {
    state.processingRequests.delete(caregiverUid);
    renderConnectionRequests();
  }
}



/* =====================================================
   REJECT CONNECTION
===================================================== */

async function rejectConnectionRequest(caregiverUid) {
  if (!state.user || !caregiverUid) return;
  if (state.processingRequests.has(caregiverUid)) return;

  if (!state.connectionRequests[caregiverUid]) {
    notice("info", "This connection request is no longer available.");
    return;
  }

  state.processingRequests.add(caregiverUid);
  renderConnectionRequests();

  try {
    await remove(
      ref(db, `users/${state.user.uid}/connectionRequests/${caregiverUid}`)
    );

    delete state.connectionRequests[caregiverUid];
    notice("success", "The caregiver connection request was rejected.");

  } catch (error) {
    console.error("Rejecting caregiver request failed:", error);
    notice(
      "error",
      "Unable to reject this request. Check your Firebase Database Rules."
    );

  } finally {
    state.processingRequests.delete(caregiverUid);
    renderConnectionRequests();
  }
}

/* =====================================================
   DISCONNECT CAREGIVER
===================================================== */


async function disconnectCaregiver() {
  if (!state.user || !state.caregiverUid) {
    notice("info", "There is no active caregiver connection.");
    return;
  }

  const patientUid = auth.currentUser?.uid;
  const caregiverUid = state.caregiverUid;

  if (!patientUid || patientUid !== state.user.uid) {
    notice("error", "Patient authentication has expired. Please sign in again.");
    return;
  }

  const caregiverName =
    state.connectionInfo?.caregiverName || "this caregiver";

  const confirmed = window.confirm(
    `Are you sure you want to disconnect ${caregiverName}?\n\n` +
    "Your caregiver will lose access to your connected medication records. " +
    "Your dose history will remain in your account."
  );

  if (!confirmed) return;

  const button = $("disconnectCaregiverButton");

  if (button) {
    button.disabled = true;
    button.textContent = "Disconnecting...";
  }

  try {
    console.log("DISCONNECTING CAREGIVER");
    console.log("Patient UID:", patientUid);
    console.log("Caregiver UID:", caregiverUid);

    // STEP 1: Remove the patient from caregiver's patient list.
    await remove(
      ref(db, `users/${caregiverUid}/connectedPatients/${patientUid}`)
    );

    // STEP 2: Remove the patient from ESP32 discovery.
    await remove(
      ref(db, `devicePatientIndex/${patientUid}`)
    );

    // STEP 3: Remove the patient's active caregiver connection.
    await remove(
      ref(db, `users/${patientUid}/careConnection`)
    );

    // STEP 4: Verify the records are gone.
    const [indexCheck, connectionCheck] = await Promise.all([
      get(ref(db, `devicePatientIndex/${patientUid}`)),
      get(ref(db, `users/${patientUid}/careConnection`))
    ]);

    if (indexCheck.exists() || connectionCheck.exists()) {
      throw new Error(
        "Disconnect verification failed. Some connection records still exist."
      );
    }

    // STEP 5: Clear dashboard state.
    state.caregiverUid = null;
    state.connectionInfo = {};
    state.medicines = {};
    state.reminders = {};

    stopDataListeners();

    renderActiveCaregiver();
    renderAll();

    updateConnectionStatus(
      false,
      "Your caregiver has been disconnected. You can approve another request."
    );

    notice(
      "success",
      "Caregiver disconnected. The patient was also removed from ESP32 discovery."
    );

    console.log("CAREGIVER DISCONNECTED SUCCESSFULLY.");

  } catch (error) {
    console.error("Disconnect caregiver failed:", error);

    notice(
      "error",
      error.message ||
      "Unable to disconnect. Check your Firebase Database Rules."
    );

    renderActiveCaregiver();

  } finally {
    if ($("disconnectCaregiverButton")) {
      $("disconnectCaregiverButton").disabled = false;
      $("disconnectCaregiverButton").textContent = "✕ Disconnect Caregiver";
    }
  }
}


/* =====================================================
   REMINDER SOUND AND MODAL
===================================================== */

let reminderAudioContext = null;
let reminderSoundInterval = null;
let reminderCheckInterval = null;
let reminderSnoozeTimeout = null;
let activeReminder = null;

const reminderQueue = [];
const triggeredReminders = new Set();

function playReminderSound() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;

    if (!reminderAudioContext) {
      reminderAudioContext = new AudioContext();
    }

    if (reminderAudioContext.state === "suspended") {
      reminderAudioContext.resume();
    }

    const oscillator = reminderAudioContext.createOscillator();
    const gain = reminderAudioContext.createGain();

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(
      880,
      reminderAudioContext.currentTime
    );

    gain.gain.setValueAtTime(0.001, reminderAudioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(
      0.15,
      reminderAudioContext.currentTime + 0.05
    );
    gain.gain.exponentialRampToValueAtTime(
      0.001,
      reminderAudioContext.currentTime + 0.6
    );

    oscillator.connect(gain);
    gain.connect(reminderAudioContext.destination);
    oscillator.start();
    oscillator.stop(reminderAudioContext.currentTime + 0.6);

  } catch (error) {
    console.error("Reminder sound error:", error);
  }
}

function unlockReminderAudio() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;

  try {
    if (!reminderAudioContext) {
      reminderAudioContext = new AudioContext();
    }

    if (reminderAudioContext.state === "suspended") {
      reminderAudioContext.resume();
    }
  } catch (error) {
    console.warn("Could not enable reminder audio:", error);
  }
}

document.addEventListener("pointerdown", unlockReminderAudio, {
  once: true
});

function startReminderSound() {
  stopReminderSound();
  playReminderSound();

  reminderSoundInterval = setInterval(() => {
    if (activeReminder) playReminderSound();
  }, 3000);
}

function stopReminderSound() {
  if (reminderSoundInterval) {
    clearInterval(reminderSoundInterval);
    reminderSoundInterval = null;
  }
}

function getReminderDetails(entry) {
  const medicine = findMedicine(entry.reminder);

  return {
    medicineName: medicine
      ? medicineName(medicine)
      : entry.reminder?.medicineName ||
        entry.reminder?.name ||
        "Scheduled medicine",

    dosage: medicine
      ? medicineDosage(medicine)
      : entry.reminder?.medicineDosage ||
        entry.reminder?.dose ||
        entry.reminder?.dosage ||
        "Dosage not specified"
  };
}

function enqueueMedicineReminder(entry) {
  const alreadyQueued = reminderQueue.some(item =>
    item.id === entry.id && item.date === entry.date
  );

  const alreadyActive =
    activeReminder?.id === entry.id &&
    activeReminder?.date === entry.date;

  if (alreadyQueued || alreadyActive) return;

  reminderQueue.push(entry);
  showNextMedicineReminder();
}

function showNextMedicineReminder() {
  if (activeReminder || !reminderQueue.length) return;

  const entry = reminderQueue.shift();
  if (!entry) return;

  if (isDoseCompleted(entry.id, entry.date)) {
    showNextMedicineReminder();
    return;
  }

  activeReminder = entry;

  const details = getReminderDetails(entry);
  const modal = $("medicineReminderModal");

  if (!modal) {
    console.error("Medicine reminder modal not found.");
    activeReminder = null;
    return;
  }

  if ($("modalMedicineName")) {
    $("modalMedicineName").textContent = details.medicineName;
  }

  if ($("modalMedicineDosage")) {
    $("modalMedicineDosage").textContent = details.dosage;
  }

  if ($("modalMedicineTime")) {
    $("modalMedicineTime").textContent =
      `Scheduled: ${formatTime(entry.time)}`;
  }

  modal.hidden = false;
  startReminderSound();
}

function closeMedicineReminder() {
  stopReminderSound();

  if ($("medicineReminderModal")) {
    $("medicineReminderModal").hidden = true;
  }

  activeReminder = null;
  showNextMedicineReminder();
}

function checkDueMedicineReminders() {
  if (!state.user || !state.caregiverUid) return;

  const now = new Date();
  const date = todayKey(now);

  const currentTime =
    `${String(now.getHours()).padStart(2, "0")}:` +
    `${String(now.getMinutes()).padStart(2, "0")}`;

  getReminderEntries(date).forEach(entry => {
    const scheduledTime = String(entry.time || "").slice(0, 5);
    if (scheduledTime !== currentTime) return;

    const key = `${entry.id}_${date}_${scheduledTime}`;
    if (triggeredReminders.has(key)) return;

    if (isDoseCompleted(entry.id, date)) {
      triggeredReminders.add(key);
      return;
    }

    triggeredReminders.add(key);
    enqueueMedicineReminder(entry);
  });
}

function startReminderChecker() {
  if (reminderCheckInterval) {
    clearInterval(reminderCheckInterval);
  }

  checkDueMedicineReminders();
  reminderCheckInterval = setInterval(checkDueMedicineReminders, 5000);
}

function stopReminderChecker() {
  if (reminderCheckInterval) {
    clearInterval(reminderCheckInterval);
    reminderCheckInterval = null;
  }

  if (reminderSnoozeTimeout) {
    clearTimeout(reminderSnoozeTimeout);
    reminderSnoozeTimeout = null;
  }

  stopReminderSound();
  reminderQueue.length = 0;
  activeReminder = null;

  if ($("medicineReminderModal")) {
    $("medicineReminderModal").hidden = true;
  }
}

$("stopReminderSound")?.addEventListener("click", stopReminderSound);

$("modalTakenButton")?.addEventListener("click", async () => {
  if (!activeReminder) return;

  const entry = activeReminder;
  const button = $("modalTakenButton");

  if (button) button.disabled = true;

  const saved = await recordDose(entry.id, entry.date, "taken", button);

  if (button) button.disabled = false;
  if (saved) closeMedicineReminder();
});

//*modal of snoozebutton

$("modalSnoozeButton")?.addEventListener("click", async () => {
  if (!activeReminder || !state.user || !state.caregiverUid) return;

  const snoozedEntry = activeReminder;
  const button = $("modalSnoozeButton");

  if (button) button.disabled = true;

  // Set snooze duration to 2 minutes.
  const snoozeUntil = Date.now() + (2 * 60 * 1000);

  // Generate the existing intake log key.
  const key = logKey(snoozedEntry.id, snoozedEntry.date);

  // Firebase path for this patient's snooze instruction.
  const snoozePath =
    `users/${state.user.uid}/intakeLogs/${key}/snoozeUntil`;

  try {
    // Send the snooze timestamp to Firebase.
    await set(ref(db, snoozePath), snoozeUntil);

    // Stop the website reminder sound.
    stopReminderSound();

    // Hide the reminder modal.
    if ($("medicineReminderModal")) {
      $("medicineReminderModal").hidden = true;
    }

    activeReminder = null;

    // Clear any previous snooze timer.
    if (reminderSnoozeTimeout) {
      clearTimeout(reminderSnoozeTimeout);
    }

    // Show the website reminder again after 2 minutes.
    reminderSnoozeTimeout = setTimeout(() => {
      reminderSnoozeTimeout = null;

      if (!state.user || !state.caregiverUid) return;

      if (isDoseCompleted(snoozedEntry.id, snoozedEntry.date)) {
        showNextMedicineReminder();
        return;
      }

      enqueueMedicineReminder(snoozedEntry);

    }, 2 * 60 * 1000);

    showNextMedicineReminder();

    notice(
      "success",
      "Reminder snoozed. The device buzzer will pause for 2 minutes."
    );

  } catch (error) {
    console.error("Saving snooze instruction failed:", error);

    notice(
      "error",
      "Unable to snooze. Please check your internet connection and try again."
    );

  } finally {
    if (button) button.disabled = false;
  }
});


/* =====================================================
   MEDICINE AND REMINDER DISPLAY
===================================================== */

function statusTag(status) {
  const value = String(status || "pending").toLowerCase();

  if (value === "taken") {
    return `
      <span class="dose-status dose-taken">
        <span class="status-icon">✓</span>
        Dose Taken
      </span>
    `;
  }

  if (value === "missed") {
    return `
      <span class="dose-status dose-missed">
        <span class="status-icon">!</span>
        Dose Missed
      </span>
    `;
  }

  return `
    <span class="dose-status dose-pending">
      <span class="status-icon">◷</span>
      Pending
    </span>
  `;
}

function renderReminderCard(entry) {
  const { id, reminder, date, time } = entry;
  const medicine = findMedicine(reminder);

  const name = medicine
    ? medicineName(medicine)
    : reminder?.medicineName || reminder?.name || "Scheduled medicine";

  const dosage = medicine
    ? medicineDosage(medicine)
    : reminder?.medicineDosage ||
      reminder?.dose ||
      reminder?.dosage ||
      "Dosage not specified";

  const instructions =
    medicine?.instructions ||
    medicine?.notes ||
    reminder?.medicineInstructions ||
    reminder?.notes ||
    reminder?.instructions ||
    "";

  const status = getStatus(id, date);
  const completed = ["taken", "missed"].includes(status);

  return `
    <article class="item reminder-item ${completed ? "dose-completed" : ""}">
      <div class="item-icon medicine-icon">💊</div>

      <div class="item-main">
        <div class="reminder-heading">
          <h3 class="item-title">${escapeHTML(name)}</h3>
          ${statusTag(status)}
        </div>

        <p class="item-description">${escapeHTML(dosage)}</p>

        ${instructions ? `
          <p class="reminder-instructions">
            ${escapeHTML(instructions)}
          </p>
        ` : ""}

        <div class="reminder-time">
          <span>◷</span>
          ${escapeHTML(formatTime(time))}
        </div>

        ${!completed ? `
          <div class="dose-actions">
            <button
              class="dose-action-button taken-button"
              type="button"
              data-dose-action="taken"
              data-reminder-id="${escapeHTML(id)}"
              data-dose-date="${escapeHTML(date)}">
              ✓ Mark as Taken
            </button>

            <button
              class="dose-action-button missed-button"
              type="button"
              data-dose-action="missed"
              data-reminder-id="${escapeHTML(id)}"
              data-dose-date="${escapeHTML(date)}">
              ! Mark as Missed
            </button>
          </div>
        ` : `
          <div class="dose-completion-message ${
            status === "taken" ? "completion-taken" : "completion-missed"
          }">
            ${
              status === "taken"
                ? "✓ This dose has been recorded as taken."
                : "! This dose has been recorded as missed."
            }
          </div>
        `}
      </div>
    </article>
  `;
}

function renderToday() {
  const date = todayKey();
  const entries = getReminderEntries(date);

  if ($("todayLabel")) {
    $("todayLabel").textContent = new Date().toLocaleDateString(
      undefined,
      {
        weekday: "long",
        month: "short",
        day: "numeric",
        year: "numeric"
      }
    );
  }

  if ($("todayCount")) $("todayCount").textContent = entries.length;

  if ($("takenCount")) {
    $("takenCount").textContent = entries.filter(
      entry => getStatus(entry.id, date) === "taken"
    ).length;
  }

  if (!entries.length) {
    empty(
      "todayList",
      "No reminders for today",
      state.caregiverUid
        ? "No doses are scheduled for today."
        : "Your caregiver's schedule will appear here after the accounts are connected."
    );
    return;
  }

  if ($("todayList")) {
    $("todayList").innerHTML = entries.map(renderReminderCard).join("");
  }
}

function renderMedicines() {
  const entries = getPatientMedicineEntries();

  if ($("medicineCount")) {
    $("medicineCount").textContent = entries.length;
  }

  if (!entries.length) {
    empty(
      "medicineList",
      "No medicines yet",
      state.caregiverUid
        ? "Medicines assigned to you by your caregiver will appear here after they create your reminders."
        : "Connect with your authorized caregiver to receive your medicine information."
    );
    return;
  }

  if (!$("medicineList")) return;

  $("medicineList").innerHTML = entries.map(entry => {
    const medicine = entry.medicine;

    const instructions =
      medicine.instructions ||
      medicine.notes ||
      medicine.usage ||
      "";

    const quantity =
      medicine.quantity ??
      medicine.stock ??
      medicine.currentQuantity;

    const frequency =
      medicine.frequency ||
      medicine.recurrence ||
      "";

    const schedules = (entry.reminders || [])
      .map(item => {
        const reminder = item.reminder;
        const time = reminderTime(reminder);
        const recurrence =
          reminder.recurrence ||
          reminder.frequency ||
          reminder.repeat ||
          "";

        return [
          time ? formatTime(time) : "",
          recurrence ? String(recurrence) : ""
        ].filter(Boolean).join(" · ");
      })
      .filter(Boolean);

    const uniqueSchedules = [...new Set(schedules)];

    return `
      <article class="record">
        <div class="medicine-icon">💊</div>

        <div class="record-main">
          <h3>${escapeHTML(medicineName(medicine))}</h3>

          <p><strong>Dosage:</strong> ${escapeHTML(medicineDosage(medicine))}</p>

          ${medicine.strength ? `
            <p><strong>Strength:</strong> ${escapeHTML(medicine.strength)}</p>
          ` : ""}

          ${medicine.form ? `
            <p><strong>Form:</strong> ${escapeHTML(medicine.form)}</p>
          ` : ""}

          ${quantity !== undefined && quantity !== null ? `
            <p><strong>Quantity:</strong> ${escapeHTML(quantity)}</p>
          ` : ""}

          ${medicine.refillAt || medicine.refillDate ? `
            <p>
              <strong>Refill date:</strong>
              ${escapeHTML(formatDate(medicine.refillAt || medicine.refillDate))}
            </p>
          ` : ""}

          ${frequency ? `
            <p><strong>Frequency:</strong> ${escapeHTML(frequency)}</p>
          ` : ""}

          ${uniqueSchedules.length ? `
            <p>
              <strong>Reminder schedule:</strong>
              ${escapeHTML(uniqueSchedules.join(", "))}
            </p>
          ` : ""}

          ${instructions ? `
            <p><strong>Instructions:</strong> ${escapeHTML(instructions)}</p>
          ` : ""}

          <span class="tag green">Shared by caregiver</span>
        </div>
      </article>
    `;
  }).join("");
}

function renderReminders() {
  const dates = [];

  for (let offset = 0; offset < 7; offset++) {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    dates.push(todayKey(date));
  }

  const today = todayKey();
  const entries = dates.flatMap(getReminderEntries);

  if (!entries.length) {
    empty(
      "reminderList",
      "No upcoming reminders",
      "Upcoming scheduled doses will appear here."
    );
    return;
  }

  if ($("reminderList")) {
    $("reminderList").innerHTML = entries.map(entry => `
      <div>
        <p class="panel-subtitle" style="margin:4px 0 8px;">
          ${escapeHTML(entry.date === today ? "Today" : formatDate(entry.date))}
        </p>
        ${renderReminderCard(entry)}
      </div>
    `).join("");
  }
}

function renderHistory() {
  const entries = Object.entries(state.logs)
    .filter(([, log]) => log && typeof log === "object")
    .map(([id, log]) => ({ id, ...log }))
    .filter(log =>
      ["taken", "missed"].includes(String(log.status || "").toLowerCase())
    )
    .sort((a, b) =>
      String(b.recordedAt || "").localeCompare(String(a.recordedAt || ""))
    );

  if (!entries.length) {
    empty("historyList", "No history yet", "Doses you record will appear here.");
    return;
  }

  if ($("historyList")) {
    $("historyList").innerHTML = entries.map(log => `
      <article class="record">
        <div class="medicine-icon">
          ${String(log.status).toLowerCase() === "taken" ? "✓" : "◷"}
        </div>

        <div class="record-main">
          <h3>${escapeHTML(log.medicineName || log.name || "Medicine dose")}</h3>
          <p>Date: ${escapeHTML(formatDate(log.date))}</p>
          <p>Dosage: ${escapeHTML(log.dosage || "Not specified")}</p>

          ${log.recordedAt ? `
            <p>Recorded: ${escapeHTML(new Date(log.recordedAt).toLocaleString())}</p>
          ` : ""}

          ${statusTag(log.status)}
        </div>
      </article>
    `).join("");
  }
}

function renderAll() {
  renderToday();
  renderMedicines();
  renderReminders();
  renderHistory();
}

/* =====================================================
   FIREBASE LISTENER CLEANUP
===================================================== */

function stopDataListeners() {
  state.unsubscribers.forEach(unsubscribe => {
    try {
      unsubscribe();
    } catch (error) {
      console.warn("Listener cleanup error:", error);
    }
  });

  state.unsubscribers = [];
}

function stopPatientLogListener() {
  if (state.logUnsubscribe) {
    state.logUnsubscribe();
    state.logUnsubscribe = null;
  }
}

function stopRequestListener() {
  if (state.requestUnsubscribe) {
    state.requestUnsubscribe();
    state.requestUnsubscribe = null;
  }
}

function stopAllListeners() {
  stopPatientLogListener();
  stopDataListeners();
  stopRequestListener();

  if (state.connectionUnsubscribe) {
    state.connectionUnsubscribe();
    state.connectionUnsubscribe = null;
  }

  stopReminderChecker();
}

/* =====================================================
   PATIENT HISTORY LISTENER
===================================================== */

function listenToPatientLogs(uid) {
  stopPatientLogListener();

  state.logUnsubscribe = onValue(
    ref(db, `users/${uid}/intakeLogs`),
    snapshot => {
      state.logs = normalizeCollection(snapshot.val());
      console.log("PATIENT INTAKE LOGS UPDATED:", state.logs);
      renderAll();
    },
    error => {
      console.error("Patient history read failed:", error);
      notice(
        "error",
        "Unable to load intake history. Check your Firebase Database Rules."
      );
    }
  );
}

/* =====================================================
   CONNECTION REQUEST LISTENER
===================================================== */

function listenToConnectionRequests(uid) {
  stopRequestListener();

  state.requestUnsubscribe = onValue(
    ref(db, `users/${uid}/connectionRequests`),
    snapshot => {
      state.connectionRequests = normalizeCollection(snapshot.val());
      renderConnectionRequests();
    },
    error => {
      console.error("Connection requests listener failed:", error);
      notice(
        "error",
        "Unable to load caregiver requests. Check your Firebase Database Rules."
      );
    }
  );
}

/* =====================================================
   ACTIVE CONNECTION LISTENER
===================================================== */

function listenToConnection(uid) {
  if (state.connectionUnsubscribe) {
    state.connectionUnsubscribe();
    state.connectionUnsubscribe = null;
  }

  state.connectionUnsubscribe = onValue(
    ref(db, `users/${uid}/careConnection`),
    snapshot => {
      const connection = snapshot.val() || {};

      const caregiverUid =
        connection.status === "active"
          ? connection.authorizedUid
          : null;

      if (caregiverUid && caregiverUid !== uid) {
        const connectionChanged = state.caregiverUid !== caregiverUid;

        state.caregiverUid = caregiverUid;
        state.connectionInfo = connection;

        updateConnectionStatus(
          true,
          "Connected. Your caregiver's assigned medicines and reminders are syncing live."
        );

        renderActiveCaregiver();

        if (connectionChanged || state.unsubscribers.length === 0) {
          listenToPatientData(uid);
        }

      } else {
        state.caregiverUid = null;
        state.connectionInfo = {};

        stopDataListeners();

        state.medicines = {};
        state.reminders = {};

        updateConnectionStatus(
          false,
          "Share your QR code or patient ID with your authorized caregiver. Approve their request below to connect."
        );

        renderActiveCaregiver();
        renderAll();
      }
    },
    error => {
      console.error("Patient connection listener failed:", error);
      notice(
        "error",
        "Unable to check your caregiver connection. Check your Firebase Database Rules."
      );
    }
  );
}

/* =====================================================
   PATIENT MEDICINES AND REMINDERS
===================================================== */

function listenToPatientData(patientUid) {
  stopDataListeners();

  const medicinesUnsubscribe = onValue(
    ref(db, `users/${patientUid}/medicines`),
    snapshot => {
      state.medicines = normalizeCollection(snapshot.val());
      renderAll();
    },
    error => {
      console.error("Patient medicines read failed:", error);
      notice(
        "error",
        "Existing patient medicines could not be loaded. Check your Firebase Database Rules."
      );
    }
  );

  const remindersUnsubscribe = onValue(
    ref(db, `users/${patientUid}/reminders`),
    snapshot => {
      state.reminders = normalizeCollection(snapshot.val());
      renderAll();
    },
    error => {
      console.error("Patient reminders read failed:", error);
      notice(
        "error",
        "Reminders could not be loaded. Check your Firebase Database Rules."
      );
    }
  );

  state.unsubscribers.push(
    medicinesUnsubscribe,
    remindersUnsubscribe
  );
}

/* =====================================================
   COPY PATIENT UID
===================================================== */

async function copyPatientUid() {
  if (!state.user) return;

  try {
    await navigator.clipboard.writeText(state.user.uid);
    notice(
      "success",
      "Patient ID copied. Share it only with your verified authorized caregiver."
    );
  } catch (error) {
    notice(
      "info",
      `Your patient ID is ${state.user.uid}. Select and copy it from the panel.`
    );
  }
}

/* =====================================================
   RECORD MEDICINE DOSE
===================================================== */

async function recordDose(reminderId, date, status, button) {
  if (!state.user || !state.caregiverUid) {
    notice(
      "error",
      "Your authorized caregiver has not connected your account yet."
    );
    return false;
  }

  if (!["taken", "missed"].includes(status)) return false;

  const reminder = state.reminders[reminderId];

  if (!reminder) {
    notice("error", "This reminder is no longer available.");
    return false;
  }

  const key = logKey(reminderId, date);

  if (isDoseCompleted(reminderId, date)) {
    notice("info", "This dose has already been recorded.");
    return false;
  }

  if (state.recording.has(key)) return false;

  state.recording.add(key);
  if (button) button.disabled = true;

  const medicine = findMedicine(reminder);

  const log = {
    reminderId,
    medicineId: reminderMedicineId(reminder),
    medicineName: medicine
      ? medicineName(medicine)
      : reminder.medicineName || reminder.name || "Scheduled medicine",
    dosage: medicine
      ? medicineDosage(medicine)
      : reminder.medicineDosage ||
        reminder.dose ||
        reminder.dosage ||
        "Not specified",
    date,
    time: reminderTime(reminder),
    status: status.toLowerCase(),
    recordedAt: new Date().toISOString()
  };

  try {
    const logPath = `users/${state.user.uid}/intakeLogs/${key}`;

    console.log("====================================");
    console.log("SAVING PATIENT INTAKE LOG");
    console.log("Firebase path:", logPath);
    console.log("Log data:", log);
    console.log("====================================");

    await set(ref(db, logPath), log);

    state.logs[key] = log;

    triggeredReminders.add(
      `${reminderId}_${date}_${String(reminderTime(reminder)).slice(0, 5)}`
    );

    renderAll();

    console.log("DOSE SUCCESSFULLY SAVED TO FIREBASE");
    console.log("Saved status:", log.status);
    console.log("Saved reminder ID:", reminderId);
    console.log("Saved date:", date);

    notice(
      "success",
      status === "taken"
        ? "Dose recorded as taken."
        : "Dose recorded as missed."
    );

    return true;

  } catch (error) {
    console.error("Saving dose record failed:", error);
    notice(
      "error",
      "Unable to save this dose. Check your Firebase Database Rules."
    );

    if (button) button.disabled = false;
    return false;

  } finally {
    state.recording.delete(key);
  }
}

/* =====================================================
   NAVIGATION
===================================================== */

function setupNavigation() {
  const buttons = document.querySelectorAll(".nav-btn[data-page]");

  buttons.forEach(button => {
    button.addEventListener("click", () => {
      const pageId = button.dataset.page;

      if (!$(pageId)) return;

      document.querySelectorAll(".page").forEach(page => {
        page.classList.toggle("active", page.id === pageId);
      });

      buttons.forEach(navButton => {
        navButton.classList.toggle(
          "active",
          navButton.dataset.page === pageId
        );
      });

      $("mainContent")?.scrollTo({
        top: 0,
        behavior: "smooth"
      });
    });
  });
}

/* =====================================================
   DASHBOARD EVENTS
===================================================== */

function setupEvents() {
  $("copyPatientUidButton")?.addEventListener("click", copyPatientUid);

  $("allowCaregiverConnections")?.addEventListener(
    "change",
    async event => {
      if (!state.user) return;

      const checkbox = event.currentTarget;
      const enabled = checkbox.checked;
      checkbox.disabled = true;

      try {
        await set(
          ref(
            db,
            `users/${state.user.uid}/profile/allowCaregiverConnections`
          ),
          enabled
        );

        state.profile.allowCaregiverConnections = enabled;

        notice(
          "success",
          enabled
            ? "Caregiver connection requests are enabled. You still need to approve each request."
            : "Caregiver connection requests are disabled."
        );

      } catch (error) {
        console.error("Updating connection permission failed:", error);
        checkbox.checked = !enabled;

        notice(
          "error",
          "Unable to update connection permission. Check your Firebase Database Rules."
        );

      } finally {
        checkbox.disabled = false;
      }
    }
  );

  document.addEventListener("click", event => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const connectionButton = target.closest("[data-connection-action]");

    if (connectionButton) {
      const caregiverUid = connectionButton.dataset.caregiverUid;
      const action = connectionButton.dataset.connectionAction;

      if (action === "approve") approveConnectionRequest(caregiverUid);
      if (action === "reject") rejectConnectionRequest(caregiverUid);
      return;
    }

    const doseButton = target.closest("[data-dose-action]");

    if (doseButton) {
      recordDose(
        doseButton.dataset.reminderId,
        doseButton.dataset.doseDate,
        doseButton.dataset.doseAction,
        doseButton
      );
    }
  });

  async function handleLogout() {
    try {
      stopAllListeners();
      await signOut(auth);
      window.location.href = "login.html";
    } catch (error) {
      console.error("Sign out failed:", error);
      notice("error", "Unable to sign out. Please try again.");
    }
  }

  $("sidebarLogout")?.addEventListener("click", handleLogout);
  $("mobileLogoutButton")?.addEventListener("click", handleLogout);

  window.addEventListener("beforeunload", stopAllListeners);
}

/* =====================================================
   PATIENT VISUAL TUTORIAL
===================================================== */

let patientVisualTour = null;
let patientTourInitialized = false;

const patientVisualSteps = [
  {
    title: "Welcome to Medminder!",
    description:
      "Welcome to your medicine dashboard! Here you can view your assigned medicines, follow reminders, and record your daily intake.",
    page: "homeSection",
    target: "#welcomeTitle",
    icon: "👋"
  },
  {
    title: "Your Patient ID and QR Code",
    description:
      "This is your unique Patient ID and QR code. Share your ID with your authorized caregiver so they can send you medicine schedules.",
    page: "homeSection",
    target: "#patientQrCode",
    icon: "🔳"
  },
  {
    title: "Caregiver Connections",
    description:
      "Caregiver connection requests appear here. Review the caregiver's information and approve or reject each request.",
    page: "homeSection",
    target: "#connectionRequestsPanel",
    icon: "🔗"
  },
  {
    title: "Your Assigned Medicines",
    description:
      "View the medicines shared by your caregiver. You can check the medicine name, dosage, instructions, and available schedule information.",
    page: "medicinesSection",
    target: "#medicineList",
    icon: "💊"
  },
  {
    title: "Your Medicine Reminders",
    description:
      "Your upcoming medicine schedules appear here. Check the time and follow your caregiver's instructions.",
    page: "remindersSection",
    target: "#reminderList",
    icon: "⏰"
  },
  {
    title: "Record Your Medicine Intake",
    description:
      "After taking a scheduled dose, select Mark as Taken. If you did not take the dose, you can record it as missed.",
    page: "homeSection",
    target: "#todayList",
    icon: "✓"
  },
  {
    title: "Review Your Intake History",
    description:
      "Your recorded doses appear here. Use this section to review your previous intake records.",
    page: "historySection",
    target: "#historyList",
    icon: "📋"
  }
];

/* =====================================================
   SPOTLIGHT TUTORIAL CREATOR
===================================================== */

//*for tutorial images to

function createMedminderSpotlight(steps, onComplete) {
  let currentStep = 0;
  let isOpen = false;
  let closing = false;
  let repositionFrame = null;

  document.getElementById("patientSpotlightOverlay")?.remove();
  document.getElementById("patientSpotlightStyles")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "patientSpotlightOverlay";

  overlay.innerHTML = `
    <div id="patientSpotlightHighlight"></div>

    <div id="patientSpotlightCard">
      <button type="button" id="patientSpotlightClose"
        aria-label="Close tutorial">×</button>

      <div class="patient-tour-top">
        <span id="patientTourStepLabel"></span>
        <span id="patientTourStepIcon">👋</span>
      </div>

      <div class="patient-tour-progress">
        <div id="patientTourProgressBar"></div>
      </div>

      <h3 id="patientTourTitle"></h3>
      <p id="patientTourDescription"></p>

      <div class="patient-tour-footer">
        <button type="button" id="patientTourSkip"
          class="patient-tour-skip">Skip tutorial</button>

        <div class="patient-tour-navigation">
          <button type="button" id="patientTourBack"
            class="patient-tour-back">Back</button>
          <button type="button" id="patientTourNext"
            class="patient-tour-next">Next →</button>
        </div>
      </div>
    </div>
  `;

  const style = document.createElement("style");
  style.id = "patientSpotlightStyles";

  style.textContent = `
    #patientSpotlightOverlay {
      position:fixed;
      inset:0;
      z-index:100000;
      display:none;
      pointer-events:none;
    }

    #patientSpotlightOverlay.active {
      display:block;
    }

    #patientSpotlightHighlight {
      position:fixed;
      display:none;
      z-index:100001;
      border:3px solid #42b875;
      border-radius:12px;
      box-shadow:
        0 0 0 9999px rgba(7,22,13,.72),
        0 0 20px rgba(66,184,117,.45);
      pointer-events:none;
      box-sizing:border-box;
      transition:
        top .2s ease,
        left .2s ease,
        width .2s ease,
        height .2s ease;
    }

    #patientSpotlightCard {
      position:fixed;
      z-index:100002;
      width:min(370px, calc(100vw - 32px));
      max-height:calc(100vh - 24px);
      overflow-y:auto;
      overscroll-behavior:contain;
      box-sizing:border-box;
      padding:22px;
      border-radius:17px;
      background:#ffffff;
      color:#263a2d;
      box-shadow:0 12px 35px rgba(0,0,0,.25);
      pointer-events:auto;
      font-family:Inter,Arial,sans-serif;
      scrollbar-width:thin;
    }

    .patient-tour-top {
      display:flex;
      align-items:center;
      justify-content:space-between;
      margin-bottom:12px;
      padding-right:27px;
    }

    #patientTourStepLabel {
      color:#175638;
      font-size:11px;
      font-weight:800;
      letter-spacing:.7px;
    }

    #patientTourStepIcon {
      font-size:21px;
    }

    #patientSpotlightClose {
      position:absolute;
      top:10px;
      right:11px;
      width:30px;
      height:30px;
      border:0;
      border-radius:50%;
      background:#f0f5f1;
      color:#526259;
      font-size:21px;
      cursor:pointer;
    }

    .patient-tour-progress {
      width:100%;
      height:5px;
      margin-bottom:16px;
      overflow:hidden;
      border-radius:20px;
      background:#e6eee8;
    }

    #patientTourProgressBar {
      width:0;
      height:100%;
      border-radius:20px;
      background:#24945a;
      transition:width .25s ease;
    }

    #patientTourTitle {
      margin:0 0 8px;
      color:#175638;
      font-size:18px;
      font-weight:800;
      line-height:1.4;
    }

    #patientTourDescription {
      margin:0;
      color:#64736a;
      font-size:13px;
      line-height:1.65;
      overflow-wrap:anywhere;
    }

    .patient-tour-footer {
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:8px;
      margin-top:20px;
    }

    .patient-tour-navigation {
      display:flex;
      gap:8px;
    }

    #patientSpotlightCard button {
      min-height:38px;
      padding:9px 13px;
      border-radius:9px;
      font-size:12px;
      font-weight:800;
      cursor:pointer;
    }

    .patient-tour-skip {
      padding-left:0!important;
      border:0;
      background:transparent;
      color:#7a8980;
    }

    .patient-tour-back {
      border:1px solid #dce8df;
      background:#f4f8f5;
      color:#175638;
    }

    .patient-tour-next {
      border:0;
      background:#175638;
      color:white;
    }

    .patient-tour-next:hover {
      background:#10442b;
    }

    @media(max-width:768px) {
      #patientSpotlightCard {
        width:calc(100vw - 24px);
        max-width:420px;
        max-height:42vh;
        padding:14px 16px;
        border-radius:14px;
      }

      #patientTourStepLabel {
        font-size:10px;
      }

      #patientTourStepIcon {
        font-size:18px;
      }

      #patientSpotlightClose {
        width:27px;
        height:27px;
        top:8px;
        right:9px;
      }

      .patient-tour-top {
        margin-bottom:9px;
      }

      .patient-tour-progress {
        margin-bottom:11px;
        height:4px;
      }

      #patientTourTitle {
        font-size:16px;
        margin-bottom:6px;
      }

      #patientTourDescription {
        font-size:12px;
        line-height:1.5;
      }

      .patient-tour-footer {
        margin-top:13px;
      }

      #patientSpotlightCard button {
        min-height:34px;
        padding:8px 10px;
        font-size:11px;
      }

      .patient-tour-navigation {
        gap:6px;
      }
    }

    @media(max-width:380px) {
      #patientSpotlightCard {
        width:calc(100vw - 20px);
        padding:12px 13px;
      }

      #patientTourTitle {
        font-size:15px;
      }

      #patientTourDescription {
        font-size:11px;
      }

      .patient-tour-footer {
        margin-top:10px;
      }

      #patientSpotlightCard button {
        padding:7px 9px;
        font-size:10px;
      }
    }
  `;

  document.head.appendChild(style);
  document.body.appendChild(overlay);

  const highlight = overlay.querySelector("#patientSpotlightHighlight");
  const card = overlay.querySelector("#patientSpotlightCard");

  function isMobile() {
    return window.matchMedia("(max-width: 768px)").matches;
  }

  function getBottomNavigationHeight() {
    const nav = document.querySelector(
      "#bottomNav, #bottomNavigation, .bottom-nav, " +
      ".bottom-navigation, .mobile-bottom-nav, " +
      ".bottom-navbar, .navbar-bottom"
    );

    if (!nav) return 0;

    const rect = nav.getBoundingClientRect();

    if (rect.top >= window.innerHeight) return 0;

    return Math.max(0, window.innerHeight - rect.top);
  }

  function getTarget(step) {
    if (!step) return null;

    let target = typeof step.target === "function"
      ? step.target()
      : document.querySelector(step.target);

    if (!target) return null;

    // Avoid highlighting an entire long list or page.
    // Highlight its first visible child instead.
    const rect = target.getBoundingClientRect();

    if (rect.height > window.innerHeight * 0.45) {
      const children = Array.from(target.children);

      const firstVisibleChild = children.find(child => {
        const childRect = child.getBoundingClientRect();

        return (
          childRect.width > 0 &&
          childRect.height > 0 &&
          childRect.height <= window.innerHeight * 0.45
        );
      });

      if (firstVisibleChild) {
        target = firstVisibleChild;
      }
    }

    return target;
  }

  function navigateToStep(step) {
    if (!step.page) return;

    const pageButton = document.querySelector(
      `.nav-btn[data-page="${step.page}"]`
    );

    if (pageButton) {
      pageButton.click();
      return;
    }

    const fallbackButton = document.querySelector(
      `[data-page="${step.page}"]`
    );

    fallbackButton?.click();

    const page = document.getElementById(step.page);

    if (page && !page.classList.contains("active")) {
      document.querySelectorAll(".page").forEach(item => {
        item.classList.toggle("active", item === page);
      });
    }
  }

  function rectanglesOverlap(a, b, gap = 8) {
    return !(
      a.right + gap <= b.left ||
      a.left >= b.right + gap ||
      a.bottom + gap <= b.top ||
      a.top >= b.bottom + gap
    );
  }

  function positionCard(target) {
    card.style.left = "12px";
    card.style.right = "auto";
    card.style.top = "12px";
    card.style.bottom = "auto";
    card.style.transform = "none";

    const mobile = isMobile();
    const margin = mobile ? 10 : 12;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const navHeight = mobile ? getBottomNavigationHeight() : 0;

    const availableBottom = viewportHeight - navHeight - margin;

    // Measure the actual card after its text has been rendered.
    const cardRect = card.getBoundingClientRect();

    const cardWidth = cardRect.width;
    const cardHeight = cardRect.height;

    if (!target) {
      card.style.left = `${Math.max(
        margin,
        (viewportWidth - cardWidth) / 2
      )}px`;

      card.style.top = `${Math.max(
        margin,
        (viewportHeight - cardHeight) / 2
      )}px`;

      return;
    }

    const rect = target.getBoundingClientRect();

    const targetRect = {
      left: rect.left - 5,
      right: rect.right + 5,
      top: rect.top - 5,
      bottom: rect.bottom + 5
    };

    const gap = 12;

    const candidates = [
      {
        name: "bottom",
        left: Math.max(
          margin,
          Math.min(
            rect.left,
            viewportWidth - cardWidth - margin
          )
        ),
        top: targetRect.bottom + gap
      },
      {
        name: "top",
        left: Math.max(
          margin,
          Math.min(
            rect.left,
            viewportWidth - cardWidth - margin
          )
        ),
        top: targetRect.top - cardHeight - gap
      },
      {
        name: "right",
        left: targetRect.right + gap,
        top: Math.max(
          margin,
          Math.min(
            rect.top,
            availableBottom - cardHeight
          )
        )
      },
      {
        name: "left",
        left: targetRect.left - cardWidth - gap,
        top: Math.max(
          margin,
          Math.min(
            rect.top,
            availableBottom - cardHeight
          )
        )
      }
    ];

    // On mobile, use above/below first to preserve the screen width.
    const orderedCandidates = mobile
      ? [candidates[0], candidates[1], candidates[2], candidates[3]]
      : candidates;

    let selected = null;

    for (const candidate of orderedCandidates) {
      const candidateRect = {
        left: candidate.left,
        right: candidate.left + cardWidth,
        top: candidate.top,
        bottom: candidate.top + cardHeight
      };

      const insideViewport =
        candidateRect.left >= margin &&
        candidateRect.right <= viewportWidth - margin &&
        candidateRect.top >= margin &&
        candidateRect.bottom <= availableBottom;

      if (
        insideViewport &&
        !rectanglesOverlap(candidateRect, targetRect, 5)
      ) {
        selected = candidate;
        break;
      }
    }

    // If no position is available, move the target toward the top
    // of the screen and place the tutorial beneath it.
    if (!selected) {
      const maximumTargetHeight = Math.max(
        55,
        availableBottom - cardHeight - gap - margin * 2
      );

      if (rect.height > maximumTargetHeight) {
        const firstChild = target.querySelector(":scope > *");

        if (firstChild) {
          const childRect = firstChild.getBoundingClientRect();

          if (
            childRect.height > 0 &&
            childRect.height <= maximumTargetHeight
          ) {
            target = firstChild;
            updateHighlight(target);
            return;
          }
        }
      }

      selected = {
        left: Math.max(
          margin,
          Math.min(
            rect.left,
            viewportWidth - cardWidth - margin
          )
        ),
        top: Math.max(
          margin,
          Math.min(
            targetRect.bottom + gap,
            availableBottom - cardHeight
          )
        )
      };
    }

    const finalLeft = Math.max(
      margin,
      Math.min(
        selected.left,
        viewportWidth - cardWidth - margin
      )
    );

    const finalTop = Math.max(
      margin,
      Math.min(
        selected.top,
        availableBottom - cardHeight
      )
    );

    card.style.left = `${finalLeft}px`;
    card.style.top = `${finalTop}px`;
  }

  function updateHighlight(target) {
    if (!target || !target.isConnected) {
      highlight.style.display = "none";
      positionCard(null);
      return;
    }

    const rect = target.getBoundingClientRect();
    const padding = 5;

    highlight.style.display = "block";
    highlight.style.top = `${rect.top - padding}px`;
    highlight.style.left = `${rect.left - padding}px`;
    highlight.style.width = `${rect.width + padding * 2}px`;
    highlight.style.height = `${rect.height + padding * 2}px`;

    positionCard(target);
  }

  function renderStep() {
    const step = steps[currentStep];
    if (!step) return;

    navigateToStep(step);

    overlay.querySelector("#patientTourStepLabel").textContent =
      `STEP ${currentStep + 1} OF ${steps.length}`;

    overlay.querySelector("#patientTourStepIcon").textContent =
      step.icon || "🌿";

    overlay.querySelector("#patientTourTitle").textContent =
      step.title;

    overlay.querySelector("#patientTourDescription").textContent =
      step.description;

    overlay.querySelector("#patientTourProgressBar").style.width =
      `${((currentStep + 1) / steps.length) * 100}%`;

    overlay.querySelector("#patientTourBack").style.visibility =
      currentStep === 0 ? "hidden" : "visible";

    overlay.querySelector("#patientTourNext").textContent =
      currentStep === steps.length - 1 ? "Finish ✓" : "Next →";

    const target = getTarget(step);

    if (target) {
      target.scrollIntoView({
        behavior: "smooth",
        block: "center",
        inline: "nearest"
      });
    }

    // Wait for scrolling and layout to settle before positioning.
    setTimeout(() => {
      if (!isOpen) return;

      const updatedTarget = getTarget(step);
      updateHighlight(updatedTarget);
    }, 450);
  }

  function reposition() {
    if (!isOpen) return;

    if (repositionFrame) {
      cancelAnimationFrame(repositionFrame);
    }

    repositionFrame = requestAnimationFrame(() => {
      repositionFrame = null;

      updateHighlight(getTarget(steps[currentStep]));
    });
  }

  async function closeTour() {
    if (!isOpen || closing) return;

    closing = true;
    isOpen = false;

    overlay.classList.remove("active");

    document.body.style.overflow = "";

    window.removeEventListener("resize", reposition);
    window.removeEventListener("orientationchange", reposition);
    window.removeEventListener("scroll", reposition, true);
    document.removeEventListener("keydown", handleEscape);

    if (repositionFrame) {
      cancelAnimationFrame(repositionFrame);
      repositionFrame = null;
    }

    try {
      if (typeof onComplete === "function") {
        await onComplete();
      }
    } finally {
      closing = false;
    }
  }

  function openTour() {
    if (isOpen) return;

    currentStep = 0;
    isOpen = true;

    overlay.classList.add("active");

    document.body.style.overflow = "hidden";

    window.addEventListener("resize", reposition);
    window.addEventListener("orientationchange", reposition);
    window.addEventListener("scroll", reposition, true);

    renderStep();
  }

  overlay.querySelector("#patientTourNext").addEventListener(
    "click",
    async () => {
      if (currentStep < steps.length - 1) {
        currentStep++;
        renderStep();
      } else {
        await closeTour();
      }
    }
  );

  overlay.querySelector("#patientTourBack").addEventListener(
    "click",
    () => {
      if (currentStep > 0) {
        currentStep--;
        renderStep();
      }
    }
  );

  overlay.querySelector("#patientTourSkip").addEventListener(
    "click",
    closeTour
  );

  overlay.querySelector("#patientSpotlightClose").addEventListener(
    "click",
    closeTour
  );

  function handleEscape(event) {
    if (isOpen && event.key === "Escape") {
      closeTour();
    }
  }

  document.addEventListener("keydown", handleEscape);

  return {
    open: openTour,
    close: closeTour
  };
}


/* =====================================================
   ONBOARDING COMPLETION
===================================================== */

async function completeOnboarding() {
  if (!state.user?.uid) return;

  if (state.profile?.onboardingCompleted === true) {
    return;
  }

  try {
    const profilePath = `users/${state.user.uid}/profile`;

    await Promise.all([
      set(ref(db, `${profilePath}/onboardingCompleted`), true),
      set(ref(db, `${profilePath}/onboardingCompletedAt`), Date.now())
    ]);

    state.profile = {
      ...state.profile,
      onboardingCompleted: true
    };

    console.log("Patient onboarding completed.");

  } catch (error) {
    console.error("Unable to save patient onboarding completion:", error);

    notice(
      "error",
      "Tutorial completion could not be saved. Please check your internet connection and Firebase Database Rules."
    );
  }
}

/* =====================================================
   HOW TO USE BUTTON
===================================================== */

function removeHeaderHowToUseButton() {
  document.querySelectorAll("button, a").forEach(element => {
    if (element.id === "medminderHelpButton") return;

    const label = String(element.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

    if (
      label === "how to use" ||
      label === "❔ how to use" ||
      label === "how to use medminder" ||
      label === "❔ how to use medminder"
    ) {
      element.remove();
    }
  });
}

function showOnboardingGuide() {
  if (!patientVisualTour) {
    initializePatientVisualTour();
  }

  patientVisualTour?.open();
}

//*changes to the how to use 

function ensureOnboardingUI() {
  // Remove duplicate How to Use buttons from the header.
  removeHeaderHowToUseButton();

  // Find the existing button or create a new one.
  let button = $("medminderHelpButton");

  if (!button) {
    button = document.createElement("button");
    button.id = "medminderHelpButton";
    button.type = "button";
    button.textContent = "❔ How to Use";
    document.body.appendChild(button);
  }

  // Find the bottom navigation.
  // These selectors cover common bottom navigation names.
  function getBottomNavigation() {
    return document.querySelector(
      "#bottomNav, " +
      "#bottomNavigation, " +
      ".bottom-nav, " +
      ".bottom-navigation, " +
      ".mobile-bottom-nav, " +
      ".bottom-navbar, " +
      ".navbar-bottom"
    );
  }

  // Button appearance and positioning.
  button.style.cssText = `
    position: fixed;
    right: 20px;
    bottom: 22px;
    z-index: 9998;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 13px 19px;
    border: none;
    border-radius: 30px;
    background: #175638;
    color: #ffffff;
    font-size: 14px;
    font-weight: 800;
    cursor: pointer;
    white-space: nowrap;
    box-shadow: 0 5px 20px rgba(0,0,0,.18);
    transition: bottom .2s ease, transform .2s ease;
  `;

  // Position the button above the bottom navigation on mobile.
  function positionHelpButton() {
    const isMobile = window.matchMedia("(max-width: 768px)").matches;
    const bottomNav = getBottomNavigation();

    if (isMobile && bottomNav) {
      const navHeight = bottomNav.getBoundingClientRect().height;

      // Leave enough space above the bottom navigation.
      button.style.bottom = `calc(${navHeight}px + 18px + env(safe-area-inset-bottom, 0px))`;
    } else {
      // Desktop position.
      button.style.bottom = "22px";
    }
  }

  // Add responsive button styles.
  if (!$("medminderHelpResponsiveStyle")) {
    const style = document.createElement("style");
    style.id = "medminderHelpResponsiveStyle";

    style.textContent = `
      #medminderHelpButton:hover {
        transform: translateY(-2px);
      }

      @media (max-width: 768px) {
        #medminderHelpButton {
          right: 14px !important;
          padding: 11px 15px !important;
          font-size: 12px !important;
        }
      }

      @media (max-width: 380px) {
        #medminderHelpButton {
          right: 10px !important;
          padding: 9px 12px !important;
          font-size: 11px !important;
        }
      }
    `;

    document.head.appendChild(style);
  }

  // Calculate the position immediately.
  positionHelpButton();

  // Recalculate when the screen changes.
  window.addEventListener("resize", positionHelpButton);
  window.addEventListener("orientationchange", positionHelpButton);

  // Recalculate if the bottom navigation changes size.
  if (window.ResizeObserver && !button._navResizeObserver) {
    const bottomNav = getBottomNavigation();

    if (bottomNav) {
      button._navResizeObserver = new ResizeObserver(
        positionHelpButton
      );

      button._navResizeObserver.observe(bottomNav);
    }
  }

  // Attach the tutorial click event only once.
  if (button.dataset.tutorialBound !== "true") {
    button.addEventListener("click", showOnboardingGuide);
    button.dataset.tutorialBound = "true";
  }

  return button;
}


function initializePatientVisualTour() {
  if (patientTourInitialized && patientVisualTour) {
    return patientVisualTour;
  }

  patientVisualTour = createMedminderSpotlight(
    patientVisualSteps,
    completeOnboarding
  );

  patientTourInitialized = true;
  return patientVisualTour;
}

/* =====================================================
   START PATIENT DASHBOARD
   THIS FUNCTION WAS MISSING IN YOUR ORIGINAL CODE.
===================================================== */

async function startPatientDashboard(user) {
  setLoading(true);

  try {
    state.user = user;

    // Reset previous account data before loading this account.
    state.profile = {};
    state.caregiverUid = null;
    state.connectionInfo = {};
    state.medicines = {};
    state.reminders = {};
    state.logs = {};
    state.connectionRequests = {};

    stopAllListeners();

    const profileSnapshot = await get(
      ref(db, `users/${user.uid}/profile`)
    );

    state.profile = profileSnapshot.val() || {};

    console.log("PATIENT PROFILE:", state.profile);
    console.log("PATIENT UID:", user.uid);

    updateUserDisplay(state.profile, user);

    if ($("allowCaregiverConnections")) {
      $("allowCaregiverConnections").checked =
        state.profile.allowCaregiverConnections !== false;
    }

    ensureConnectionRequestPanel();
    ensureOnboardingUI();
    initializePatientVisualTour();

    renderConnectionRequests();
    renderActiveCaregiver();
    renderAll();

    // Start Firebase listeners.
    listenToPatientLogs(user.uid);
    listenToConnectionRequests(user.uid);
    listenToConnection(user.uid);

    // Start checking reminders.
    startReminderChecker();

    setLoading(false);

    // Show tutorial only on the first successful dashboard entry.
    if (state.profile.onboardingCompleted !== true) {
      setTimeout(() => {
        if (
          auth.currentUser?.uid === user.uid &&
          state.profile.onboardingCompleted !== true
        ) {
          showOnboardingGuide();
        }
      }, 700);
    }

  } catch (error) {
    console.error("Starting patient dashboard failed:", error);

    setLoading(false);

    notice(
      "error",
      "Unable to load your patient dashboard. Please refresh the page or check your Firebase Database Rules."
    );
  }
}

/* =====================================================
   INITIALIZE
===================================================== */

setupNavigation();
setupEvents();

onAuthStateChanged(auth, async user => {
  if (!user) {
    stopAllListeners();
    window.location.href = "login.html";
    return;
  }

  await startPatientDashboard(user);
});
