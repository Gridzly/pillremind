
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
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
];

const pages = {
  medicinesPage: [
    "My Medicines",
    "Manage your medicine inventory."
  ],
  remindersPage: [
    "Reminders",
    "Manage one-time and weekly patient schedules."
  ],
  refillsPage: [
    "Refill tracker",
    "Monitor your medicine stock."
  ],
  historyPage: [
    "Activity history",
    "Review recent account activity."
  ],
  connectionPage: [
    "Patient connection",
    "Connect to a patient using their Firebase UID or QR code."
  ],
  notificationsPage: [
    "Notifications",
    "Review recent activity."
  ],
  profilePage: [
    "My profile",
    "Manage your account."
  ]
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
  if (!state.user) {
    throw new Error("You are not signed in.");
  }

  return `users/${state.user.uid}/${path}`;
};

const patientPath = (uid, path) => {
  if (!uid) {
    throw new Error("Please select a connected patient.");
  }

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

  if (element) {
    element.className = "message";
  }
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

  if ($("pageTitle")) {
    $("pageTitle").textContent = pages[id][0];
  }

  if ($("pageSubtitle")) {
    $("pageSubtitle").textContent = pages[id][1];
  }

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

  if (hours > 23 || minutes > 59) {
    return "Time not set";
  }

  return new Date(2000, 0, 1, hours, minutes)
    .toLocaleTimeString("en-PH", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true
    });
}

function formatStamp(timestamp) {
  const value = Number(timestamp);

  if (!Number.isFinite(value) || value <= 0) {
    return "Time unavailable";
  }

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

      showMessage(
        "pageMessage",
        `Unable to load ${path}: ${error.message}`,
        "error"
      );
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
    .map(([id, item]) => ({
      id,
      ...item
    }))
    .sort((a, b) =>
      Number(b.timestamp || 0) - Number(a.timestamp || 0)
    );
}

/* =========================================================
   CONNECTED PATIENTS
   ========================================================= */

function patientIsActive(patient) {
  if (!patient || typeof patient !== "object") {
    return false;
  }

  const status = String(
    patient.status || ""
  ).toLowerCase().trim();

  if (!status) return true;

  return [
    "active",
    "approved",
    "connected"
  ].includes(status);
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

      if (
        patient.patientUid &&
        patient.patientUid !== uid
      ) {
        return false;
      }

      return patientIsActive(patient);
    });
}

function buildPatientOptions(selectedUid = "") {
  return `
    <option value="">Select a connected patient</option>

    ${getConnectedPatients().map(([uid, patient]) => `
      <option
        value="${escapeHTML(uid)}"
        ${uid === selectedUid ? "selected" : ""}
      >
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
      message.textContent =
        "No approved patients are connected. Connect to a patient first.";
    }

    setReminderMedicineOptions(
      [],
      "Connect to a patient first."
    );

    return;
  }

  select.disabled = false;

  if (patients.some(([uid]) => uid === previousUid)) {
    select.value = previousUid;
  } else {
    select.value = "";
  }

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

  if (
    !uid ||
    !patient ||
    !patientIsActive(patient)
  ) {
    state.selectedPatientUid = null;
    state.reminders = {};

    stopList(state.patientUnsubscribers);

    renderReminders();
    return;
  }

  if (state.selectedPatientUid === uid) {
    return;
  }

  state.selectedPatientUid = uid;
  state.reminders = {};

  stopList(state.patientUnsubscribers);

  renderReminders();

  const remindersPath =
    `users/${uid}/reminders`;

  const listener = onValue(
    ref(db, remindersPath),

    snapshot => {
      if (state.selectedPatientUid !== uid) {
        return;
      }

      state.reminders = snapshot.val() || {};

      renderReminders();
    },

    error => {
      console.error(
        "Patient reminders Firebase error:",
        error
      );

      showMessage(
        "pageMessage",
        `Unable to load patient reminders: ${error.message}`,
        "error"
      );
    }
  );

  state.patientUnsubscribers.push(listener);

  console.log(
    "Listening to patient reminders:",
    remindersPath
  );
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

  if (!patients.some(([uid]) =>
    uid === state.selectedPatientUid
  )) {
    selectPatient(patients[0][0]);
  }
}

