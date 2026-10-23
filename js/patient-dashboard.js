
import { auth, db } from "./firebaseConfig.js";

import {
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
  ref,
  get,
  onValue,
  set
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

import {
  getFunctions,
  httpsCallable
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";

/*
  MEDMINDER PATIENT DASHBOARD

  Expected data locations:
  users/{patientUid}/profile
  users/{patientUid}/careConnection
  users/{patientUid}/intakeLogs

  Caregiver-managed data:
  users/{caregiverUid}/medicines
  users/{caregiverUid}/reminders

  IMPORTANT:
  Caregiver-to-patient access requires appropriate secure Firebase
  Database Rules and a trusted connection backend. The browser must
  not be allowed to create or approve its own connections.
*/

const $ = (id) => document.getElementById(id);

const state = {
  user: null,
  patientData: {},
  caregiverUid: null,
  medicines: {},
  reminders: {},
  logs: {},
  unsubscribers: [],
  code: null,
  codeExpiry: null,
  codeTimer: null,
  codeRequestInProgress: false
};

const functions = getFunctions(auth.app, "us-central1");

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function showNotice(type, message) {
  ["error", "success", "info"].forEach((id) => {
    $(id).classList.remove("show");
    $(id).textContent = "";
  });

  const element = $(type);
  if (!element) return;

  element.textContent = message;
  element.classList.add("show");
}

function clearNotice(type) {
  if ($(type)) {
    $(type).textContent = "";
    $(type).classList.remove("show");
  }
}

function setLoading(loading) {
  $("loading").hidden = !loading;
  $("app").hidden = loading;
}

function stopListeners() {
  state.unsubscribers.forEach((unsubscribe) => {
    try {
      unsubscribe();
    } catch (error) {
      console.warn("Listener cleanup failed:", error);
    }
  });

  state.unsubscribers = [];
}

function stopCodeTimer() {
  if (state.codeTimer) {
    clearInterval(state.codeTimer);
    state.codeTimer = null;
  }
}

function todayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function formatDate(dateString) {
  if (!dateString) return "Date not specified";

  const date = new Date(`${dateString}T12:00:00`);

  if (Number.isNaN(date.getTime())) return dateString;

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

function formatTime(value) {
  if (!value) return "Time not set";

  const text = String(value);

  const match = text.match(/^(\d{1,2}):(\d{2})$/);

  if (!match) return text;

  const date = new Date();
  date.setHours(Number(match[1]), Number(match[2]), 0, 0);

  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit"
  });
}

function normalizeRole(data) {
  return String(
    data?.profile?.role ??
    data?.role ??
    data?.accountRole ??
    ""
  ).toLowerCase().trim();
}

function normalizeCollection(data) {
  if (!data || typeof data !== "object") return {};

  return Object.fromEntries(
    Object.entries(data).filter(([, value]) =>
      value && typeof value === "object"
    )
  );
}

function displayName(data, user) {
  const profile = data?.profile || {};

  const firstName =
    profile.firstName ||
    data?.firstName ||
    user?.displayName?.split(" ")[0] ||
    "there";

  return firstName;
}

function showEmpty(containerId, title, message) {
  $(containerId).innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">🌿</div>
      <strong>${escapeHTML(title)}</strong>
      <span>${escapeHTML(message)}</span>
    </div>
  `;
}

function getConnectedUid(data) {
  return (
    data?.careConnection?.authorizedUid ||
    data?.connection?.authorizedUid ||
    data?.authorizedPersonUid ||
    data?.connectedAuthorizedUid ||
    null
  );
}

function isActiveMedicine(medicine) {
  return medicine?.active !== false &&
    medicine?.isActive !== false &&
    medicine?.archived !== true;
}

function medicineName(medicine) {
  return (
    medicine?.name ||
    medicine?.medicineName ||
    medicine?.medicationName ||
    "Unnamed medicine"
  );
}

function medicineDosage(medicine) {
  return (
    medicine?.dosage ||
    medicine?.dose ||
    medicine?.strength ||
    "Dosage not specified"
  );
}

function reminderMedicineId(reminder) {
  return (
    reminder?.medicineId ||
    reminder?.medicationId ||
    reminder?.medicineKey ||
    ""
  );
}

function reminderDate(reminder) {
  return (
    reminder?.date ||
    reminder?.scheduledDate ||
    reminder?.startDate ||
    ""
  );
}

function reminderTime(reminder) {
  return (
    reminder?.time ||
    reminder?.scheduledTime ||
    reminder?.reminderTime ||
    ""
  );
}

function reminderIdForLog(reminderId, date) {
  return `${reminderId}_${date}`;
}

function getLog(reminderId, date) {
  return state.logs[reminderIdForLog(reminderId, date)] || null;
}

function getStatus(reminderId, date) {
  const log = getLog(reminderId, date);
  return String(log?.status || "pending").toLowerCase();
}

function getDayName(dateString) {
  const date = new Date(`${dateString}T12:00:00`);

  if (Number.isNaN(date.getTime())) return "";

  return [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday"
  ][date.getDay()];
}

function getDaysOfWeek(reminder) {
  const days = reminder?.daysOfWeek ?? reminder?.days ?? [];

  if (Array.isArray(days)) {
    return days.map((day) => String(day).toLowerCase());
  }

  if (typeof days === "string") {
    return days.split(",").map((day) => day.trim().toLowerCase());
  }

  if (days && typeof days === "object") {
    return Object.keys(days).filter((day) => days[day]);
  }

  return [];
}

function matchesDay(dayValues, dateString) {
  if (!dayValues.length) return true;

  const date = new Date(`${dateString}T12:00:00`);
  const dayName = getDayName(dateString).toLowerCase();
  const dayNumber = String(date.getDay());

  return dayValues.some((value) => {
    const day = String(value).toLowerCase();

    return (
      day === dayName ||
      day === dayNumber ||
      day.slice(0, 3) === dayName.slice(0, 3)
    );
  });
}

function isReminderScheduled(reminder, dateString) {
  if (reminder?.active === false || reminder?.isActive === false) {
    return false;
  }

  const recurrence = String(
    reminder?.recurrence ||
    reminder?.repeat ||
    reminder?.frequency ||
    "once"
  ).toLowerCase();

  const days = getDaysOfWeek(reminder);
  const startDate = reminderDate(reminder);
  const endDate = reminder?.endDate || "";

  if (startDate && dateString < startDate) return false;
  if (endDate && dateString > endDate) return false;

  if (
    recurrence === "weekly" ||
    recurrence === "daily" ||
    recurrence === "everyday" ||
    recurrence === "every day"
  ) {
    if (
      recurrence === "daily" ||
      recurrence === "everyday" ||
      recurrence === "every day"
    ) {
      return true;
    }

    return matchesDay(days, dateString);
  }

  if (days.length) {
    return matchesDay(days, dateString);
  }

  // A one-time reminder only appears on its scheduled date.
  return !startDate || startDate === dateString;
}

function getReminderEntries(dateString) {
  return Object.entries(state.reminders)
    .filter(([, reminder]) => isReminderScheduled(reminder, dateString))
    .map(([id, reminder]) => ({
      id,
      reminder,
      date: dateString,
      time: reminderTime(reminder)
    }))
    .sort((a, b) => {
      return String(a.time).localeCompare(String(b.time));
    });
}

function findMedicine(reminder) {
  const medicineId = reminderMedicineId(reminder);

  if (medicineId && state.medicines[medicineId]) {
    return state.medicines[medicineId];
  }

  const embedded = reminder?.medicine;

  if (embedded && typeof embedded === "object") {
    return embedded;
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

function badgeForStatus(status) {
  const normalized = String(status || "pending").toLowerCase();

  if (normalized === "taken") {
    return `<span class="badge taken">Taken</span>`;
  }

  if (normalized === "missed") {
    return `<span class="badge missed">Missed</span>`;
  }

  return `<span class="badge pending">Pending</span>`;
}

function renderReminderCard(entry, allowActions = true) {
  const { id, reminder, date, time } = entry;
  const medicine = findMedicine(reminder);
  const status = getStatus(id, date);

  const name = medicine
    ? medicineName(medicine)
    : (reminder?.medicineName || reminder?.name || "Scheduled medicine");

  const dosage = medicine
    ? medicineDosage(medicine)
    : (reminder?.dosage || reminder?.dose || "Dosage not specified");

  const notes = reminder?.notes || reminder?.instructions || "";
  const disabled = status === "taken" || status === "missed";

  let actions = "";

  if (allowActions && !disabled) {
    actions = `
      <div class="item-actions">
        <button
          class="btn small"
          type="button"
          data-dose-action="taken"
          data-reminder-id="${escapeHTML(id)}"
          data-dose-date="${escapeHTML(date)}"
        >✓ Mark taken</button>

        <button
          class="btn danger small"
          type="button"
          data-dose-action="missed"
          data-reminder-id="${escapeHTML(id)}"
          data-dose-date="${escapeHTML(date)}"
        >Mark missed</button>
      </div>
    `;
  }

  return `
    <article class="item-card">
      <div class="item-main">
        <h3 class="item-title">${escapeHTML(name)}</h3>

        <div class="item-details">
          <div>Dosage: ${escapeHTML(dosage)}</div>
          <div>Date: ${escapeHTML(formatDate(date))}</div>
          ${notes ? `<div>Instructions: ${escapeHTML(notes)}</div>` : ""}
        </div>

        ${actions}
      </div>

      <div class="item-side">
        <div class="item-time">${escapeHTML(formatTime(time))}</div>
        ${badgeForStatus(status)}
      </div>
    </article>
  `;
}

function renderToday() {
  const date = todayKey();
  const entries = getReminderEntries(date);

  $("todayLabel").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric"
  });

  $("todayCount").textContent = entries.length;

  $("takenCount").textContent = entries.filter(
    (entry) => getStatus(entry.id, date) === "taken"
  ).length;

  if (!entries.length) {
    showEmpty(
      "todayList",
      "No reminders for today",
      state.caregiverUid
        ? "Your caregiver has not scheduled any doses for today."
        : "Connect with your caregiver to receive your medicine schedule."
    );

    return;
  }

  $("todayList").innerHTML = entries
    .map((entry) => renderReminderCard(entry))
    .join("");
}

function renderAllReminders() {
  const today = todayKey();
  const dates = [];

  // Show today's and the next six days of reminders.
  for (let offset = 0; offset < 7; offset++) {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    dates.push(todayKey(date));
  }

  const entries = dates.flatMap((date) => getReminderEntries(date));

  if (!entries.length) {
    showEmpty(
      "reminderList",
      "No upcoming reminders",
      "Your scheduled medicine reminders will appear here."
    );

    return;
  }

  $("reminderList").innerHTML = entries.map((entry) => {
    const dateLabel = entry.date === today
      ? "Today"
      : formatDate(entry.date);

    return `
      <div>
        <p class="small-note">${escapeHTML(dateLabel)}</p>
        ${renderReminderCard(entry)}
      </div>
    `;
  }).join("");
}

function renderMedicines() {
  const entries = Object.entries(state.medicines)
    .filter(([, medicine]) => isActiveMedicine(medicine));

  $("medicineCount").textContent = entries.length;

  if (!entries.length) {
    showEmpty(
      "medicineList",
      "No medicines yet",
      state.caregiverUid
        ? "Medicines added by your caregiver will appear here."
        : "Your medicine list will appear once your caregiver is connected."
    );

    return;
  }

  $("medicineList").innerHTML = entries.map(([id, medicine]) => {
    const notes = medicine.notes || medicine.instructions || "";
    const frequency = medicine.frequency || medicine.recurrence || "";

    return `
      <article class="item-card">
        <div class="item-main">
          <h3 class="item-title">${escapeHTML(medicineName(medicine))}</h3>

          <div class="item-details">
            <div>Dosage: ${escapeHTML(medicineDosage(medicine))}</div>
            ${frequency ? `<div>Schedule: ${escapeHTML(frequency)}</div>` : ""}
            ${notes ? `<div>Instructions: ${escapeHTML(notes)}</div>` : ""}
          </div>
        </div>

        <div class="item-side">
          <span class="badge">Medicine</span>
        </div>
      </article>
    `;
  }).join("");
}

function renderHistory() {
  const entries = Object.entries(state.logs)
    .filter(([, log]) => log && typeof log === "object")
    .map(([id, log]) => ({ id, ...log }))
    .filter((log) => ["taken", "missed"].includes(
      String(log.status || "").toLowerCase()
    ))
    .sort((a, b) => {
      const aKey = `${a.date || ""} ${a.time || ""}`;
      const bKey = `${b.date || ""} ${b.time || ""}`;
      return bKey.localeCompare(aKey);
    });

  if (!entries.length) {
    showEmpty(
      "historyList",
      "No history yet",
      "Doses you mark as taken or missed will appear here."
    );

    return;
  }

  $("historyList").innerHTML = entries.map((log) => {
    const status = String(log.status).toLowerCase();

    return `
      <article class="item-card">
        <div class="item-main">
          <h3 class="item-title">${escapeHTML(
            log.medicineName || log.name || "Medicine dose"
          )}</h3>

          <div class="item-details">
            <div>Date: ${escapeHTML(formatDate(log.date))}</div>
            <div>Dosage: ${escapeHTML(log.dosage || "Not specified")}</div>
            ${log.recordedAt
              ? `<div>Recorded: ${escapeHTML(
                  new Date(log.recordedAt).toLocaleString()
                )}</div>`
              : ""}
          </div>
        </div>

        <div class="item-side">
          ${badgeForStatus(status)}
        </div>
      </article>
    `;
  }).join("");
}

function renderAll() {
  renderToday();
  renderMedicines();
  renderAllReminders();
  renderHistory();
}

function listenToPatientLogs(uid) {
  const logsRef = ref(db, `users/${uid}/intakeLogs`);

  const unsubscribe = onValue(
    logsRef,
    (snapshot) => {
      state.logs = normalizeCollection(snapshot.val());
      renderAll();
    },
    (error) => {
      console.error("Could not read intake history:", error);
      showNotice(
        "error",
        "Unable to load your medicine history. Check your Firebase Database Rules."
      );
    }
  );

  state.unsubscribers.push(unsubscribe);
}

function listenToCaregiverData(caregiverUid) {
  stopListeners();

  state.caregiverUid = caregiverUid;

  // These reads require secure Firebase rules permitting this patient
  // to read only the caregiver account explicitly linked to them.
  const medicinesRef = ref(db, `users/${caregiverUid}/medicines`);
  const remindersRef = ref(db, `users/${caregiverUid}/reminders`);

  const unsubscribeMedicines = onValue(
    medicinesRef,
    (snapshot) => {
      state.medicines = normalizeCollection(snapshot.val());
      renderAll();
    },
    (error) => {
      console.error("Caregiver medicine read failed:", error);

      showNotice(
        "error",
        "Your account is connected in the profile, but Firebase denied access to caregiver medicines. Secure cross-account Database Rules must be configured."
      );
    }
  );

  const unsubscribeReminders = onValue(
    remindersRef,
    (snapshot) => {
      state.reminders = normalizeCollection(snapshot.val());
      renderAll();
    },
    (error) => {
      console.error("Caregiver reminder read failed:", error);

      showNotice(
        "error",
        "Unable to read caregiver reminders. Check the secure cross-account Database Rules."
      );
    }
  );

  state.unsubscribers.push(
    unsubscribeMedicines,
    unsubscribeReminders
  );

  listenToPatientLogs(state.user.uid);
}

async function startPatientDashboard(user) {
  stopListeners();
  stopCodeTimer();

  state.user = user;
  state.medicines = {};
  state.reminders = {};
  state.logs = {};
  state.caregiverUid = null;

  setLoading(true);
  clearNotice("error");
  clearNotice("success");
  clearNotice("info");

  try {
    const snapshot = await get(ref(db, `users/${user.uid}`));

    if (!snapshot.exists()) {
      showNotice(
        "error",
        "Your user profile was not found. Please finish setting up your Medminder account."
      );
      setLoading(false);
      $("app").hidden = true;
      return;
    }

    const data = snapshot.val();
    state.patientData = data;

    const role = normalizeRole(data);

    if (!["patient", "medicine taker", "medicine_taker"].includes(role)) {
      showNotice(
        "error",
        "This page is for patient accounts. Please sign in using your patient account."
      );

      setLoading(false);
      $("app").hidden = true;
      return;
    }

    const name = displayName(data, user);

    $("welcomeTitle").textContent = `Hello, ${name}! 👋`;
    $("headerUserName").textContent = name;

    $("app").hidden = false;
    $("loading").hidden = true;

    const caregiverUid = getConnectedUid(data);

    if (caregiverUid) {
      $("connectionStatusBadge").textContent = "Connected";
      $("connectionStatusBadge").className = "badge taken";
      $("connectionStatus").textContent =
        "A caregiver is linked to your profile. Loading your schedule...";

      listenToCaregiverData(caregiverUid);
    } else {
      $("connectionStatusBadge").textContent = "Not connected";
      $("connectionStatusBadge").className = "badge pending";
      $("connectionStatus").textContent =
        "Your caregiver has not been connected to this account yet.";

      state.caregiverUid = null;
      state.medicines = {};
      state.reminders = {};

      listenToPatientLogs(user.uid);
      renderAll();

      showNotice(
        "info",
        "Connect your patient account to your authorized caregiver to receive their medicine schedule."
      );
    }
  } catch (error) {
    console.error("Patient dashboard startup failed:", error);

    showNotice(
      "error",
      "Unable to load your account. Check your Firebase configuration and Database Rules."
    );

    setLoading(false);
    $("app").hidden = true;
  }
}

async function recordDose(reminderId, date, status) {
  if (!state.user || !state.caregiverUid) {
    showNotice(
      "error",
      "Connect your account to your caregiver before recording a scheduled dose."
    );
    return;
  }

  if (!["taken", "missed"].includes(status)) return;

  const reminder = state.reminders[reminderId];

  if (!reminder) {
    showNotice(
      "error",
      "This reminder is no longer available. Refresh your dashboard."
    );
    return;
  }

  const existing = getLog(reminderId, date);

  if (existing?.status === "taken" || existing?.status === "missed") {
    showNotice("info", "You have already recorded this dose.");
    return;
  }

  const medicine = findMedicine(reminder);
  const logKey = reminderIdForLog(reminderId, date);

  const log = {
    reminderId,
    medicineId: reminderMedicineId(reminder),
    medicineName: medicine
      ? medicineName(medicine)
      : (reminder.medicineName || reminder.name || "Scheduled medicine"),
    dosage: medicine
      ? medicineDosage(medicine)
      : (reminder.dosage || reminder.dose || "Not specified"),
    date,
    time: reminderTime(reminder),
    status,
    recordedAt: new Date().toISOString()
  };

  const button = document.querySelector(
    `[data-dose-action="${status}"][data-reminder-id="${CSS.escape(reminderId)}"][data-dose-date="${CSS.escape(date)}"]`
  );

  if (button) button.disabled = true;

  try {
    await set(
      ref(db, `users/${state.user.uid}/intakeLogs/${logKey}`),
      log
    );

    state.logs[logKey] = log;
    renderAll();

    showNotice(
      "success",
      status === "taken"
        ? "Dose recorded as taken."
        : "Dose recorded as missed."
    );
  } catch (error) {
    console.error("Dose recording failed:", error);

    if (button) button.disabled = false;

    showNotice(
      "error",
      "Could not save your dose record. Check your Firebase Database Rules and try again."
    );
  }
}

function showConnectionCode(code, expiresAt) {
  state.code = code;
  state.codeExpiry = expiresAt;

  $("connectionCodeArea").hidden = false;
  $("connectionCodeText").textContent = code;

  updateExpiryText();
  stopCodeTimer();

  state.codeTimer = setInterval(() => {
    if (!state.code || !state.codeExpiry) {
      stopCodeTimer();
      return;
    }

    if (Date.now() >= state.codeExpiry) {
      state.code = null;
      $("connectionCodeArea").hidden = true;
      $("connectionStatus").textContent =
        "Your connection code has expired. Generate a new one if needed.";
      stopCodeTimer();
      return;
    }

    updateExpiryText();
  }, 1000);
}

function updateExpiryText() {
  if (!state.codeExpiry) return;

  const remaining = Math.max(
    0,
    Math.floor((state.codeExpiry - Date.now()) / 1000)
  );

  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;

  $("connectionExpiry").textContent =
    `Expires in ${minutes}:${String(seconds).padStart(2, "0")}`;
}

function hideConnectionCode() {
  state.code = null;
  state.codeExpiry = null;

  stopCodeTimer();

  $("connectionCodeArea").hidden = true;
  $("connectionCodeText").textContent = "";
  $("connectionExpiry").textContent = "";
}

async function generateConnectionCode() {
  if (!state.user || state.codeRequestInProgress) return;

  state.codeRequestInProgress = true;

  const button = $("generateConnectionCode");
  button.disabled = true;
  button.textContent = "Generating...";

  try {
    /*
      This callable must be deployed and implemented securely.
      It should authenticate the patient, generate a cryptographically
      random single-use code, save only a safe representation, set an
      expiry, and let the caregiver redeem it through a trusted backend.

      No browser-generated fallback is used because it would not be
      a secure way to authorize access to another Firebase account.
    */

    const createCode = httpsCallable(functions, "createConnectionCode");
    const result = await createCode({});
    const data = result.data || {};

    if (!data.code || !data.expiresAt) {
      throw new Error(
        "The connection service returned an incomplete response."
      );
    }

    const expiresAt = typeof data.expiresAt === "number"
      ? data.expiresAt
      : new Date(data.expiresAt).getTime();

    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new Error("The connection service returned an invalid expiry.");
    }

    showConnectionCode(String(data.code), expiresAt);

    $("connectionStatus").textContent =
      "Temporary code created. Share it only with your authorized caregiver.";

    showNotice(
      "success",
      "Your temporary connection code is ready."
    );
  } catch (error) {
    console.error("Connection-code generation failed:", error);

    hideConnectionCode();

    $("connectionStatus").textContent =
      "Connection-code service is not available. It must be deployed and configured before you can connect your caregiver.";

    showNotice(
      "error",
      "Could not generate a connection code. The createConnectionCode Firebase Cloud Function must be deployed and configured."
    );
  } finally {
    state.codeRequestInProgress = false;
    button.disabled = false;
    button.textContent = "Generate connection code";
  }
}

async function copyConnectionCode() {
  if (!state.code) return;

  try {
    await navigator.clipboard.writeText(state.code);
    showNotice("success", "Connection code copied.");
  } catch (error) {
    console.error("Clipboard access failed:", error);

    showNotice(
      "error",
      "Unable to copy automatically. Select and copy the displayed code manually."
    );
  }
}

function setupNavigation() {
  document.querySelectorAll(".nav-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const targetId = button.dataset.target;

      document.querySelectorAll(".section").forEach((section) => {
        section.classList.toggle("active", section.id === targetId);
      });

      document.querySelectorAll(".nav-btn").forEach((navButton) => {
        navButton.classList.toggle("active", navButton === button);
      });

      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

function setupEvents() {
  $("logoutButton").addEventListener("click", async () => {
    try {
      stopListeners();
      stopCodeTimer();
      await signOut(auth);
      window.location.href = "login.html";
    } catch (error) {
      console.error("Logout failed:", error);
      showNotice("error", "Unable to log out. Please try again.");
    }
  });

  $("generateConnectionCode").addEventListener(
    "click",
    generateConnectionCode
  );

  $("copyConnectionCode").addEventListener(
    "click",
    copyConnectionCode
  );

  $("hideConnectionCode").addEventListener(
    "click",
    hideConnectionCode
  );

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-dose-action]");

    if (!button) return;

    recordDose(
      button.dataset.reminderId,
      button.dataset.doseDate,
      button.dataset.doseAction
    );
  });

  window.addEventListener("beforeunload", () => {
    stopListeners();
    stopCodeTimer();
  });
}

setupNavigation();
setupEvents();

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    stopListeners();
    stopCodeTimer();
    window.location.href = "login.html";
    return;
  }

  await startPatientDashboard(user);
});
