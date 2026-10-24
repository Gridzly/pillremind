
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

const $ = (id) => document.getElementById(id);

const state = {
  user: null,
  profile: {},
  caregiverUid: null,
  medicines: {},
  reminders: {},
  logs: {},
  patientLogUnsubscribe: null,
  caregiverUnsubscribers: [],
  recording: new Set()
};

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function notice(type, message) {
  ["error", "success", "info"].forEach((id) => {
    const el = $(id);
    if (el) {
      el.classList.add("hidden");
      el.textContent = "";
    }
  });

  const el = $(type);
  if (el) {
    el.textContent = message;
    el.classList.remove("hidden");
  }
}

function clearNotices() {
  ["error", "success", "info"].forEach((id) => {
    const el = $(id);
    if (el) {
      el.classList.add("hidden");
      el.textContent = "";
    }
  });
}

function setLoading(loading) {
  if ($("loading")) $("loading").classList.toggle("hidden", !loading);
  if ($("app")) $("app").classList.toggle("ready", !loading);
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
    return days.map((day) => String(day).toLowerCase());
  }

  if (typeof days === "string") {
    return days.split(",").map((day) => day.trim().toLowerCase());
  }

  if (days && typeof days === "object") {
    return Object.keys(days)
      .filter((day) => days[day])
      .map((day) => day.toLowerCase());
  }

  return [];
}

function matchesDays(days, dateString) {
  if (!days.length) return true;

  const fullDay = dayName(dateString);
  const shortDay = fullDay.slice(0, 3);
  const date = new Date(`${dateString}T12:00:00`);
  const numberDay = String(date.getDay());

  return days.some((day) =>
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

  if (id && state.medicines[id]) return state.medicines[id];

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
    </div>`;
}

function renderQRCode(uid) {
  const container = $("patientQrCode");
  if (!container) return;

  container.innerHTML = "";

  if (typeof QRCode === "undefined") {
    container.textContent =
      "QR code could not load. You can still share your patient ID below.";
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

  const initial = name.charAt(0).toUpperCase();

  if ($("welcomeTitle")) {
    $("welcomeTitle").textContent = `Hello, ${name}! 👋`;
  }

  if ($("sideUserName")) $("sideUserName").textContent = name;
  if ($("userAvatar")) $("userAvatar").textContent = initial;

  if ($("headerUserName")) {
    $("headerUserName").textContent = initial;
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

function statusTag(status) {
  const value = String(status || "pending").toLowerCase();

  if (value === "taken") return '<span class="tag green">Taken</span>';
  if (value === "missed") return '<span class="tag orange">Missed</span>';

  return '<span class="tag">Pending</span>';
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

  const instructions = reminder?.notes || reminder?.instructions || "";
  const status = getStatus(id, date);
  const completed = ["taken", "missed"].includes(status);

  return `
    <article class="item">
      <div class="item-icon">💊</div>
      <div class="item-main">
        <h3 class="item-title">${escapeHTML(name)}</h3>
        <p class="item-description">Dosage: ${escapeHTML(dosage)}${instructions
          ? `\nInstructions: ${escapeHTML(instructions)}` : ""}</p>
        <div class="item-meta">${statusTag(status)}</div>
      </div>
      <div class="item-actions">
        <span class="tag">${escapeHTML(formatTime(time))}</span>
        ${completed ? "" : `
          <button class="take-button" type="button"
            data-dose-action="taken"
            data-reminder-id="${escapeHTML(id)}"
            data-dose-date="${escapeHTML(date)}">✓ Taken</button>
          <button class="secondary-button" type="button"
            data-dose-action="missed"
            data-reminder-id="${escapeHTML(id)}"
            data-dose-date="${escapeHTML(date)}">Missed</button>
        `}
      </div>
    </article>`;
}

function renderToday() {
  const date = todayKey();
  const entries = getReminderEntries(date);

  if ($("todayLabel")) {
    $("todayLabel").textContent = new Date().toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
      year: "numeric"
    });
  }

  if ($("todayCount")) $("todayCount").textContent = entries.length;

  if ($("takenCount")) {
    $("takenCount").textContent = entries.filter(
      (entry) => getStatus(entry.id, date) === "taken"
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
      "Medicines shared by your authorized caregiver will appear here."
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
            <h3 class="item-title">${escapeHTML(medicineName(medicine))}</h3>
            <p class="item-description">Dosage: ${escapeHTML(medicineDosage(medicine))}${frequency
              ? `\nSchedule: ${escapeHTML(frequency)}` : ""}${instructions
              ? `\nInstructions: ${escapeHTML(instructions)}` : ""}</p>
          </div>
        </article>`;
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
    $("reminderList").innerHTML = entries.map((entry) => `
      <div>
        <p class="panel-subtitle" style="margin:4px 0 8px;">
          ${escapeHTML(entry.date === today ? "Today" : formatDate(entry.date))}
        </p>
        ${renderReminderCard(entry)}
      </div>`).join("");
  }
}

