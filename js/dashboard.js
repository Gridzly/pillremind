
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

const loading = document.getElementById("loading");
const app = document.getElementById("app");
const errorBox = document.getElementById("error");

const welcomeTitle = document.getElementById("welcomeTitle");
const accountRole = document.getElementById("accountRole");

const medicineCount = document.getElementById("medicineCount");
const reminderCount = document.getElementById("reminderCount");

const medicineForm = document.getElementById("medicineForm");
const reminderForm = document.getElementById("reminderForm");

const medicineList = document.getElementById("medicineList");
const reminderList = document.getElementById("reminderList");
const historyList = document.getElementById("historyList");
const reminderMedicine = document.getElementById("reminderMedicine");

let currentUser = null;
let currentRole = "";
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

function normalizeRole(role) {
  if (role === "authorized" || role === "caregiver") {
    return "authorized";
  }

  if (role === "patient" || role === "medicine_taker") {
    return "patient";
  }

  return "";
}

function userPath(child = "") {
  return `users/${currentUser.uid}${child ? `/${child}` : ""}`;
}

async function saveHistory(action, details) {
  const entryRef = push(ref(db, userPath("history")));

  await set(entryRef, {
    action,
    details,
    timestamp: new Date().toISOString()
  });
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);

  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;

  return element;
}

function makeEmpty(container, icon, title, description) {
  container.replaceChildren();

  const empty = makeElement("div", "empty");
  empty.append(
    makeElement("div", "empty-icon", icon),
    makeElement("h3", "", title),
    makeElement("p", "muted", description)
  );

  container.append(empty);
}

function renderMedicines() {
  medicineList.replaceChildren();

  const entries = Object.entries(medicines);

  medicineCount.textContent = entries.length;

  if (!entries.length) {
    makeEmpty(
      medicineList,
      "💊",
      "No medicines added yet",
      "Use Add to create your first medicine record."
    );
    return;
  }

  for (const [id, medicine] of entries) {
    const row = makeElement("div", "record");
    const info = makeElement("div");
    const name = makeElement("strong", "", medicine.name || "Medicine");
    const dose = makeElement(
      "p",
      "muted",
      medicine.dose || "No dose instructions added"
    );
    info.append(name, dose);

    if (medicine.notes) {
      info.append(makeElement("p", "muted", medicine.notes));
    }

    const remove = makeElement("button", "logout", "Remove");
    remove.type = "button";

    remove.addEventListener("click", async () => {
      if (!confirm(`Remove ${medicine.name} from your medicine list?`)) {
        return;
      }

      try {
        clearError();

        await set(ref(db, userPath(`medicines/${id}`)), null);
        await saveHistory("Medicine removed", medicine.name);

        await loadRecords();
      } catch (error) {
        console.error(error);
        showError("Could not remove medicine. Please try again.");
      }
    });

    row.append(info, remove);
    medicineList.append(row);
  }
}

function renderReminders() {
  reminderList.replaceChildren();

  const entries = Object.entries(reminders);
  reminderCount.textContent = entries.length;

  reminderMedicine.replaceChildren();

  const defaultOption = makeElement(
    "option",
    "",
    "Select a saved medicine"
  );
  defaultOption.value = "";
  reminderMedicine.append(defaultOption);

  for (const [id, medicine] of Object.entries(medicines)) {
    const option = makeElement("option", "", medicine.name || "Medicine");
    option.value = id;
    reminderMedicine.append(option);
  }

  if (!entries.length) {
    makeEmpty(
      reminderList,
      "🔔",
      "No reminders scheduled",
      "Add a medicine first, then create a reminder."
    );
    return;
  }

  for (const [id, reminder] of entries) {
    const row = makeElement("div", "record");
    const info = makeElement("div");

    info.append(
      makeElement("strong", "", reminder.medicineName || "Medicine"),
      makeElement(
        "p",
        "muted",
        `${reminder.time || "No time"} · ${reminder.startDate || ""}`
      )
    );

    const remove = makeElement("button", "logout", "Remove");
    remove.type = "button";

    remove.addEventListener("click", async () => {
      if (!confirm("Remove this reminder?")) return;

      try {
        clearError();

        await set(ref(db, userPath(`reminders/${id}`)), null);
        await saveHistory(
          "Reminder removed",
          reminder.medicineName || "Medicine"
        );

        await loadRecords();
      } catch (error) {
        console.error(error);
        showError("Could not remove reminder. Please try again.");
      }
    });

    row.append(info, remove);
    reminderList.append(row);
  }
}

