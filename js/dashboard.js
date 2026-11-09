
import { auth, db } from "./firebaseConfig.js";

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
const COMPARTMENT_COUNT = 7;

const state = {
  user: null,
  profile: {},
  medicines: {},
  refills: {},
  reminders: {},
  activities: {},
  connectedPatients: {},
  selectedPatientUid: null,
  unsubscribers: [],
  patientUnsubscribers: [],
  busy: false,
  initializedUid: null
};

const DAYS = [
  "Sunday", "Monday", "Tuesday", "Wednesday",
  "Thursday", "Friday", "Saturday"
];

const pages = {
  medicinesPage: ["My Medicines", "Manage your medicine inventory."],
  remindersPage: ["Reminders", "Manage one-time and weekly patient schedules."],
  refillsPage: ["Refill tracker", "Monitor your medicine stock."],
  historyPage: ["Activity history", "Review recent account activity."],
  connectionPage: ["Patient connection", "Connect to a patient using their Firebase UID or QR code."],
  notificationsPage: ["Notifications", "Review recent activity."],
  profilePage: ["My profile", "Manage your account."]
};

/* =========================================================
   GENERAL HELPERS
========================================================= */

const escapeHTML = value =>
  String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);

const accountPath = path => {
  if (!state.user) throw new Error("You are not signed in.");
  return `users/${state.user.uid}/${path}`;
};

const patientPath = (uid, path) => {
  if (!uid) throw new Error("Please select a connected patient.");
  return `users/${uid}/${path}`;
};

function showMessage(id, message, type = "success") {
  const element = $(id);
  if (!element) return;
  element.textContent = message;
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

  document.querySelector(".content")?.scrollTo({
    top: 0,
    behavior: "smooth"
  });

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
  ) return "Date not set";

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
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return "Time unavailable";

  return new Date(value).toLocaleString("en-PH", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  });
}

function emptyState(message) {
  return `<div class="empty-state">${escapeHTML(message)}</div>`;
}

function stopList(list) {
  list.forEach(unsubscribe => {
    try {
      unsubscribe();
    } catch (error) {
      console.warn("Could not stop Firebase listener:", error);
    }
  });
  list.length = 0;
}

function stopSubscriptions() {
  stopList(state.unsubscribers);
  stopList(state.patientUnsubscribers);
}

function subscribeAccount(path, callback) {
  if (!state.user) return;

  const listener = onValue(
    ref(db, accountPath(path)),
    snapshot => callback(snapshot.val() || {}),
    error => {
      console.error(`Firebase error at ${path}:`, error);
      showMessage("pageMessage", `Unable to load ${path}: ${error.message}`, "error");
    }
  );

  state.unsubscribers.push(listener);
}

/* =========================================================
   ACTIVITY HISTORY
========================================================= */