function renderHistory() {
  const entries = Object.entries(state.logs)
    .filter(([, log]) => log && typeof log === "object")
    .map(([id, log]) => ({ id, ...log }))
    .filter((log) => ["taken", "missed"].includes(
      String(log.status || "").toLowerCase()
    ))
    .sort((a, b) =>
      String(b.recordedAt || "").localeCompare(String(a.recordedAt || ""))
    );

  if (!entries.length) {
    empty("historyList", "No history yet", "Doses you record will appear here.");
    return;
  }

  if ($("historyList")) {
    $("historyList").innerHTML = entries.map((log) => `
      <article class="item">
        <div class="item-icon">${String(log.status).toLowerCase() === "taken" ? "✓" : "◷"}</div>
        <div class="item-main">
          <h3 class="item-title">${escapeHTML(log.medicineName || log.name || "Medicine dose")}</h3>
          <p class="item-description">Date: ${escapeHTML(formatDate(log.date))}
            \nDosage: ${escapeHTML(log.dosage || "Not specified")}
            ${log.recordedAt ? `\nRecorded: ${escapeHTML(new Date(log.recordedAt).toLocaleString())}` : ""}</p>
          <div class="item-meta">${statusTag(log.status)}</div>
        </div>
      </article>`).join("");
  }
}

function renderAll() {
  renderToday();
  renderMedicines();
  renderReminders();
  renderHistory();
}

function stopPatientLogListener() {
  if (state.patientLogUnsubscribe) {
    state.patientLogUnsubscribe();
    state.patientLogUnsubscribe = null;
  }
}

function stopCaregiverListeners() {
  state.caregiverUnsubscribers.forEach((unsubscribe) => {
    try {
      unsubscribe();
    } catch (error) {
      console.warn("Could not stop caregiver listener:", error);
    }
  });

  state.caregiverUnsubscribers = [];
}

function stopAllListeners() {
  stopPatientLogListener();
  stopCaregiverListeners();
}

function listenToPatientLogs(uid) {
  stopPatientLogListener();

  state.patientLogUnsubscribe = onValue(
    ref(db, `users/${uid}/intakeLogs`),
    (snapshot) => {
      state.logs = normalizeCollection(snapshot.val());
      renderAll();
    },
    (error) => {
      console.error("Patient history read failed:", error);
      notice("error", "Unable to load intake history. Check your Firebase Database Rules.");
    }
  );
}

function listenToCaregiverData(uid) {
  stopCaregiverListeners();

  state.caregiverUnsubscribers.push(
    onValue(
      ref(db, `users/${uid}/medicines`),
      (snapshot) => {
        state.medicines = normalizeCollection(snapshot.val());
        renderAll();
      },
      (error) => {
        console.error("Caregiver medicines read failed:", error);
        notice(
          "error",
          "Shared medicines could not be loaded. Confirm that the authorized person connected to your patient ID and that your database rules allow the shared read."
        );
      }
    ),
    onValue(
      ref(db, `users/${uid}/reminders`),
      (snapshot) => {
        state.reminders = normalizeCollection(snapshot.val());
        renderAll();
      },
      (error) => {
        console.error("Caregiver reminders read failed:", error);
        notice(
          "error",
          "Shared reminders could not be loaded. Check the reciprocal connection and Firebase Database Rules."
        );
      }
    )
  );
}

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

async function handleLogout() {
  try {
    stopAllListeners();

    const buttons = [$("sidebarLogout"), $("mobileLogout")].filter(Boolean);
    buttons.forEach((button) => {
      button.disabled = true;
      button.textContent = "Signing out...";
    });

    await signOut(auth);
    window.location.replace("login.html");
  } catch (error) {
    console.error("Sign out failed:", error);

    const buttons = [$("sidebarLogout"), $("mobileLogout")].filter(Boolean);
    buttons.forEach((button) => {
      button.disabled = false;
    });

    if ($("sidebarLogout")) $("sidebarLogout").textContent = "↪ Sign out";
    if ($("mobileLogout")) $("mobileLogout").textContent = "↪ Sign out";

    notice("error", "Unable to sign out. Please try again.");
  }
}

