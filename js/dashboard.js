import { auth, db } from "./firebaseConfig.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { ref, get, set, push, remove, update, runTransaction } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const $ = (id) => document.getElementById(id);
const state = { user: null, medicines: {}, reminders: {}, history: {} };

function showMessage(message, type = "success") {
  const box = $("pageMessage");
  if (!box) return;
  box.textContent = message;
  box.className = `message show ${type}`;
  window.clearTimeout(showMessage.timer);
  showMessage.timer = window.setTimeout(() => { box.className = "message"; }, 5000);
}
function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
function userPath(path = "") { return `users/${state.user.uid}${path ? `/${path}` : ""}`; }
function asDateTime(date, time) {
  if (!date || !time) return NaN;
  return new Date(`${date}T${time}`).getTime();
}
function formatDateTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Date not set";
  return date.toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}
function getMedicineName(id) { return state.medicines[id]?.name || "Medicine removed"; }
function sortByTimestamp(items) { return items.sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0)); }

async function loadData() {
  const snapshot = await get(ref(db, userPath()));
  const data = snapshot.exists() ? snapshot.val() : {};
  state.medicines = data.medicines || {};
  state.reminders = data.reminders || {};
  state.history = data.history || {};
  renderAll();
}
function renderAll() { renderMedicines(); renderReminders(); renderHistory(); renderSummary(); }

function renderMedicines() {
  const list = $("medicineList");
  const entries = Object.entries(state.medicines);
  if (!entries.length) list.innerHTML = '<div class="empty">No medicines yet. Select “Add medicine” to get started.</div>';
  else list.innerHTML = entries.map(([id, medicine]) => {
    const remaining = Number(medicine.quantityRemaining ?? medicine.quantity ?? 0);
    const dosage = medicine.dosage ? ` · ${escapeHTML(medicine.dosage)}` : "";
    const frequency = medicine.frequency ? escapeHTML(medicine.frequency) : "Frequency not set";
    const notes = medicine.notes ? `<div class="item-sub">${escapeHTML(medicine.notes)}</div>` : "";
    const stockClass = remaining <= 5 ? "status overdue" : "status";
    return `<article class="list-item"><div><div class="item-title">${escapeHTML(medicine.name || "Unnamed medicine")}${dosage}</div><div class="item-sub">${frequency}</div><div class="item-sub"><span class="${stockClass}">${remaining} remaining</span></div>${notes}</div><div class="item-actions"><button class="small-btn" data-action="stock" data-id="${escapeHTML(id)}" type="button">＋ Stock</button><button class="small-btn danger" data-action="delete-medicine" data-id="${escapeHTML(id)}" type="button">Remove</button></div></article>`;
  }).join("");
  const dropdown = $("reminderMedicine");
  const selected = dropdown.value;
  dropdown.innerHTML = '<option value="">Select a medicine</option>' + entries.map(([id, medicine]) => `<option value="${escapeHTML(id)}">${escapeHTML(medicine.name || "Unnamed medicine")}</option>`).join("");
  if (state.medicines[selected]) dropdown.value = selected;
}

function renderReminders() {
  const list = $("reminderList");
  const now = Date.now();
  const entries = Object.entries(state.reminders).map(([id, reminder]) => ({ id, ...reminder, timestamp: Number(reminder.timestamp) || asDateTime(reminder.date, reminder.time) }));
  entries.sort((a, b) => a.timestamp - b.timestamp);
  const pending = entries.filter((item) => item.status !== "taken" && item.status !== "completed");
  if (!entries.length) list.innerHTML = '<div class="empty">No reminders yet. Add one to help keep your schedule on track.</div>';
  else list.innerHTML = entries.map((reminder) => {
    const done = reminder.status === "taken" || reminder.status === "completed";
    const overdue = !done && reminder.timestamp < now;
    const status = done ? '<span class="status">Completed</span>' : overdue ? '<span class="status overdue">Overdue</span>' : '<span class="status">Scheduled</span>';
    const notes = reminder.notes ? `<div class="item-sub">${escapeHTML(reminder.notes)}</div>` : "";
    return `<article class="list-item"><div><div class="item-title">${escapeHTML(getMedicineName(reminder.medicineId || reminder.medicine))}</div><div class="item-sub">${formatDateTime(reminder.timestamp)}</div>${notes}<div style="margin-top:8px">${status}</div></div><div class="item-actions">${done ? "" : `<button class="small-btn" data-action="taken" data-id="${escapeHTML(reminder.id)}" type="button">Mark taken</button>`}<button class="small-btn danger" data-action="delete-reminder" data-id="${escapeHTML(reminder.id)}" type="button">Remove</button></div></article>`;
  }).join("");
  $("reminderCount").textContent = String(pending.length);
}

