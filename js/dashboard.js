
import { auth, db } from "./firebaseConfig.js";

import {
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
  ref,
  get,
  push,
  set,
  remove
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const $ = (id) => document.getElementById(id);

let currentUser = null;
let medicines = {};
let reminders = {};
let historyRecords = {};
let isSavingMedicine = false;
let isSavingReminder = false;

function showMessage(id, message, type = "error") {
  const element = $(id);
  if (!element) return;

  element.textContent = message;
  element.className = `message show ${type}`;
}

function clearMessage(id) {
  const element = $(id);
  if (!element) return;

  element.textContent = "";
  element.className = "message";
}

function showPageMessage(message, type = "error") {
  showMessage("pageMessage", message, type);
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

function formatDate(dateString) {
  if (!dateString) return "No date selected";

  const parts = String(dateString).split("-").map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    return String(dateString);
  }

  return new Date(parts[0], parts[1] - 1, parts[2])
    .toLocaleDateString("en-PH", {
      month: "long",
      day: "numeric",
      year: "numeric"
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

function escapeText(value) {
  return String(value ?? "");
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function showEmpty(containerId, message) {
  const container = $(containerId);
  container.replaceChildren(
    makeElement("div", "empty-state", message)
  );
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
    console.error("Could not save activity history:", error);
  }
}

async function refreshData() {
  if (!currentUser) return;

  const [medicineSnapshot, reminderSnapshot, historySnapshot] =
    await Promise.all([
      get(ref(db, userPath("medicines"))),
      get(ref(db, userPath("reminders"))),
      get(ref(db, userPath("history")))
    ]);

  medicines = medicineSnapshot.exists() ? medicineSnapshot.val() : {};
  reminders = reminderSnapshot.exists() ? reminderSnapshot.val() : {};
  historyRecords = historySnapshot.exists() ? historySnapshot.val() : {};

  renderMedicines();
  renderReminders();
  renderHistory();
  renderSummary();
}

function renderSummary() {
  const medicineEntries = Object.entries(medicines || {});
  const reminderEntries = Object.entries(reminders || {});

  $("medicineCount").textContent = medicineEntries.length;
  $("reminderCount").textContent = reminderEntries.length;

  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  const upcoming = reminderEntries
    .map(([id, reminder]) => ({ id, ...reminder }))
    .filter(reminder => reminder.startDate && reminder.time)
    .filter(reminder => {
      return reminder.startDate > today ||
        (reminder.startDate === today && reminder.time >= currentTime);
    })
    .sort((a, b) => {
      const first = `${a.startDate}T${a.time}`;
      const second = `${b.startDate}T${b.time}`;
      return first.localeCompare(second);
    });

  if (!upcoming.length) {
    $("nextReminder").textContent = "None yet";
    $("nextReminderDetail").textContent = "No upcoming reminders";
    return;
  }

  const next = upcoming[0];
  $("nextReminder").textContent = formatTime(next.time);
  $("nextReminderDetail").textContent =
    `${next.medicineName || "Medicine"} · ${formatDate(next.startDate)}`;
}

function renderMedicines() {
  const container = $("medicineList");
  container.replaceChildren();

  const entries = Object.entries(medicines || {});

  if (!entries.length) {
    showEmpty("medicineList", "No medicines added yet. Select “Add medicine” to get started.");
  }

  entries.sort((a, b) =>
    String(a[1].name || "").localeCompare(String(b[1].name || ""))
  );

  for (const [id, medicine] of entries) {
    const record = makeElement("article", "record");
    const main = makeElement("div", "record-main");
    const title = makeElement("div", "record-title", medicine.name || "Unnamed medicine");
    const detail = makeElement(
      "div",
      "record-detail",
      [
        medicine.dosage ? `Dosage: ${medicine.dosage}` : "",
        medicine.frequency ? `Instructions: ${medicine.frequency}` : "",
        medicine.notes ? `Notes: ${medicine.notes}` : ""
      ].filter(Boolean).join("\n") || "No additional details"
    );

    const actions = makeElement("div", "record-actions");
    const deleteButton = makeElement("button", "btn btn-danger btn-small", "Remove");
    deleteButton.type = "button";
    deleteButton.addEventListener("click", async () => {
      if (!confirm(`Remove ${medicine.name || "this medicine"}? Related reminders will not be deleted automatically.`)) {
        return;
      }

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

    actions.appendChild(deleteButton);
    main.append(title, detail);
    record.append(main, actions);
    container.appendChild(record);
  }

  // Refresh the medicine selector without losing a still-valid selection.
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

  if (medicines && medicines[previousValue]) {
    selector.value = previousValue;
  }
}

function renderReminders() {
  const container = $("reminderList");
  container.replaceChildren();

  const entries = Object.entries(reminders || {});

  if (!entries.length) {
    showEmpty("reminderList", "No reminders yet. Open “New reminder” to choose a date and time.");
  }

  entries.sort((a, b) => {
    const first = `${a[1].startDate || ""}T${a[1].time || ""}`;
    const second = `${b[1].startDate || ""}T${b[1].time || ""}`;
    return first.localeCompare(second);
  });

  for (const [id, reminder] of entries) {
    const record = makeElement("article", "record");
    const main = makeElement("div", "record-main");
    const title = makeElement(
      "div",
      "record-title",
      reminder.medicineName || "Medication reminder"
    );

    const detailLines = [
      `📅 ${formatDate(reminder.startDate)}`,
      `🕒 ${formatTime(reminder.time)}`
    ];

    if (reminder.notes) {
      detailLines.push(`Notes: ${reminder.notes}`);
    }

    const detail = makeElement("div", "record-detail", detailLines.join("\n"));
    const actions = makeElement("div", "record-actions");

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

function renderHistory() {
  const container = $("historyList");
  container.replaceChildren();

  const entries = Object.entries(historyRecords || {})
    .sort((a, b) => Number(b[1].createdAt || 0) - Number(a[1].createdAt || 0));

  if (!entries.length) {
    showEmpty("historyList", "No activity has been recorded yet.");
    return;
  }

  for (const [, item] of entries) {
    const record = makeElement("article", "record");
    const main = makeElement("div", "record-main");
    const title = makeElement("div", "record-title", item.action || "Activity");
    const detail = makeElement("div", "record-detail", item.detail || "");

    const timestamp = item.createdAt
      ? new Date(item.createdAt).toLocaleString("en-PH", {
          dateStyle: "medium",
          timeStyle: "short"
        })
      : "";

    const date = makeElement("div", "record-detail", timestamp);
    main.append(title, detail, date);
    record.appendChild(main);
    container.appendChild(record);
  }
}

async function loadUserData(user) {
  currentUser = user;

  $("userLabel").textContent = user.email || "Your account";

  try {
    const snapshot = await get(ref(db, `users/${user.uid}`));
    const userData = snapshot.exists() ? snapshot.val() : {};

    const profile = userData.profile || {};
    const role = normalizeRole(
      userData.role || profile.role || userData.accountType || profile.accountType
    );

    // Keep patient accounts on their own patient dashboard.
    if (["patient", "medicine_taker"].includes(role)) {
      window.location.replace("patient-dashboard.html");
      return;
    }

    const displayName =
      profile.firstName ||
      profile.first_name ||
      user.displayName ||
      user.email?.split("@")[0] ||
      "there";

    $("welcomeTitle").textContent = `Welcome, ${displayName}!`;
    $("loading").style.display = "none";
    $("app").style.display = "block";

    await refreshData();
  } catch (error) {
    console.error("Dashboard loading error:", error);
    $("loading").textContent =
      "Unable to load your dashboard. Check your Firebase database rules and connection, then reload the page.";
  }
}

$("addMedicineForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentUser || isSavingMedicine) return;

  const name = $("medicineName").value.trim();
  const dosage = $("medicineDosage").value.trim();
  const frequency = $("medicineFrequency").value.trim();
  const notes = $("medicineNotes").value.trim();

  if (!name) {
    showPageMessage("Please enter a medicine name.");
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
      createdAt: Date.now()
    });

    await saveHistory("Medicine added", name);

    $("addMedicineForm").reset();
    $("medicineForm").classList.remove("open");

    await refreshData();
    showPageMessage("Medicine saved successfully.", "success");
  } catch (error) {
    console.error("Medicine save error:", error);
    showPageMessage("Could not save the medicine. Check your Firebase database rules and try again.");
  } finally {
    isSavingMedicine = false;
    $("saveMedicineButton").disabled = false;
  }
});

$("addReminderForm").addEventListener("submit", async (event) => {
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

  // Use local calendar values so the chosen date is not shifted by UTC conversion.
  const selectedParts = startDate.split("-").map(Number);
  const selectedDate = new Date(
    selectedParts[0],
    selectedParts[1] - 1,
    selectedParts[2]
  );
  selectedDate.setHours(0, 0, 0, 0);

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (selectedDate < today) {
    showMessage("reminderFormMessage", "Please select today or a future date.");
    return;
  }

  if (startDate === [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ].join("-")) {
    const [hours, minutes] = time.split(":").map(Number);
    if (hours * 60 + minutes < now.getHours() * 60 + now.getMinutes()) {
      showMessage("reminderFormMessage", "That time has already passed today. Please choose a later time.");
      return;
    }
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
    showMessage(
      "reminderFormMessage",
      "Could not save the reminder. Check your Firebase database rules and try again."
    );
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

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.replace("login.html");
    return;
  }

  await loadUserData(user);
});
