
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
  unsubscribers: [],
  recording: new Set(),
  loggingOut: false
};


function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}


function showNotice(message, type = "info") {
  const notice = $("notice");
  if (!notice) return;

  notice.textContent = message;
  notice.className = `notice show ${type}`;
}


function hideNotice() {
  const notice = $("notice");
  if (!notice) return;

  notice.textContent = "";
  notice.className = "notice";
}


function showLoading() {
  $("loading")?.classList.remove("hidden");
  if ($("app")) $("app").classList.remove("ready");
}


function hideLoading() {
  $("loading")?.classList.add("hidden");
  $("app")?.classList.add("ready");
}


function normalizeCollection(value) {
  if (!value || typeof value !== "object") return [];

  if (Array.isArray(value)) {
    return value
      .map((item, index) => ({
        id: String(index),
        ...(item && typeof item === "object" ? item : {})
      }))
      .filter((item) => item && Object.keys(item).length > 1);
  }

  return Object.entries(value)
    .filter(([, item]) => item && typeof item === "object")
    .map(([id, item]) => ({ id, ...item }));
}


function firstValue(object, keys, fallback = "") {
  for (const key of keys) {
    const value = object?.[key];

    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }

  return fallback;
}


function todayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}


function formatDate(value) {
  if (!value) return "";

  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);

  if (Number.isNaN(date.getTime())) return String(value);

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}


function formatTime(value) {
  if (value === undefined || value === null || value === "") {
    return "Time not specified";
  }

  if (typeof value === "number") {
    if (value >= 0 && value <= 23) {
      return new Date(2000, 0, 1, value, 0)
        .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }

    return String(value);
  }

  const raw = String(value).trim();

  const twelveHour = raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);

  if (twelveHour) {
    return `${Number(twelveHour[1])}:${twelveHour[2]} ${twelveHour[3].toUpperCase()}`;
  }

  const twentyFourHour = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);

  if (twentyFourHour) {
    const hours = Number(twentyFourHour[1]);
    const minutes = Number(twentyFourHour[2]);

    if (hours < 24 && minutes < 60) {
      return new Date(2000, 0, 1, hours, minutes)
        .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }
  }

  return raw;
}


function medicineName(medicine) {
  return firstValue(
    medicine,
    ["name", "medicineName", "medicationName", "medicine", "drugName"],
    "Unnamed medicine"
  );
}


function medicineDosage(medicine) {
  return firstValue(
    medicine,
    ["dosage", "dose", "strength", "quantity"],
    "Follow prescribed instructions"
  );
}


function isActiveMedicine(medicine) {
  if (medicine?.active === false || medicine?.isActive === false) {
    return false;
  }

  const status = String(medicine?.status ?? "").toLowerCase();

  return !["inactive", "archived", "deleted", "discontinued"].includes(status);
}


function reminderMedicineId(reminder) {
  return String(firstValue(
    reminder,
    ["medicineId", "medicationId", "medicine_id", "medication_id"],
    ""
  ));
}


function reminderDate(reminder) {
  return String(firstValue(
    reminder,
    ["date", "scheduledDate", "reminderDate", "day"],
    ""
  )).slice(0, 10);
}


function reminderTime(reminder) {
  return firstValue(
    reminder,
    ["time", "scheduledTime", "reminderTime", "doseTime", "hour"],
    ""
  );
}


function reminderDays(reminder) {
  const value = firstValue(
    reminder,
    ["days", "weekdays", "repeatDays", "recurringDays", "scheduleDays"],
    null
  );

  if (Array.isArray(value)) {
    return value.map((day) => String(day).toLowerCase());
  }

  if (typeof value === "string" && value.trim()) {
    return value.split(/[,;|]/).map((day) => day.trim().toLowerCase());
  }

  if (value && typeof value === "object") {
    return Object.entries(value)
      .filter(([, enabled]) => enabled === true)
      .map(([day]) => day.toLowerCase());
  }

  return [];
}


