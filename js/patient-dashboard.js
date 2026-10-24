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

const $ = (id) => document.getElementById(id);

const state = {
  user: null,
  profile: {},
  caregiverUid: null,
  medicines: {},
  reminders: {},
  logs: {},
  unsubscribers: [],
  connecting: false,
  recording: new Set()
};

/* -------------------- HELPERS -------------------- */

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
    element.classList.add("hidden");
    element.textContent = "";
  });

  const element = $(type);
  if (!element) return;

  element.textContent = message;
  element.classList.remove("hidden");
}

function clearNotices() {
  ["error", "success", "info"].forEach((id) => {
    const element = $(id);
    if (!element) return;
    element.classList.add("hidden");
    element.textContent = "";
  });
}

function setLoading(loading) {
  if ($("loading")) $("loading").hidden = !loading;

  if ($("app")) {
    $("app").classList.toggle("ready", !loading);
  }
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

function normalizeCollection(data) {
  if (!data || typeof data !== "object") return {};

  return Object.fromEntries(
    Object.entries(data).filter(([, value]) =>
      value && typeof value === "object"
    )
  );
}

function showEmpty(containerId, title, message) {
  const container = $(containerId);
  if (!container) return;

  container.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">🌿</div>
      <strong>${escapeHTML(title)}</strong>
      <p>${escapeHTML(message)}</p>
    </div>`;
}

function getFirstName(profile, user) {
  return profile?.firstName ||
    profile?.fullName?.trim()?.split(/\s+/)[0] ||
    user?.displayName?.split(/\s+/)[0] ||
    "there";
}

function showConnectionStatus(connected, message) {
  const badge = $("connectionStatusBadge");

  if (badge) {
    badge.textContent = connected ? "Connected" : "Not connected";
    badge.classList.toggle("connected", connected);
  }

  if ($("connectionStatus")) {
    $("connectionStatus").textContent = message;
  }

  if ($("disconnectCaregiverButton")) {
    $("disconnectCaregiverButton").classList.toggle(
      "hidden",
      !connected
    );
  }
}

function updateUserDisplay(profile, user) {
  const name = getFirstName(profile, user);
  const initial = name.charAt(0).toUpperCase();

  if ($("welcomeTitle")) {
    $("welcomeTitle").textContent = `Hello, ${name}! 👋`;
  }

  if ($("sideUserName")) {
    $("sideUserName").textContent = name;
  }

  if ($("userAvatar")) {
    $("userAvatar").textContent = initial;
  }

  if ($("headerUserName")) {
    $("headerUserName").textContent = initial;
    $("headerUserName").title = name;
  }

  if ($("patientUidDisplay")) {
    $("patientUidDisplay").textContent = user.uid;
  }
}

/* -------------------- MEDICINE HELPERS -------------------- */

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
  return String(getLog(reminderId, date)?.status || "pending")
    .toLowerCase();
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

  const dayName = getDayName(dateString).toLowerCase();
  const date = new Date(`${dateString}T12:00:00`);
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

  if (["daily", "everyday", "every day"].includes(recurrence)) {
    return true;
  }

  if (recurrence === "weekly" || days.length > 0) {
    return matchesDay(days, dateString);
  }

  return !startDate || startDate === dateString;
}

function getReminderEntries(dateString) {
  return Object.entries(state.reminders)
    .filter(([, reminder]) =>
      isReminderScheduled(reminder, dateString)
    )
    .map(([id, reminder]) => ({
      id,
      reminder,
      date: dateString,
      time: reminderTime(reminder)
    }))
    .sort((a, b) =>
      String(a.time).localeCompare(String(b.time))
    );
}

function findMedicine(reminder) {
  const id = reminderMedicineId(reminder);

  if (id && state.medicines[id]) {
    return state.medicines[id];
  }

  if (reminder?.medicine &&
      typeof reminder.medicine === "object") {
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

function statusTag(status) {
  const value = String(status || "pending").toLowerCase();

  if (value === "taken") {
    return '<span class="tag green">Taken</span>';
  }

  if (value === "missed") {
    return '<span class="tag orange">Missed</span>';
  }

  return '<span class="tag">Pending</span>';
}

/* -------------------- RENDERING -------------------- */

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

  const actionButtons = completed ? "" : `
    <div class="item-actions">
      <button
        class="take-button"
        type="button"
        data-dose-action="taken"
        data-reminder-id="${escapeHTML(id)}"
        data-dose-date="${escapeHTML(date)}">
        ✓ Taken
      </button>
      <button
        class="secondary-button"
        type="button"
        data-dose-action="missed"
        data-reminder-id="${escapeHTML(id)}"
        data-dose-date="${escapeHTML(date)}">
        Missed
      </button>
    </div>`;

  return `
    <article class="item">
      <div class="item-icon">💊</div>
      <div class="item-main">
        <h3 class="item-title">${escapeHTML(name)}</h3>
        <p class="item-description">
          Dosage: ${escapeHTML(dosage)}
          ${notes ? `\nInstructions: ${escapeHTML(notes)}` : ""}
        </p>
        <div class="item-meta">
          ${statusTag(status)}
        </div>
      </div>
      <div class="item-actions">
        <span class="tag">${escapeHTML(formatTime(time))}</span>
        ${actionButtons}
      </div>
    </article>`;
}

function renderToday() {
  const date = todayKey();
  const entries = getReminderEntries(date);

  if ($("todayLabel")) {
    $("todayLabel").textContent =
      new Date().toLocaleDateString(undefined, {
        weekday: "long",
        month: "short",
        day: "numeric",
        year: "numeric"
      });
  }

  if ($("todayCount")) {
    $("todayCount").textContent = entries.length;
  }

  if ($("takenCount")) {
    $("takenCount").textContent = entries.filter(
      (entry) => getStatus(entry.id, date) === "taken"
    ).length;
  }

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

  if ($("todayList")) {
    $("todayList").innerHTML =
      entries.map(renderReminderCard).join("");
  }
}

function renderMedicines() {
  const entries = Object.entries(state.medicines)
    .filter(([, medicine]) => isActiveMedicine(medicine));

  if ($("medicineCount")) {
    $("medicineCount").textContent = entries.length;
  }

  if (!entries.length) {
    showEmpty(
      "medicineList",
      "No medicines yet",
      state.caregiverUid
        ? "Medicines shared by your caregiver will appear here."
        : "Connect to your caregiver to view your medicines."
    );
    return;
  }

  if ($("medicineList")) {
    $("medicineList").innerHTML = entries.map(([, medicine]) => {
      const notes = medicine.notes || medicine.instructions || "";
      const frequency = medicine.frequency || medicine.recurrence || "";

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
              ${notes ? `\nInstructions: ${escapeHTML(notes)}` : ""}
            </p>
          </div>
        </article>`;
    }).join("");
  }
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
    showEmpty(
      "reminderList",
      "No upcoming reminders",
      "Your upcoming medicine reminders will appear here."
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
      </div>
    `).join("");
  }
}

function renderHistory() {
  const entries = Object.entries(state.logs)
    .filter(([, log]) => log && typeof log === "object")
    .map(([id, log]) => ({ id, ...log }))
    .filter((log) =>
      ["taken", "missed"].includes(String(log.status || "").toLowerCase())
    )
    .sort((a, b) =>
      String(b.recordedAt || "").localeCompare(String(a.recordedAt || ""))
    );

  if (!entries.length) {
    showEmpty(
      "historyList",
      "No history yet",
      "Doses you mark as taken or missed will appear here."
    );
    return;
  }

  if ($("historyList")) {
    $("historyList").innerHTML = entries.map((log) => `
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
  renderAllReminders();
  renderHistory();
}

