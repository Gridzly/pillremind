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
  get,
  push,
  set,
  update,
  remove
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const $ = id => document.getElementById(id);

let user = null;
let medicines = {};
let reminders = {};
let activities = {};
let activePatientUid = null;
let unsubs = [];
let busy = false;
let selectedMedicinePhoto = null;
let latestOcrResult = null;

const pages = {
  medicinesPage: ["Medicines", "Manage medicine records."],
  remindersPage: ["Reminders", "Manage one-time and weekly schedules."],
  refillsPage: ["Refill tracker", "Monitor medicine stock levels."],
  historyPage: ["Activity history", "Review recent changes."]
};

const escapeHTML = value =>
  String(value ?? "").replace(/[&<>"']/g, c => ({
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
  document.querySelectorAll(".page").forEach(page => {
    page.classList.toggle("active", page.id === id);
  });

  document.querySelectorAll("[data-page]").forEach(button => {
    button.classList.toggle("active", button.dataset.page === id);
  });

  if (pages[id]) {
    $("pageTitle").textContent = pages[id][0];
    $("pageSubtitle").textContent = pages[id][1];
  }

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function localDate() {
  const date = new Date();

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function formatDate(value) {
  if (!value) return "Date not set";

  const [year, month, day] = value.split("-").map(Number);

  return new Date(year, month - 1, day).toLocaleDateString("en-PH", {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

function formatTime(value) {
  if (!value) return "Time not set";

  const [hours, minutes] = value.split(":").map(Number);

  return `${hours % 12 || 12}:${String(minutes).padStart(2, "0")} ${
    hours >= 12 ? "PM" : "AM"
  }`;
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
  unsubs.forEach(unsubscribe => unsubscribe());
  unsubs = [];
}

function subscribe(path, callback) {
  const unsubscribe = onValue(
    ref(db, dataPath(path)),
    snapshot => callback(snapshot.val() || {}),
    error => {
      console.error("Firebase subscription error:", error);

      message(
        "pageMessage",
        "Unable to load records. Check your Firebase Database Rules and account access.",
        "error"
      );
    }
  );

  unsubs.push(unsubscribe);
}

// ============================================
// MEDICINE AND REFILL DISPLAY
// ============================================

function renderMedicines() {
  const entries = Object.entries(medicines);

  $("medicineCount").textContent = entries.length;

  $("medicineList").innerHTML = entries.length
    ? entries.map(([id, medicine]) => {
        const low =
          Number(medicine.quantity ?? 0) <=
          Number(medicine.refillAt ?? 0);

        return `
          <article class="record">
            <div class="record-main">
              <div class="record-title">
                💊 ${escapeHTML(medicine.name)}
              </div>

              <div class="record-detail">
                ${medicine.dosage
                  ? `Strength: ${escapeHTML(medicine.dosage)}<br>`
                  : ""}

                ${medicine.instructions
                  ? `Instructions: ${escapeHTML(medicine.instructions)}<br>`
                  : ""}

                Stock: ${Number(medicine.quantity ?? 0)} units

                ${low
                  ? '<br><strong style="color:#c53d3d">Refill needed</strong>'
                  : ""}

                ${medicine.notes
                  ? `<br>Notes: ${escapeHTML(medicine.notes)}`
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
    entries.map(([id, medicine]) =>
      `<option value="${escapeHTML(id)}">${escapeHTML(medicine.name)}</option>`
    ).join("");

  if (medicines[previous]) select.value = previous;

  renderRefills();
  renderReminders();
}

function renderRefills() {
  const entries = Object.entries(medicines).filter(([, medicine]) =>
    Number(medicine.quantity ?? 0) <= Number(medicine.refillAt ?? 0)
  );

  $("refillCount").textContent = entries.length;

  $("refillList").innerHTML = entries.length
    ? entries.map(([id, medicine]) => `
        <article class="record">
          <div class="record-main">
            <div class="record-title">📦 ${escapeHTML(medicine.name)}</div>
            <div class="record-detail">
              Remaining: ${Number(medicine.quantity ?? 0)} units<br>
              Refill threshold: ${Number(medicine.refillAt ?? 0)} units
            </div>
          </div>

          <button class="btn small" data-stock-med="${escapeHTML(id)}">
            Record refill
          </button>
        </article>
      `).join("")
    : '<div class="empty">No medicines currently need a refill based on their recorded stock.</div>';
}

// ============================================
// REMINDER DISPLAY
// ============================================

function dayNames(days) {
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (Array.isArray(days) ? days : [])
    .map(day => names[Number(day)])
    .filter(Boolean)
    .join(", ");
}

function renderReminders() {
  const entries = Object.entries(reminders).sort((a, b) =>
    (a[1].time || "").localeCompare(b[1].time || "")
  );

  $("reminderCount").textContent = entries.length;

  $("reminderList").innerHTML = entries.length
    ? entries.map(([id, reminder]) => `
        <article class="record">
          <div class="record-main">
            <div class="record-title">
              🔔 ${escapeHTML(medicineName(reminder.medicineId))}
            </div>

            <div class="record-detail">
              ${reminder.recurrence === "weekly"
                ? `Every week: ${escapeHTML(dayNames(reminder.daysOfWeek))}`
                : `Date: ${escapeHTML(formatDate(reminder.date))}`}

              <br>Time: ${escapeHTML(formatTime(reminder.time))}

              ${reminder.dose
                ? `<br>Dose: ${escapeHTML(reminder.dose)}`
                : ""}

              ${reminder.notes
                ? `<br>Notes: ${escapeHTML(reminder.notes)}`
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

// ============================================
// HISTORY
// ============================================

function renderHistory() {
  const entries = getActivities();

  $("historyList").innerHTML = entries.length
    ? entries.slice(0, 100).map(activity => `
        <article class="record">
          <div class="record-main">
            <div class="record-title">${escapeHTML(activity.action)}</div>
            <div class="record-detail">
              ${escapeHTML(activity.detail)}<br>
              ${escapeHTML(formatStamp(activity.timestamp))}
            </div>
          </div>
        </article>
      `).join("")
    : '<div class="empty">No activity history yet.</div>';

  $("notificationList").innerHTML = entries.length
    ? entries.slice(0, 30).map(activity => `
        <article class="record">
          <div class="record-main">
            <div class="record-title">${escapeHTML(activity.action)}</div>
            <div class="record-detail">
              ${escapeHTML(activity.detail)}<br>
              ${escapeHTML(formatStamp(activity.timestamp))}
            </div>
          </div>
        </article>
      `).join("")
    : '<div class="empty">No notifications yet.</div>';
}

// ============================================
// SCANNER: RESET AND PHOTO PREVIEW
// ============================================

function resetScanner() {
  selectedMedicinePhoto = null;
  latestOcrResult = null;

  $("medicinePhotoInput").value = "";
  $("medicinePhotoPreview").removeAttribute("src");
  $("photoPreviewWrap").classList.remove("visible");
  $("ocrResult").hidden = true;
  $("ocrRawText").textContent = "";

  $("scannerStatus").textContent =
    "No photo selected. Use bright, even lighting and keep the label in focus.";

  $("runOcrButton").disabled = false;
  $("startScanner").disabled = false;
}

$("startScanner").addEventListener("click", () => {
  $("medicinePhotoInput").click();
});

$("retakePhoto").addEventListener("click", () => {
  $("medicinePhotoInput").click();
});

$("medicinePhotoInput").addEventListener("change", event => {
  const file = event.target.files?.[0];

  if (!file) return;

  if (!file.type.startsWith("image/")) {
    $("scannerStatus").textContent =
      "Please select a valid photo of the medicine packaging.";
    event.target.value = "";
    return;
  }

  // Avoid unexpectedly large uploads/images that may exhaust browser memory.
  if (file.size > 15 * 1024 * 1024) {
    $("scannerStatus").textContent =
      "This image is larger than 15 MB. Take a smaller photo or resize it first.";
    event.target.value = "";
    return;
  }

  selectedMedicinePhoto = file;
  latestOcrResult = null;

  const previewUrl = URL.createObjectURL(file);

  const preview = $("medicinePhotoPreview");
  const oldUrl = preview.dataset.objectUrl;

  if (oldUrl) URL.revokeObjectURL(oldUrl);

  preview.dataset.objectUrl = previewUrl;
  preview.src = previewUrl;

  $("photoPreviewWrap").classList.add("visible");
  $("ocrResult").hidden = true;

  $("scannerStatus").textContent =
    "Review the photo. If the label is clear, select Read label. Retake the photo if it is blurry or has glare.";

  // A new image requires fresh verification before the medicine can be saved.
  $("medicineDetailsVerified").checked = false;
  $("medicinePhotoInput").value = "";
});

// ============================================
// SCANNER: IMAGE ENHANCEMENT
// ============================================

async function loadImageFromFile(file) {
  if ("createImageBitmap" in window) {
    return await createImageBitmap(file);
  }

  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);

    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };

    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("The selected photo could not be opened."));
    };

    image.src = url;
  });
}

async function enhanceMedicineImage(file) {
  const image = await loadImageFromFile(file);

  const originalWidth = image.width;
  const originalHeight = image.height;

  if (!originalWidth || !originalHeight) {
    throw new Error("The image has invalid dimensions.");
  }

  // Upscale small images, but limit the maximum size to control memory use.
  const scale = Math.min(
    2.5,
    2400 / Math.max(originalWidth, originalHeight)
  );

  const width = Math.max(1, Math.round(originalWidth * scale));
  const height = Math.max(1, Math.round(originalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d", {
    willReadFrequently: true
  });

  if (!context) {
    throw new Error("Image processing is unavailable in this browser.");
  }

  // Draw the image larger with a high-quality interpolation filter.
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, width, height);

  if (typeof image.close === "function") image.close();

  const frame = context.getImageData(0, 0, width, height);
  const pixels = frame.data;

  // Convert to grayscale, increase contrast, and gently brighten.
  // This can improve printed text, although it cannot restore missing detail.
  const contrast = 1.35;
  const brightness = 8;

  for (let i = 0; i < pixels.length; i += 4) {
    const gray =
      0.299 * pixels[i] +
      0.587 * pixels[i + 1] +
      0.114 * pixels[i + 2];

    let value = (gray - 128) * contrast + 128 + brightness;

    value = Math.max(0, Math.min(255, value));

    pixels[i] = value;
    pixels[i + 1] = value;
    pixels[i + 2] = value;
  }

  context.putImageData(frame, 0, 0);

  const enhancedBlob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error("Could not enhance the photo.")),
      "image/jpeg",
      0.94
    );
  });

  return enhancedBlob;
}

