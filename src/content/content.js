import { onAuthStateChanged, signInAnonymously } from "firebase/auth/web-extension";
import { doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { auth, db } from "../shared/firebase.js";

const NAME_BLACKLIST = new Set(["people", "chat", "activities", "host controls", "mute", "leave call", "more options"]);
const AWAY_DEBOUNCE_MS = 5000;
let meetCode = null;
let session = null;
let currentRunId = null;
let currentUid = null;
let currentName = null;
let storedHostUid = null;
let stopSessionListener = null;
let meetingActive = false;
let meetingContextTimer = null;
let lastStatus = null;
let lastHeartbeatAt = 0;
let awayTimer = null;

function readMeetCode() {
  if (location.hostname !== "meet.google.com") return null;
  return location.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\/|$)/i)?.[1] ?? null;
}

function isInMeeting() {
  return Boolean(meetCode && document.querySelector('button[aria-label*="Leave call" i], button[aria-label*="Leave meeting" i]'));
}

function hasMeetHostControls() {
  // Google Meet exposes its host-only controls as a toolbar button. This is a
  // UI signal, not a security boundary; fail closed when the label is absent.
  return Boolean(document.querySelector(
    'button[aria-label*="host controls" i], [role="button"][aria-label*="host controls" i]'
  ));
}

function isCleanName(value) {
  const name = value?.trim();
  return Boolean(name && name.length >= 2 && name.length <= 80 && !NAME_BLACKLIST.has(name.toLowerCase()));
}

function findMyName() {
  const account = document.querySelector('[aria-label*="Google Account:" i]')?.getAttribute("aria-label") ?? "";
  const accountMatch = account.match(/Google Account:\s*([^,(]+)/i);
  if (isCleanName(accountMatch?.[1])) return accountMatch[1].trim();
  const self = document.querySelector("[data-self-name]")?.getAttribute("data-self-name");
  if (isCleanName(self)) return self.trim();
  const you = Array.from(document.querySelectorAll('[role="listitem"]')).find((el) => /\(You\)/i.test(el.textContent ?? ""));
  const text = you?.textContent?.replace(/\s*\(You\)/gi, "").trim();
  return isCleanName(text) ? text : auth.currentUser?.displayName || null;
}

function listenForSession() {
  stopSessionListener?.();
  stopSessionListener = null;
  session = null;
  currentRunId = null;
  lastStatus = null;
  lastHeartbeatAt = 0;
  if (awayTimer !== null) {
    clearTimeout(awayTimer);
    awayTimer = null;
  }
  if (!meetCode || !currentUid || !meetingActive) return;
  stopSessionListener = onSnapshot(doc(db, "sessions", meetCode), (snapshot) => {
    session = snapshot.exists() ? snapshot.data() : null;
    const nextRunId = session?.runId ?? null;
    if (nextRunId !== currentRunId) {
      currentRunId = nextRunId;
      lastStatus = null;
      lastHeartbeatAt = 0;
    }
    if (session?.status !== "running" || session.hostUid === currentUid || session.hostUid === storedHostUid) {
      lastStatus = null;
      return;
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

async function reportStatus(forceHeartbeat = false, statusOverride = null) {
  if (!currentUid || !meetingActive || !session || session.status !== "running"
    || session.hostUid === currentUid || session.hostUid === storedHostUid) return;
  const name = findMyName();
  if (name) currentName = name;
  const status = statusOverride ?? getCurrentStatus();
  const now = Date.now();
  if (!forceHeartbeat && status === lastStatus && now - lastHeartbeatAt < 30000) return;
  try {
    await setDoc(doc(db, "sessions", meetCode, "students", currentUid), {
      uid: currentUid,
      name: currentName || "Meet participant",
      status,
      lastSeen: serverTimestamp()
    }, { merge: true });
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
  if (session?.status === "running" && session.hostUid === storedHostUid) lastStatus = null;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.hostUid) return;
  storedHostUid = changes.hostUid.newValue ?? null;
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
setInterval(() => scheduleStatusReport(true), 30000);
console.info("[InSession] Authenticated tracker ready.");
