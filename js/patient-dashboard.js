
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
    const element = $(id);
    if (!element) return;
    element.classList.remove("show");
    element.textContent = "";
  });

  const element = $(type);
  if (!element) return;
  element.textContent = message;
  element.classList.add("show");
}

function clearNotice(type) {
  const element = $(type);
  if (element) {
    element.textContent = "";
    element.classList.remove("show");
  }
}

function setLoading(loading) {
  $("loading").hidden = !loading;
  if (loading) $("app").hidden = true;
}

function stopListeners() {
  state.unsubscribers.forEach((unsubscribe) => {
    try { unsubscribe(); } catch (error) {
      console.warn("Listener cleanup failed:", error);
    }
  });
  state.unsubscribers = [];
}

function stopCodeTimer() {
  if (state.codeTimer) clearInterval(state.codeTimer);
  state.codeTimer = null;
}

function todayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDate(value) {
  if (!value) return "Date not specified";
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: "numeric"
  });
}

function formatTime(value) {
  if (!value) return "Time not set";
  const match = String(value).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return String(value);

  const date = new Date();
  date.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return date.toLocaleTimeString(undefined, {
    hour: "numeric", minute: "2-digit"
  });
}

function normalizeRole(data) {
  return String(
    data?.profile?.role ?? data?.role ?? data?.accountRole ?? ""
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
  return profile.firstName ||
    data?.firstName ||
    user?.displayName?.split(" ")[0] ||
    "there";
}

function showEmpty(containerId, title, message) {
  $(containerId).innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">🌿</div>
      <strong>${escapeHTML(title)}</strong>
      <span>${escapeHTML(message)}</span>
    </div>`;
}

function getConnectedUid(data) {
  return data?.careConnection?.authorizedUid ||
    data?.connection?.authorizedUid ||
    data?.authorizedPersonUid ||
    data?.connectedAuthorizedUid ||
    null;
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

function logKey(reminderId, date) {
  return `${reminderId}_${date}`;
}

function getLog(reminderId, date) {
  return state.logs[logKey(reminderId, date)] || null;
}

function getStatus(reminderId, date) {
  return String(getLog(reminderId, date)?.status || "pending").toLowerCase();
}

function getDayName(dateString) {
  const date = new Date(`${dateString}T12:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  return [
    "Sunday", "Monday", "Tuesday", "Wednesday",
    "Thursday", "Friday", "Saturday"
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

function matchesDay(days, dateString) {
  if (!days.length) return true;

  const date = new Date(`${dateString}T12:00:00`);
  const dayName = getDayName(dateString).toLowerCase();
  const dayNumber = String(date.getDay());

  return days.some((value) => {
    const day = String(value).toLowerCase();
    return day === dayName ||
      day === dayNumber ||
      day.slice(0, 3) === dayName.slice(0, 3);
  });
}

function isReminderScheduled(reminder, dateString) {
  if (reminder?.active === false || reminder?.isActive === false) {
    return false;
  }

  const recurrence = String(
    reminder?.recurrence || reminder?.repeat || reminder?.frequency || "once"
  ).toLowerCase();

  const days = getDaysOfWeek(reminder);
  const startDate = reminderDate(reminder);
  const endDate = reminder?.endDate || "";

  if (startDate && dateString < startDate) return false;
  if (endDate && dateString > endDate) return false;

  if (["daily", "everyday", "every day"].includes(recurrence)) return true;

  if (recurrence === "weekly" || days.length) {
    return matchesDay(days, dateString);
  }

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
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
}

function findMedicine(reminder) {
  const id = reminderMedicineId(reminder);
  if (id && state.medicines[id]) return state.medicines[id];

  if (reminder?.medicine && typeof reminder.medicine === "object") {
    return reminder.medicine;
  }

  const name = reminder?.medicineName || reminder?.name;
  if (name) {
    return { name, dosage: reminder?.dosage || reminder?.dose || "" };
  }
  return null;
}

function statusBadge(status) {
  const value = String(status || "pending").toLowerCase();
  if (value === "taken") return '<span class="badge taken">Taken</span>';
  if (value === "missed") return '<span class="badge missed">Missed</span>';
  return '<span class="badge pending">Pending</span>';
}

function renderReminderCard(entry) {
  const { id, reminder, date, time } = entry;
  const medicine = findMedicine(reminder);
  const name = medicine
    ? medicineName(medicine)
    : reminder?.medicineName || reminder?.name || "Scheduled medicine";
  const dosage = medicine
    ? medicineDosage(medicine)
    : reminder?.dosage || reminder?.dose || "Dosage not specified";
  const notes = reminder?.notes || reminder?.instructions || "";
  const status = getStatus(id, date);
  const completed = ["taken", "missed"].includes(status);

  const actions = completed ? "" : `
    <div class="item-actions">
      <button class="btn small" type="button"
        data-dose-action="taken"
        data-reminder-id="${escapeHTML(id)}"
        data-dose-date="${escapeHTML(date)}">✓ Mark taken</button>
      <button class="btn danger small" type="button"
        data-dose-action="missed"
        data-reminder-id="${escapeHTML(id)}"
        data-dose-date="${escapeHTML(date)}">Mark missed</button>
    </div>`;

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
        ${statusBadge(status)}
      </div>
    </article>`;
}

function renderToday() {
  const date = todayKey();
  const entries = getReminderEntries(date);

  $("todayLabel").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric"
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

  $("todayList").innerHTML = entries.map(renderReminderCard).join("");
}

function renderAllReminders() {
  const today = todayKey();
  const dates = [];

  for (let offset = 0; offset < 7; offset++) {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    dates.push(todayKey(date));
  }

  const entries = dates.flatMap(getReminderEntries);

  if (!entries.length) {
    showEmpty("reminderList", "No upcoming reminders",
      "Your scheduled medicine reminders will appear here.");
    return;
  }

  $("reminderList").innerHTML = entries.map((entry) => `
    <div>
      <p class="small-note">${escapeHTML(
        entry.date === today ? "Today" : formatDate(entry.date)
      )}</p>
      ${renderReminderCard(entry)}
    </div>`).join("");
}

function renderMedicines() {
  const entries = Object.entries(state.medicines)
    .filter(([, medicine]) => isActiveMedicine(medicine));

  $("medicineCount").textContent = entries.length;

  if (!entries.length) {
    showEmpty("medicineList", "No medicines yet",
      state.caregiverUid
        ? "Medicines added by your caregiver will appear here."
        : "Your medicine list will appear once your caregiver is connected.");
    return;
  }

  $("medicineList").innerHTML = entries.map(([, medicine]) => {
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
        <div class="item-side"><span class="badge">Medicine</span></div>
      </article>`;
  }).join("");
}

function renderHistory() {
  const entries = Object.entries(state.logs)
    .filter(([, log]) => log && typeof log === "object")
    .map(([id, log]) => ({ id, ...log }))
    .filter((log) => ["taken", "missed"].includes(
      String(log.status || "").toLowerCase()
    ))
    .sort((a, b) => String(b.recordedAt || "").localeCompare(
      String(a.recordedAt || "")
    ));

  if (!entries.length) {
    showEmpty("historyList", "No history yet",
      "Doses you mark as taken or missed will appear here.");
    return;
  }

  $("historyList").innerHTML = entries.map((log) => `
    <article class="item-card">
      <div class="item-main">
        <h3 class="item-title">${escapeHTML(
          log.medicineName || log.name || "Medicine dose"
        )}</h3>
        <div class="item-details">
          <div>Date: ${escapeHTML(formatDate(log.date))}</div>
          <div>Dosage: ${escapeHTML(log.dosage || "Not specified")}</div>
          ${log.recordedAt ? `<div>Recorded: ${escapeHTML(
            new Date(log.recordedAt).toLocaleString()
          )}</div>` : ""}
        </div>
      </div>
      <div class="item-side">${statusBadge(log.status)}</div>
    </article>`).join("");
}

function renderAll() {
  renderToday();
  renderMedicines();
  renderAllReminders();
  renderHistory();
}

function listenToPatientLogs(uid) {
  const unsubscribe = onValue(
    ref(db, `users/${uid}/intakeLogs`),
    (snapshot) => {
      state.logs = normalizeCollection(snapshot.val());
      renderAll();
    },
    (error) => {
      console.error("Could not read intake history:", error);
      showNotice("error",
        "Unable to load your medicine history. Check your Firebase Database Rules.");
    }
  );
  state.unsubscribers.push(unsubscribe);
}

function listenToCaregiverData(caregiverUid) {
  state.caregiverUid = caregiverUid;

  const unsubscribeMedicines = onValue(
    ref(db, `users/${caregiverUid}/medicines`),
    (snapshot) => {
      state.medicines = normalizeCollection(snapshot.val());
      renderAll();
    },
    (error) => {
      console.error("Caregiver medicine read failed:", error);
      showNotice("error",
        "Firebase denied access to caregiver medicines. Secure cross-account Database Rules are required.");
    }
  );

  const unsubscribeReminders = onValue(
    ref(db, `users/${caregiverUid}/reminders`),
    (snapshot) => {
      state.reminders = normalizeCollection(snapshot.val());
      renderAll();
    },
    (error) => {
      console.error("Caregiver reminder read failed:", error);
      showNotice("error",
        "Unable to read caregiver reminders. Secure cross-account Database Rules are required.");
    }
  );

  state.unsubscribers.push(unsubscribeMedicines, unsubscribeReminders);
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
  ["error", "success", "info"].forEach(clearNotice);

  try {
    const snapshot = await get(ref(db, `users/${user.uid}`));

    if (!snapshot.exists()) {
      showNotice("error",
        "Your user profile was not found. Please finish setting up your Medminder account.");
      setLoading(false);
      return;
    }

    const data = snapshot.val();
    state.patientData = data;
    const role = normalizeRole(data);

    if (!["patient", "medicine taker", "medicine_taker"].includes(role)) {
      showNotice("error",
        "This page is for patient accounts. Please sign in using your patient account.");
      setLoading(false);
      return;
    }

    const name = displayName(data, user);
    $("welcomeTitle").textContent = `Hello, ${name}! 👋`;
    $("headerUserName").textContent = name;
    $("sideUserName").textContent = name;
    $("userAvatar").textContent = name.charAt(0).toUpperCase();

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
      listenToPatientLogs(user.uid);
      renderAll();
      showNotice("info",
        "Connect your patient account to your authorized caregiver to receive their medicine schedule.");
    }
  } catch (error) {
    console.error("Patient dashboard startup failed:", error);
    showNotice("error",
      "Unable to load your account. Check your Firebase configuration and Database Rules.");
    setLoading(false);
  }
}

