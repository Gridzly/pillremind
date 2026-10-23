
import { auth, db, functions } from "./firebaseConfig.js";

import {
  httpsCallable
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";

import {
  onAuthStateChanged,
  signOut,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
  updateProfile
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
  ref,
  onValue,
  get,
  push,
  set,
  update,
  remove
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

/* =========================================================
   MEDMINDER — AUTHORIZED PERSON DASHBOARD
   ========================================================= */

const $ = id => document.getElementById(id);

const state = {
  user: null,
  medicines: {},
  reminders: {},
  activities: {},
  unsubscribers: [],
  busy: false,
  initializedUid: null
};

const pages = {
  medicinesPage: ["Medicines", "Manage your medicine records."],
  remindersPage: ["Reminders", "Manage one-time and weekly schedules."],
  refillsPage: ["Refill tracker", "Monitor medicine stock levels."],
  historyPage: ["Activity history", "Review recent changes."],
  connectionPage: ["Patient connection", "Connect to a patient using their code."],
  notificationsPage: ["Notifications", "Review recent activity."],
  profilePage: ["My profile", "Manage your account."]
};

const DAYS = [
  "Sunday", "Monday", "Tuesday", "Wednesday",
  "Thursday", "Friday", "Saturday"
];

const escapeHTML = value =>
  String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);

const accountPath = path => `users/${state.user.uid}/${path}`;

function showMessage(id, text, type = "success") {
  const element = $(id);
  if (!element) return;

  element.textContent = text;
  element.className = `message show${type === "error" ? " error" : ""}`;
}

function hideMessage(id) {
  const element = $(id);
  if (element) element.className = "message";
}

function setButtonBusy(button, busy, busyText = "Please wait…") {
  if (!button) return;

  if (busy) {
    if (!button.dataset.originalText) {
      button.dataset.originalText = button.textContent;
    }

    button.disabled = true;
    button.textContent = busyText;
  } else {
    button.disabled = false;

    if (button.dataset.originalText) {
      button.textContent = button.dataset.originalText;
      delete button.dataset.originalText;
    }
  }
}

function showPage(id) {
  if (!pages[id]) return;

  document.querySelectorAll(".page").forEach(page => {
    page.classList.toggle("active", page.id === id);
  });

  document.querySelectorAll("[data-page]").forEach(button => {
    button.classList.toggle("active", button.dataset.page === id);
  });

  if ($("pageTitle")) $("pageTitle").textContent = pages[id][0];
  if ($("pageSubtitle")) $("pageSubtitle").textContent = pages[id][1];

  const content = document.querySelector(".content");
  if (content) content.scrollTo({ top: 0, behavior: "smooth" });

  hideMessage("pageMessage");
}

function localDate() {
  const now = new Date();

  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ].join("-");
}

function formatDate(value) {
  if (!value) return "Date not set";

  const parts = String(value).split("-").map(Number);

  if (
    parts.length !== 3 ||
    parts.some(Number.isNaN) ||
    parts[0] < 1000 ||
    parts[1] < 1 ||
    parts[1] > 12 ||
    parts[2] < 1 ||
    parts[2] > 31
  ) {
    return "Date not set";
  }

  return new Date(parts[0], parts[1] - 1, parts[2])
    .toLocaleDateString("en-PH", {
      month: "long",
      day: "numeric",
      year: "numeric"
    });
}

function formatTime(value) {
  if (!value || !/^\d{2}:\d{2}$/.test(String(value))) {
    return "Time not set";
  }

  const [hours, minutes] = value.split(":").map(Number);

  if (hours > 23 || minutes > 59) return "Time not set";

  return new Date(2000, 0, 1, hours, minutes)
    .toLocaleTimeString("en-PH", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true
    });
}

function formatStamp(timestamp) {
  const numericTimestamp = Number(timestamp);

  if (!Number.isFinite(numericTimestamp) || numericTimestamp <= 0) {
    return "Time unavailable";
  }

  return new Date(numericTimestamp).toLocaleString("en-PH", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  });
}

function medicineName(id) {
  return state.medicines[id]?.name || "Medicine unavailable";
}