async function logActivity(action, detail, patientUid = null) {
  if (!state.user) return;

  try {
    await set(push(ref(db, accountPath("activity"))), {
      action,
      detail,
      patientUid,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error("Could not save activity:", error);
  }
}

function getActivities() {
  return Object.entries(state.activities || {})
    .map(([id, item]) => ({ id, ...item }))
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
}

/* =========================================================
   CONNECTED PATIENTS
========================================================= */

function patientIsActive(patient) {
  if (!patient || typeof patient !== "object") return false;

  const status = String(patient.status || "").toLowerCase().trim();
  if (!status) return true;

  return ["active", "approved", "connected"].includes(status);
}

function patientDisplayName(uid, patient) {
  return (
    patient?.patientName ||
    patient?.displayName ||
    patient?.fullName ||
    patient?.name ||
    `Patient ${uid.slice(0, 8)}`
  );
}

function getConnectedPatients() {
  return Object.entries(state.connectedPatients || {})
    .filter(([uid, patient]) => {
      if (!uid || !patient) return false;
      if (patient.patientUid && patient.patientUid !== uid) return false;
      return patientIsActive(patient);
    });
}

function buildPatientOptions(selectedUid = "") {
  return `
    <option value="">Select a connected patient</option>
    ${getConnectedPatients().map(([uid, patient]) => `
      <option value="${escapeHTML(uid)}" ${uid === selectedUid ? "selected" : ""}>
        ${escapeHTML(patientDisplayName(uid, patient))}
      </option>
    `).join("")}
  `;
}

function populateReminderPatientSelector(preferredUid = null) {
  const select = $("reminderPatient");
  const message = $("reminderPatientMessage");
  if (!select) return;

  const previousUid = preferredUid || select.value || "";
  const patients = getConnectedPatients();

  select.innerHTML = buildPatientOptions(previousUid);

  if (!patients.length) {
    select.value = "";
    select.disabled = true;

    if (message) {
      message.textContent = "No approved patients are connected. Connect to a patient first.";
    }

    setReminderMedicineOptions([], "Connect to a patient first.");
    return;
  }

  select.disabled = false;
  select.value = patients.some(([uid]) => uid === previousUid) ? previousUid : "";

  if (message) {
    message.textContent = select.value
      ? "Patient selected."
      : "Choose a patient to create a reminder.";
  }
}

/* =========================================================
   PATIENT REMINDER SUBSCRIPTION
========================================================= */

function selectPatient(uid) {
  const patient = state.connectedPatients?.[uid];

  if (!uid || !patient || !patientIsActive(patient)) {
    state.selectedPatientUid = null;
    state.reminders = {};
    stopList(state.patientUnsubscribers);
    renderReminders();
    return;
  }

  if (state.selectedPatientUid === uid) return;

  state.selectedPatientUid = uid;
  state.reminders = {};
  stopList(state.patientUnsubscribers);
  renderReminders();

  const remindersPath = `users/${uid}/reminders`;

  const listener = onValue(
    ref(db, remindersPath),
    snapshot => {
      if (state.selectedPatientUid !== uid) return;
      state.reminders = snapshot.val() || {};
      renderReminders();
    },
    error => {
      console.error("Patient reminders Firebase error:", error);
      showMessage("pageMessage", `Unable to load patient reminders: ${error.message}`, "error");
    }
  );

  state.patientUnsubscribers.push(listener);
  console.log("Listening to patient reminders:", remindersPath);
}

function refreshPatientSelectors() {
  populateReminderPatientSelector();

  const patients = getConnectedPatients();

  if (!patients.length) {
    state.selectedPatientUid = null;
    state.reminders = {};
    stopList(state.patientUnsubscribers);
    renderReminders();
    return;
  }

  if (!patients.some(([uid]) => uid === state.selectedPatientUid)) {
    selectPatient(patients[0][0]);
  }
}

$("reminderPatient")?.addEventListener("change", event => {
  const uid = event.target.value;
  const patient = state.connectedPatients?.[uid];

  if (!uid || !patient || !patientIsActive(patient)) {
    selectPatient(null);
    setReminderMedicineOptions([], "Select a patient first.");

    if ($("reminderPatientMessage")) {
      $("reminderPatientMessage").textContent =
        "Please select an approved connected patient.";
    }
    return;
  }

  selectPatient(uid);
  updateReminderMedicineDropdown();

  if ($("reminderPatientMessage")) {
    $("reminderPatientMessage").textContent =
      `Selected: ${patientDisplayName(uid, patient)}.`;
  }
});

/* =========================================================
   MEDICINE DROPDOWN
========================================================= */

function setReminderMedicineOptions(medicines, placeholder) {
  const select = $("reminderMedicine");
  if (!select) return;

  select.innerHTML = `<option value="">${escapeHTML(placeholder)}</option>`;
  select.disabled = true;

  if (!Array.isArray(medicines) || !medicines.length) return;

  medicines.forEach(([id, medicine]) => {
    const option = document.createElement("option");
    option.value = id;
    option.textContent =
      `${medicine.name || "Unnamed medicine"}` +
      `${medicine.dosage ? ` — ${medicine.dosage}` : ""}`;
    select.appendChild(option);
  });

  select.disabled = false;
}

function updateReminderMedicineDropdown() {
  const patientUid = $("reminderPatient")?.value || "";

  if (!patientUid) {
    setReminderMedicineOptions([], "Select a patient first.");
    return;
  }

  if (!patientIsActive(state.connectedPatients?.[patientUid])) {
    setReminderMedicineOptions([], "Patient is not connected.");
    return;
  }

  const entries = Object.entries(state.medicines || {});

  if (!entries.length) {
    setReminderMedicineOptions([], "Add a medicine to your inventory first.");
    return;
  }

  const previous = $("reminderMedicine")?.value || "";
  setReminderMedicineOptions(entries, "Choose a medicine");

  if (state.medicines[previous]) {
    $("reminderMedicine").value = previous;
  }
}

/* =========================================================
   COMPARTMENT SELECTOR
========================================================= */

function ensureCompartmentSelector() {
  const medicineSelect = $("reminderMedicine");
  if (!medicineSelect || $("reminderCompartment")) return;

  const wrapper = document.createElement("div");
  wrapper.className = "form-group";
  wrapper.style.marginTop = "12px";

  const label = document.createElement("label");
  label.htmlFor = "reminderCompartment";
  label.textContent = "Assigned Compartment (1–7)";

  const select = document.createElement("select");
  select.id = "reminderCompartment";
  select.name = "reminderCompartment";
  select.required = true;
  select.style.width = "100%";
  select.style.padding = "12px";
  select.style.borderRadius = "8px";
  select.style.border = "1px solid #d0d5dd";
  select.style.backgroundColor = "#ffffff";

  select.innerHTML = `
    <option value="">Select compartment</option>
    ${Array.from({ length: COMPARTMENT_COUNT }, (_, index) => `
      <option value="${index + 1}">Compartment ${index + 1}</option>
    `).join("")}
  `;

  wrapper.appendChild(label);
  wrapper.appendChild(select);
  medicineSelect.insertAdjacentElement("afterend", wrapper);
}

/* =========================================================
   DISPLAY HELPERS
========================================================= */

function medicineName(id) {
  return state.medicines[id]?.name || "Medicine unavailable";
}

function dayNames(days) {
  return (Array.isArray(days) ? days : [])
    .map(Number)
    .filter(day => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((a, b) => a - b)
    .map(day => DAYS[day])
    .join(", ");
}

/* =========================================================
   MEDICINE DISPLAY
========================================================= */

function renderMedicines() {
  const entries = Object.entries(state.medicines || {});

  if ($("medicineCount")) $("medicineCount").textContent = entries.length;

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
                ${lowStock ? `<p style="color:#b42318;font-weight:700">Refill needed</p>` : ""}
                ${medicine.instructions ? `<p>Instructions: ${escapeHTML(medicine.instructions)}</p>` : ""}
                ${medicine.notes ? `<p>Notes: ${escapeHTML(medicine.notes)}</p>` : ""}
                ${medicine.detailsVerified ? `<p style="color:#175638">✓ Details verified</p>` : ""}
              </div>

              <div class="record-actions">
                <button type="button" class="btn btn-secondary" data-edit-med="${escapeHTML(id)}">Edit</button>
                <button type="button" class="btn btn-secondary" data-stock-med="${escapeHTML(id)}">＋ Refill</button>
                <button type="button" class="btn btn-danger" data-del-med="${escapeHTML(id)}">Delete</button>
              </div>
            </article>
          `;
        }).join("")
      : emptyState("No medicines in your inventory yet. Add your first medicine.");
  }

  updateReminderMedicineDropdown();
  renderRefills();
}

/* =========================================================
   REFILL TRACKER
========================================================= */

function renderRefills() {
  const entries = Object.entries(state.medicines || {})
    .filter(([, medicine]) =>
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

          <button type="button" class="btn btn-primary" data-stock-med="${escapeHTML(id)}">
            Record refill
          </button>
        </article>
      `).join("")
    : emptyState("No medicines currently need refilling.");
}

/* =========================================================
   REMINDER DISPLAY
========================================================= */

function renderReminders() {
  const entries = Object.entries(state.reminders || {})
    .sort((a, b) => String(a[1].time || "").localeCompare(String(b[1].time || "")));

  if ($("reminderCount")) $("reminderCount").textContent = entries.length;
  if (!$("reminderList")) return;

  const patientUid = state.selectedPatientUid;
  const patient = state.connectedPatients?.[patientUid];

  $("reminderList").innerHTML = entries.length
    ? entries.map(([id, reminder]) => {
        const recurring = reminder.recurrence === "weekly";
        const snapshot = reminder.medicineSnapshot || reminder.medicineDetails || {};

        const displayMedicineName =
          snapshot.name || reminder.medicineName || medicineName(reminder.medicineId);

        const displayDosage =
          snapshot.dosage || reminder.medicineDosage || "";

        const compartment =
          reminder.compartment ?? snapshot.compartment ?? "Not assigned";

        return `
          <article class="record">
            <div class="record-main">
              <h3>${escapeHTML(displayMedicineName)}</h3>
              ${displayDosage ? `<p>Strength: ${escapeHTML(displayDosage)}</p>` : ""}
              <p>Patient: ${escapeHTML(patient ? patientDisplayName(patientUid, patient) : "Selected patient")}</p>
              <p>${recurring
                ? `Every week: ${escapeHTML(dayNames(reminder.daysOfWeek))}`
                : `Date: ${escapeHTML(formatDate(reminder.date))}`}</p>
              <p>Time: ${escapeHTML(formatTime(reminder.time))}</p>
              ${reminder.dose ? `<p>Dose: ${escapeHTML(reminder.dose)}</p>` : ""}
              <p>Assigned compartment: ${escapeHTML(compartment)}</p>
              ${snapshot.instructions ? `<p>Instructions: ${escapeHTML(snapshot.instructions)}</p>` : ""}
              ${reminder.notes ? `<p>Notes: ${escapeHTML(reminder.notes)}</p>` : ""}
              <p>Status: ${escapeHTML(reminder.status || "active")}</p>
            </div>

            <div class="record-actions">
              <button type="button" class="btn btn-secondary" data-edit-rem="${escapeHTML(id)}">Edit</button>
              <button type="button" class="btn btn-danger" data-del-rem="${escapeHTML(id)}">Delete</button>
            </div>
          </article>
        `;
      }).join("")
    : emptyState(patientUid
        ? "No reminders created for this patient yet."
        : "Select a connected patient to view their reminders.");
}

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
  if ($("medicineFormPanel")) $("medicineFormPanel").hidden = !open;
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

  const id = $("medicineId")?.value || "";
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

  const button = $("medicineForm")?.querySelector('button[type="submit"]');
  setButtonBusy(button, true, "Saving…");

  try {
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
      record.createdBy = state.user.uid;
      const newMedicineRef = push(ref(db, accountPath("medicines")));
      await set(newMedicineRef, record);
    }

    await logActivity(
      id ? "Medicine updated" : "Medicine added",
      `${name} — ${dosage}`
    );

    resetMedicineForm();
    showMessage("pageMessage", "Medicine saved to your inventory.");
  } catch (error) {
    console.error("Saving medicine failed:", error);
    showMessage("pageMessage", `Unable to save medicine: ${error.message}`, "error");
  } finally {
    state.busy = false;
    setButtonBusy(button, false);
  }
});