$("reminderPatient")?.addEventListener("change", event => {
  const uid = event.target.value;
  const patient = state.connectedPatients?.[uid];

  if (!uid || !patient || !patientIsActive(patient)) {
    selectPatient(null);

    setReminderMedicineOptions(
      [],
      "Select a patient first."
    );

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

  select.innerHTML = `
    <option value="">
      ${escapeHTML(placeholder)}
    </option>
  `;

  select.disabled = true;

  if (!Array.isArray(medicines) || !medicines.length) {
    return;
  }

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
    setReminderMedicineOptions(
      [],
      "Select a patient first."
    );

    return;
  }

  if (!patientIsActive(state.connectedPatients?.[patientUid])) {
    setReminderMedicineOptions(
      [],
      "Patient is not connected."
    );

    return;
  }

  const entries = Object.entries(state.medicines || {});

  if (!entries.length) {
    setReminderMedicineOptions(
      [],
      "Add a medicine to your inventory first."
    );

    return;
  }

  const previous = $("reminderMedicine")?.value || "";

  setReminderMedicineOptions(
    entries,
    "Choose a medicine"
  );

  if (state.medicines[previous]) {
    $("reminderMedicine").value = previous;
  }
}

/* =========================================================
   COMPARTMENT SELECTOR — NEW
   ========================================================= */

function ensureCompartmentSelector() {
  const medicineSelect = $("reminderMedicine");

  if (!medicineSelect) return;

  if ($("reminderCompartment")) return;

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
    ${Array.from(
      { length: COMPARTMENT_COUNT },
      (_, index) => `
        <option value="${index + 1}">
          Compartment ${index + 1}
        </option>
      `
    ).join("")}
  `;

  wrapper.appendChild(label);
  wrapper.appendChild(select);

  medicineSelect.insertAdjacentElement(
    "afterend",
    wrapper
  );
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
    .filter(day =>
      Number.isInteger(day) &&
      day >= 0 &&
      day <= 6
    )
    .sort((a, b) => a - b)
    .map(day => DAYS[day])
    .join(", ");
}

/* =========================================================
   MEDICINE DISPLAY
   ========================================================= */

function renderMedicines() {
  const entries = Object.entries(state.medicines || {});

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
                <h3>
                  ${escapeHTML(medicine.name || "Unnamed medicine")}
                </h3>

                <p>
                  Strength: ${escapeHTML(medicine.dosage || "Not provided")}
                </p>

                <p>Stock: ${quantity} units</p>

                ${lowStock
                  ? `
                    <p style="color:#b42318;font-weight:700">
                      Refill needed
                    </p>
                  `
                  : ""
                }

                ${medicine.instructions
                  ? `
                    <p>
                      Instructions:
                      ${escapeHTML(medicine.instructions)}
                    </p>
                  `
                  : ""
                }

                ${medicine.notes
                  ? `
                    <p>
                      Notes:
                      ${escapeHTML(medicine.notes)}
                    </p>
                  `
                  : ""
                }

                ${medicine.detailsVerified
                  ? `
                    <p style="color:#175638">
                      ✓ Details verified
                    </p>
                  `
                  : ""
                }
              </div>

              <div class="record-actions">
                <button
                  type="button"
                  class="btn btn-secondary"
                  data-edit-med="${escapeHTML(id)}"
                >
                  Edit
                </button>

                <button
                  type="button"
                  class="btn btn-secondary"
                  data-stock-med="${escapeHTML(id)}"
                >
                  ＋ Refill
                </button>

                <button
                  type="button"
                  class="btn btn-danger"
                  data-del-med="${escapeHTML(id)}"
                >
                  Delete
                </button>
              </div>
            </article>
          `;
        }).join("")
      : emptyState(
          "No medicines in your inventory yet. Add your first medicine."
        );
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
      Number(medicine.quantity ?? 0) <=
      Number(medicine.refillAt ?? 5)
    );

  if ($("refillCount")) {
    $("refillCount").textContent = entries.length;
  }

  if (!$("refillList")) return;

  $("refillList").innerHTML = entries.length
    ? entries.map(([id, medicine]) => `
        <article class="record">
          <div class="record-main">
            <h3>
              ${escapeHTML(medicine.name || "Unnamed medicine")}
            </h3>

            <p>
              Remaining: ${Number(medicine.quantity ?? 0)} units
            </p>

            <p>
              Refill alert level:
              ${Number(medicine.refillAt ?? 5)} units
            </p>
          </div>

          <button
            type="button"
            class="btn btn-primary"
            data-stock-med="${escapeHTML(id)}"
          >
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
    .sort((a, b) =>
      String(a[1].time || "").localeCompare(
        String(b[1].time || "")
      )
    );

  if ($("reminderCount")) {
    $("reminderCount").textContent = entries.length;
  }

  if (!$("reminderList")) return;

  const patientUid = state.selectedPatientUid;
  const patient = state.connectedPatients?.[patientUid];

  $("reminderList").innerHTML = entries.length
    ? entries.map(([id, reminder]) => {
        const recurring = reminder.recurrence === "weekly";

        const snapshot =
          reminder.medicineSnapshot ||
          reminder.medicineDetails ||
          {};

        const displayMedicineName =
          snapshot.name ||
          reminder.medicineName ||
          medicineName(reminder.medicineId);

        const displayDosage =
          snapshot.dosage ||
          reminder.medicineDosage ||
          "";

        const compartment =
          reminder.compartment ??
          snapshot.compartment ??
          "Not assigned";

        return `
          <article class="record">
            <div class="record-main">
              <h3>
                ${escapeHTML(displayMedicineName)}
              </h3>

              ${displayDosage
                ? `<p>Strength: ${escapeHTML(displayDosage)}</p>`
                : ""
              }

              <p>
                Patient:
                ${escapeHTML(
                  patient
                    ? patientDisplayName(patientUid, patient)
                    : "Selected patient"
                )}
              </p>

              <p>
                ${recurring
                  ? `Every week: ${escapeHTML(dayNames(reminder.daysOfWeek))}`
                  : `Date: ${escapeHTML(formatDate(reminder.date))}`
                }
              </p>

              <p>
                Time: ${escapeHTML(formatTime(reminder.time))}
              </p>

              ${reminder.dose
                ? `<p>Dose: ${escapeHTML(reminder.dose)}</p>`
                : ""
              }

              <p>
                Assigned compartment:
                ${escapeHTML(compartment)}
              </p>

              ${snapshot.instructions
                ? `
                  <p>
                    Instructions:
                    ${escapeHTML(snapshot.instructions)}
                  </p>
                `
                : ""
              }

              ${reminder.notes
                ? `<p>Notes: ${escapeHTML(reminder.notes)}</p>`
                : ""
              }

              <p>
                Status:
                ${escapeHTML(reminder.status || "active")}
              </p>
            </div>

            <div class="record-actions">
              <button
                type="button"
                class="btn btn-secondary"
                data-edit-rem="${escapeHTML(id)}"
              >
                Edit
              </button>

              <button
                type="button"
                class="btn btn-danger"
                data-del-rem="${escapeHTML(id)}"
              >
                Delete
              </button>
            </div>
          </article>
        `;
      }).join("")
    : emptyState(
        patientUid
          ? "No reminders created for this patient yet."
          : "Select a connected patient to view their reminders."
      );
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
              <h3>
                ${escapeHTML(activity.action || "Activity")}
              </h3>

              <p>
                ${escapeHTML(activity.detail || "")}
              </p>

              <p class="muted">
                ${escapeHTML(formatStamp(activity.timestamp))}
              </p>
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
              <h3>
                ${escapeHTML(activity.action || "Activity")}
              </h3>

              <p>
                ${escapeHTML(activity.detail || "")}
              </p>

              <p class="muted">
                ${escapeHTML(formatStamp(activity.timestamp))}
              </p>
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
  if ($("medicineFormPanel")) {
    $("medicineFormPanel").hidden = !open;
  }
}

function resetMedicineForm() {
  $("medicineForm")?.reset();

  if ($("medicineId")) {
    $("medicineId").value = "";
  }

  if ($("medicineQuantity")) {
    $("medicineQuantity").value = "0";
  }

  if ($("medicineRefillAt")) {
    $("medicineRefillAt").value = "5";
  }

  if ($("medicineFormTitle")) {
    $("medicineFormTitle").textContent = "Add medicine";
  }

  const button = $("medicineForm")
    ?.querySelector('button[type="submit"]');

  if (button) {
    button.textContent = "Save medicine";
  }

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

  const refillAt = Number(
    $("medicineRefillAt")?.value ?? 5
  );

  const verified = $("detailsVerified");

  if (!name || !dosage) {
    showMessage(
      "pageMessage",
      "Enter the medicine name and strength/dosage.",
      "error"
    );
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
    showMessage(
      "pageMessage",
      "Enter valid whole-number stock quantities.",
      "error"
    );
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

  const button = $("medicineForm")
    ?.querySelector('button[type="submit"]');

  setButtonBusy(button, true, "Saving…");

  try {
    const timestamp = Date.now();

    const record = {
      name,
      dosage,
      quantity,
      refillAt,

      instructions:
        $("medicineInstructions")?.value.trim() || "",

      notes:
        $("medicineNotes")?.value.trim() || "",

      detailsVerified: Boolean(verified?.checked),

      updatedAt: timestamp
    };

    if (id) {
      await update(
        ref(db, accountPath(`medicines/${id}`)),
        record
      );
    } else {
      record.createdAt = timestamp;
      record.createdBy = state.user.uid;

      const newMedicineRef = push(
        ref(db, accountPath("medicines"))
      );

      await set(newMedicineRef, record);
    }

    await logActivity(
      id ? "Medicine updated" : "Medicine added",
      `${name} — ${dosage}`
    );

    resetMedicineForm();

    showMessage(
      "pageMessage",
      "Medicine saved to your inventory."
    );

  } catch (error) {
    console.error("Saving medicine failed:", error);

    showMessage(
      "pageMessage",
      `Unable to save medicine: ${error.message}`,
      "error"
    );

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

  $("medicineInstructions").value =
    medicine.instructions || "";

  $("medicineNotes").value =
    medicine.notes || "";

  if ($("detailsVerified")) {
    $("detailsVerified").checked =
      Boolean(medicine.detailsVerified);
  }

  if ($("medicineFormTitle")) {
    $("medicineFormTitle").textContent = "Edit medicine";
  }

  const button = $("medicineForm")
    ?.querySelector('button[type="submit"]');

  if (button) {
    button.textContent = "Update medicine";
  }

  medicinePanel(true);
  $("medicineName")?.focus();
});

$("refillList")?.addEventListener("click", async event => {
  const button = event.target.closest("[data-stock-med]");

  if (button) {
    await recordRefill(button.dataset.stockMed);
  }
});

/* =========================================================
   RECORD MEDICINE REFILL
   ========================================================= */

async function recordRefill(id) {
  const medicine = state.medicines[id];

  if (!medicine || !state.user || state.busy) return;

  const input = prompt(
    `How many units are being added to ${medicine.name}?`,
    "30"
  );

  if (input === null) return;

  const amount = Number(input);

  if (
    !Number.isInteger(amount) ||
    amount <= 0 ||
    amount > 100000
  ) {
    showMessage(
      "pageMessage",
      "Enter a positive whole number up to 100,000.",
      "error"
    );
    return;
  }

  const current = Number(medicine.quantity ?? 0);

  if (current + amount > 100000) {
    showMessage(
      "pageMessage",
      "The resulting stock quantity is too large.",
      "error"
    );
    return;
  }

  state.busy = true;

  try {
    const newQuantity = current + amount;
    const timestamp = Date.now();

    await update(
      ref(db, accountPath(`medicines/${id}`)),
      {
        quantity: newQuantity,
        updatedAt: timestamp
      }
    );

    await set(
      push(ref(db, accountPath("refills"))),
      {
        medicineId: id,
        medicineName: medicine.name || "",
        amount,
        previousQuantity: current,
        newQuantity,
        recordedBy: state.user.uid,
        timestamp
      }
    );

    await logActivity(
      "Medicine refilled",
      `${medicine.name}: added ${amount} units. New stock: ${newQuantity}.`
    );

    showMessage(
      "pageMessage",
      "Medicine stock updated successfully."
    );

  } catch (error) {
    console.error(error);

    showMessage(
      "pageMessage",
      `Unable to record refill: ${error.message}`,
      "error"
    );

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

  if (!confirm(
    `Delete ${medicine.name} from your medicine inventory?`
  )) {
    return;
  }

  state.busy = true;

  try {
    await remove(
      ref(db, accountPath(`medicines/${id}`))
    );

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

    showMessage(
      "pageMessage",
      `Unable to delete medicine: ${error.message}`,
      "error"
    );

  } finally {
    state.busy = false;
  }
}

/* =========================================================
   REMINDER FORM
   ========================================================= */

function reminderPanel(open) {
  if ($("reminderFormPanel")) {
    $("reminderFormPanel").hidden = !open;
  }
}

function updateRecurrenceFields() {
  const weekly =
    $("reminderRecurrence")?.value === "weekly";

  if ($("reminderDateField")) {
    $("reminderDateField").hidden = weekly;
  }

  if ($("reminderDaysField")) {
    $("reminderDaysField").hidden = !weekly;
  }

  if ($("reminderDate")) {
    $("reminderDate").required = !weekly;
  }
}

function resetReminderForm() {
  $("reminderForm")?.reset();

  // Make sure the compartment selector exists.
  ensureCompartmentSelector();

  if ($("reminderId")) {
    $("reminderId").value = "";
  }

  if ($("reminderRecurrence")) {
    $("reminderRecurrence").value = "once";
  }

  if ($("reminderTime")) {
    $("reminderTime").value = "08:00";
  }

  if ($("reminderDate")) {
    $("reminderDate").value = "";
  }

  if ($("reminderCompartment")) {
    $("reminderCompartment").value = "";
  }

  if ($("reminderFormTitle")) {
    $("reminderFormTitle").textContent = "Add reminder";
  }

  const button = $("reminderForm")
    ?.querySelector('button[type="submit"]');

  if (button) {
    button.textContent = "Save reminder";
  }

  populateReminderPatientSelector();

  setReminderMedicineOptions(
    [],
    "Select a patient first."
  );

  reminderPanel(false);
  updateRecurrenceFields();
  hideMessage("pageMessage");
}

$("reminderRecurrence")?.addEventListener(
  "change",
  updateRecurrenceFields
);

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

$("cancelReminderButton")?.addEventListener(
  "click",
  resetReminderForm
);

/* =========================================================
   CREATE / UPDATE PATIENT REMINDER

   COMPARTMENT FIX:
   - Saves reminder.compartment
   - Saves medicineSnapshot.compartment
   - Requires a valid compartment from 1 to 7
   ========================================================= */

$("reminderForm")?.addEventListener("submit", async event => {
  event.preventDefault();

  if (!state.user || state.busy) return;

  ensureCompartmentSelector();

  const patientUid =
    $("reminderPatient")?.value || "";

  const patient =
    state.connectedPatients?.[patientUid];

  if (
    !patientUid ||
    !patient ||
    !patientIsActive(patient)
  ) {
    showMessage(
      "pageMessage",
      "Please select an approved connected patient.",
      "error"
    );

    $("reminderPatient")?.focus();
    return;
  }

  const medicineId =
    $("reminderMedicine")?.value || "";

  const selectedMedicine =
    state.medicines?.[medicineId];

  const recurrence =
    $("reminderRecurrence")?.value || "once";

  const date =
    $("reminderDate")?.value || "";

  const time =
    $("reminderTime")?.value || "";

  const dose =
    $("reminderDose")?.value.trim() || "";

  const notes =
    $("reminderNotes")?.value.trim() || "";

  // NEW: Read the selected compartment.
  const compartment = Number(
    $("reminderCompartment")?.value
  );

  if (!selectedMedicine) {
    showMessage(
      "pageMessage",
      "Choose a medicine from your inventory.",
      "error"
    );

    $("reminderMedicine")?.focus();
    return;
  }

  // NEW: Compartment validation.
  if (
    !Number.isInteger(compartment) ||
    compartment < 1 ||
    compartment > COMPARTMENT_COUNT
  ) {
    showMessage(
      "pageMessage",
      "Please assign a valid compartment from 1 to 7.",
      "error"
    );

    $("reminderCompartment")?.focus();
    return;
  }

  if (!dose) {
    showMessage(
      "pageMessage",
      "Enter the prescribed dose.",
      "error"
    );

    $("reminderDose")?.focus();
    return;
  }

  if (!/^\d{2}:\d{2}$/.test(time)) {
    showMessage(
      "pageMessage",
      "Choose a valid reminder time.",
      "error"
    );
    return;
  }

  const [hours, minutes] = time.split(":").map(Number);

  if (hours > 23 || minutes > 59) {
    showMessage(
      "pageMessage",
      "The reminder time is invalid.",
      "error"
    );
    return;
  }

  if (!["once", "weekly"].includes(recurrence)) {
    showMessage(
      "pageMessage",
      "Choose a valid recurrence.",
      "error"
    );
    return;
  }

  if (
    recurrence === "once" &&
    (!date || date < localDate())
  ) {
    showMessage(
      "pageMessage",
      "Choose today or a future date.",
      "error"
    );
    return;
  }

  const daysOfWeek = [
    ...document.querySelectorAll(
      'input[name="reminderDay"]:checked'
    )
  ]
    .map(input => Number(input.value))
    .filter(day =>
      Number.isInteger(day) &&
      day >= 0 &&
      day <= 6
    );

  if (
    recurrence === "weekly" &&
    !daysOfWeek.length
  ) {
    showMessage(
      "pageMessage",
      "Select at least one day for the weekly schedule.",
      "error"
    );
    return;
  }

  const id =
    $("reminderId")?.value || "";

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

  const button = $("reminderForm")
    ?.querySelector('button[type="submit"]');

  setButtonBusy(button, true, "Saving…");

  try {
    const timestamp = Date.now();

    // Medicine information copied into patient reminder.
    const medicineSnapshot = {
      medicineId,

      name: selectedMedicine.name || "",

      dosage: selectedMedicine.dosage || "",

      // NEW: Save compartment in medicine snapshot.
      compartment,

      instructions:
        selectedMedicine.instructions || "",

      notes:
        selectedMedicine.notes || "",

      detailsVerified:
        Boolean(selectedMedicine.detailsVerified),

      snapshotUpdatedAt: timestamp
    };

    const record = {
      patientUid,

      patientName:
        patientDisplayName(patientUid, patient),

      caregiverUid: state.user.uid,

      caregiverName:
        state.user.displayName ||
        state.profile.displayName ||
        state.user.email ||
        "Authorized Person",

      medicineId,

      medicineName:
        selectedMedicine.name || "",

      medicineDosage:
        selectedMedicine.dosage || "",

      // NEW: Main compartment field read by ESP32.
      compartment,

      medicineSnapshot,

      recurrence,

      date:
        recurrence === "once"
          ? date
          : null,

      daysOfWeek:
        recurrence === "weekly"
          ? [...new Set(daysOfWeek)].sort(
              (a, b) => a - b
            )
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
      await update(
        ref(
          db,
          `users/${patientUid}/reminders/${id}`
        ),
        record
      );

    } else {
      const newReminderRef = push(
        ref(
          db,
          `users/${patientUid}/reminders`
        )
      );

      reminderId = newReminderRef.key;

      record.createdAt = timestamp;

      await set(newReminderRef, record);
    }

    // Verify the reminder was actually saved.
    const savedSnapshot = await get(
      ref(
        db,
        `users/${patientUid}/reminders/${reminderId}`
      )
    );

    if (!savedSnapshot.exists()) {
      throw new Error(
        "The reminder could not be verified in Firebase."
      );
    }

    const savedReminder = savedSnapshot.val();

    if (
      savedReminder.caregiverUid !== state.user.uid ||
      savedReminder.patientUid !== patientUid ||
      savedReminder.status !== "active" ||
      Number(savedReminder.compartment) !== compartment ||
      Number(savedReminder.medicineSnapshot?.compartment) !== compartment
    ) {
      throw new Error(
        "The saved reminder or compartment information does not match."
      );
    }

    const scheduleDescription =
      recurrence === "weekly"
        ? `Every week on ${dayNames(record.daysOfWeek)} at ${formatTime(time)}`
        : `One time on ${formatDate(date)} at ${formatTime(time)}`;

    await logActivity(
      id
        ? "Patient reminder updated"
        : "Patient reminder added",

      `${selectedMedicine.name} — ${scheduleDescription}. Compartment ${compartment}. Patient: ${patientDisplayName(patientUid, patient)}`,

      patientUid
    );

    if (state.selectedPatientUid !== patientUid) {
      selectPatient(patientUid);
    }

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
    console.error(
      "Saving patient reminder failed:",
      error
    );

    showMessage(
      "pageMessage",
      `Unable to save reminder: ${error.message}`,
      "error"
    );

  } finally {
    state.busy = false;
    setButtonBusy(button, false);
  }
});

/* =========================================================
   EDIT / DELETE PATIENT REMINDERS
   ========================================================= */

$("reminderList")?.addEventListener("click", async event => {
  const edit =
    event.target.closest("[data-edit-rem]");

  const del =
    event.target.closest("[data-del-rem]");

  const patientUid =
    state.selectedPatientUid;

  if (!patientUid) {
    showMessage(
      "pageMessage",
      "Select a connected patient first.",
      "error"
    );
    return;
  }

  /* DELETE REMINDER */

  if (del) {
    const id = del.dataset.delRem;
    const reminder = state.reminders[id];

    if (!reminder) return;

    if (
      reminder.caregiverUid !== state.user.uid ||
      reminder.patientUid !== patientUid
    ) {
      showMessage(
        "pageMessage",
        "You cannot delete this reminder.",
        "error"
      );
      return;
    }

    if (!confirm("Delete this reminder?")) {
      return;
    }

    try {
      await remove(
        ref(
          db,
          patientPath(patientUid, `reminders/${id}`)
        )
      );

      await logActivity(
        "Patient reminder deleted",
        `Deleted the reminder for ${reminder.medicineName || "a medicine"}.`,
        patientUid
      );

      showMessage(
        "pageMessage",
        "Reminder deleted successfully."
      );

    } catch (error) {
      console.error(error);

      showMessage(
        "pageMessage",
        `Unable to delete reminder: ${error.message}`,
        "error"
      );
    }

    return;
  }

  /* EDIT REMINDER */

  if (!edit) return;

  const id = edit.dataset.editRem;
  const reminder = state.reminders[id];

  if (!reminder) return;

  if (
    reminder.caregiverUid !== state.user.uid ||
    reminder.patientUid !== patientUid
  ) {
    showMessage(
      "pageMessage",
      "You cannot edit this reminder.",
      "error"
    );
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

  if ($("reminderPatient")) {
    $("reminderPatient").value = patientUid;
  }

  selectPatient(patientUid);

  reminderPanel(true);

  updateReminderMedicineDropdown();

  // Ensure selector exists before restoring its value.
  ensureCompartmentSelector();

  $("reminderId").value = id;

  $("reminderMedicine").value =
    reminder.medicineId || "";

  // NEW: Restore previously assigned compartment.
  const savedCompartment =
    reminder.compartment ??
    reminder.medicineSnapshot?.compartment ??
    "";

  $("reminderCompartment").value =
    String(savedCompartment);

  $("reminderRecurrence").value =
    reminder.recurrence || "once";

  $("reminderDate").value =
    reminder.date || "";

  $("reminderTime").value =
    reminder.time || "08:00";

  $("reminderDose").value =
    reminder.dose || "";

  $("reminderNotes").value =
    reminder.notes || "";

  const selectedDays =
    Array.isArray(reminder.daysOfWeek)
      ? reminder.daysOfWeek.map(Number)
      : [];

  document.querySelectorAll(
    'input[name="reminderDay"]'
  ).forEach(input => {
    input.checked = selectedDays.includes(
      Number(input.value)
    );
  });

  updateRecurrenceFields();

  if ($("reminderFormTitle")) {
    $("reminderFormTitle").textContent =
      "Edit reminder";
  }

  const button = $("reminderForm")
    ?.querySelector('button[type="submit"]');

  if (button) {
    button.textContent = "Update reminder";
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

$("openConnection")?.addEventListener("click", () => {
  showPage("connectionPage");
});

$("mobileConnectionButton")?.addEventListener("click", () => {
  showPage("connectionPage");
});

$("openNotifications")?.addEventListener("click", () => {
  showPage("notificationsPage");
});

$("openProfile")?.addEventListener("click", () => {
  showPage("profilePage");
});

$("profileButton")?.addEventListener("click", () => {
  showPage("profilePage");
});

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
      if (patientQrScanner.isScanning) {
        await patientQrScanner.stop();
      }

      await patientQrScanner.clear();

    } catch (error) {
      console.warn("QR scanner stop:", error);
    }

    patientQrScanner = null;
  }

  if ($("patientQrReader")) {
    $("patientQrReader").hidden = true;
  }

  if ($("stopPatientScanner")) {
    $("stopPatientScanner").hidden = true;
  }
}

$("startPatientScanner")?.addEventListener(
  "click",
  async () => {
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

      if (reader) {
        reader.hidden = false;
      }

      if ($("stopPatientScanner")) {
        $("stopPatientScanner").hidden = false;
      }

      patientQrScanner =
        new Html5Qrcode("patientQrReader");

      await patientQrScanner.start(
        { facingMode: "environment" },

        {
          fps: 10,
          qrbox: {
            width: 230,
            height: 230
          }
        },

        async decodedText => {
          const uid = cleanPatientUid(decodedText);

          if ($("connectionCode")) {
            $("connectionCode").value = uid;
          }

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
  }
);

$("stopPatientScanner")?.addEventListener(
  "click",
  stopPatientQrScanner
);

/* =========================================================
   SEND PATIENT CONNECTION REQUEST
   ========================================================= */

$("connectionForm")?.addEventListener(
  "submit",
  async event => {
    event.preventDefault();

    if (!state.user || !auth.currentUser) {
      showMessage(
        "connectionMessage",
        "Please sign in again.",
        "error"
      );
      return;
    }

    const patientUid =
      cleanPatientUid($("connectionCode")?.value);

    const caregiverUid =
      state.user.uid;

    if (
      !patientUid ||
      patientUid.length < 20 ||
      patientUid.length > 128
    ) {
      showMessage(
        "connectionMessage",
        "Enter or scan a valid Firebase patient UID.",
        "error"
      );
      return;
    }

    if (patientUid === caregiverUid) {
      showMessage(
        "connectionMessage",
        "You cannot connect your account to itself.",
        "error"
      );
      return;
    }

    const button = $("connectionForm")
      ?.querySelector('button[type="submit"]');

    hideMessage("connectionMessage");

    setButtonBusy(
      button,
      true,
      "Sending request…"
    );

    try {
      await auth.currentUser.getIdToken(true);

      const requestRef = ref(
        db,
        `users/${patientUid}/connectionRequests/${caregiverUid}`
      );

      const existing = await get(requestRef);

      if (existing.exists()) {
        const status = String(
          existing.val()?.status || ""
        ).toLowerCase();

        if (status === "pending") {
          showMessage(
            "connectionMessage",
            "A request is already pending. Please wait for the patient's approval."
          );
          return;
        }

        if ([
          "approved",
          "active",
          "connected"
        ].includes(status)) {
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

        caregiverEmail:
          state.user.email || "",

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
      console.error(
        "Connection request failed:",
        error
      );

      let message =
        `Unable to send the connection request: ${error.message}`;

      if (
        error.code === "PERMISSION_DENIED" ||
        error.code === "database/permission-denied"
      ) {
        message =
          "Firebase denied this request. Check your database rules and patient connection permissions.";

      } else if (!navigator.onLine) {
        message =
          "You appear to be offline. Check your internet connection.";

      } else if (
        error.code === "auth/user-token-expired"
      ) {
        message =
          "Your session has expired. Please sign in again.";
      }

      showMessage(
        "connectionMessage",
        message,
        "error"
      );

    } finally {
      setButtonBusy(button, false);
    }
  }
);

/* =========================================================
   PROFILE
   ========================================================= */

function loadProfileForm(profile = {}) {
  const displayName =
    state.user?.displayName || "";

  const nameParts =
    displayName.split(" ");

  if ($("profileFirstName")) {
    $("profileFirstName").value =
      profile.firstName ||
      nameParts[0] ||
      "";
  }

  if ($("profileLastName")) {
    $("profileLastName").value =
      profile.lastName ||
      nameParts.slice(1).join(" ");
  }

  if ($("profileEmail")) {
    $("profileEmail").textContent =
      state.user?.email || "";
  }
}

$("profileForm")?.addEventListener(
  "submit",
  async event => {
    event.preventDefault();

    if (!state.user || state.busy) return;

    const firstName =
      $("profileFirstName")?.value.trim() || "";

    const lastName =
      $("profileLastName")?.value.trim() || "";

    if (!firstName) {
      showMessage(
        "profileMessage",
        "Enter your first name.",
        "error"
      );
      return;
    }

    const displayName = [
      firstName,
      lastName
    ].filter(Boolean).join(" ");

    const button = $("profileForm")
      ?.querySelector('button[type="submit"]');

    state.busy = true;

    setButtonBusy(
      button,
      true,
      "Saving…"
    );

    try {
      await updateProfile(
        state.user,
        { displayName }
      );

      await update(
        ref(db, accountPath("profile")),
        {
          firstName,
          lastName,
          displayName,
          email: state.user.email || "",
          updatedAt: Date.now()
        }
      );

      state.profile = {
        ...state.profile,
        firstName,
        lastName,
        displayName
      };

      if ($("displayName")) {
        $("displayName").textContent = displayName;
      }

      if ($("avatar")) {
        $("avatar").textContent =
          firstName[0].toUpperCase();
      }

      await logActivity(
        "Profile updated",
        "Account profile information updated."
      );

      showMessage(
        "profileMessage",
        "Profile updated successfully."
      );

    } catch (error) {
      console.error(
        "Profile update failed:",
        error
      );

      showMessage(
        "profileMessage",
        `Unable to save your profile: ${error.message}`,
        "error"
      );

    } finally {
      state.busy = false;
      setButtonBusy(button, false);
    }
  }
);

/* =========================================================
   PASSWORD CHANGE
   ========================================================= */

$("passwordForm")?.addEventListener(
  "submit",
  async event => {
    event.preventDefault();

    if (!state.user || state.busy) return;

    const current =
      $("currentPassword")?.value || "";

    const next =
      $("newPassword")?.value || "";

    const confirmNext =
      $("confirmPassword")?.value || "";

    if (next.length < 8) {
      showMessage(
        "passwordMessage",
        "New password must contain at least 8 characters.",
        "error"
      );
      return;
    }

    if (next !== confirmNext) {
      showMessage(
        "passwordMessage",
        "New passwords do not match.",
        "error"
      );
      return;
    }

    if (next === current) {
      showMessage(
        "passwordMessage",
        "Choose a different password.",
        "error"
      );
      return;
    }

    if (!state.user.email) {
      showMessage(
        "passwordMessage",
        "This account has no email address for password verification.",
        "error"
      );
      return;
    }

    const button = $("passwordForm")
      ?.querySelector('button[type="submit"]');

    state.busy = true;

    setButtonBusy(
      button,
      true,
      "Updating…"
    );

    try {
      const credential =
        EmailAuthProvider.credential(
          state.user.email,
          current
        );

      await reauthenticateWithCredential(
        state.user,
        credential
      );

      await updatePassword(
        state.user,
        next
      );

      $("passwordForm").reset();

      await logActivity(
        "Password changed",
        "Account password updated."
      );

      showMessage(
        "passwordMessage",
        "Password updated successfully."
      );

    } catch (error) {
      console.error(
        "Password change failed:",
        error
      );

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

      showMessage(
        "passwordMessage",
        errorText,
        "error"
      );

    } finally {
      state.busy = false;
      setButtonBusy(button, false);
    }
  }
);

/* =========================================================
   LOGOUT
   ========================================================= */

$("logoutButton")?.addEventListener(
  "click",
  async () => {
    if (!confirm("Are you sure you want to log out?")) {
      return;
    }

    try {
      stopSubscriptions();

      await stopPatientQrScanner();

      await signOut(auth);

      window.location.replace("login.html");

    } catch (error) {
      console.error(
        "Logout failed:",
        error
      );

      showMessage(
        "pageMessage",
        `Unable to log out: ${error.message}`,
        "error"
      );
    }
  }
);

/* =========================================================
   AUTHENTICATION AND FIREBASE LISTENERS
   ========================================================= */

onAuthStateChanged(
  auth,
  async authenticatedUser => {
    stopSubscriptions();

    if (!authenticatedUser) {
      state.user = null;
      state.initializedUid = null;
      state.selectedPatientUid = null;

      window.location.replace("login.html");
      return;
    }

    if (
      state.initializedUid === authenticatedUser.uid
    ) {
      return;
    }

    state.user = authenticatedUser;

    state.initializedUid =
      authenticatedUser.uid;

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

      const profile =
        profileSnapshot.val() || {};

      state.profile = profile;

      const role = String(
        profile.role || ""
      ).toLowerCase().trim();

      if (![
        "authorized",
        "caregiver",
        "authorized_person"
      ].includes(role)) {
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
        [
          profile.firstName,
          profile.lastName
        ].filter(Boolean).join(" ") ||
        "My account";

      if ($("displayName")) {
        $("displayName").textContent = name;
      }

      if ($("avatar")) {
        $("avatar").textContent =
          name[0].toUpperCase();
      }

      if ($("welcomeTitle")) {
        $("welcomeTitle").textContent =
          `Welcome, ${name.split(" ")[0]}!`;
      }

      if ($("profileEmail")) {
        $("profileEmail").textContent =
          authenticatedUser.email || "";
      }

      loadProfileForm(profile);

      /* LOAD MEDICINES */

      subscribeAccount(
        "medicines",
        value => {
          state.medicines = value;
          renderMedicines();
        }
      );

      /* LOAD REFILLS */

      subscribeAccount(
        "refills",
        value => {
          state.refills = value;
        }
      );

      /* LOAD ACTIVITY */

      subscribeAccount(
        "activity",
        value => {
          state.activities = value;
          renderHistory();
        }
      );

      /* LOAD CONNECTED PATIENTS */

      subscribeAccount(
        "connectedPatients",
        value => {
          state.connectedPatients = value || {};
          refreshPatientSelectors();
        }
      );

      // Create the compartment selector when the dashboard loads.
      ensureCompartmentSelector();

      updateRecurrenceFields();

      showPage("medicinesPage");

    } catch (error) {
      console.error(
        "Dashboard initialization failed:",
        error
      );

      state.initializedUid = null;

      showMessage(
        "pageMessage",
        `Unable to initialize the dashboard: ${error.message}`,
        "error"
      );
    }
  }
);

/* =========================================================
   CLEANUP
   ========================================================= */

window.addEventListener("beforeunload", () => {
  stopSubscriptions();
  stopPatientQrScanner();
});