function stopSubscriptions() {
  state.unsubscribers.forEach(unsubscribe => {
    try {
      unsubscribe();
    } catch (error) {
      console.warn("Could not stop Firebase listener:", error);
    }
  });

  state.unsubscribers = [];
}

function subscribe(path, callback) {
  if (!state.user) return;

  const listener = onValue(
    ref(db, accountPath(path)),
    snapshot => callback(snapshot.val() || {}),
    error => {
      console.error(`Firebase error at ${path}:`, error);

      showMessage(
        "pageMessage",
        `Unable to load ${path}. Check your connection and Firebase database rules.`,
        "error"
      );
    }
  );

  state.unsubscribers.push(listener);
}

async function logActivity(action, detail) {
  if (!state.user) return;

  try {
    await set(push(ref(db, accountPath("activity"))), {
      action,
      detail,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error("Could not save activity:", error);
  }
}

function getActivities() {
  return Object.entries(state.activities)
    .map(([id, item]) => ({ id, ...item }))
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
}

/* =========================================================
   MEDICINE, REFILL, REMINDER AND ACTIVITY DISPLAY
   ========================================================= */

function emptyState(text) {
  return `<div class="empty-state">${escapeHTML(text)}</div>`;
}

function dayNames(days) {
  return (Array.isArray(days) ? days : [])
    .map(Number)
    .filter(day => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((a, b) => a - b)
    .map(day => DAYS[day])
    .join(", ");
}

function renderMedicines() {
  const entries = Object.entries(state.medicines);

  if ($("medicineCount")) {
    $("medicineCount").textContent = entries.length;
  }

  if ($("medicineList")) {
    $("medicineList").innerHTML = entries.length
      ? entries.map(([id, medicine]) => {
          const quantity = Number(medicine.quantity ?? 0);
          const refillAt = Number(medicine.refillAt ?? 5);
          const lowStock = quantity <= refillAt;

          return `
            <article class="record">
              <div class="record-main">
                <h3>${escapeHTML(medicine.name || "Unnamed medicine")}</h3>
                <p>Strength: ${escapeHTML(medicine.dosage || "Not provided")}</p>
                <p>Stock: ${quantity} units</p>
                ${lowStock
                  ? '<p style="color:#b42318;font-weight:700">Refill needed</p>'
                  : ""}
                ${medicine.instructions
                  ? `<p>Instructions: ${escapeHTML(medicine.instructions)}</p>`
                  : ""}
                ${medicine.notes
                  ? `<p>Notes: ${escapeHTML(medicine.notes)}</p>`
                  : ""}
                ${medicine.detailsVerified
                  ? '<p style="color:#175638">✓ Details verified</p>'
                  : ""}
              </div>

              <div class="record-actions">
                <button type="button" class="btn btn-secondary"
                  data-edit-med="${escapeHTML(id)}">Edit</button>
                <button type="button" class="btn btn-secondary"
                  data-stock-med="${escapeHTML(id)}">＋ Refill</button>
                <button type="button" class="btn btn-danger"
                  data-del-med="${escapeHTML(id)}">Delete</button>
              </div>
            </article>
          `;
        }).join("")
      : emptyState("No medicines saved yet. Add a medicine to begin.");
  }

  const select = $("reminderMedicine");

  if (select) {
    const previous = select.value;

    select.innerHTML =
      '<option value="">Select a medicine</option>' +
      entries.map(([id, medicine]) =>
        `<option value="${escapeHTML(id)}">${escapeHTML(medicine.name)}</option>`
      ).join("");

    if (state.medicines[previous]) select.value = previous;
  }

  renderRefills();
  renderReminders();
}

function renderRefills() {
  const entries = Object.entries(state.medicines).filter(([, medicine]) =>
    Number(medicine.quantity ?? 0) <= Number(medicine.refillAt ?? 5)
  );

  if ($("refillCount")) $("refillCount").textContent = entries.length;
  if (!$("refillList")) return;

  $("refillList").innerHTML = entries.length
    ? entries.map(([id, medicine]) => `
        <article class="record">
          <div class="record-main">
            <h3>${escapeHTML(medicine.name || "Unnamed medicine")}</h3>
            <p>Remaining: ${Number(medicine.quantity ?? 0)} units</p>
            <p>Refill alert level: ${Number(medicine.refillAt ?? 5)} units</p>
          </div>
          <button type="button" class="btn btn-primary"
            data-stock-med="${escapeHTML(id)}">Record refill</button>
        </article>
      `).join("")
    : emptyState("No medicines currently need refilling.");
}

function renderReminders() {
  const entries = Object.entries(state.reminders).sort((a, b) =>
    String(a[1].time || "").localeCompare(String(b[1].time || ""))
  );

  if ($("reminderCount")) $("reminderCount").textContent = entries.length;
  if (!$("reminderList")) return;

  $("reminderList").innerHTML = entries.length
    ? entries.map(([id, reminder]) => {
        const recurring = reminder.recurrence === "weekly";
        const days = Array.isArray(reminder.daysOfWeek)
          ? reminder.daysOfWeek
          : [];

        return `
          <article class="record">
            <div class="record-main">
              <h3>${escapeHTML(medicineName(reminder.medicineId))}</h3>
              <p>${recurring
                ? `Every week: ${escapeHTML(dayNames(days))}`
                : `Date: ${escapeHTML(formatDate(reminder.date))}`}</p>
              <p>Time: ${escapeHTML(formatTime(reminder.time))}</p>
              ${reminder.dose
                ? `<p>Dose: ${escapeHTML(reminder.dose)}</p>`
                : ""}
              ${reminder.notes
                ? `<p>Notes: ${escapeHTML(reminder.notes)}</p>`
                : ""}
            </div>

            <div class="record-actions">
              <button type="button" class="btn btn-secondary"
                data-edit-rem="${escapeHTML(id)}">Edit</button>
              <button type="button" class="btn btn-danger"
                data-del-rem="${escapeHTML(id)}">Delete</button>
            </div>
          </article>
        `;
      }).join("")
    : emptyState("No reminders created yet.");
}

function renderHistory() {
  const entries = getActivities();

  if ($("historyList")) {
    $("historyList").innerHTML = entries.length
      ? entries.slice(0, 100).map(activity => `
          <article class="record">
            <div class="record-main">
              <h3>${escapeHTML(activity.action || "Activity")}</h3>
              <p>${escapeHTML(activity.detail || "")}</p>
              <p class="muted">${escapeHTML(formatStamp(activity.timestamp))}</p>
            </div>
          </article>
        `).join("")
      : emptyState("No activity history yet.");
  }

  if ($("notificationList")) {
    $("notificationList").innerHTML = entries.length
      ? entries.slice(0, 30).map(activity => `
          <article class="record">
            <div class="record-main">
              <h3>${escapeHTML(activity.action || "Activity")}</h3>
              <p>${escapeHTML(activity.detail || "")}</p>
              <p class="muted">${escapeHTML(formatStamp(activity.timestamp))}</p>
            </div>
          </article>
        `).join("")
      : emptyState("No notifications to display.");
  }
}

/* =========================================================
   MEDICINE FORM
   ========================================================= */

function medicinePanel(open) {
  const panel = $("medicineFormPanel");
  if (panel) panel.hidden = !open;
}

function resetMedicineForm() {
  $("medicineForm")?.reset();

  if ($("medicineId")) $("medicineId").value = "";
  if ($("medicineQuantity")) $("medicineQuantity").value = "0";
  if ($("medicineRefillAt")) $("medicineRefillAt").value = "5";
  if ($("medicineFormTitle")) $("medicineFormTitle").textContent = "Add medicine";

  const button = $("medicineForm")?.querySelector('button[type="submit"]');
  if (button) button.textContent = "Save medicine";

  medicinePanel(false);
}

$("addMedicineButton")?.addEventListener("click", () => {
  resetMedicineForm();
  medicinePanel(true);
  $("medicineName")?.focus();
});

$("cancelMedicineButton")?.addEventListener("click", () => {
  resetMedicineForm();
  hideMessage("pageMessage");
});

$("medicineForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  if (!state.user || state.busy) return;

  const name = $("medicineName")?.value.trim() || "";
  const dosage = $("medicineDosage")?.value.trim() || "";
  const quantity = Number($("medicineQuantity")?.value);
  const refillAt = Number($("medicineRefillAt")?.value ?? 5);
  const verified = $("detailsVerified");

  if (!name || !dosage) {
    showMessage("pageMessage", "Enter the medicine name and strength/dosage.", "error");
    return;
  }

  if (
    !Number.isInteger(quantity) || quantity < 0 || quantity > 100000 ||
    !Number.isInteger(refillAt) || refillAt < 0 || refillAt > 100000
  ) {
    showMessage("pageMessage", "Enter valid whole-number stock quantities.", "error");
    return;
  }

  if (verified && !verified.checked) {
    showMessage(
      "pageMessage",
      "Verify the details against the medicine label or prescription before saving.",
      "error"
    );
    verified.focus();
    return;
  }

  state.busy = true;

  const saveButton = $("medicineForm")?.querySelector('button[type="submit"]');
  setButtonBusy(saveButton, true, "Saving…");

  try {
    const id = $("medicineId")?.value || "";
    const timestamp = Date.now();

    const record = {
      name,
      dosage,
      quantity,
      refillAt,
      instructions: $("medicineInstructions")?.value.trim() || "",
      notes: $("medicineNotes")?.value.trim() || "",
      detailsVerified: Boolean(verified?.checked),
      updatedAt: timestamp
    };

    if (id) {
      await update(ref(db, accountPath(`medicines/${id}`)), record);
    } else {
      record.createdAt = timestamp;
      await set(push(ref(db, accountPath("medicines"))), record);
    }

    await logActivity(id ? "Medicine updated" : "Medicine added", name);

    resetMedicineForm();
    showMessage("pageMessage", "Medicine saved successfully.");
  } catch (error) {
    console.error("Saving medicine failed:", error);
    showMessage("pageMessage", `Unable to save medicine: ${error.message}`, "error");
  } finally {
    state.busy = false;
    setButtonBusy(saveButton, false);
  }
});

$("medicineList")?.addEventListener("click", async event => {
  const edit = event.target.closest("[data-edit-med]");
  const del = event.target.closest("[data-del-med]");
  const stock = event.target.closest("[data-stock-med]");

  if (stock) {
    await recordRefill(stock.dataset.stockMed);
    return;
  }

  if (del) {
    await deleteMedicine(del.dataset.delMed);
    return;
  }

  if (!edit) return;

  const id = edit.dataset.editMed;
  const medicine = state.medicines[id];
  if (!medicine) return;

  $("medicineId").value = id;
  $("medicineName").value = medicine.name || "";
  $("medicineDosage").value = medicine.dosage || "";
  $("medicineQuantity").value = medicine.quantity ?? 0;
  $("medicineRefillAt").value = medicine.refillAt ?? 5;
  $("medicineInstructions").value = medicine.instructions || "";
  $("medicineNotes").value = medicine.notes || "";
  $("detailsVerified").checked = Boolean(medicine.detailsVerified);

  if ($("medicineFormTitle")) $("medicineFormTitle").textContent = "Edit medicine";

  const saveButton = $("medicineForm")?.querySelector('button[type="submit"]');
  if (saveButton) saveButton.textContent = "Update medicine";

  medicinePanel(true);
  $("medicineName")?.focus();
});

$("refillList")?.addEventListener("click", async event => {
  const button = event.target.closest("[data-stock-med]");
  if (button) await recordRefill(button.dataset.stockMed);
});

async function recordRefill(id) {
  const medicine = state.medicines[id];
  if (!medicine || !state.user || state.busy) return;

  const input = prompt(`How many units are being added to ${medicine.name}?`, "30");

  if (input === null) return;

  const amount = Number(input);

  if (!Number.isInteger(amount) || amount <= 0 || amount > 100000) {
    showMessage("pageMessage", "Enter a positive whole number up to 100,000.", "error");
    return;
  }

  const current = Number(medicine.quantity ?? 0);

  if (current + amount > 100000) {
    showMessage("pageMessage", "The resulting stock quantity is too large.", "error");
    return;
  }

  try {
    const newQuantity = current + amount;

    await update(ref(db, accountPath(`medicines/${id}`)), {
      quantity: newQuantity,
      updatedAt: Date.now()
    });

    await logActivity(
      "Medicine refilled",
      `${medicine.name}: added ${amount} units. New stock: ${newQuantity}.`
    );

    showMessage("pageMessage", "Medicine stock updated successfully.");
  } catch (error) {
    console.error(error);
    showMessage("pageMessage", `Unable to record refill: ${error.message}`, "error");
  }
}

async function deleteMedicine(id) {
  const medicine = state.medicines[id];
  if (!medicine || !state.user || state.busy) return;

  if (!confirm(`Delete ${medicine.name} and its associated reminders?`)) return;

  state.busy = true;

  try {
    const changes = {};
    changes[accountPath(`medicines/${id}`)] = null;

    for (const [reminderId, reminder] of Object.entries(state.reminders)) {
      if (reminder.medicineId === id) {
        changes[accountPath(`reminders/${reminderId}`)] = null;
      }
    }

    await update(ref(db), changes);

    await logActivity(
      "Medicine deleted",
      `Deleted ${medicine.name} and its associated reminders.`
    );

    showMessage("pageMessage", "Medicine and associated reminders deleted.");
  } catch (error) {
    console.error(error);
    showMessage("pageMessage", `Unable to delete medicine: ${error.message}`, "error");
  } finally {
    state.busy = false;
  }
}

/* =========================================================
   REMINDER FORM
   ========================================================= */

function reminderPanel(open) {
  const panel = $("reminderFormPanel");
  if (panel) panel.hidden = !open;
}

function updateRecurrenceFields() {
  const weekly = $("reminderRecurrence")?.value === "weekly";

  if ($("reminderDateField")) $("reminderDateField").hidden = weekly;
  if ($("reminderDaysField")) $("reminderDaysField").hidden = !weekly;
  if ($("reminderDate")) $("reminderDate").required = !weekly;

  document.querySelectorAll('input[name="reminderDay"]').forEach(input => {
    input.required = false;
  });
}

function resetReminderForm() {
  $("reminderForm")?.reset();

  if ($("reminderId")) $("reminderId").value = "";
  if ($("reminderRecurrence")) $("reminderRecurrence").value = "once";
  if ($("reminderTime")) $("reminderTime").value = "08:00";
  if ($("reminderDate")) $("reminderDate").value = "";
  if ($("reminderFormTitle")) $("reminderFormTitle").textContent = "Add reminder";

  const saveButton = $("reminderForm")?.querySelector('button[type="submit"]');
  if (saveButton) saveButton.textContent = "Save reminder";

  reminderPanel(false);
  updateRecurrenceFields();
  hideMessage("pageMessage");
}

$("reminderRecurrence")?.addEventListener("change", updateRecurrenceFields);

$("addReminderButton")?.addEventListener("click", () => {
  if (!Object.keys(state.medicines).length) {
    showMessage("pageMessage", "Add a medicine before scheduling reminders.", "error");
    return;
  }

  resetReminderForm();
  reminderPanel(true);
  updateRecurrenceFields();
  $("reminderMedicine")?.focus();
});

$("cancelReminderButton")?.addEventListener("click", resetReminderForm);

$("reminderForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  if (!state.user || state.busy) return;

  const medicineId = $("reminderMedicine")?.value || "";
  const recurrence = $("reminderRecurrence")?.value || "once";
  const date = $("reminderDate")?.value || "";
  const time = $("reminderTime")?.value || "";
  const dose = $("reminderDose")?.value.trim() || "";

  const daysOfWeek = [
    ...document.querySelectorAll('input[name="reminderDay"]:checked')
  ]
    .map(input => Number(input.value))
    .filter(day => Number.isInteger(day) && day >= 0 && day <= 6);

  if (!state.medicines[medicineId]) {
    showMessage("pageMessage", "Choose a valid medicine first.", "error");
    return;
  }

  if (!dose) {
    showMessage("pageMessage", "Enter the prescribed dose for this reminder.", "error");
    return;
  }

  if (!/^\d{2}:\d{2}$/.test(time)) {
    showMessage("pageMessage", "Choose a valid reminder time.", "error");
    return;
  }

  if (recurrence === "once" && (!date || date < localDate())) {
    showMessage("pageMessage", "Choose today or a future date.", "error");
    return;
  }

  if (recurrence === "weekly" && daysOfWeek.length === 0) {
    showMessage("pageMessage", "Select at least one day for the weekly schedule.", "error");
    return;
  }

  state.busy = true;

  const saveButton = $("reminderForm")?.querySelector('button[type="submit"]');
  setButtonBusy(saveButton, true, "Saving…");

  try {
    const id = $("reminderId")?.value || "";
    const timestamp = Date.now();

    const record = {
      medicineId,
      recurrence,
      date: recurrence === "once" ? date : null,
      daysOfWeek: recurrence === "weekly"
        ? [...new Set(daysOfWeek)].sort((a, b) => a - b)
        : [],
      time,
      dose,
      notes: $("reminderNotes")?.value.trim() || "",
      updatedAt: timestamp
    };

    if (id) {
      await update(ref(db, accountPath(`reminders/${id}`)), record);
    } else {
      record.createdAt = timestamp;
      await set(push(ref(db, accountPath("reminders"))), record);
    }

    const scheduleDescription = recurrence === "weekly"
      ? `weekly: ${dayNames(record.daysOfWeek)} at ${formatTime(time)}`
      : `for ${formatDate(date)} at ${formatTime(time)}`;

    await logActivity(
      id ? "Reminder updated" : "Reminder added",
      `${medicineName(medicineId)} — ${scheduleDescription}`
    );

    resetReminderForm();
    showMessage("pageMessage", "Reminder saved successfully.");
  } catch (error) {
    console.error("Saving reminder failed:", error);
    showMessage("pageMessage", `Unable to save reminder: ${error.message}`, "error");
  } finally {
    state.busy = false;
    setButtonBusy(saveButton, false);
  }
});

$("reminderList")?.addEventListener("click", async event => {
  const edit = event.target.closest("[data-edit-rem]");
  const del = event.target.closest("[data-del-rem]");

  if (del) {
    const id = del.dataset.delRem;

    if (!confirm("Delete this reminder?")) return;

    try {
      const reminder = state.reminders[id];
      const name = medicineName(reminder?.medicineId);

      await remove(ref(db, accountPath(`reminders/${id}`)));
      await logActivity("Reminder deleted", `Deleted the reminder for ${name}.`);

      showMessage("pageMessage", "Reminder deleted successfully.");
    } catch (error) {
      console.error(error);
      showMessage("pageMessage", `Unable to delete reminder: ${error.message}`, "error");
    }

    return;
  }

  if (!edit) return;

  const id = edit.dataset.editRem;
  const reminder = state.reminders[id];
  if (!reminder) return;

  showPage("remindersPage");
  reminderPanel(true);

  $("reminderId").value = id;
  $("reminderMedicine").value = reminder.medicineId || "";
  $("reminderRecurrence").value = reminder.recurrence || "once";
  $("reminderDate").value = reminder.date || "";
  $("reminderTime").value = reminder.time || "08:00";
  $("reminderDose").value = reminder.dose || "";
  $("reminderNotes").value = reminder.notes || "";

  const selectedDays = Array.isArray(reminder.daysOfWeek)
    ? reminder.daysOfWeek.map(Number)
    : [];

  document.querySelectorAll('input[name="reminderDay"]').forEach(input => {
    input.checked = selectedDays.includes(Number(input.value));
  });

  updateRecurrenceFields();

  if ($("reminderFormTitle")) $("reminderFormTitle").textContent = "Edit reminder";

  const saveButton = $("reminderForm")?.querySelector('button[type="submit"]');
  if (saveButton) saveButton.textContent = "Update reminder";
});

/* =========================================================
   NAVIGATION
   ========================================================= */

document.querySelectorAll("[data-page]").forEach(button => {
  button.addEventListener("click", () => showPage(button.dataset.page));
});

$("openConnection")?.addEventListener("click", () => showPage("connectionPage"));
$("mobileConnectionButton")?.addEventListener("click", () => showPage("connectionPage"));
$("openNotifications")?.addEventListener("click", () => showPage("notificationsPage"));
$("openProfile")?.addEventListener("click", () => showPage("profilePage"));
$("profileButton")?.addEventListener("click", () => showPage("profilePage"));

/* =========================================================
   PATIENT CONNECTION
   ========================================================= */

$("connectionForm")?.addEventListener("submit", async event => {
  event.preventDefault();

  if (!state.user || !auth.currentUser) {
    showMessage("connectionMessage", "Please sign in again.", "error");
    return;
  }

  const code = $("connectionCode")?.value.trim().toUpperCase() || "";

  if (!code) {
    showMessage("connectionMessage", "Please enter the patient's connection code.", "error");
    return;
  }

  const form = $("connectionForm");
  const submitButton = form.querySelector('button[type="submit"]');

  hideMessage("connectionMessage");
  setButtonBusy(submitButton, true, "Connecting…");

  try {
    // This must match the deployed Firebase Callable Function name and region.
    const redeemConnectionCode = httpsCallable(
      functions,
      "redeemConnectionCode"
    );

    const result = await redeemConnectionCode({ code });

    console.log("Connection response:", result.data);

    showMessage(
      "connectionMessage",
      result.data?.message || "Patient connection processed successfully.",
      "success"
    );

    form.reset();
  } catch (error) {
    console.error("Patient connection failed:", error);

    const messages = {
      "functions/unauthenticated":
        "Your session has expired. Please sign in again.",

      "functions/permission-denied":
        "Only an authorized person can connect to a patient.",

      "functions/invalid-argument":
        "Please enter a valid connection code.",

      "functions/not-found":
        "The code is invalid, expired, or already used. Ask the patient to generate a new code.",

      "functions/already-exists":
        "This patient already has an active caregiver connection.",

      "functions/failed-precondition":
        "The patient or authorized-person profile is missing or has an incorrect role.",

      "functions/unavailable":
        "The connection service is unavailable. Check the Cloud Function deployment and region."
    };

    showMessage(
      "connectionMessage",
      messages[error.code] || error.message || "Unable to connect. Please try again.",
      "error"
    );
  } finally {
    setButtonBusy(submitButton, false);
  }
});

/* =========================================================
   PROFILE
   ========================================================= */

function loadProfileForm(profile = {}) {
  const displayName = state.user?.displayName || "";
  const nameParts = displayName.split(" ");

  if ($("profileFirstName")) {
    $("profileFirstName").value = profile.firstName || nameParts[0] || "";
  }

  if ($("profileLastName")) {
    $("profileLastName").value =
      profile.lastName || nameParts.slice(1).join(" ");
  }

  if ($("profileEmail")) {
    $("profileEmail").textContent = state.user?.email || "";
  }
}

$("profileForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  if (!state.user || state.busy) return;

  const firstName = $("profileFirstName")?.value.trim() || "";
  const lastName = $("profileLastName")?.value.trim() || "";

  if (!firstName) {
    showMessage("profileMessage", "Enter your first name.", "error");
    return;
  }

  const displayName = [firstName, lastName].filter(Boolean).join(" ");
  const submitButton = $("profileForm").querySelector('button[type="submit"]');

  state.busy = true;
  setButtonBusy(submitButton, true, "Saving…");

  try {
    await updateProfile(state.user, { displayName });

    await update(ref(db, accountPath("profile")), {
      firstName,
      lastName,
      displayName,
      email: state.user.email || "",
      updatedAt: Date.now()
    });

    if ($("displayName")) $("displayName").textContent = displayName;
    if ($("avatar")) $("avatar").textContent = firstName[0].toUpperCase();

    await logActivity("Profile updated", "Account profile information updated.");

    showMessage("profileMessage", "Profile updated successfully.");
  } catch (error) {
    console.error("Profile update failed:", error);
    showMessage("profileMessage", `Unable to save your profile: ${error.message}`, "error");
  } finally {
    state.busy = false;
    setButtonBusy(submitButton, false);
  }
});