/* =========================================================
   MEDICINE EDIT / DELETE / REFILL
========================================================= */

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

  resetMedicineForm();

  $("medicineId").value = id;
  $("medicineName").value = medicine.name || "";
  $("medicineDosage").value = medicine.dosage || "";
  $("medicineQuantity").value = medicine.quantity ?? 0;
  $("medicineRefillAt").value = medicine.refillAt ?? 5;
  $("medicineInstructions").value = medicine.instructions || "";
  $("medicineNotes").value = medicine.notes || "";

  if ($("detailsVerified")) {
    $("detailsVerified").checked = Boolean(medicine.detailsVerified);
  }

  if ($("medicineFormTitle")) $("medicineFormTitle").textContent = "Edit medicine";

  const button = $("medicineForm")?.querySelector('button[type="submit"]');
  if (button) button.textContent = "Update medicine";

  medicinePanel(true);
  $("medicineName")?.focus();
});

$("refillList")?.addEventListener("click", async event => {
  const button = event.target.closest("[data-stock-med]");
  if (button) await recordRefill(button.dataset.stockMed);
});

/* =========================================================
   RECORD MEDICINE REFILL
========================================================= */

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

  state.busy = true;

  try {
    const newQuantity = current + amount;
    const timestamp = Date.now();

    await update(ref(db, accountPath(`medicines/${id}`)), {
      quantity: newQuantity,
      updatedAt: timestamp
    });

    await set(push(ref(db, accountPath("refills"))), {
      medicineId: id,
      medicineName: medicine.name || "",
      amount,
      previousQuantity: current,
      newQuantity,
      recordedBy: state.user.uid,
      timestamp
    });

    await logActivity(
      "Medicine refilled",
      `${medicine.name}: added ${amount} units. New stock: ${newQuantity}.`
    );

    showMessage("pageMessage", "Medicine stock updated successfully.");
  } catch (error) {
    console.error(error);
    showMessage("pageMessage", `Unable to record refill: ${error.message}`, "error");
  } finally {
    state.busy = false;
  }
}

/* =========================================================
   DELETE MEDICINE
========================================================= */

async function deleteMedicine(id) {
  const medicine = state.medicines[id];
  if (!medicine || !state.user || state.busy) return;

  if (!confirm(`Delete ${medicine.name} from your medicine inventory?`)) return;

  state.busy = true;

  try {
    await remove(ref(db, accountPath(`medicines/${id}`)));

    await logActivity(
      "Medicine deleted",
      `Deleted ${medicine.name} from the medicine inventory.`
    );

    showMessage(
      "pageMessage",
      "Medicine deleted from your inventory. Existing patient reminders are not automatically deleted."
    );
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
  if ($("reminderFormPanel")) $("reminderFormPanel").hidden = !open;
}

function updateRecurrenceFields() {
  const weekly = $("reminderRecurrence")?.value === "weekly";

  if ($("reminderDateField")) $("reminderDateField").hidden = weekly;
  if ($("reminderDaysField")) $("reminderDaysField").hidden = !weekly;
  if ($("reminderDate")) $("reminderDate").required = !weekly;
}

function resetReminderForm() {
  $("reminderForm")?.reset();
  ensureCompartmentSelector();

  if ($("reminderId")) $("reminderId").value = "";
  if ($("reminderRecurrence")) $("reminderRecurrence").value = "once";
  if ($("reminderTime")) $("reminderTime").value = "08:00";
  if ($("reminderDate")) $("reminderDate").value = "";
  if ($("reminderCompartment")) $("reminderCompartment").value = "";
  if ($("reminderFormTitle")) $("reminderFormTitle").textContent = "Add reminder";

  const button = $("reminderForm")?.querySelector('button[type="submit"]');
  if (button) button.textContent = "Save reminder";

  populateReminderPatientSelector();
  setReminderMedicineOptions([], "Select a patient first.");

  reminderPanel(false);
  updateRecurrenceFields();
  hideMessage("pageMessage");
}

$("reminderRecurrence")?.addEventListener("change", updateRecurrenceFields);

$("addReminderButton")?.addEventListener("click", () => {
  if (!getConnectedPatients().length) {
    showMessage(
      "pageMessage",
      "Connect to a patient and wait for approval before adding reminders.",
      "error"
    );
    return;
  }

  if (!Object.keys(state.medicines || {}).length) {
    showMessage(
      "pageMessage",
      "Add a medicine to your inventory before creating a reminder.",
      "error"
    );
    return;
  }

  resetReminderForm();
  reminderPanel(true);
  updateRecurrenceFields();
  $("reminderPatient")?.focus();
});

$("cancelReminderButton")?.addEventListener("click", resetReminderForm);

/* =========================================================
   CREATE / UPDATE PATIENT REMINDER
========================================================= */

$("reminderForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  if (!state.user || state.busy) return;

  ensureCompartmentSelector();

  const patientUid = $("reminderPatient")?.value || "";
  const patient = state.connectedPatients?.[patientUid];

  if (!patientUid || !patient || !patientIsActive(patient)) {
    showMessage("pageMessage", "Please select an approved connected patient.", "error");
    $("reminderPatient")?.focus();
    return;
  }

  const medicineId = $("reminderMedicine")?.value || "";
  const selectedMedicine = state.medicines?.[medicineId];
  const recurrence = $("reminderRecurrence")?.value || "once";
  const date = $("reminderDate")?.value || "";
  const time = $("reminderTime")?.value || "";
  const dose = $("reminderDose")?.value.trim() || "";
  const notes = $("reminderNotes")?.value.trim() || "";
  const compartment = Number($("reminderCompartment")?.value);

  if (!selectedMedicine) {
    showMessage("pageMessage", "Choose a medicine from your inventory.", "error");
    $("reminderMedicine")?.focus();
    return;
  }

  if (!Number.isInteger(compartment) || compartment < 1 || compartment > COMPARTMENT_COUNT) {
    showMessage("pageMessage", "Please assign a valid compartment from 1 to 7.", "error");
    $("reminderCompartment")?.focus();
    return;
  }

  if (!dose) {
    showMessage("pageMessage", "Enter the prescribed dose.", "error");
    $("reminderDose")?.focus();
    return;
  }

  if (!/^\d{2}:\d{2}$/.test(time)) {
    showMessage("pageMessage", "Choose a valid reminder time.", "error");
    return;
  }

  const [hours, minutes] = time.split(":").map(Number);

  if (hours > 23 || minutes > 59) {
    showMessage("pageMessage", "The reminder time is invalid.", "error");
    return;
  }

  if (!["once", "weekly"].includes(recurrence)) {
    showMessage("pageMessage", "Choose a valid recurrence.", "error");
    return;
  }

  if (recurrence === "once" && (!date || date < localDate())) {
    showMessage("pageMessage", "Choose today or a future date.", "error");
    return;
  }

  const daysOfWeek = [
    ...document.querySelectorAll('input[name="reminderDay"]:checked')
  ]
    .map(input => Number(input.value))
    .filter(day => Number.isInteger(day) && day >= 0 && day <= 6);

  if (recurrence === "weekly" && !daysOfWeek.length) {
    showMessage("pageMessage", "Select at least one day for the weekly schedule.", "error");
    return;
  }

  const id = $("reminderId")?.value || "";

  if (id) {
    const existing = state.reminders?.[id];

    if (
      !existing ||
      existing.caregiverUid !== state.user.uid ||
      existing.patientUid !== patientUid
    ) {
      showMessage(
        "pageMessage",
        "This reminder does not belong to your account or selected patient.",
        "error"
      );
      return;
    }
  }

  state.busy = true;

  const button = $("reminderForm")?.querySelector('button[type="submit"]');
  setButtonBusy(button, true, "Saving…");

  try {
    const timestamp = Date.now();

    const medicineSnapshot = {
      medicineId,
      name: selectedMedicine.name || "",
      dosage: selectedMedicine.dosage || "",
      compartment,
      instructions: selectedMedicine.instructions || "",
      notes: selectedMedicine.notes || "",
      detailsVerified: Boolean(selectedMedicine.detailsVerified),
      snapshotUpdatedAt: timestamp
    };

    const record = {
      patientUid,
      patientName: patientDisplayName(patientUid, patient),
      caregiverUid: state.user.uid,
      caregiverName:
        state.user.displayName ||
        state.profile.displayName ||
        state.user.email ||
        "Authorized Person",
      medicineId,
      medicineName: selectedMedicine.name || "",
      medicineDosage: selectedMedicine.dosage || "",
      compartment,
      medicineSnapshot,
      recurrence,
      date: recurrence === "once" ? date : null,
      daysOfWeek: recurrence === "weekly"
        ? [...new Set(daysOfWeek)].sort((a, b) => a - b)
        : [],
      time,
      dose,
      notes,
      status: "active",
      enabled: true,
      updatedAt: timestamp
    };

    let reminderId = id;

    if (id) {
      await update(ref(db, `users/${patientUid}/reminders/${id}`), record);
    } else {
      const newReminderRef = push(ref(db, `users/${patientUid}/reminders`));
      reminderId = newReminderRef.key;
      record.createdAt = timestamp;
      await set(newReminderRef, record);
    }

    const savedSnapshot = await get(
      ref(db, `users/${patientUid}/reminders/${reminderId}`)
    );

    if (!savedSnapshot.exists()) {
      throw new Error("The reminder could not be verified in Firebase.");
    }

    const savedReminder = savedSnapshot.val();

    if (
      savedReminder.caregiverUid !== state.user.uid ||
      savedReminder.patientUid !== patientUid ||
      savedReminder.status !== "active" ||
      Number(savedReminder.compartment) !== compartment ||
      Number(savedReminder.medicineSnapshot?.compartment) !== compartment
    ) {
      throw new Error("The saved reminder or compartment information does not match.");
    }

    const scheduleDescription = recurrence === "weekly"
      ? `Every week on ${dayNames(record.daysOfWeek)} at ${formatTime(time)}`
      : `One time on ${formatDate(date)} at ${formatTime(time)}`;

    await logActivity(
      id ? "Patient reminder updated" : "Patient reminder added",
      `${selectedMedicine.name} — ${scheduleDescription}. Compartment ${compartment}. Patient: ${patientDisplayName(patientUid, patient)}`,
      patientUid
    );

    if (state.selectedPatientUid !== patientUid) selectPatient(patientUid);

    resetReminderForm();

    showMessage(
      "pageMessage",
      `Reminder saved successfully. Compartment ${compartment} assigned to ${selectedMedicine.name}.`
    );

    console.log(
      "REMINDER SAVED AND VERIFIED:",
      `users/${patientUid}/reminders/${reminderId}`,
      savedReminder
    );
  } catch (error) {
    console.error("Saving patient reminder failed:", error);
    showMessage("pageMessage", `Unable to save reminder: ${error.message}`, "error");
  } finally {
    state.busy = false;
    setButtonBusy(button, false);
  }
});