async function recordDose(reminderId, date, status) {
  if (!state.user || !state.caregiverUid) {
    showNotice("error",
      "Connect your account to your caregiver before recording a scheduled dose.");
    return;
  }

  if (!["taken", "missed"].includes(status)) return;

  const reminder = state.reminders[reminderId];
  if (!reminder) {
    showNotice("error",
      "This reminder is no longer available. Refresh your dashboard.");
    return;
  }

  const existing = getLog(reminderId, date);
  if (existing?.status === "taken" || existing?.status === "missed") {
    showNotice("info", "You have already recorded this dose.");
    return;
  }

  const medicine = findMedicine(reminder);
  const key = logKey(reminderId, date);
  const log = {
    reminderId,
    medicineId: reminderMedicineId(reminder),
    medicineName: medicine
      ? medicineName(medicine)
      : reminder.medicineName || reminder.name || "Scheduled medicine",
    dosage: medicine
      ? medicineDosage(medicine)
      : reminder.dosage || reminder.dose || "Not specified",
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
    await set(ref(db, `users/${state.user.uid}/intakeLogs/${key}`), log);
    state.logs[key] = log;
    renderAll();
    showNotice("success",
      status === "taken" ? "Dose recorded as taken." : "Dose recorded as missed.");
  } catch (error) {
    console.error("Dose recording failed:", error);
    if (button) button.disabled = false;
    showNotice("error",
      "Could not save your dose record. Check your Firebase Database Rules and try again.");
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
      hideConnectionCode();
      $("connectionStatus").textContent =
        "Your connection code has expired. Generate a new one if needed.";
      return;
    }

    updateExpiryText();
  }, 1000);
}

