
import { auth, db } from "./firebaseConfig.js";

import {
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
  ref,
  get,
  onValue,
  set
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const $ = id => document.getElementById(id);

let unsubscribers = [];
let patientUser = null;
let authorizedUid = null;
let medicines = {};
let reminders = {};
let intakeLogs = {};
let loadingConnection = false;

const DAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday",
  "Thursday", "Friday", "Saturday"
];

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function showError(text) {
  $("error").textContent = text;
  $("error").classList.add("show");
}

function clearError() {
  $("error").textContent = "";
  $("error").classList.remove("show");
}

function showSuccess(text) {
  $("success").textContent = text;
  $("success").classList.add("show");
}

function clearSuccess() {
  $("success").textContent = "";
  $("success").classList.remove("show");
}

function showApp() {
  $("loading").style.display = "none";
  $("app").style.display = "block";
}

function hideLoading() {
  $("loading").style.display = "none";
}

function empty(container, text) {
  container.innerHTML = "";
  const div = document.createElement("div");
  div.className = "empty";
  div.textContent = text;
  container.appendChild(div);
}

function nameFromUser(data, user) {
  const profile = data?.profile || {};
  const fullName = [
    profile.firstName || profile.first_name,
    profile.lastName || profile.last_name
  ].filter(Boolean).join(" ");

  return fullName ||
    profile.displayName ||
    user.displayName ||
    user.email?.split("@")[0] ||
    "there";
}

function todayDateString() {
  const date = new Date();
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function dateLabel(value) {
  if (!value) return "Date not set";

  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return String(value);

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

function timeLabel(value) {
  if (!value) return "Time not set";

  const parts = String(value).split(":");
  if (parts.length < 2) return String(value);

  const date = new Date();
  date.setHours(Number(parts[0]), Number(parts[1]), 0, 0);

  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit"
  });
}

