
import { auth, db } from "./firebaseConfig.js";

import {
  onAuthStateChanged,
  signOut,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
  ref, onValue, get, push, set, update, remove
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const $ = id => document.getElementById(id);

let user = null;
let medicines = {};
let reminders = {};
let activities = {};
let activePatientUid = null;
let unsubs = [];
let busy = false;
let qrStream = null;
let qrDetector = null;
let scanning = false;
let scanFrame = null;

const pages = {
  medicinesPage: ["Medicines", "Manage patient medicine records."],
  remindersPage: ["Reminders", "Manage one-time and weekly schedules."],
  refillsPage: ["Refill tracker", "Monitor medicine stock levels."],
  historyPage: ["Activity history", "Review recent changes."]
};

const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[c]));

const patientUid = () => activePatientUid || user.uid;
const dataPath = path => `users/${patientUid()}/${path}`;
const accountPath = path => `users/${user.uid}/${path}`;

function message(id, text, type = "success") {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = `message show ${type}`;
}

function hideMessage(id) {
  if ($(id)) $(id).className = "message";
}

function openModal(id) {
  $(id)?.classList.add("open");
}

async function closeModal(id) {
  $(id)?.classList.remove("open");
  if (id === "connectionOverlay") await stopQrScanner();
}

function showPage(id) {
  document.querySelectorAll(".page").forEach(p =>
    p.classList.toggle("active", p.id === id)
  );
  document.querySelectorAll("[data-page]").forEach(b =>
    b.classList.toggle("active", b.dataset.page === id)
  );
  if (pages[id]) {
    $("pageTitle").textContent = pages[id][0];
    $("pageSubtitle").textContent = pages[id][1];
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDate(date) {
  if (!date) return "Date not set";
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-PH", {
    month: "short", day: "numeric", year: "numeric"
  });
}

