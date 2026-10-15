
import { auth, db } from "./firebaseConfig.js";

import {
  onAuthStateChanged,
  signOut,
  updateProfile,
  updateEmail,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
  ref,
  get,
  push,
  set,
  update,
  remove,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const $ = id => document.getElementById(id);

let currentUser = null;
let userData = {};
let medicines = {};
let reminders = {};
let historyRecords = {};
let isSavingMedicine = false;
let isSavingReminder = false;
let notificationItems = [];

const LOW_STOCK_LIMIT = 5;

function showMessage(id, message, type = "error") {
  const el = $(id);
  if (!el) return;
  el.textContent = message;
  el.className = `message show ${type}`;
}

function clearMessage(id) {
  const el = $(id);
  if (!el) return;
  el.textContent = "";
  el.className = "message";
}

function showPageMessage(message, type = "error") {
  showMessage("pageMessage", message, type);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function userPath(section) {
  return `users/${currentUser.uid}/${section}`;
}

function normalizeRole(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function makeElement(tag, className = "", text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function formatDate(dateString) {
  if (!dateString) return "No date selected";

  const [year, month, day] = String(dateString).split("-").map(Number);

  if (!year || !month || !day) return String(dateString);

  return new Date(year, month - 1, day).toLocaleDateString("en-PH", {
    month: "long",
    day: "numeric",
    year: "numeric"
  });
}

function formatDateTime(timestamp) {
  if (!timestamp) return "Time unavailable";

  return new Date(timestamp).toLocaleString("en-PH", {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function formatTime(timeString) {
  if (!timeString || !/^\d{2}:\d{2}$/.test(timeString)) {
    return timeString || "No time selected";
  }

  const [hours, minutes] = timeString.split(":").map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);

  return date.toLocaleTimeString("en-PH", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  });
}

function getQuantity(medicine) {
  return Math.max(0, Number(medicine?.quantityRemaining ?? 0) || 0);
}

function getInitialQuantity(medicine) {
  return Math.max(0, Number(medicine?.initialQuantity ?? 0) || 0);
}

function getTakenCount(medicine) {
  return Math.max(0, Number(medicine?.dosesTaken ?? 0) || 0);
}

function getReminderTimestamp(reminder) {
  if (!reminder?.startDate || !reminder?.time) return null;

  const [year, month, day] = reminder.startDate.split("-").map(Number);
  const [hours, minutes] = reminder.time.split(":").map(Number);

  if (![year, month, day, hours, minutes].every(Number.isFinite)) {
    return null;
  }

  return new Date(year, month - 1, day, hours, minutes, 0, 0).getTime();
}

function getMedicineName(id) {
  return medicines[id]?.name || "Medicine";
}

async function saveHistory(action, detail) {
  try {
    const historyRef = push(ref(db, userPath("history")));

    await set(historyRef, {
      action,
      detail,
      createdAt: Date.now()
    });
  } catch (error) {
    console.error("History save error:", error);
  }
}

function injectFeatureStyles() {
  if ($("medminderFeatureStyles")) return;

  const style = document.createElement("style");
  style.id = "medminderFeatureStyles";

  style.textContent = `
    .feature-badge {
      display:inline-flex;
      align-items:center;
      gap:6px;
      border-radius:999px;
      padding:6px 10px;
      font-size:12px;
      font-weight:800;
      background:#e7f4eb;
      color:#175638;
    }

    .notice-card {
      border:1px solid #e0e9e2;
      border-radius:14px;
      background:#fff;
      padding:15px;
      display:flex;
      justify-content:space-between;
      align-items:flex-start;
      gap:12px;
    }

    .notice-card.notice-danger {
      background:#fff8f7;
      border-color:#f4d0cc;
    }

    .notice-card.notice-warning {
      background:#fffaf0;
      border-color:#f1dfb8;
    }

    .notice-card.notice-info {
      background:#f5fbf6;
      border-color:#d6e9da;
    }

    .notice-title { font-weight:800; overflow-wrap:anywhere; }
    .notice-detail {
      color:#718077;
      font-size:13px;
      line-height:1.6;
      margin-top:5px;
      overflow-wrap:anywhere;
    }

    .profile-avatar {
      width:64px;
      height:64px;
      border-radius:20px;
      display:grid;
      place-items:center;
      flex-shrink:0;
      background:#e7f4eb;
      color:#175638;
      font-size:25px;
      font-weight:800;
    }

    .profile-header {
      display:flex;
      align-items:center;
      gap:15px;
      margin-bottom:22px;
    }

    .security-note {
      padding:13px;
      border-radius:12px;
      background:#f2f7f3;
      color:#52675a;
      font-size:13px;
      line-height:1.6;
      margin-top:12px;
    }

    .notification-count {
      display:inline-grid;
      place-items:center;
      min-width:20px;
      height:20px;
      padding:0 5px;
      border-radius:999px;
      background:#b42318;
      color:white;
      font-size:11px;
      font-weight:800;
    }

    @media(max-width:420px) {
      .notice-card { flex-direction:column; }
      .notice-card .record-actions { width:100%; }
      .profile-header { align-items:flex-start; }
    }
  `;

  document.head.appendChild(style);
}

function injectProfileAndNotifications() {
  if ($("profileSection") || $("notificationsSection")) return;

  const main = document.querySelector("main.container");
  const nav = document.querySelector(".nav-inner");

  if (!main || !nav) return;

  const notificationsSection = makeElement("section", "section");
  notificationsSection.id = "notificationsSection";

  notificationsSection.innerHTML = `
    <div class="panel">
      <div class="panel-heading">
        <div>
          <h2>Notifications</h2>
          <p class="muted small">
            Upcoming reminders, missed doses, and medicine stock warnings.
          </p>
        </div>
        <span id="notificationCount" class="feature-badge">0 alerts</span>
      </div>

      <div id="notificationSummary" class="message" role="status"></div>

      <div id="notificationList" class="record-list">
        <div class="empty-state">Checking your medicine schedule...</div>
      </div>

      <p class="security-note">
        Missed-dose alerts are based on your saved reminder times and the
        intake records you enter. Medminder cannot confirm whether you took
        medicine unless you record the intake.
      </p>
    </div>
  `;

  const profileSection = makeElement("section", "section");
  profileSection.id = "profileSection";

  profileSection.innerHTML = `
    <div class="panel">
      <div class="panel-heading">
        <div>
          <h2>My profile</h2>
          <p class="muted small">Edit your personal information.</p>
        </div>
      </div>

      <div class="profile-header">
        <div id="profileAvatar" class="profile-avatar">M</div>
        <div>
          <h3 id="profileDisplayName">Your profile</h3>
          <p id="profileEmailLabel" class="muted small" style="margin:5px 0 0"></p>
        </div>
      </div>

      <div id="profileMessage" class="message" role="status" aria-live="polite"></div>

      <form id="profileForm">
        <div class="form-grid">
          <div class="field">
            <label for="profileFirstName">First name *</label>
            <input id="profileFirstName" maxlength="80" required>
          </div>

          <div class="field">
            <label for="profileLastName">Last name</label>
            <input id="profileLastName" maxlength="80">
          </div>

          <div class="field full">
            <label for="profileEmail">Email address *</label>
            <input id="profileEmail" type="email" maxlength="254" required>
          </div>
        </div>

        <div class="form-actions">
          <button id="saveProfileButton" class="btn btn-primary" type="submit">
            Save profile
          </button>
        </div>
      </form>
    </div>

    <div class="panel">
      <div class="panel-heading">
        <div>
          <h2>Change password</h2>
          <p class="muted small">Choose a strong password for your account.</p>
        </div>
      </div>

      <div id="passwordMessage" class="message" role="status" aria-live="polite"></div>

      <form id="passwordForm">
        <div class="form-grid">
          <div class="field full">
            <label for="currentPassword">Current password *</label>
            <input id="currentPassword" type="password" autocomplete="current-password" required>
          </div>

          <div class="field">
            <label for="newPassword">New password *</label>
            <input id="newPassword" type="password" minlength="8"
              autocomplete="new-password" required>
            <span class="muted small">Use at least 8 characters.</span>
          </div>

          <div class="field">
            <label for="confirmNewPassword">Confirm new password *</label>
            <input id="confirmNewPassword" type="password" minlength="8"
              autocomplete="new-password" required>
          </div>
        </div>

        <div class="form-actions">
          <button id="changePasswordButton" class="btn btn-primary" type="submit">
            Update password
          </button>
        </div>
      </form>

      <div class="security-note">
        For security, Medminder verifies your current password before changing
        your password or email. If Firebase requires a fresh login, sign in
        again and retry.
      </div>
    </div>
  `;

  const historySection = $("historySection");
  main.insertBefore(notificationsSection, historySection);
  main.insertBefore(profileSection, historySection);

  const definitions = [
    ["notificationsSection", "🔔", "Notifications"],
    ["profileSection", "👤", "Profile"]
  ];

  definitions.forEach(([target, icon, label]) => {
    const button = makeElement("button", "nav-btn");
    button.type = "button";
    button.dataset.target = target;

    const iconElement = makeElement("span", "", icon);
    iconElement.setAttribute("aria-hidden", "true");

    const labelElement = makeElement("span", "", label);
    labelElement.style.fontSize = "11px";
    labelElement.style.fontWeight = "700";

    button.append(iconElement, labelElement);
    nav.appendChild(button);
  });

  nav.style.gridTemplateColumns = "repeat(5, minmax(0, 1fr))";

  document.querySelectorAll(".nav-btn").forEach(button => {
    button.addEventListener("click", () => showSection(button.dataset.target));
  });

  $("profileForm").addEventListener("submit", saveProfile);
  $("passwordForm").addEventListener("submit", changePassword);
}

function showSection(sectionId) {
  document.querySelectorAll(".nav-btn").forEach(button => {
    button.classList.toggle("active", button.dataset.target === sectionId);
  });

  document.querySelectorAll(".section").forEach(section => {
    section.classList.toggle("active", section.id === sectionId);
  });

  window.scrollTo({ top: 0, behavior: "smooth" });

  if (sectionId === "notificationsSection") {
    renderNotifications();
  }

  if (sectionId === "profileSection") {
    populateProfile();
  }
}

function setupQuantityInput() {
  const grid = document.querySelector("#addMedicineForm .form-grid");
  if (!grid || $("medicineQuantity")) return;

  const field = makeElement("div", "field");
  const label = makeElement("label", "", "Initial quantity *");
  label.htmlFor = "medicineQuantity";

  const input = document.createElement("input");
  input.id = "medicineQuantity";
  input.name = "medicineQuantity";
  input.type = "number";
  input.min = "1";
  input.max = "100000";
  input.step = "1";
  input.required = true;
  input.placeholder = "e.g. 30 tablets";
  input.inputMode = "numeric";

  field.append(
    label,
    input,
    makeElement("div", "muted small",
      "Enter the number of tablets, capsules, or doses you have.")
  );

  grid.appendChild(field);
}

function setupIntakeSummary() {
  if ($("intakeSummary")) return;

  const stats = document.querySelector(".stats");
  if (!stats) return;

  const panel = makeElement("section", "panel");
  panel.id = "intakeSummary";

  panel.innerHTML = `
    <div class="panel-heading">
      <div>
        <h2>Medicine intake tracker</h2>
        <p class="muted small">Record each dose and track your remaining quantity.</p>
      </div>
      <span aria-hidden="true" style="font-size:28px">💊</span>
    </div>

    <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px">
      <div style="background:#f2f7f3;padding:15px;border-radius:12px">
        <div class="muted small">Total added</div>
        <div id="totalQuantity" style="font-size:24px;font-weight:800;color:#175638">0</div>
      </div>
      <div style="background:#f2f7f3;padding:15px;border-radius:12px">
        <div class="muted small">Intakes recorded</div>
        <div id="totalTaken" style="font-size:24px;font-weight:800;color:#175638">0</div>
      </div>
      <div style="background:#f2f7f3;padding:15px;border-radius:12px">
        <div class="muted small">Remaining</div>
        <div id="totalRemaining" style="font-size:24px;font-weight:800;color:#175638">0</div>
      </div>
    </div>
    <p class="muted small" style="margin-bottom:0">
      The totals are calculated from saved medicine quantities and recorded intakes.
    </p>
  `;

  stats.insertAdjacentElement("afterend", panel);

  const style = document.createElement("style");
  style.textContent = `
    @media(max-width:420px) {
      #intakeSummary > div:nth-child(2) { gap:6px !important; }
      #intakeSummary > div:nth-child(2) > div { padding:10px !important; }
      #intakeSummary > div:nth-child(2) .muted { font-size:11px; }
      #intakeSummary > div:nth-child(2) div[style*="font-size:24px"] {
        font-size:20px !important;
      }
    }
  `;
  document.head.appendChild(style);
}

async function refreshData() {
  if (!currentUser) return;

  const [profileSnapshot, medicineSnapshot, reminderSnapshot, historySnapshot] =
    await Promise.all([
      get(ref(db, `users/${currentUser.uid}`)),
      get(ref(db, userPath("medicines"))),
      get(ref(db, userPath("reminders"))),
      get(ref(db, userPath("history")))
    ]);

  userData = profileSnapshot.exists() ? profileSnapshot.val() : {};
  medicines = medicineSnapshot.exists() ? medicineSnapshot.val() : {};
  reminders = reminderSnapshot.exists() ? reminderSnapshot.val() : {};
  historyRecords = historySnapshot.exists() ? historySnapshot.val() : {};

  renderMedicines();
  renderReminders();
  renderHistory();
  renderSummary();
  renderIntakeSummary();
  renderNotifications();
}

function renderIntakeSummary() {
  let totalQuantity = 0;
  let totalTaken = 0;
  let totalRemaining = 0;

  Object.values(medicines || {}).forEach(medicine => {
    totalQuantity += getInitialQuantity(medicine);
    totalTaken += getTakenCount(medicine);
    totalRemaining += getQuantity(medicine);
  });

  if ($("totalQuantity")) $("totalQuantity").textContent = totalQuantity;
  if ($("totalTaken")) $("totalTaken").textContent = totalTaken;
  if ($("totalRemaining")) $("totalRemaining").textContent = totalRemaining;
}

function renderSummary() {
  const medicineEntries = Object.entries(medicines || {});
  const reminderEntries = Object.entries(reminders || {});

  $("medicineCount").textContent = medicineEntries.length;
  $("reminderCount").textContent = reminderEntries.length;

  const now = Date.now();

  const upcoming = reminderEntries
    .map(([id, reminder]) => ({ id, ...reminder }))
    .filter(reminder => !reminder.takenAt && !reminder.completed)
    .map(reminder => ({ ...reminder, timestamp: getReminderTimestamp(reminder) }))
    .filter(reminder => reminder.timestamp !== null && reminder.timestamp >= now)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (!upcoming.length) {
    $("nextReminder").textContent = "None yet";
    $("nextReminderDetail").textContent = "No upcoming reminders";
    return;
  }

  $("nextReminder").textContent = formatTime(upcoming[0].time);
  $("nextReminderDetail").textContent =
    `${upcoming[0].medicineName || "Medicine"} · ${formatDate(upcoming[0].startDate)}`;
}

function renderMedicines() {
  const container = $("medicineList");
  container.replaceChildren();

  const entries = Object.entries(medicines || {}).sort((a, b) =>
    String(a[1].name || "").localeCompare(String(b[1].name || ""))
  );

  if (!entries.length) {
    container.appendChild(makeElement(
      "div", "empty-state", "No medicines added yet. Select “Add medicine” to get started."
    ));
  }

  for (const [id, medicine] of entries) {
    const record = makeElement("article", "record");
    const main = makeElement("div", "record-main");
    const title = makeElement("div", "record-title", medicine.name || "Unnamed medicine");

    const initial = getInitialQuantity(medicine);
    const remaining = getQuantity(medicine);
    const taken = getTakenCount(medicine);

    const quantityText = initial > 0
      ? `Initial quantity: ${initial}\nIntakes recorded: ${taken}\nRemaining: ${remaining}`
      : "Quantity not set yet. Set your starting quantity to track intake.";

    const details = [
      medicine.dosage ? `Dosage: ${medicine.dosage}` : "",
      medicine.frequency ? `Instructions: ${medicine.frequency}` : "",
      quantityText,
      medicine.notes ? `Notes: ${medicine.notes}` : ""
    ].filter(Boolean);

    const detail = makeElement("div", "record-detail", details.join("\n"));
    const actions = makeElement("div", "record-actions");

    if (initial > 0 && remaining > 0) {
      const takenButton = makeElement("button", "btn btn-primary btn-small", "✓ Mark as taken");
      takenButton.type = "button";

      takenButton.addEventListener("click", async () => {
        if (!confirm(
          `Record one intake of ${medicine.name}? This subtracts 1 from the remaining quantity.`
        )) return;

        takenButton.disabled = true;

        try {
          await recordIntake(id);
        } catch (error) {
          console.error("Intake error:", error);
          showPageMessage("Could not record the intake. Please try again.");
        } finally {
          takenButton.disabled = false;
        }
      });

      actions.appendChild(takenButton);
    }

    const stockButton = makeElement(
      "button",
      "btn btn-secondary btn-small",
      initial > 0 ? "＋ Add stock" : "Set quantity"
    );
    stockButton.type = "button";

    stockButton.addEventListener("click", async () => {
      const input = prompt(
        initial > 0
          ? `How many additional units of ${medicine.name} are you adding?`
          : `What is the starting quantity for ${medicine.name}?`,
        "30"
      );

      if (input === null) return;

      const amount = Number(input);

      if (!Number.isInteger(amount) || amount < 1 || amount > 100000) {
        showPageMessage("Enter a whole number between 1 and 100,000.");
        return;
      }

      stockButton.disabled = true;

      try {
        const medicineRef = ref(db, `${userPath("medicines")}/${id}`);

        const result = await runTransaction(medicineRef, current => {
          if (!current) return;

          const oldInitial = getInitialQuantity(current);
          const oldRemaining = getQuantity(current);

          current.initialQuantity = oldInitial + amount;
          current.quantityRemaining = oldRemaining + amount;
          current.stockUpdatedAt = Date.now();

          return current;
        });

        if (!result.committed) {
          showPageMessage("Could not update the medicine quantity.");
          return;
        }

        await saveHistory("Medicine stock added", `${medicine.name} · ${amount} units added`);
        await refreshData();
        showPageMessage(`Added ${amount} units to ${medicine.name}.`, "success");
      } catch (error) {
        console.error(error);
        showPageMessage("Could not update the quantity. Please try again.");
      } finally {
        stockButton.disabled = false;
      }
    });

    const removeButton = makeElement("button", "btn btn-danger btn-small", "Remove");
    removeButton.type = "button";

    removeButton.addEventListener("click", async () => {
      if (!confirm(
        `Remove ${medicine.name}? Its associated reminders will not be deleted automatically.`
      )) return;

      try {
        await remove(ref(db, `${userPath("medicines")}/${id}`));
        await saveHistory("Medicine removed", medicine.name || "Medicine");
        await refreshData();
        showPageMessage("Medicine removed successfully.", "success");
      } catch (error) {
        console.error(error);
        showPageMessage("Could not remove the medicine. Please try again.");
      }
    });

    actions.append(stockButton, removeButton);
    main.append(title, detail);
    record.append(main, actions);
    container.appendChild(record);
  }

  const selector = $("reminderMedicine");
  const previousValue = selector.value;
  selector.replaceChildren();

  const placeholder = makeElement("option", "", "Choose a medicine");
  placeholder.value = "";
  selector.appendChild(placeholder);

  for (const [id, medicine] of Object.entries(medicines || {})) {
    const option = makeElement("option", "", medicine.name || "Unnamed medicine");
    option.value = id;
    selector.appendChild(option);
  }

  if (medicines[previousValue]) selector.value = previousValue;
}

async function recordIntake(medicineId, reminderId = null) {
  const medicine = medicines[medicineId];

  if (!medicine) {
    showPageMessage("This medicine could not be found.");
    return;
  }

  const medicineRef = ref(db, `${userPath("medicines")}/${medicineId}`);
  const now = Date.now();

  const result = await runTransaction(medicineRef, current => {
    if (!current) return;

    const remaining = getQuantity(current);
    if (remaining < 1) return;

    current.quantityRemaining = remaining - 1;
    current.dosesTaken = getTakenCount(current) + 1;
    current.lastTakenAt = now;

    return current;
  });

  if (!result.committed) {
    showPageMessage("No remaining quantity is available to deduct.");
    await refreshData();
    return;
  }

  let completedReminder = reminderId;

  // If the intake was recorded from a medicine card, match the earliest
  // overdue reminder for the same medicine, if one exists.
  if (!completedReminder) {
    const overdue = Object.entries(reminders)
      .map(([id, reminder]) => ({ id, ...reminder }))
      .filter(reminder =>
        reminder.medicineId === medicineId &&
        !reminder.takenAt &&
        !reminder.completed &&
        getReminderTimestamp(reminder) !== null &&
        getReminderTimestamp(reminder) <= now
      )
      .sort((a, b) => getReminderTimestamp(a) - getReminderTimestamp(b));

    if (overdue.length) completedReminder = overdue[0].id;
  }

  if (completedReminder && reminders[completedReminder]) {
    await update(
      ref(db, `${userPath("reminders")}/${completedReminder}`),
      { completed: true, takenAt: now }
    );
  }

  await saveHistory(
    "Medicine intake recorded",
    `${medicine.name || "Medicine"} · 1 unit recorded · ${formatDateTime(now)}`
  );

  await refreshData();

  showPageMessage(
    `Intake recorded for ${medicine.name}. Remaining quantity: ${getQuantity(result.snapshot.val())}.`,
    "success"
  );
}

function renderReminders() {
  const container = $("reminderList");
  container.replaceChildren();

  const entries = Object.entries(reminders || {}).sort((a, b) =>
    `${a[1].startDate || ""}T${a[1].time || ""}`.localeCompare(
      `${b[1].startDate || ""}T${b[1].time || ""}`
    )
  );

  if (!entries.length) {
    container.appendChild(makeElement(
      "div", "empty-state", "No reminders yet. Open “New reminder” to choose a date and time."
    ));
  }

  for (const [id, reminder] of entries) {
    const record = makeElement("article", "record");
    const main = makeElement("div", "record-main");
    const title = makeElement(
      "div", "record-title", reminder.medicineName || "Medication reminder"
    );

    const timestamp = getReminderTimestamp(reminder);
    const isOverdue = timestamp !== null && timestamp < Date.now() &&
      !reminder.takenAt && !reminder.completed;

    const lines = [
      `📅 ${formatDate(reminder.startDate)}`,
      `🕒 ${formatTime(reminder.time)}`,
      reminder.takenAt || reminder.completed ? "Status: Intake recorded" :
        isOverdue ? "Status: Overdue — intake not recorded" : "Status: Upcoming"
    ];

    if (reminder.notes) lines.push(`Notes: ${reminder.notes}`);

    const detail = makeElement("div", "record-detail", lines.join("\n"));
    const actions = makeElement("div", "record-actions");

    if (!reminder.takenAt && !reminder.completed &&
        timestamp !== null && timestamp <= Date.now() &&
        medicines[reminder.medicineId] &&
        getQuantity(medicines[reminder.medicineId]) > 0) {
      const takenButton = makeElement("button", "btn btn-primary btn-small", "✓ Mark as taken");
      takenButton.type = "button";

      takenButton.addEventListener("click", async () => {
        if (!confirm(
          `Record the intake for ${reminder.medicineName || "this reminder"}?`
        )) return;

        takenButton.disabled = true;

        try {
          await recordIntake(reminder.medicineId, id);
        } catch (error) {
          console.error(error);
          showPageMessage("Could not record this intake. Please try again.");
        } finally {
          takenButton.disabled = false;
        }
      });

      actions.appendChild(takenButton);
    }

    const deleteButton = makeElement("button", "btn btn-danger btn-small", "Remove reminder");
    deleteButton.type = "button";

    deleteButton.addEventListener("click", async () => {
      if (!confirm(`Remove the reminder for ${reminder.medicineName || "this medicine"}?`)) {
        return;
      }

      try {
        await remove(ref(db, `${userPath("reminders")}/${id}`));
        await saveHistory(
          "Reminder removed",
          `${reminder.medicineName || "Medicine"} · ${formatDate(reminder.startDate)} · ${formatTime(reminder.time)}`
        );
        await refreshData();
        showPageMessage("Reminder removed successfully.", "success");
      } catch (error) {
        console.error(error);
        showPageMessage("Could not remove the reminder. Please try again.");
      }
    });

    actions.appendChild(deleteButton);
    main.append(title, detail);
    record.append(main, actions);
    container.appendChild(record);
  }

  renderSummary();
}

function buildNotifications() {
  const items = [];
  const now = Date.now();
  const upcomingWindow = 24 * 60 * 60 * 1000;

  for (const [id, reminder] of Object.entries(reminders || {})) {
    const timestamp = getReminderTimestamp(reminder);
    if (timestamp === null || reminder.takenAt || reminder.completed) continue;

    const name = reminder.medicineName || getMedicineName(reminder.medicineId);
    const detail = `${formatDate(reminder.startDate)} at ${formatTime(reminder.time)}`;

    if (timestamp < now) {
      items.push({
        id: `overdue-${id}`,
        type: "overdue",
        priority: 1,
        title: `Missed reminder: ${name}`,
        detail: `Scheduled for ${detail}. No intake has been recorded for this reminder.`,
        reminderId: id,
        medicineId: reminder.medicineId
      });
    } else if (timestamp - now <= upcomingWindow) {
      items.push({
        id: `upcoming-${id}`,
        type: "upcoming",
        priority: 3,
        title: `Upcoming: ${name}`,
        detail: `Scheduled for ${detail}.`,
        reminderId: id,
        medicineId: reminder.medicineId
      });
    }
  }

  for (const [id, medicine] of Object.entries(medicines || {})) {
    const initial = getInitialQuantity(medicine);
    const remaining = getQuantity(medicine);

    if (initial <= 0) continue;

    if (remaining === 0) {
      items.push({
        id: `empty-${id}`,
        type: "empty-stock",
        priority: 1,
        title: `Out of stock: ${medicine.name || "Medicine"}`,
        detail: "The recorded remaining quantity is zero. Update your stock when you have more.",
        medicineId: id
      });
    } else if (remaining <= LOW_STOCK_LIMIT) {
      items.push({
        id: `low-${id}`,
        type: "low-stock",
        priority: 2,
        title: `Low stock: ${medicine.name || "Medicine"}`,
        detail: `Only ${remaining} unit${remaining === 1 ? "" : "s"} remaining.`,
        medicineId: id
      });
    }
  }

  return items.sort((a, b) => a.priority - b.priority);
}

function renderNotifications() {
  const container = $("notificationList");
  if (!container) return;

  notificationItems = buildNotifications();
  container.replaceChildren();

  const count = notificationItems.length;
  const countLabel = $("notificationCount");

  if (countLabel) {
    countLabel.textContent = `${count} alert${count === 1 ? "" : "s"}`;
  }

  const navButton = document.querySelector(
    '.nav-btn[data-target="notificationsSection"]'
  );

  if (navButton) {
    navButton.replaceChildren();

    const icon = makeElement("span", "", "🔔");
    icon.setAttribute("aria-hidden", "true");

    const labelRow = makeElement("span");
    labelRow.style.display = "flex";
    labelRow.style.alignItems = "center";
    labelRow.style.gap = "4px";
    labelRow.style.fontSize = "11px";
    labelRow.style.fontWeight = "700";

    labelRow.append(
      document.createTextNode("Notifications"),
      ...(count ? [makeElement("span", "notification-count", String(count))] : [])
    );

    navButton.append(icon, labelRow);
  }

  if (!count) {
    container.appendChild(makeElement(
      "div", "empty-state",
      "You're all caught up. No upcoming reminders in the next 24 hours, missed reminders, or stock warnings."
    ));
    return;
  }

  for (const item of notificationItems) {
    const card = makeElement("article", `notice-card ${
      item.type === "overdue" || item.type === "empty-stock"
        ? "notice-danger"
        : item.type === "low-stock"
          ? "notice-warning"
          : "notice-info"
    }`);

    const main = makeElement("div");
    const title = makeElement("div", "notice-title", item.title);
    const detail = makeElement("div", "notice-detail", item.detail);

    main.append(title, detail);

    const actions = makeElement("div", "record-actions");

    if (item.type === "overdue" &&
        item.medicineId &&
        medicines[item.medicineId] &&
        getQuantity(medicines[item.medicineId]) > 0) {
      const takenButton = makeElement("button", "btn btn-primary btn-small", "Mark as taken");
      takenButton.type = "button";

      takenButton.addEventListener("click", async () => {
        if (!confirm(`Record the intake for ${item.title.replace("Missed reminder: ", "")}?`)) {
          return;
        }

        takenButton.disabled = true;

        try {
          await recordIntake(item.medicineId, item.reminderId);
        } catch (error) {
          console.error(error);
          showPageMessage("Could not record the intake. Please try again.");
        } finally {
          takenButton.disabled = false;
        }
      });

      actions.appendChild(takenButton);
    }

    if (item.type === "low-stock" || item.type === "empty-stock") {
      const stockButton = makeElement("button", "btn btn-secondary btn-small", "Update stock");
      stockButton.type = "button";

      stockButton.addEventListener("click", () => {
        showSection("medicinesSection");

        const medicine = medicines[item.medicineId];
        if (!medicine) return;

        const input = prompt(`How many additional units of ${medicine.name} are you adding?`, "30");
        if (input === null) return;

        const amount = Number(input);

        if (!Number.isInteger(amount) || amount < 1 || amount > 100000) {
          showPageMessage("Enter a whole number between 1 and 100,000.");
          return;
        }

        addStock(item.medicineId, amount);
      });

      actions.appendChild(stockButton);
    }

    card.append(main);

    if (actions.childElementCount) card.appendChild(actions);

    container.appendChild(card);
  }
}

async function addStock(medicineId, amount) {
  const medicine = medicines[medicineId];
  if (!medicine) return;

  try {
    const medicineRef = ref(db, `${userPath("medicines")}/${medicineId}`);

    const result = await runTransaction(medicineRef, current => {
      if (!current) return;

      current.initialQuantity = getInitialQuantity(current) + amount;
      current.quantityRemaining = getQuantity(current) + amount;
      current.stockUpdatedAt = Date.now();

      return current;
    });

    if (!result.committed) {
      showPageMessage("Could not update the medicine quantity.");
      return;
    }

    await saveHistory("Medicine stock added", `${medicine.name} · ${amount} units added`);
    await refreshData();
    showPageMessage(`Added ${amount} units to ${medicine.name}.`, "success");
  } catch (error) {
    console.error(error);
    showPageMessage("Could not update the medicine quantity. Please try again.");
  }
}

function renderHistory() {
  const container = $("historyList");
  container.replaceChildren();

  const entries = Object.entries(historyRecords || {}).sort(
    (a, b) => Number(b[1].createdAt || 0) - Number(a[1].createdAt || 0)
  );

  if (!entries.length) {
    container.appendChild(makeElement(
      "div", "empty-state", "No activity has been recorded yet."
    ));
    return;
  }

  for (const [, item] of entries) {
    const record = makeElement("article", "record");
    const main = makeElement("div", "record-main");
    const title = makeElement("div", "record-title", item.action || "Activity");
    const detail = makeElement("div", "record-detail", item.detail || "");
    const date = makeElement(
      "div",
      "record-detail",
      item.createdAt ? formatDateTime(item.createdAt) : ""
    );

    main.append(title, detail, date);
    record.appendChild(main);
    container.appendChild(record);
  }
}

function populateProfile() {
  if (!currentUser) return;

  const profile = userData.profile || {};
  const firstName = profile.firstName || profile.first_name || "";
  const lastName = profile.lastName || profile.last_name || "";
  const displayName = [firstName, lastName].filter(Boolean).join(" ") ||
    currentUser.displayName ||
    currentUser.email?.split("@")[0] ||
    "Medminder user";

  $("profileFirstName").value = firstName;
  $("profileLastName").value = lastName;
  $("profileEmail").value = currentUser.email || "";

  $("profileDisplayName").textContent = displayName;
  $("profileEmailLabel").textContent = currentUser.email || "";
  $("profileAvatar").textContent = (firstName || displayName).charAt(0).toUpperCase();
}

async function saveProfile(event) {
  event.preventDefault();

  const firstName = $("profileFirstName").value.trim();
  const lastName = $("profileLastName").value.trim();
  const newEmail = $("profileEmail").value.trim();
  const oldEmail = currentUser.email || "";

  clearMessage("profileMessage");

  if (!firstName) {
    showMessage("profileMessage", "Please enter your first name.");
    return;
  }

  if (!newEmail) {
    showMessage("profileMessage", "Please enter your email address.");
    return;
  }

  const button = $("saveProfileButton");
  button.disabled = true;

  try {
    if (newEmail !== oldEmail) {
      const currentPassword = prompt(
        "For security, enter your current password to change your email address."
      );

      if (currentPassword === null) return;

      const credential = EmailAuthProvider.credential(oldEmail, currentPassword);

      await reauthenticateWithCredential(currentUser, credential);
      await updateEmail(currentUser, newEmail);
    }

    const displayName = [firstName, lastName].filter(Boolean).join(" ");

    await updateProfile(currentUser, { displayName });

    const existingProfile = userData.profile || {};
    const updatedProfile = {
      ...existingProfile,
      firstName,
      lastName,
      displayName,
      email: newEmail,
      updatedAt: Date.now()
    };

    await update(ref(db, `users/${currentUser.uid}`), {
      profile: updatedProfile
    });

    userData.profile = updatedProfile;

    $("userLabel").textContent = newEmail;
    $("welcomeTitle").textContent = `Welcome, ${firstName}!`;

    populateProfile();

    await saveHistory("Profile updated", `Profile information updated for ${displayName}.`);

    showMessage("profileMessage", "Your profile has been updated.", "success");
  } catch (error) {
    console.error("Profile update error:", error);

    const messages = {
      "auth/invalid-credential": "The current password is incorrect.",
      "auth/wrong-password": "The current password is incorrect.",
      "auth/requires-recent-login": "Please sign in again before changing your email.",
      "auth/email-already-in-use": "That email address is already in use.",
      "auth/invalid-email": "Please enter a valid email address.",
      "auth/weak-password": "Please choose a stronger password."
    };

    showMessage(
      "profileMessage",
      messages[error.code] ||
        "Could not update your profile. Check your connection and Firebase Authentication settings."
    );
  } finally {
    button.disabled = false;
  }
}

async function changePassword(event) {
  event.preventDefault();

  clearMessage("passwordMessage");

  const currentPassword = $("currentPassword").value;
  const newPassword = $("newPassword").value;
  const confirmPassword = $("confirmNewPassword").value;

  if (newPassword.length < 8) {
    showMessage("passwordMessage", "Your new password must contain at least 8 characters.");
    return;
  }

  if (newPassword !== confirmPassword) {
    showMessage("passwordMessage", "The new passwords do not match.");
    return;
  }

  if (newPassword === currentPassword) {
    showMessage("passwordMessage", "Your new password must be different from your current password.");
    return;
  }

  if (!currentUser.email) {
    showMessage("passwordMessage", "This account does not have an email/password sign-in.");
    return;
  }

  const button = $("changePasswordButton");
  button.disabled = true;

  try {
    const credential = EmailAuthProvider.credential(
      currentUser.email,
      currentPassword
    );

    await reauthenticateWithCredential(currentUser, credential);
    await updatePassword(currentUser, newPassword);

    $("passwordForm").reset();

    await saveHistory("Password changed", "The account password was updated.");

    showMessage("passwordMessage", "Your password has been changed successfully.", "success");
  } catch (error) {
    console.error("Password update error:", error);

    const messages = {
      "auth/invalid-credential": "Your current password is incorrect.",
      "auth/wrong-password": "Your current password is incorrect.",
      "auth/weak-password": "Choose a stronger password.",
      "auth/requires-recent-login": "Please sign in again, then retry changing your password.",
      "auth/too-many-requests": "Too many attempts. Please wait and try again."
    };

    showMessage(
      "passwordMessage",
      messages[error.code] || "Could not change the password. Please try again."
    );
  } finally {
    button.disabled = false;
  }
}

async function loadUserData(user) {
  currentUser = user;
  $("userLabel").textContent = user.email || "Your account";

  try {
    const snapshot = await get(ref(db, `users/${user.uid}`));
    userData = snapshot.exists() ? snapshot.val() : {};

    const profile = userData.profile || {};
    const role = normalizeRole(
      userData.role || profile.role || userData.accountType || profile.accountType
    );

    if (["patient", "medicine_taker"].includes(role)) {
      window.location.replace("patient-dashboard.html");
      return;
    }

    const firstName = profile.firstName || profile.first_name ||
      user.displayName || user.email?.split("@")[0] || "there";

    $("welcomeTitle").textContent = `Welcome, ${firstName}!`;

    injectFeatureStyles();
    injectProfileAndNotifications();
    setupQuantityInput();
    setupIntakeSummary();

    $("loading").style.display = "none";
    $("app").style.display = "block";

    populateProfile();
    await refreshData();
  } catch (error) {
    console.error("Dashboard loading error:", error);

    $("loading").textContent =
      "Unable to load your dashboard. Check your Firebase database rules and connection, then reload the page.";
  }
}

$("addMedicineForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!currentUser || isSavingMedicine) return;

  const name = $("medicineName").value.trim();
  const dosage = $("medicineDosage").value.trim();
  const frequency = $("medicineFrequency").value.trim();
  const notes = $("medicineNotes").value.trim();
  const quantity = Number($("medicineQuantity")?.value);

  if (!name) {
    showPageMessage("Please enter a medicine name.");
    return;
  }

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) {
    showPageMessage("Please enter a valid initial quantity.");
    return;
  }

  isSavingMedicine = true;
  $("saveMedicineButton").disabled = true;
  clearMessage("pageMessage");

  try {
    const medicineRef = push(ref(db, userPath("medicines")));

    await set(medicineRef, {
      name,
      dosage,
      frequency,
      notes,
      initialQuantity: quantity,
      quantityRemaining: quantity,
      dosesTaken: 0,
      createdAt: Date.now()
    });

    await saveHistory("Medicine added", `${name} · Initial quantity: ${quantity}`);

    $("addMedicineForm").reset();
    $("medicineForm").classList.remove("open");

    await refreshData();
    showPageMessage(`${name} saved with ${quantity} units available.`, "success");
  } catch (error) {
    console.error("Medicine save error:", error);
    showPageMessage("Could not save the medicine. Check your Firebase database rules and try again.");
  } finally {
    isSavingMedicine = false;
    $("saveMedicineButton").disabled = false;
  }
});

$("addReminderForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!currentUser || isSavingReminder) return;

  const medicineId = $("reminderMedicine").value;
  const medicine = medicines[medicineId];
  const startDate = $("reminderStartDate").value;
  const time = $("reminderTime").value;
  const notes = $("reminderNotes").value.trim();

  clearMessage("reminderFormMessage");

  if (!medicineId || !medicine) {
    showMessage("reminderFormMessage", "Please add and select a medicine first.");
    return;
  }

  if (!startDate) {
    showMessage("reminderFormMessage", "Please click a date on the calendar.");
    return;
  }

  if (!time || !/^\d{2}:\d{2}$/.test(time)) {
    showMessage("reminderFormMessage", "Please select a valid reminder time.");
    return;
  }

  const [year, month, day] = startDate.split("-").map(Number);
  const selectedDate = new Date(year, month - 1, day);
  selectedDate.setHours(0, 0, 0, 0);

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (selectedDate < today) {
    showMessage("reminderFormMessage", "Please select today or a future date.");
    return;
  }

  const timestamp = getReminderTimestamp({ startDate, time });

  if (timestamp !== null && timestamp < Date.now()) {
    showMessage("reminderFormMessage", "That time has already passed. Please choose a later time.");
    return;
  }

  isSavingReminder = true;
  $("saveReminderButton").disabled = true;

  try {
    const reminderRef = push(ref(db, userPath("reminders")));

    const reminderData = {
      medicineId,
      medicineName: medicine.name || "Medicine",
      time,
      startDate,
      notes,
      completed: false,
      createdAt: Date.now()
    };

    await set(reminderRef, reminderData);

    await saveHistory(
      "Reminder added",
      `${reminderData.medicineName} · ${formatDate(startDate)} · ${formatTime(time)}${notes ? ` · ${notes}` : ""}`
    );

    $("addReminderForm").reset();
    $("reminderForm").classList.remove("open");
    document.dispatchEvent(new CustomEvent("medminder:resetReminderPicker"));

    await refreshData();

    showPageMessage(
      `Reminder saved for ${reminderData.medicineName} on ${formatDate(startDate)} at ${formatTime(time)}.`,
      "success"
    );
  } catch (error) {
    console.error("Reminder save error:", error);
    showMessage("reminderFormMessage", "Could not save the reminder. Check your Firebase database rules and try again.");
  } finally {
    isSavingReminder = false;
    $("saveReminderButton").disabled = false;
  }
});

$("logoutButton").addEventListener("click", async () => {
  try {
    await signOut(auth);
    window.location.replace("login.html");
  } catch (error) {
    console.error("Logout error:", error);
    showPageMessage("Unable to log out. Please try again.");
  }
});

onAuthStateChanged(auth, async user => {
  if (!user) {
    window.location.replace("login.html");
    return;
  }

  await loadUserData(user);
});