function matchesDays(reminder, date = new Date()) {
  const days = reminderDays(reminder);

  if (!days.length) return true;

  const weekday = date.toLocaleDateString("en-US", {
    weekday: "long"
  }).toLowerCase();

  const shortWeekday = weekday.slice(0, 3);

  return days.some((day) => {
    const normalized = day.replace(/\.$/, "");

    return normalized === weekday ||
      normalized === shortWeekday ||
      normalized === String(date.getDay());
  });
}


function isScheduled(reminder, date = new Date()) {
  const targetDate = todayKey(date);
  const specificDate = reminderDate(reminder);

  if (specificDate) {
    return specificDate === targetDate;
  }

  const startDate = String(firstValue(
    reminder,
    ["startDate", "start_date", "effectiveDate"],
    ""
  )).slice(0, 10);

  const endDate = String(firstValue(
    reminder,
    ["endDate", "end_date", "untilDate"],
    ""
  )).slice(0, 10);

  if (startDate && targetDate < startDate) return false;
  if (endDate && targetDate > endDate) return false;

  if (reminder.enabled === false || reminder.active === false) return false;

  return matchesDays(reminder, date);
}


function logKey(reminderId, date) {
  return `${reminderId}_${date}`;
}


function getLog(reminderId, date = todayKey()) {
  const logs = state.logs || {};
  const key = logKey(reminderId, date);

  if (logs[key]) return logs[key];

  const found = Object.values(logs).find((log) => {
    if (!log || typeof log !== "object") return false;

    const logReminderId = String(firstValue(
      log,
      ["reminderId", "scheduleId", "doseId"],
      ""
    ));

    const logDate = String(firstValue(
      log,
      ["date", "scheduledDate", "intakeDate"],
      ""
    )).slice(0, 10);

    return logReminderId === String(reminderId) && logDate === date;
  });

  return found || null;
}


function getStatus(reminderId, date = todayKey()) {
  const log = getLog(reminderId, date);

  if (!log) return "upcoming";

  const status = String(firstValue(
    log,
    ["status", "state", "result"],
    ""
  )).toLowerCase();

  if (["taken", "completed", "done"].includes(status)) return "taken";
  if (["missed", "skipped"].includes(status)) return "missed";

  return "upcoming";
}


function getReminderEntries(date = new Date()) {
  const medicines = normalizeCollection(state.medicines)
    .filter(isActiveMedicine);

  const medicineMap = new Map(
    medicines.map((medicine) => [String(medicine.id), medicine])
  );

  const entries = [];

  for (const reminder of normalizeCollection(state.reminders)) {
    if (!isScheduled(reminder, date)) continue;

    const linkedId = reminderMedicineId(reminder);
    const linkedMedicine = medicineMap.get(linkedId);

    const inlineName = firstValue(
      reminder,
      ["medicineName", "medicationName", "name"],
      ""
    );

    // Some projects store all medicine information directly in a reminder.
    const medicine = linkedMedicine || (
      inlineName
        ? {
            name: inlineName,
            dosage: firstValue(reminder, ["dosage", "dose"], "")
          }
        : null
    );

    if (!medicine) continue;

    const id = String(reminder.id);
    const dateKey = todayKey(date);

    entries.push({
      id,
      reminder,
      medicine,
      name: medicineName(medicine),
      dosage: medicineDosage(medicine),
      time: reminderTime(reminder),
      date: dateKey,
      status: getStatus(id, dateKey)
    });
  }

  entries.sort((a, b) => {
    const first = String(a.time || "99:99");
    const second = String(b.time || "99:99");

    return first.localeCompare(second);
  });

  return entries;
}


function findMedicine(id) {
  return normalizeCollection(state.medicines)
    .find((medicine) => String(medicine.id) === String(id)) || null;
}


function empty(message, title = "Nothing to show yet") {
  return `
    <div class="empty-state">
      <div class="empty-icon">💊</div>
      <strong>${escapeHTML(title)}</strong>
      ${escapeHTML(message)}
    </div>
  `;
}