/* =========================================================
   PASSWORD CHANGE
   ========================================================= */

$("passwordForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  if (!state.user || state.busy) return;

  const current = $("currentPassword")?.value || "";
  const next = $("newPassword")?.value || "";
  const confirmNext = $("confirmPassword")?.value || "";

  if (next.length < 8) {
    showMessage("passwordMessage", "New password must contain at least 8 characters.", "error");
    return;
  }

  if (next !== confirmNext) {
    showMessage("passwordMessage", "New passwords do not match.", "error");
    return;
  }

  if (next === current) {
    showMessage("passwordMessage", "Choose a different password.", "error");
    return;
  }

  if (!state.user.email) {
    showMessage("passwordMessage", "This account has no email address for password verification.", "error");
    return;
  }

  const submitButton = $("passwordForm").querySelector('button[type="submit"]');

  state.busy = true;
  setButtonBusy(submitButton, true, "Updating…");

  try {
    const credential = EmailAuthProvider.credential(state.user.email, current);

    await reauthenticateWithCredential(state.user, credential);
    await updatePassword(state.user, next);

    $("passwordForm").reset();

    await logActivity("Password changed", "Account password updated.");

    showMessage("passwordMessage", "Password updated successfully.");
  } catch (error) {
    console.error("Password change failed:", error);

    const errorText = [
      "auth/invalid-credential",
      "auth/wrong-password",
      "auth/invalid-login-credentials"
    ].includes(error.code)
      ? "Your current password is incorrect."
      : error.code === "auth/requires-recent-login"
        ? "Please sign in again before changing your password."
        : error.code === "auth/weak-password"
          ? "Choose a stronger password."
          : error.message;

    showMessage("passwordMessage", errorText, "error");
  } finally {
    state.busy = false;
    setButtonBusy(submitButton, false);
  }
});

