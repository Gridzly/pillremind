
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

const $ = id => document.getElementById(id);

let user = null;
let medicines = {};
let reminders = {};
let activities = {};
let activePatientUid = null;
let unsubs = [];
let busy = false;

const pages = {
  medicinesPage: ["Medicines", "Manage medicine records."],
  remindersPage: ["Reminders", "Manage one-time and weekly schedules."],
  refillsPage: ["Refill tracker", "Monitor medicine stock levels."],
  historyPage: ["Activity history", "Review recent changes."]
};

const escapeHTML = value =>
  String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);

const patientUid = () => activePatientUid || user?.uid;
const dataPath = path => `users/${patientUid()}/${path}`;
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

function openModal(id) {
  $(id)?.classList.add("open");
}

function closeModal(id) {
  $(id)?.classList.remove("open");
}

function showPage(id) {
  document.querySelectorAll(".page").forEach(page => {
    page.classList.toggle("active", page.id === id);
  });

  document.querySelectorAll("[data-page]").forEach(button => {
    button.classList.toggle("active", button.dataset.page === id);
  });

  if (pages[id]) {
    if ($("pageTitle")) $("pageTitle").textContent = pages[id][0];
    if ($("pageSubtitle")) $("pageSubtitle").textContent = pages[id][1];
  }

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function localDate() {
  const date = new Date();

  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatDate(date) {
  if (!date) return "Date not set";

  const [year, month, day] = date.split("-").map(Number);

  return new Date(year, month - 1, day).toLocaleDateString("en-PH", {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

function formatTime(time) {
  if (!time) return "Time not set";

  const [hours, minutes] = time.split(":").map(Number);

  return `${String(hours % 12 || 12).padStart(2, "0")}:${String(minutes).padStart(2, "0")} ${hours >= 12 ? "PM" : "AM"}`;
}

function formatStamp(timestamp) {
  return new Date(timestamp || Date.now()).toLocaleString("en-PH");
}

async function logActivity(action, detail) {
  if (!user) return;

  await set(push(ref(db, accountPath("activity"))), {
    action,
    detail,
    timestamp: Date.now()
  });
}

function getActivities() {
  return Object.entries(activities)
    .map(([id, item]) => ({ id, ...item }))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

function medicineName(id) {
  return medicines[id]?.name || "Medicine unavailable";
}

function stopSubscriptions() {
  unsubs.forEach(unsubscribe => unsubscribe());
  unsubs = [];
}

function subscribe(path, callback) {
  const unsubscribe = onValue(
    ref(db, dataPath(path)),
    snapshot => callback(snapshot.val() || {}),
    error => {
      console.error("Firebase subscription error:", error);

      message(
        "pageMessage",
        "Unable to access these records. Check your Firebase connection and database rules.",
        "error"
      );
    }
  );

  unsubs.push(unsubscribe);
}

/* MEDICINES */

function renderMedicines() {
  const entries = Object.entries(medicines);

  if ($("medicineCount")) {
    $("medicineCount").textContent = entries.length;
  }

  if ($("medicineList")) {
    $("medicineList").innerHTML = entries.length
      ? entries.map(([id, medicine]) => {
          const quantity = Number(medicine.quantity ?? 0);
          const refillAt = Number(medicine.refillAt ?? 0);
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
                <button class="btn secondary small"
                  data-edit-med="${escapeHTML(id)}">Edit</button>

                <button class="btn secondary small"
                  data-stock-med="${escapeHTML(id)}">＋ Refill</button>

                <button class="btn danger small"
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
    Number(medicine.quantity ?? 0) <= Number(medicine.refillAt ?? 0)
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
              · Alert level: ${Number(medicine.refillAt ?? 0)} units
            </div>
          </div>

          <button class="btn small"
            data-stock-med="${escapeHTML(id)}">Record refill</button>
        </article>
      `).join("")
    : '<div class="empty">All recorded medicine quantities are above their refill thresholds.</div>';
}

async function recordRefill(id) {
  const medicine = medicines[id];

  if (!medicine) return;

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

    await update(ref(db, dataPath(`medicines/${id}`)), {
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
    alert("Unable to record refill: " + error.message);
  }
}

async function deleteMedicine(id) {
  const medicine = medicines[id];

  if (!medicine || !confirm(`Delete ${medicine.name} and its reminders?`)) {
    return;
  }

  try {
    const changes = {};

    changes[dataPath(`medicines/${id}`)] = null;

    for (const [reminderId, reminder] of Object.entries(reminders)) {
      if (reminder.medicineId === id) {
        changes[dataPath(`reminders/${reminderId}`)] = null;
      }
    }

    await update(ref(db), changes);

    await logActivity("Medicine deleted", medicine.name);

    message("pageMessage", "Medicine and its reminders deleted.");
  } catch (error) {
    console.error(error);
    alert("Unable to delete medicine: " + error.message);
  }
}

function resetMedicineForm() {
  $("medicineFormElement").reset();
  $("medicineEditId").value = "";
  $("medicineQuantity").value = "0";
  $("medicineRefillAt").value = "5";
  $("medicineFormTitle").textContent = "Add medicine";
  $("saveMedicine").textContent = "Save medicine";
  $("medicineForm").classList.remove("open");
}

$("toggleMedicineForm").addEventListener("click", () => {
  $("medicineForm").classList.toggle("open");
});

$("cancelMedicine").addEventListener("click", () => {
  resetMedicineForm();
  hideMessage("pageMessage");
});

$("medicineFormElement").addEventListener("submit", async event => {
  event.preventDefault();

  if (!user || busy) return;

  const name = $("medicineName").value.trim();
  const quantity = Number($("medicineQuantity").value);
  const refillAt = Number($("medicineRefillAt").value);

  if (!name) {
    message("pageMessage", "Enter the medicine name.", "error");
    return;
  }

  if (
    !Number.isInteger(quantity) ||
    quantity < 0 ||
    quantity > 100000 ||
    !Number.isInteger(refillAt) ||
    refillAt < 0 ||
    refillAt > 100000
  ) {
    message("pageMessage", "Enter valid whole-number quantities.", "error");
    return;
  }

  if (!$("medicineDetailsVerified").checked) {
    message(
      "pageMessage",
      "Please verify the medicine details before saving.",
      "error"
    );

    $("medicineDetailsVerified").focus();
    return;
  }

  busy = true;
  $("saveMedicine").disabled = true;
  hideMessage("pageMessage");

  try {
    const id = $("medicineEditId").value;

    const record = {
      name,
      dosage: $("medicineDosage").value.trim(),
      quantity,
      refillAt,
      instructions: $("medicineInstructions").value.trim(),
      notes: $("medicineNotes").value.trim(),
      detailsVerified: true,
      updatedAt: Date.now()
    };

    if (id) {
      await update(ref(db, dataPath(`medicines/${id}`)), record);
    } else {
      record.createdAt = Date.now();

      await set(push(ref(db, dataPath("medicines"))), record);
    }

    await logActivity(
      id ? "Medicine updated" : "Medicine added",
      name
    );

    resetMedicineForm();

    message("pageMessage", "Medicine saved successfully.");
  } catch (error) {
    console.error(error);

    message(
      "pageMessage",
      "Unable to save medicine. Check your Firebase connection and database rules.",
      "error"
    );
  } finally {
    busy = false;
    $("saveMedicine").disabled = false;
  }
});

$("medicineList").addEventListener("click", event => {
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

  $("medicineEditId").value = id;
  $("medicineName").value = medicine.name || "";
  $("medicineDosage").value = medicine.dosage || "";
  $("medicineQuantity").value = medicine.quantity ?? 0;
  $("medicineRefillAt").value = medicine.refillAt ?? 5;
  $("medicineInstructions").value = medicine.instructions || "";
  $("medicineNotes").value = medicine.notes || "";

  // Require verification again after editing details.
  $("medicineDetailsVerified").checked = false;

  $("medicineFormTitle").textContent = "Edit medicine";
  $("saveMedicine").textContent = "Update medicine";
  $("medicineForm").classList.add("open");

  window.scrollTo({ top: 0, behavior: "smooth" });
});

$("refillList").addEventListener("click", event => {
  const button = event.target.closest("[data-stock-med]");

  if (button) recordRefill(button.dataset.stockMed);
});

/* REMINDERS */

function dayNames(days) {
  const names = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday"
  ];

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

              ${reminder.dose
                ? `<br>Dose: ${escapeHTML(reminder.dose)}`
                : ""}

              ${reminder.notes
                ? `<br>Notes: ${escapeHTML(reminder.notes)}`
                : ""}
            </div>
          </div>

          <div class="record-actions">
            <button class="btn secondary small"
              data-edit-rem="${escapeHTML(id)}">Edit</button>

            <button class="btn danger small"
              data-del-rem="${escapeHTML(id)}">Delete</button>
          </div>
        </article>
      `).join("")
    : '<div class="empty">No reminders created yet.</div>';
}

function resetReminderForm() {
  $("reminderFormElement").reset();
  $("reminderEditId").value = "";
  $("reminderTime").value = "08:00";
  $("recurrenceType").value = "once";
  $("saveReminder").textContent = "Save reminder";

  $("onceDateField").style.display = "";
  $("weeklyDaysField").style.display = "none";
  $("reminderDate").required = true;

  $("reminderForm").classList.remove("open");

  hideMessage("reminderMessage");
}

$("recurrenceType").addEventListener("change", () => {
  const weekly = $("recurrenceType").value === "weekly";

  $("onceDateField").style.display = weekly ? "none" : "";
  $("weeklyDaysField").style.display = weekly ? "" : "none";
  $("reminderDate").required = !weekly;
});

$("toggleReminderForm").addEventListener("click", () => {
  if (!Object.keys(medicines).length) {
    message(
      "reminderMessage",
      "Add a medicine before scheduling reminders.",
      "error"
    );

    $("reminderForm").classList.add("open");
    return;
  }

  $("reminderForm").classList.toggle("open");
});

$("cancelReminder").addEventListener("click", resetReminderForm);

$("reminderFormElement").addEventListener("submit", async event => {
  event.preventDefault();

  if (!user || busy) return;

  const medicineId = $("reminderMedicine").value;
  const recurrence = $("recurrenceType").value;
  const date = $("reminderDate").value;
  const time = $("reminderTime").value;

  const daysOfWeek = [
    ...document.querySelectorAll('input[name="weeklyDay"]:checked')
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
    message(
      "reminderMessage",
      "Select at least one day for the weekly schedule.",
      "error"
    );
    return;
  }

  busy = true;
  $("saveReminder").disabled = true;

  try {
    const id = $("reminderEditId").value;

    const record = {
      medicineId,
      recurrence,
      date: recurrence === "once" ? date : null,
      daysOfWeek: recurrence === "weekly" ? daysOfWeek : [],
      time,
      dose: $("reminderDose").value.trim(),
      notes: $("reminderNotes").value.trim(),
      updatedAt: Date.now()
    };

    if (id) {
      await update(ref(db, dataPath(`reminders/${id}`)), record);
    } else {
      record.createdAt = Date.now();

      await set(push(ref(db, dataPath("reminders"))), record);
    }

    await logActivity(
      id ? "Reminder updated" : "Reminder created",
      `${medicineName(medicineId)} — ${
        recurrence === "weekly"
          ? "weekly: " + dayNames(daysOfWeek)
          : formatDate(date)
      } at ${formatTime(time)}`
    );

    resetReminderForm();

    message("pageMessage", "Reminder saved successfully.");
  } catch (error) {
    console.error(error);

    message(
      "reminderMessage",
      "Unable to save reminder. Check your Firebase connection and database rules.",
      "error"
    );
  } finally {
    busy = false;
    $("saveReminder").disabled = false;
  }
});

$("reminderList").addEventListener("click", async event => {
  const edit = event.target.closest("[data-edit-rem]");
  const del = event.target.closest("[data-del-rem]");

  if (del) {
    const id = del.dataset.delRem;

    if (!confirm("Delete this reminder?")) return;

    try {
      const name = medicineName(reminders[id]?.medicineId);

      await remove(ref(db, dataPath(`reminders/${id}`)));

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

  $("reminderForm").classList.add("open");
  $("reminderEditId").value = id;
  $("reminderMedicine").value = reminder.medicineId || "";
  $("recurrenceType").value = reminder.recurrence || "once";
  $("reminderDate").value = reminder.date || "";
  $("reminderTime").value = reminder.time || "08:00";
  $("reminderDose").value = reminder.dose || "";
  $("reminderNotes").value = reminder.notes || "";

  document.querySelectorAll('input[name="weeklyDay"]').forEach(input => {
    input.checked = (reminder.daysOfWeek || []).includes(Number(input.value));
  });

  $("recurrenceType").dispatchEvent(new Event("change"));

  $("saveReminder").textContent = "Update reminder";
});

/* ACTIVITY HISTORY AND NOTIFICATIONS */

function renderHistory() {
  const entries = getActivities();

  if ($("historyList")) {
    $("historyList").innerHTML = entries.length
      ? entries.slice(0, 100).map(activity => `
          <article class="record">
            <div class="record-main">
              <div class="record-title">
                ${escapeHTML(activity.action)}
              </div>

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
              <div class="record-title">
                ${escapeHTML(activity.action)}
              </div>

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

/* MANUAL PATIENT CONNECTION CODE — NO QR SCANNING */

$("connectionForm").addEventListener("submit", async event => {
  event.preventDefault();

  if (!user) {
    message("connectionMessage", "Please sign in first.", "error");
    return;
  }

  const code = $("connectionCode").value.trim();

  if (!code) {
    message("connectionMessage", "Enter a patient connection code.", "error");
    return;
  }

  const button = $("connectPatientButton");

  button.disabled = true;
  button.textContent = "Checking code…";

  hideMessage("connectionMessage");

  try {
    const snapshot = await get(ref(db, `connectionCodes/${code}`));

    if (!snapshot.exists()) {
      message(
        "connectionMessage",
        "Code not found. Check the code and try again.",
        "error"
      );
      return;
    }

    const record = snapshot.val();
    const patientId = record?.patientUid;

    if (!patientId || typeof patientId !== "string") {
      message(
        "connectionMessage",
        "This code does not contain a valid patient reference.",
        "error"
      );
      return;
    }

    if (patientId === user.uid) {
      message(
        "connectionMessage",
        "You cannot connect an account to itself.",
        "error"
      );
      return;
    }

    /*
     * Security note:
     * Finding a code does not establish patient consent or grant access.
     * Do not change activePatientUid or read another user's data here.
     *
     * A secure connection needs patient consent and Firebase rules or
     * trusted backend logic that verifies the caregiver-patient link.
     */
    message(
      "connectionMessage",
      "The code was found. Patient consent and secure authorization must be verified before connecting accounts.",
      "error"
    );
  } catch (error) {
    console.error("Connection lookup failed:", error);

    message(
      "connectionMessage",
      "Connection lookup failed. Check the connectionCodes database path and Firebase rules.",
      "error"
    );
  } finally {
    button.disabled = false;
    button.textContent = "Connect patient";
  }
});

/* NAVIGATION AND MODALS */

document.querySelectorAll("[data-page]").forEach(button => {
  button.addEventListener("click", () => showPage(button.dataset.page));
});

$("openConnection").addEventListener("click", () => {
  openModal("connectionOverlay");
});

$("openNotifications").addEventListener("click", () => {
  openModal("notificationsOverlay");
});

$("openProfile").addEventListener("click", () => {
  openModal("profileOverlay");
});

$("profileButton").addEventListener("click", () => {
  openModal("profileOverlay");
});

document.querySelectorAll("[data-close]").forEach(button => {
  button.addEventListener("click", () => closeModal(button.dataset.close));
});

document.querySelectorAll(".overlay").forEach(overlay => {
  overlay.addEventListener("click", event => {
    if (event.target === overlay) closeModal(overlay.id);
  });
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    document.querySelectorAll(".overlay.open").forEach(overlay => {
      overlay.classList.remove("open");
    });
  }
});

$("refreshHistory").addEventListener("click", renderHistory);

$("markRead").addEventListener("click", () => {
  closeModal("notificationsOverlay");
});

/* PASSWORD CHANGE */

$("passwordForm").addEventListener("submit", async event => {
  event.preventDefault();

  if (!user) return;

  const current = $("currentPassword").value;
  const next = $("newPassword").value;
  const confirmNext = $("confirmPassword").value;

  if (next.length < 8) {
    message(
      "passwordMessage",
      "New password must contain at least 8 characters.",
      "error"
    );
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
    const credential = EmailAuthProvider.credential(user.email, current);

    await reauthenticateWithCredential(user, credential);
    await updatePassword(user, next);

    $("passwordForm").reset();

    message("passwordMessage", "Password updated successfully.");

    await logActivity(
      "Password changed",
      "Account password updated."
    );
  } catch (error) {
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

/* LOGOUT */

$("logoutButton").addEventListener("click", async () => {
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

/* AUTHENTICATION AND FIREBASE LISTENERS */

onAuthStateChanged(auth, async authenticatedUser => {
  if (!authenticatedUser) {
    stopSubscriptions();
    window.location.replace("login.html");
    return;
  }

  stopSubscriptions();

  user = authenticatedUser;
  activePatientUid = null;

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

  // Until the secure patient connection workflow is completed,
  // only the signed-in user's own records are read and written.
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
});

window.addEventListener("beforeunload", () => {
  stopSubscriptions();
});