function renderQRCode(uid) {
  const container = $("patientQrCode");
  if (!container) return;

  container.innerHTML = "";

  if (!uid) {
    container.textContent = "Patient ID unavailable.";
    return;
  }

  if (typeof window.QRCode !== "function") {
    container.textContent = "QR code could not load. Check your internet connection.";
    return;
  }

  try {
    new window.QRCode(container, {
      text: uid,
      width: 160,
      height: 160,
      colorDark: "#10442b",
      colorLight: "#ffffff",
      correctLevel: window.QRCode.CorrectLevel.M
    });
  } catch (error) {
    console.error("QR code error:", error);
    container.textContent = "Unable to generate QR code.";
  }
}


function updateUserDisplay(profile, user) {
  const fullName = [
    profile.firstName || profile.first_name || "",
    profile.lastName || profile.last_name || ""
  ].filter(Boolean).join(" ").trim();

  const displayName = firstValue(
    profile,
    ["displayName", "fullName", "name"],
    fullName || user.displayName || "Patient"
  );

  const initial = String(displayName).trim().charAt(0).toUpperCase() || "P";

  $("welcomeTitle").textContent = `Hello, ${displayName.split(" ")[0]}! 👋`;
  $("sideUserName").textContent = displayName;
  $("headerUserName").textContent = displayName;
  $("modalUserName").textContent = displayName;
  $("modalUserEmail").textContent = user.email || "Patient account";

  $("userAvatar").textContent = initial;
  $("sideAvatar").textContent = initial;
  $("modalAvatar").textContent = initial;

  $("patientUidDisplay").textContent = user.uid;
  $("qrPatientId").textContent = user.uid;

  renderQRCode(user.uid);
}


function updateConnectionStatus(connected, message = "") {
  $("connectionTitle").textContent = connected
    ? "Caregiver connected"
    : "Waiting for caregiver";

  $("connectionStatus").textContent = message || (
    connected
      ? "Your caregiver's assigned medicines and reminders are available below."
      : "Ask your authorized caregiver to scan your patient QR code or enter your Patient ID to connect your account."
  );

  $("modalConnectionStatus").textContent = connected
    ? "Connected"
    : "Not connected";
}


function statusTag(status) {
  const labels = {
    taken: ["Taken", "status-taken"],
    missed: ["Missed", "status-missed"],
    upcoming: ["Upcoming", "status-upcoming"]
  };

  const [label, className] = labels[status] || ["Upcoming", "status-neutral"];

  return `<span class="status ${className}">${label}</span>`;
}


function renderReminderCard(entry, includeActions = true) {
  const safeName = escapeHTML(entry.name);
  const safeDosage = escapeHTML(entry.dosage);
  const safeTime = escapeHTML(formatTime(entry.time));
  const safeDate = escapeHTML(formatDate(entry.date));

  const status = entry.status;

  let actionButtons = "";

  if (includeActions && status === "upcoming") {
    actionButtons = `
      <button class="dose-button"
        data-dose-action="taken"
        data-reminder-id="${escapeHTML(entry.id)}"
        type="button">
        ✓ Taken
      </button>
      <button class="dose-button"
        data-dose-action="missed"
        data-reminder-id="${escapeHTML(entry.id)}"
        type="button"
        style="background:#fff0f0;color:#a92e2e">
        Missed
      </button>
    `;
  }

  return `
    <article class="schedule-item">
      <div class="medicine-icon">💊</div>

      <div class="schedule-content">
        <div class="schedule-name">${safeName}</div>
        <div class="schedule-meta">
          ${safeDosage}<br>
          🕒 ${safeTime}<br>
          📅 ${safeDate}
        </div>
      </div>

      <div class="schedule-actions">
        ${statusTag(status)}
        ${actionButtons}
      </div>
    </article>
  `;
}


function renderToday() {
  const entries = getReminderEntries(new Date());
  const total = entries.length;
  const taken = entries.filter((entry) => entry.status === "taken").length;

  $("todayCount").textContent = String(total);
  $("takenCount").textContent = `${taken}/${total}`;
  $("takenCaption").textContent = total
    ? `${Math.round((taken / total) * 100)}% of today's doses recorded`
    : "No scheduled doses yet";

  $("todayBadge").textContent = `${total} ${total === 1 ? "dose" : "doses"}`;

  $("todayLabel").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric"
  });

  $("todayList").innerHTML = entries.length
    ? entries.map((entry) => renderReminderCard(entry, true)).join("")
    : empty(
        "Your assigned caregiver can add medicines and reminders for you.",
        "No medicines scheduled for today"
      );
}


