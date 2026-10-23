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

const pages = {
  medicinesPage: ["Medicines", "Manage patient medicine records."],
  remindersPage: ["Reminders", "Manage one-time and weekly schedules."],
  refillsPage: ["Refill tracker", "Monitor medicine stock levels."],
  historyPage: ["Activity history", "Review recent changes."]
};

const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
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

function closeModal(id) {
  $(id)?.classList.remove("open");
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
    month: "short",
    day: "numeric",
    year: "numeric"
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
  unsubs.forEach(fn => fn());
  unsubs = [];
}

function subscribe(path, callback) {
  const unsub = onValue(
    ref(db, dataPath(path)),
    snap => callback(snap.val() || {}),
    error => {
      console.error("Firebase subscription error:", error);

      message(
        "pageMessage",
        "Unable to access these records. Check Firebase Database Rules and patient authorization.",
        "error"
      );
    }
  );

  unsubs.push(unsub);
}

// ==========================================
// MEDICINES
// ==========================================

function renderMedicines() {
  const entries = Object.entries(medicines);

  $("medicineCount").textContent = entries.length;

  $("medicineList").innerHTML = entries.length
    ? entries.map(([id, m]) => {
        const low =
          Number(m.quantity ?? 0) <= Number(m.refillAt ?? 0);

        return `
          <article class="record">
            <div class="record-main">
              <div class="record-title">
                💊 ${escapeHTML(m.name)}
              </div>

              <div class="record-detail">
                ${m.dosage
                  ? `Strength: ${escapeHTML(m.dosage)}<br>`
                  : ""}

                ${m.instructions
                  ? `Instructions: ${escapeHTML(m.instructions)}<br>`
                  : ""}

                ${m.barcode
                  ? `Barcode: ${escapeHTML(m.barcode)}<br>`
                  : ""}

                Stock: ${Number(m.quantity ?? 0)} units

                ${low
                  ? '<br><strong style="color:#c53d3d">Refill needed</strong>'
                  : ""}

                ${m.notes
                  ? `<br>Notes: ${escapeHTML(m.notes)}`
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

  const select = $("reminderMedicine");
  const previous = select.value;

  select.innerHTML =
    '<option value="">Choose medicine</option>' +
    entries.map(([id, m]) =>
      `<option value="${escapeHTML(id)}">${escapeHTML(m.name)}</option>`
    ).join("");

  if (medicines[previous]) {
    select.value = previous;
  }

  renderRefills();
  renderReminders();
}

function renderRefills() {
  const entries = Object.entries(medicines).filter(([, m]) =>
    Number(m.quantity ?? 0) <= Number(m.refillAt ?? 0)
  );

  $("refillCount").textContent = entries.length;

  $("refillList").innerHTML = entries.length
    ? entries.map(([id, m]) => `
        <article class="record">
          <div class="record-main">
            <div class="record-title">
              📦 ${escapeHTML(m.name)}
            </div>

            <div class="record-detail">
              Remaining: ${Number(m.quantity ?? 0)} units ·
              Alert level: ${Number(m.refillAt ?? 0)} units
            </div>
          </div>

          <button class="btn small"
            data-stock-med="${escapeHTML(id)}">
            Record refill
          </button>
        </article>
      `).join("")
    : '<div class="empty">All recorded medicine quantities are above their refill thresholds.</div>';
}

function dayNames(days) {
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (Array.isArray(days) ? days : [])
    .map(d => names[Number(d)])
    .filter(Boolean)
    .join(", ");
}

function renderReminders() {
  const entries = Object.entries(reminders).sort((a, b) =>
    (a[1].time || "").localeCompare(b[1].time || "")
  );

  $("reminderCount").textContent = entries.length;

  $("reminderList").innerHTML = entries.length
    ? entries.map(([id, r]) => `
        <article class="record">
          <div class="record-main">
            <div class="record-title">
              🔔 ${escapeHTML(medicineName(r.medicineId))}
            </div>

            <div class="record-detail">
              ${r.recurrence === "weekly"
                ? `Every week: ${escapeHTML(dayNames(r.daysOfWeek))}`
                : `Date: ${escapeHTML(formatDate(r.date))}`}

              <br>Time: ${escapeHTML(formatTime(r.time))}

              ${r.dose
                ? `<br>Dose: ${escapeHTML(r.dose)}`
                : ""}

              ${r.notes
                ? `<br>Notes: ${escapeHTML(r.notes)}`
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

// ==========================================
// HISTORY AND NOTIFICATIONS
// ==========================================

function renderHistory() {
  const entries = getActivities();

  $("historyList").innerHTML = entries.length
    ? entries.slice(0, 100).map(a => `
        <article class="record">
          <div class="record-main">
            <div class="record-title">
              ${escapeHTML(a.action)}
            </div>

            <div class="record-detail">
              ${escapeHTML(a.detail)}<br>
              ${escapeHTML(formatStamp(a.timestamp))}
            </div>
          </div>
        </article>
      `).join("")
    : '<div class="empty">No activity history yet.</div>';

  $("notificationList").innerHTML = entries.length
    ? entries.slice(0, 30).map(a => `
        <article class="record">
          <div class="record-main">
            <div class="record-title">
              ${escapeHTML(a.action)}
            </div>

            <div class="record-detail">
              ${escapeHTML(a.detail)}<br>
              ${escapeHTML(formatStamp(a.timestamp))}
            </div>
          </div>
        </article>
      `).join("")
    : '<div class="empty">No notifications yet.</div>';
}

// ==========================================
// FORM RESET
// ==========================================

function resetMedicineForm() {
  $("medicineFormElement").reset();

  $("medicineEditId").value = "";
  $("medicineQuantity").value = "0";
  $("medicineRefillAt").value = "5";
  $("medicineFormTitle").textContent = "Add medicine";
  $("saveMedicine").textContent = "Save medicine";

  $("medicineForm").classList.remove("open");

  $("scannerStatus").textContent =
    "Capture a photo to read the printed medicine name and strength. Check the results before saving.";
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

// ==========================================
// MEDICINE PHOTO OCR SCANNER
// ==========================================

async function stopCamera() {
  // The scanner uses a captured photo instead of a live barcode stream.
  const photoInput = $("medicinePhotoInput");

  if (photoInput) {
    photoInput.value = "";
  }
}

function parseMedicineText(rawText) {
  const lines = rawText
    .split(/\r?\n/)
    .map(line =>
      line
        .replace(/[|]/g, "I")
        .replace(/[^\p{L}\p{N}®™%.,/+() -]/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(line => line.length >= 2);

  // Find common medicine strengths, such as 500 mg or 5 mg/mL.
  const strengthRegex =
    /\b\d+(?:[.,]\d+)?\s?(?:mg|mcg|µg|ug|g|kg|ml|mL|µl|iu|units?)(?:\s*\/\s*\d+(?:[.,]\d+)?\s?(?:ml|mL|g|mg))?\b/i;

  const strengthLine = lines.find(line =>
    strengthRegex.test(line)
  );

  const strengthMatch = strengthLine
    ? strengthLine.match(strengthRegex)
    : null;

  const dosage = strengthMatch
    ? strengthMatch[0].replace(/\s+/g, " ").trim()
    : "";

  const ignore = /^(?:medicines?|tablets?|capsules?|oral|suspension|solution|syrup|for oral use|prescription only|keep out of reach|store below|dosage|strength|composition|each tablet|each capsule|contains|warning|caution|expiry|batch|lot|manufactured|manufacturer|net contents|directions|take as directed|pharmacy|generic name|active ingredient)$/i;

  const candidates = lines.filter(line => {
    if (ignore.test(line)) return false;
    if (strengthRegex.test(line)) return false;

    if (/^(?:\d+[.)]?\s*)?(?:tablets?|capsules?|pcs?|pieces?)\b/i.test(line)) {
      return false;
    }

    if (line.length < 3 || line.length > 65) return false;

    if (/https?:|www\.|batch\s*(?:no|number)|expiry|exp\s*date|mfg\s*date/i.test(line)) {
      return false;
    }

    return /[a-zA-Z]{3,}/.test(line);
  });

  // Prefer a likely product name close to the strength line.
  let name = "";

  if (strengthLine) {
    const strengthIndex = lines.indexOf(strengthLine);

    for (
      let i = strengthIndex - 1;
      i >= Math.max(0, strengthIndex - 3);
      i--
    ) {
      if (candidates.includes(lines[i])) {
        name = lines[i];
        break;
      }
    }
  }

  if (!name) {
    name = candidates[0] || "";
  }

  name = name
    .replace(/\s+(?:\d+(?:[.,]\d+)?\s?(?:mg|mcg|µg|ug|g|ml|mL|iu)\b).*$/i, "")
    .trim();

  return { name, dosage, lines };
}

$("startScanner").addEventListener("click", () => {
  hideMessage("pageMessage");

  if (!window.Tesseract?.recognize) {
    $("scannerStatus").textContent =
      "Text recognition is loading or unavailable. Check your internet connection and try again.";
  }

  $("medicinePhotoInput").click();
});

$("medicinePhotoInput").addEventListener("change", async event => {
  const file = event.target.files?.[0];
  const status = $("scannerStatus");
  const button = $("startScanner");

  if (!file) return;

  if (!file.type.startsWith("image/")) {
    status.textContent =
      "Please choose an image of the medicine label.";
    event.target.value = "";
    return;
  }

  if (!window.Tesseract?.recognize) {
    status.textContent =
      "Text recognition could not load. Check your internet connection and refresh the page.";
    event.target.value = "";
    return;
  }

  button.disabled = true;
  status.textContent =
    "Reading the medicine label. Please keep this page open.";

  try {
    const result = await window.Tesseract.recognize(
      file,
      "eng",
      {
        logger: info => {
          if (
            info.status === "recognizing text" &&
            typeof info.progress === "number"
          ) {
            status.textContent =
              `Reading image… ${Math.round(info.progress * 100)}%`;
          }
        }
      }
    );

    const detectedText = result?.data?.text || "";
    const parsed = parseMedicineText(detectedText);

    if (parsed.name) {
      $("medicineName").value = parsed.name;
    }

    if (parsed.dosage) {
      $("medicineDosage").value = parsed.dosage;
    }

    if (parsed.name || parsed.dosage) {
      status.textContent =
        `Text detected. ${parsed.name ? `Name: ${parsed.name}. ` : "Name not confidently detected. "}${parsed.dosage ? `Strength: ${parsed.dosage}.` : "Strength not detected; enter it manually."} Verify the fields against the package before saving.`;

      $("medicineName").focus();
    } else {
      status.textContent =
        "No clear medicine name or strength found. Try a brighter, sharper photo with the label filling the frame, or enter the details manually.";
    }
  } catch (error) {
    console.error("Medicine label OCR failed:", error);

    status.textContent =
      "Could not read this image. Try another clear photo or enter the details manually.";
  } finally {
    button.disabled = false;
    event.target.value = "";
  }
});

// ==========================================
// ADD, EDIT AND DELETE MEDICINES
// ==========================================

$("toggleMedicineForm").addEventListener("click", () => {
  $("medicineForm").classList.toggle("open");
});

$("cancelMedicine").addEventListener("click", () => {
  resetMedicineForm();
  hideMessage("pageMessage");
});

$("medicineFormElement").addEventListener("submit", async event => {
  event.preventDefault();

  if (busy) return;

  const name = $("medicineName").value.trim();
  const quantity = Number($("medicineQuantity").value);
  const refillAt = Number($("medicineRefillAt").value);

  if (
    !name ||
    quantity < 0 ||
    refillAt < 0 ||
    !Number.isFinite(quantity) ||
    !Number.isFinite(refillAt)
  ) {
    message(
      "pageMessage",
      "Enter a medicine name and valid non-negative quantities.",
      "error"
    );
    return;
  }

  busy = true;
  $("saveMedicine").disabled = true;

  try {
    const id = $("medicineEditId").value;

    const record = {
      name,
      dosage: $("medicineDosage").value.trim(),
      barcode: $("medicineBarcode").value.trim(),
      quantity,
      refillAt,
      instructions: $("medicineInstructions").value.trim(),
      notes: $("medicineNotes").value.trim(),
      updatedAt: Date.now()
    };

    if (id) {
      await update(
        ref(db, dataPath(`medicines/${id}`)),
        record
      );
    } else {
      record.createdAt = Date.now();

      await set(
        push(ref(db, dataPath("medicines"))),
        record
      );
    }

    await logActivity(
      id ? "Medicine updated" : "Medicine added",
      name
    );

    resetMedicineForm();
    message("pageMessage", "Medicine saved successfully.");
  } catch (error) {
    message(
      "pageMessage",
      `Unable to save medicine: ${error.message}`,
      "error"
    );
  } finally {
    busy = false;
    $("saveMedicine").disabled = false;
  }
});

async function recordRefill(id) {
  const med = medicines[id];

  if (!med) return;

  const input = prompt(
    `How many units are being added to ${med.name}?`,
    "30"
  );

  if (input === null) return;

  const amount = Number(input);

  if (!Number.isInteger(amount) || amount <= 0) {
    alert("Enter a positive whole number.");
    return;
  }

  try {
    const newQuantity = Number(med.quantity || 0) + amount;

    await update(
      ref(db, dataPath(`medicines/${id}`)),
      {
        quantity: newQuantity,
        updatedAt: Date.now()
      }
    );

    await logActivity(
      "Medicine refilled",
      `${med.name}: added ${amount} units. New stock: ${newQuantity}.`
    );
  } catch (error) {
    alert("Unable to record refill: " + error.message);
  }
}

async function deleteMedicine(id) {
  const med = medicines[id];

  if (!med || !confirm(`Delete ${med.name} and its reminders?`)) {
    return;
  }

  try {
    const changes = {};

    changes[dataPath(`medicines/${id}`)] = null;

    for (const [rid, r] of Object.entries(reminders)) {
      if (r.medicineId === id) {
        changes[dataPath(`reminders/${rid}`)] = null;
      }
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

  if (stock) {
    return recordRefill(stock.dataset.stockMed);
  }

  if (del) {
    return deleteMedicine(del.dataset.delMed);
  }

  if (!edit) return;

  const id = edit.dataset.editMed;
  const m = medicines[id];

  if (!m) return;

  $("medicineEditId").value = id;
  $("medicineName").value = m.name || "";
  $("medicineDosage").value = m.dosage || "";
  $("medicineBarcode").value = m.barcode || "";
  $("medicineQuantity").value = m.quantity ?? 0;
  $("medicineRefillAt").value = m.refillAt ?? 5;
  $("medicineInstructions").value = m.instructions || "";
  $("medicineNotes").value = m.notes || "";

  $("medicineFormTitle").textContent = "Edit medicine";
  $("saveMedicine").textContent = "Update medicine";
  $("medicineForm").classList.add("open");

  window.scrollTo({ top: 0, behavior: "smooth" });
});

$("refillList").addEventListener("click", event => {
  const button = event.target.closest("[data-stock-med]");

  if (button) {
    recordRefill(button.dataset.stockMed);
  }
});

// ==========================================
// REMINDERS: ONE-TIME OR RECURRING WEEKLY
// ==========================================

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

  if (busy) return;

  const medicineId = $("reminderMedicine").value;
  const recurrence = $("recurrenceType").value;
  const date = $("reminderDate").value;
  const time = $("reminderTime").value;

  const daysOfWeek = [
    ...document.querySelectorAll('input[name="weeklyDay"]:checked')
  ].map(input => Number(input.value));

  if (!medicines[medicineId]) {
    message(
      "reminderMessage",
      "Choose a valid medicine.",
      "error"
    );
    return;
  }

  if (!time) {
    message(
      "reminderMessage",
      "Choose a reminder time.",
      "error"
    );
    return;
  }

  if (recurrence === "once" && (!date || date < localDate())) {
    message(
      "reminderMessage",
      "Choose today or a future date.",
      "error"
    );
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
      await update(
        ref(db, dataPath(`reminders/${id}`)),
        record
      );
    } else {
      record.createdAt = Date.now();

      await set(
        push(ref(db, dataPath("reminders"))),
        record
      );
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
  } catch (error) {
    message(
      "reminderMessage",
      `Unable to save reminder: ${error.message}`,
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
      await remove(ref(db, dataPath(`reminders/${id}`)));

      await logActivity(
        "Reminder deleted",
        medicineName(reminders[id]?.medicineId)
      );
    } catch (error) {
      alert(error.message);
    }

    return;
  }

  if (!edit) return;

  const id = edit.dataset.editRem;
  const r = reminders[id];

  if (!r) return;

  showPage("remindersPage");

  $("reminderForm").classList.add("open");
  $("reminderEditId").value = id;
  $("reminderMedicine").value = r.medicineId || "";
  $("recurrenceType").value = r.recurrence || "once";
  $("reminderDate").value = r.date || "";
  $("reminderTime").value = r.time || "08:00";
  $("reminderDose").value = r.dose || "";
  $("reminderNotes").value = r.notes || "";

  document.querySelectorAll('input[name="weeklyDay"]').forEach(input => {
    input.checked = (r.daysOfWeek || []).includes(Number(input.value));
  });

  $("recurrenceType").dispatchEvent(new Event("change"));
  $("saveReminder").textContent = "Update reminder";
});

// ==========================================
// NAVIGATION AND MODALS
// ==========================================

document.querySelectorAll("[data-page]").forEach(button => {
  button.addEventListener("click", () => {
    showPage(button.dataset.page);
  });
});

$("openConnection").addEventListener("click", () =>
  openModal("connectionOverlay")
);

$("openNotifications").addEventListener("click", () =>
  openModal("notificationsOverlay")
);

$("openProfile").addEventListener("click", () =>
  openModal("profileOverlay")
);

$("profileButton").addEventListener("click", () =>
  openModal("profileOverlay")
);

document.querySelectorAll("[data-close]").forEach(button => {
  button.addEventListener("click", () => {
    closeModal(button.dataset.close);
  });
});

document.querySelectorAll(".overlay").forEach(overlay => {
  overlay.addEventListener("click", event => {
    if (event.target === overlay) {
      closeModal(overlay.id);
    }
  });
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    document.querySelectorAll(".overlay.open").forEach(el =>
      el.classList.remove("open")
    );
  }
});

$("refreshHistory").addEventListener("click", renderHistory);

$("markRead").addEventListener("click", () => {
  closeModal("notificationsOverlay");
});

// ==========================================
// PATIENT CONNECTION CODE
// ==========================================

$("connectionForm").addEventListener("submit", async event => {
  event.preventDefault();

  const code = $("connectionCode").value.trim();

  if (!code) {
    message(
      "connectionMessage",
      "Enter a patient connection code.",
      "error"
    );
    return;
  }

  try {
    const snapshot = await get(ref(db, `connectionCodes/${code}`));

    if (!snapshot.exists()) {
      message(
        "connectionMessage",
        "Code not found. Check the code or QR connection setup.",
        "error"
      );
      return;
    }

    const record = snapshot.val();
    const patientId = record.patientUid;

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

    message(
      "connectionMessage",
      "The code was found, but patient access still requires a verified authorization workflow and matching Firebase security rules.",
      "error"
    );
  } catch (error) {
    message(
      "connectionMessage",
      `Connection lookup failed: ${error.message}. Check your connection-code database path and rules.`,
      "error"
    );
  }
});

// ==========================================
// CHANGE PASSWORD
// ==========================================

$("passwordForm").addEventListener("submit", async event => {
  event.preventDefault();

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
    message(
      "passwordMessage",
      "New passwords do not match.",
      "error"
    );
    return;
  }

  if (next === current) {
    message(
      "passwordMessage",
      "Choose a different password.",
      "error"
    );
    return;
  }

  try {
    const credential = EmailAuthProvider.credential(
      user.email,
      current
    );

    await reauthenticateWithCredential(user, credential);
    await updatePassword(user, next);

    $("passwordForm").reset();

    message(
      "passwordMessage",
      "Password updated successfully."
    );

    await logActivity(
      "Password changed",
      "Account password updated."
    );
  } catch (error) {
    const text =
      error.code === "auth/invalid-credential" ||
      error.code === "auth/wrong-password" ||
      error.code === "auth/invalid-login-credentials"
        ? "Your current password is incorrect."
        : error.message;

    message("passwordMessage", text, "error");
  }
});

// ==========================================
// LOG OUT
// ==========================================

$("logoutButton").addEventListener("click", async () => {
  if (!confirm("Are you sure you want to log out?")) return;

  try {
    await stopCamera();
    await signOut(auth);
    window.location.replace("login.html");
  } catch (error) {
    alert("Unable to log out: " + error.message);
  }
});

// ==========================================
// FIREBASE AUTHENTICATION AND DATA
// ==========================================

onAuthStateChanged(auth, async authenticatedUser => {
  if (!authenticatedUser) {
    stopSubscriptions();
    window.location.replace("login.html");
    return;
  }

  stopSubscriptions();

  user = authenticatedUser;
  activePatientUid = null;

  $("displayName").textContent =
    user.displayName || "My account";

  $("avatar").textContent =
    (user.displayName || user.email || "A")[0].toUpperCase();

  $("welcomeTitle").textContent =
    `Welcome, ${(user.displayName || "there").split(" ")[0]}!`;

  $("profileEmail").textContent = user.email || "";

  // Loads records from the signed-in account by default.
  subscribe("medicines", value => {
    medicines = value;
    renderMedicines();
  });

  subscribe("reminders", value => {
    reminders = value;
    renderReminders();
  });

  const historyUnsub = onValue(
    ref(db, accountPath("activity")),
    snap => {
      activities = snap.val() || {};
      renderHistory();
    },
    error => {
      console.error("History subscription failed:", error);
    }
  );

  unsubs.push(historyUnsub);
});

window.addEventListener("beforeunload", () => {
  stopCamera();
  stopSubscriptions();
});