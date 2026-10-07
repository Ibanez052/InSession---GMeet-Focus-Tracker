// --- CONFIGURATION ---
const FIREBASE_PROJECT_ID = "insession-extension";
const FIRESTORE_API_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/students`;
const SESSION_API_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/session/current`;

let cachedMyName = null;
let isSessionRunning = false;
let lastReportedStatus = null;

const UI_BLACKLIST = [
  "join now",
  "ask to join",
  "backgrounds and effects",
  "meeting details",
  "people",
  "chat",
  "activities",
  "host controls",
  "pin",
  "mute",
  "mic",
  "mic_off",
  "videocam",
  "videocam_off",
  "more options",
  "more_vert",
  "turn off",
  "turn on",
  "raise hand",
  "hand raises",
  "frame_person",
  "leave call",
  "others might still see your full video",
  "admit",
  "deny",
  "devices",
  "device",
  "audio",
  "video",
  "paired",
  "in call",
  "contributors",
  "waiting to join",
  "entry request"
];

function isCleanName(text) {
  if (!text || text.length < 2 || text.length > 50) return false;
  if (/^\d{1,2}:\d{2}/.test(text)) return false;
  const lower = text.toLowerCase().trim();
  return !UI_BLACKLIST.some(bad => lower === bad || lower.includes(bad));
}

function isInMeeting() {
  return document.querySelector('button[aria-label*="leave" i], button[aria-label*="call" i], [data-call-ended]') !== null;
}

// 1. Multi-Account Identity Resolution
function getMyName() {
  if (cachedMyName) return cachedMyName;
  if (!isInMeeting()) return null;

  // Method A: Check top right Google Account profile icon in Meet
  const accountBtn = document.querySelector('a[aria-label*="Google Account:" i], button[aria-label*="Google Account:" i]');
  if (accountBtn) {
    const label = accountBtn.getAttribute('aria-label') || '';
    const match = label.match(/Google Account:\s*([^(]+)/i);
    if (match && match[1]) {
      const clean = match[1].trim();
      if (isCleanName(clean)) {
        cachedMyName = clean;
        return cachedMyName;
      }
    }
  }

  // Method B: Check People Panel list items for "(You)"
  const listItems = Array.from(document.querySelectorAll('div[role="listitem"]'));
  for (const item of listItems) {
    const raw = item.textContent || "";
    if (raw.includes("(You)")) {
      const spans = Array.from(item.querySelectorAll("span")).map(s => s.textContent.trim());
      for (const s of spans) {
        if (s.includes("(You)")) {
          const cleaned = s.replace(/\s*\(You\)/gi, "").trim();
          if (isCleanName(cleaned)) {
            cachedMyName = cleaned;
            return cachedMyName;
          }
        }
      }
    }
  }

  // Method C: Google Meet data-self-name attribute
  const selfAttr = document.querySelector("[data-self-name]");
  if (selfAttr) {
    const val = selfAttr.getAttribute("data-self-name")?.trim();
    if (val && isCleanName(val)) {
      cachedMyName = val;
      return cachedMyName;
    }
  }

  // Method D: Leaf text node explicitly containing "(You)"
  const youLeaf = Array.from(document.querySelectorAll("span, div")).find(el => {
    if (el.children.length > 0) return false;
    const txt = el.textContent.trim();
    return txt.endsWith("(You)") && isCleanName(txt.replace(/\s*\(You\)/gi, "").trim());
  });

  if (youLeaf) {
    const clean = youLeaf.textContent.replace(/\s*\(You\)/gi, "").trim();
    cachedMyName = clean;
    return cachedMyName;
  }

  return null;
}

// 2. Host Scraper: Discovers new participants
async function scrapeAllVisibleParticipants() {
  if (!isSessionRunning || !isInMeeting()) return;

  const myName = getMyName();
  const myClean = myName ? myName.toLowerCase().replace(/[^a-z0-9]/g, "") : "";

  const namesFound = new Set();
  const buttons = document.querySelectorAll('button[aria-label*="options for" i]');
  buttons.forEach(btn => {
    const label = btn.getAttribute("aria-label") || "";
    const match = label.match(/options for\s+(.+)$/i);
    if (match && match[1]) {
      const cleaned = match[1].replace(/\s*\(You\)/gi, "").trim();
      if (isCleanName(cleaned)) {
        namesFound.add(cleaned);
      }
    }
  });

  for (const name of namesFound) {
    const nameClean = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (myClean && nameClean === myClean) continue;

    const safeDocId = name.toLowerCase().replace(/[^a-z0-9]/g, "_");
    const checkUrl = `${FIRESTORE_API_URL}/${safeDocId}`;

    try {
      const res = await fetch(checkUrl);
      if (res.status === 404) {
        const payload = {
          fields: {
            name: { stringValue: name },
            status: { stringValue: "active" },
            lastSeen: { stringValue: new Date().toISOString() }
          }
        };
        await fetch(`${FIRESTORE_API_URL}?documentId=${safeDocId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        console.log(`%c[InSession] Auto-discovered participant: ${name}`, "color: #4b88ff; font-weight: bold;");
      }
    } catch (e) {}
  }
}

// 3. Poll Session Status
async function checkSessionStatus() {
  try {
    const res = await fetch(SESSION_API_URL);
    if (res.ok) {
      const data = await res.json();
      const status = data.fields?.status?.stringValue;
      isSessionRunning = status === "running";

      if (status === "ended") {
        lastReportedStatus = null;
      }
    }
  } catch (err) {}
}
setInterval(checkSessionStatus, 3000);
checkSessionStatus();

// 4. Report Status to Firestore
async function reportMyStatus(status) {
  if (!isInMeeting() || !isSessionRunning) return;
  if (lastReportedStatus === status) return;

  const myName = getMyName();
  if (!myName) return;

  const safeDocId = myName.toLowerCase().replace(/[^a-z0-9]/g, "_");
  const url = `${FIRESTORE_API_URL}/${safeDocId}?updateMask.fieldPaths=name&updateMask.fieldPaths=status&updateMask.fieldPaths=lastSeen`;

  const payload = {
    fields: {
      name: { stringValue: myName },
      status: { stringValue: status },
      lastSeen: { stringValue: new Date().toISOString() }
    }
  };

  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true
    });

    if (res.ok) {
      lastReportedStatus = status;
      console.log(`%c[InSession] Status synced: ${myName} -> ${status.toUpperCase()}`, "color: #00e676; font-weight: bold;");
    }
  } catch (err) {
    console.error("[InSession] Status sync error:", err);
  }
}

// 5. Clean, Direct State Evaluator
function evaluateStatus() {
  if (document.hidden) {
    reportMyStatus("away");
  } else {
    reportMyStatus("active");
  }
}

// Listen to native tab visibility change
document.addEventListener("visibilitychange", evaluateStatus);

// Window focus/blur tracking
window.addEventListener("focus", () => {
  reportMyStatus("active");
});

window.addEventListener("blur", () => {
  // If the user tabs away or clicks outside the window
  reportMyStatus("away");
});

// Regular heartbeat that checks visibility every 2 seconds
setInterval(() => {
  if (isSessionRunning && isInMeeting()) {
    evaluateStatus();
    scrapeAllVisibleParticipants();
  }
}, 2000);

// Kickstart initial check
setTimeout(() => {
  if (isInMeeting()) {
    evaluateStatus();
  }
}, 1500);

console.log("[InSession] Multi-account tracker ready.");