/* =========================================================
   EDIT / DELETE PATIENT REMINDERS
========================================================= */

$("reminderList")?.addEventListener("click", async event => {
  const edit = event.target.closest("[data-edit-rem]");
  const del = event.target.closest("[data-del-rem]");
  const patientUid = state.selectedPatientUid;

  if (!patientUid) {
    showMessage("pageMessage", "Select a connected patient first.", "error");
    return;
  }

  if (del) {
    const id = del.dataset.delRem;
    const reminder = state.reminders[id];
    if (!reminder) return;

    if (
      reminder.caregiverUid !== state.user.uid ||
      reminder.patientUid !== patientUid
    ) {
      showMessage("pageMessage", "You cannot delete this reminder.", "error");
      return;
    }

    if (!confirm("Delete this reminder?")) return;

    try {
      await remove(ref(db, patientPath(patientUid, `reminders/${id}`)));

      await logActivity(
        "Patient reminder deleted",
        `Deleted the reminder for ${reminder.medicineName || "a medicine"}.`,
        patientUid
      );

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

  if (
    reminder.caregiverUid !== state.user.uid ||
    reminder.patientUid !== patientUid
  ) {
    showMessage("pageMessage", "You cannot edit this reminder.", "error");
    return;
  }

  if (!state.medicines?.[reminder.medicineId]) {
    showMessage(
      "pageMessage",
      "The medicine for this reminder is no longer in your inventory.",
      "error"
    );
    return;
  }

  showPage("remindersPage");
  resetReminderForm();
  populateReminderPatientSelector(patientUid);

  if ($("reminderPatient")) $("reminderPatient").value = patientUid;

  selectPatient(patientUid);
  reminderPanel(true);
  updateReminderMedicineDropdown();
  ensureCompartmentSelector();

  $("reminderId").value = id;
  $("reminderMedicine").value = reminder.medicineId || "";

  const savedCompartment =
    reminder.compartment ??
    reminder.medicineSnapshot?.compartment ??
    "";

  $("reminderCompartment").value = String(savedCompartment);
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

  const button = $("reminderForm")?.querySelector('button[type="submit"]');
  if (button) button.textContent = "Update reminder";
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
   PATIENT CONNECTION — UID / QR CODE
========================================================= */

let patientQrScanner = null;

function cleanPatientUid(value) {
  let uid = String(value || "").trim();
  if (uid.startsWith("MEDMINDER:")) {
    uid = uid.slice("MEDMINDER:".length).trim();
  }
  return uid;
}

async function stopPatientQrScanner() {
  if (patientQrScanner) {
    try {
      if (patientQrScanner.isScanning) await patientQrScanner.stop();
      await patientQrScanner.clear();
    } catch (error) {
      console.warn("QR scanner stop:", error);
    }
    patientQrScanner = null;
  }

  if ($("patientQrReader")) $("patientQrReader").hidden = true;
  if ($("stopPatientScanner")) $("stopPatientScanner").hidden = true;
}

$("startPatientScanner")?.addEventListener("click", async () => {
  const reader = $("patientQrReader");

  if (typeof Html5Qrcode === "undefined") {
    showMessage(
      "connectionMessage",
      "The QR scanner could not load. Enter the patient's UID manually.",
      "error"
    );
    return;
  }

  try {
    await stopPatientQrScanner();

    if (reader) reader.hidden = false;
    if ($("stopPatientScanner")) $("stopPatientScanner").hidden = false;

    patientQrScanner = new Html5Qrcode("patientQrReader");

    await patientQrScanner.start(
      { facingMode: "environment" },
      {
        fps: 10,
        qrbox: { width: 230, height: 230 }
      },
      async decodedText => {
        const uid = cleanPatientUid(decodedText);
        if ($("connectionCode")) $("connectionCode").value = uid;

        await stopPatientQrScanner();

        showMessage(
          "connectionMessage",
          "Patient QR code scanned. Check the UID, then send the request."
        );
      },
      () => {}
    );
  } catch (error) {
    console.error("QR scanner failed:", error);
    await stopPatientQrScanner();

    showMessage(
      "connectionMessage",
      "Unable to start the camera. Allow camera access or enter the UID manually.",
      "error"
    );
  }
});

$("stopPatientScanner")?.addEventListener("click", stopPatientQrScanner);

/* =========================================================
   SEND PATIENT CONNECTION REQUEST
========================================================= */

$("connectionForm")?.addEventListener("submit", async event => {
  event.preventDefault();

  if (!state.user || !auth.currentUser) {
    showMessage("connectionMessage", "Please sign in again.", "error");
    return;
  }

  const patientUid = cleanPatientUid($("connectionCode")?.value);
  const caregiverUid = state.user.uid;

  if (!patientUid || patientUid.length < 20 || patientUid.length > 128) {
    showMessage("connectionMessage", "Enter or scan a valid Firebase patient UID.", "error");
    return;
  }

  if (patientUid === caregiverUid) {
    showMessage("connectionMessage", "You cannot connect your account to itself.", "error");
    return;
  }

  const button = $("connectionForm")?.querySelector('button[type="submit"]');
  hideMessage("connectionMessage");
  setButtonBusy(button, true, "Sending request…");

  try {
    await auth.currentUser.getIdToken(true);

    const requestRef = ref(
      db,
      `users/${patientUid}/connectionRequests/${caregiverUid}`
    );

    const existing = await get(requestRef);

    if (existing.exists()) {
      const status = String(existing.val()?.status || "").toLowerCase();

      if (status === "pending") {
        showMessage(
          "connectionMessage",
          "A request is already pending. Please wait for the patient's approval."
        );
        return;
      }

      if (["approved", "active", "connected"].includes(status)) {
        showMessage(
          "connectionMessage",
          "This connection request has already been approved."
        );
        return;
      }
    }

    const caregiverName =
      state.user.displayName ||
      state.profile.displayName ||
      state.user.email ||
      "Authorized Person";

    await set(requestRef, {
      caregiverUid,
      caregiverName,
      caregiverEmail: state.user.email || "",
      status: "pending",
      createdAt: Date.now()
    });

    await logActivity(
      "Patient connection request sent",
      `A connection request was sent to patient UID ${patientUid}.`
    );

    $("connectionForm").reset();

    showMessage(
      "connectionMessage",
      "Request sent. The patient must approve it before you can create reminders for them."
    );
  } catch (error) {
    console.error("Connection request failed:", error);

    let message = `Unable to send the connection request: ${error.message}`;

    if (
      error.code === "PERMISSION_DENIED" ||
      error.code === "database/permission-denied"
    ) {
      message =
        "Firebase denied this request. Check your database rules and patient connection permissions.";
    } else if (!navigator.onLine) {
      message = "You appear to be offline. Check your internet connection.";
    } else if (error.code === "auth/user-token-expired") {
      message = "Your session has expired. Please sign in again.";
    }

    showMessage("connectionMessage", message, "error");
  } finally {
    setButtonBusy(button, false);
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
    $("profileLastName").value = profile.lastName || nameParts.slice(1).join(" ");
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
  const button = $("profileForm")?.querySelector('button[type="submit"]');

  state.busy = true;
  setButtonBusy(button, true, "Saving…");

  try {
    await updateProfile(state.user, { displayName });

    await update(ref(db, accountPath("profile")), {
      firstName,
      lastName,
      displayName,
      email: state.user.email || "",
      updatedAt: Date.now()
    });

    state.profile = {
      ...state.profile,
      firstName,
      lastName,
      displayName
    };

    if ($("displayName")) $("displayName").textContent = displayName;
    if ($("avatar")) $("avatar").textContent = firstName[0].toUpperCase();

    await logActivity("Profile updated", "Account profile information updated.");

    showMessage("profileMessage", "Profile updated successfully.");
  } catch (error) {
    console.error("Profile update failed:", error);
    showMessage("profileMessage", `Unable to save your profile: ${error.message}`, "error");
  } finally {
    state.busy = false;
    setButtonBusy(button, false);
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

  const button = $("passwordForm")?.querySelector('button[type="submit"]');
  state.busy = true;
  setButtonBusy(button, true, "Updating…");

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
    setButtonBusy(button, false);
  }
});

/* =========================================================
   LOGOUT
========================================================= */

$("logoutButton")?.addEventListener("click", async () => {
  if (!confirm("Are you sure you want to log out?")) return;

  try {
    stopSubscriptions();
    await stopPatientQrScanner();
    await signOut(auth);
    window.location.replace("login.html");
  } catch (error) {
    console.error("Logout failed:", error);
    showMessage("pageMessage", `Unable to log out: ${error.message}`, "error");
  }
});

/* =========================================================
   AUTHORIZED PERSON — VISUAL SPOTLIGHT TUTORIAL
========================================================= */

const authorizedGuideSteps = [
  {
    title: "Welcome to Medminder!",
    description:
      "This is your Authorized Person dashboard. You can manage your medicine inventory, connect with patients, and create medicine schedules for them.",
    target: "#welcomeTitle",
    navigate: () => showPage("medicinesPage")
  },
  {
    title: "Your Medicine Inventory",
    description:
      "This section displays the medicines in your inventory. You can review medicine names, strengths, available stock, and refill alerts here.",
    target: "#medicineList",
    navigate: () => showPage("medicinesPage")
  },
  {
    title: "Add a Medicine",
    description:
      "Use this button to add a medicine. Enter its name, strength or dosage, stock quantity, and refill alert level. Verify the details against the medicine label or prescription.",
    target: "#addMedicineButton",
    navigate: () => showPage("medicinesPage")
  },
  {
    title: "Connect to a Patient",
    description:
      "Open Patient Connection to enter a patient's Firebase UID or scan their QR code. Send a connection request when the UID is ready.",
    target: "#connectionForm",
    navigate: () => showPage("connectionPage")
  },
  {
    title: "Create Patient Reminders",
    description:
      "After a patient approves your connection, open Reminders. Select the connected patient and a medicine from your inventory, then enter the dose and reminder time.",
    target: "#addReminderButton",
    navigate: () => showPage("remindersPage")
  },
  {
    title: "Set the Reminder Schedule",
    description:
      "Choose whether the reminder is one-time or weekly. For a weekly schedule, select at least one day. For a one-time schedule, choose today or a future date.",
    target: "#reminderRecurrence",
    navigate: () => {
      showPage("remindersPage");
      if ($("reminderFormPanel")) $("reminderFormPanel").hidden = false;
      updateRecurrenceFields();
    }
  },
  {
    title: "Assign a Device Compartment",
    description:
      "Every reminder must have a compartment number from 1 to 7. Make sure the number you select matches the physical compartment containing the medicine.",
    target: "#reminderCompartment",
    navigate: () => {
      showPage("remindersPage");
      if ($("reminderFormPanel")) $("reminderFormPanel").hidden = false;
      ensureCompartmentSelector();
    }
  },
  {
    title: "Monitor Medicine Refills",
    description:
      "The Refill Tracker displays medicines at or below their refill alert level. Use Record Refill to add new stock to your inventory.",
    target: "#refillList",
    navigate: () => showPage("refillsPage")
  },
  {
    title: "Review Activity History",
    description:
      "Use Activity History to review actions such as adding medicines, recording refills, connecting with patients, and creating reminders.",
    target: "#historyList",
    navigate: () => showPage("historyPage")
  },
  {
    title: "You're Ready!",
    description:
      "You now know the main features of the Authorized Person dashboard. You can reopen this walkthrough anytime using the floating How to Use button.",
    target: "#pageTitle",
    navigate: () => showPage("medicinesPage")
  }
];

let authorizedSpotlight = null;

function createAuthorizedSpotlight({ steps, helpButton, onComplete }) {
  let currentStep = 0;
  let isOpen = false;
  let completionHandled = false;

  const overlay = document.createElement("div");
  overlay.id = "medminderSpotlightOverlay";

  const style = document.createElement("style");
  style.id = "medminderSpotlightStyles";

  style.textContent = `
    #medminderSpotlightOverlay {
      position: fixed;
      inset: 0;
      z-index: 99990;
      display: none;
      pointer-events: none;
    }

    #medminderSpotlightOverlay.active {
      display: block;
    }

    #medminderSpotlight {
      position: fixed;
      z-index: 99991;
      border: 3px solid #42b875;
      border-radius: 12px;
      box-shadow:
        0 0 0 9999px rgba(0, 0, 0, .68),
        0 0 20px rgba(66, 184, 117, .5);
      pointer-events: none;
      transition: all .25s ease;
    }

    #medminderSpotlightCard {
      position: fixed;
      z-index: 99992;
      width: min(360px, calc(100vw - 32px));
      background: #fff;
      color: #20352a;
      border-radius: 16px;
      padding: 20px;
      box-shadow: 0 12px 45px rgba(0,0,0,.25);
      pointer-events: auto;
      font-family: Inter, Arial, sans-serif;
    }

    #medminderSpotlightCard h3 {
      margin: 0 0 9px;
      font-size: 17px;
      color: #175638;
    }

    #medminderSpotlightCard p {
      font-size: 13px;
      line-height: 1.65;
      margin: 0 0 15px;
      color: #53665a;
    }

    #medminderSpotlightCard .tour-progress {
      height: 5px;
      background: #e6eee8;
      border-radius: 20px;
      overflow: hidden;
      margin-bottom: 15px;
    }

    #medminderSpotlightCard .tour-progress div {
      height: 100%;
      background: #24945a;
      transition: width .2s;
    }

    #medminderSpotlightCard .tour-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    #medminderSpotlightCard button {
      border: 0;
      border-radius: 8px;
      padding: 9px 13px;
      cursor: pointer;
      font-weight: 600;
      font-size: 12px;
    }

    #medminderSpotlightCard button:disabled {
      opacity: .5;
      cursor: not-allowed;
    }

    #medminderSpotlightCard .tour-skip {
      background: transparent;
      color: #758579;
      padding-left: 0;
    }

    #medminderSpotlightCard .tour-back {
      background: #edf4ef;
      color: #175638;
    }

    #medminderSpotlightCard .tour-next {
      background: #175638;
      color: white;
    }

    #medminderSpotlightCard .tour-close {
      position: absolute;
      top: 10px;
      right: 12px;
      background: transparent;
      color: #738176;
      padding: 4px 8px;
      font-size: 18px;
    }

    @media(max-width: 480px) {
      #medminderSpotlightCard {
        left: 16px !important;
        right: 16px;
        bottom: 18px !important;
        top: auto !important;
        width: auto;
      }
    }
  `;

  document.head.appendChild(style);

  overlay.innerHTML = `
    <div id="medminderSpotlight"></div>

    <div id="medminderSpotlightCard" role="dialog" aria-modal="true" aria-labelledby="tourTitle">
      <button class="tour-close" id="tourClose" type="button" aria-label="Close tutorial">&times;</button>

      <div class="tour-progress">
        <div id="tourProgressBar"></div>
      </div>

      <small id="tourStepCount"></small>
      <h3 id="tourTitle"></h3>
      <p id="tourDescription"></p>

      <div class="tour-actions">
        <button class="tour-skip" id="tourSkip" type="button">Skip tutorial</button>

        <div style="display:flex;gap:8px">
          <button class="tour-back" id="tourBack" type="button">Back</button>
          <button class="tour-next" id="tourNext" type="button">Next</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const spotlight = overlay.querySelector("#medminderSpotlight");
  const card = overlay.querySelector("#medminderSpotlightCard");

  function findTarget(step) {
    if (!step?.target) return null;

    if (typeof step.target === "function") {
      return step.target();
    }

    return document.querySelector(step.target);
  }

  function positionSpotlight(target) {
    if (!target || !target.isConnected) {
      spotlight.style.display = "none";
      card.style.top = "50%";
      card.style.left = "50%";
      card.style.bottom = "auto";
      card.style.transform = "translate(-50%, -50%)";
      return;
    }

    spotlight.style.display = "block";

    const rect = target.getBoundingClientRect();
    const padding = 7;

    spotlight.style.top = `${Math.max(0, rect.top - padding)}px`;
    spotlight.style.left = `${Math.max(0, rect.left - padding)}px`;
    spotlight.style.width = `${rect.width + padding * 2}px`;
    spotlight.style.height = `${rect.height + padding * 2}px`;

    card.style.transform = "none";

    const cardHeight = card.offsetHeight || 200;
    const cardWidth = Math.min(360, window.innerWidth - 32);

    let top = rect.bottom + 18;

    if (top + cardHeight > window.innerHeight - 12) {
      top = rect.top - cardHeight - 18;
    }

    if (top < 12) {
      top = Math.max(12, (window.innerHeight - cardHeight) / 2);
    }

    let left = rect.left;

    if (left + cardWidth > window.innerWidth - 12) {
      left = window.innerWidth - cardWidth - 12;
    }

    left = Math.max(12, left);

    if (window.innerWidth <= 480) {
      card.style.top = "";
      card.style.left = "";
      card.style.bottom = "18px";
    } else {
      card.style.top = `${top}px`;
      card.style.left = `${left}px`;
      card.style.bottom = "auto";
    }
  }

  function reposition() {
    if (!isOpen) return;
    positionSpotlight(findTarget(steps[currentStep]));
  }

  function renderStep() {
    const step = steps[currentStep];
    if (!step) return;

    if (typeof step.navigate === "function") {
      step.navigate();
    }

    const target = findTarget(step);

    if (target) {
      target.scrollIntoView({
        behavior: "smooth",
        block: "center"
      });
    }

    overlay.querySelector("#tourStepCount").textContent =
      `STEP ${currentStep + 1} OF ${steps.length}`;

    overlay.querySelector("#tourTitle").textContent = step.title;
    overlay.querySelector("#tourDescription").textContent = step.description;

    overlay.querySelector("#tourProgressBar").style.width =
      `${((currentStep + 1) / steps.length) * 100}%`;

    overlay.querySelector("#tourBack").style.visibility =
      currentStep === 0 ? "hidden" : "visible";

    overlay.querySelector("#tourNext").textContent =
      currentStep === steps.length - 1 ? "Finish" : "Next";

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        positionSpotlight(findTarget(step));
      });
    });
  }

  async function closeTour(markCompleted = true) {
    if (!isOpen) return;

    isOpen = false;
    overlay.classList.remove("active");
    document.body.style.overflow = "";

    window.removeEventListener("resize", reposition);
    window.removeEventListener("scroll", reposition, true);

    if (markCompleted && !completionHandled) {
      completionHandled = true;
      if (typeof onComplete === "function") {
        await onComplete();
      }
    }
  }

  function openTour() {
    currentStep = 0;
    completionHandled = false;
    isOpen = true;

    overlay.classList.add("active");
    document.body.style.overflow = "hidden";

    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);

    renderStep();
  }

  overlay.querySelector("#tourNext").addEventListener("click", async () => {
    if (currentStep < steps.length - 1) {
      currentStep++;
      renderStep();
    } else {
      await closeTour(true);
    }
  });

  overlay.querySelector("#tourBack").addEventListener("click", () => {
    if (currentStep > 0) {
      currentStep--;
      renderStep();
    }
  });

  overlay.querySelector("#tourSkip").addEventListener("click", () => {
    closeTour(true);
  });

  overlay.querySelector("#tourClose").addEventListener("click", () => {
    closeTour(true);
  });

  overlay.addEventListener("click", event => {
    if (event.target === overlay) {
      closeTour(true);
    }
  });

  const keyHandler = event => {
    if (isOpen && event.key === "Escape") {
      closeTour(true);
    }
  };

  document.addEventListener("keydown", keyHandler);

  if (helpButton) {
    helpButton.addEventListener("click", event => {
      event.preventDefault();
      openTour();
    });
  }

  return {
    open: openTour,
    close: closeTour,
    destroy() {
      if (isOpen) {
        document.body.style.overflow = "";
      }
      document.removeEventListener("keydown", keyHandler);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      overlay.remove();
      style.remove();
    }
  };
}


function createAuthorizedSpotlight({ steps, helpButton, onComplete }) {
  let currentStep = 0;
  let isOpen = false;
  let completionHandled = false;
  let positionFrame = null;

  const overlay = document.createElement("div");
  overlay.id = "medminderSpotlightOverlay";

  const style = document.createElement("style");
  style.id = "medminderSpotlightStyles";

  style.textContent = `
    #medminderSpotlightOverlay {
      position: fixed;
      inset: 0;
      z-index: 99990;
      display: none;
      pointer-events: none;
    }

    #medminderSpotlightOverlay.active {
      display: block;
    }

    #medminderSpotlight {
      position: fixed;
      z-index: 99991;
      border: 3px solid #42b875;
      border-radius: 12px;
      box-shadow:
        0 0 0 9999px rgba(0, 0, 0, .68),
        0 0 20px rgba(66, 184, 117, .5);
      pointer-events: none;
      transition: top .2s ease, left .2s ease,
                  width .2s ease, height .2s ease;
    }

    #medminderSpotlightCard {
      position: fixed;
      z-index: 99992;
      width: min(360px, calc(100vw - 32px));
      max-height: min(420px, 75vh);
      overflow-y: auto;
      background: #fff;
      color: #20352a;
      border-radius: 16px;
      padding: 20px;
      box-shadow: 0 12px 45px rgba(0,0,0,.25);
      pointer-events: auto;
      font-family: Inter, Arial, sans-serif;
      box-sizing: border-box;
    }

    #medminderSpotlightCard h3 {
      margin: 0 0 9px;
      font-size: 17px;
      color: #175638;
    }

    #medminderSpotlightCard p {
      font-size: 13px;
      line-height: 1.6;
      margin: 0 0 15px;
      color: #53665a;
    }

    #medminderSpotlightCard .tour-progress {
      height: 5px;
      background: #e6eee8;
      border-radius: 20px;
      overflow: hidden;
      margin-bottom: 12px;
    }

    #medminderSpotlightCard .tour-progress div {
      height: 100%;
      background: #24945a;
      transition: width .2s;
    }

    #medminderSpotlightCard .tour-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    #medminderSpotlightCard button {
      border: 0;
      border-radius: 8px;
      padding: 9px 13px;
      cursor: pointer;
      font-weight: 600;
      font-size: 12px;
    }

    #medminderSpotlightCard button:disabled {
      opacity: .5;
      cursor: not-allowed;
    }

    #medminderSpotlightCard .tour-skip {
      background: transparent;
      color: #758579;
      padding-left: 0;
    }

    #medminderSpotlightCard .tour-back {
      background: #edf4ef;
      color: #175638;
    }

    #medminderSpotlightCard .tour-next {
      background: #175638;
      color: white;
    }

    #medminderSpotlightCard .tour-close {
      position: absolute;
      top: 8px;
      right: 10px;
      background: transparent;
      color: #738176;
      padding: 4px 8px;
      font-size: 18px;
    }

    @media(max-width: 480px) {
      #medminderSpotlightCard {
        width: calc(100vw - 24px);
        max-height: 42vh;
        padding: 14px;
        border-radius: 13px;
      }

      #medminderSpotlightCard h3 {
        font-size: 15px;
        margin-bottom: 7px;
      }

      #medminderSpotlightCard p {
        font-size: 12px;
        line-height: 1.5;
        margin-bottom: 10px;
      }

      #medminderSpotlightCard .tour-progress {
        margin-bottom: 9px;
      }

      #medminderSpotlightCard button {
        padding: 8px 10px;
        font-size: 11px;
      }

      #medminderSpotlightCard .tour-close {
        top: 5px;
        right: 7px;
      }
    }
  `;

  document.head.appendChild(style);

  overlay.innerHTML = `
    <div id="medminderSpotlight"></div>

    <div
      id="medminderSpotlightCard"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tourTitle"
    >
      <button
        class="tour-close"
        id="tourClose"
        type="button"
        aria-label="Close tutorial"
      >&times;</button>

      <div class="tour-progress">
        <div id="tourProgressBar"></div>
      </div>

      <small id="tourStepCount"></small>
      <h3 id="tourTitle"></h3>
      <p id="tourDescription"></p>

      <div class="tour-actions">
        <button class="tour-skip" id="tourSkip" type="button">
          Skip tutorial
        </button>

        <div style="display:flex;gap:8px">
          <button class="tour-back" id="tourBack" type="button">
            Back
          </button>

          <button class="tour-next" id="tourNext" type="button">
            Next
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const spotlight = overlay.querySelector("#medminderSpotlight");
  const card = overlay.querySelector("#medminderSpotlightCard");

  function findTarget(step) {
    if (!step?.target) return null;

    if (typeof step.target === "function") {
      return step.target();
    }

    return document.querySelector(step.target);
  }

  function updateSpotlight(target) {
    if (!target || !target.isConnected) {
      spotlight.style.display = "none";
      return;
    }

    spotlight.style.display = "block";

    const rect = target.getBoundingClientRect();
    const padding = 6;

    spotlight.style.top = `${Math.max(0, rect.top - padding)}px`;
    spotlight.style.left = `${Math.max(0, rect.left - padding)}px`;
    spotlight.style.width = `${Math.min(
      rect.width + padding * 2,
      window.innerWidth
    )}px`;
    spotlight.style.height = `${Math.min(
      rect.height + padding * 2,
      window.innerHeight
    )}px`;
  }

  function positionCard(target) {
    if (!target || !target.isConnected) {
      card.style.top = "50%";
      card.style.left = "50%";
      card.style.bottom = "auto";
      card.style.transform = "translate(-50%, -50%)";
      return;
    }

    card.style.transform = "none";
    card.style.bottom = "auto";

    const rect = target.getBoundingClientRect();
    const mobile = window.innerWidth <= 480;
    const margin = 12;
    const gap = 14;

    const cardWidth = mobile
      ? window.innerWidth - 24
      : Math.min(360, window.innerWidth - 32);

    card.style.width = `${cardWidth}px`;

    const cardHeight = card.offsetHeight;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const candidates = [
      {
        left: rect.left,
        top: rect.bottom + gap
      },
      {
        left: rect.left,
        top: rect.top - cardHeight - gap
      },
      {
        left: rect.right + gap,
        top: rect.top
      },
      {
        left: rect.left - cardWidth - gap,
        top: rect.top
      }
    ];

    function clamp(value, min, max) {
      return Math.max(min, Math.min(value, max));
    }

    function calculateOverlap(candidate) {
      const left = clamp(
        candidate.left,
        margin,
        viewportWidth - cardWidth - margin
      );

      const top = clamp(
        candidate.top,
        margin,
        viewportHeight - cardHeight - margin
      );

      const overlapWidth = Math.max(
        0,
        Math.min(left + cardWidth, rect.right + 8) -
        Math.max(left, rect.left - 8)
      );

      const overlapHeight = Math.max(
        0,
        Math.min(top + cardHeight, rect.bottom + 8) -
        Math.max(top, rect.top - 8)
      );

      return {
        left,
        top,
        overlap: overlapWidth * overlapHeight
      };
    }

    const positions = candidates.map(calculateOverlap);

    positions.sort((a, b) => a.overlap - b.overlap);

    let bestPosition = positions[0];

    // On mobile, favor the area with the least overlap.
    // The card remains scrollable if its content is taller.
    if (mobile) {
      bestPosition = positions.reduce((best, current) => {
        return current.overlap < best.overlap ? current : best;
      }, positions[0]);
    }

    card.style.left = `${bestPosition.left}px`;
    card.style.top = `${bestPosition.top}px`;
  }

  function reposition() {
    if (!isOpen) return;

    const target = findTarget(steps[currentStep]);

    updateSpotlight(target);
    positionCard(target);
  }

  function renderStep() {
    const step = steps[currentStep];
    if (!step) return;

    if (typeof step.navigate === "function") {
      step.navigate();
    }

    const target = findTarget(step);

    if (target) {
      target.scrollIntoView({
        behavior: "smooth",
        block: "center",
        inline: "nearest"
      });
    }

    overlay.querySelector("#tourStepCount").textContent =
      `STEP ${currentStep + 1} OF ${steps.length}`;

    overlay.querySelector("#tourTitle").textContent = step.title;
    overlay.querySelector("#tourDescription").textContent =
      step.description;

    overlay.querySelector("#tourProgressBar").style.width =
      `${((currentStep + 1) / steps.length) * 100}%`;

    overlay.querySelector("#tourBack").style.visibility =
      currentStep === 0 ? "hidden" : "visible";

    overlay.querySelector("#tourNext").textContent =
      currentStep === steps.length - 1 ? "Finish" : "Next";

    // Reposition after the page navigation and scrolling.
    if (positionFrame) {
      cancelAnimationFrame(positionFrame);
    }

    positionFrame = requestAnimationFrame(() => {
      reposition();

      setTimeout(() => {
        reposition();
      }, 350);
    });
  }

  async function closeTour(markCompleted = true) {
    if (!isOpen) return;

    isOpen = false;
    overlay.classList.remove("active");
    document.body.style.overflow = "";

    window.removeEventListener("resize", reposition);
    window.removeEventListener("scroll", reposition, true);

    if (markCompleted && !completionHandled) {
      completionHandled = true;

      if (typeof onComplete === "function") {
        await onComplete();
      }
    }
  }

  function openTour() {
    currentStep = 0;
    completionHandled = false;
    isOpen = true;

    overlay.classList.add("active");
    document.body.style.overflow = "hidden";

    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);

    renderStep();
  }

  overlay.querySelector("#tourNext").addEventListener("click", async () => {
    if (currentStep < steps.length - 1) {
      currentStep++;
      renderStep();
    } else {
      await closeTour(true);
    }
  });

  overlay.querySelector("#tourBack").addEventListener("click", () => {
    if (currentStep > 0) {
      currentStep--;
      renderStep();
    }
  });

  overlay.querySelector("#tourSkip").addEventListener("click", () => {
    closeTour(true);
  });

  overlay.querySelector("#tourClose").addEventListener("click", () => {
    closeTour(true);
  });

  const keyHandler = event => {
    if (isOpen && event.key === "Escape") {
      closeTour(true);
    }
  };

  document.addEventListener("keydown", keyHandler);

  if (helpButton) {
    helpButton.addEventListener("click", event => {
      event.preventDefault();
      openTour();
    });
  }

  return {
    open: openTour,
    close: closeTour,

    destroy() {
      if (isOpen) {
        document.body.style.overflow = "";
      }

      document.removeEventListener("keydown", keyHandler);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);

      if (positionFrame) {
        cancelAnimationFrame(positionFrame);
      }

      overlay.remove();
      style.remove();
    }
  };
}