function renderMedicines() {
  const medicines = normalizeCollection(state.medicines)
    .filter(isActiveMedicine);

  $("medicineCount").textContent =
    `${medicines.length} ${medicines.length === 1 ? "medicine" : "medicines"}`;

  if (!medicines.length) {
    $("medicineList").innerHTML = empty(
      "Your assigned medicines will appear here once your caregiver connects your account.",
      "No assigned medicines"
    );
    return;
  }

  $("medicineList").innerHTML = medicines.map((medicine) => {
    const frequency = firstValue(
      medicine,
      ["frequency", "schedule", "timesPerDay"],
      "See assigned reminders"
    );

    const notes = firstValue(
      medicine,
      ["notes", "instructions", "description"],
      ""
    );

    return `
      <article class="schedule-item">
        <div class="medicine-icon">💊</div>

        <div class="schedule-content">
          <div class="schedule-name">${escapeHTML(medicineName(medicine))}</div>
          <div class="schedule-meta">
            ${escapeHTML(medicineDosage(medicine))}<br>
            ${escapeHTML(String(frequency))}
            ${notes ? `<br>${escapeHTML(String(notes))}` : ""}
          </div>
        </div>

        <span class="status status-neutral">Assigned</span>
      </article>
    `;
  }).join("");
}


function renderReminders() {
  const entries = getReminderEntries(new Date());

  $("reminderList").innerHTML = entries.length
    ? entries.map((entry) => renderReminderCard(entry, true)).join("")
    : empty(
        "Your caregiver's scheduled reminders will appear here.",
        "No reminders available for today"
      );
}


function renderHistory() {
  const entries = Object.entries(state.logs || {})
    .filter(([, log]) => log && typeof log === "object")
    .map(([id, log]) => {
      const reminderId = String(firstValue(
        log,
        ["reminderId", "scheduleId", "doseId"],
        id.replace(/_\d{4}-\d{2}-\d{2}$/, "")
      ));

      const medicine = findMedicine(
        firstValue(log, ["medicineId", "medicationId"], "")
      );

      const date = String(firstValue(
        log,
        ["date", "scheduledDate", "intakeDate"],
        ""
      )).slice(0, 10);

      const status = String(firstValue(
        log,
        ["status", "state", "result"],
        "upcoming"
      )).toLowerCase();

      return {
        id,
        log,
        reminderId,
        medicine,
        date,
        status: ["completed", "done"].includes(status)
          ? "taken"
          : ["skipped"].includes(status)
            ? "missed"
            : status
      };
    })
    .sort((a, b) => {
      const dateComparison = String(b.date).localeCompare(String(a.date));
      if (dateComparison !== 0) return dateComparison;

      return String(b.log.time || b.log.timestamp || "")
        .localeCompare(String(a.log.time || a.log.timestamp || ""));
    });

  if (!entries.length) {
    $("historyList").innerHTML = empty(
      "Your dose records will appear here after you record your medicine intake.",
      "No medicine history yet"
    );
    return;
  }

  $("historyList").innerHTML = entries.map((entry) => {
    const name = firstValue(
      entry.log,
      ["medicineName", "medicationName", "name"],
      entry.medicine ? medicineName(entry.medicine) : "Medicine"
    );

    const dosage = firstValue(
      entry.log,
      ["dosage", "dose"],
      entry.medicine ? medicineDosage(entry.medicine) : ""
    );

    return `
      <article class="schedule-item">
        <div class="medicine-icon">📋</div>

        <div class="schedule-content">
          <div class="schedule-name">${escapeHTML(name)}</div>
          <div class="schedule-meta">
            ${escapeHTML(dosage)}<br>
            📅 ${escapeHTML(formatDate(entry.date))}<br>
            ${entry.log.time ? `🕒 ${escapeHTML(formatTime(entry.log.time))}` : ""}
          </div>
        </div>

        ${statusTag(entry.status)}
      </article>
    `;
  }).join("");
}


function renderAll() {
  renderToday();
  renderMedicines();
  renderReminders();
  renderHistory();
}


