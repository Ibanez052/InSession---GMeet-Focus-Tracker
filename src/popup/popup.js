import { GoogleAuthProvider, linkWithCredential, onAuthStateChanged, signInAnonymously, signInWithCredential, signOut } from "firebase/auth/web-extension";
import { collection, deleteDoc, doc, onSnapshot, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
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
const hostDashboard = byId("host-dashboard");
const participantView = byId("participant-view");
const participantHeading = byId("participant-heading");
const participantMessage = byId("participant-message");
const btnStart = document.querySelector(".btn-start");
const btnPause = document.querySelector(".btn-pause");
const btnEnd = document.querySelector(".btn-end");
const statusFilter = byId("status-filter");

let user = null;
let meetCode = null;
let hostControlsVisible = false;
let sessionData = null;
let studentsData = [];
let currentFilter = "all";
let searchQuery = "";
let stopSessionListener = null;
let stopStudentsListener = null;
let pendingAction = null;
let pendingActionLabel = "";
let anonymousAuthPromise = null;
let stalenessTimer = null;
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

function setParticipantNotice(heading, message) {
  participantHeading.textContent = heading;
  participantMessage.textContent = message;
}

function showSessionError(message) {
  if (isGoogleAccount(user)) setNotice(message, true);
  else setParticipantNotice("Could not connect to the session", message);
}

function isGoogleAccount(account) {
  return Boolean(account?.providerData?.some((provider) => provider.providerId === "google.com"));
}

function ensureParticipantAuth() {
  if (!meetCode || user) return Promise.resolve();
  if (anonymousAuthPromise) return anonymousAuthPromise;
  anonymousAuthPromise = signInAnonymously(auth)
    .catch((error) => {
      console.error("[InSession] Anonymous participant sign-in failed:", error);
      setParticipantNotice("Participant tracking unavailable", "Could not connect to attendance tracking. Ask the instructor to check the extension setup.");
    })
    .finally(() => { anonymousAuthPromise = null; });
  return anonymousAuthPromise;
}

function getDisplayStatus(student, now = Date.now()) {
  if (!["active", "away", "left"].includes(student.status)) return "untracked";
  if (student.status === "left" || sessionData?.status !== "running") return student.status;
  const lastSeenMs = getLastSeenMillis(student);
  return Number.isFinite(lastSeenMs) && now - lastSeenMs <= STALE_AFTER_MS ? student.status : "untracked";
}

function getLastSeenMillis(student) {
  const lastSeen = student.lastSeen;
  return typeof lastSeen?.toMillis === "function"
    ? lastSeen.toMillis()
    : lastSeen instanceof Date
      ? lastSeen.getTime()
      : typeof lastSeen === "string"
        ? Date.parse(lastSeen)
        : Number.NaN;
}

function scheduleStalenessRefresh(now = Date.now()) {
  if (stalenessTimer !== null) clearTimeout(stalenessTimer);
  stalenessTimer = null;
  if (sessionData?.status !== "running") return;
  const nextStaleAt = studentsData
    .filter((student) => ["active", "away"].includes(student.status))
    .map(getLastSeenMillis)
    .filter((lastSeenMs) => Number.isFinite(lastSeenMs) && lastSeenMs + STALE_AFTER_MS + 1 > now)
    .reduce((earliest, lastSeenMs) => Math.min(earliest, lastSeenMs + STALE_AFTER_MS + 1), Number.POSITIVE_INFINITY);
  if (Number.isFinite(nextStaleAt)) {
    stalenessTimer = setTimeout(renderUI, Math.max(0, nextStaleAt - now));
  }
}

function updateControls() {
  const isGoogleUser = isGoogleAccount(user);
  const isHost = Boolean(isGoogleUser && meetCode && hostControlsVisible
    && (!sessionData || sessionData.hostUid === user.uid));
  hostControls.hidden = !isHost;
  hostDashboard.hidden = !isHost;
  participantView.hidden = isHost;
  signInButton.hidden = !hostControlsVisible || isGoogleUser
    || Boolean(user && sessionData?.hostUid && sessionData.hostUid !== user.uid);
  signInButton.textContent = user?.isAnonymous ? "Sign in as instructor" : "Instructor sign-in";
  signOutButton.hidden = !isGoogleUser;

  if (isHost) {
    accountStatus.textContent = `Signed in as ${user.displayName || user.email || "Google account"}`;
    if (!meetCode) {
      setNotice("Open this side panel from an active Google Meet tab.");
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
    return;
  }

  accountStatus.textContent = isGoogleUser ? "Participant mode" : user ? "Participant mode" : "Not signed in";
  if (!user) {
    setParticipantNotice(hostControlsVisible ? "Instructor sign-in" : "Participant mode",
      hostControlsVisible
        ? "Meet host controls are available in this call. Sign in with Google to manage the session."
        : "Your attendance is tracked automatically when the instructor starts a session.");
    return;
  }
  if (!meetCode) {
    setParticipantNotice("Ready for a meeting", "Your attendance status is reported automatically while an instructor's session is running.");
    return;
  }
  if (sessionData?.hostUid && sessionData.hostUid !== user.uid) {
    setParticipantNotice(sessionData.status === "running" ? "Attendance is being tracked" : "Participant mode", sessionData.status === "running"
      ? `Your status is shared with the host for meeting ${meetCode}.`
      : "Your status will be shared when the host starts tracking.");
    return;
  }
  if (!hostControlsVisible) {
    setParticipantNotice("Participant mode", "Meet host controls were not detected. Your attendance is tracked when the instructor starts a session.");
    return;
  }
  setParticipantNotice(sessionData?.status === "paused" ? "Tracking is paused" : "Waiting for the instructor", sessionData?.status === "paused"
    ? "Your status will be shared again when the host resumes tracking."
    : "Your attendance status will be shared automatically when the host starts tracking.");
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
  scheduleStalenessRefresh();
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
    const statusLabel = status === "active" ? "Active"
      : status === "away" ? "Away"
        : status === "left" ? "Left"
          : "Not reporting";
    badge.append(dot, document.createTextNode(statusLabel));
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
  if (!meetCode) {
    updateControls();
    return;
  }
  if (!user) {
    updateControls();
    ensureParticipantAuth();
    return;
  }
  const sessionRef = doc(db, "sessions", meetCode);
  stopSessionListener = onSnapshot(sessionRef, (snapshot) => {
    sessionData = snapshot.exists() ? snapshot.data() : null;
    updateControls();

    stopStudentsListener?.();
    stopStudentsListener = null;
    studentsData = [];
    if (isGoogleAccount(user) && sessionData?.hostUid === user.uid) {
      stopStudentsListener = onSnapshot(collection(sessionRef, "students"), (students) => {
        const hostRecord = students.docs.find((student) =>
          student.id === sessionData.hostUid || student.data().uid === sessionData.hostUid
        );
        if (hostRecord) {
          void deleteDoc(doc(sessionRef, "students", hostRecord.id)).catch((error) => {
            console.error("[InSession] Could not remove the host from the attendee list:", error);
          });
        }
        studentsData = students.docs
          .filter((student) => student.id !== sessionData.hostUid && student.data().uid !== sessionData.hostUid)
          .map((student) => ({ id: student.id, ...student.data() }));
        studentsData.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        renderUI();
      }, (error) => setNotice(`Could not read attendees: ${error.message}`, true));
    }
    renderUI();
  }, (error) => showSessionError(`Could not read meeting session: ${error.message}`));
}

signInButton.addEventListener("click", async () => {
  const originalLabel = signInButton.textContent;
  signInButton.disabled = true;
  signInButton.textContent = "Signing in…";
  setNotice("Opening Google sign-in…");
  try {
    await ensureParticipantAuth();
    const token = await getGoogleAccessToken();
    const credential = GoogleAuthProvider.credential(null, token);
    if (auth.currentUser?.isAnonymous) {
      try {
        await linkWithCredential(auth.currentUser, credential);
      } catch (error) {
        if (error.code !== "auth/credential-already-in-use") throw error;
        await signInWithCredential(auth, credential);
      }
    } else {
      await signInWithCredential(auth, credential);
    }
  } catch (error) {
    console.error("[InSession] Google sign-in failed:", error);
    const message = error.message || "Check the extension OAuth setup and try again.";
    if (isGoogleAccount(user)) setNotice(`Sign in failed: ${message}`, true);
    else setParticipantNotice("Instructor sign-in failed", message);
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
  } catch (error) { setNotice(error.message, true); }
  finally {
    signOutButton.disabled = false;
    signOutButton.textContent = "Sign out";
  }
});

btnStart.addEventListener("click", async () => {
  if (!isGoogleAccount(user) || !meetCode) return;
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
  if (!isGoogleAccount(user) || !sessionData || sessionData.hostUid !== user.uid) return;
  await runSessionAction(btnPause, "Pausing…", () => updateDoc(doc(db, "sessions", meetCode), { status: "paused", pausedAt: serverTimestamp() }), "Could not pause tracking");
});

btnEnd.addEventListener("click", async () => {
  if (!isGoogleAccount(user) || !sessionData || sessionData.hostUid !== user.uid || !confirm("End tracking for this meeting?")) return;
  await runSessionAction(btnEnd, "Ending…", () => updateDoc(doc(db, "sessions", meetCode), { status: "ended", endedAt: serverTimestamp() }), "Could not end tracking");
});

searchInput.addEventListener("input", (event) => { searchQuery = event.target.value.trim(); renderUI(); });
statusFilter.addEventListener("change", (event) => { currentFilter = event.target.value; renderUI(); });

function useActiveTab(tab) {
  const nextMeetCode = getMeetCode(tab?.url);
  if (nextMeetCode === meetCode) {
    refreshHostUiRole(tab?.id);
    return;
  }
  meetCode = nextMeetCode;
  hostControlsVisible = false;
  listenToMeeting();
  updateControls();
  refreshHostUiRole(tab?.id);
}

function refreshHostUiRole(tabId) {
  if (!tabId || !meetCode) {
    hostControlsVisible = false;
    updateControls();
    return;
  }
  chrome.tabs.sendMessage(tabId, { type: "in-session:get-host-ui-role" }, (result) => {
    // A missing content script or changed Meet UI must not grant host controls.
    if (chrome.runtime.lastError) {
      hostControlsVisible = false;
      updateControls();
      return;
    }
    hostControlsVisible = Boolean(result?.inMeeting && result?.hostControlsVisible && result?.meetCode === meetCode);
    updateControls();
  });
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
  if (isGoogleAccount(user)) chrome.storage.local.set({ hostUid: user.uid });
  listenToMeeting();
  updateControls();
});
