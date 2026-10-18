import { onAuthStateChanged, signInAnonymously } from "firebase/auth/web-extension";
import { deleteDoc, doc, getDoc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { auth, db } from "../shared/firebase.js";

const MEET_UI = Object.freeze({
  leaveControls: 'button[aria-label], [role="button"][aria-label]',
  leaveLabels: Object.freeze({
    en: [/^leave call$/i, /^leave meeting$/i],
    de: [/^anruf verlassen$/i, /^meeting verlassen$/i],
    es: [/^salir de la llamada$/i, /^salir de la reunión$/i],
    fil: [/^umalis sa tawag$/i],
    fr: [/^quitter l'appel$/i, /^quitter la réunion$/i],
    it: [/^abbandona la chiamata$/i, /^esci dalla riunione$/i],
    ja: [/^通話から退出$/i, /^会議から退出$/i],
    ko: [/^통화 나가기$/i, /^회의 나가기$/i],
    pt: [/^sair da chamada$/i, /^sair da reunião$/i],
    zh: [/^退出通话$/, /^退出会议$/]
  }),
  hostControls: 'button[aria-label], button[title], button[data-tooltip], [role="button"][aria-label], [role="button"][title], [role="button"][data-tooltip]',
  hostControlLabel: /\b(?:host controls?|meeting controls?|host management|meeting safety)\b/i,
  googleAccount: '[aria-label*="Google Account:" i]',
  selfName: "[data-self-name]",
  participantRows: '[role="listitem"]',
  youLabel: /(?:\(\s*You\s*\)|(?:^|[\s,])You(?:$|[\s,]))/i
});
const AWAY_DEBOUNCE_MS = 5000;
const HEARTBEAT_MS = 30000;
const DURATION_STALE_AFTER_MS = 60000;
let meetCode = null;
let session = null;
let currentRunId = null;
let currentUid = null;
let currentName = null;
let storedHostUid = null;
let storedHostUidLoaded = false;
let stopSessionListener = null;
let meetingActive = false;
let meetingContextTimer = null;
let leaveConfirmationTimer = null;
let heartbeatTimer = null;
let checkInTimer = null;
let rosterUpdateTimer = null;
let durationLoadedRunId = null;
let durationLoadPromise = null;
let activeDurationMs = 0;
let awayDurationMs = 0;
let durationStatus = null;
let durationLastReportedAt = null;
let statusWriteQueue = Promise.resolve();
let lastStatus = null;
let lastHeartbeatAt = 0;
let awayTimer = null;
let privacyNoticeHost = null;
let activityCheckInHost = null;
let activityCheckInButton = null;
let activityCheckInError = null;
let activityCheckInRequest = null;
let privacyNoticeDismissalLoaded = false;
let privacyNoticeDismissedRun = null;
let checkInAck = null;

function getParticipantRoster() {
  const names = new Map();
  const ownName = normalizeParticipantName(findMyName());
  for (const row of document.querySelectorAll(MEET_UI.participantRows)) {
    if (isSelfParticipantRow(row)) continue;
    const name = getParticipantRowName(row);
    if (!name || name.length > 80) continue;
    if (ownName && normalizeParticipantName(name) === ownName) continue;
    names.set(normalizeParticipantName(name), name);
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b));
}

function participantRowAccessibleText(row) {
  return Array.from(row.querySelectorAll("[aria-label], [title], [data-tooltip]"))
    .map((element) => ["aria-label", "title", "data-tooltip"]
      .map((attribute) => element.getAttribute(attribute) || "")
      .filter(Boolean)
      .join(" "));
}

function isSelfParticipantRow(row) {
  if (row.matches('[data-is-self="true"], [data-self="true"]')) return true;
  const text = [row.innerText || row.textContent || "", ...participantRowAccessibleText(row)]
    .join(" ")
    .replace(/You can't unmute someone else/gi, " ");
  return MEET_UI.youLabel.test(text);
}

function getParticipantRowName(row) {
  const accessibleText = participantRowAccessibleText(row);
  const text = [row.innerText || row.textContent || "", ...accessibleText].join("\n");
  const lines = text.split(/\r?\n/).map((line) => line
    .replace(/You can't unmute someone else/gi, " ")
    .replace(/domain_disabled/gi, " ")
    .replace(/Visitor/gi, " ")
    .replace(/\bMore actions?\b/gi, " ")
    .replace(/more_vert/gi, " ")
    .replace(/devices?/gi, " ")
    .replace(/\bactions?\b/gi, " ")
    .replace(/\(\s*You\s*\)/gi, " ")
    .replace(/\bYou\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim())
    .filter((line) => isCleanName(line) && !/^meet(?:ing)? participant$/i.test(line));
  return lines[0] ?? "";
}

function normalizeParticipantName(name) {
  return String(name || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function publishParticipantRoster() {
  if (!meetingActive || !hasMeetHostControls()) return;
  chrome.runtime.sendMessage({ type: "in-session:roster-update", meetCode, participantNames: getParticipantRoster() }, () => { void chrome.runtime.lastError; });
}

function scheduleRosterUpdate() {
  if (rosterUpdateTimer !== null) return;
  rosterUpdateTimer = setTimeout(() => {
    rosterUpdateTimer = null;
    publishParticipantRoster();
  }, 750);
}

function currentCheckInRound(now = Date.now()) {
  const interval = Number(session?.checkInIntervalMinutes);
  if (!Number.isFinite(interval) || interval <= 0 || session?.status !== "running") return 0;
  const cycleStartedAt = timestampMillis(session.checkInCycleStartedAt)
    || timestampMillis(session.resumedAt)
    || timestampMillis(session.startedAt);
  if (!Number.isFinite(cycleStartedAt)) return 0;
  const elapsed = now - cycleStartedAt;
  if (elapsed < interval * 60_000) return 0;
  return Math.floor(elapsed / (interval * 60_000));
}

function updateCheckInBadge() {
  const request = getPendingActivityCheckIn();
  renderActivityCheckInPrompt(request);
  const pending = Boolean(request);
  try {
    chrome.runtime.sendMessage({ type: "in-session:check-in-state", meetCode, pending }, () => { void chrome.runtime.lastError; });
  } catch (error) { console.warn("[InSession] Could not update the activity check-in badge:", error); }
}

function getPendingActivityCheckIn() {
  const round = currentCheckInRound();
  const cycleId = session?.checkInCycleId || "";
  const isParticipant = Boolean(meetingActive && currentUid && session?.hostUid !== currentUid && session?.hostUid !== storedHostUid);
  const periodicPending = Boolean(isParticipant && round && cycleId && !(
    checkInAck?.meetCode === meetCode
    && checkInAck?.runId === currentRunId
    && checkInAck?.cycleId === cycleId
    && checkInAck?.round === round
  ));
  const instantPending = Boolean(isParticipant && session?.status === "running" && session?.checkInPromptId
    && !(checkInAck?.meetCode === meetCode
      && checkInAck?.runId === currentRunId
      && checkInAck?.promptId === session.checkInPromptId));
  if (!periodicPending && !instantPending) return null;
  return instantPending
    ? { promptId: session.checkInPromptId, runId: currentRunId }
    : { round, cycleId, runId: currentRunId };
}

function removeActivityCheckInPrompt() {
  activityCheckInHost?.remove();
  activityCheckInHost = null;
  activityCheckInButton = null;
  activityCheckInError = null;
  activityCheckInRequest = null;
}

function renderActivityCheckInPrompt(request) {
  if (!request) {
    removeActivityCheckInPrompt();
    return;
  }
  const requestKey = request.promptId || `${request.cycleId}:${request.round}`;
  if (!activityCheckInHost?.isConnected) {
    activityCheckInHost = document.createElement("div");
    activityCheckInHost.id = "insession-activity-check-in";
    activityCheckInHost.setAttribute("aria-label", "InSession activity check-in");
    const shadow = activityCheckInHost.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; position: fixed; z-index: 2147483647; top: 76px; left: 50%; transform: translateX(-50%); width: min(370px, calc(100vw - 24px)); color: #17324d; font: 14px/1.45 Arial, sans-serif; pointer-events: none; }
        .card { box-sizing: border-box; padding: 16px; border: 1px solid #d7a33a; border-top: 4px solid #d28a20; border-radius: 12px; background: #fffdf5; box-shadow: 0 8px 28px #102a4340; pointer-events: auto; }
        .eyebrow { margin-bottom: 3px; color: #805511; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
        h2 { margin: 0; color: #263844; font: 700 17px/1.3 Arial, sans-serif; }
        p { margin: 6px 0 12px; color: #536078; }
        button { min-height: 40px; width: 100%; border: 0; border-radius: 8px; background: #16776c; color: #fff; font: 700 14px Arial, sans-serif; cursor: pointer; }
        button:hover:not(:disabled) { background: #0f6259; }
        button:focus-visible { outline: 3px solid #6a9bd2; outline-offset: 2px; }
        button:disabled { cursor: wait; opacity: .7; }
        .error { margin: 9px 0 0; color: #a4313b; font-size: 12px; }
        @media (prefers-reduced-motion: no-preference) { .card { animation: enter 180ms ease-out; } @keyframes enter { from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; transform: translateY(0); } } }
      </style>
      <section class="card" role="alert" aria-live="assertive">
        <div class="eyebrow">InSession activity check</div>
        <h2>Are you here?</h2>
        <p>Your instructor asked you to confirm your activity.</p>
        <button type="button">I'm here</button>
        <p class="error" role="status" hidden></p>
      </section>`;
    activityCheckInButton = shadow.querySelector("button");
    activityCheckInError = shadow.querySelector(".error");
    activityCheckInButton.addEventListener("click", async () => {
      if (!activityCheckInRequest || activityCheckInButton.disabled) return;
      activityCheckInButton.disabled = true;
      activityCheckInButton.textContent = "Sending…";
      activityCheckInError.hidden = true;
      try {
        await submitActivityCheckIn(activityCheckInRequest);
      } catch (error) {
        activityCheckInError.textContent = error.message || "Could not confirm activity. Try again.";
        activityCheckInError.hidden = false;
        activityCheckInButton.disabled = false;
        activityCheckInButton.textContent = "Try again";
        updateCheckInBadge();
      }
    });
    (document.body || document.documentElement).appendChild(activityCheckInHost);
  }
  if (activityCheckInHost.dataset.requestKey !== requestKey) {
    activityCheckInHost.dataset.requestKey = requestKey;
    activityCheckInButton.disabled = false;
    activityCheckInButton.textContent = "I'm here";
    activityCheckInError.hidden = true;
  }
  activityCheckInRequest = request;
}

function reportExtensionError(source, error, retryAction = null) {
  const message = error?.message || String(error || "Unknown error");
  console.error(`[InSession] ${source} failed:`, error);
  try {
    chrome.runtime.sendMessage({ type: "in-session:report-error", source, message, retryAction }, () => {
      void chrome.runtime.lastError;
    });
  } catch (sendError) { console.warn("[InSession] Could not report the error to the extension:", sendError); }
}

function clearExtensionError(source) {
  try {
    chrome.runtime.sendMessage({ type: "in-session:clear-error", source }, () => {
      void chrome.runtime.lastError;
    });
  } catch (error) { console.warn("[InSession] Could not clear the extension error badge:", error); }
}

function readMeetCode() {
  if (location.hostname !== "meet.google.com") return null;
  return location.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\/|$)/i)?.[1] ?? null;
}

function isInMeeting() {
  if (!meetCode) return false;
  const language = (document.documentElement.lang || navigator.language || "en").toLowerCase().split("-")[0];
  const labels = MEET_UI.leaveLabels[language] ?? MEET_UI.leaveLabels.en;
  const leaveControl = Array.from(document.querySelectorAll(MEET_UI.leaveControls)).find((control) => {
    const label = control.getAttribute("aria-label")?.trim() ?? "";
    return labels.some((pattern) => pattern.test(label));
  });
  return Boolean(leaveControl);
}

function hasMeetHostControls() {
  // Google Meet exposes host-only controls through an accessible label or
  // tooltip. This is a UI signal, not a security boundary.
  return Array.from(document.querySelectorAll(MEET_UI.hostControls))
    .some((control) => ["aria-label", "title", "data-tooltip"]
      .some((attribute) => MEET_UI.hostControlLabel.test(control.getAttribute(attribute) ?? "")));
}

function isCleanName(value) {
  const name = value?.trim();
  return Boolean(name && name.length >= 2 && name.length <= 80);
}

function findMyName() {
  const self = document.querySelector(MEET_UI.selfName)?.getAttribute("data-self-name");
  if (isCleanName(self)) return self.trim();
  const you = Array.from(document.querySelectorAll(MEET_UI.participantRows))
    .find(isSelfParticipantRow);
  const text = you ? getParticipantRowName(you) : null;
  if (isCleanName(text)) return text;
  const account = document.querySelector(MEET_UI.googleAccount)?.getAttribute("aria-label") ?? "";
  const accountMatch = account.match(/Google Account:\s*([^,(]+)/i);
  if (isCleanName(accountMatch?.[1])) return accountMatch[1].trim();
  return auth.currentUser?.displayName || null;
}

function removeTrackingNotice() {
  privacyNoticeHost?.remove();
  privacyNoticeHost = null;
}

function dismissTrackingNotice() {
  privacyNoticeDismissedRun = `${meetCode}:${session?.runId || ""}`;
  chrome.storage.local.set({ privacyNoticeDismissedRun });
  removeTrackingNotice();
}

function removeLocalHostAttendanceRecord() {
  if (!meetCode || !currentUid || !session?.hostUid
    || (session.hostUid !== storedHostUid && session.hostUid !== currentUid)) return;
  void deleteDoc(doc(db, "sessions", meetCode, "students", currentUid))
    .catch((error) => console.warn("[InSession] Could not remove this host's participant record:", error));
}

function renderTrackingNotice() {
  const isHost = Boolean(session?.hostUid && (session.hostUid === currentUid || session.hostUid === storedHostUid));
  if (!meetingActive || session?.status !== "running" || !currentUid || isHost) {
    removeTrackingNotice();
    return;
  }
  const runKey = `${meetCode}:${session?.runId || ""}`;
  if (!privacyNoticeDismissalLoaded) return;
  if (privacyNoticeDismissedRun === runKey) {
    removeTrackingNotice();
    return;
  }

  if (!privacyNoticeHost?.isConnected) {
    privacyNoticeHost = document.createElement("div");
    privacyNoticeHost.id = "insession-tracking-notice";
    privacyNoticeHost.setAttribute("aria-label", "InSession attendance tracking notice");
    const shadow = privacyNoticeHost.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; position: fixed; z-index: 2147483647; top: 12px; left: 50%; transform: translateX(-50%); width: min(430px, calc(100vw - 28px)); color: #17324d; font: 13px/1.45 Arial, sans-serif; }
        .notice { box-sizing: border-box; padding: 10px 14px; border: 1px solid #cbd9e5; border-radius: 10px; background: #fff; box-shadow: 0 3px 14px #102a4330; }
        .heading { display: flex; align-items: center; gap: 8px; font-weight: 700; }
        .dot { width: 8px; height: 8px; flex: 0 0 8px; border-radius: 50%; background: #d28a20; }
        .dismiss { margin-left: auto; padding: 0 3px; border: 0; background: transparent; color: #496170; cursor: pointer; font: 20px/1 Arial, sans-serif; }
        details { margin-top: 5px; }
        summary { width: fit-content; color: #315c7d; cursor: pointer; font-size: 12px; }
        p { margin: 6px 0 0; }
        @media (prefers-reduced-motion: no-preference) { .notice { animation: enter 180ms ease-out; } @keyframes enter { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } } }
      </style>
      <section class="notice" role="status" aria-live="polite">
        <div class="heading"><span class="dot" aria-hidden="true"></span><span>InSession attendance tracking is on</span><button class="dismiss" type="button" aria-label="Dismiss InSession notice" title="Dismiss">×</button></div>
        <details>
          <summary>What is shared?</summary>
          <p>The session host can see your Meet display name, whether this Meet tab is Active or Away, and when your status was last updated. The host may also request a periodic or instant one-click activity confirmation; the response time is shared with the host. InSession checks this Meet tab only; it does not read your audio or video.</p>
          <p>Tracking runs only while the host's session is running. When the host ends the session, attendance is downloaded as a CSV and the session records are deleted from Firebase after the download completes. If the download or cleanup fails, the host can retry.</p>
        </details>
      </section>`;
    shadow.querySelector(".dismiss").addEventListener("click", dismissTrackingNotice);
    (document.body || document.documentElement).appendChild(privacyNoticeHost);
  }
}

function listenForSession() {
  stopSessionListener?.();
  stopSessionListener = null;
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (checkInTimer !== null) {
    clearInterval(checkInTimer);
    checkInTimer = null;
  }
  session = null;
  currentRunId = null;
  lastStatus = null;
  lastHeartbeatAt = 0;
  if (awayTimer !== null) {
    clearTimeout(awayTimer);
    awayTimer = null;
  }
  renderTrackingNotice();
  updateCheckInBadge();
  if (!meetCode || !currentUid || !meetingActive) return;
  stopSessionListener = onSnapshot(doc(db, "sessions", meetCode), (snapshot) => {
    clearExtensionError("participant-session");
    session = snapshot.exists() ? snapshot.data() : null;
    chrome.storage.local.get("activityCheckInAcks", ({ activityCheckInAcks }) => {
      checkInAck = activityCheckInAcks?.[meetCode] ?? null;
      updateCheckInBadge();
    });
    const nextRunId = session?.runId ?? null;
    if (nextRunId !== currentRunId) {
      currentRunId = nextRunId;
      durationLoadedRunId = null;
      durationLoadPromise = null;
      activeDurationMs = 0;
      awayDurationMs = 0;
      durationStatus = null;
      durationLastReportedAt = null;
      lastStatus = null;
      lastHeartbeatAt = 0;
    }
    renderTrackingNotice();
    if (session?.status !== "running" || session.hostUid === currentUid || session.hostUid === storedHostUid) {
      removeLocalHostAttendanceRecord();
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      durationStatus = null;
      durationLastReportedAt = null;
      lastStatus = null;
      if (checkInTimer !== null) {
        clearInterval(checkInTimer);
        checkInTimer = null;
      }
      updateCheckInBadge();
      return;
    }
    if (Number(session.checkInIntervalMinutes) > 0 && checkInTimer === null) {
      checkInTimer = setInterval(updateCheckInBadge, 10_000);
    } else if (Number(session.checkInIntervalMinutes) <= 0 && checkInTimer !== null) {
      clearInterval(checkInTimer);
      checkInTimer = null;
    }
    updateCheckInBadge();
    if (heartbeatTimer === null) {
      heartbeatTimer = setInterval(() => scheduleStatusReport(true), HEARTBEAT_MS);
    }
    scheduleStatusReport();
  }, (error) => reportExtensionError("participant-session", error, "session"));
}

function getCurrentStatus() {
  return !document.hidden && document.hasFocus() ? "active" : "away";
}

function scheduleStatusReport(forceHeartbeat = false) {
  if (!meetingActive) return;
  const status = getCurrentStatus();
  if (status === "away" && lastStatus !== "away") {
    if (awayTimer === null) {
      awayTimer = setTimeout(() => {
        awayTimer = null;
        if (getCurrentStatus() === "away") void reportStatus(true);
      }, AWAY_DEBOUNCE_MS);
    }
    return;
  }

  if (awayTimer !== null) {
    clearTimeout(awayTimer);
    awayTimer = null;
  }
  void reportStatus(forceHeartbeat);
}

function timestampMillis(value) {
  return typeof value?.toMillis === "function" ? value.toMillis()
    : value instanceof Date ? value.getTime()
      : Number.NaN;
}

async function ensureDurationState(now) {
  const runId = currentRunId;
  if (!runId || durationLoadedRunId === runId) return;
  if (!durationLoadPromise) {
    durationLoadPromise = (async () => {
      const snapshot = await getDoc(doc(db, "sessions", meetCode, "students", currentUid));
      if (currentRunId !== runId) return;
      if (snapshot.exists()) {
        const previous = snapshot.data();
        if (previous.runId === runId) {
          activeDurationMs = Number(previous.activeDurationMs) || 0;
          awayDurationMs = Number(previous.awayDurationMs) || 0;
          const lastSeenMs = timestampMillis(previous.lastSeen);
          const resumedAtMs = timestampMillis(session?.resumedAt) || timestampMillis(session?.startedAt);
          const since = Math.max(lastSeenMs || now, resumedAtMs || 0, now - DURATION_STALE_AFTER_MS);
          const unreportedMs = Math.max(0, now - since);
          if (previous.status === "active") activeDurationMs += unreportedMs;
          if (previous.status === "away") awayDurationMs += unreportedMs;
        }
      }
      durationStatus = null;
      durationLastReportedAt = null;
      durationLoadedRunId = runId;
    })().finally(() => { durationLoadPromise = null; });
  }
  await durationLoadPromise;
}

function reportStatus(forceHeartbeat = false, statusOverride = null, additionalFields = {}) {
  const report = statusWriteQueue.then(() => writeStatus(forceHeartbeat, statusOverride, additionalFields));
  statusWriteQueue = report.then((written) => {
    if (written) clearExtensionError("participant-status");
    return written;
  }).catch((error) => {
    reportExtensionError("participant-status", error, "status");
    return false;
  });
  return statusWriteQueue;
}

async function writeStatus(forceHeartbeat = false, statusOverride = null, additionalFields = {}) {
  if (!currentUid || !storedHostUidLoaded || !meetingActive || !session || session.status !== "running"
    || session.hostUid === currentUid || session.hostUid === storedHostUid) return false;
  const name = findMyName();
  if (name) currentName = name;
  const status = statusOverride ?? getCurrentStatus();
  const reportRunId = currentRunId;
  await ensureDurationState(Date.now());
  if (!meetingActive || !session || session.status !== "running" || currentRunId !== reportRunId
    || session.hostUid === currentUid || session.hostUid === storedHostUid) return false;
  const now = Date.now();
  if (!forceHeartbeat && status === lastStatus && now - lastHeartbeatAt < 30000) return false;
  let nextActiveDurationMs = activeDurationMs;
  let nextAwayDurationMs = awayDurationMs;
  if (durationStatus && durationLastReportedAt !== null) {
    const elapsedMs = Math.max(0, Math.min(now - durationLastReportedAt, DURATION_STALE_AFTER_MS));
    if (durationStatus === "active") nextActiveDurationMs += elapsedMs;
    if (durationStatus === "away") nextAwayDurationMs += elapsedMs;
  }
  await setDoc(doc(db, "sessions", meetCode, "students", currentUid), {
    uid: currentUid,
    name: currentName || "Meet participant",
    status,
    runId: reportRunId,
    activeDurationMs: nextActiveDurationMs,
    awayDurationMs: nextAwayDurationMs,
    lastSeen: serverTimestamp(),
    ...additionalFields
  }, { merge: true });
  activeDurationMs = nextActiveDurationMs;
  awayDurationMs = nextAwayDurationMs;
  durationStatus = ["active", "away"].includes(status) ? status : null;
  durationLastReportedAt = durationStatus ? now : null;
  lastStatus = status;
  lastHeartbeatAt = now;
  return true;
}

function syncMeetingContext() {
  const nextCode = readMeetCode();
  const nextMeetingActive = Boolean(nextCode && isInMeeting());
  if (nextCode === meetCode && nextMeetingActive === meetingActive) return;
  if (leaveConfirmationTimer !== null && (nextMeetingActive || nextCode !== meetCode)) {
    clearTimeout(leaveConfirmationTimer);
    leaveConfirmationTimer = null;
  }
  if (meetingActive && nextCode === meetCode && !nextMeetingActive) {
    if (leaveConfirmationTimer === null) {
      const leavingCode = meetCode;
      leaveConfirmationTimer = setTimeout(() => {
        leaveConfirmationTimer = null;
        if (meetCode !== leavingCode || isInMeeting()) {
          scheduleMeetingContextCheck();
          return;
        }
        void reportStatus(true, "left");
        meetingActive = false;
        listenForSession();
      }, 1000);
    }
    return;
  }
  if (meetingActive && nextCode !== meetCode) {
    // Send the final status while the previous meeting code and session are
    // still available. The stale-status timeout remains a fallback if this
    // write is interrupted by a closed browser or lost connection.
    void reportStatus(true, "left");
  }
  if (nextCode !== meetCode) currentName = null;
  meetCode = nextCode;
  meetingActive = nextMeetingActive;
  listenForSession();
}

function scheduleMeetingContextCheck() {
  if (meetingContextTimer !== null) return;
  meetingContextTimer = setTimeout(() => {
    meetingContextTimer = null;
    syncMeetingContext();
  }, 500);
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    try { await signInAnonymously(auth); }
    catch (error) { reportExtensionError("participant-auth", error, "auth"); }
    return;
  }
  clearExtensionError("participant-auth");
  currentUid = user.uid;
  chrome.storage.local.set({ participantUid: currentUid });
  if (user.displayName) currentName = user.displayName;
  listenForSession();
});

chrome.storage.local.get(["hostUid", "privacyNoticeDismissedRun"], ({ hostUid, privacyNoticeDismissedRun: dismissedRun }) => {
  storedHostUid = hostUid ?? null;
  storedHostUidLoaded = true;
  privacyNoticeDismissedRun = dismissedRun ?? null;
  privacyNoticeDismissalLoaded = true;
  renderTrackingNotice();
  updateCheckInBadge();
  listenForSession();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.hostUid) {
    storedHostUid = changes.hostUid.newValue ?? null;
    storedHostUidLoaded = true;
    renderTrackingNotice();
    updateCheckInBadge();
    if (session?.hostUid === storedHostUid) lastStatus = null;
    removeLocalHostAttendanceRecord();
  }
  if (changes.activityCheckInAcks) {
    checkInAck = changes.activityCheckInAcks.newValue?.[meetCode] ?? null;
    updateCheckInBadge();
  }
});

async function submitActivityCheckIn(request) {
  if (!meetCode || !meetingActive || !currentUid) {
    throw new Error("Join the active Google Meet before confirming.");
  }
  const latestSessionSnapshot = await getDoc(doc(db, "sessions", meetCode));
  if (!latestSessionSnapshot.exists()) {
    throw new Error("The host's session is no longer available.");
  }
  const latestSession = latestSessionSnapshot.data();
  if (latestSession.runId !== request.runId) {
    throw new Error("That activity check has expired. Wait for the host to send a new check-in.");
  }
  if (latestSession.runId !== currentRunId) {
    durationLoadedRunId = null;
    durationLoadPromise = null;
    activeDurationMs = 0;
    awayDurationMs = 0;
    durationStatus = null;
    durationLastReportedAt = null;
    lastStatus = null;
    lastHeartbeatAt = 0;
    currentRunId = latestSession.runId;
  }
  session = latestSession;
  const round = currentCheckInRound();
  const cycleId = session.checkInCycleId || "";
  const promptId = request.promptId;
  const instantPromptMatches = Boolean(promptId && session.status === "running" && session.checkInPromptId === promptId);
  const periodicCheckInMatches = Boolean(!promptId && round && round === request.round && cycleId
    && cycleId === request.cycleId);
  if (session.status !== "running" || session.hostUid === currentUid || session.hostUid === storedHostUid
    || (!instantPromptMatches && !periodicCheckInMatches)) {
    throw new Error("That activity check has expired. Wait for the host to send a new check-in.");
  }
  const responseFields = instantPromptMatches
    ? {
        checkInPromptId: promptId,
        ...(round && cycleId ? { checkInCycleId: cycleId, checkInRound: round } : {}),
        checkInAt: serverTimestamp(),
      }
    : { checkInRound: round, checkInCycleId: cycleId, checkInAt: serverTimestamp() };
  const ok = await reportStatus(true, lastStatus ?? getCurrentStatus(), responseFields);
  if (!ok) throw new Error("Your activity confirmation could not be saved.");
  const stored = await chrome.storage.local.get("activityCheckInAcks");
  const checkInAcks = stored.activityCheckInAcks ?? {};
  const priorAck = checkInAcks[meetCode];
  checkInAck = {
    ...(priorAck?.runId === currentRunId ? priorAck : {}),
    meetCode,
    runId: currentRunId,
    ...(instantPromptMatches ? { promptId, ...(round && cycleId ? { cycleId, round } : {}) } : { cycleId, round }),
  };
  checkInAcks[meetCode] = checkInAck;
  await chrome.storage.local.set({ activityCheckInAcks: checkInAcks });
  updateCheckInBadge();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "in-session:get-host-ui-role") {
    const inMeeting = isInMeeting();
    sendResponse({ meetCode: readMeetCode(), inMeeting, hostControlsVisible: inMeeting && hasMeetHostControls(), participantNames: inMeeting && hasMeetHostControls() ? getParticipantRoster() : [] });
    return;
  }
  if (message?.type !== "in-session:retry") return;
  if (message.action === "status") {
    void reportStatus(true).then((ok) => sendResponse({ ok, message: ok ? "" : "Attendance is not currently being tracked." }));
    return true;
  }
  if (message.action === "session") {
    listenForSession();
    sendResponse({ ok: true });
    return;
  }
  if (message.action === "check-in") {
    void submitActivityCheckIn(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }
  if (message.action === "auth") {
    void signInAnonymously(auth).then(() => sendResponse({ ok: true }), (error) => {
      reportExtensionError("participant-auth", error, "auth");
      sendResponse({ ok: false, message: error.message });
    });
    return true;
  }
});

meetCode = readMeetCode();
meetingActive = Boolean(meetCode && isInMeeting());
const routeObserver = new MutationObserver(() => {
  scheduleMeetingContextCheck();
  scheduleRosterUpdate();
});
routeObserver.observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener("visibilitychange", () => scheduleStatusReport(true));
window.addEventListener("focus", () => scheduleStatusReport(true));
window.addEventListener("blur", () => scheduleStatusReport(true));
window.addEventListener("pagehide", () => {
  if (awayTimer !== null) clearTimeout(awayTimer);
  awayTimer = null;
  chrome.runtime.sendMessage({ type: "in-session:check-in-state", meetCode, pending: false }, () => { void chrome.runtime.lastError; });
  void reportStatus(true, "left");
});
window.addEventListener("pageshow", () => scheduleStatusReport(true));
console.info("[InSession] Authenticated tracker ready.");
