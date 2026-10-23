
import { auth, db } from "./firebaseConfig.js";

import {
  onAuthStateChanged,
  signOut,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword
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
   MEDMINDER AUTHORIZED PERSON DASHBOARD
   ========================================================= */

const $ = id => document.getElementById(id);

const firstElement = (...ids) =>
  ids.map(id => $(id)).find(element => element !== null) || null;

let user = null;
let medicines = {};
let reminders = {};
let activities = {};
let unsubs = [];
let busy = false;
let authCheckInProgress = false;

const pages = {
  medicinesPage: ["Medicines", "Manage your medicine records."],
  remindersPage: ["Reminders", "Manage one-time and weekly schedules."],
  refillsPage: ["Refill tracker", "Monitor medicine stock levels."],
  historyPage: ["Activity history", "Review recent changes."],
  connectionPage: ["Patient connection", "Connect to a patient using their code."],
  notificationsPage: ["Notifications", "Review recent activity."],
  profilePage: ["My profile", "Manage your account."]
};

const escapeHTML = value =>
  String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);

const accountPath = path => `users/${user.uid}/${path}`;

function message(id, text, type = "success") {
  const element = $(id);
  if (!element) return;

  element.textContent = text;
  element.className = `message show ${type}`;
}

function hideMessage(id) {
  if ($(id)) $(id).className = "message";
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

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function localDate() {
  const date = new Date();

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function formatDate(date) {
  if (!date) return "Date not set";

  const parts = String(date).split("-").map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    return "Date not set";
  }

  return new Date(parts[0], parts[1] - 1, parts[2])
    .toLocaleDateString("en-PH", {
      month: "short",
      day: "numeric",
      year: "numeric"
    });
}

function formatTime(time) {
  if (!time) return "Time not set";

  const [hours, minutes] = String(time).split(":").map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    return "Time not set";
  }

  return `${hours % 12 || 12}:${String(minutes).padStart(2, "0")} ${hours >= 12 ? "PM" : "AM"}`;
}

function formatStamp(timestamp) {
  return new Date(timestamp || Date.now()).toLocaleString("en-PH");
}

function medicineName(id) {
  return medicines[id]?.name || "Medicine unavailable";
}

function stopSubscriptions() {
  unsubs.forEach(unsubscribe => {
    try {
      unsubscribe();
    } catch (error) {
      console.warn("Could not stop a Firebase listener:", error);
    }
  });

  unsubs = [];
}

function subscribe(path, callback) {
  if (!user) return;

  const unsubscribe = onValue(
    ref(db, accountPath(path)),
    snapshot => callback(snapshot.val() || {}),
    error => {
      console.error(`Firebase error at ${path}:`, error);

      message(
        "pageMessage",
        "Unable to load records. Check your internet connection and Firebase database rules.",
        "error"
      );
    }
  );

  unsubs.push(unsubscribe);
}