function formatTime(time) {
  if (!time) return "Time not set";
  const [h, m] = time.split(":").map(Number);
  return `${String(h % 12 || 12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

function formatStamp(timestamp) {
  return new Date(timestamp || Date.now()).toLocaleString("en-PH");
}

async function logActivity(action, detail) {
  if (!user) return;
  await set(push(ref(db, accountPath("activity"))), {
    action, detail, timestamp: Date.now()
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
  unsubs.forEach(fn => fn());
  unsubs = [];
}

function subscribe(path, callback) {
  const unsub = onValue(ref(db, dataPath(path)), snap => {
    callback(snap.val() || {});
  }, error => {
    console.error("Firebase subscription error:", error);
    message("pageMessage",
      "Unable to access these records. Check Firebase Database Rules and patient authorization.",
      "error");
  });
  unsubs.push(unsub);
}

function renderMedicines() {
  const entries = Object.entries(medicines);
  $("medicineCount").textContent = entries.length;

  $("medicineList").innerHTML = entries.length ? entries.map(([id, m]) => {
    const low = Number(m.quantity ?? 0) <= Number(m.refillAt ?? 0);
    return `
      <article class="record">
        <div class="record-main">
          <div class="record-title">💊 ${escapeHTML(m.name)}</div>
          <div class="record-detail">
            ${m.dosage ? `Strength: ${escapeHTML(m.dosage)}<br>` : ""}
            ${m.instructions ? `Instructions: ${escapeHTML(m.instructions)}<br>` : ""}
            Stock: ${Number(m.quantity ?? 0)} units
            ${low ? '<br><strong style="color:#c53d3d">Refill needed</strong>' : ""}
            ${m.notes ? `<br>Notes: ${escapeHTML(m.notes)}` : ""}
            ${m.detailsVerified ? '<br><strong style="color:#175638">✓ Details verified</strong>' : ""}
          </div>
        </div>
        <div class="record-actions">
          <button class="btn secondary small" data-edit-med="${escapeHTML(id)}">Edit</button>
          <button class="btn secondary small" data-stock-med="${escapeHTML(id)}">＋ Refill</button>
          <button class="btn danger small" data-del-med="${escapeHTML(id)}">Delete</button>
        </div>
      </article>`;
  }).join("") : '<div class="empty">No medicines saved yet. Add a medicine to begin.</div>';

  const select = $("reminderMedicine");
  const previous = select.value;
  select.innerHTML = '<option value="">Choose medicine</option>' +
    entries.map(([id, m]) =>
      `<option value="${escapeHTML(id)}">${escapeHTML(m.name)}</option>`
    ).join("");
  if (medicines[previous]) select.value = previous;

  renderRefills();
  renderReminders();
}

function renderRefills() {
  const entries = Object.entries(medicines).filter(([, m]) =>
    Number(m.quantity ?? 0) <= Number(m.refillAt ?? 0)
  );

  $("refillCount").textContent = entries.length;

  $("refillList").innerHTML = entries.length ? entries.map(([id, m]) => `
    <article class="record">
      <div class="record-main">
        <div class="record-title">📦 ${escapeHTML(m.name)}</div>
        <div class="record-detail">Remaining: ${Number(m.quantity ?? 0)} units · Alert level: ${Number(m.refillAt ?? 0)} units</div>
      </div>
      <button class="btn small" data-stock-med="${escapeHTML(id)}">Record refill</button>
    </article>
  `).join("") : '<div class="empty">All recorded medicine quantities are above their refill thresholds.</div>';
}

function dayNames(days) {
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return (Array.isArray(days) ? days : []).map(d => names[Number(d)] || "").filter(Boolean).join(", ");
}

function renderReminders() {
  const entries = Object.entries(reminders).sort((a, b) =>
    (a[1].time || "").localeCompare(b[1].time || "")
  );

  $("reminderCount").textContent = entries.length;

  $("reminderList").innerHTML = entries.length ? entries.map(([id, r]) => `
    <article class="record">
      <div class="record-main">
        <div class="record-title">🔔 ${escapeHTML(medicineName(r.medicineId))}</div>
        <div class="record-detail">
          ${r.recurrence === "weekly"
            ? `Every week: ${escapeHTML(dayNames(r.daysOfWeek))}`
            : `Date: ${escapeHTML(formatDate(r.date))}`}
          <br>Time: ${escapeHTML(formatTime(r.time))}
          ${r.dose ? `<br>Dose: ${escapeHTML(r.dose)}` : ""}
          ${r.notes ? `<br>Notes: ${escapeHTML(r.notes)}` : ""}
        </div>
      </div>
      <div class="record-actions">
        <button class="btn secondary small" data-edit-rem="${escapeHTML(id)}">Edit</button>
        <button class="btn danger small" data-del-rem="${escapeHTML(id)}">Delete</button>
      </div>
    </article>
  `).join("") : '<div class="empty">No reminders created yet.</div>';
}

function renderHistory() {
  const entries = getActivities();

  $("historyList").innerHTML = entries.length ? entries.slice(0, 100).map(a => `
    <article class="record">
      <div class="record-main">
        <div class="record-title">${escapeHTML(a.action)}</div>
        <div class="record-detail">${escapeHTML(a.detail)}<br>${escapeHTML(formatStamp(a.timestamp))}</div>
      </div>
    </article>
  `).join("") : '<div class="empty">No activity history yet.</div>';

  $("notificationList").innerHTML = entries.length ? entries.slice(0, 30).map(a => `
    <article class="record">
      <div class="record-main">
        <div class="record-title">${escapeHTML(a.action)}</div>
        <div class="record-detail">${escapeHTML(a.detail)}<br>${escapeHTML(formatStamp(a.timestamp))}</div>
      </div>
    </article>
  `).join("") : '<div class="empty">No notifications yet.</div>';
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

/* Medicine form */
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
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 100000 ||
      !Number.isInteger(refillAt) || refillAt < 0 || refillAt > 100000) {
    message("pageMessage", "Enter valid whole-number quantities.", "error");
    return;
  }
  if (!$("medicineDetailsVerified").checked) {
    message("pageMessage", "Please verify the medicine details before saving.", "error");
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

    await logActivity(id ? "Medicine updated" : "Medicine added", name);
    resetMedicineForm();
    message("pageMessage", "Medicine saved successfully.");
  } catch (error) {
    console.error(error);
    message("pageMessage", "Unable to save medicine. Check your Firebase connection and database rules.", "error");
  } finally {
    busy = false;
    $("saveMedicine").disabled = false;
  }
});

async function recordRefill(id) {
  const med = medicines[id];
  if (!med) return;

  const input = prompt(`How many units are being added to ${med.name}?`, "30");
  if (input === null) return;
  const amount = Number(input);

  if (!Number.isInteger(amount) || amount <= 0 || amount > 100000) {
    alert("Enter a positive whole number up to 100,000.");
    return;
  }

  try {
    const newQuantity = Number(med.quantity || 0) + amount;
    await update(ref(db, dataPath(`medicines/${id}`)), {
      quantity: newQuantity,
      updatedAt: Date.now()
    });
    await logActivity("Medicine refilled", `${med.name}: added ${amount} units. New stock: ${newQuantity}.`);
  } catch (error) {
    alert("Unable to record refill: " + error.message);
  }
}

async function deleteMedicine(id) {
  const med = medicines[id];
  if (!med || !confirm(`Delete ${med.name} and its reminders?`)) return;

  try {
    const changes = {};
    changes[dataPath(`medicines/${id}`)] = null;

    for (const [rid, reminder] of Object.entries(reminders)) {
      if (reminder.medicineId === id) changes[dataPath(`reminders/${rid}`)] = null;
    }

    await update(ref(db), changes);
    await logActivity("Medicine deleted", med.name);
  } catch (error) {
    alert("Unable to delete medicine: " + error.message);
  }
}

$("medicineList").addEventListener("click", async event => {
  const edit = event.target.closest("[data-edit-med]");
  const del = event.target.closest("[data-del-med]");
  const stock = event.target.closest("[data-stock-med]");

  if (stock) return recordRefill(stock.dataset.stockMed);
  if (del) return deleteMedicine(del.dataset.delMed);
  if (!edit) return;

  const id = edit.dataset.editMed;
  const med = medicines[id];
  if (!med) return;

  $("medicineEditId").value = id;
  $("medicineName").value = med.name || "";
  $("medicineDosage").value = med.dosage || "";
  $("medicineQuantity").value = med.quantity ?? 0;
  $("medicineRefillAt").value = med.refillAt ?? 5;
  $("medicineInstructions").value = med.instructions || "";
  $("medicineNotes").value = med.notes || "";
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

/* Reminder form */
$("recurrenceType").addEventListener("change", () => {
  const weekly = $("recurrenceType").value === "weekly";
  $("onceDateField").style.display = weekly ? "none" : "";
  $("weeklyDaysField").style.display = weekly ? "" : "none";
  $("reminderDate").required = !weekly;
});

$("toggleReminderForm").addEventListener("click", () => {
  if (!Object.keys(medicines).length) {
    message("reminderMessage", "Add a medicine before scheduling reminders.", "error");
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
  const daysOfWeek = [...document.querySelectorAll('input[name="weeklyDay"]:checked')]
    .map(input => Number(input.value));

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
      `${medicineName(medicineId)} — ${recurrence === "weekly" ? "weekly: " + dayNames(daysOfWeek) : formatDate(date)} at ${formatTime(time)}`
    );

    resetReminderForm();
  } catch (error) {
    console.error(error);
    message("reminderMessage", "Unable to save reminder. Check your Firebase connection and database rules.", "error");
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
      await remove(ref(db, dataPath(`reminders/${id}`)));
      await logActivity("Reminder deleted", medicineName(reminders[id]?.medicineId));
    } catch (error) {
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

/* QR scanner */
function scannerStatus(text) {
  $("scannerStatus").textContent = text;
}

async function stopQrScanner() {
  scanning = false;
  if (scanFrame !== null) {
    cancelAnimationFrame(scanFrame);
    scanFrame = null;
  }
  if (qrStream) {
    qrStream.getTracks().forEach(track => track.stop());
    qrStream = null;
  }
  $("qrVideo").srcObject = null;
  $("scannerView").classList.remove("scanning");
  $("startQrScanner").disabled = false;
  $("stopQrScanner").disabled = true;
}

function useScannedCode(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) return;

  let code = value;
  try {
    const url = new URL(value);
    code = url.searchParams.get("code") ||
           url.searchParams.get("connectionCode") ||
           url.searchParams.get("token") || value;
  } catch {
    // QR value is plain text rather than a URL.
  }

  $("connectionCode").value = code;
  scannerStatus("QR code detected. Check the code above, then select Connect patient.");
  message("connectionMessage", "Code scanned. Verify it before connecting.", "success");
  stopQrScanner();
}

async function scanVideoFrame() {
  if (!scanning) return;

  const video = $("qrVideo");
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && qrDetector) {
    try {
      const results = await qrDetector.detect(video);
      if (results?.length && results[0].rawValue) {
        useScannedCode(results[0].rawValue);
        return;
      }
    } catch (error) {
      console.warn("QR scan frame error:", error);
    }
  }

  if (scanning) scanFrame = requestAnimationFrame(scanVideoFrame);
}

$("startQrScanner").addEventListener("click", async () => {
  hideMessage("connectionMessage");

  if (!("BarcodeDetector" in window)) {
    scannerStatus("QR scanning is not supported in this browser. Try Chrome on HTTPS, or enter the code manually.");
    message("connectionMessage", "This browser does not support built-in QR scanning. You can enter the code manually.", "error");
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    scannerStatus("Camera access is unavailable. Open the site over HTTPS or localhost, or enter the code manually.");
    return;
  }

  try {
    qrDetector = new BarcodeDetector({ formats: ["qr_code"] });
    $("startQrScanner").disabled = true;
    scannerStatus("Requesting camera permission…");

    qrStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false
    });

    $("qrVideo").srcObject = qrStream;
    $("scannerView").classList.add("scanning");
    await $("qrVideo").play();

    scanning = true;
    $("stopQrScanner").disabled = false;
    scannerStatus("Camera active. Hold the patient's QR code inside the camera view.");
    scanVideoFrame();
  } catch (error) {
    console.error("QR camera error:", error);
    await stopQrScanner();
    scannerStatus("Unable to start the camera. Check browser permissions or enter the code manually.");
    message("connectionMessage", "Camera access failed. Allow camera permission and try again, or enter the code manually.", "error");
  }
});

$("stopQrScanner").addEventListener("click", async () => {
  await stopQrScanner();
  scannerStatus("Scanner stopped. You can restart it or enter the code manually.");
});

$("qrImageInput").addEventListener("change", async event => {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    if (!("BarcodeDetector" in window)) {
      message("connectionMessage", "QR image scanning is not supported in this browser. Enter the code manually.", "error");
      return;
    }
    const detector = new BarcodeDetector({ formats: ["qr_code"] });
    const bitmap = await createImageBitmap(file);
    const results = await detector.detect(bitmap);
    bitmap.close?.();

    if (results?.length && results[0].rawValue) {
      useScannedCode(results[0].rawValue);
    } else {
      message("connectionMessage", "No QR code was found in that image. Try a clearer image or enter the code manually.", "error");
    }
  } catch (error) {
    console.error("QR image scan error:", error);
    message("connectionMessage", "Could not scan this image. Try another image or enter the code manually.", "error");
  } finally {
    event.target.value = "";
  }
});

/*
  IMPORTANT:
  This looks up the existing connectionCodes/{code} structure.
  A successful lookup does not grant cross-account access.
  Complete the trusted patient-consent workflow and secure Firebase
  rules before changing activePatientUid or reading another user's data.
*/
$("connectionForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!user) return;

  const code = $("connectionCode").value.trim();
  if (!code) {
    message("connectionMessage", "Enter or scan a patient connection code.", "error");
    return;
  }

  const button = $("connectPatientButton");
  button.disabled = true;
  button.textContent = "Checking code…";
  hideMessage("connectionMessage");

  try {
    const snapshot = await get(ref(db, `connectionCodes/${code}`));

    if (!snapshot.exists()) {
      message("connectionMessage", "Code not found. Check the code or ask the patient to generate a new one.", "error");
      return;
    }

    const record = snapshot.val();
    const patientId = record.patientUid;

    if (!patientId || typeof patientId !== "string") {
      message("connectionMessage", "This code has no valid patient reference. Please generate a valid code through the connection workflow.", "error");
      return;
    }

    if (patientId === user.uid) {
      message("connectionMessage", "You cannot connect an account to itself.", "error");
      return;
    }

    message(
      "connectionMessage",
      "Code found. Before patient records can be accessed, the verified connection workflow must confirm consent and authorize this caregiver in Firebase.",
      "error"
    );
  } catch (error) {
    console.error("Connection lookup error:", error);
    message(
      "connectionMessage",
      "Connection lookup failed. Check the connectionCodes database path and Firebase security rules.",
      "error"
    );
  } finally {
    button.disabled = false;
    button.textContent = "Connect patient";
  }
});

/* Navigation and modals */
document.querySelectorAll("[data-page]").forEach(button => {
  button.addEventListener("click", () => showPage(button.dataset.page));
});

$("openConnection").addEventListener("click", () => openModal("connectionOverlay"));
$("openNotifications").addEventListener("click", () => openModal("notificationsOverlay"));
$("openProfile").addEventListener("click", () => openModal("profileOverlay"));
$("profileButton").addEventListener("click", () => openModal("profileOverlay"));

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
    document.querySelectorAll(".overlay.open").forEach(async el => {
      await closeModal(el.id);
    });
  }
});

$("refreshHistory").addEventListener("click", renderHistory);
$("markRead").addEventListener("click", () => closeModal("notificationsOverlay"));

/* Password and logout */
$("passwordForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!user) return;

  const current = $("currentPassword").value;
  const next = $("newPassword").value;
  const confirmNext = $("confirmPassword").value;

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
    const credential = EmailAuthProvider.credential(user.email, current);
    await reauthenticateWithCredential(user, credential);
    await updatePassword(user, next);
    $("passwordForm").reset();
    message("passwordMessage", "Password updated successfully.");
    await logActivity("Password changed", "Account password updated.");
  } catch (error) {
    const text = ["auth/invalid-credential", "auth/wrong-password", "auth/invalid-login-credentials"].includes(error.code)
      ? "Your current password is incorrect."
      : error.code === "auth/requires-recent-login"
        ? "Please sign in again before changing your password."
        : error.message;
    message("passwordMessage", text, "error");
  }
});

$("logoutButton").addEventListener("click", async () => {
  if (!confirm("Are you sure you want to log out?")) return;
  try {
    await stopQrScanner();
    stopSubscriptions();
    await signOut(auth);
    window.location.replace("login.html");
  } catch (error) {
    alert("Unable to log out: " + error.message);
  }
});

/* Authentication and Firebase listeners */
onAuthStateChanged(auth, async authenticatedUser => {
  if (!authenticatedUser) {
    stopSubscriptions();
    window.location.replace("login.html");
    return;
  }

  stopSubscriptions();
  user = authenticatedUser;
  activePatientUid = null;

  $("displayName").textContent = user.displayName || "My account";
  $("avatar").textContent = (user.displayName || user.email || "A")[0].toUpperCase();
  $("welcomeTitle").textContent = `Welcome, ${(user.displayName || "there").split(" ")[0]}!`;
  $("profileEmail").textContent = user.email || "";

  // Until a verified patient relationship is implemented, the
  // dashboard reads and writes only the signed-in account's data.
  subscribe("medicines", value => {
    medicines = value;
    renderMedicines();
  });

  subscribe("reminders", value => {
    reminders = value;
    renderReminders();
  });

  const historyUnsub = onValue(ref(db, accountPath("activity")), snap => {
    activities = snap.val() || {};
    renderHistory();
  }, error => console.error("History subscription failed:", error));

  unsubs.push(historyUnsub);
});

window.addEventListener("beforeunload", () => {
  stopQrScanner();
  stopSubscriptions();
});