async function recordDose(reminderId, date, status, button) {
  if (!state.user || !state.caregiverUid) {
    notice("error", "Your authorized caregiver has not connected your account yet.");
    return;
  }

  if (!["taken", "missed"].includes(status)) return;

  const reminder = state.reminders[reminderId];

  if (!reminder) {
    notice("error", "This reminder is no longer available.");
    return;
  }

  const key = logKey(reminderId, date);

  if (getLog(reminderId, date)) {
    notice("info", "This dose has already been recorded.");
    return;
  }

  if (state.recording.has(key)) return;

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
      : reminder.dosage || reminder.dose || "Not specified",
    date,
    time: reminderTime(reminder),
    status,
    recordedAt: new Date().toISOString()
  };

  try {
    await set(ref(db, `users/${state.user.uid}/intakeLogs/${key}`), log);

    state.logs[key] = log;
    renderAll();

    notice(
      "success",
      status === "taken" ? "Dose recorded as taken." : "Dose recorded as missed."
    );
  } catch (error) {
    console.error("Saving dose record failed:", error);
    notice("error", "Unable to save this dose. Check your Firebase Database Rules.");

    if (button) button.disabled = false;
  } finally {
    state.recording.delete(key);
  }
}

function setupNavigation() {
  const buttons = document.querySelectorAll(".nav-button[data-page]");

  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      const pageId = button.dataset.page;
      if (!$(pageId)) return;

      document.querySelectorAll(".page").forEach((page) => {
        page.classList.toggle("active", page.id === pageId);
      });

      buttons.forEach((navButton) => {
        navButton.classList.toggle(
          "active",
          navButton.dataset.page === pageId
        );
      });

      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

function setupEvents() {
  $("copyPatientUidButton")?.addEventListener("click", copyPatientUid);

  // The same logout function works on desktop and mobile.
  $("sidebarLogout")?.addEventListener("click", handleLogout);
  $("mobileLogout")?.addEventListener("click", handleLogout);

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-dose-action]");
    if (!button) return;

    recordDose(
      button.dataset.reminderId,
      button.dataset.doseDate,
      button.dataset.doseAction,
      button
    );
  });

  window.addEventListener("beforeunload", stopAllListeners);
}

async function startPatientDashboard(user) {
  stopAllListeners();

  state.user = user;
  state.profile = {};
  state.caregiverUid = null;
  state.medicines = {};
  state.reminders = {};
  state.logs = {};

  setLoading(true);
  clearNotices();

  try {
    const [profileSnapshot, connectionSnapshot] = await Promise.all([
      get(ref(db, `users/${user.uid}/profile`)),
      get(ref(db, `users/${user.uid}/careConnection`))
    ]);

    const profile = profileSnapshot.val() || {};
    state.profile = profile;

    const role = String(profile.role || "").toLowerCase().trim();

    if (!["patient", "medicine taker", "medicine_taker"].includes(role)) {
      setLoading(false);
      notice(
        "error",
        "This page is for patient accounts. Please sign in with your patient account."
      );
      return;
    }

    updateUserDisplay(profile, user);

    const connection = connectionSnapshot.val() || {};
    const caregiverUid = connection.authorizedUid || null;

    setLoading(false);

    if (caregiverUid && caregiverUid !== user.uid) {
      state.caregiverUid = caregiverUid;

      updateConnectionStatus(
        true,
        "Your caregiver ID is saved. Loading your shared medicine schedule..."
      );

      listenToCaregiverData(caregiverUid);
    } else {
      updateConnectionStatus(
        false,
        "Show your QR code or patient ID to your authorized caregiver. They initiate the connection from their dashboard."
      );

      empty(
        "todayList",
        "Waiting for your caregiver",
        "Your medicine schedule will appear here after the accounts are connected."
      );

      empty(
        "medicineList",
        "Waiting for your caregiver",
        "Shared medicines will appear here after connection."
      );

      empty(
        "reminderList",
        "No reminders yet",
        "Shared reminders will appear here after connection."
      );

      renderAll();

      notice(
        "info",
        "Your QR code is ready. Ask your authorized caregiver to scan it from their dashboard."
      );
    }

    listenToPatientLogs(user.uid);
  } catch (error) {
    console.error("Patient dashboard startup failed:", error);
    setLoading(false);

    notice(
      "error",
      "Unable to load your account. Check Firebase configuration, sign-in status, and Database Rules."
    );
  }
}

setupNavigation();
setupEvents();

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    stopAllListeners();
    window.location.replace("login.html");
    return;
  }

  await startPatientDashboard(user);
});