// ============================================
// SCANNER: OCR AND TEXT PARSING
// ============================================

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

  // Recognizes common strength units. This is text extraction, not a dose recommendation.
  const strengthRegex =
    /\b\d+(?:[.,]\d+)?\s?(?:mg|mcg|µg|ug|g|kg|ml|mL|µl|iu|units?)(?:\s*\/\s*\d+(?:[.,]\d+)?\s?(?:ml|mL|g|mg))?\b/i;

  const strengthLines = lines.filter(line => strengthRegex.test(line));

  const strengths = strengthLines
    .map(line => line.match(strengthRegex)?.[0])
    .filter(Boolean);

  const ignoreLine =
    /^(?:medicine|medicines|tablets?|capsules?|oral|suspension|solution|syrup|prescription only|keep out of reach|dosage|strength|composition|warning|caution|expiry|batch|lot|manufacturer|directions|pharmacy|generic name|active ingredient|each tablet|each capsule|store below)$/i;

  const candidates = lines.filter(line => {
    if (ignoreLine.test(line)) return false;
    if (strengthRegex.test(line)) return false;
    if (line.length < 3 || line.length > 65) return false;

    if (/https?:|www\.|batch\s*(?:no|number)|expiry|exp\s*date|mfg\s*date/i.test(line)) {
      return false;
    }

    return /[a-zA-Z]{3,}/.test(line);
  });

  // Prefer a text line near the strength, but never claim that it is verified.
  let name = "";

  if (strengthLines.length) {
    const index = lines.indexOf(strengthLines[0]);

    for (let i = index - 1; i >= Math.max(0, index - 3); i--) {
      if (candidates.includes(lines[i])) {
        name = lines[i];
        break;
      }
    }
  }

  if (!name) name = candidates[0] || "";

  name = name
    .replace(/\s+\d+(?:[.,]\d+)?\s?(?:mg|mcg|µg|ug|g|ml|mL|iu)\b.*$/i, "")
    .trim();

  // Return unique extracted strength strings for manual selection if there are several.
  const uniqueStrengths = [...new Set(
    strengths.map(s => s.replace(/\s+/g, " ").trim())
  )];

  return {
    name,
    dosage: uniqueStrengths.length === 1 ? uniqueStrengths[0] : "",
    strengths: uniqueStrengths,
    lines
  };
}

