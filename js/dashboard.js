
import { auth, db } from "./firebaseConfig.js";

import {
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
  ref,
  get,
  set,
  push
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const $ = (id) => document.getElementById(id);

const loading = $("loading");
const app = $("app");
const errorBox = $("error");

let currentUser = null;
let medicines = {};
let reminders = {};
let historyRecords = {};

function showError(message) {
  errorBox.textContent = message;
  errorBox.style.display = "block";
}

function clearError() {
  errorBox.textContent = "";
  errorBox.style.display = "none";
}

function showDashboard() {
  loading.style.display = "none";
  app.style.display = "block";
}

function normalizeRole(role) {
  const value = String(role || "").toLowerCase().trim();

  if (["authorized", "caregiver"].includes(value)) {
    return "caregiver";
  }

  if (["patient", "medicine_taker"].includes(value)) {
    return "patient";
  }

  return "";
}

function userPath(child = "") {
  return `users/${currentUser.uid}${child ? "/" + child : ""}`;
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);

  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;

  return element;
}

function showEmpty(container, icon, title, description) {
  container.replaceChildren();

  const empty = makeElement("div", "empty");
  empty.append(
    makeElement("div", "empty-icon", icon),
    makeElement("h3", "", title),
    makeElement("p", "", description)
  );

  container.append(empty);
}

async function saveHistory(action, details) {
  const historyRef = push(ref(db, userPath("history")));

  await set(historyRef, {
    action,
    details,
    timestamp: new Date().toISOString()
  });
}

async function removeRecord(path, label, details) {
  if (!confirm(`Remove ${label}?`)) return;

  try {
    clearError();

    await set(ref(db, userPath(path)), null);
    await saveHistory(`${label} removed`, details);
    await loadRecords();
  } catch (error) {
    console.error("Remove error:", error);
    showError(
      "Unable to remove this record. Please check your Firebase database rules."
    );
  }
}

function renderMedicines() {
  const container = $("medicineList");
  const entries = Object.entries(medicines);

  $("medicineCount").textContent = entries.length;
  container.replaceChildren();

  if (entries.length === 0) {
    showEmpty(
      container,
      "💊",
      "No medicines added yet",
      "Select Add medicine to create your first record."
    );
    return;
  }

  entries.forEach(([id, medicine]) => {
    const row = makeElement("article", "record");
    const info = makeElement("div", "record-info");

    info.append(
      makeElement("strong", "", medicine.name || "Unnamed medicine"),
      makeElement("p", "", medicine.dose || "Dosage not specified")
    );

    if (medicine.notes) {
      info.append(makeElement("p", "", `Notes: ${medicine.notes}`));
    }

    const removeButton = makeElement("button", "remove-button", "Remove");
    removeButton.type = "button";

    removeButton.addEventListener("click", () => {
      removeRecord(`medicines/${id}`, "this medicine", medicine.name || "Medicine");
    });

    row.append(info, removeButton);
    container.append(row);
  });
}

function renderReminders() {
  const container = $("reminderList");
  const select = $("reminderMedicine");
  const entries = Object.entries(reminders);

  $("reminderCount").textContent = entries.length;
  container.replaceChildren();

  // Rebuild the medicine dropdown using saved medicines.
  select.replaceChildren();

  const defaultOption = makeElement("option", "", "Select a medicine");
  defaultOption.value = "";
  select.append(defaultOption);

  Object.entries(medicines).forEach(([id, medicine]) => {
    const option = makeElement("option", "", medicine.name || "Medicine");
    option.value = id;
    select.append(option);
  });

  if (entries.length === 0) {
    showEmpty(
      container,
      "🔔",
      "No reminders scheduled",
      "Add a medicine first, then create a reminder."
    );
    return;
  }

  entries.forEach(([id, reminder]) => {
    const row = makeElement("article", "record");
    const info = makeElement("div", "record-info");

    info.append(
      makeElement("strong", "", reminder.medicineName || "Medicine"),
      makeElement(
        "p",
        "",
        `Time: ${reminder.time || "Not set"}`
      ),
      makeElement(
        "p",
        "",
        `Start date: ${reminder.startDate || "Not set"}`
      )
    );

    const removeButton = makeElement("button", "remove-button", "Remove");
    removeButton.type = "button";

    removeButton.addEventListener("click", () => {
      removeRecord(
        `reminders/${id}`,
        "this reminder",
        reminder.medicineName || "Medicine"
      );
    });

    row.append(info, removeButton);
    container.append(row);
  });
}

function renderHistory() {
  const container = $("historyList");

  const entries = Object.values(historyRecords).sort((a, b) =>
    String(b.timestamp || "").localeCompare(String(a.timestamp || ""))
  );

  container.replaceChildren();

  if (entries.length === 0) {
    showEmpty(
      container,
      "📋",
      "No activity yet",
      "Medicine and reminder changes will appear here."
    );
    return;
  }

  entries.forEach(entry => {
    const row = makeElement("article", "record");
    const info = makeElement("div", "record-info");

    info.append(
      makeElement("strong", "", entry.action || "Activity"),
      makeElement("p", "", entry.details || "")
    );

    if (entry.timestamp) {
      const date = new Date(entry.timestamp);

      if (!Number.isNaN(date.getTime())) {
        info.append(
          makeElement("span", "record-date", date.toLocaleString())
        );
      }
    }

    row.append(info);
    container.append(row);
  });
}