function timestampFor(date, time) {
  if (!date || !time) return null;

  const timestamp = new Date(`${date}T${time}:00`).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function stopListeners() {
  unsubscribers.forEach(unsubscribe => {
    try {
      unsubscribe();
    } catch (error) {
      console.warn("Could not stop listener:", error);
    }
  });

  unsubscribers = [];
}

function showConnectionRequired() {
  $("connectionBanner").style.display = "block";
  $("connectionBanner").textContent =
    "Your patient account is not connected to an authorized person yet. Ask your caregiver to complete the secure connection process. Your shared medicines will appear here after the connection is approved.";

  empty($("todayList"), "Your schedule will appear here after your account is connected.");
  empty($("medicineList"), "No shared medicines are available yet.");
  empty($("reminderList"), "No shared reminders are available yet.");
  empty($("historyList"), "Your medication activity will appear here.");
  $("medicineCount").textContent = "0";
  $("todayCount").textContent = "0";
  $("takenCount").textContent = "0";
}

function isWeekly(reminder) {
  return reminder?.recurrence === "weekly";
}

function daysForReminder(reminder) {
  return Array.isArray(reminder?.daysOfWeek)
    ? reminder.daysOfWeek.map(Number)
    : [];
}

function occursOnDate(reminder, dateString) {
  if (!reminder) return false;

  if (isWeekly(reminder)) {
    const date = new Date(`${dateString}T00:00:00`);
    if (Number.isNaN(date.getTime())) return false;

    return daysForReminder(reminder).includes(date.getDay());
  }

  return reminder.date === dateString;
}

function reminderKey(reminderId, dateString) {
  return `${reminderId}_${dateString}`;
}

function getIntake(reminderId, dateString) {
  return intakeLogs[reminderKey(reminderId, dateString)] || null;
}

function doseStatus(reminderId, reminder, dateString) {
  const intake = getIntake(reminderId, dateString);

  if (intake?.status === "taken") return "Taken";
  if (intake?.status === "missed") return "Marked missed";

  const scheduledAt = timestampFor(dateString, reminder.time);
  if (scheduledAt !== null && scheduledAt < Date.now()) {
    return "Past due";
  }

  return "Upcoming";
}

function statusClass(status) {
  if (status === "Taken") return "done";
  if (status === "Past due" || status === "Marked missed") return "past";
  return "";
}

function medicineForReminder(reminder) {
  return medicines[reminder?.medicineId] || {};
}

function sortedReminderEntries() {
  return Object.entries(reminders).sort((a, b) => {
    const timeA = a[1]?.time || "99:99";
    const timeB = b[1]?.time || "99:99";
    return timeA.localeCompare(timeB);
  });
}

function scheduleDescription(reminder) {
  if (isWeekly(reminder)) {
    const days = daysForReminder(reminder)
      .sort((a, b) => a - b)
      .map(day => DAY_NAMES[day])
      .filter(Boolean);

    return days.length ? `Repeats every ${days.join(", ")}` : "Weekly schedule";
  }

  return `Scheduled for ${dateLabel(reminder.date)}`;
}

function medicineDetail(medicine) {
  return [
    medicine.dosage ? `Strength: ${medicine.dosage}` : "",
    medicine.instructions ? `Instructions: ${medicine.instructions}` : "",
    medicine.notes ? `Notes: ${medicine.notes}` : ""
  ].filter(Boolean).join("\n");
}

function renderMedicines() {
  const container = $("medicineList");
  container.innerHTML = "";

  const entries = Object.entries(medicines).sort((a, b) =>
    String(a[1]?.name || "").localeCompare(String(b[1]?.name || ""))
  );

  $("medicineCount").textContent = entries.length;

  if (!entries.length) {
    empty(container, "No medicines have been shared with you yet.");
    return;
  }

  for (const [, medicine] of entries) {
    const article = document.createElement("article");
    article.className = "medicine-card";

    const name = document.createElement("h3");
    name.textContent = `💊 ${medicine.name || "Medicine"}`;

    const detail = document.createElement("p");
    detail.className = "dose-detail";
    detail.textContent = medicineDetail(medicine) ||
      "Follow the instructions given by your caregiver or healthcare professional.";

    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "In your medication plan";

    article.append(name, detail, badge);
    container.appendChild(article);
  }
}

function createDoseCard(reminderId, reminder, dateString) {
  const medicine = medicineForReminder(reminder);
  const name = reminder.medicineName || medicine.name || "Medication reminder";
  const status = doseStatus(reminderId, reminder, dateString);
  const intake = getIntake(reminderId, dateString);

  const article = document.createElement("article");
  article.className = "dose-card";

  const top = document.createElement("div");
  top.className = "dose-top";

  const left = document.createElement("div");

  const title = document.createElement("div");
  title.className = "dose-title";
  title.textContent = `💊 ${name}`;

  const time = document.createElement("div");
  time.className = "dose-time";
  time.textContent = timeLabel(reminder.time);

  const detail = document.createElement("div");
  detail.className = "dose-detail";
  detail.textContent = [
    `Date: ${dateLabel(dateString)}`,
    reminder.dose ? `Dose: ${reminder.dose}` : "",
    reminder.notes ? `Notes: ${reminder.notes}` : "",
    medicine.dosage ? `Strength: ${medicine.dosage}` : ""
  ].filter(Boolean).join("\n");

  const badge = document.createElement("span");
  badge.className = `badge ${statusClass(status)}`;
  badge.textContent = status;

  left.append(title, time);
  top.append(left, badge);
  article.append(top, detail);

  const alreadyRecorded = Boolean(intake?.status === "taken");

  if (!alreadyRecorded) {
    const actions = document.createElement("div");
    actions.className = "actions";

    const takenButton = document.createElement("button");
    takenButton.className = "btn";
    takenButton.type = "button";
    takenButton.textContent = "✓ Mark as taken";
    takenButton.addEventListener("click", () =>
      recordDose(reminderId, reminder, dateString, "taken", takenButton)
    );

    const missedButton = document.createElement("button");
    missedButton.className = "btn secondary";
    missedButton.type = "button";
    missedButton.textContent = "Mark as missed";
    missedButton.addEventListener("click", () => {
      if (confirm("Mark this scheduled dose as missed?")) {
        recordDose(reminderId, reminder, dateString, "missed", missedButton);
      }
    });

    actions.append(takenButton, missedButton);
    article.appendChild(actions);
  } else {
    const note = document.createElement("p");
    note.className = "small-note";
    note.textContent = `Recorded at ${new Date(Number(intake.recordedAt)).toLocaleString()}.`;
    article.appendChild(note);
  }

  return article;
}

function renderToday() {
  const container = $("todayList");
  container.innerHTML = "";

  const today = todayDateString();
  const entries = sortedReminderEntries()
    .filter(([, reminder]) => occursOnDate(reminder, today));

  $("todayCount").textContent = entries.length;

  const taken = entries.filter(([id]) =>
    getIntake(id, today)?.status === "taken"
  ).length;

  $("takenCount").textContent = taken;

  if (!entries.length) {
    empty(container, "No medicines are scheduled for today. Your upcoming weekly schedules are available under Reminders.");
    return;
  }

  for (const [id, reminder] of entries) {
    container.appendChild(createDoseCard(id, reminder, today));
  }
}

function renderAllReminders() {
  const container = $("reminderList");
  container.innerHTML = "";

  const entries = sortedReminderEntries();

  if (!entries.length) {
    empty(container, "No reminders have been shared with you yet.");
    return;
  }

  const today = todayDateString();

  for (const [id, reminder] of entries) {
    const medicine = medicineForReminder(reminder);
    const article = document.createElement("article");
    article.className = "dose-card";

    const title = document.createElement("div");
    title.className = "dose-title";
    title.textContent = `💊 ${reminder.medicineName || medicine.name || "Medication reminder"}`;

    const time = document.createElement("div");
    time.className = "dose-time";
    time.textContent = timeLabel(reminder.time);

    const details = document.createElement("div");
    details.className = "dose-detail";
    details.textContent = [
      scheduleDescription(reminder),
      reminder.dose ? `Dose: ${reminder.dose}` : "",
      reminder.notes ? `Notes: ${reminder.notes}` : ""
    ].filter(Boolean).join("\n");

    article.append(title, time, details);

    if (occursOnDate(reminder, today)) {
      const todayDose = createDoseCard(id, reminder, today);
      const todaySection = document.createElement("div");
      todaySection.style.marginTop = "12px";

      const todayLabel = document.createElement("div");
      todayLabel.className = "small-note";
      todayLabel.textContent = "Today's dose status";

      todaySection.append(todayLabel, todayDose);
      article.appendChild(todaySection);
    }

    container.appendChild(article);
  }
}

function renderHistory() {
  const container = $("historyList");
  container.innerHTML = "";

  const entries = Object.entries(intakeLogs)
    .filter(([, item]) => item && typeof item === "object")
    .sort((a, b) => Number(b[1].recordedAt || 0) - Number(a[1].recordedAt || 0));

  if (!entries.length) {
    empty(container, "Your recorded medication activity will appear here.");
    return;
  }

  for (const [, item] of entries) {
    const article = document.createElement("article");
    article.className = "medicine-card";

    const title = document.createElement("h3");
    title.textContent = item.medicineName || "Medication dose";

    const detail = document.createElement("p");
    detail.className = "dose-detail";

    const status = item.status === "taken" ? "Marked as taken" : "Marked as missed";
    const when = item.recordedAt
      ? new Date(Number(item.recordedAt)).toLocaleString()
      : "Time not recorded";

    detail.textContent = [
      status,
      item.scheduledDate ? `Scheduled date: ${dateLabel(item.scheduledDate)}` : "",
      item.scheduledTime ? `Scheduled time: ${timeLabel(item.scheduledTime)}` : "",
      `Recorded: ${when}`
    ].filter(Boolean).join("\n");

    const badge = document.createElement("span");
    badge.className = `badge ${item.status === "taken" ? "done" : "past"}`;
    badge.textContent = status;

    article.append(title, detail, badge);
    container.appendChild(article);
  }
}

function renderAll() {
  renderMedicines();
  renderToday();
  renderAllReminders();
  renderHistory();
}

async function recordDose(reminderId, reminder, scheduledDate, status, button) {
  if (!patientUser || !authorizedUid) {
    showError("Your patient account is not connected to a caregiver.");
    return;
  }

  clearError();
  clearSuccess();
  button.disabled = true;

  const medicine = medicineForReminder(reminder);
  const key = reminderKey(reminderId, scheduledDate);

  const intake = {
    reminderId,
    medicineId: reminder.medicineId || "",
    medicineName: reminder.medicineName || medicine.name || "Medicine",
    status,
    scheduledDate,
    scheduledTime: reminder.time || "",
    recordedAt: Date.now()
  };

  try {
    /*
      The intake record is stored under the patient's own account.
      This allows the patient to record their dose without modifying
      the caregiver's medicine or reminder records.
    */
    await set(ref(db, `users/${patientUser.uid}/intakeLogs/${key}`), intake);

    showSuccess(
      status === "taken"
        ? "Dose recorded as taken."
        : "Dose recorded as missed."
    );
  } catch (error) {
    console.error("Could not record dose:", error);
    showError(
      "Could not record this dose. Check that your Firebase Database Rules allow you to write to your own users/" +
      patientUser.uid +
      "/intakeLogs path."
    );
  } finally {
    button.disabled = false;
  }
}

async function startPatientDashboard(user) {
  stopListeners();
  patientUser = user;
  clearError();
  clearSuccess();

  try {
    const ownSnapshot = await get(ref(db, `users/${user.uid}`));
    const ownData = ownSnapshot.exists() ? ownSnapshot.val() : {};

    const role = String(
      ownData.role ||
      ownData.accountRole ||
      ownData.profile?.role ||
      ""
    ).toLowerCase();

    if (role &&
        !role.includes("patient") &&
        !role.includes("medicine_taker") &&
        !role.includes("medicine taker")) {
      hideLoading();
      showError("This account is not set up as a patient or medicine-taker account.");
      return;
    }

    $("welcomeTitle").textContent = `Hello, ${nameFromUser(ownData, user)}!`;
    $("todayLabel").textContent = new Date().toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric"
    });

    /*
      The patient profile must contain the authorized caregiver UID.
      This UID must be set only by a trusted, verified connection flow.
    */
    authorizedUid =
      ownData.authorizedPersonUid ||
      ownData.connectedAuthorizedUid ||
      ownData.careConnection?.authorizedUid ||
      ownData.connection?.authorizedUid ||
      null;

    if (!authorizedUid) {
      showApp();
      showConnectionRequired();
      return;
    }

    if (authorizedUid === user.uid) {
      showApp();
      showError("Your patient connection points to your own account. Ask your caregiver to correct the connection.");
      return;
    }

    $("connectionBanner").style.display = "none";
    showApp();

    /*
      Live listeners: caregiver changes will appear automatically
      once Firebase Database Rules authorize this patient to read
      the connected caregiver's records.
    */
    const caregiverPath = `users/${authorizedUid}`;

    const medicineUnsubscribe = onValue(
      ref(db, `${caregiverPath}/medicines`),
      snapshot => {
        medicines = snapshot.val() || {};
        renderAll();
      },
      error => {
        console.error("Medicine listener error:", error);
        showError("Unable to receive shared medicines. Firebase Database Rules must authorize this patient-caregiver relationship.");
      }
    );

    const reminderUnsubscribe = onValue(
      ref(db, `${caregiverPath}/reminders`),
      snapshot => {
        reminders = snapshot.val() || {};
        renderAll();
      },
      error => {
        console.error("Reminder listener error:", error);
        showError("Unable to receive scheduled reminders. Check Firebase permissions for the verified patient connection.");
      }
    );

    const intakeUnsubscribe = onValue(
      ref(db, `users/${user.uid}/intakeLogs`),
      snapshot => {
        intakeLogs = snapshot.val() || {};
        renderAll();
      },
      error => {
        console.error("Intake history listener error:", error);
        showError("Unable to load your medication history. Check permissions for your own intakeLogs.");
      }
    );

    unsubscribers.push(
      medicineUnsubscribe,
      reminderUnsubscribe,
      intakeUnsubscribe
    );

  } catch (error) {
    console.error("Patient dashboard load error:", error);
    hideLoading();
    showError(error.message || "Could not load your patient dashboard. Please try again.");
  }
}

/* Bottom navigation */
document.querySelectorAll(".nav-btn").forEach(button => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".section").forEach(section => {
      section.classList.toggle("active", section.id === button.dataset.target);
    });

    document.querySelectorAll(".nav-btn").forEach(nav => {
      nav.classList.toggle("active", nav === button);
    });

    window.scrollTo({ top: 0, behavior: "smooth" });
  });
});

/* Log out */
$("logoutButton").addEventListener("click", async () => {
  try {
    stopListeners();
    await signOut(auth);
    window.location.replace("login.html");
  } catch (error) {
    console.error(error);
    showError("Unable to log out. Please try again.");
  }
});

/* Authentication */
onAuthStateChanged(auth, user => {
  if (!user) {
    stopListeners();
    window.location.replace("login.html");
    return;
  }

  startPatientDashboard(user);
});

window.addEventListener("beforeunload", stopListeners);
