import { GoogleAuthProvider, linkWithCredential, onAuthStateChanged, signInAnonymously, signInWithCredential, signOut } from "firebase/auth/web-extension";
import { collection, deleteDoc, doc, getDoc, getDocs, onSnapshot, serverTimestamp, setDoc, Timestamp, updateDoc, writeBatch } from "firebase/firestore";
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
const retryParticipantErrorButton = byId("retry-participant-error");
const retrySessionErrorButton = byId("retry-session-error");
const refreshHostDetectionButton = byId("refresh-host-detection");
const btnStart = byId("start-session");
const btnPause = byId("pause-session");
const btnEnd = byId("end-session");
const btnDownloadAttendance = byId("download-attendance");
const statusFilter = byId("status-filter");
const checkInSettings = byId("check-in-settings");
const checkInIntervalSelect = byId("check-in-interval");
const requestCheckInButton = byId("request-check-in");

let user = null;
let localParticipantUid = null;
let meetCode = null;
let hostControlsVisible = false;
let hostDetectionRequestId = 0;
let activeMeetTabId = null;
let popupErrorMessage = "";
let popupErrorSource = "";
let popupErrorRetry = null;
let sessionData = null;
let studentsData = [];
let rosterNames = [];
let currentFilter = "all";
let searchQuery = "";
let stopSessionListener = null;
let stopStudentsListener = null;
let pendingAction = null;
let pendingActionLabel = "";
let anonymousAuthPromise = null;
let hostTransferPromise = null;
let authStateInitialized = false;
let resolveAuthStateInitialized;
const authStateInitializedPromise = new Promise((resolve) => {
  resolveAuthStateInitialized = resolve;
});
let stalenessTimer = null;
let selectedCheckInInterval = 0;
let endConfirmationPending = false;
const STALE_AFTER_MS = 60_000;
const DELETE_BATCH_SIZE = 450;

async function signOutAndClearGoogleAccount() {
  await signOut(auth);
}

function requestGoogleAccountSelection() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "in-session:choose-google-account" }, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (!result?.accessToken) {
        reject(new Error(result?.message || "Google account selection was canceled or did not return an access token."));
        return;
      }
      resolve(result.accessToken);
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
  if (popupErrorMessage && !isError) {
    renderPopupError();
    return;
  }
  sessionNotice.hidden = !message;
  sessionNotice.textContent = message;
  sessionNotice.classList.toggle("error", isError);
}

function setParticipantNotice(heading, message) {
  if (popupErrorMessage) {
    renderPopupError();
    return;
  }
  participantHeading.textContent = heading;
  participantMessage.textContent = message;
}

function notifyBackgroundError(type, source, message = "") {
  chrome.runtime.sendMessage({ type, source, message }, () => { void chrome.runtime.lastError; });
}

function renderPopupError() {
  if (!popupErrorMessage) return;
  if (!hostDashboard.hidden) {
    sessionNotice.hidden = false;
    sessionNotice.textContent = popupErrorMessage;
    sessionNotice.classList.add("error");
    retrySessionErrorButton.hidden = !popupErrorRetry;
    retryParticipantErrorButton.hidden = true;
  } else {
    participantHeading.textContent = "Something needs attention";
    participantMessage.textContent = popupErrorMessage;
    retryParticipantErrorButton.hidden = !popupErrorRetry;
    retrySessionErrorButton.hidden = true;
  }
}

function showPopupError(message, source, retry = null) {
  popupErrorMessage = message;
  popupErrorSource = source;
  popupErrorRetry = retry;
  notifyBackgroundError("in-session:report-error", source, message);
  renderPopupError();
}

function clearPopupError(source = popupErrorSource) {
  if (!source) return;
  notifyBackgroundError("in-session:clear-error", source);
  if (source !== popupErrorSource) return;
  popupErrorMessage = "";
  popupErrorSource = "";
  popupErrorRetry = null;
  retrySessionErrorButton.hidden = true;
  retryParticipantErrorButton.hidden = true;
  sessionNotice.classList.remove("error");
  updateControls();
}

function showSessionError(message) {
  showPopupError(message, "session-read", listenToMeeting);
}