function stopAllListeners() {
  for (const unsubscribe of state.unsubscribers) {
    try {
      unsubscribe();
    } catch (error) {
      console.warn("Listener cleanup error:", error);
    }
  }

  state.unsubscribers = [];
}


function listenToPatientLogs(uid) {
  const logsReference = ref(db, `users/${uid}/intakeLogs`);

  const unsubscribe = onValue(
    logsReference,
    (snapshot) => {
      state.logs = snapshot.val() || {};
      renderAll();
    },
    (error) => {
      console.error("Patient logs error:", error);
      showNotice(
        "Unable to load your dose history. Check your Firebase database permissions.",
        "error"
      );
    }
  );

  state.unsubscribers.push(unsubscribe);
}


function listenToCaregiverData(uid) {
  const medicinesReference = ref(db, `users/${uid}/medicines`);
  const remindersReference = ref(db, `users/${uid}/reminders`);

  const medicinesUnsubscribe = onValue(
    medicinesReference,
    (snapshot) => {
      state.medicines = snapshot.val() || {};
      renderAll();
    },
    (error) => {
      console.error("Caregiver medicines error:", error);
      showNotice(
        "Your caregiver connection exists, but the medicine list could not be loaded. Check your Firebase database rules.",
        "error"
      );
    }
  );

  const remindersUnsubscribe = onValue(
    remindersReference,
    (snapshot) => {
      state.reminders = snapshot.val() || {};
      renderAll();
    },
    (error) => {
      console.error("Caregiver reminders error:", error);
      showNotice(
        "Unable to load reminders. Check your Firebase database permissions.",
        "error"
      );
    }
  );

  state.unsubscribers.push(medicinesUnsubscribe, remindersUnsubscribe);
}


async function copyPatientUid() {
  const uid = state.user?.uid;

  if (!uid) {
    showNotice("Your Patient ID is not available yet.", "error");
    return;
  }

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(uid);
    } else {
      const input = document.createElement("textarea");
      input.value = uid;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();

      const copied = document.execCommand("copy");
      input.remove();

      if (!copied) throw new Error("Copy command failed");
    }

    showNotice("Patient ID copied successfully.", "success");
  } catch (error) {
    console.error("Copy error:", error);
    showNotice("Unable to copy automatically. You can select your Patient ID in the profile.", "error");
  }
}


async function recordDose(reminderId, date, status, button) {
  if (!state.user || !state.caregiverUid) {
    showNotice(
      "Connect your account to an authorized caregiver before recording a dose.",
      "error"
    );
    return;
  }

  const allowedStatuses = ["taken", "missed"];

  if (!allowedStatuses.includes(status)) return;

  const key = logKey(reminderId, date);

  if (state.recording.has(key)) return;

  const existing = getStatus(reminderId, date);

  if (existing !== "upcoming") {
    showNotice("This dose has already been recorded.", "info");
    return;
  }

  const entry = getReminderEntries(new Date())
    .find((item) => String(item.id) === String(reminderId));

  if (!entry) {
    showNotice("This reminder is no longer available.", "error");
    return;
  }

  state.recording.add(key);

  if (button) button.disabled = true;

  try {
    const logReference = ref(
      db,
      `users/${state.user.uid}/intakeLogs/${key}`
    );

    const log = {
      reminderId: String(reminderId),
      medicineName: entry.name,
      dosage: entry.dosage,
      date,
      time: new Date().toISOString(),
      status,
      recordedBy: state.user.uid
    };

    await set(logReference, log);

    showNotice(
      status === "taken"
        ? "Your medicine intake has been recorded."
        : "Your dose has been marked as missed.",
      status === "taken" ? "success" : "info"
    );
  } catch (error) {
    console.error("Dose recording error:", error);

    showNotice(
      "Unable to save your dose. Check your Firebase database rules and try again.",
      "error"
    );
  } finally {
    state.recording.delete(key);

    if (button) button.disabled = false;
  }
}


function openProfile() {
  const overlay = $("profileOverlay");
  if (!overlay) return;

  overlay.classList.add("open");
  document.body.style.overflow = "hidden";
  $("closeProfile")?.focus();
}