/* =========================================================
   SAVE TUTORIAL COMPLETION
========================================================= */

async function completeAuthorizedGuide() {
  if (!state.user) return;

  try {
    await update(ref(db, accountPath("profile")), {
      onboardingCompleted: true,
      onboardingCompletedAt: Date.now()
    });

    state.profile = {
      ...state.profile,
      onboardingCompleted: true
    };
  } catch (error) {
    console.error("Could not save tutorial completion:", error);
  }
}

/* =========================================================
   START AUTHORIZED PERSON TUTORIAL
========================================================= */

function startAuthorizedGuide(profile = {}) {
  const helpButton = ensureAuthorizedHelpButton();

  if (authorizedSpotlight) {
    authorizedSpotlight.destroy();
    authorizedSpotlight = null;
  }

  authorizedSpotlight = createAuthorizedSpotlight({
    steps: authorizedGuideSteps,
    helpButton,
    onComplete: completeAuthorizedGuide
  });

  // Automatically open only for accounts that have not completed the guide.
  if (profile.onboardingCompleted !== true) {
    setTimeout(() => {
      if (
        state.user &&
        state.profile.onboardingCompleted !== true &&
        authorizedSpotlight
      ) {
        authorizedSpotlight.open();
      }
    }, 900);
  }
}

/* =========================================================
   AUTHENTICATION AND FIREBASE LISTENERS
========================================================= */