function renderHistory() {
  const list = $("historyList");
  const entries = Object.entries(state.history).map(([id, item]) => ({ id, ...item }));
  entries.sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));
  if (!entries.length) { list.innerHTML = '<div class="empty">Your medicine activity will appear here.</div>'; return; }
  list.innerHTML = entries.slice(0, 8).map((item) => `<article class="list-item"><div><div class="item-title">${escapeHTML(item.title || item.action || "Activity recorded")}</div><div class="item-sub">${escapeHTML(item.details || item.medicineName || "")}</div><div class="item-sub">${formatDateTime(Number(item.timestamp) || Date.parse(item.createdAt || ""))}</div></div></article>`).join("");
}

function renderSummary() {
  $("medicineCount").textContent = String(Object.keys(state.medicines).length);
  const now = Date.now();
  const pending = Object.values(state.reminders).map((item) => ({ ...item, timestamp: Number(item.timestamp) || asDateTime(item.date, item.time) })).filter((item) => item.status !== "taken" && item.status !== "completed" && item.timestamp >= now).sort((a, b) => a.timestamp - b.timestamp);
  if (!pending.length) { $("nextReminder").textContent = "—"; $("nextReminderDetail").textContent = "No upcoming reminder"; return; }
  const next = pending[0];
  $("nextReminder").textContent = new Date(next.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  $("nextReminderDetail").textContent = `${getMedicineName(next.medicineId || next.medicine)} · ${new Date(next.timestamp).toLocaleDateString([], { month: "short", day: "numeric" })}`;
}

async function writeHistory(title, details) {
  const historyRef = push(ref(db, userPath("history")));
  await set(historyRef, { title, details, timestamp: Date.now() });
}

$("addMedicineForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("saveMedicineButton");
  button.disabled = true;
  try {
    const name = $("medicineName").value.trim();
    const quantity = Math.max(0, Math.floor(Number($("medicineQuantity").value) || 0));
    if (!name) throw new Error("Please enter a medicine name.");
    const newRef = push(ref(db, userPath("medicines")));
    await set(newRef, { name, dosage: $("medicineDosage").value.trim(), frequency: $("medicineFrequency").value, notes: $("medicineNotes").value.trim(), initialQuantity: quantity, quantityRemaining: quantity, dosesTaken: 0, createdAt: Date.now() });
    await writeHistory("Medicine added", name);
    event.target.reset(); $("medicineQuantity").value = "0"; event.target.classList.add("hidden");
    await loadData(); showMessage("Medicine saved successfully.");
  } catch (error) { showMessage(error.message || "Could not save the medicine.", "error"); }
  finally { button.disabled = false; }
});

$("addReminderForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("saveReminderButton"); button.disabled = true;
  try {
    const medicineId = $("reminderMedicine").value;
    const date = $("reminderStartDate").value;
    const time = $("reminderTime").value;
    if (!medicineId || !state.medicines[medicineId]) throw new Error("Please select a saved medicine.");
    if (!date || !time) throw new Error("Please select a date and time.");
    const timestamp = asDateTime(date, time);
    if (!Number.isFinite(timestamp)) throw new Error("Please enter a valid date and time.");
    const newRef = push(ref(db, userPath("reminders")));
    await set(newRef, { medicineId, date, time, timestamp, notes: $("reminderNotes").value.trim(), status: "scheduled", createdAt: Date.now() });
    await writeHistory("Reminder created", `${state.medicines[medicineId].name} · ${formatDateTime(timestamp)}`);
    event.target.reset(); event.target.classList.add("hidden");
    await loadData(); showMessage("Reminder saved successfully.");
  } catch (error) { showMessage(error.message || "Could not save the reminder.", "error"); }
  finally { button.disabled = false; }
});