async function runTesseract(blob, label) {
  if (!window.Tesseract?.recognize) {
    throw new Error(
      "The OCR library is unavailable. Check your internet connection and refresh the page."
    );
  }

  $("scannerStatus").textContent = `Reading ${label} image…`;

  return window.Tesseract.recognize(blob, "eng", {
    logger: info => {
      if (
        info.status === "recognizing text" &&
        typeof info.progress === "number"
      ) {
        $("scannerStatus").textContent =
          `Reading ${label} image… ${Math.round(info.progress * 100)}%`;
      }
    }
  });
}

$("runOcrButton").addEventListener("click", async () => {
  if (!selectedMedicinePhoto) {
    $("scannerStatus").textContent =
      "Capture or select a medicine-box photo first.";
    return;
  }

  if (!window.Tesseract?.recognize) {
    $("scannerStatus").textContent =
      "OCR could not load. Check your internet connection and refresh the page.";
    return;
  }

  const button = $("runOcrButton");
  button.disabled = true;
  $("startScanner").disabled = true;

  $("ocrResult").hidden = true;
  $("scannerStatus").textContent =
    "Enhancing the photo and recognizing printed text. Please wait…";

  try {
    // Pass 1: enhanced image.
    const enhanced = await enhanceMedicineImage(selectedMedicinePhoto);
    const enhancedResult = await runTesseract(enhanced, "enhanced");
    let bestResult = enhancedResult;

    // Pass 2: original image. Choose the result with the higher OCR confidence.
    // OCR confidence is not medicine identity confidence.
    try {
      const originalResult = await runTesseract(selectedMedicinePhoto, "original");

      const enhancedConfidence = Number(enhancedResult?.data?.confidence || 0);
      const originalConfidence = Number(originalResult?.data?.confidence || 0);

      if (originalConfidence > enhancedConfidence) {
        bestResult = originalResult;
      }
    } catch (secondPassError) {
      console.warn("Original-image OCR pass failed:", secondPassError);
    }

    const rawText = bestResult?.data?.text || "";
    const confidence = Number(bestResult?.data?.confidence || 0);
    const parsed = parseMedicineText(rawText);

    latestOcrResult = {
      rawText,
      confidence,
      parsed
    };

    $("ocrRawText").textContent =
      rawText.trim() || "No readable text was found.";

    $("ocrResult").hidden = false;

    // Fill only fields that were extracted. Never save automatically.
    if (parsed.name) {
      $("medicineName").value = parsed.name;
    }

    if (parsed.dosage) {
      $("medicineDosage").value = parsed.dosage;
    } else if (parsed.strengths.length > 1) {
      $("scannerStatus").textContent =
        `Several possible strengths were detected (${parsed.strengths.join(", ")}). Choose the correct strength from the packaging and enter it manually.`;
    }

    // Every OCR run clears verification. The user must check the fields.
    $("medicineDetailsVerified").checked = false;

    if (!rawText.trim()) {
      $("scannerStatus").textContent =
        "No readable text was found. Retake the photo with the label flat, well-lit, and in focus, or enter the details manually.";
    } else if (confidence < 55) {
      $("scannerStatus").textContent =
        `OCR confidence is low (${Math.round(confidence)}%). The fields may be wrong. Compare the raw recognized text and photo with the packaging, then correct the fields manually.`;
    } else if (!parsed.name || !parsed.dosage) {
      $("scannerStatus").textContent =
        "Some text was detected, but the name or strength could not be confidently separated. Review the recognized text and complete the fields manually.";
    } else {
      $("scannerStatus").textContent =
        `Text extraction finished (OCR confidence ${Math.round(confidence)}%). This is not a guarantee of accuracy. Verify and correct the medicine name and strength before saving.`;
    }

    $("medicineName").focus();
  } catch (error) {
    console.error("Medicine OCR failed:", error);

    $("scannerStatus").textContent =
      `Could not read this photo: ${error.message}. Try another clear photo or enter the details manually.`;
  } finally {
    button.disabled = false;
    $("startScanner").disabled = false;
  }
});