async function loadRecords() {
  const [medicineSnapshot, reminderSnapshot, historySnapshot] =
    await Promise.all([
      get(ref(db, userPath("medicines"))),
      get(ref(db, userPath("reminders"))),
      get(ref(db, userPath("history")))
    ]);

  medicines = medicineSnapshot.val() || {};
  reminders = reminderSnapshot.val() || {};
  historyRecords = historySnapshot.val() || {};

  renderMedicines();
  renderReminders();
  renderHistory();
}

// Save a medicine.
$("addMedicineForm").addEventListener("submit", async event => {
  event.preventDefault();

  if (!currentUser) return;

  const name = $("medicineName").value.trim();
  const dose = $("medicineDose").value.trim();
  const notes = $("medicineNotes").value.trim();

  if (!name || !dose) {
    showError("Enter the medicine name and dosage.");
    return;
  }

  const submitButton = event.submitter;
  if (submitButton) submitButton.disabled = true;

  try {
    clearError();

    const newMedicineRef = push(ref(db, userPath("medicines")));

    await set(newMedicineRef, {
      name,
      dose,
      notes,
      createdAt: new Date().toISOString()
    });

    await saveHistory("Medicine added", `${name} — ${dose}`);

    $("addMedicineForm").reset();
    $("medicineForm").classList.remove("open");

    await loadRecords();
  } catch (error) {
    console.error("Save medicine error:", error);
    showError(
      "Could not save the medicine. Check your Firebase connection and database rules."
    );
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
});

// Save a reminder.
$("addReminderForm").addEventListener("submit", async event => {
  event.preventDefault();

  if (!currentUser) return;

  const medicineId = $("reminderMedicine").value;
  const time = $("reminderTime").value;
  const startDate = $("reminderStartDate").value;
  const medicine = medicines[medicineId];

  if (!medicine) {
    showError("Please select a saved medicine.");
    return;
  }

  if (!time || !startDate) {
    showError("Choose a reminder time and start date.");
    return;
  }

  const submitButton = event.submitter;
  if (submitButton) submitButton.disabled = true;

  try {
    clearError();

    const newReminderRef = push(ref(db, userPath("reminders")));

    await set(newReminderRef, {
      medicineId,
      medicineName: medicine.name,
      time,
      startDate,
      createdAt: new Date().toISOString()
    });

    await saveHistory(
      "Reminder created",
      `${medicine.name} at ${time}, starting ${startDate}`
    );

    $("addReminderForm").reset();
    $("reminderForm").classList.remove("open");

    await loadRecords();
  } catch (error) {
    console.error("Save reminder error:", error);
    showError(
      "Could not save the reminder. Check your Firebase connection and database rules."
    );
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
});

// Log out only when the caregiver clicks the button.
$("logoutButton").addEventListener("click", async () => {
  try {
    await signOut(auth);
    window.location.replace("login.html");
  } catch (error) {
    console.error("Logout error:", error);
    showError("Could not log out. Please try again.");
  }
});

// Wait for Firebase to restore the user's authentication session.
onAuthStateChanged(auth, async user => {
  if (!user) {
    window.location.replace("login.html");
    return;
  }

  currentUser = user;
  clearError();
  loading.style.display = "block";
  app.style.display = "none";

  try {
    const profileSnapshot = await get(ref(db, userPath()));
    const record = profileSnapshot.val();

    if (!record || !record.role) {
      showDashboard();
      showError(
        "Your account role is missing. Check the role field under users/" +
        user.uid + " in Firebase Realtime Database."
      );
      return;
    }

    const role = normalizeRole(record.role);

    if (!role) {
      showDashboard();
      showError(
        "Your account role is not recognized. Check the role saved in Firebase."
      );
      return;
    }

    // This page is for authorized persons/caregivers only.
    if (role !== "caregiver") {
      window.location.replace("patient-dashboard.html");
      return;
    }

    const profile = record.profile || {};
    const fullName =
      profile.fullName ||
      [profile.firstName, profile.lastName].filter(Boolean).join(" ") ||
      user.displayName ||
      "";

    $("welcomeTitle").textContent = fullName
      ? `Welcome, ${fullName}!`
      : "Welcome!";

    $("accountRole").textContent = "Caregiver dashboard";

    await loadRecords();

    showDashboard();
  } catch (error) {
    console.error("Dashboard loading error:", error);

    showDashboard();

    showError(
      "Could not load your dashboard. Check your Firebase database URL, " +
      "connection, and rules. " + (error.code || "")
    );
  }
});