/* -------------------- DATA LISTENERS -------------------- */

function listenToPatientLogs(uid) {
  const unsubscribe = onValue(
    ref(db, `users/${uid}/intakeLogs`),
    (snapshot) => {
      state.logs = normalizeCollection(snapshot.val());
      renderAll();
    },
    (error) => {
      console.error("Intake history read failed:", error);
      showNotice(
        "error",
        "Unable to load intake history. Please check your Firebase Database Rules."
      );
    }
  );

  state.unsubscribers.push(unsubscribe);
}

function clearCaregiverListeners() {
  stopListeners();
  state.medicines = {};
  state.reminders = {};
}

function listenToCaregiverData(caregiverUid) {
  const unsubscribeMedicines = onValue(
    ref(db, `users/${caregiverUid}/medicines`),
    (snapshot) => {
      state.medicines = normalizeCollection(snapshot.val());
      renderAll();
    },
    (error) => {
      console.error("Caregiver medicine read failed:", error);
      showNotice(
        "error",
        "Cannot read caregiver medicines. Confirm that the caregiver has also connected to your patient UID and that the database rules are published."
      );
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
      showNotice(
        "error",
        "Cannot read caregiver reminders. Confirm the reciprocal connection and Firebase Database Rules."
      );
    }
  );

  state.unsubscribers.push(
    unsubscribeMedicines,
    unsubscribeReminders
  );
}

