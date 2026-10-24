
import { auth, db } from "./firebaseConfig.js";

import {
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
  ref,
  get,
  onValue
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const $ = (id) => document.getElementById(id);

let unsubscribe = [];
let redirecting = false;
let currentUser = null;

function showError(message) {
  const box = $("error");

  if (!box) return;

  box.textContent = message;
  box.style.display = "block";
}

function hideError() {
  const box = $("error");

  if (!box) return;

  box.textContent = "";
  box.style.display = "none";
}

function hideLoading() {
  const loading = $("loading");

  if (loading) {
    loading.style.display = "none";
  }
}

function stopListeners() {
  unsubscribe.forEach((stop) => {
    try {
      stop();
    } catch (error) {
      console.warn("Unable to stop Firebase listener:", error);
    }
  });

  unsubscribe = [];
}

function card(title, detail, status = "") {
  const article = document.createElement("article");
  article.className = "item";

  const heading = document.createElement("h3");
  heading.textContent = title || "Medication";

  const paragraph = document.createElement("p");
  paragraph.textContent = detail || "No additional details.";

  article.append(heading, paragraph);

  if (status) {
    const badge = document.createElement("span");
    badge.className = "status";
    badge.textContent = status;
    article.append(badge);
  }

  return article;
}

function empty(container, message) {
  if (!container) return;

  container.replaceChildren();

  const element = document.createElement("div");
  element.className = "empty";
  element.textContent = message;

  container.append(element);
}

function nameFromUser(data, user) {
  const profile = data?.profile || {};

  const name = [
    profile.firstName || profile.first_name,
    profile.lastName || profile.last_name
  ].filter(Boolean).join(" ");

  return (
    name ||
    profile.displayName ||
    user.displayName ||
    user.email?.split("@")[0] ||
    "there"
  );
}

function dateLabel(value) {
  if (!value) return "Date not set";

  const date = new Date(`${value}T00:00:00`);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleDateString("en-PH", {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

function timeLabel(value) {
  if (!value) return "Time not set";

  const parts = String(value).split(":");

  if (parts.length < 2) {
    return String(value);
  }

  const date = new Date();

  date.setHours(
    Number(parts[0]),
    Number(parts[1]),
    0,
    0
  );

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleTimeString("en-PH", {
    hour: "numeric",
    minute: "2-digit"
  });
}

function reminderTimestamp(reminder) {
  if (!reminder?.startDate || !reminder?.time) {
    return null;
  }

  const date = new Date(
    `${reminder.startDate}T${reminder.time}:00`
  );

  return Number.isNaN(date.getTime())
    ? null
    : date.getTime();
}

function reminderStatus(reminder) {
  if (reminder.takenAt || reminder.completed) {
    return "Intake recorded";
  }

  const timestamp = reminderTimestamp(reminder);

  if (timestamp !== null && timestamp < Date.now()) {
    return "Past due";
  }

  return "Upcoming";
}

/*
 * PATIENT QR CODE
 *
 * The QR code contains the patient's Firebase Authentication UID.
 * It identifies the patient, but it does not by itself grant access
 * or connect accounts.
 */
function renderQRCode(uid) {
  const qrContainer = $("todayPatientQr");
  const codeContainer = $("todayPatientCode");

  if (codeContainer) {
    codeContainer.textContent = uid || "Patient ID unavailable.";
  }

  if (!qrContainer) return;

  qrContainer.replaceChildren();

  if (!uid) {
    qrContainer.textContent = "Patient ID unavailable.";
    return;
  }

  if (typeof window.QRCode !== "function") {
    qrContainer.textContent =
      "QR code unavailable. Please check your internet connection.";
    return;
  }

  try {
    new window.QRCode(qrContainer, {
      text: uid,
      width: 160,
      height: 160,
      colorDark: "#10442b",
      colorLight: "#ffffff",
      correctLevel: window.QRCode.CorrectLevel.M
    });
  } catch (error) {
    console.error("QR generation error:", error);
    qrContainer.textContent = "Unable to generate QR code.";
  }
}

/*
 * COPY PATIENT CONNECTION CODE
 */
async function copyTodayPatientCode() {
  const message = $("copyCodeMessage");
  const uid = currentUser?.uid;

  if (message) {
    message.textContent = "";
  }

  if (!uid) {
    showError("Your Patient ID is not available yet.");
    return;
  }

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(uid);
    } else {
      const temporaryInput = document.createElement("textarea");

      temporaryInput.value = uid;
      temporaryInput.setAttribute("readonly", "");
      temporaryInput.style.position = "fixed";
      temporaryInput.style.left = "-9999px";

      document.body.appendChild(temporaryInput);
      temporaryInput.select();

      const copied = document.execCommand("copy");
      temporaryInput.remove();

      if (!copied) {
        throw new Error("The browser could not copy the code.");
      }
    }

    if (message) {
      message.textContent = "✓ Patient connection code copied!";
    }
  } catch (error) {
    console.error("Copy connection code error:", error);

    if (message) {
      message.textContent =
        "Copy failed. Please select and copy the code manually.";
    }
  }
}

/*
 * MEDICINES
 */
function renderMedicines(medicines) {
  const container = $("medicineList");

  if (!container) return;

  container.replaceChildren();

  const entries = Object.entries(medicines || {}).sort(
    (a, b) =>
      String(a[1]?.name || "").localeCompare(
        String(b[1]?.name || "")
      )
  );

  if (!entries.length) {
    empty(
      container,
      "No medicines have been shared with you yet."
    );
    return;
  }

  for (const [, medicine] of entries) {
    const details = [
      medicine.dosage
        ? `Dosage: ${medicine.dosage}`
        : "",

      medicine.frequency
        ? `Instructions: ${medicine.frequency}`
        : "",

      medicine.notes
        ? `Notes: ${medicine.notes}`
        : "",

      medicine.quantityRemaining !== undefined &&
      medicine.quantityRemaining !== null &&
      medicine.quantityRemaining !== ""
        ? `Remaining quantity: ${medicine.quantityRemaining}`
        : ""
    ].filter(Boolean).join("\n");

    container.append(
      card(
        medicine.name || "Unnamed medicine",
        details,
        "In your medication plan"
      )
    );
  }
}

/*
 * REMINDERS
 */
function renderReminders(reminders, medicines) {
  const container = $("reminderList");

  if (!container) return;

  container.replaceChildren();

  const entries = Object.entries(reminders || {}).sort(
    (a, b) =>
      `${a[1]?.startDate || ""}T${a[1]?.time || ""}`.localeCompare(
        `${b[1]?.startDate || ""}T${b[1]?.time || ""}`
      )
  );

  if (!entries.length) {
    empty(
      container,
      "No reminders have been shared with you yet."
    );
    return;
  }

  for (const [, reminder] of entries) {
    const medicine = medicines?.[reminder.medicineId] || {};

    const title =
      reminder.medicineName ||
      medicine.name ||
      "Medication reminder";

    const details = [
      `Date: ${dateLabel(reminder.startDate)}`,
      `Time: ${timeLabel(reminder.time)}`,
      reminder.dose ? `Dose: ${reminder.dose}` : "",
      reminder.notes ? `Notes: ${reminder.notes}` : ""
    ].filter(Boolean).join("\n");

    container.append(
      card(title, details, reminderStatus(reminder))
    );
  }
}

/*
 * MEDICATION HISTORY
 */
function renderHistory(history) {
  const container = $("historyList");

  if (!container) return;

  container.replaceChildren();

  const entries = Object.entries(history || {}).sort(
    (a, b) =>
      Number(b[1]?.createdAt || 0) -
      Number(a[1]?.createdAt || 0)
  );

  if (!entries.length) {
    empty(
      container,
      "No medication activity has been recorded yet."
    );
    return;
  }

  for (const [, item] of entries) {
    const timestamp = item.createdAt
      ? new Date(Number(item.createdAt)).toLocaleString()
      : "Time not recorded";

    const details = [
      item.detail || "",
      timestamp
    ].filter(Boolean).join("\n");

    container.append(
      card(
        item.action || "Medication activity",
        details
      )
    );
  }
}

/*
 * LOAD THE PATIENT DASHBOARD
 */
async function startPatientDashboard(user) {
  stopListeners();
  hideError();

  currentUser = user;

  try {
    /*
     * Load the patient's own account record.
     */
    const ownSnapshot = await get(
      ref(db, `users/${user.uid}`)
    );

    const ownData = ownSnapshot.exists()
      ? ownSnapshot.val()
      : {};

    /*
     * Display QR and code even before the patient connects
     * to an authorized person.
     */
    renderQRCode(user.uid);

    const role = String(
      ownData.role ||
      ownData.accountRole ||
      ownData.profile?.role ||
      ""
    ).toLowerCase();

    if (
      role &&
      !role.includes("patient") &&
      !role.includes("medicine_taker") &&
      !role.includes("medicine taker")
    ) {
      hideLoading();
      showError(
        "This account is not set up as a patient/medicine-taker account. Please sign in using your patient account."
      );
      return;
    }

    const authorizedUid =
      ownData.authorizedPersonUid ||
      ownData.connectedAuthorizedUid ||
      ownData.careConnection?.authorizedUid ||
      ownData.connection?.authorizedUid;

    $("welcomeTitle").textContent =
      `Hello, ${nameFromUser(ownData, user)}!`;

    $("app").style.display = "block";
    hideLoading();

    /*
     * If not connected yet, the patient can still share
     * their QR code and connection code with the caregiver.
     */
    if (!authorizedUid) {
      $("accountRole").textContent =
        "Patient account · Not connected yet";

      empty(
        $("medicineList"),
        "Medicines will appear here after your account is connected."
      );

      empty(
        $("reminderList"),
        "Reminders will appear here after your account is connected."
      );

      empty(
        $("historyList"),
        "Medication activity will appear here after your account is connected."
      );

      return;
    }

    $("accountRole").textContent =
      "Your shared medication plan";

    /*
     * Read the connected authorized person's data.
     *
     * IMPORTANT:
     * Firebase Database Rules must explicitly authorize this
     * access. The connection value alone is not sufficient.
     */
    const authorizedRoot = `users/${authorizedUid}`;

    const medicineRef = ref(
      db,
      `${authorizedRoot}/medicines`
    );

    const reminderRef = ref(
      db,
      `${authorizedRoot}/reminders`
    );

    const historyRef = ref(
      db,
      `${authorizedRoot}/history`
    );

    let medicines = {};
    let reminders = {};
    let history = {};

    function updateView() {
      $("medicineCount").textContent =
        Object.keys(medicines).length;

      $("reminderCount").textContent =
        Object.keys(reminders).length;

      renderMedicines(medicines);
      renderReminders(reminders, medicines);
      renderHistory(history);
    }

    unsubscribe.push(
      onValue(
        medicineRef,
        (snapshot) => {
          medicines = snapshot.exists()
            ? snapshot.val() || {}
            : {};

          updateView();
        },
        (error) => {
          console.error("Medicine listener error:", error);

          showError(
            `Cannot load shared medicines (${error.code || "error"}). Check your Firebase Database Rules and patient connection.`
          );
        }
      )
    );

    unsubscribe.push(
      onValue(
        reminderRef,
        (snapshot) => {
          reminders = snapshot.exists()
            ? snapshot.val() || {}
            : {};

          updateView();
        },
        (error) => {
          console.error("Reminder listener error:", error);

          showError(
            `Cannot load shared reminders (${error.code || "error"}). Check your Firebase Database Rules and patient connection.`
          );
        }
      )
    );

    unsubscribe.push(
      onValue(
        historyRef,
        (snapshot) => {
          history = snapshot.exists()
            ? snapshot.val() || {}
            : {};

          updateView();
        },
        (error) => {
          console.error("History listener error:", error);

          showError(
            `Cannot load shared history (${error.code || "error"}). Check your Firebase Database Rules and patient connection.`
          );
        }
      )
    );

  } catch (error) {
    console.error("Patient dashboard loading error:", error);

    hideLoading();

    const details = error?.code
      ? `${error.code}: ${error.message || "Unknown Firebase error"}`
      : (error?.message || "Unknown error");

    showError(
      `Dashboard loading failed: ${details}`
    );
  }
}

/*
 * COPY BUTTON
 */
$("copyTodayPatientCode")?.addEventListener(
  "click",
  copyTodayPatientCode
);

/*
 * LOG OUT
 */
$("logoutButton")?.addEventListener("click", async () => {
  try {
    stopListeners();

    await signOut(auth);

    window.location.replace("login.html");
  } catch (error) {
    console.error("Logout error:", error);

    showError(
      `Unable to log out: ${error.message || "Please try again."}`
    );
  }
});

/*
 * AUTHENTICATION CHECK
 */
onAuthStateChanged(auth, (user) => {
  if (redirecting) return;

  if (!user) {
    redirecting = true;
    stopListeners();
    window.location.replace("login.html");
    return;
  }

  startPatientDashboard(user);
});

/*
 * Clean up Firebase listeners when leaving the page.
 */
window.addEventListener("beforeunload", stopListeners);
