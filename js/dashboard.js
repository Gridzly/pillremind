
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
  push,
  set,
  update,
  remove
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const $ = id => document.getElementById(id);

let currentUser = null;
let medicines = {};
let reminders = {};
let activities = {};
let readNotifications = {};
let unsubscribeFunctions = [];
let busy = false;

const pageInfo = {
  medicinesPage: ["My Medicines", "Manage your medicine information."],
  remindersPage: ["My Reminders", "Schedule and manage medicine reminders."],
  historyPage: ["Activity History", "Review recent changes to your account."]
};

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function pathFor(path = "") {
  return `users/${currentUser.uid}/${path}`;
}

function showMessage(id, message, type = "success") {
  const element = $(id);
  if (!element) return;

  element.textContent = message;
  element.className = `message show ${type}`;
}

function hideMessage(id) {
  const element = $(id);
  if (element) element.className = "message";
}

function localDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function formatDate(value) {
  if (!value) return "Date not set";

  const [year, month, day] = value.split("-").map(Number);

  return new Date(year, month - 1, day).toLocaleDateString("en-PH", {
    month: "long",
    day: "numeric",
    year: "numeric"
  });
}

function formatTime(value) {
  if (!value) return "";

  const [hours, minutes] = value.split(":").map(Number);
  const period = hours >= 12 ? "PM" : "AM";
  return `${String(hours % 12 || 12).padStart(2, "0")}:${String(minutes).padStart(2, "0")} ${period}`;
}