onAuthStateChanged(auth, async authenticatedUser => {
  stopSubscriptions();

  if (!authenticatedUser) {
    state.user = null;
    state.initializedUid = null;
    state.selectedPatientUid = null;

    if (authorizedSpotlight) {
      authorizedSpotlight.destroy();
      authorizedSpotlight = null;
    }

    window.location.replace("login.html");
    return;
  }

  if (state.initializedUid === authenticatedUser.uid) return;

  state.user = authenticatedUser;
  state.initializedUid = authenticatedUser.uid;

  state.profile = {};
  state.medicines = {};
  state.refills = {};
  state.reminders = {};
  state.activities = {};
  state.connectedPatients = {};
  state.selectedPatientUid = null;

  try {
    const profileSnapshot = await get(
      ref(db, accountPath("profile"))
    );

    const profile = profileSnapshot.val() || {};
    state.profile = profile;

    const role = String(profile.role || "").toLowerCase().trim();

    if (!["authorized", "caregiver", "authorized_person"].includes(role)) {
      state.initializedUid = null;

      showMessage(
        "pageMessage",
        "This dashboard is only for authorized person accounts.",
        "error"
      );

      window.location.replace("login.html");
      return;
    }

    const name =
      authenticatedUser.displayName ||
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

    // Start the visual spotlight tutorial and floating help button.
    startAuthorizedGuide(profile);

    subscribeAccount("medicines", value => {
      state.medicines = value;
      renderMedicines();
    });

    subscribeAccount("refills", value => {
      state.refills = value;
    });

    subscribeAccount("activity", value => {
      state.activities = value;
      renderHistory();
    });

    subscribeAccount("connectedPatients", value => {
      state.connectedPatients = value || {};
      refreshPatientSelectors();
    });

    ensureCompartmentSelector();
    updateRecurrenceFields();
    showPage("medicinesPage");

  } catch (error) {
    console.error("Dashboard initialization failed:", error);
    state.initializedUid = null;

    showMessage(
      "pageMessage",
      `Unable to initialize the dashboard: ${error.message}`,
      "error"
    );
  }
});

/* =========================================================
   CLEANUP
========================================================= */

window.addEventListener("beforeunload", () => {
  stopSubscriptions();
  stopPatientQrScanner();

  if (authorizedSpotlight) {
    authorizedSpotlight.destroy();
    authorizedSpotlight = null;
  }
});