function closeProfile() {
  $("profileOverlay")?.classList.remove("open");
  document.body.style.overflow = "";
}


function setupNavigation() {
  document.querySelectorAll(".nav-button[data-page]").forEach((button) => {
    button.addEventListener("click", () => {
      const targetId = button.dataset.page;
      const target = $(targetId);

      if (!target) return;

      document.querySelectorAll(".page").forEach((page) => {
        page.classList.toggle("active", page.id === targetId);
      });

      document.querySelectorAll(".nav-button[data-page]").forEach((navButton) => {
        navButton.classList.toggle(
          "active",
          navButton.dataset.page === targetId
        );
      });

      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}


async function handleSignOut() {
  if (state.loggingOut) return;

  state.loggingOut = true;

  const logoutButton = $("profileLogout");

  if (logoutButton) {
    logoutButton.disabled = true;
    logoutButton.textContent = "Signing out...";
  }

  try {
    stopAllListeners();

    // Sign out immediately; no confirmation modal.
    await signOut(auth);

    window.location.replace("login.html");
  } catch (error) {
    console.error("Sign-out error:", error);

    state.loggingOut = false;

    if (logoutButton) {
      logoutButton.disabled = false;
      logoutButton.textContent = "↪ Sign out";
    }

    showNotice("Unable to sign out. Please try again.", "error");
    closeProfile();
  }
}


function setupEvents() {
  $("profileTrigger")?.addEventListener("click", openProfile);
  $("sidebarProfile")?.addEventListener("click", openProfile);

  $("closeProfile")?.addEventListener("click", closeProfile);

  $("profileOverlay")?.addEventListener("click", (event) => {
    if (event.target === $("profileOverlay")) {
      closeProfile();
    }
  });

  $("copyPatientUidButton")?.addEventListener("click", copyPatientUid);

  // Direct logout with one tap. No confirmation prompt.
  $("profileLogout")?.addEventListener("click", handleSignOut);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeProfile();
  });

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-dose-action]");
    if (!button) return;

    const status = button.dataset.doseAction;
    const reminderId = button.dataset.reminderId;

    recordDose(reminderId, todayKey(), status, button);
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

  showLoading();
  hideNotice();

  try {
    const profileReference = ref(db, `users/${user.uid}`);
    const profileSnapshot = await get(profileReference);
    const profile = profileSnapshot.val() || {};

    const role = String(
      firstValue(profile, ["role", "userRole", "accountType"], "")
    ).toLowerCase().replace(/[\s-]+/g, "_");

    if (
      role &&
      !["patient", "medicine_taker", "patient_user"].includes(role)
    ) {
      showLoading();
      $("loading").innerHTML = `
        <strong>This account is not registered as a patient.</strong>
        <p style="max-width:340px;text-align:center;line-height:1.6">
          Please sign in using your patient account.
        </p>
        <button id="wrongRoleLogout" class="primary-button" type="button">
          Return to login
        </button>
      `;

      $("wrongRoleLogout").addEventListener("click", handleSignOut);
      return;
    }

    state.profile = profile;
    updateUserDisplay(profile, user);

    const connection = profile.careConnection || {};
    const authorizedUid = firstValue(
      connection,
      ["authorizedUid", "caregiverUid", "caregiverId"],
      ""
    );

    const connected = Boolean(
      authorizedUid && authorizedUid !== user.uid
    );

    state.caregiverUid = connected ? String(authorizedUid) : null;

    updateConnectionStatus(connected);

    hideLoading();

    // Patient intake history belongs to the patient account.
    listenToPatientLogs(user.uid);

    if (connected) {
      listenToCaregiverData(state.caregiverUid);
    } else {
      state.medicines = {};
      state.reminders = {};
      renderAll();

      showNotice(
        "Your account is not connected to an authorized caregiver yet. Show your Patient QR code or ID from your profile to your caregiver.",
        "info"
      );
    }
  } catch (error) {
    console.error("Dashboard loading error:", error);

    hideLoading();

    showNotice(
      "Unable to load your patient dashboard. Please refresh the page and check your Firebase configuration and database permissions.",
      "error"
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