function retryContentAction(action, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab || getMeetCode(tab.url) !== meetCode) {
        reject(new Error("Open the affected Google Meet tab and retry."));
        return;
      }
      chrome.tabs.sendMessage(tab.id, { type: "in-session:retry", action, ...payload }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error("Reload the Meet tab, then retry."));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.message || "The retry did not complete."));
          return;
        }
        resolve();
      });
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "in-session:report-error") {
    const retry = message.retryAction ? () => retryContentAction(message.retryAction) : null;
    showPopupError(message.message || "Attendance tracking needs attention.", message.source || "unknown", retry);
  } else if (message?.type === "in-session:clear-error") {
    clearPopupError(message.source || "unknown");
  } else if (message?.type === "in-session:roster-update"
    && sender.tab?.id === activeMeetTabId && message.meetCode === meetCode && hostControlsVisible) {
    rosterNames = Array.isArray(message.participantNames) ? message.participantNames : [];
    renderUI();
  }
});

chrome.runtime.sendMessage({ type: "in-session:get-errors" }, (errors) => {
  if (chrome.runtime.lastError || popupErrorMessage || !errors) return;
  const [source, message] = Object.entries(errors).at(-1) ?? [];
  if (!source) return;
  const contentRetry = ({
    "participant-status": "status",
    "participant-session": "session",
    "participant-auth": "auth"
  })[source];
  const retry = contentRetry ? () => retryContentAction(contentRetry)
    : ["session-read", "attendees-read", "host-record-cleanup"].includes(source) ? listenToMeeting
      : source === "google-auth" ? () => signInButton.click()
          : source === "sign-out" ? signOutAndClearGoogleAccount
          : null;
  showPopupError(message, source, retry);
});

function toMillis(value) {
  return typeof value?.toMillis === "function" ? value.toMillis()
    : value instanceof Date ? value.getTime()
      : Number.NaN;
}