function renderHistory() {
  historyList.replaceChildren();

  const entries = Object.values(historyRecords)
    .sort((a, b) =>
      String(b.timestamp || "").localeCompare(String(a.timestamp || ""))
    );

  if (!entries.length) {
    makeEmpty(
      historyList,
      "📋",
      "No history yet",
      "Your medicine and reminder changes will appear here."
    );
    return;
  }

  for (const entry of entries) {
    const row = makeElement("div", "record");
    const info = makeElement("div");

    info.append(
      makeElement("strong", "", entry.action || "Activity"),
      makeElement("p", "muted", entry.details || "")
    );

    const date = entry.timestamp
      ? new Date(entry.timestamp).toLocaleString()
      : "";

    row.append(info, makeElement("span", "pill", date));
    historyList.append(row);
  }
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

document.querySelectorAll(".nav-button").forEach(button => {
  button.addEventListener("click", () => {
    const sectionName = button.dataset.section;

    document.querySelectorAll(".nav-button").forEach(item => {
      item.classList.remove("active");
      item.removeAttribute("aria-current");
    });

    button.classList.add("active");
    button.setAttribute("aria-current", "page");

    document.querySelectorAll(".section").forEach(section => {
      section.classList.remove("active");
    });

    document
      .getElementById(`${sectionName}Section`)
      .classList.add("active");

    clearError();
  });
});

document.getElementById("addMedicineButton").addEventListener("click", () => {
  medicineForm.hidden = !medicineForm.hidden;

  if (!medicineForm.hidden) {
    document.getElementById("medicineName").focus();
  }
});

document.getElementById("cancelMedicineButton").addEventListener("click", () => {
  medicineForm.reset();
  medicineForm.hidden = true;
});

medicineForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!currentUser) return;

  const name = document.getElementById("medicineName").value.trim();
  const dose = document.getElementById("medicineDose").value.trim();
  const notes = document.getElementById("medicineNotes").value.trim();

  if (!name) {
    showError("Enter a medicine name.");
    return;
  }

  try {
    clearError();

    const newMedicine = push(ref(db, userPath("medicines")));

    await set(newMedicine, {
      name,
      dose,
      notes,
      createdAt: new Date().toISOString()
    });

    await saveHistory("Medicine added", name);

    medicineForm.reset();
    medicineForm.hidden = true;

    await loadRecords();
  } catch (error) {
    console.error(error);
    showError(
      "Could not save the medicine. Check your Firebase connection and rules."
    );
  }
});

document.getElementById("addReminderButton").addEventListener("click", () => {
  reminderForm.hidden = !reminderForm.hidden;

  if (!reminderForm.hidden) {
    document.getElementById("reminderTime").focus();
  }
});

document.getElementById("cancelReminderButton").addEventListener("click", () => {
  reminderForm.reset();
  reminderForm.hidden = true;
});

reminderForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!currentUser) return;

  const medicineId = reminderMedicine.value;
  const time = document.getElementById("reminderTime").value;
  const startDate = document.getElementById("reminderStartDate").value;
  const medicine = medicines[medicineId];

  if (!medicine) {
    showError("Please select a medicine from your list.");
    return;
  }

  if (!time || !startDate) {
    showError("Choose a reminder time and start date.");
    return;
  }

  try {
    clearError();

    const newReminder = push(ref(db, userPath("reminders")));

    await set(newReminder, {
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

    reminderForm.reset();
    reminderForm.hidden = true;

    await loadRecords();
  } catch (error) {
    console.error(error);
    showError(
      "Could not save the reminder. Check your Firebase connection and rules."
    );
  }
});

document.getElementById("logoutButton").addEventListener("click", async () => {
  try {
    await signOut(auth);
    window.location.replace("login.html");
  } catch (error) {
    console.error(error);
    showError("Could not log out. Please try again.");
  }
});

onAuthStateChanged(auth, async user => {
  if (!user) {
    window.location.replace("login.html");
    return;
  }

  currentUser = user;
  clearError();
  loading.hidden = false;
  app.hidden = true;

  try {
    const profileSnapshot = await get(ref(db, userPath()));
    const record = profileSnapshot.val();

    if (!record || !record.role) {
      showError(
        "Your account profile or role is missing. Check your Firebase " +
        "Realtime Database under users/" + user.uid + "."
      );
      loading.hidden = true;
      app.hidden = false;
      return;
    }

    currentRole = normalizeRole(record.role);

    if (!currentRole) {
      showError(
        "Your account role is not recognized. Use authorized or patient."
      );
      loading.hidden = true;
      app.hidden = false;
      return;
    }

    const profile = record.profile || {};
    const name =
      profile.fullName ||
      [profile.firstName, profile.lastName].filter(Boolean).join(" ") ||
      user.displayName ||
      "there";

    welcomeTitle.textContent = `Welcome, ${name}!`;
    accountRole.textContent =
      currentRole === "authorized" ? "CAREGIVER DASHBOARD" : "PATIENT DASHBOARD";

    await loadRecords();

    loading.hidden = true;
    app.hidden = false;
  } catch (error) {
    console.error("Dashboard loading error:", error);

    loading.hidden = true;
    app.hidden = false;

    showError(
      "Could not load your dashboard data. Check your Firebase database " +
      "URL, connection, and rules. " + (error.code || "")
    );
  }
});