/* -------------------- CAREGIVER CONNECTION -------------------- */

async function connectCaregiver() {
  if (!state.user || state.connecting) return;

  const input = $("caregiverUidInput");
  const button = $("connectCaregiverButton");
  const caregiverUid = String(input?.value || "").trim();

  if (!caregiverUid) {
    showNotice("error", "Enter the authorized person's Firebase user ID.");
    input?.focus();
    return;
  }

  if (caregiverUid === state.user.uid) {
    showNotice("error", "You cannot connect your account to itself.");
    return;
  }

  if (!/^[A-Za-z0-9_-]{10,128}$/.test(caregiverUid)) {
    showNotice("error", "That user ID does not look valid. Please check it.");
    input?.focus();
    return;
  }

  state.connecting = true;

  if (button) {
    button.disabled = true;
    button.textContent = "Connecting...";
  }

  try {
    /*
      The patient writes only to their own account.
      The caregiver must separately connect back using the patient's UID.
    */
    await set(
      ref(db, `users/${state.user.uid}/careConnection/authorizedUid`),
      caregiverUid
    );

    state.caregiverUid = caregiverUid;
    clearCaregiverListeners();

    listenToCaregiverData(caregiverUid);
    showConnectionStatus(
      true,
      "Your caregiver ID has been saved. The caregiver must also connect back using your patient ID for shared data access."
    );

    renderAll();

    showNotice(
      "success",
      "Caregiver ID saved. Ask your caregiver to enter your patient ID in their dashboard to complete the connection."
    );
  } catch (error) {
    console.error("Saving caregiver connection failed:", error);

    showNotice(
      "error",
      "Unable to save the connection. Check that your Firebase Database Rules allow you to write to your own careConnection."
    );
  } finally {
    state.connecting = false;

    if (button) {
      button.disabled = false;
      button.textContent = "Connect caregiver";
    }
  }
}

async function disconnectCaregiver() {
  if (!state.user || !state.caregiverUid) return;

  const confirmed = window.confirm(
    "Disconnect this caregiver from your patient account?"
  );

  if (!confirmed) return;

  const button = $("disconnectCaregiverButton");

  if (button) button.disabled = true;

  try {
    await remove(
      ref(db, `users/${state.user.uid}/careConnection/authorizedUid`)
    );

    clearCaregiverListeners();

    state.caregiverUid = null;
    renderAll();

    showConnectionStatus(
      false,
      "Your caregiver is disconnected. You can connect again whenever you are ready."
    );

    if ($("caregiverUidInput")) {
      $("caregiverUidInput").value = "";
    }

    showNotice("success", "Caregiver disconnected from your account.");
  } catch (error) {
    console.error("Disconnect failed:", error);

    showNotice(
      "error",
      "Could not disconnect. Check your Firebase Database Rules and try again."
    );
  } finally {
    if (button) button.disabled = false;
  }
}

async function copyPatientUid() {
  if (!state.user) return;

  try {
    await navigator.clipboard.writeText(state.user.uid);
    showNotice(
      "success",
      "Your patient ID has been copied. Send it to your caregiver so they can connect back."
    );
  } catch (error) {
    console.error("Copy failed:", error);

    showNotice(
      "info",
      `Your patient ID is ${state.user.uid}. Select and copy it from the connection panel.`
    );
  }
}

/* -------------------- RECORD A DOSE -------------------- */