// ============================================
// RESET FORMS
// ============================================

function resetMedicineForm() {
  $("medicineFormElement").reset();

  $("medicineEditId").value = "";
  $("medicineQuantity").value = "0";
  $("medicineRefillAt").value = "5";
  $("medicineFormTitle").textContent = "Add medicine";
  $("saveMedicine").textContent = "Save medicine";

  $("medicineForm").classList.remove("open");
  resetScanner();
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

// ============================================
// SAVE, EDIT AND DELETE MEDICINES
// ============================================

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
  const dosage = $("medicineDosage").value.trim();
  const quantity = Number($("medicineQuantity").value);
  const refillAt = Number($("medicineRefillAt").value);
  const verified = $("medicineDetailsVerified").checked;

  if (!name) {
    message("pageMessage", "Enter the medicine name.", "error");
    return;
  }

  if (!verified) {
    message(
      "pageMessage",
      "Before saving, verify the medicine name and strength against the packaging or prescription and tick the confirmation box.",
      "error"
    );
    $("medicineDetailsVerified").focus();
    return;
  }

  if (
    quantity < 0 ||
    refillAt < 0 ||
    !Number.isFinite(quantity) ||
    !Number.isFinite(refillAt)
  ) {
    message(
      "pageMessage",
      "Enter valid non-negative quantities.",
      "error"
    );
    return;
  }

  // Avoid saving the unreviewed OCR text as if it were a verified result.
  if (latestOcrResult && !verified) {
    message(
      "pageMessage",
      "Confirm the OCR results before saving.",
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
      dosage,
      barcode: $("medicineBarcode").value.trim(),
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

      await set(
        push(ref(db, dataPath("medicines"))),
        record
      );
    }

    await logActivity(
      id ? "Medicine updated" : "Medicine added",
      `${name}${dosage ? ` (${dosage})` : ""}`
    );

    resetMedicineForm();
    message("pageMessage", "Verified medicine details saved successfully.");
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
  const medicine = medicines[id];
  if (!medicine) return;

  const input = prompt(
    `How many units are being added to ${medicine.name}?`,
    "30"
  );

  if (input === null) return;

  const amount = Number(input);

  if (!Number.isInteger(amount) || amount <= 0) {
    alert("Enter a positive whole number.");
    return;
  }

  try {
    const newQuantity = Number(medicine.quantity || 0) + amount;

    await update(ref(db, dataPath(`medicines/${id}`)), {
      quantity: newQuantity,
      updatedAt: Date.now()
    });

    await logActivity(
      "Medicine refilled",
      `${medicine.name}: added ${amount} units. New stock: ${newQuantity}.`
    );
  } catch (error) {
    alert("Unable to record refill: " + error.message);
  }
}

async function deleteMedicine(id) {
  const medicine = medicines[id];

  if (!medicine || !confirm(`Delete ${medicine.name} and its reminders?`)) {
    return;
  }

  try {
    const changes = {};
    changes[dataPath(`medicines/${id}`)] = null;

    for (const [reminderId, reminder] of Object.entries(reminders)) {
      if (reminder.medicineId === id) {
        changes[dataPath(`reminders/${reminderId}`)] = null;
      }
    }

    await update(ref(db), changes);
    await logActivity("Medicine deleted", medicine.name);
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
  const medicine = medicines[id];

  if (!medicine) return;

  $("medicineEditId").value = id;
  $("medicineName").value = medicine.name || "";
  $("medicineDosage").value = medicine.dosage || "";
  $("medicineBarcode").value = medicine.barcode || "";
  $("medicineQuantity").value = medicine.quantity ?? 0;
  $("medicineRefillAt").value = medicine.refillAt ?? 5;
  $("medicineInstructions").value = medicine.instructions || "";
  $("medicineNotes").value = medicine.notes || "";

  // Editing existing records also requires explicit confirmation before updating.
  $("medicineDetailsVerified").checked = false;

  $("medicineFormTitle").textContent = "Edit medicine";
  $("saveMedicine").textContent = "Update medicine";
  $("medicineForm").classList.add("open");

  resetScanner();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

$("refillList").addEventListener("click", event => {
  const button = event.target.closest("[data-stock-med]");
  if (button) recordRefill(button.dataset.stockMed);
});

// ============================================
// RECURRING WEEKLY REMINDERS
// ============================================

$("toggleReminderForm").addEventListener("click", () => {
  if (!Object.keys(medicines).length) {
    $("reminderForm").classList.add("open");
    message(
      "reminderMessage",
      "Add a medicine before creating a reminder.",
      "error"
    );
    return;
  }

  $("reminderForm").classList.toggle("open");
});

$("recurrenceType").addEventListener("change", () => {
  const weekly = $("recurrenceType").value === "weekly";

  $("onceDateField").style.display = weekly ? "none" : "";
  $("weeklyDaysField").style.display = weekly ? "" : "none";
  $("reminderDate").required = !weekly;
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
    message("reminderMessage", "Choose a valid medicine.", "error");
    return;
  }

  if (!time) {
    message("reminderMessage", "Choose a reminder time.", "error");
    return;
  }

  if (recurrence === "once" && (!date || date < localDate())) {
    message("reminderMessage", "Choose today or a future date.", "error");
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
      await update(ref(db, dataPath(`reminders/${id}`)), record);
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

// ============================================
// NAVIGATION AND MODALS
// ============================================

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
    document.querySelectorAll(".overlay.open").forEach(overlay => {
      overlay.classList.remove("open");
    });
  }
});

$("refreshHistory").addEventListener("click", renderHistory);

// ============================================
// PATIENT CONNECTION CODE LOOKUP
// ============================================

$("connectionForm").addEventListener("submit", async event => {
  event.preventDefault();

  const code = $("connectionCode").value.trim();

  if (!code) {
    message("connectionMessage", "Enter a connection code.", "error");
    return;
  }

  try {
    const snapshot = await get(ref(db, `connectionCodes/${code}`));

    if (!snapshot.exists()) {
      message(
        "connectionMessage",
        "Code not found. Check the code and your Firebase connection-code setup.",
        "error"
      );
      return;
    }

    const record = snapshot.val();

    if (!record.patientUid || typeof record.patientUid !== "string") {
      message(
        "connectionMessage",
        "The code does not contain a valid patient reference.",
        "error"
      );
      return;
    }

    if (record.patientUid === user.uid) {
      message(
        "connectionMessage",
        "You cannot connect an account to itself.",
        "error"
      );
      return;
    }

    // Deliberately do not grant access or switch the active database path.
    // A valid connection needs a server/rules-backed authorization workflow.
    message(
      "connectionMessage",
      "The code exists. Patient access has not been granted by this lookup. Complete the secure connection workflow and Firebase rules before sharing records.",
      "error"
    );
  } catch (error) {
    message(
      "connectionMessage",
      `Connection lookup failed: ${error.message}. Check the database path and rules.`,
      "error"
    );
  }
});

// ============================================
// CHANGE PASSWORD
// ============================================

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
    message("passwordMessage", "New passwords do not match.", "error");
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
    const credential = EmailAuthProvider.credential(user.email, current);

    await reauthenticateWithCredential(user, credential);
    await updatePassword(user, next);

    $("passwordForm").reset();

    message("passwordMessage", "Password updated successfully.");

    await logActivity("Password changed", "Account password updated.");
  } catch (error) {
    const text = [
      "auth/invalid-credential",
      "auth/wrong-password",
      "auth/invalid-login-credentials"
    ].includes(error.code)
      ? "Your current password is incorrect."
      : error.message;

    message("passwordMessage", text, "error");
  }
});