$("medicineList").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]"); if (!button) return;
  const { action, id } = button.dataset; const medicine = state.medicines[id]; if (!medicine) return;
  try {
    if (action === "delete-medicine") {
      if (!confirm(`Remove ${medicine.name || "this medicine"}? Related reminders will remain until removed separately.`)) return;
      await remove(ref(db, userPath(`medicines/${id}`)));
      await writeHistory("Medicine removed", medicine.name || "Medicine");
      await loadData(); showMessage("Medicine removed.");
    } else if (action === "stock") {
      const amountText = prompt("How many units would you like to add?", "1"); if (amountText === null) return;
      const amount = Number(amountText);
      if (!Number.isInteger(amount) || amount < 1) throw new Error("Enter a whole number greater than zero.");
      await runTransaction(ref(db, userPath(`medicines/${id}/quantityRemaining`)), (current) => Math.max(0, Number(current) || 0) + amount);
      await writeHistory("Stock updated", `${medicine.name}: +${amount}`);
      await loadData(); showMessage("Medicine stock updated.");
    }
  } catch (error) { showMessage(error.message || "Could not update this medicine.", "error"); }
});

$("reminderList").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]"); if (!button) return;
  const { action, id } = button.dataset; const reminder = state.reminders[id]; if (!reminder) return;
  try {
    if (action === "delete-reminder") {
      if (!confirm("Remove this reminder?")) return;
      await remove(ref(db, userPath(`reminders/${id}`)));
      await writeHistory("Reminder removed", getMedicineName(reminder.medicineId || reminder.medicine));
      await loadData(); showMessage("Reminder removed.");
    } else if (action === "taken") {
      await update(ref(db, userPath(`reminders/${id}`)), { status: "taken", completedAt: Date.now() });
      const medicineId = reminder.medicineId || reminder.medicine;
      if (medicineId && state.medicines[medicineId]) {
        await runTransaction(ref(db, userPath(`medicines/${medicineId}`)), (current) => {
          if (!current) return current;
          const remaining = Math.max(0, Number(current.quantityRemaining ?? current.quantity ?? 0) - 1);
          return { ...current, quantityRemaining: remaining, dosesTaken: (Number(current.dosesTaken) || 0) + 1 };
        });
      }
      await writeHistory("Dose marked as taken", getMedicineName(medicineId));
      await loadData(); showMessage("Dose marked as taken.");
    }
  } catch (error) { showMessage(error.message || "Could not update this reminder.", "error"); }
});

$("toggleMedicineForm").addEventListener("click", () => $("addMedicineForm").classList.toggle("hidden"));
$("cancelMedicineForm").addEventListener("click", () => { $("addMedicineForm").reset(); $("medicineQuantity").value = "0"; $("addMedicineForm").classList.add("hidden"); });
$("toggleReminderForm").addEventListener("click", () => {
  if (!Object.keys(state.medicines).length) { showMessage("Add a medicine before creating a reminder.", "error"); $("addMedicineForm").classList.remove("hidden"); return; }
  $("addReminderForm").classList.toggle("hidden");
  if (!$("reminderStartDate").value) $("reminderStartDate").value = new Date().toLocaleDateString("en-CA");
});
$("quickAddReminder").addEventListener("click", () => $("toggleReminderForm").click());
$("cancelReminderForm").addEventListener("click", () => { $("addReminderForm").reset(); $("addReminderForm").classList.add("hidden"); });
$("logoutButton").addEventListener("click", async () => {
  try { await signOut(auth); window.location.replace("login.html"); }
  catch (error) { showMessage(error.message || "Could not log out.", "error"); }
});

onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.replace("login.html"); return; }
  state.user = user;
  $("userLabel").textContent = user.displayName || user.email || "My account";
  $("welcomeTitle").textContent = `Welcome${user.displayName ? `, ${user.displayName.split(" ")[0]}` : " to Medminder"}`;
  $("todayLabel").textContent = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }).toUpperCase();
  try { await loadData(); }
  catch (error) {
    console.error("Medminder dashboard load failed:", error);
    $("medicineList").innerHTML = '<div class="empty">Unable to load medicines. Check your Firebase connection and database rules.</div>';
    $("reminderList").innerHTML = '<div class="empty">Unable to load reminders. Check your Firebase connection and database rules.</div>';
    $("historyList").innerHTML = '<div class="empty">Unable to load activity.</div>';
    showMessage("Dashboard data could not be loaded. Confirm that firebaseConfig.js is correct and that your database rules allow this signed-in user to read users/{uid}.", "error");
  }
});