function normalizeParticipantName(name) {
  return String(name || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeNameForIdentityMatch(name) {
  return String(name || "").normalize("NFKC").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

function resolveFallbackParticipantNames(participants, availableRosterNames) {
  const genericName = (name) => !name || /^(?:meet(?:ing)? participant|unknown participant)$/i.test(name.trim());
  const nameCounts = new Map();
  for (const participant of participants) {
    if (genericName(participant.name)) continue;
    const key = normalizeParticipantName(participant.name);
    nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
  }
  const rosterCounts = new Map();
  for (const name of availableRosterNames) {
    const key = normalizeParticipantName(name);
    rosterCounts.set(key, (rosterCounts.get(key) || 0) + 1);
  }
  const unmatchedRosterNames = [];
  for (const [key, count] of rosterCounts) {
    const unmatched = count - (nameCounts.get(key) || 0);
    for (let index = 0; index < unmatched; index += 1) {
      unmatchedRosterNames.push(availableRosterNames.find((name) => normalizeParticipantName(name) === key));
    }
  }
  const fallbackIndexes = participants
    .map((participant, index) => genericName(participant.name) ? index : -1)
    .filter((index) => index !== -1);
  if (fallbackIndexes.length !== 1 || unmatchedRosterNames.length !== 1) return participants;
  const [participantIndex] = fallbackIndexes;
  return participants.map((participant, index) => index === participantIndex
    ? { ...participant, name: unmatchedRosterNames[0] }
    : participant);
}

function currentCheckInRound(now = Date.now()) {
  const interval = Number(sessionData?.checkInIntervalMinutes);
  if (!Number.isFinite(interval) || interval <= 0 || sessionData?.status !== "running") return 0;
  const cycleStartedAt = toMillis(sessionData.checkInCycleStartedAt)
    || toMillis(sessionData.resumedAt)
    || toMillis(sessionData.startedAt);
  if (!Number.isFinite(cycleStartedAt)) return 0;
  const elapsed = now - cycleStartedAt;
  if (elapsed < interval * 60_000) return 0;
  return Math.floor(elapsed / (interval * 60_000));
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[\t\r\n=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function isCurrentRunStudent(student, session) {
  if (student.runId) return student.runId === session.runId;
  const lastSeenMs = toMillis(student.lastSeen);
  const startedAtMs = toMillis(session.startedAt);
  return Number.isFinite(lastSeenMs) && Number.isFinite(startedAtMs) && lastSeenMs >= startedAtMs;
}

function createAttendanceCsv(session, participantDocs, endedAtMs, availableRosterNames = []) {
  const startedAtMs = toMillis(session.startedAt);
  const startedAt = Number.isFinite(startedAtMs) ? new Date(startedAtMs).toISOString() : "";
  const endedAt = new Date(endedAtMs).toISOString();
  const pausedAtMs = toMillis(session.pausedAt);
  const resumedAtMs = toMillis(session.resumedAt);
  const trackingEndedAtMs = Number.isFinite(pausedAtMs) && (!Number.isFinite(resumedAtMs) || pausedAtMs > resumedAtMs)
    ? pausedAtMs
    : endedAtMs;
  const rows = [["Participant", "Final status", "Active duration estimate", "Away duration estimate", "Last activity confirmation (UTC)", "Meeting code", "Session started (UTC)", "Session ended (UTC)"]];
  const participantData = resolveFallbackParticipantNames(
    participantDocs.map((participantDoc) => participantDoc.data()),
    availableRosterNames
  );
  const participants = participantData.map((student) => {
    const hasDurationData = typeof student.activeDurationMs === "number" && typeof student.awayDurationMs === "number";
    let activeMs = Math.max(0, Number(student.activeDurationMs) || 0);
    let awayMs = Math.max(0, Number(student.awayDurationMs) || 0);
    const lastSeenMs = toMillis(student.lastSeen);
    const signalAgeMs = Number.isFinite(lastSeenMs) ? Math.max(0, trackingEndedAtMs - lastSeenMs) : Number.POSITIVE_INFINITY;
    const finalSegmentMs = Number.isFinite(signalAgeMs)
      ? Math.max(0, Math.min(signalAgeMs, STALE_AFTER_MS, Math.max(0, trackingEndedAtMs - lastSeenMs)))
      : 0;
    if (student.status === "active") activeMs += finalSegmentMs;
    if (student.status === "away") awayMs += finalSegmentMs;
    const finalStatus = student.status === "left" ? "Left"
      : signalAgeMs <= STALE_AFTER_MS && ["active", "away"].includes(student.status)
        ? student.status === "active" ? "Active" : "Away"
        : "Not reporting";
    const checkInAtMs = student.runId === session.runId
      && ((session.checkInPromptId && student.checkInPromptId === session.checkInPromptId)
        || (session.checkInCycleId && student.checkInCycleId === session.checkInCycleId))
      ? toMillis(student.checkInAt)
      : Number.NaN;
    return [student.name || "Unknown participant", finalStatus,
      hasDurationData ? formatDuration(activeMs) : "Unavailable in this extension version",
      hasDurationData ? formatDuration(awayMs) : "Unavailable in this extension version",
      Number.isFinite(checkInAtMs) ? new Date(checkInAtMs).toISOString() : "",
      session.meetCode, startedAt, endedAt];
  });
  rows.push(...participants);
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

async function waitForDownload(downloadId) {
  await new Promise((resolve, reject) => {
    const finish = (error) => {
      chrome.downloads.onChanged.removeListener(onChanged);
      if (error) reject(error);
      else resolve();
    };
    const onChanged = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === "complete") finish();
      if (delta.state.current === "interrupted") finish(new Error("The CSV download was canceled or interrupted."));
    };
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id: downloadId }).then(([download]) => {
      if (download?.state === "complete") finish();
      else if (download?.state === "interrupted") finish(new Error("The CSV download was canceled or interrupted."));
    }).catch(finish);
  });
}

async function downloadAttendanceCsv(csv, meetCode, endedAtMs) {
  const objectUrl = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const date = new Date(endedAtMs).toISOString().slice(0, 10);
  try {
    const downloadId = await chrome.downloads.download({
      url: objectUrl,
      filename: `InSession-${meetCode}-${date}.csv`,
      saveAs: true
    });
    await waitForDownload(downloadId);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function deleteEndedSessionData(sessionRef, existingStudentsSnapshot = null) {
  const studentsSnapshot = existingStudentsSnapshot ?? await getDocs(collection(sessionRef, "students"));
  for (let start = 0; start < studentsSnapshot.docs.length; start += DELETE_BATCH_SIZE) {
    const batch = writeBatch(db);
    for (const student of studentsSnapshot.docs.slice(start, start + DELETE_BATCH_SIZE)) {
      batch.delete(student.ref);
    }
    await batch.commit();
  }
  await deleteDoc(sessionRef);
}

async function downloadOrClearEndedSession() {
  if (!isGoogleAccount(user) || !meetCode) {
    throw new Error("Only the instructor can export an ended session.");
  }
  const sessionRef = doc(db, "sessions", meetCode);
  const currentSessionSnapshot = await getDoc(sessionRef);
  if (!currentSessionSnapshot.exists()) return;
  const currentSession = currentSessionSnapshot.data();
  if (currentSession.hostUid !== user.uid || currentSession.status !== "ended") {
    throw new Error("The meeting session changed. Refresh and try again.");
  }
  let studentsToDelete = null;
  if (!currentSession.exportedAt) {
    const studentsSnapshot = await getDocs(collection(sessionRef, "students"));
    const endedAtMs = toMillis(currentSession.endedAt) || Date.now();
    const currentRunStudents = studentsSnapshot.docs.filter((student) =>
      student.id !== currentSession.hostUid
      && student.data().uid !== currentSession.hostUid
      && student.id !== localParticipantUid
      && student.data().uid !== localParticipantUid
      && isCurrentRunStudent(student.data(), currentSession)
    );
    const hostName = isGoogleAccount(user) ? normalizeNameForIdentityMatch(user.displayName) : "";
    const exportRosterNames = rosterNames.filter((name) => normalizeNameForIdentityMatch(name) !== hostName);
    const csv = createAttendanceCsv(currentSession, currentRunStudents, endedAtMs, exportRosterNames);
    await downloadAttendanceCsv(csv, currentSession.meetCode || meetCode, endedAtMs);
    await updateDoc(sessionRef, { exportedAt: serverTimestamp() });
    studentsToDelete = studentsSnapshot;
  }
  await deleteEndedSessionData(sessionRef, studentsToDelete);
}

function isGoogleAccount(account) {
  return Boolean(account?.providerData?.some((provider) => provider.providerId === "google.com"));
}

function ensureParticipantAuth() {
  if (!meetCode) return Promise.resolve();
  if (!authStateInitialized) return authStateInitializedPromise.then(() => ensureParticipantAuth());
  if (user) return Promise.resolve();
  if (anonymousAuthPromise) return anonymousAuthPromise;
  anonymousAuthPromise = signInAnonymously(auth)
    .catch((error) => {
      console.error("[InSession] Anonymous participant sign-in failed:", error);
      showPopupError("Could not connect to attendance tracking. Check the connection and retry.", "participant-auth", async () => {
        await ensureParticipantAuth();
        if (!auth.currentUser) throw new Error("Anonymous sign-in did not complete.");
      });
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
  const ownsCurrentSession = Boolean(sessionData?.hostUid && sessionData.hostUid === user?.uid);
  const isHost = Boolean(isGoogleUser && meetCode
    && (ownsCurrentSession || (!sessionData && hostControlsVisible)));
  hostControls.hidden = !isHost;
  hostDashboard.hidden = !isHost;
  participantView.hidden = isHost;
  checkInSettings.hidden = !isHost;
  requestCheckInButton.hidden = !isHost || sessionData?.status !== "running";
  requestCheckInButton.disabled = Boolean(pendingAction);
  requestCheckInButton.textContent = pendingAction === requestCheckInButton ? pendingActionLabel : "Check in now";
  if (isHost) {
    checkInIntervalSelect.value = String(sessionData?.checkInIntervalMinutes ?? selectedCheckInInterval);
    selectedCheckInInterval = Number(checkInIntervalSelect.value) || 0;
    checkInIntervalSelect.disabled = sessionData?.status === "ended" || Boolean(pendingAction);
  }
  refreshHostDetectionButton.hidden = !meetCode || hostControlsVisible
    || Boolean(sessionData?.hostUid && user?.uid && sessionData.hostUid !== user.uid && !sessionData?.hostTransferPending);
  signInButton.hidden = !hostControlsVisible || isGoogleUser
    || Boolean(user && sessionData?.hostUid && sessionData.hostUid !== user.uid && !sessionData?.hostTransferPending);
  signInButton.textContent = user?.isAnonymous ? "Sign in as instructor" : "Instructor sign-in";
  signOutButton.hidden = !isGoogleUser;

  if (isHost) {
    accountStatus.textContent = `Signed in as ${user.displayName || user.email || "Google account"}`;
    if (!meetCode) {
      setNotice("Open this side panel from an active Google Meet tab.");
      return;
    }
    const notice = sessionData?.status === "running" ? `Tracking is on for ${meetCode}.`
      : sessionData?.status === "ended"
        ? sessionData.exportedAt ? "CSV downloaded; finish clearing session data." : "Download the attendance CSV to finish and clear session data."
        : "You can start a session for this meeting.";
    setNotice(notice);

    const status = sessionData?.status ?? "idle";
    btnStart.disabled = status === "running" || status === "ended" || Boolean(pendingAction);
    btnStart.textContent = pendingAction === btnStart ? pendingActionLabel : status === "paused" ? "Resume" : "Start";
    btnPause.disabled = status !== "running" || Boolean(pendingAction);
    btnPause.textContent = pendingAction === btnPause ? pendingActionLabel : "Pause";
    btnEnd.disabled = !["running", "paused"].includes(status) || Boolean(pendingAction);
    btnEnd.textContent = pendingAction === btnEnd ? pendingActionLabel : endConfirmationPending ? "Confirm end" : "End";
    btnDownloadAttendance.hidden = status !== "ended";
    btnDownloadAttendance.disabled = Boolean(pendingAction);
    btnDownloadAttendance.textContent = sessionData?.exportedAt ? "Finish data cleanup" : "Download CSV & delete data";
    return;
  }

  accountStatus.textContent = isGoogleUser ? "Participant mode" : user ? "Participant mode" : "Not signed in";
  if (!user) {
    setParticipantNotice(hostControlsVisible ? "Instructor sign-in" : "Participant mode",
      sessionData?.hostTransferPending && hostControlsVisible
        ? "The instructor opened a short handoff. Sign in with the Google account that should manage this meeting."
        : hostControlsVisible
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
  clearPopupError();
  pendingAction = button;
  pendingActionLabel = pendingLabel;
  [btnStart, btnPause, btnEnd, btnDownloadAttendance, requestCheckInButton].forEach((control) => {
    control.disabled = true;
    control.setAttribute("aria-busy", "true");
  });
  updateControls();
  let succeeded = false;
  let failureNotice = "";
  try {
    await action();
    succeeded = true;
  } catch (error) {
    failureNotice = `${errorLabel}: ${error.message}`;
  } finally {
    pendingAction = null;
    pendingActionLabel = "";
    [btnStart, btnPause, btnEnd, btnDownloadAttendance, requestCheckInButton].forEach((control) => control.removeAttribute("aria-busy"));
    updateControls();
  }
  if (failureNotice) showPopupError(failureNotice, "session-action",
    () => runSessionAction(button, pendingLabel, action, errorLabel));
  else clearPopupError("session-action");
  return succeeded;
}

async function retryPopupError() {
  if (!popupErrorRetry) return;
  const retry = popupErrorRetry;
  const source = popupErrorSource;
  const buttons = [retrySessionErrorButton, retryParticipantErrorButton];
  for (const button of buttons) {
    if (!button.hidden) {
      button.disabled = true;
      button.textContent = "Retrying…";
    }
  }
  try {
    const retryResult = await retry();
    if (retryResult === false) return;
    clearPopupError(source);
  } catch (error) {
    showPopupError(`Retry failed: ${error.message || "Please try again."}`, source, retry);
  } finally {
    for (const button of buttons) {
      button.disabled = false;
      button.textContent = "Retry connection";
    }
  }
}

retrySessionErrorButton.addEventListener("click", retryPopupError);
retryParticipantErrorButton.addEventListener("click", retryPopupError);

function renderUI() {
  scheduleStalenessRefresh();
  const signedInHostName = isGoogleAccount(user) ? normalizeNameForIdentityMatch(user.displayName) : "";
  const availableRosterNames = rosterNames.filter((name) => normalizeNameForIdentityMatch(name) !== signedInHostName);
  const reconciledStudents = resolveFallbackParticipantNames(studentsData, availableRosterNames);
  const students = reconciledStudents.map((student) => ({ ...student, displayStatus: getDisplayStatus(student) }));
  const reportedNameCounts = new Map();
  for (const student of students) {
    const key = normalizeParticipantName(student.name);
    reportedNameCounts.set(key, (reportedNameCounts.get(key) || 0) + 1);
  }
  const rosterNameCounts = new Map();
  for (const name of rosterNames) {
    const rosterIdentity = normalizeNameForIdentityMatch(name);
    if (signedInHostName && rosterIdentity === signedInHostName) continue;
    const key = normalizeParticipantName(name);
    const rosterSeen = (rosterNameCounts.get(key) || 0) + 1;
    rosterNameCounts.set(key, rosterSeen);
    if (rosterSeen > (reportedNameCounts.get(key) || 0)) {
      students.push({ name, displayStatus: "untracked", fromRoster: true });
    }
  }
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
    const checkInRound = currentCheckInRound();
    if ((checkInRound || sessionData?.checkInPromptId) && !student.fromRoster) {
      const confirmed = (!sessionData?.checkInPromptId || student.checkInPromptId === sessionData.checkInPromptId)
        && (!checkInRound || (student.checkInCycleId === sessionData?.checkInCycleId && student.checkInRound === checkInRound));
      const checkInLabel = document.createElement("span");
      checkInLabel.className = `check-in-state${confirmed ? " confirmed" : " pending"}`;
      checkInLabel.textContent = confirmed ? "Confirmed" : "Awaiting check-in";
      statusCell.appendChild(checkInLabel);
    }
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
  rosterNames = [];
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
    clearPopupError("session-read");
    sessionData = snapshot.exists() ? snapshot.data() : null;
    void resolvePendingHostTransfer();
    updateControls();
    stopStudentsListener?.();
    stopStudentsListener = null;
    studentsData = [];
    if (isGoogleAccount(user) && sessionData?.hostUid === user.uid) {
      stopStudentsListener = onSnapshot(collection(sessionRef, "students"), (students) => {
        clearPopupError("attendees-read");
        const hostRecord = students.docs.find((student) =>
          student.id === sessionData.hostUid || student.data().uid === sessionData.hostUid
          || (localParticipantUid && (student.id === localParticipantUid || student.data().uid === localParticipantUid))
        );
        if (hostRecord) {
          void deleteDoc(doc(sessionRef, "students", hostRecord.id))
            .then(() => clearPopupError("host-record-cleanup"))
            .catch((error) => {
              console.error("[InSession] Could not remove the host from the attendee list:", error);
              showPopupError(`Could not remove the host from the attendee list: ${error.message}`, "host-record-cleanup", listenToMeeting);
            });
        }
        studentsData = students.docs
          .filter((student) => student.id !== sessionData.hostUid && student.data().uid !== sessionData.hostUid)
          .filter((student) => !localParticipantUid || (student.id !== localParticipantUid && student.data().uid !== localParticipantUid))
          .filter((student) => isCurrentRunStudent(student.data(), sessionData))
          .map((student) => ({ id: student.id, ...student.data() }));
        studentsData.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        renderUI();
      }, (error) => showPopupError(`Could not read attendees: ${error.message}`, "attendees-read", listenToMeeting));
    }
    renderUI();
  }, (error) => showSessionError(`Could not read meeting session: ${error.message}`));
}

async function resolvePendingHostTransfer() {
  if (hostTransferPromise || !sessionData?.hostTransferPending || !isGoogleAccount(user) || !meetCode) return;
  const sessionRef = doc(db, "sessions", meetCode);
  const targetUid = user.uid;
  const currentHostUid = sessionData.hostUid;

  hostTransferPromise = (async () => {
    if (targetUid === currentHostUid) return;
    const expiresAt = toMillis(sessionData.hostTransferExpiresAt);
    if (!hostControlsVisible || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
    await updateDoc(sessionRef, { hostUid: targetUid, hostTransferPending: false });
  })()
    .then(() => clearPopupError("host-transfer"))
    .catch((error) => {
      showPopupError(`Could not transfer the session to this account: ${error.message}`, "host-transfer", resolvePendingHostTransfer);
    })
    .finally(() => { hostTransferPromise = null; });
  return hostTransferPromise;
}

signInButton.addEventListener("click", async () => {
  clearPopupError();
  const originalLabel = signInButton.textContent;
  signInButton.disabled = true;
  signInButton.textContent = "Signing in…";
  setNotice("Opening Google sign-in…");
  try {
    await ensureParticipantAuth();
    const token = await requestGoogleAccountSelection();
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
    clearPopupError("google-auth");
  } catch (error) {
    console.error("[InSession] Google sign-in failed:", error);
    const message = error.message || "Check the extension OAuth setup and try again.";
    showPopupError(`Sign in failed: ${message}`, "google-auth", () => signInButton.click());
  } finally {
    signInButton.disabled = false;
    signInButton.textContent = originalLabel;
  }
});

signOutButton.addEventListener("click", async () => {
  clearPopupError();
  signOutButton.disabled = true;
  signOutButton.textContent = "Switching…";
  try {
    if (isGoogleAccount(user) && sessionData?.hostUid === user.uid && meetCode) {
      const expiresAt = Timestamp.fromMillis(Date.now() + 2 * 60 * 1000);
      await updateDoc(doc(db, "sessions", meetCode), {
        hostTransferPending: true,
        hostTransferExpiresAt: expiresAt,
      });
      sessionData = { ...sessionData, hostTransferPending: true, hostTransferExpiresAt: expiresAt };
    }
    await signOutAndClearGoogleAccount();
    clearPopupError("sign-out");
    setParticipantNotice("Signed out", "Choose Sign in as instructor to use another Google account for this meeting.");
  } catch (error) {
    showPopupError(`Could not switch accounts: ${error.message}`, "sign-out", signOutAndClearGoogleAccount);
  }
  finally {
    signOutButton.disabled = false;
    signOutButton.textContent = "Switch account";
  }
});

btnStart.addEventListener("click", async () => {
  if (!isGoogleAccount(user) || !meetCode) return;
  await runSessionAction(btnStart, sessionData?.status === "paused" ? "Resuming…" : "Starting…", async () => {
    const sessionRef = doc(db, "sessions", meetCode);
    if (!sessionData) {
      await setDoc(sessionRef, {
        meetCode,
        hostUid: user.uid,
        runId: crypto.randomUUID(),
        status: "running",
        startedAt: serverTimestamp(),
        resumedAt: serverTimestamp(),
        checkInIntervalMinutes: selectedCheckInInterval,
        checkInCycleId: crypto.randomUUID(),
        checkInCycleStartedAt: serverTimestamp()
      });
    } else if (sessionData.hostUid === user.uid) {
      const nextRun = sessionData.status === "ended";
      await updateDoc(sessionRef, {
        status: "running",
        ...(nextRun ? { runId: crypto.randomUUID(), startedAt: serverTimestamp() } : {}),
        ...(nextRun ? { checkInPromptId: null, checkInPromptAt: null } : {}),
        resumedAt: serverTimestamp(),
        checkInIntervalMinutes: selectedCheckInInterval,
        checkInCycleId: crypto.randomUUID(),
        checkInCycleStartedAt: serverTimestamp()
      });
    }
  }, "Could not start tracking");
});

btnPause.addEventListener("click", async () => {
  if (!isGoogleAccount(user) || !sessionData || sessionData.hostUid !== user.uid) return;
  await runSessionAction(btnPause, "Pausing…", () => updateDoc(doc(db, "sessions", meetCode), { status: "paused", pausedAt: serverTimestamp() }), "Could not pause tracking");
});

btnEnd.addEventListener("click", async () => {
  if (!isGoogleAccount(user) || !sessionData || sessionData.hostUid !== user.uid) return;
  if (!endConfirmationPending) {
    endConfirmationPending = true;
    setNotice("Click Confirm end to stop tracking, download the CSV, and delete the session data.");
    updateControls();
    return;
  }
  endConfirmationPending = false;
  const completed = await runSessionAction(btnEnd, "Ending…", async () => {
    await updateDoc(doc(db, "sessions", meetCode), { status: "ended", endedAt: serverTimestamp() });
    await downloadOrClearEndedSession();
  }, "Could not finish export and cleanup");
  if (completed) setNotice("Attendance CSV saved. Session data has been deleted from Firebase.");
  else {
    endConfirmationPending = false;
    updateControls();
  }
});

btnDownloadAttendance.addEventListener("click", async () => {
  const completed = await runSessionAction(btnDownloadAttendance, "Saving CSV…", downloadOrClearEndedSession, "Could not export attendance");
  if (completed) setNotice("Attendance CSV saved. Session data has been deleted from Firebase.");
});

searchInput.addEventListener("input", (event) => { searchQuery = event.target.value.trim(); renderUI(); });
statusFilter.addEventListener("change", (event) => { currentFilter = event.target.value; renderUI(); });
checkInIntervalSelect.addEventListener("change", async () => {
  selectedCheckInInterval = Number(checkInIntervalSelect.value) || 0;
  if (!sessionData || !user || sessionData.hostUid !== user.uid) return;
  try {
    await updateDoc(doc(db, "sessions", meetCode), {
      checkInIntervalMinutes: selectedCheckInInterval,
      checkInCycleId: crypto.randomUUID(),
      checkInCycleStartedAt: serverTimestamp()
    });
    setNotice(selectedCheckInInterval ? `Activity confirmations requested every ${selectedCheckInInterval} minutes.` : "Activity confirmations are off.");
  } catch (error) {
    showPopupError(`Could not update activity check-ins: ${error.message}`, "session-action", listenToMeeting);
  }
});

requestCheckInButton.addEventListener("click", async () => {
  if (!isGoogleAccount(user) || !sessionData || sessionData.hostUid !== user.uid
    || sessionData.status !== "running" || pendingAction) return;
  const completed = await runSessionAction(requestCheckInButton, "Sending…", () => updateDoc(doc(db, "sessions", meetCode), {
    checkInPromptId: crypto.randomUUID(),
    checkInPromptAt: serverTimestamp(),
  }), "Could not request an activity check-in");
  if (completed) setNotice("Activity check-in sent to participants.");
});

function useActiveTab(tab) {
  const nextMeetCode = getMeetCode(tab?.url);
  activeMeetTabId = tab?.id ?? null;
  if (nextMeetCode === meetCode) {
    refreshHostUiRole(tab?.id);
    return;
  }
  meetCode = nextMeetCode;
  rosterNames = [];
  hostControlsVisible = false;
  listenToMeeting();
  updateControls();
  refreshHostUiRole(tab?.id);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requestHostUiRole(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "in-session:get-host-ui-role" }, (result) => {
      resolve(chrome.runtime.lastError ? null : result);
    });
  });
}

async function refreshHostUiRole(tabId, { retry = false, showResult = false } = {}) {
  const requestId = ++hostDetectionRequestId;
  if (!tabId || !meetCode) {
    hostControlsVisible = false;
    updateControls();
    return;
  }
  let result = null;
  const attempts = retry ? 8 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    result = await requestHostUiRole(tabId);
    if (hostDetectionRequestId !== requestId) return;
    if (result?.inMeeting && result?.hostControlsVisible && result?.meetCode === meetCode) break;
    if (attempt + 1 < attempts) await wait(400);
  }
  if (hostDetectionRequestId !== requestId) return;
  hostControlsVisible = Boolean(result?.inMeeting && result?.hostControlsVisible && result?.meetCode === meetCode);
  rosterNames = hostControlsVisible && Array.isArray(result?.participantNames) ? result.participantNames : [];
  void resolvePendingHostTransfer();
  updateControls();
  renderUI();
  if (showResult && !hostControlsVisible) {
    setParticipantNotice("Host controls still not detected", result
      ? "Open Host controls in Google Meet, then refresh here. If you just loaded the extension, reload the Meet tab first."
      : "The extension could not reach this Meet tab. Reload the Meet tab and try again.");
  } else if (showResult && hostControlsVisible && !isGoogleAccount(user)) {
    setParticipantNotice("Instructor sign-in", "Meet host controls were detected. Sign in with Google to manage attendance.");
  }
}

async function refreshHostDetection() {
  if (refreshHostDetectionButton.disabled) return;
  refreshHostDetectionButton.disabled = true;
  refreshHostDetectionButton.textContent = "Checking Meet controls…";
  setParticipantNotice("Checking Meet host controls…", "Looking for the host controls in your current meeting.");
  chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
    const tabMeetCode = getMeetCode(tab?.url);
    if (!tab || tabMeetCode !== meetCode) {
      hostControlsVisible = false;
      updateControls();
      setParticipantNotice("Open the meeting tab", "Switch to your active Google Meet tab, then refresh host detection.");
    } else {
      await refreshHostUiRole(tab.id, { retry: true, showResult: true });
    }
    refreshHostDetectionButton.disabled = false;
    refreshHostDetectionButton.textContent = "Refresh host detection";
  });
}

refreshHostDetectionButton.addEventListener("click", refreshHostDetection);

function refreshActiveTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => useActiveTab(tab));
}

refreshActiveTab();
chrome.tabs.onActivated.addListener(refreshActiveTab);
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.active && (changeInfo.url || changeInfo.status === "complete")) refreshActiveTab();
});

chrome.storage.local.get("participantUid", ({ participantUid }) => {
  localParticipantUid = participantUid ?? null;
  if (user && meetCode) listenToMeeting();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.participantUid) return;
  localParticipantUid = changes.participantUid.newValue ?? null;
  if (user && meetCode) listenToMeeting();
});

onAuthStateChanged(auth, (signedInUser) => {
  user = signedInUser;
  if (!authStateInitialized) {
    authStateInitialized = true;
    resolveAuthStateInitialized();
  }
  if (user) clearPopupError("participant-auth");
  if (isGoogleAccount(user)) chrome.storage.local.set({ hostUid: user.uid });
  listenToMeeting();
  updateControls();
});