// ============================================
// LOG OUT
// ============================================

$("logoutButton").addEventListener("click", async () => {
  if (!confirm("Are you sure you want to log out?")) return;

  try {
    stopSubscriptions();
    await signOut(auth);
    window.location.replace("login.html");
  } catch (error) {
    alert("Unable to log out: " + error.message);
  }
});

// ============================================
// FIREBASE AUTHENTICATION AND LIVE DATA
// ============================================

onAuthStateChanged(auth, authenticatedUser => {
  if (!authenticatedUser) {
    stopSubscriptions();
    window.location.replace("login.html");
    return;
  }

  stopSubscriptions();

  user = authenticatedUser;
  activePatientUid = null;

  $("displayName").textContent = user.displayName || "My account";
  $("avatar").textContent =
    (user.displayName || user.email || "A")[0].toUpperCase();

  $("welcomeTitle").textContent =
    `Welcome, ${(user.displayName || "there").split(" ")[0]}!`;

  $("profileEmail").textContent = user.email || "";

  // Existing authorized-dashboard structure: signed-in user's records.
  // Do not switch to another user's data until a secure connection is implemented.
  subscribe("medicines", value => {
    medicines = value;
    renderMedicines();
  });

  subscribe("reminders", value => {
    reminders = value;
    renderReminders();
  });

  const historyUnsubscribe = onValue(
    ref(db, accountPath("activity")),
    snapshot => {
      activities = snapshot.val() || {};
      renderHistory();
    },
    error => console.error("History subscription failed:", error)
  );

  unsubs.push(historyUnsubscribe);
});

window.addEventListener("beforeunload", () => {
  stopSubscriptions();

  const preview = $("medicinePhotoPreview");
  if (preview?.dataset.objectUrl) {
    URL.revokeObjectURL(preview.dataset.objectUrl);
  }
});