function formatTimestamp(value) {
  return new Date(value || Date.now()).toLocaleString("en-PH", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function setBusy(button, value, text = "Please wait...") {
  if (!button) return;

  if (value) {
    button.dataset.originalText = button.textContent;
    button.disabled = true;
    button.textContent = text;
  } else {
    button.disabled = false;
    button.textContent = button.dataset.originalText || button.textContent;
  }
}

function showPage(pageId) {
  document.querySelectorAll(".page").forEach(page => {
    page.classList.toggle("active", page.id === pageId);
  });

  document.querySelectorAll(".nav-btn[data-page]").forEach(button => {
    button.classList.toggle("active", button.dataset.page === pageId);
  });

  const info = pageInfo[pageId];
  if (info) {
    $("pageTitle").textContent = info[0];
    $("pageSubtitle").textContent = info[1];
  }

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function openOverlay(id) {
  $(id)?.classList.add("open");
}

function closeOverlay(id) {
  $(id)?.classList.remove("open");
}

async function logActivity(action, detail) {
  if (!currentUser) return;

  await set(push(ref(db, pathFor("activity"))), {
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

function renderNotificationIndicators() {
  const unread = getActivities().filter(item => !readNotifications[item.id]).length;

  $("notificationDot").hidden = unread === 0;
  $("navNotificationDot").hidden = unread === 0;
}

function renderHistory() {
  const items = getActivities();

  $("historyList").innerHTML = items.length
    ? items.slice(0, 100).map(item => `
        <article class="record">
          <div class="record-main">
            <div class="record-title">${escapeHTML(item.action || "Activity")}</div>
            <div class="record-detail">
              ${escapeHTML(item.detail || "")}<br>
              ${escapeHTML(formatTimestamp(item.timestamp))}
            </div>
          </div>
        </article>
      `).join("")
    : `<div class="empty-state">No activities yet. Add a medicine or reminder to get started.</div>`;

  $("notificationList").innerHTML = items.length
    ? items.slice(0, 30).map(item => `
        <article class="record" style="${readNotifications[item.id] ? "" : "background:#f2f9f4;padding-left:10px;padding-right:10px;border-radius:8px"}">
          <div class="record-main">
            <div class="record-title">
              ${escapeHTML(item.action || "Activity")}
              ${readNotifications[item.id] ? "" : " · New"}
            </div>
            <div class="record-detail">
              ${escapeHTML(item.detail || "")}<br>
              ${escapeHTML(formatTimestamp(item.timestamp))}
            </div>
          </div>
        </article>
      `).join("")
    : `<div class="empty-state">No notifications yet.</div>`;

  renderNotificationIndicators();
}

function renderMedicineSelect() {
  const select = $("reminderMedicine");
  const previous = select.value;

  select.innerHTML = '<option value="">Choose a medicine</option>' +
    Object.entries(medicines).map(([id, medicine]) => `
      <option value="${escapeHTML(id)}">${escapeHTML(medicine.name || "Unnamed medicine")}</option>
    `).join("");

  if (medicines[previous]) select.value = previous;
}

function renderMedicines() {
  const entries = Object.entries(medicines);
  $("medicineCount").textContent = entries.length;

  $("medicineList").innerHTML = entries.length
    ? entries.map(([id, medicine]) => `
        <article class="record">
          <div class="record-main">
            <div class="record-title">💊 ${escapeHTML(medicine.name || "Unnamed medicine")}</div>
            <div class="record-detail">
              ${medicine.dosage ? `Dosage: ${escapeHTML(medicine.dosage)}<br>` : ""}
              ${medicine.frequency ? `Instructions: ${escapeHTML(medicine.frequency)}<br>` : ""}
              ${medicine.notes ? `Notes: ${escapeHTML(medicine.notes)}` : ""}
            </div>
          </div>
          <div class="record-actions">
            <button class="btn secondary small-btn" data-edit-medicine="${escapeHTML(id)}">Edit</button>
            <button class="btn danger small-btn" data-delete-medicine="${escapeHTML(id)}">Delete</button>
          </div>
        </article>
      `).join("")
    : `<div class="empty-state">No medicines saved yet. Select Add medicine to get started.</div>`;

  renderMedicineSelect();
  renderReminders();
}

let calendarYear = new Date().getFullYear();
let calendarMonth = new Date().getMonth();
let selectedDate = "";

function renderCalendar() {
  const grid = $("calendarGrid");
  const first = new Date(calendarYear, calendarMonth, 1);
  const numberOfDays = new Date(calendarYear, calendarMonth + 1, 0).getDate();

  $("calendarMonth").textContent = first.toLocaleDateString("en-PH", {
    month: "long",
    year: "numeric"
  });

  grid.replaceChildren();

  ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach(day => {
    const label = document.createElement("div");
    label.className = "weekday";
    label.textContent = day;
    grid.appendChild(label);
  });

  for (let blank = 0; blank < first.getDay(); blank++) {
    grid.appendChild(document.createElement("div"));
  }

  for (let day = 1; day <= numberOfDays; day++) {
    const date = `${calendarYear}-${String(calendarMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "calendar-day";
    button.textContent = day;

    if (date === localDate()) button.classList.add("today");
    if (date === selectedDate) button.classList.add("selected");

    if (Object.values(reminders).some(reminder => reminder.date === date)) {
      button.classList.add("has-reminder");
    }

    if (date < localDate()) button.disabled = true;

    button.addEventListener("click", () => {
      selectedDate = date;
      $("reminderStartDate").value = date;
      $("selectedDateLabel").textContent = formatDate(date);
      renderCalendar();
    });

    grid.appendChild(button);
  }

  const current = new Date();
  $("calendarPrev").disabled =
    calendarYear === current.getFullYear() &&
    calendarMonth <= current.getMonth();
}

function renderReminders() {
  const entries = Object.entries(reminders).sort((a, b) =>
    `${a[1].date || "9999"} ${a[1].time || "99:99"}`.localeCompare(
      `${b[1].date || "9999"} ${b[1].time || "99:99"}`
    )
  );

  const now = Date.now();
  const upcoming = entries.filter(([, reminder]) =>
    reminder.date && reminder.time &&
    new Date(`${reminder.date}T${reminder.time}:00`).getTime() >= now
  );

  $("reminderCount").textContent = entries.length;

  if (upcoming.length) {
    $("nextReminder").textContent = formatTime(upcoming[0][1].time);
    $("nextReminderDetail").textContent =
      `${formatDate(upcoming[0][1].date)} · ${medicineName(upcoming[0][1].medicineId)}`;
  } else {
    $("nextReminder").textContent = "None yet";
    $("nextReminderDetail").textContent = "No upcoming reminders";
  }

  $("reminderList").innerHTML = entries.length
    ? entries.map(([id, reminder]) => `
        <article class="record">
          <div class="record-main">
            <div class="record-title">🔔 ${escapeHTML(medicineName(reminder.medicineId))}</div>
            <div class="record-detail">
              ${escapeHTML(formatDate(reminder.date))} · ${escapeHTML(formatTime(reminder.time))}
              ${reminder.notes ? `<br>${escapeHTML(reminder.notes)}` : ""}
            </div>
          </div>
          <div class="record-actions">
            <button class="btn secondary small-btn" data-edit-reminder="${escapeHTML(id)}">Edit</button>
            <button class="btn danger small-btn" data-delete-reminder="${escapeHTML(id)}">Delete</button>
          </div>
        </article>
      `).join("")
    : `<div class="empty-state">No reminders scheduled yet.</div>`;

  renderCalendar();
}

function updateTime() {
  const hour = Number($("timeHour").value || "08");
  const minute = $("timeMinute").value || "00";
  const period = $("timePeriod").value || "AM";

  $("timeDisplay").textContent =
    `${String(hour).padStart(2, "0")}:${minute} ${period}`;

  let hour24 = hour % 12;
  if (period === "PM") hour24 += 12;

  $("reminderTime").value =
    `${String(hour24).padStart(2, "0")}:${minute}`;
}

// Build time choices.
for (let hour = 1; hour <= 12; hour++) {
  const value = String(hour).padStart(2, "0");
  $("timeHour").add(new Option(value, value));
}

for (let minute = 0; minute < 60; minute += 5) {
  const value = String(minute).padStart(2, "0");
  $("timeMinute").add(new Option(value, value));
}

$("timeHour").value = "08";
$("timeMinute").value = "00";

["timeHour", "timeMinute", "timePeriod"].forEach(id => {
  $(id).addEventListener("change", updateTime);
});

updateTime();

// Page navigation.
document.querySelectorAll(".nav-btn[data-page]").forEach(button => {
  button.addEventListener("click", () => showPage(button.dataset.page));
});

$("toggleMedicineForm").addEventListener("click", () => {
  $("medicineForm").classList.toggle("open");
});

$("cancelMedicineForm").addEventListener("click", () => {
  $("addMedicineForm").reset();
  $("medicineEditId").value = "";
  $("medicineForm").classList.remove("open");
  $("medicineFormTitle").textContent = "Add a medicine";
  $("saveMedicineButton").textContent = "Save medicine";
  hideMessage("pageMessage");
});

$("quickAddReminder").addEventListener("click", () => {
  if (!Object.keys(medicines).length) {
    showPage("medicinesPage");
    $("medicineForm").classList.add("open");
    showMessage("pageMessage", "Please add a medicine before creating a reminder.", "error");
    return;
  }

  showPage("remindersPage");
  $("reminderForm").classList.add("open");
});

$("toggleReminderForm").addEventListener("click", () => {
  if (!Object.keys(medicines).length) {
    showMessage("reminderFormMessage", "Please add a medicine first.", "error");
    return;
  }

  $("reminderForm").classList.toggle("open");
});

$("cancelReminderForm").addEventListener("click", () => {
  resetReminderForm();
  $("reminderForm").classList.remove("open");
});

function resetReminderForm() {
  $("addReminderForm").reset();
  $("reminderEditId").value = "";
  $("saveReminderButton").textContent = "Save reminder";
  selectedDate = "";
  $("reminderStartDate").value = "";
  $("selectedDateLabel").textContent = "Select a date on the calendar";
  $("timeHour").value = "08";
  $("timeMinute").value = "00";
  $("timePeriod").value = "AM";
  updateTime();
  hideMessage("reminderFormMessage");
  renderCalendar();
}

// Calendar navigation.
$("calendarPrev").addEventListener("click", () => {
  if ($("calendarPrev").disabled) return;

  calendarMonth--;
  if (calendarMonth < 0) {
    calendarMonth = 11;
    calendarYear--;
  }
  renderCalendar();
});

$("calendarNext").addEventListener("click", () => {
  calendarMonth++;
  if (calendarMonth > 11) {
    calendarMonth = 0;
    calendarYear++;
  }
  renderCalendar();
});

// Add and update medicine.
$("addMedicineForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy) return;

  const name = $("medicineName").value.trim();
  if (!name) return;

  const id = $("medicineEditId").value;
  const button = $("saveMedicineButton");

  busy = true;
  setBusy(button, true, "Saving...");

  try {
    const data = {
      name,
      dosage: $("medicineDosage").value.trim(),
      frequency: $("medicineFrequency").value.trim(),
      notes: $("medicineNotes").value.trim(),
      updatedAt: Date.now()
    };

    if (id) {
      await update(ref(db, pathFor(`medicines/${id}`)), data);
      await logActivity("Medicine updated", `Updated ${name}.`);
    } else {
      data.createdAt = Date.now();
      await set(push(ref(db, pathFor("medicines"))), data);
      await logActivity("Medicine added", `Added ${name}.`);
    }

    $("addMedicineForm").reset();
    $("medicineEditId").value = "";
    $("medicineForm").classList.remove("open");
    $("medicineFormTitle").textContent = "Add a medicine";
    showMessage("pageMessage", id ? "Medicine updated successfully." : "Medicine added successfully.");
  } catch (error) {
    showMessage("pageMessage", error.message, "error");
  } finally {
    busy = false;
    setBusy(button, false);
  }
});

// Edit or delete a medicine.
$("medicineList").addEventListener("click", async event => {
  const editButton = event.target.closest("[data-edit-medicine]");
  const deleteButton = event.target.closest("[data-delete-medicine]");

  if (editButton) {
    const id = editButton.dataset.editMedicine;
    const medicine = medicines[id];
    if (!medicine) return;

    $("medicineEditId").value = id;
    $("medicineName").value = medicine.name || "";
    $("medicineDosage").value = medicine.dosage || "";
    $("medicineFrequency").value = medicine.frequency || "";
    $("medicineNotes").value = medicine.notes || "";
    $("medicineFormTitle").textContent = "Edit medicine";
    $("saveMedicineButton").textContent = "Update medicine";
    $("medicineForm").classList.add("open");
    return;
  }

  if (deleteButton) {
    const id = deleteButton.dataset.deleteMedicine;
    const medicine = medicines[id];
    if (!medicine || !confirm(`Delete ${medicine.name} and its associated reminders?`)) return;

    try {
      const changes = {
        [pathFor(`medicines/${id}`)]: null
      };

      for (const [reminderId, reminder] of Object.entries(reminders)) {
        if (reminder.medicineId === id) {
          changes[pathFor(`reminders/${reminderId}`)] = null;
        }
      }

      await update(ref(db), changes);
      await logActivity("Medicine deleted", `Deleted ${medicine.name} and its associated reminders.`);
    } catch (error) {
      alert("Unable to delete medicine: " + error.message);
    }
  }
});

// Add or update a reminder.
$("addReminderForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy) return;

  const medicineId = $("reminderMedicine").value;
  const date = $("reminderStartDate").value;
  const time = $("reminderTime").value;
  const id = $("reminderEditId").value;

  if (!medicines[medicineId]) {
    showMessage("reminderFormMessage", "Please select a medicine.", "error");
    return;
  }

  if (!date || date < localDate()) {
    showMessage("reminderFormMessage", "Choose today or a future date.", "error");
    return;
  }

  const button = $("saveReminderButton");
  busy = true;
  setBusy(button, true, "Saving...");

  try {
    const data = {
      medicineId,
      date,
      time,
      notes: $("reminderNotes").value.trim(),
      updatedAt: Date.now()
    };

    if (id) {
      await update(ref(db, pathFor(`reminders/${id}`)), data);
      await logActivity("Reminder updated", `Updated ${medicineName(medicineId)} for ${formatDate(date)} at ${formatTime(time)}.`);
    } else {
      data.createdAt = Date.now();
      await set(push(ref(db, pathFor("reminders"))), data);
      await logActivity("Reminder added", `Scheduled ${medicineName(medicineId)} for ${formatDate(date)} at ${formatTime(time)}.`);
    }

    resetReminderForm();
    $("reminderForm").classList.remove("open");
    showMessage("pageMessage", id ? "Reminder updated successfully." : "Reminder saved successfully.");
  } catch (error) {
    showMessage("reminderFormMessage", error.message, "error");
  } finally {
    busy = false;
    setBusy(button, false);
  }
});

// Edit or delete a reminder.
$("reminderList").addEventListener("click", async event => {
  const editButton = event.target.closest("[data-edit-reminder]");
  const deleteButton = event.target.closest("[data-delete-reminder]");

  if (editButton) {
    const id = editButton.dataset.editReminder;
    const reminder = reminders[id];
    if (!reminder) return;

    showPage("remindersPage");
    $("reminderForm").classList.add("open");
    $("reminderEditId").value = id;
    $("reminderMedicine").value = reminder.medicineId || "";

    selectedDate = reminder.date || "";
    $("reminderStartDate").value = selectedDate;
    $("selectedDateLabel").textContent =
      selectedDate ? formatDate(selectedDate) : "Select a date on the calendar";

    if (selectedDate) {
      const date = new Date(`${selectedDate}T12:00:00`);
      calendarYear = date.getFullYear();
      calendarMonth = date.getMonth();
    }

    const [hours, minutes] = (reminder.time || "08:00").split(":").map(Number);
    $("timeHour").value = String(hours % 12 || 12).padStart(2, "0");
    $("timeMinute").value = String(minutes).padStart(2, "0");
    $("timePeriod").value = hours >= 12 ? "PM" : "AM";
    $("reminderNotes").value = reminder.notes || "";
    $("saveReminderButton").textContent = "Update reminder";

    updateTime();
    renderCalendar();
    return;
  }

  if (deleteButton) {
    const id = deleteButton.dataset.deleteReminder;
    const reminder = reminders[id];
    if (!reminder || !confirm("Delete this reminder?")) return;

    try {
      await remove(ref(db, pathFor(`reminders/${id}`)));
      await logActivity("Reminder deleted", `Deleted the reminder for ${medicineName(reminder.medicineId)}.`);
    } catch (error) {
      alert("Unable to delete reminder: " + error.message);
    }
  }
});

// Notifications and profile.
$("notificationButton").addEventListener("click", () => openOverlay("notificationsOverlay"));
$("navNotifications").addEventListener("click", () => openOverlay("notificationsOverlay"));
$("profileButton").addEventListener("click", () => openOverlay("profileOverlay"));
$("navProfile").addEventListener("click", () => openOverlay("profileOverlay"));

document.querySelectorAll("[data-close]").forEach(button => {
  button.addEventListener("click", () => closeOverlay(button.dataset.close));
});

document.querySelectorAll(".overlay").forEach(overlay => {
  overlay.addEventListener("click", event => {
    if (event.target === overlay) closeOverlay(overlay.id);
  });
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    document.querySelectorAll(".overlay.open").forEach(close => close.classList.remove("open"));
  }
});

$("viewHistoryButton").addEventListener("click", () => {
  closeOverlay("notificationsOverlay");
  showPage("historyPage");
});

$("refreshHistory").addEventListener("click", renderHistory);

$("markReadButton").addEventListener("click", async () => {
  try {
    const changes = {};

    getActivities().forEach(item => {
      changes[item.id] = true;
    });

    if (Object.keys(changes).length) {
      await update(ref(db, pathFor("readNotifications")), changes);
    }
  } catch (error) {
    alert("Unable to update notifications: " + error.message);
  }
});

// Change account password.
$("passwordForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!currentUser) return;

  const currentPassword = $("currentPassword").value;
  const newPassword = $("newPassword").value;
  const confirmPassword = $("confirmNewPassword").value;

  if (newPassword.length < 8) {
    showMessage("passwordMessage", "Your new password must contain at least 8 characters.", "error");
    return;
  }

  if (newPassword !== confirmPassword) {
    showMessage("passwordMessage", "The new passwords do not match.", "error");
    return;
  }

  if (newPassword === currentPassword) {
    showMessage("passwordMessage", "Choose a password different from your current password.", "error");
    return;
  }

  const button = $("changePasswordButton");
  setBusy(button, true, "Updating...");

  try {
    const credential = EmailAuthProvider.credential(currentUser.email, currentPassword);
    await reauthenticateWithCredential(currentUser, credential);
    await updatePassword(currentUser, newPassword);

    $("passwordForm").reset();
    showMessage("passwordMessage", "Your password has been updated successfully.");

    await logActivity("Password changed", "Your account password was changed.");
  } catch (error) {
    let message = error.message;

    if ([
      "auth/invalid-credential",
      "auth/wrong-password",
      "auth/invalid-login-credentials"
    ].includes(error.code)) {
      message = "Your current password is incorrect.";
    } else if (error.code === "auth/weak-password") {
      message = "Choose a stronger password.";
    } else if (error.code === "auth/requires-recent-login") {
      message = "Please log in again before changing your password.";
    }

    showMessage("passwordMessage", message, "error");
  } finally {
    setBusy(button, false);
  }
});

// Log out.
$("logoutButton").addEventListener("click", async () => {
  if (!confirm("Are you sure you want to log out?")) return;

  try {
    await signOut(auth);
    window.location.replace("login.html");
  } catch (error) {
    alert("Unable to log out: " + error.message);
  }
});

// Firebase data subscriptions.
function stopSubscriptions() {
  unsubscribeFunctions.forEach(unsubscribe => unsubscribe());
  unsubscribeFunctions = [];
}

function subscribe(path, callback) {
  const unsubscribe = onValue(
    ref(db, pathFor(path)),
    snapshot => callback(snapshot.val() || {}),
    error => {
      console.error(`Firebase error (${path}):`, error);
      showMessage(
        "pageMessage",
        "Unable to load data. Check your internet connection and Firebase Database Rules.",
        "error"
      );
    }
  );

  unsubscribeFunctions.push(unsubscribe);
}

onAuthStateChanged(auth, user => {
  if (!user) {
    stopSubscriptions();
    window.location.replace("login.html");
    return;
  }

  stopSubscriptions();
  currentUser = user;

  $("profileName").textContent = user.displayName || "My account";
  $("profileModalName").textContent = user.displayName || "My account";
  $("profileEmail").textContent = user.email || "";
  $("welcomeTitle").textContent = `Welcome, ${(user.displayName || "there").split(" ")[0]}! 👋`;
  $("profileAvatar").textContent = (user.displayName || user.email || "U").charAt(0).toUpperCase();

  subscribe("medicines", value => {
    medicines = value;
    renderMedicines();
  });

  subscribe("reminders", value => {
    reminders = value;
    renderReminders();
  });

  subscribe("activity", value => {
    activities = value;
    renderHistory();
  });

  subscribe("readNotifications", value => {
    readNotifications = value;
    renderHistory();
  });
});
