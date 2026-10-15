
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
  update,
  remove,
  runTransaction
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

function userPath(section) {
  return `users/${currentUser.uid}/${section}`;
}

function normalizeRole(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function formatDate(dateString) {
  if (!dateString) return "No date selected";
  const parts = String(dateString).split("-").map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return String(dateString);

  return new Date(parts[0], parts[1] - 1, parts[2]).toLocaleDateString("en-PH", {
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

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function showEmpty(containerId, message) {
  $(containerId).replaceChildren(makeElement("div", "empty-state", message));
}

/* Add the quantity input to the existing medicine form. */
function setupQuantityInput() {
  const grid = document.querySelector("#addMedicineForm .form-grid");
  if (!grid || $("medicineQuantity")) return;

  const field = makeElement("div", "field");
  const label = makeElement("label", "", "Initial quantity *");
  label.htmlFor = "medicineQuantity";

  const input = document.createElement("input");
  input.id = "medicineQuantity";
  input.name = "medicineQuantity";
  input.type = "number";
  input.min = "1";
  input.max = "100000";
  input.step = "1";
  input.required = true;
  input.placeholder = "e.g. 30 tablets";
  input.inputMode = "numeric";

  const help = makeElement("div", "muted small", "Enter the number of tablets, capsules, or doses you have.");

  field.append(label, input, help);
  grid.appendChild(field);
}

/* Add a separate intake summary to the dashboard. */
function setupIntakeSummary() {
  if ($("intakeSummary")) return;

  const stats = document.querySelector(".stats");
  if (!stats) return;

  const panel = makeElement("section", "panel");
  panel.id = "intakeSummary";
  panel.style.marginTop = "0";
  panel.innerHTML = `
    <div class="panel-heading">
      <div>
        <h2>Medicine intake tracker</h2>
        <p class="muted small">Record each dose taken and track your remaining quantity.</p>
      </div>
      <span aria-hidden="true" style="font-size:28px">💊</span>
    </div>
    <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px">
      <div style="background:#f2f7f3;padding:15px;border-radius:12px">
        <div class="muted small">Total added</div>
        <div id="totalQuantity" style="font-size:24px;font-weight:800;color:#175638">0</div>
      </div>
      <div style="background:#f2f7f3;padding:15px;border-radius:12px">
        <div class="muted small">Intakes recorded</div>
        <div id="totalTaken" style="font-size:24px;font-weight:800;color:#175638">0</div>
      </div>
      <div style="background:#f2f7f3;padding:15px;border-radius:12px">
        <div class="muted small">Remaining</div>
        <div id="totalRemaining" style="font-size:24px;font-weight:800;color:#175638">0</div>
      </div>
    </div>
    <p class="muted small" style="margin-bottom:0">
      Counts are based on your saved quantities and the doses you record in Medminder.
    </p>
  `;

  stats.insertAdjacentElement("afterend", panel);

  const responsiveStyle = document.createElement("style");
  responsiveStyle.textContent = `
    @media(max-width:420px) {
      #intakeSummary > div:nth-child(2) { gap:6px !important; }
      #intakeSummary > div:nth-child(2) > div { padding:10px !important; }
      #intakeSummary > div:nth-child(2) .muted { font-size:11px; }
      #intakeSummary > div:nth-child(2) div[style*="font-size:24px"] { font-size:20px !important; }
    }
  `;
  document.head.appendChild(responsiveStyle);
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

  const [medicineSnapshot, reminderSnapshot, historySnapshot] = await Promise.all([
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
  renderIntakeSummary();
}

function getQuantity(medicine) {
  return Math.max(0, Number(medicine.quantityRemaining ?? 0) || 0);
}

function getInitialQuantity(medicine) {
  return Math.max(0, Number(medicine.initialQuantity ?? 0) || 0);
}

function getTakenCount(medicine) {
  return Math.max(0, Number(medicine.dosesTaken ?? 0) || 0);
}

function renderIntakeSummary() {
  let totalQuantity = 0;
  let totalTaken = 0;
  let totalRemaining = 0;

  Object.values(medicines || {}).forEach(medicine => {
    totalQuantity += getInitialQuantity(medicine);
    totalTaken += getTakenCount(medicine);
    totalRemaining += getQuantity(medicine);
  });

  if ($("totalQuantity")) $("totalQuantity").textContent = totalQuantity;
  if ($("totalTaken")) $("totalTaken").textContent = totalTaken;
  if ($("totalRemaining")) $("totalRemaining").textContent = totalRemaining;
}

function renderSummary() {
  const medicineEntries = Object.entries(medicines || {});
  const reminderEntries = Object.entries(reminders || {});

  $("medicineCount").textContent = medicineEntries.length;
  $("reminderCount").textContent = reminderEntries.length;

  const now = new Date();
  const today = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ].join("-");
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  const upcoming = reminderEntries
    .map(([id, reminder]) => ({ id, ...reminder }))
    .filter(reminder => reminder.startDate && reminder.time)
    .filter(reminder =>
      reminder.startDate > today ||
      (reminder.startDate === today && reminder.time >= currentTime)
    )
    .sort((a, b) =>
      `${a.startDate}T${a.time}`.localeCompare(`${b.startDate}T${b.time}`)
    );

  if (!upcoming.length) {
    $("nextReminder").textContent = "None yet";
    $("nextReminderDetail").textContent = "No upcoming reminders";
    return;
  }

  $("nextReminder").textContent = formatTime(upcoming[0].time);
  $("nextReminderDetail").textContent =
    `${upcoming[0].medicineName || "Medicine"} · ${formatDate(upcoming[0].startDate)}`;
}

function renderMedicines() {
  const container = $("medicineList");
  container.replaceChildren();

  const entries = Object.entries(medicines || {}).sort((a, b) =>
    String(a[1].name || "").localeCompare(String(b[1].name || ""))
  );

  if (!entries.length) {
    showEmpty("medicineList", "No medicines added yet. Select “Add medicine” to get started.");
  }

  for (const [id, medicine] of entries) {
    const record = makeElement("article", "record");
    const main = makeElement("div", "record-main");
    const title = makeElement("div", "record-title", medicine.name || "Unnamed medicine");

    const initial = getInitialQuantity(medicine);
    const remaining = getQuantity(medicine);
    const taken = getTakenCount(medicine);

    const quantityText = initial > 0
      ? `Initial quantity: ${initial}\nIntakes recorded: ${taken}\nRemaining: ${remaining}`
      : "Quantity not set yet. Set your starting quantity to track intake.";

    const detailLines = [
      medicine.dosage ? `Dosage: ${medicine.dosage}` : "",
      medicine.frequency ? `Instructions: ${medicine.frequency}` : "",
      quantityText,
      medicine.notes ? `Notes: ${medicine.notes}` : ""
    ].filter(Boolean);

    const detail = makeElement("div", "record-detail", detailLines.join("\n"));
    const actions = makeElement("div", "record-actions");

    if (initial > 0 && remaining > 0) {
      const takenButton = makeElement("button", "btn btn-primary btn-small", "✓ Mark as taken");
      takenButton.type = "button";

      takenButton.addEventListener("click", async () => {
        if (!confirm(`Record one intake of ${medicine.name || "this medicine"}? This will subtract 1 from the remaining quantity.`)) {
          return;
        }

        takenButton.disabled = true;

        try {
          const medicineRef = ref(db, `${userPath("medicines")}/${id}`);
          const result = await runTransaction(medicineRef, current => {
            if (!current) return;
            const currentRemaining = Math.max(0, Number(current.quantityRemaining ?? 0) || 0);

            if (currentRemaining < 1) return;

            current.quantityRemaining = currentRemaining - 1;
            current.dosesTaken = Math.max(0, Number(current.dosesTaken ?? 0) || 0) + 1;
            current.lastTakenAt = Date.now();

            return current;
          });

          if (!result.committed) {
            showPageMessage("No remaining quantity was available to deduct.");
          } else {
            await saveHistory(
              "Medicine intake recorded",
              `${medicine.name || "Medicine"} · 1 unit recorded · ${formatTime(new Date().toTimeString().slice(0, 5))}`
            );

            await refreshData();
            showPageMessage(
              `Intake recorded for ${medicine.name}. Remaining quantity: ${getQuantity(result.snapshot.val())}.`,
              "success"
            );
          }
        } catch (error) {
          console.error("Could not record medicine intake:", error);
          showPageMessage("Could not record this intake. Please check your connection and try again.");
        } finally {
          takenButton.disabled = false;
        }
      });

      actions.appendChild(takenButton);
    }

    const stockButton = makeElement(
      "button",
      "btn btn-secondary btn-small",
      initial > 0 ? "＋ Add stock" : "Set quantity"
    );
    stockButton.type = "button";

    stockButton.addEventListener("click", async () => {
      const input = prompt(
        initial > 0
          ? `How many additional units of ${medicine.name} are you adding?`
          : `What is the starting quantity for ${medicine.name}?`,
        "30"
      );

      if (input === null) return;

      const amount = Number(input);
      if (!Number.isInteger(amount) || amount < 1 || amount > 100000) {
        showPageMessage("Enter a whole number between 1 and 100,000.");
        return;
      }

      stockButton.disabled = true;

      try {
        const medicineRef = ref(db, `${userPath("medicines")}/${id}`);

        const result = await runTransaction(medicineRef, current => {
          if (!current) return;

          const oldInitial = Math.max(0, Number(current.initialQuantity ?? 0) || 0);
          const oldRemaining = Math.max(0, Number(current.quantityRemaining ?? 0) || 0);

          current.initialQuantity = oldInitial + amount;
          current.quantityRemaining = oldRemaining + amount;
          current.stockUpdatedAt = Date.now();

          return current;
        });

        if (!result.committed) {
          showPageMessage("Could not update the medicine quantity.");
          return;
        }

        await saveHistory(
          "Medicine stock added",
          `${medicine.name || "Medicine"} · ${amount} units added`
        );

        await refreshData();
        showPageMessage(`Added ${amount} units to ${medicine.name}.`, "success");
      } catch (error) {
        console.error("Stock update error:", error);
        showPageMessage("Could not update the quantity. Please try again.");
      } finally {
        stockButton.disabled = false;
      }
    });

    const removeButton = makeElement("button", "btn btn-danger btn-small", "Remove");
    removeButton.type = "button";

    removeButton.addEventListener("click", async () => {
      if (!confirm(`Remove ${medicine.name || "this medicine"}? Its associated reminders will not be deleted automatically.`)) {
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

    actions.append(stockButton, removeButton);
    main.append(title, detail);
    record.append(main, actions);
    container.appendChild(record);
  }

  // Refresh the reminder medicine dropdown while retaining a valid selection.
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

  const entries = Object.entries(reminders || {}).sort((a, b) =>
    `${a[1].startDate || ""}T${a[1].time || ""}`.localeCompare(
      `${b[1].startDate || ""}T${b[1].time || ""}`
    )
  );

  if (!entries.length) {
    showEmpty("reminderList", "No reminders yet. Open “New reminder” to choose a date and time.");
  }

  for (const [id, reminder] of entries) {
    const record = makeElement("article", "record");
    const main = makeElement("div", "record-main");
    const title = makeElement("div", "record-title", reminder.medicineName || "Medication reminder");

    const lines = [
      `📅 ${formatDate(reminder.startDate)}`,
      `🕒 ${formatTime(reminder.time)}`
    ];
    if (reminder.notes) lines.push(`Notes: ${reminder.notes}`);

    const detail = makeElement("div", "record-detail", lines.join("\n"));
    const actions = makeElement("div", "record-actions");
    const deleteButton = makeElement("button", "btn btn-danger btn-small", "Remove reminder");
    deleteButton.type = "button";

    deleteButton.addEventListener("click", async () => {
      if (!confirm(`Remove the reminder for ${reminder.medicineName || "this medicine"}?`)) return;

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

  const entries = Object.entries(historyRecords || {}).sort(
    (a, b) => Number(b[1].createdAt || 0) - Number(a[1].createdAt || 0)
  );

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

    setupQuantityInput();
    setupIntakeSummary();

    await refreshData();
  } catch (error) {
    console.error("Dashboard loading error:", error);
    $("loading").textContent =
      "Unable to load your dashboard. Check your Firebase database rules and connection, then reload the page.";
  }
}

$("addMedicineForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!currentUser || isSavingMedicine) return;

  const name = $("medicineName").value.trim();
  const dosage = $("medicineDosage").value.trim();
  const frequency = $("medicineFrequency").value.trim();
  const notes = $("medicineNotes").value.trim();
  const quantity = Number($("medicineQuantity")?.value);

  if (!name) {
    showPageMessage("Please enter a medicine name.");
    return;
  }

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) {
    showPageMessage("Please enter a valid initial quantity.");
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
      initialQuantity: quantity,
      quantityRemaining: quantity,
      dosesTaken: 0,
      createdAt: Date.now()
    });

    await saveHistory("Medicine added", `${name} · Initial quantity: ${quantity}`);

    $("addMedicineForm").reset();
    $("medicineForm").classList.remove("open");

    await refreshData();
    showPageMessage(`${name} saved with ${quantity} units available.`, "success");
  } catch (error) {
    console.error("Medicine save error:", error);
    showPageMessage("Could not save the medicine. Check your Firebase database rules and try again.");
  } finally {
    isSavingMedicine = false;
    $("saveMedicineButton").disabled = false;
  }
});

$("addReminderForm").addEventListener("submit", async event => {
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

  const parts = startDate.split("-").map(Number);
  const selectedDate = new Date(parts[0], parts[1] - 1, parts[2]);
  selectedDate.setHours(0, 0, 0, 0);

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (selectedDate < today) {
    showMessage("reminderFormMessage", "Please select today or a future date.");
    return;
  }

  const todayString = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ].join("-");

  if (startDate === todayString) {
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
    showMessage("reminderFormMessage", "Could not save the reminder. Check your Firebase database rules and try again.");
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

onAuthStateChanged(auth, async user => {
  if (!user) {
    window.location.replace("login.html");
    return;
  }

  await loadUserData(user);
});
