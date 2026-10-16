import { onAuthStateChanged, signInAnonymously } from "firebase/auth/web-extension";
import { doc, getDoc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { auth, db } from "../shared/firebase.js";

const MEET_UI = Object.freeze({
  leaveControls: 'button[aria-label], [role="button"][aria-label]',
  leaveLabels: [/^leave call$/i, /^leave meeting$/i],
  hostControls: 'button[aria-label], button[title], button[data-tooltip], [role="button"][aria-label], [role="button"][title], [role="button"][data-tooltip]',
  hostControlLabel: /\b(?:host controls?|meeting controls?|host management|meeting safety)\b/i,
  googleAccount: '[aria-label*="Google Account:" i]',
  selfName: "[data-self-name]",
  participantRows: '[role="listitem"]',
  youLabel: /\(You\)/i
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
let stopSessionListener = null;
let meetingActive = false;
let meetingContextTimer = null;
let leaveConfirmationTimer = null;
let heartbeatTimer = null;
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

function readMeetCode() {
  if (location.hostname !== "meet.google.com") return null;
  return location.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\/|$)/i)?.[1] ?? null;
}

function isInMeeting() {
  if (!meetCode) return false;
  const leaveControl = Array.from(document.querySelectorAll(MEET_UI.leaveControls)).find((control) => {
    const label = control.getAttribute("aria-label")?.trim() ?? "";
    return MEET_UI.leaveLabels.some((pattern) => pattern.test(label));
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
  const account = document.querySelector(MEET_UI.googleAccount)?.getAttribute("aria-label") ?? "";
  const accountMatch = account.match(/Google Account:\s*([^,(]+)/i);
  if (isCleanName(accountMatch?.[1])) return accountMatch[1].trim();
  const self = document.querySelector(MEET_UI.selfName)?.getAttribute("data-self-name");
  if (isCleanName(self)) return self.trim();
  const you = Array.from(document.querySelectorAll(MEET_UI.participantRows))
    .find((el) => MEET_UI.youLabel.test(el.textContent ?? ""));
  const text = you?.textContent?.replace(/\s*\(You\)/gi, "").trim();
  return isCleanName(text) ? text : auth.currentUser?.displayName || null;
}

function removeTrackingNotice() {
  privacyNoticeHost?.remove();
  privacyNoticeHost = null;
}

function renderTrackingNotice() {
  const isHost = Boolean(session?.hostUid && (session.hostUid === currentUid || session.hostUid === storedHostUid));
  if (!meetingActive || session?.status !== "running" || !currentUid || isHost) {
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
        details { margin-top: 5px; }
        summary { width: fit-content; color: #315c7d; cursor: pointer; font-size: 12px; }
        p { margin: 6px 0 0; }
        @media (prefers-reduced-motion: no-preference) { .notice { animation: enter 180ms ease-out; } @keyframes enter { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } } }
      </style>
      <section class="notice" role="status" aria-live="polite">
        <div class="heading"><span class="dot" aria-hidden="true"></span><span>InSession attendance tracking is on</span></div>
        <details>
          <summary>What is shared?</summary>
          <p>The session host can see your Meet display name, whether this Meet tab is Active or Away, and when your status was last updated. InSession checks this Meet tab only; it does not read your audio or video.</p>
          <p>Tracking runs only while the host's session is running. When the host ends the session, attendance is downloaded as a CSV and the session records are deleted from Firebase after the download completes. If the download or cleanup fails, the host can retry.</p>
        </details>
      </section>`;
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
  session = null;
  currentRunId = null;
  lastStatus = null;
  lastHeartbeatAt = 0;
  if (awayTimer !== null) {
    clearTimeout(awayTimer);
    awayTimer = null;
  }
  renderTrackingNotice();
  if (!meetCode || !currentUid || !meetingActive) return;
  stopSessionListener = onSnapshot(doc(db, "sessions", meetCode), (snapshot) => {
    session = snapshot.exists() ? snapshot.data() : null;
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
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      durationStatus = null;
      durationLastReportedAt = null;
      lastStatus = null;
      return;
    }
    if (heartbeatTimer === null) {
      heartbeatTimer = setInterval(() => scheduleStatusReport(true), HEARTBEAT_MS);
    }
    scheduleStatusReport();
  }, (error) => console.error("[InSession] Session listener failed:", error));
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

function reportStatus(forceHeartbeat = false, statusOverride = null) {
  const report = statusWriteQueue.then(() => writeStatus(forceHeartbeat, statusOverride));
  statusWriteQueue = report.catch((error) => console.error("[InSession] Status report failed:", error));
  return report;
}

async function writeStatus(forceHeartbeat = false, statusOverride = null) {
  if (!currentUid || !meetingActive || !session || session.status !== "running"
    || session.hostUid === currentUid || session.hostUid === storedHostUid) return;
  const name = findMyName();
  if (name) currentName = name;
  const status = statusOverride ?? getCurrentStatus();
  const reportRunId = currentRunId;
  await ensureDurationState(Date.now());
  if (!meetingActive || !session || session.status !== "running" || currentRunId !== reportRunId) return;
  const now = Date.now();
  if (!forceHeartbeat && status === lastStatus && now - lastHeartbeatAt < 30000) return;
  let nextActiveDurationMs = activeDurationMs;
  let nextAwayDurationMs = awayDurationMs;
  if (durationStatus && durationLastReportedAt !== null) {
    const elapsedMs = Math.max(0, Math.min(now - durationLastReportedAt, DURATION_STALE_AFTER_MS));
    if (durationStatus === "active") nextActiveDurationMs += elapsedMs;
    if (durationStatus === "away") nextAwayDurationMs += elapsedMs;
  }
  try {
    await setDoc(doc(db, "sessions", meetCode, "students", currentUid), {
      uid: currentUid,
      name: currentName || "Meet participant",
      status,
      runId: reportRunId,
      activeDurationMs: nextActiveDurationMs,
      awayDurationMs: nextAwayDurationMs,
      lastSeen: serverTimestamp()
    }, { merge: true });
    activeDurationMs = nextActiveDurationMs;
    awayDurationMs = nextAwayDurationMs;
    durationStatus = ["active", "away"].includes(status) ? status : null;
    durationLastReportedAt = durationStatus ? now : null;
    lastStatus = status;
    lastHeartbeatAt = now;
  } catch (error) {
    console.error("[InSession] Status sync failed:", error);
  }
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
    catch (error) { console.error("[InSession] Anonymous sign-in failed:", error); }
    return;
  }
  currentUid = user.uid;
  if (user.displayName) currentName = user.displayName;
  listenForSession();
});

chrome.storage.local.get("hostUid", ({ hostUid }) => {
  storedHostUid = hostUid ?? null;
  renderTrackingNotice();
  if (session?.status === "running" && session.hostUid === storedHostUid) lastStatus = null;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.hostUid) return;
  storedHostUid = changes.hostUid.newValue ?? null;
  renderTrackingNotice();
  if (session?.hostUid === storedHostUid) lastStatus = null;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "in-session:get-host-ui-role") return;
  sendResponse({
    meetCode: readMeetCode(),
    inMeeting: isInMeeting(),
    hostControlsVisible: isInMeeting() && hasMeetHostControls()
  });
});

meetCode = readMeetCode();
meetingActive = Boolean(meetCode && isInMeeting());
const routeObserver = new MutationObserver(scheduleMeetingContextCheck);
routeObserver.observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener("visibilitychange", () => scheduleStatusReport(true));
window.addEventListener("focus", () => scheduleStatusReport(true));
window.addEventListener("blur", () => scheduleStatusReport(true));
window.addEventListener("pagehide", () => {
  if (awayTimer !== null) clearTimeout(awayTimer);
  awayTimer = null;
  void reportStatus(true, "left");
});
window.addEventListener("pageshow", () => scheduleStatusReport(true));
console.info("[InSession] Authenticated tracker ready.");
