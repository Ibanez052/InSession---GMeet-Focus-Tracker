import { GoogleAuthProvider, onAuthStateChanged, signInWithCredential, signOut } from "firebase/auth/web-extension";
import { collection, doc, onSnapshot, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
import { auth, db } from "../shared/firebase.js";

const byId = (id) => document.getElementById(id);
const studentTableBody = byId("studentTableBody");
const attendeeCountEl = document.querySelector(".card-yellow .stat-number");
const activeCountEl = document.querySelector(".card-green .stat-number");
const awayCountEl = document.querySelector(".card-red .stat-number");
const searchInput = document.querySelector(".search-input");
const hostControls = byId("host-controls");
const signInButton = byId("sign-in");
const signOutButton = byId("sign-out");
const accountStatus = byId("account-status");
const sessionNotice = byId("session-notice");
const btnStart = document.querySelector(".btn-start");
const btnPause = document.querySelector(".btn-pause");
const btnEnd = document.querySelector(".btn-end");
const filterBtn = byId("filter-btn");
const filterDropdown = byId("filterDropdown");
const currentFilterText = byId("currentFilterText");
const menuItems = filterDropdown?.querySelectorAll("li") ?? [];

let user = null;
let meetCode = null;
let sessionData = null;
let studentsData = [];
let currentFilter = "all";
let searchQuery = "";
let stopSessionListener = null;
let stopStudentsListener = null;

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
  btnStart.disabled = status === "running";
  btnStart.textContent = status === "paused" ? "Resume" : "Start";
  btnPause.disabled = status !== "running";
  btnEnd.disabled = !["running", "paused"].includes(status);
}

function renderUI() {
  const total = studentsData.length;
  const activeCount = studentsData.filter((student) => student.status === "active").length;
  const awayCount = studentsData.filter((student) => student.status === "away").length;
  attendeeCountEl.textContent = String(total);
  activeCountEl.textContent = `${activeCount}/${total}`;
  awayCountEl.textContent = `${awayCount}/${total}`;

  const filtered = studentsData.filter((student) =>
    (currentFilter === "all" || student.status === currentFilter)
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
    const active = student.status === "active";
    badge.className = `status-badge ${active ? "badge-active" : "badge-away"}`;
    const dot = document.createElement("span");
    dot.className = "badge-dot";
    badge.append(dot, document.createTextNode(active ? "Active" : "Away"));
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
  signInButton.disabled = true;
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
  }
});

signOutButton.addEventListener("click", async () => {
  try {
    await signOut(auth);
    await chrome.storage.local.remove("hostUid");
  } catch (error) { setNotice(error.message, true); }
});

btnStart.addEventListener("click", async () => {
  if (!user || !meetCode) return;
  try {
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
  } catch (error) {
    setNotice(`Could not start tracking: ${error.message}`, true);
  }
});

btnPause.addEventListener("click", async () => {
  if (!sessionData || sessionData.hostUid !== user?.uid) return;
  try { await updateDoc(doc(db, "sessions", meetCode), { status: "paused", pausedAt: serverTimestamp() }); }
  catch (error) { setNotice(`Could not pause tracking: ${error.message}`, true); }
});

btnEnd.addEventListener("click", async () => {
  if (!sessionData || sessionData.hostUid !== user?.uid || !confirm("End tracking for this meeting?")) return;
  try { await updateDoc(doc(db, "sessions", meetCode), { status: "ended", endedAt: serverTimestamp() }); }
  catch (error) { setNotice(`Could not end tracking: ${error.message}`, true); }
});

searchInput.addEventListener("input", (event) => { searchQuery = event.target.value.trim(); renderUI(); });
filterBtn.addEventListener("click", (event) => { event.stopPropagation(); filterDropdown.classList.toggle("show"); });
menuItems.forEach((item) => item.addEventListener("click", () => {
  menuItems.forEach((entry) => entry.classList.remove("active"));
  item.classList.add("active");
  currentFilter = item.dataset.value;
  currentFilterText.textContent = item.textContent;
  filterDropdown.classList.remove("show");
  renderUI();
}));
document.addEventListener("click", (event) => {
  if (!filterDropdown.contains(event.target) && !filterBtn.contains(event.target)) filterDropdown.classList.remove("show");
});

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  meetCode = getMeetCode(tab?.url);
  updateControls();
  if (user) listenToMeeting();
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