function updateExpiryText() {
  if (!state.codeExpiry) return;
  const remaining = Math.max(0,
    Math.floor((state.codeExpiry - Date.now()) / 1000));
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
      This calls a trusted backend. It will only work after the
      createConnectionCode Cloud Function has been deployed.
      No insecure browser-generated fallback is used.
    */
    const createCode = httpsCallable(functions, "createConnectionCode");
    const result = await createCode({});
    const data = result.data || {};

    if (!data.code || !data.expiresAt) {
      throw new Error("The connection service returned an incomplete response.");
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
    showNotice("success", "Your temporary connection code is ready.");
  } catch (error) {
    console.error("Connection-code generation failed:", error);
    hideConnectionCode();
    $("connectionStatus").textContent =
      "The connection-code service is not available yet.";
    showNotice("error",
      "Could not generate a connection code. The createConnectionCode Firebase Cloud Function must be deployed and configured.");
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
    showNotice("error",
      "Unable to copy automatically. Select and copy the displayed code manually.");
  }
}

function setupNavigation() {
  document.querySelectorAll(".nav-btn[data-target]").forEach((button) => {
    button.addEventListener("click", () => {
      const targetId = button.dataset.target;
      const target = $(targetId);
      if (!target) return;

      document.querySelectorAll(".section").forEach((section) => {
        section.classList.toggle("active", section.id === targetId);
      });

      document.querySelectorAll(".nav-btn[data-target]").forEach((navButton) => {
        navButton.classList.toggle(
          "active", navButton.dataset.target === targetId
        );
      });

      const titles = {
        homeSection: "Patient dashboard",
        remindersSection: "My reminders",
        historySection: "Medicine history"
      };
      $("pageTitle").textContent = titles[targetId] || "Patient dashboard";
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

function setupEvents() {
  async function logout() {
    try {
      stopListeners();
      stopCodeTimer();
      await signOut(auth);
      window.location.href = "login.html";
    } catch (error) {
      console.error("Logout failed:", error);
      showNotice("error", "Unable to log out. Please try again.");
    }
  }

  $("sidebarLogout").addEventListener("click", logout);

  $("generateConnectionCode").addEventListener(
    "click", generateConnectionCode
  );
  $("copyConnectionCode").addEventListener("click", copyConnectionCode);
  $("hideConnectionCode").addEventListener("click", hideConnectionCode);

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
