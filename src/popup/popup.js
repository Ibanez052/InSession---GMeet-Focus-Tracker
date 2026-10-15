import { GoogleAuthProvider, onAuthStateChanged, signInWithCredential, signOut } from "firebase/auth/web-extension";
import { collection, doc, onSnapshot, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
import { auth, db } from "../shared/firebase.js";

const byId = (id) => document.getElementById(id);
const studentTableBody = byId("studentTableBody");
const attendeeCountEl = byId("attendee-count");
const activeCountEl = byId("active-count");
const awayCountEl = byId("away-count");
const searchInput = document.querySelector(".search-input");
const hostControls = byId("host-controls");
const signInButton = byId("sign-in");
const signOutButton = byId("sign-out");
const accountStatus = byId("account-status");
const sessionNotice = byId("session-notice");
const btnStart = document.querySelector(".btn-start");
const btnPause = document.querySelector(".btn-pause");
const btnEnd = document.querySelector(".btn-end");
const statusFilter = byId("status-filter");

let user = null;
let meetCode = null;
let sessionData = null;
let studentsData = [];
let currentFilter = "all";
let searchQuery = "";
let stopSessionListener = null;
let stopStudentsListener = null;
let pendingAction = null;
let pendingActionLabel = "";
const STALE_AFTER_MS = 60_000;

function getGoogleAccessToken() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      // Chrome 105+ returns an object; older callback implementations return
      // the token string directly.
      const token = typeof result === "string" ? result : result?.token;
      if (!token) {
        reject(new Error("Chrome did not return a Google access token. Check the extension OAuth client and extension ID."));
        return;
      }
      resolve(token);
    });
  });
}

function getMeetCode(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "meet.google.com") return null;
    return parsed.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\/|$)/i)?.[1] ?? null;
  } catch {
    return null;
  }
}

function setNotice(message, isError = false) {
  sessionNotice.hidden = !message;
  sessionNotice.textContent = message;
  sessionNotice.classList.toggle("error", isError);
}

function getDisplayStatus(student, now = Date.now()) {
  if (student.status === "left" || sessionData?.status !== "running") return student.status;
  const lastSeen = student.lastSeen;
  const lastSeenMs = typeof lastSeen?.toMillis === "function"
    ? lastSeen.toMillis()
    : lastSeen instanceof Date
      ? lastSeen.getTime()
      : typeof lastSeen === "string"
        ? Date.parse(lastSeen)
        : Number.NaN;
  return Number.isFinite(lastSeenMs) && now - lastSeenMs <= STALE_AFTER_MS ? student.status : "left";
}

function updateControls() {
  const isHost = Boolean(user && meetCode && (!sessionData || sessionData.hostUid === user.uid));
  hostControls.hidden = !isHost;
  if (!user) {
    setNotice("Sign in with your instructor account to manage a session.");
    return;
  }
  if (!meetCode) {
    setNotice("Open this popup from an active Google Meet tab.");
    return;
  }
  if (sessionData?.hostUid && sessionData.hostUid !== user.uid) {
    setNotice("This session is managed by its host. Tracking is read-only here.");
    return;
  }
  setNotice(sessionData?.status === "running" ? `Tracking is on for ${meetCode}.` : "You can start a session for this meeting.");

  const status = sessionData?.status ?? "idle";
  btnStart.disabled = status === "running" || Boolean(pendingAction);
  btnStart.textContent = pendingAction === btnStart ? pendingActionLabel : status === "paused" ? "Resume" : "Start";
  btnPause.disabled = status !== "running" || Boolean(pendingAction);
  btnPause.textContent = pendingAction === btnPause ? pendingActionLabel : "Pause";
  btnEnd.disabled = !["running", "paused"].includes(status) || Boolean(pendingAction);
  btnEnd.textContent = pendingAction === btnEnd ? pendingActionLabel : "End";
}

async function runSessionAction(button, pendingLabel, action, errorLabel) {
  if (pendingAction) return;
  pendingAction = button;
  pendingActionLabel = pendingLabel;
  [btnStart, btnPause, btnEnd].forEach((control) => {
    control.disabled = true;
    control.setAttribute("aria-busy", "true");
  });
  updateControls();
  try {
    await action();
  } catch (error) {
    setNotice(`${errorLabel}: ${error.message}`, true);
  } finally {
    pendingAction = null;
    pendingActionLabel = "";
    [btnStart, btnPause, btnEnd].forEach((control) => control.removeAttribute("aria-busy"));
    updateControls();
  }
}

function renderUI() {
  const students = studentsData.map((student) => ({ ...student, displayStatus: getDisplayStatus(student) }));
  const total = students.length;
  const activeCount = students.filter((student) => student.displayStatus === "active").length;
  const awayCount = students.filter((student) => student.displayStatus === "away").length;
  attendeeCountEl.textContent = String(total);
  activeCountEl.textContent = `${activeCount}/${total}`;
  awayCountEl.textContent = `${awayCount}/${total}`;

  const filtered = students.filter((student) =>
    (currentFilter === "all" || student.displayStatus === currentFilter)
    && (student.name || "").toLowerCase().includes(searchQuery.toLowerCase())
  );
  studentTableBody.replaceChildren();
  if (!filtered.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 2;
    cell.className = "empty-state";
    cell.textContent = "No participants found.";
    row.appendChild(cell);
    studentTableBody.appendChild(row);
    return;
  }

  for (const student of filtered) {
    const row = document.createElement("tr");
    const nameCell = document.createElement("td");
    nameCell.className = "col-student";
    nameCell.textContent = student.name || "Unknown";
    const statusCell = document.createElement("td");
    statusCell.className = "col-status";
    const badge = document.createElement("span");
    const status = student.displayStatus;
    badge.className = `status-badge badge-${status}`;
    const dot = document.createElement("span");
    dot.className = "badge-dot";
    badge.append(dot, document.createTextNode(status === "active" ? "Active" : status === "away" ? "Away" : "Left"));
    statusCell.appendChild(badge);
    row.append(nameCell, statusCell);
    studentTableBody.appendChild(row);
  }
}

