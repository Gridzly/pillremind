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

const $ = (id) => document.getElementById(id);

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

  const match = String(value).match(/^(\d{1,2}):(\d{2})$/);

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
    "Unnamed medicine";
}

function medicineDosage(medicine) {
  return medicine?.dosage ||
    medicine?.dose ||
    medicine?.strength ||
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

function getStatus(reminderId, date) {
  return String(getLog(reminderId, date)?.status || "pending").toLowerCase();
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
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
}

function findMedicine(reminder) {
  const id = reminderMedicineId(reminder);

  if (id && state.medicines[id]) {
    return state.medicines[id];
  }

  if (reminder?.medicine && typeof reminder.medicine === "object") {
    return reminder.medicine;
  }

  const name = reminder?.medicineName || reminder?.name;

  if (name) {
    return {
      name,
      dosage: reminder?.dosage || reminder?.dose || ""
    };
  }

  return null;
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

  if ($("sideUserName")) {
    $("sideUserName").textContent = name;
  }

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

  if (!qrContainer) {
    console.warn("Patient QR code container not found.");
    return null;
  }

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
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
      flex-wrap:wrap;
      margin-top:22px;
      padding-top:18px;
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
        background:#e7f4eb;
        color:#175638;
        padding:7px 12px;
        border-radius:20px;
        font-size:12px;
        font-weight:800;
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
  const panel = ensureConnectionRequestPanel();
  if (!panel) return;

  const list = $("connectionRequestsList");
  const count = $("connectionRequestCount");

  if (!list) return;

  const entries = Object.entries(state.connectionRequests)
    .filter(([, request]) =>
      request &&
      String(request.status || "").toLowerCase() === "pending"
    );

  if (count) {
    count.textContent = `${entries.length} Pending`;
  }

  if (!entries.length) {
    list.innerHTML = `
      <div style="
        padding:15px;
        background:#f6faf7;
        border-radius:12px;
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
        padding:16px;
        margin-bottom:12px;
        border:1px solid #e2ebe4;
        border-radius:13px;
        background:#ffffff;
      ">
        <div style="display:flex;align-items:flex-start;gap:12px;">
          <div style="
            width:44px;height:44px;flex-shrink:0;
            display:flex;align-items:center;justify-content:center;
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
            <p style="margin:7px 0 0;color:#89958d;font-size:11px;overflow-wrap:anywhere;">
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
        padding:18px;background:#f6faf7;
        border:1px dashed #cbdccf;border-radius:14px;
        text-align:center;
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
      padding:18px;background:#f1f8f3;
      border:1px solid #d7e9dc;border-radius:15px;
    ">
      <div style="
        display:flex;align-items:center;justify-content:space-between;
        gap:10px;flex-wrap:wrap;margin-bottom:15px;
      ">
        <strong style="color:#175638;font-size:13px;">
          🟢 Active Connection
        </strong>
        <span style="
          padding:5px 10px;border-radius:20px;
          background:#dff2e5;color:#17643b;
          font-size:11px;font-weight:800;
        ">CONNECTED</span>
      </div>

      <div style="display:flex;align-items:center;gap:13px;">
        <div style="
          width:48px;height:48px;flex-shrink:0;
          display:flex;align-items:center;justify-content:center;
          border-radius:50%;background:#175638;color:white;
          font-size:20px;font-weight:800;
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

      <div style="
        margin-top:15px;padding:12px;background:white;border-radius:10px;
      ">
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
          width:100%;min-height:44px;margin-top:15px;
          padding:12px;border:1px solid #efcaca;border-radius:10px;
          background:#fff5f5;color:#b42323;
          font-size:13px;font-weight:800;cursor:pointer;
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

   Writes TWO records:
   1. Patient's careConnection
   2. Caregiver's connectedPatients index
===================================================== */

async function approveConnectionRequest(caregiverUid) {
  if (!state.user || !caregiverUid) return;
  if (state.processingRequests.has(caregiverUid)) return;

  if (state.caregiverUid && state.caregiverUid !== caregiverUid) {
    notice(
      "error",
      "You already have an active caregiver. Disconnect the current caregiver first."
    );
    return;
  }

  const request = state.connectionRequests[caregiverUid];

  if (!request || request.status !== "pending") {
    notice("error", "This connection request is no longer pending.");
    return;
  }

  state.processingRequests.add(caregiverUid);
  renderConnectionRequests();

  const patientUid = state.user.uid;
  const connectionRef = ref(db, `users/${patientUid}/careConnection`);
  const patientProfileRef = ref(db, `users/${patientUid}/profile`);

  let connectionWasWritten = false;

  try {
    const [connectionSnapshot, profileSnapshot] = await Promise.all([
      get(connectionRef),
      get(patientProfileRef)
    ]);

    const currentConnection = connectionSnapshot.val() || {};
    const patientProfile = profileSnapshot.val() || {};

    if (
      currentConnection.status === "active" &&
      currentConnection.authorizedUid &&
      currentConnection.authorizedUid !== caregiverUid
    ) {
      throw new Error(
        "You already have another active caregiver. Disconnect that caregiver first."
      );
    }

    const connectedAt = Date.now();

    const connectionData = {
      authorizedUid: caregiverUid,
      caregiverName: request.caregiverName || "Authorized Caregiver",
      caregiverEmail: request.caregiverEmail || "",
      status: "active",
      connectedAt
    };

    // First: save the patient's active caregiver.
    await set(connectionRef, connectionData);
    connectionWasWritten = true;

    // Second: register this patient under the caregiver's account.
    await set(
      ref(db, `users/${caregiverUid}/connectedPatients/${patientUid}`),
      {
        patientUid,
        patientName:
          patientProfile.firstName ||
          patientProfile.fullName ||
          state.user.displayName ||
          "Patient",
        status: "active",
        connectedAt
      }
    );

    // Remove the original pending request.
    await remove(
      ref(db, `users/${patientUid}/connectionRequests/${caregiverUid}`)
    );

    delete state.connectionRequests[caregiverUid];

    notice(
      "success",
      "Connection approved! Your caregiver has been added to your account."
    );

    renderConnectionRequests();

  } catch (error) {
    console.error("Approving caregiver request failed:", error);

    // Roll back the connection if the caregiver index could not be saved.
    if (connectionWasWritten) {
      try {
        await remove(connectionRef);
      } catch (rollbackError) {
        console.error("Connection rollback failed:", rollbackError);
      }
    }

    notice(
      "error",
      error.message ||
      "Unable to approve this request. Check your Firebase Database Rules."
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

   Removes the caregiver index first, then the patient's
   active connection.
===================================================== */

async function disconnectCaregiver() {
  if (!state.user || !state.caregiverUid) {
    notice("info", "There is no active caregiver connection.");
    return;
  }

  const caregiverUid = state.caregiverUid;
  const caregiverName =
    state.connectionInfo?.caregiverName || "this caregiver";

  const confirmed = window.confirm(
    `Are you sure you want to disconnect ${caregiverName}?\n\n` +
    "You will no longer receive this caregiver's shared medicines and reminders. " +
    "Your dose history will remain in your account."
  );

  if (!confirmed) return;

  const button = $("disconnectCaregiverButton");

  if (button) {
    button.disabled = true;
    button.textContent = "Disconnecting...";
  }

  try {
    // Remove this patient from the caregiver's patient list.
    await remove(
      ref(
        db,
        `users/${caregiverUid}/connectedPatients/${state.user.uid}`
      )
    );

    // Remove the patient's active caregiver connection.
    await remove(
      ref(db, `users/${state.user.uid}/careConnection`)
    );

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
      "Caregiver disconnected successfully. Your dose history has been kept."
    );

  } catch (error) {
    console.error("Disconnect caregiver failed:", error);

    notice(
      "error",
      "Unable to disconnect. Check your Firebase Database Rules. If the patient-list entry was removed but the connection remains, try disconnecting again."
    );

    renderActiveCaregiver();
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
    const AudioContext =
      window.AudioContext || window.webkitAudioContext;

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

    gain.gain.setValueAtTime(
      0.001,
      reminderAudioContext.currentTime
    );

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
  const AudioContext =
    window.AudioContext || window.webkitAudioContext;

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

    dosage: entry.reminder?.dose ||
      entry.reminder?.dosage ||
      (medicine ? medicineDosage(medicine) : "") ||
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

  if (getLog(entry.id, entry.date)) {
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

    if (getLog(entry.id, date)) {
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

  reminderCheckInterval = setInterval(
    checkDueMedicineReminders,
    5000
  );
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

$("stopReminderSound")?.addEventListener(
  "click",
  stopReminderSound
);

$("modalTakenButton")?.addEventListener("click", async () => {
  if (!activeReminder) return;

  const entry = activeReminder;

  const saved = await recordDose(
    entry.id,
    entry.date,
    "taken",
    null
  );

  if (saved) closeMedicineReminder();
});

$("modalSnoozeButton")?.addEventListener("click", () => {
  if (!activeReminder) return;

  const snoozedEntry = activeReminder;

  stopReminderSound();

  if ($("medicineReminderModal")) {
    $("medicineReminderModal").hidden = true;
  }

  activeReminder = null;

  reminderSnoozeTimeout = setTimeout(() => {
    reminderSnoozeTimeout = null;

    if (!state.user || !state.caregiverUid) return;

    if (getLog(snoozedEntry.id, snoozedEntry.date)) {
      showNextMedicineReminder();
      return;
    }

    enqueueMedicineReminder(snoozedEntry);
  }, 5 * 60 * 1000);

  showNextMedicineReminder();

  notice(
    "info",
    "Reminder postponed. Medminder will remind you again in 5 minutes."
  );
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

  const dosage = reminder?.dose ||
    (medicine ? medicineDosage(medicine) : "") ||
    reminder?.dosage ||
    "Dosage not specified";

  const instructions = reminder?.notes || reminder?.instructions || "";

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

  if ($("todayCount")) {
    $("todayCount").textContent = entries.length;
  }

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
  const entries = Object.entries(state.medicines)
    .filter(([, medicine]) => isActiveMedicine(medicine));

  if ($("medicineCount")) {
    $("medicineCount").textContent = entries.length;
  }

  if (!entries.length) {
    empty(
      "medicineList",
      "No medicines yet",
      "Medicines added by your authorized caregiver will appear here."
    );
    return;
  }

  if ($("medicineList")) {
    $("medicineList").innerHTML = entries.map(([, medicine]) => {
      const frequency = medicine.frequency || medicine.recurrence || "";
      const instructions = medicine.notes || medicine.instructions || "";

      return `
        <article class="item">
          <div class="item-icon">💊</div>
          <div class="item-main">
            <h3 class="item-title">
              ${escapeHTML(medicineName(medicine))}
            </h3>
            <p class="item-description">
              Dosage: ${escapeHTML(medicineDosage(medicine))}
              ${frequency ? `\nSchedule: ${escapeHTML(frequency)}` : ""}
              ${instructions ? `\nInstructions: ${escapeHTML(instructions)}` : ""}
            </p>
          </div>
        </article>
      `;
    }).join("");
  }
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
    empty(
      "historyList",
      "No history yet",
      "Doses you record will appear here."
    );
    return;
  }

  if ($("historyList")) {
    $("historyList").innerHTML = entries.map(log => `
      <article class="item">
        <div class="item-icon">
          ${String(log.status).toLowerCase() === "taken" ? "✓" : "◷"}
        </div>

        <div class="item-main">
          <h3 class="item-title">
            ${escapeHTML(log.medicineName || log.name || "Medicine dose")}
          </h3>

          <p class="item-description">
            Date: ${escapeHTML(formatDate(log.date))}
            \nDosage: ${escapeHTML(log.dosage || "Not specified")}
            ${log.recordedAt
              ? `\nRecorded: ${escapeHTML(new Date(log.recordedAt).toLocaleString())}`
              : ""}
          </p>

          <div class="item-meta">${statusTag(log.status)}</div>
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
          "Connected. Your caregiver's medicines and reminders are syncing live."
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
   PATIENT-OWNED MEDICINES AND REMINDERS

   IMPORTANT:
   The caregiver now saves each patient's medicines
   and reminders under the patient's UID.

   Patient data paths:
   users/PATIENT_UID/medicines
   users/PATIENT_UID/reminders
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
        "Medicines could not be loaded. Check your Firebase Database Rules."
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

  if (getLog(reminderId, date)) {
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
      : reminder.medicineName ||
        reminder.name ||
        "Scheduled medicine",

    dosage:
      reminder.dose ||
      reminder.dosage ||
      (medicine ? medicineDosage(medicine) : "Not specified"),

    date,
    time: reminderTime(reminder),
    status,
    recordedAt: new Date().toISOString()
  };

  try {
    await set(
      ref(db, `users/${state.user.uid}/intakeLogs/${key}`),
      log
    );

    state.logs[key] = log;

    triggeredReminders.add(
      `${reminderId}_${date}_${String(reminderTime(reminder)).slice(0, 5)}`
    );

    renderAll();

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
  $("copyPatientUidButton")?.addEventListener(
    "click",
    copyPatientUid
  );

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

    const connectionButton = target.closest(
      "[data-connection-action]"
    );

    if (connectionButton) {
      const caregiverUid = connectionButton.dataset.caregiverUid;
      const action = connectionButton.dataset.connectionAction;

      if (action === "approve") {
        approveConnectionRequest(caregiverUid);
      }

      if (action === "reject") {
        rejectConnectionRequest(caregiverUid);
      }

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

  $("mobileLogoutButton")?.addEventListener(
    "click",
    handleLogout
  );

  window.addEventListener("beforeunload", stopAllListeners);
}

/* =====================================================
   START PATIENT DASHBOARD
===================================================== */

async function startPatientDashboard(user) {
  stopAllListeners();

  state.user = user;
  state.profile = {};
  state.caregiverUid = null;
  state.connectionInfo = {};
  state.medicines = {};
  state.reminders = {};
  state.logs = {};
  state.connectionRequests = {};

  state.processingRequests.clear();
  state.recording.clear();

  triggeredReminders.clear();

  setLoading(true);
  clearNotices();

  try {
    const profileSnapshot = await get(
      ref(db, `users/${user.uid}/profile`)
    );

    const profile = profileSnapshot.val() || {};

    state.profile = profile;

    const role = String(profile.role || "")
      .toLowerCase()
      .trim();

    if (
      !["patient", "medicine taker", "medicine_taker"].includes(role)
    ) {
      setLoading(false);

      notice(
        "error",
        "This page is for patient accounts. Please sign in with your patient account."
      );

      return;
    }

    updateUserDisplay(profile, user);

    const permissionToggle = $("allowCaregiverConnections");

    if (permissionToggle) {
      permissionToggle.checked =
        profile.allowCaregiverConnections === true;
    }

    ensureConnectionRequestPanel();

    renderActiveCaregiver();
    renderConnectionRequests();

    listenToConnectionRequests(user.uid);
    listenToConnection(user.uid);
    listenToPatientLogs(user.uid);

    startReminderChecker();

    setLoading(false);

  } catch (error) {
    console.error("Patient dashboard startup failed:", error);

    setLoading(false);

    notice(
      "error",
      "Unable to load your account. Check Firebase configuration, sign-in status, and Database Rules."
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