async function logActivity(action, detail) {
  if (!user) return;

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
  return Object.entries(activities)
    .map(([id, item]) => ({ id, ...item }))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

/* =========================================================
   MEDICINES
   ========================================================= */

function renderMedicines() {
  const entries = Object.entries(medicines);

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
                <div class="record-title">
                  💊 ${escapeHTML(medicine.name)}
                </div>

                <div class="record-detail">
                  ${medicine.dosage
                    ? `Strength: ${escapeHTML(medicine.dosage)}<br>`
                    : ""}
                  ${medicine.instructions
                    ? `Instructions: ${escapeHTML(medicine.instructions)}<br>`
                    : ""}
                  Stock: ${quantity} units
                  ${lowStock
                    ? '<br><strong style="color:#c53d3d">Refill needed</strong>'
                    : ""}
                  ${medicine.notes
                    ? `<br>Notes: ${escapeHTML(medicine.notes)}`
                    : ""}
                  ${medicine.detailsVerified
                    ? '<br><strong style="color:#175638">✓ Details verified</strong>'
                    : ""}
                </div>
              </div>

              <div class="record-actions">
                <button type="button" class="btn secondary small"
                  data-edit-med="${escapeHTML(id)}">Edit</button>
                <button type="button" class="btn secondary small"
                  data-stock-med="${escapeHTML(id)}">＋ Refill</button>
                <button type="button" class="btn danger small"
                  data-del-med="${escapeHTML(id)}">Delete</button>
              </div>
            </article>
          `;
        }).join("")
      : '<div class="empty">No medicines saved yet. Add a medicine to begin.</div>';
  }

  const select = $("reminderMedicine");

  if (select) {
    const previous = select.value;

    select.innerHTML =
      '<option value="">Choose medicine</option>' +
      entries.map(([id, medicine]) => `
        <option value="${escapeHTML(id)}">${escapeHTML(medicine.name)}</option>
      `).join("");

    if (medicines[previous]) select.value = previous;
  }

  renderRefills();
  renderReminders();
}

function renderRefills() {
  const entries = Object.entries(medicines).filter(([, medicine]) =>
    Number(medicine.quantity ?? 0) <= Number(medicine.refillAt ?? 5)
  );

  if ($("refillCount")) {
    $("refillCount").textContent = entries.length;
  }

  if (!$("refillList")) return;

  $("refillList").innerHTML = entries.length
    ? entries.map(([id, medicine]) => `
        <article class="record">
          <div class="record-main">
            <div class="record-title">
              📦 ${escapeHTML(medicine.name)}
            </div>
            <div class="record-detail">
              Remaining: ${Number(medicine.quantity ?? 0)} units
              · Alert level: ${Number(medicine.refillAt ?? 5)} units
            </div>
          </div>
          <button type="button" class="btn small"
            data-stock-med="${escapeHTML(id)}">Record refill</button>
        </article>
      `).join("")
    : '<div class="empty">No medicines currently need refilling.</div>';
}

async function recordRefill(id) {
  const medicine = medicines[id];
  if (!medicine || !user) return;

  const input = prompt(
    `How many units are being added to ${medicine.name}?`,
    "30"
  );

  if (input === null) return;

  const amount = Number(input);

  if (!Number.isInteger(amount) || amount <= 0 || amount > 100000) {
    alert("Enter a positive whole number up to 100,000.");
    return;
  }

  try {
    const newQuantity = Number(medicine.quantity || 0) + amount;

    await update(ref(db, accountPath(`medicines/${id}`)), {
      quantity: newQuantity,
      updatedAt: Date.now()
    });

    await logActivity(
      "Medicine refilled",
      `${medicine.name}: added ${amount} units. New stock: ${newQuantity}.`
    );

    message("pageMessage", "Medicine stock updated successfully.");
  } catch (error) {
    console.error(error);
    alert("Unable to record refill. " + error.message);
  }
}

async function deleteMedicine(id) {
  const medicine = medicines[id];

  if (!medicine || !user) return;
  if (!confirm(`Delete ${medicine.name} and its reminders?`)) return;

  try {
    const changes = {};

    changes[accountPath(`medicines/${id}`)] = null;

    for (const [reminderId, reminder] of Object.entries(reminders)) {
      if (reminder.medicineId === id) {
        changes[accountPath(`reminders/${reminderId}`)] = null;
      }
    }

    await update(ref(db), changes);

    await logActivity("Medicine deleted", medicine.name);
    message("pageMessage", "Medicine and its reminders deleted.");
  } catch (error) {
    console.error(error);
    alert("Unable to delete medicine. " + error.message);
  }
}

function medicinePanel(open) {
  const panel = firstElement("medicineFormPanel", "medicineForm");

  if (panel && panel.tagName !== "FORM") {
    panel.classList.toggle("open", open);
    panel.hidden = !open;
  } else if (panel) {
    panel.classList.toggle("open", open);
  }
}

function resetMedicineForm() {
  const form = firstElement("medicineForm", "medicineFormElement");
  if (form) form.reset();

  const idField = firstElement("medicineId", "medicineEditId");
  if (idField) idField.value = "";

  if ($("medicineQuantity")) $("medicineQuantity").value = "0";
  if ($("medicineRefillAt")) $("medicineRefillAt").value = "5";
  if ($("medicineFormTitle")) $("medicineFormTitle").textContent = "Add medicine";

  const save = $("saveMedicine");
  if (save) save.textContent = "Save medicine";

  const verified = firstElement("detailsVerified", "medicineDetailsVerified");
  if (verified) verified.checked = false;

  medicinePanel(false);
}

firstElement("addMedicineButton", "toggleMedicineForm")
  ?.addEventListener("click", () => {
    resetMedicineForm();
    medicinePanel(true);
  });

firstElement("cancelMedicineButton", "cancelMedicine")
  ?.addEventListener("click", () => {
    resetMedicineForm();
    hideMessage("pageMessage");
  });

firstElement("medicineForm", "medicineFormElement")
  ?.addEventListener("submit", async event => {
    event.preventDefault();

    if (!user || busy) return;

    const name = $("medicineName")?.value.trim() || "";
    const quantity = Number($("medicineQuantity")?.value);
    const refillAt = Number($("medicineRefillAt")?.value);

    const verified = firstElement("detailsVerified", "medicineDetailsVerified");

    if (!name) {
      message("pageMessage", "Enter the medicine name.", "error");
      return;
    }

    if (
      !Number.isInteger(quantity) || quantity < 0 || quantity > 100000 ||
      !Number.isInteger(refillAt) || refillAt < 0 || refillAt > 100000
    ) {
      message("pageMessage", "Enter valid whole-number quantities.", "error");
      return;
    }

    if (verified && !verified.checked) {
      message(
        "pageMessage",
        "Please verify the medicine details before saving.",
        "error"
      );
      verified.focus();
      return;
    }

    busy = true;

    const save = $("saveMedicine");
    if (save) save.disabled = true;

    try {
      const idField = firstElement("medicineId", "medicineEditId");
      const id = idField?.value || "";

      const record = {
        name,
        dosage: $("medicineDosage")?.value.trim() || "",
        quantity,
        refillAt,
        instructions: $("medicineInstructions")?.value.trim() || "",
        notes: $("medicineNotes")?.value.trim() || "",
        detailsVerified: verified ? verified.checked : false,
        updatedAt: Date.now()
      };

      if (id) {
        await update(ref(db, accountPath(`medicines/${id}`)), record);
      } else {
        record.createdAt = Date.now();
        await set(push(ref(db, accountPath("medicines"))), record);
      }

      await logActivity(id ? "Medicine updated" : "Medicine added", name);

      resetMedicineForm();
      message("pageMessage", "Medicine saved successfully.");
    } catch (error) {
      console.error(error);
      message("pageMessage", "Unable to save medicine. Check Firebase rules and connection.", "error");
    } finally {
      busy = false;
      if (save) save.disabled = false;
    }
  });

$("medicineList")?.addEventListener("click", event => {
  const edit = event.target.closest("[data-edit-med]");
  const del = event.target.closest("[data-del-med]");
  const stock = event.target.closest("[data-stock-med]");

  if (stock) {
    recordRefill(stock.dataset.stockMed);
    return;
  }

  if (del) {
    deleteMedicine(del.dataset.delMed);
    return;
  }

  if (!edit) return;

  const id = edit.dataset.editMed;
  const medicine = medicines[id];
  if (!medicine) return;

  const idField = firstElement("medicineId", "medicineEditId");
  if (idField) idField.value = id;

  if ($("medicineName")) $("medicineName").value = medicine.name || "";
  if ($("medicineDosage")) $("medicineDosage").value = medicine.dosage || "";
  if ($("medicineQuantity")) $("medicineQuantity").value = medicine.quantity ?? 0;
  if ($("medicineRefillAt")) $("medicineRefillAt").value = medicine.refillAt ?? 5;
  if ($("medicineInstructions")) $("medicineInstructions").value = medicine.instructions || "";
  if ($("medicineNotes")) $("medicineNotes").value = medicine.notes || "";

  const verified = firstElement("detailsVerified", "medicineDetailsVerified");
  if (verified) verified.checked = false;

  if ($("medicineFormTitle")) $("medicineFormTitle").textContent = "Edit medicine";
  if ($("saveMedicine")) $("saveMedicine").textContent = "Update medicine";

  medicinePanel(true);
});

$("refillList")?.addEventListener("click", event => {
  const button = event.target.closest("[data-stock-med]");
  if (button) recordRefill(button.dataset.stockMed);
});

/* =========================================================
   REMINDERS
   ========================================================= */

function dayNames(days) {
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  return (Array.isArray(days) ? days : [])
    .map(day => names[Number(day)] || "")
    .filter(Boolean)
    .join(", ");
}

function renderReminders() {
  const entries = Object.entries(reminders).sort((a, b) =>
    (a[1].time || "").localeCompare(b[1].time || "")
  );

  if ($("reminderCount")) {
    $("reminderCount").textContent = entries.length;
  }

  if (!$("reminderList")) return;

  $("reminderList").innerHTML = entries.length
    ? entries.map(([id, reminder]) => `
        <article class="record">
          <div class="record-main">
            <div class="record-title">
              🔔 ${escapeHTML(medicineName(reminder.medicineId))}
            </div>
            <div class="record-detail">
              ${reminder.recurrence === "weekly"
                ? `Every week: ${escapeHTML(dayNames(reminder.daysOfWeek))}`
                : `Date: ${escapeHTML(formatDate(reminder.date))}`}
              <br>Time: ${escapeHTML(formatTime(reminder.time))}
              ${reminder.dose ? `<br>Dose: ${escapeHTML(reminder.dose)}` : ""}
              ${reminder.notes ? `<br>Notes: ${escapeHTML(reminder.notes)}` : ""}
            </div>
          </div>
          <div class="record-actions">
            <button type="button" class="btn secondary small"
              data-edit-rem="${escapeHTML(id)}">Edit</button>
            <button type="button" class="btn danger small"
              data-del-rem="${escapeHTML(id)}">Delete</button>
          </div>
        </article>
      `).join("")
    : '<div class="empty">No reminders created yet.</div>';
}

function reminderPanel(open) {
  const panel = firstElement("reminderFormPanel", "reminderForm");

  if (panel && panel.tagName !== "FORM") {
    panel.classList.toggle("open", open);
    panel.hidden = !open;
  } else if (panel) {
    panel.classList.toggle("open", open);
  }
}

function updateRecurrenceFields() {
  const recurrence = firstElement("reminderRecurrence", "recurrenceType");
  if (!recurrence) return;

  const weekly = recurrence.value === "weekly";
  const dateField = firstElement("reminderDateField", "onceDateField");
  const daysField = firstElement("reminderDaysField", "weeklyDaysField");

  if (dateField) dateField.hidden = weekly;
  if (daysField) daysField.hidden = !weekly;
  if ($("reminderDate")) $("reminderDate").required = !weekly;
}

function resetReminderForm() {
  const form = firstElement("reminderForm", "reminderFormElement");
  if (form) form.reset();

  const idField = firstElement("reminderId", "reminderEditId");
  if (idField) idField.value = "";

  const recurrence = firstElement("reminderRecurrence", "recurrenceType");
  if (recurrence) recurrence.value = "once";

  if ($("reminderTime")) $("reminderTime").value = "08:00";
  if ($("reminderDate")) $("reminderDate").value = "";

  if ($("reminderFormTitle")) $("reminderFormTitle").textContent = "Add reminder";
  if ($("saveReminder")) $("saveReminder").textContent = "Save reminder";

  reminderPanel(false);
  updateRecurrenceFields();
  hideMessage("reminderMessage");
}

firstElement("reminderRecurrence", "recurrenceType")
  ?.addEventListener("change", updateRecurrenceFields);

firstElement("addReminderButton", "toggleReminderForm")
  ?.addEventListener("click", () => {
    if (!Object.keys(medicines).length) {
      message("pageMessage", "Add a medicine before scheduling reminders.", "error");
      return;
    }

    resetReminderForm();
    reminderPanel(true);
    updateRecurrenceFields();
  });

firstElement("cancelReminderButton", "cancelReminder")
  ?.addEventListener("click", resetReminderForm);

firstElement("reminderForm", "reminderFormElement")
  ?.addEventListener("submit", async event => {
    event.preventDefault();

    if (!user || busy) return;

    const medicineId = $("reminderMedicine")?.value || "";
    const recurrence = firstElement("reminderRecurrence", "recurrenceType")?.value || "once";
    const date = $("reminderDate")?.value || "";
    const time = $("reminderTime")?.value || "";

    const daysOfWeek = [
      ...document.querySelectorAll('input[name="reminderDay"]:checked, input[name="weeklyDay"]:checked')
    ].map(input => Number(input.value));

    hideMessage("reminderMessage");

    if (!medicines[medicineId]) {
      message("reminderMessage", "Choose a valid medicine first.", "error");
      return;
    }

    if (!time || !/^\d{2}:\d{2}$/.test(time)) {
      message("reminderMessage", "Choose a valid reminder time.", "error");
      return;
    }

    if (recurrence === "once" && (!date || date < localDate())) {
      message("reminderMessage", "Choose today or a future date.", "error");
      return;
    }

    if (recurrence === "weekly" && !daysOfWeek.length) {
      message("reminderMessage", "Select at least one day for the weekly schedule.", "error");
      return;
    }

    busy = true;

    const save = $("saveReminder");
    if (save) save.disabled = true;

    try {
      const idField = firstElement("reminderId", "reminderEditId");
      const id = idField?.value || "";

      const record = {
        medicineId,
        recurrence,
        date: recurrence === "once" ? date : null,
        daysOfWeek: recurrence === "weekly" ? daysOfWeek : [],
        time,
        dose: $("reminderDose")?.value.trim() || "",
        notes: $("reminderNotes")?.value.trim() || "",
        updatedAt: Date.now()
      };

      if (id) {
        await update(ref(db, accountPath(`reminders/${id}`)), record);
      } else {
        record.createdAt = Date.now();
        await set(push(ref(db, accountPath("reminders"))), record);
      }

      await logActivity(
        id ? "Reminder updated" : "Reminder created",
        `${medicineName(medicineId)} — ${
          recurrence === "weekly" ? dayNames(daysOfWeek) : formatDate(date)
        } at ${formatTime(time)}`
      );

      resetReminderForm();
      message("pageMessage", "Reminder saved successfully.");
    } catch (error) {
      console.error(error);
      message("reminderMessage", "Unable to save reminder. Check Firebase rules and connection.", "error");
    } finally {
      busy = false;
      if (save) save.disabled = false;
    }
  });

$("reminderList")?.addEventListener("click", async event => {
  const edit = event.target.closest("[data-edit-rem]");
  const del = event.target.closest("[data-del-rem]");

  if (del) {
    const id = del.dataset.delRem;
    if (!confirm("Delete this reminder?")) return;

    try {
      const name = medicineName(reminders[id]?.medicineId);

      await remove(ref(db, accountPath(`reminders/${id}`)));
      await logActivity("Reminder deleted", name);

      message("pageMessage", "Reminder deleted successfully.");
    } catch (error) {
      console.error(error);
      alert("Unable to delete reminder: " + error.message);
    }

    return;
  }

  if (!edit) return;

  const id = edit.dataset.editRem;
  const reminder = reminders[id];
  if (!reminder) return;

  showPage("remindersPage");
  reminderPanel(true);

  const idField = firstElement("reminderId", "reminderEditId");
  if (idField) idField.value = id;

  if ($("reminderMedicine")) $("reminderMedicine").value = reminder.medicineId || "";

  const recurrence = firstElement("reminderRecurrence", "recurrenceType");
  if (recurrence) recurrence.value = reminder.recurrence || "once";

  if ($("reminderDate")) $("reminderDate").value = reminder.date || "";
  if ($("reminderTime")) $("reminderTime").value = reminder.time || "08:00";
  if ($("reminderDose")) $("reminderDose").value = reminder.dose || "";
  if ($("reminderNotes")) $("reminderNotes").value = reminder.notes || "";

  document.querySelectorAll('input[name="reminderDay"], input[name="weeklyDay"]')
    .forEach(input => {
      input.checked = (reminder.daysOfWeek || []).includes(Number(input.value));
    });

  updateRecurrenceFields();

  if ($("reminderFormTitle")) $("reminderFormTitle").textContent = "Edit reminder";
  if ($("saveReminder")) $("saveReminder").textContent = "Update reminder";
});

/* =========================================================
   HISTORY AND NOTIFICATIONS
   ========================================================= */

function renderHistory() {
  const entries = getActivities();

  if ($("historyList")) {
    $("historyList").innerHTML = entries.length
      ? entries.slice(0, 100).map(activity => `
          <article class="record">
            <div class="record-main">
              <div class="record-title">${escapeHTML(activity.action)}</div>
              <div class="record-detail">
                ${escapeHTML(activity.detail)}
                <br>${escapeHTML(formatStamp(activity.timestamp))}
              </div>
            </div>
          </article>
        `).join("")
      : '<div class="empty">No activity history yet.</div>';
  }

  if ($("notificationList")) {
    $("notificationList").innerHTML = entries.length
      ? entries.slice(0, 30).map(activity => `
          <article class="record">
            <div class="record-main">
              <div class="record-title">${escapeHTML(activity.action)}</div>
              <div class="record-detail">
                ${escapeHTML(activity.detail)}
                <br>${escapeHTML(formatStamp(activity.timestamp))}
              </div>
            </div>
          </article>
        `).join("")
      : '<div class="empty">No notifications yet.</div>';
  }
}

/* =========================================================
   PATIENT CONNECTION
   Code lookup only. This does NOT grant patient data access.
   ========================================================= */

$("connectionForm")?.addEventListener("submit", async event => {
  event.preventDefault();

  if (!user) {
    message("connectionMessage", "Please sign in first.", "error");
    return;
  }

  const code = $("connectionCode")?.value.trim() || "";

  if (!code) {
    message("connectionMessage", "Enter a patient connection code.", "error");
    return;
  }

  const button = $("connectPatientButton");
  if (button) {
    button.disabled = true;
    button.textContent = "Checking code…";
  }

  hideMessage("connectionMessage");

  try {
    const snapshot = await get(ref(db, `connectionCodes/${code}`));

    if (!snapshot.exists()) {
      message("connectionMessage", "Code not found. Check the code and try again.", "error");
      return;
    }

    const record = snapshot.val();
    const patientId = record?.patientUid;

    if (!patientId || typeof patientId !== "string") {
      message("connectionMessage", "This code does not contain a valid patient reference.", "error");
      return;
    }

    if (patientId === user.uid) {
      message("connectionMessage", "You cannot connect an account to itself.", "error");
      return;
    }

    message(
      "connectionMessage",
      "The code exists, but the connection is not complete. Patient consent and secure database authorization are required first.",
      "error"
    );
  } catch (error) {
    console.error("Connection lookup failed:", error);

    message(
      "connectionMessage",
      "Unable to check the code. The connectionCodes path may not be accessible under your current Firebase rules.",
      "error"
    );
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Connect patient";
    }
  }
});

/* =========================================================
   NAVIGATION
   ========================================================= */

document.querySelectorAll("[data-page]").forEach(button => {
  button.addEventListener("click", () => {
    showPage(button.dataset.page);
  });
});

$("openConnection")?.addEventListener("click", () => showPage("connectionPage"));
$("mobileConnectionButton")?.addEventListener("click", () => showPage("connectionPage"));
$("openNotifications")?.addEventListener("click", () => showPage("notificationsPage"));
$("openProfile")?.addEventListener("click", () => showPage("profilePage"));
$("profileButton")?.addEventListener("click", () => showPage("profilePage"));

$("refreshHistory")?.addEventListener("click", renderHistory);

$("markRead")?.addEventListener("click", () => {
  showPage("notificationsPage");
});

/* =========================================================
   PASSWORD CHANGE
   ========================================================= */

$("passwordForm")?.addEventListener("submit", async event => {
  event.preventDefault();

  if (!user) return;

  const current = $("currentPassword")?.value || "";
  const next = $("newPassword")?.value || "";
  const confirmNext = $("confirmPassword")?.value || "";

  if (next.length < 8) {
    message("passwordMessage", "New password must contain at least 8 characters.", "error");
    return;
  }

  if (next !== confirmNext) {
    message("passwordMessage", "New passwords do not match.", "error");
    return;
  }

  if (next === current) {
    message("passwordMessage", "Choose a different password.", "error");
    return;
  }

  try {
    if (!user.email) {
      message("passwordMessage", "This account does not have an email address for password verification.", "error");
      return;
    }

    const credential = EmailAuthProvider.credential(user.email, current);

    await reauthenticateWithCredential(user, credential);
    await updatePassword(user, next);

    $("passwordForm").reset();
    message("passwordMessage", "Password updated successfully.");

    await logActivity("Password changed", "Account password updated.");
  } catch (error) {
    console.error(error);

    const text = [
      "auth/invalid-credential",
      "auth/wrong-password",
      "auth/invalid-login-credentials"
    ].includes(error.code)
      ? "Your current password is incorrect."
      : error.code === "auth/requires-recent-login"
        ? "Please sign in again before changing your password."
        : error.message;

    message("passwordMessage", text, "error");
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
    console.error(error);
    alert("Unable to log out: " + error.message);
  }
});

/* =========================================================
   AUTHENTICATION AND FIREBASE LISTENERS
   ========================================================= */

onAuthStateChanged(auth, async authenticatedUser => {
  if (authCheckInProgress) return;
  authCheckInProgress = true;

  try {
    stopSubscriptions();

    if (!authenticatedUser) {
      user = null;
      window.location.replace("login.html");
      return;
    }

    user = authenticatedUser;

    if ($("displayName")) {
      $("displayName").textContent = user.displayName || "My account";
    }

    if ($("avatar")) {
      $("avatar").textContent =
        (user.displayName || user.email || "A")[0].toUpperCase();
    }

    if ($("welcomeTitle")) {
      $("welcomeTitle").textContent =
        `Welcome, ${(user.displayName || "there").split(" ")[0]}!`;
    }

    if ($("profileEmail")) {
      $("profileEmail").textContent = user.email || "";
    }

    /*
     * This dashboard reads only the signed-in account's own records.
     * It does not switch to or read another user's data.
     *
     * Your signup code and Firebase rules must also enforce roles
     * and permissions. A client-side role check alone is not security.
     */

    subscribe("medicines", value => {
      medicines = value;
      renderMedicines();
    });

    subscribe("reminders", value => {
      reminders = value;
      renderReminders();
    });

    const historyUnsubscribe = onValue(
      ref(db, accountPath("activity")),
      snapshot => {
        activities = snapshot.val() || {};
        renderHistory();
      },
      error => {
        console.error("History subscription failed:", error);
      }
    );

    unsubs.push(historyUnsubscribe);
  } catch (error) {
    console.error("Dashboard initialization failed:", error);
    message(
      "pageMessage",
      "Unable to initialize the dashboard. Check your Firebase configuration and database rules.",
      "error"
    );
  } finally {
    authCheckInProgress = false;
  }
});

window.addEventListener("beforeunload", stopSubscriptions);