async function recordDose(reminderId, date, status, button) {
  if (!state.user || !state.caregiverUid) {
    showNotice("error", "Connect to your caregiver before recording a dose.");
    return;
  }

  if (!["taken", "missed"].includes(status)) return;

  const reminder = state.reminders[reminderId];

  if (!reminder) {
    showNotice("error", "This reminder is no longer available.");
    return;
  }

  const key = logKey(reminderId, date);

  if (getLog(reminderId, date)) {
    showNotice("info", "You have already recorded this dose.");
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

    showNotice(
      "success",
      status === "taken"
        ? "Dose recorded as taken."
        : "Dose recorded as missed."
    );
  } catch (error) {
    console.error("Saving dose record failed:", error);

    showNotice(
      "error",
      "Unable to save your dose record. Check your Firebase Database Rules."
    );

    if (button) button.disabled = false;
  } finally {
    state.recording.delete(key);
  }
}

/* -------------------- NAVIGATION -------------------- */

function setupNavigation() {
  const navButtons = document.querySelectorAll(".nav-button[data-page]");

  navButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const pageId = button.dataset.page;
      if (!$(pageId)) return;

      document.querySelectorAll(".page").forEach((page) => {
        page.classList.toggle("active", page.id === pageId);
      });

      navButtons.forEach((navButton) => {
        navButton.classList.toggle(
          "active",
          navButton.dataset.page === pageId
        );
      });

      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

/* -------------------- EVENTS -------------------- */

function setupEvents() {
  $("connectCaregiverButton")?.addEventListener(
    "click",
    connectCaregiver
  );

  $("copyPatientUidButton")?.addEventListener(
    "click",
    copyPatientUid
  );

  $("disconnectCaregiverButton")?.addEventListener(
    "click",
    disconnectCaregiver
  );

  $("caregiverUidInput")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      connectCaregiver();
    }
  });

  async function logout() {
    try {
      stopListeners();
      await signOut(auth);
      window.location.href = "login.html";
    } catch (error) {
      console.error("Logout failed:", error);
      showNotice("error", "Unable to sign out. Please try again.");
    }
  }

  $("sidebarLogout")?.addEventListener("click", logout);

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

  window.addEventListener("beforeunload", stopListeners);
}

/* -------------------- STARTUP -------------------- */

async function startPatientDashboard(user) {
  stopListeners();

  state.user = user;
  state.profile = {};
  state.caregiverUid = null;
  state.medicines = {};
  state.reminders = {};
  state.logs = {};

  setLoading(true);
  clearNotices();

  try {
    /*
      Read profile and careConnection separately.
      This works with child-level Firebase Database Rules.
    */
    const [profileSnapshot, connectionSnapshot] = await Promise.all([
      get(ref(db, `users/${user.uid}/profile`)),
      get(ref(db, `users/${user.uid}/careConnection`))
    ]);

    const profile = profileSnapshot.val() || {};
    state.profile = profile;

    const role = String(profile.role || "")
      .toLowerCase()
      .trim();

    if (!["patient", "medicine taker", "medicine_taker"].includes(role)) {
      showNotice(
        "error",
        "This page is for patient accounts. Please sign in with your patient account."
      );

      setLoading(false);
      return;
    }

    updateUserDisplay(profile, user);

    const connection = connectionSnapshot.val() || {};
    const caregiverUid = connection.authorizedUid || null;

    if ($("caregiverUidInput")) {
      $("caregiverUidInput").value = caregiverUid || "";
    }

    setLoading(false);

    if (caregiverUid && caregiverUid !== user.uid) {
      state.caregiverUid = caregiverUid;

      showConnectionStatus(
        true,
        "Caregiver ID saved. Loading shared medicines and reminders..."
      );

      listenToCaregiverData(caregiverUid);

      showNotice(
        "info",
        "If the shared schedule does not load, ask your caregiver to connect back using your patient ID."
      );
    } else {
      showConnectionStatus(
        false,
        "Connect to your authorized caregiver to receive your medicine schedule."
      );

      showEmpty(
        "todayList",
        "No reminders for today",
        "Connect with your caregiver to receive your medicine schedule."
      );

      renderAll();

      showNotice(
        "info",
        "To get started, enter your caregiver's Firebase user ID below."
      );
    }

    listenToPatientLogs(user.uid);
  } catch (error) {
    console.error("Patient dashboard startup failed:", error);

    setLoading(false);

    showNotice(
      "error",
      "Unable to load your account. Check your Firebase configuration and Database Rules."
    );
  }
}

setupNavigation();
setupEvents();

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    stopListeners();
    window.location.href = "login.html";
    return;
  }

  await startPatientDashboard(user);
});
