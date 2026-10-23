
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

import {
  getFunctions,
  httpsCallable
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";

const $ = id => document.getElementById(id);

let unsubscribers = [];
let patientUser = null;
let authorizedUid = null;
let medicines = {};
let reminders = {};
let intakeLogs = {};
let activeConnectionCode = "";
let connectionExpiry = 0;
let expiryTimer = null;

const DAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday",
  "Thursday", "Friday", "Saturday"
];

const functions = getFunctions(auth.app, "us-central1");
const createConnectionCode = httpsCallable(functions, "createConnectionCode");

function showError(message) {
  $("error").textContent = message;
  $("error").classList.add("show");
}
function clearError() {
  $("error").textContent = "";
  $("error").classList.remove("show");
}
function showSuccess(message) {
  $("success").textContent = message;
  $("success").classList.add("show");
}
function clearSuccess() {
  $("success").textContent = "";
  $("success").classList.remove("show");
}
function showApp() {
  $("loading").hidden = true;
  $("app").hidden = false;
}
function empty(container, message) {
  container.replaceChildren();
  const div = document.createElement("div");
  div.className = "empty";
  div.textContent = message;
  container.appendChild(div);
}
function stopListeners() {
  unsubscribers.forEach(unsubscribe => {
    try { unsubscribe(); } catch (error) {
      console.warn("Listener cleanup failed", error);
    }
  });
  unsubscribers = [];
}
function nameFromUser(data, user) {
  const profile = data?.profile || {};
  const name = [
    profile.firstName || profile.first_name,
    profile.lastName || profile.last_name
  ].filter(Boolean).join(" ");
  return name || profile.displayName ||
    user.displayName || user.email?.split("@")[0] || "there";
}
function todayDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function dateLabel(value) {
  if (!value) return "Date not set";
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? String(value) :
    date.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"});
}
function timeLabel(value) {
  if (!value) return "Time not set";
  const parts = String(value).split(":");
  if (parts.length < 2) return String(value);
  const date = new Date();
  date.setHours(Number(parts[0]),Number(parts[1]),0,0);
  return date.toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"});
}
function timestampFor(date, time) {
  if (!date || !time) return null;
  const value = new Date(`${date}T${time}:00`).getTime();
  return Number.isNaN(value) ? null : value;
}
function isWeekly(reminder) {
  return reminder?.recurrence === "weekly";
}
function daysForReminder(reminder) {
  return Array.isArray(reminder?.daysOfWeek) ?
    reminder.daysOfWeek.map(Number) : [];
}
function occursOnDate(reminder, dateString) {
  if (!reminder) return false;
  if (isWeekly(reminder)) {
    const date = new Date(`${dateString}T00:00:00`);
    return !Number.isNaN(date.getTime()) &&
      daysForReminder(reminder).includes(date.getDay());
  }
  return reminder.date === dateString;
}
function reminderKey(id, date) {
  return `${id}_${date}`;
}
function getIntake(id, date) {
  return intakeLogs[reminderKey(id,date)] || null;
}
function doseStatus(id, reminder, date) {
  const intake = getIntake(id,date);
  if (intake?.status === "taken") return "Taken";
  if (intake?.status === "missed") return "Marked missed";
  const scheduled = timestampFor(date,reminder.time);
  return scheduled !== null && scheduled < Date.now() ? "Past due" : "Upcoming";
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
  return Object.entries(reminders).sort((a,b) =>
    String(a[1]?.time || "99:99").localeCompare(String(b[1]?.time || "99:99"))
  );
}
function scheduleDescription(reminder) {
  if (isWeekly(reminder)) {
    const days = daysForReminder(reminder).sort((a,b)=>a-b)
      .map(day=>DAY_NAMES[day]).filter(Boolean);
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
  container.replaceChildren();
  const entries = Object.entries(medicines).sort((a,b)=>
    String(a[1]?.name||"").localeCompare(String(b[1]?.name||""))
  );
  $("medicineCount").textContent = entries.length;
  if (!entries.length) {
    empty(container,"No medicines have been shared with you yet.");
    return;
  }
  entries.forEach(([,medicine])=>{
    const article = document.createElement("article");
    article.className = "medicine-card";
    const title = document.createElement("h3");
    title.textContent = `💊 ${medicine.name || "Medicine"}`;
    const detail = document.createElement("p");
    detail.className = "dose-detail";
    detail.textContent = medicineDetail(medicine) ||
      "Follow your caregiver's instructions.";
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "In your medication plan";
    article.append(title,detail,badge);
    container.appendChild(article);
  });
}

async function recordDose(id, reminder, date, status, button) {
  if (!patientUser || !authorizedUid) {
    showError("Your patient account is not connected to a caregiver.");
    return;
  }
  clearError();
  clearSuccess();
  button.disabled = true;
  const medicine = medicineForReminder(reminder);
  const key = reminderKey(id,date);
  const record = {
    reminderId:id,
    medicineId:reminder.medicineId || "",
    medicineName:reminder.medicineName || medicine.name || "Medicine",
    status,
    scheduledDate:date,
    scheduledTime:reminder.time || "",
    recordedAt:Date.now()
  };
  try {
    await set(ref(db,`users/${patientUser.uid}/intakeLogs/${key}`),record);
    showSuccess(status === "taken" ? "Dose recorded as taken." : "Dose recorded as missed.");
  } catch(error) {
    console.error("Dose record failed:",error);
    showError("Could not save this dose. Your current Firebase rules may not allow intakeLogs writes.");
  } finally {
    button.disabled = false;
  }
}

function createDoseCard(id, reminder, date) {
  const medicine = medicineForReminder(reminder);
  const name = reminder.medicineName || medicine.name || "Medication reminder";
  const status = doseStatus(id,reminder,date);
  const intake = getIntake(id,date);
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
  left.append(title,time);

  const badge = document.createElement("span");
  badge.className = `badge ${statusClass(status)}`;
  badge.textContent = status;
  top.append(left,badge);

  const detail = document.createElement("div");
  detail.className = "dose-detail";
  detail.textContent = [
    `Date: ${dateLabel(date)}`,
    reminder.dose ? `Dose: ${reminder.dose}` : "",
    reminder.notes ? `Notes: ${reminder.notes}` : "",
    medicine.dosage ? `Strength: ${medicine.dosage}` : ""
  ].filter(Boolean).join("\n");
  article.append(top,detail);

  if (intake?.status === "taken") {
    const note = document.createElement("p");
    note.className = "small-note";
    note.textContent = intake.recordedAt ?
      `Recorded at ${new Date(Number(intake.recordedAt)).toLocaleString()}.` :
      "Dose recorded.";
    article.appendChild(note);
    return article;
  }

  const actions = document.createElement("div");
  actions.className = "actions";
  const taken = document.createElement("button");
  taken.className = "btn";
  taken.type = "button";
  taken.textContent = "✓ Mark as taken";
  taken.addEventListener("click",()=>recordDose(id,reminder,date,"taken",taken));

  const missed = document.createElement("button");
  missed.className = "btn secondary";
  missed.type = "button";
  missed.textContent = "Mark as missed";
  missed.addEventListener("click",()=>{
    if (confirm("Mark this scheduled dose as missed?")) {
      recordDose(id,reminder,date,"missed",missed);
    }
  });
  actions.append(taken,missed);
  article.appendChild(actions);
  return article;
}

function renderToday() {
  const container = $("todayList");
  container.replaceChildren();
  const today = todayDateString();
  const entries = sortedReminderEntries().filter(([,r])=>occursOnDate(r,today));
  $("todayCount").textContent = entries.length;
  $("takenCount").textContent = entries.filter(([id])=>getIntake(id,today)?.status==="taken").length;
  if (!entries.length) {
    empty(container,"No medicines are scheduled for today. Check Reminders for your repeating schedule.");
    return;
  }
  entries.forEach(([id,reminder])=>container.appendChild(createDoseCard(id,reminder,today)));
}

function renderAllReminders() {
  const container = $("reminderList");
  container.replaceChildren();
  const entries = sortedReminderEntries();
  if (!entries.length) {
    empty(container,"No reminders have been shared with you yet.");
    return;
  }
  const today = todayDateString();
  entries.forEach(([id,reminder])=>{
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
    article.append(title,time,details);
    if (occursOnDate(reminder,today)) {
      const label = document.createElement("p");
      label.className = "small-note";
      label.textContent = "Today's dose";
      article.append(label,createDoseCard(id,reminder,today));
    }
    container.appendChild(article);
  });
}

function renderHistory() {
  const container = $("historyList");
  container.replaceChildren();
  const entries = Object.entries(intakeLogs)
    .filter(([,item])=>item && typeof item==="object")
    .sort((a,b)=>Number(b[1].recordedAt||0)-Number(a[1].recordedAt||0));
  if (!entries.length) {
    empty(container,"Your recorded medication activity will appear here.");
    return;
  }
  entries.forEach(([,item])=>{
    const article = document.createElement("article");
    article.className = "medicine-card";
    const title = document.createElement("h3");
    title.textContent = item.medicineName || "Medication dose";
    const detail = document.createElement("p");
    detail.className = "dose-detail";
    detail.textContent = [
      item.status === "taken" ? "Marked as taken" : "Marked as missed",
      item.scheduledDate ? `Scheduled date: ${dateLabel(item.scheduledDate)}` : "",
      item.scheduledTime ? `Scheduled time: ${timeLabel(item.scheduledTime)}` : "",
      item.recordedAt ? `Recorded: ${new Date(Number(item.recordedAt)).toLocaleString()}` : ""
    ].filter(Boolean).join("\n");
    const badge = document.createElement("span");
    badge.className = `badge ${item.status==="taken"?"done":"past"}`;
    badge.textContent = item.status==="taken"?"Marked as taken":"Marked as missed";
    article.append(title,detail,badge);
    container.appendChild(article);
  });
}

function renderAll() {
  renderMedicines();
  renderToday();
  renderAllReminders();
  renderHistory();
}

function showConnectionRequired() {
  $("connectionBanner").style.display = "block";
  $("connectionBanner").textContent =
    "Your patient account is not connected to an authorized person yet. Generate a temporary code below and ask your caregiver to redeem it.";
  empty($("todayList"),"Your schedule will appear here after a verified connection.");
  empty($("medicineList"),"No shared medicines are available yet.");
  empty($("reminderList"),"No shared reminders are available yet.");
  empty($("historyList"),"Your medication activity will appear here.");
  $("medicineCount").textContent = "0";
  $("todayCount").textContent = "0";
  $("takenCount").textContent = "0";
}

async function startPatientDashboard(user) {
  stopListeners();
  patientUser = user;
  clearError();
  clearSuccess();

  try {
    const snapshot = await get(ref(db,`users/${user.uid}`));
    const data = snapshot.exists() ? snapshot.val() : {};
    const role = String(data.role || data.accountRole || data.profile?.role || "").toLowerCase();

    if (role && !["patient","medicine_taker","medicine taker"].includes(role)) {
      $("loading").hidden = true;
      showError("This account is not set up as a patient or medicine taker.");
      return;
    }

    $("welcomeTitle").textContent = `Hello, ${nameFromUser(data,user)}!`;
    $("todayLabel").textContent = new Date().toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"});

    authorizedUid = data.authorizedPersonUid ||
      data.connectedAuthorizedUid ||
      data.careConnection?.authorizedUid ||
      data.connection?.authorizedUid ||
      null;

    showApp();

    if (!authorizedUid) {
      showConnectionRequired();
      $("connectionStatusBadge").textContent = "Not connected";
      return;
    }

    if (authorizedUid === user.uid) {
      showError("Your connection is invalid because it points to your own account.");
      return;
    }

    $("connectionBanner").style.display = "none";
    $("connectionStatusBadge").textContent = "Connected";

    const caregiverPath = `users/${authorizedUid}`;
    unsubscribers.push(
      onValue(ref(db,`${caregiverPath}/medicines`),snap=>{
        medicines = snap.val() || {};
        renderAll();
      },error=>{
        console.error(error);
        showError("Unable to load shared medicines. Your Firebase rules must authorize this verified connection.");
      }),
      onValue(ref(db,`${caregiverPath}/reminders`),snap=>{
        reminders = snap.val() || {};
        renderAll();
      },error=>{
        console.error(error);
        showError("Unable to load reminders. Check the verified connection's database permissions.");
      }),
      onValue(ref(db,`users/${user.uid}/intakeLogs`),snap=>{
        intakeLogs = snap.val() || {};
        renderAll();
      },error=>{
        console.error(error);
        showError("Unable to load medication history.");
      })
    );
  } catch(error) {
    console.error("Patient dashboard error:",error);
    $("loading").hidden = true;
    showError(error.message || "Could not load your patient dashboard.");
  }
}

/* QR-code connection */
function hideConnectionCode() {
  clearInterval(expiryTimer);
  activeConnectionCode = "";
  connectionExpiry = 0;
  $("qrCodeArea").hidden = true;
  $("qrCodeImage").replaceChildren();
  $("qrCodeText").textContent = "";
  $("qrExpiry").textContent = "";
}

function startExpiryCountdown() {
  clearInterval(expiryTimer);
  const update = () => {
    const remaining = Math.max(0,Math.ceil((connectionExpiry-Date.now())/1000));
    if (!remaining) {
      hideConnectionCode();
      $("qrConnectionStatus").textContent = "Your code expired. Generate a new code.";
      return;
    }
    $("qrExpiry").textContent =
      `Expires in ${Math.floor(remaining/60)}:${String(remaining%60).padStart(2,"0")}`;
  };
  update();
  expiryTimer = setInterval(update,1000);
}

$("generateConnectionCode").addEventListener("click",async()=>{
  const button = $("generateConnectionCode");
  if (!auth.currentUser) {
    $("qrConnectionStatus").textContent = "Please sign in again.";
    return;
  }
  if (!window.QRCode) {
    $("qrConnectionStatus").textContent = "The QR library failed to load. Refresh and try again.";
    return;
  }

  button.disabled = true;
  $("qrConnectionStatus").textContent = "Requesting a temporary code from Firebase…";
  hideConnectionCode();

  try {
    const result = await createConnectionCode({});
    const data = result.data || {};
    if (!data.code || !data.expiresAt) {
      throw new Error("Firebase did not return a valid code and expiry time.");
    }

    activeConnectionCode = String(data.code);
    connectionExpiry = Number(data.expiresAt);

    $("qrCodeText").textContent = activeConnectionCode;
    $("qrCodeImage").replaceChildren();
    new window.QRCode($("qrCodeImage"),{
      text: data.qrText || activeConnectionCode,
      width:210,
      height:210,
      correctLevel:window.QRCode.CorrectLevel.M
    });
    $("qrCodeArea").hidden = false;
    $("qrConnectionStatus").textContent =
      "Your code is ready. Ask your authorized caregiver to scan or enter it.";
    startExpiryCountdown();
  } catch(error) {
    console.error("Connection-code request failed:",error);
    $("qrConnectionStatus").textContent =
      error.message || "Could not generate a code. Check the Firebase Cloud Function and try again.";
  } finally {
    button.disabled = false;
  }
});

$("copyConnectionCode").addEventListener("click",async()=>{
  if (!activeConnectionCode || Date.now() >= connectionExpiry) {
    hideConnectionCode();
    $("qrConnectionStatus").textContent = "Your code expired. Generate a new code.";
    return;
  }
  try {
    await navigator.clipboard.writeText(activeConnectionCode);
    $("qrConnectionStatus").textContent = "Code copied. Share it only with your authorized caregiver.";
  } catch(error) {
    $("qrConnectionStatus").textContent = "Automatic copy is unavailable. Read the code shown above.";
  }
});

$("hideConnectionCode").addEventListener("click",hideConnectionCode);

/* Navigation */
document.querySelectorAll(".nav-btn").forEach(button=>{
  button.addEventListener("click",()=>{
    document.querySelectorAll(".section").forEach(section=>{
      section.classList.toggle("active",section.id===button.dataset.target);
    });
    document.querySelectorAll(".nav-btn").forEach(nav=>{
      nav.classList.toggle("active",nav===button);
    });
    window.scrollTo({top:0,behavior:"smooth"});
  });
});

/* Logout */
$("logoutButton").addEventListener("click",async()=>{
  try {
    stopListeners();
    await signOut(auth);
    window.location.replace("login.html");
  } catch(error) {
    console.error(error);
    showError("Unable to log out. Please try again.");
  }
});

/* Authentication */
onAuthStateChanged(auth,user=>{
  if (!user) {
    stopListeners();
    window.location.replace("login.html");
    return;
  }
  startPatientDashboard(user);
});

window.addEventListener("beforeunload",()=>{
  stopListeners();
  clearInterval(expiryTimer);
});