function stopListeners() {
  stopSessionListener?.();
  stopStudentsListener?.();
  stopSessionListener = null;
  stopStudentsListener = null;
  sessionData = null;
  studentsData = [];
  renderUI();
}

function listenToMeeting() {
  stopListeners();
  if (!user || !meetCode) {
    updateControls();
    return;
  }
  const sessionRef = doc(db, "sessions", meetCode);
  stopSessionListener = onSnapshot(sessionRef, (snapshot) => {
    sessionData = snapshot.exists() ? snapshot.data() : null;
    updateControls();

    stopStudentsListener?.();
    stopStudentsListener = null;
    studentsData = [];
    if (sessionData?.hostUid === user.uid) {
      stopStudentsListener = onSnapshot(collection(sessionRef, "students"), (students) => {
        studentsData = students.docs.map((student) => ({ id: student.id, ...student.data() }));
        studentsData.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        renderUI();
      }, (error) => setNotice(`Could not read attendees: ${error.message}`, true));
    }
    renderUI();
  }, (error) => setNotice(`Could not read meeting session: ${error.message}`, true));
}

signInButton.addEventListener("click", async () => {
  const originalLabel = signInButton.textContent;
  signInButton.disabled = true;
  signInButton.textContent = "Signing in…";
  setNotice("Opening Google sign-in…");
  try {
    const token = await getGoogleAccessToken();
    const credential = GoogleAuthProvider.credential(null, token);
    await signInWithCredential(auth, credential);
  } catch (error) {
    console.error("[InSession] Google sign-in failed:", error);
    setNotice(`Sign in failed: ${error.message || "Check the extension OAuth setup and try again."}`, true);
  } finally {
    signInButton.disabled = false;
    signInButton.textContent = originalLabel;
  }
});

signOutButton.addEventListener("click", async () => {
  signOutButton.disabled = true;
  signOutButton.textContent = "Signing out…";
  try {
    await signOut(auth);
    await chrome.storage.local.remove("hostUid");
  } catch (error) { setNotice(error.message, true); }
  finally {
    signOutButton.disabled = false;
    signOutButton.textContent = "Sign out";
  }
});

btnStart.addEventListener("click", async () => {
  if (!user || !meetCode) return;
  await runSessionAction(btnStart, sessionData?.status === "paused" ? "Resuming…" : "Starting…", async () => {
    const sessionRef = doc(db, "sessions", meetCode);
    if (!sessionData) {
      await setDoc(sessionRef, { meetCode, hostUid: user.uid, runId: crypto.randomUUID(), status: "running", startedAt: serverTimestamp() });
    } else if (sessionData.hostUid === user.uid) {
      const nextRun = sessionData.status === "ended";
      await updateDoc(sessionRef, {
        status: "running",
        ...(nextRun ? { runId: crypto.randomUUID(), startedAt: serverTimestamp() } : {}),
        resumedAt: serverTimestamp()
      });
    }
  }, "Could not start tracking");
});

btnPause.addEventListener("click", async () => {
  if (!sessionData || sessionData.hostUid !== user?.uid) return;
  await runSessionAction(btnPause, "Pausing…", () => updateDoc(doc(db, "sessions", meetCode), { status: "paused", pausedAt: serverTimestamp() }), "Could not pause tracking");
});

btnEnd.addEventListener("click", async () => {
  if (!sessionData || sessionData.hostUid !== user?.uid || !confirm("End tracking for this meeting?")) return;
  await runSessionAction(btnEnd, "Ending…", () => updateDoc(doc(db, "sessions", meetCode), { status: "ended", endedAt: serverTimestamp() }), "Could not end tracking");
});

searchInput.addEventListener("input", (event) => { searchQuery = event.target.value.trim(); renderUI(); });
statusFilter.addEventListener("change", (event) => { currentFilter = event.target.value; renderUI(); });

function useActiveTab(tab) {
  const nextMeetCode = getMeetCode(tab?.url);
  if (nextMeetCode === meetCode) return;
  meetCode = nextMeetCode;
  listenToMeeting();
  updateControls();
}

function refreshActiveTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => useActiveTab(tab));
}

refreshActiveTab();
chrome.tabs.onActivated.addListener(refreshActiveTab);
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.active && (changeInfo.url || changeInfo.status === "complete")) refreshActiveTab();
});

onAuthStateChanged(auth, (signedInUser) => {
  user = signedInUser;
  if (user) chrome.storage.local.set({ hostUid: user.uid });
  else chrome.storage.local.remove("hostUid");
  accountStatus.textContent = user ? `Signed in as ${user.displayName || user.email || "Google account"}` : "Sign in to manage a session";
  signInButton.hidden = Boolean(user);
  signOutButton.hidden = !user;
  listenToMeeting();
  updateControls();
});

setInterval(() => {
  if (sessionData?.status === "running") renderUI();
}, 5000);