/* =========================================================
   LOGOUT
   ========================================================= */

$("logoutButton")?.addEventListener("click", async () => {
  if (!confirm("Are you sure you want to log out?")) return;

  try {
    stopSubscriptions();
    await signOut(auth);
    window.location.replace("login.html");
  } catch (error) {
    console.error("Logout failed:", error);
    showMessage("pageMessage", `Unable to log out: ${error.message}`, "error");
  }
});

/* =========================================================
   AUTHENTICATION AND DATA LISTENERS
   ========================================================= */

onAuthStateChanged(auth, async authenticatedUser => {
  stopSubscriptions();

  if (!authenticatedUser) {
    state.user = null;
    state.initializedUid = null;
    window.location.replace("login.html");
    return;
  }

  if (state.initializedUid === authenticatedUser.uid) return;

  state.user = authenticatedUser;
  state.initializedUid = authenticatedUser.uid;
  state.medicines = {};
  state.reminders = {};
  state.activities = {};

  try {
    const profileSnapshot = await get(ref(db, accountPath("profile")));
    const profile = profileSnapshot.val() || {};

    const name = authenticatedUser.displayName ||
      profile.displayName ||
      [profile.firstName, profile.lastName].filter(Boolean).join(" ") ||
      "My account";

    if ($("displayName")) $("displayName").textContent = name;
    if ($("avatar")) $("avatar").textContent = name[0].toUpperCase();

    if ($("welcomeTitle")) {
      $("welcomeTitle").textContent = `Welcome, ${name.split(" ")[0]}!`;
    }

    if ($("profileEmail")) {
      $("profileEmail").textContent = authenticatedUser.email || "";
    }

    loadProfileForm(profile);

    subscribe("medicines", value => {
      state.medicines = value;
      renderMedicines();
    });

    subscribe("reminders", value => {
      state.reminders = value;
      renderReminders();
    });

    subscribe("activity", value => {
      state.activities = value;
      renderHistory();
    });

    updateRecurrenceFields();
    showPage("medicinesPage");
  } catch (error) {
    console.error("Dashboard initialization failed:", error);

    showMessage(
      "pageMessage",
      `Unable to initialize the dashboard: ${error.message}`,
      "error"
    );
  }
});

window.addEventListener("beforeunload", stopSubscriptions);
