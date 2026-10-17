chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .then(() => updateErrorBadge("side-panel-setup", false))
  .catch((error) => {
    console.error("[InSession] Could not configure the side panel:", error);
    updateErrorBadge("side-panel-setup", true);
  });

const ERRORS_KEY = "inSessionErrors";
const CHECK_IN_KEY = "activityCheckInPending";
let badgeUpdateQueue = Promise.resolve();

async function renderActionBadge() {
  const stored = await chrome.storage.session.get([ERRORS_KEY, CHECK_IN_KEY]);
  const hasErrors = Object.keys(stored[ERRORS_KEY] ?? {}).length > 0;
  const checkInPending = Object.keys(stored[CHECK_IN_KEY] ?? {}).length > 0;
  await chrome.action.setBadgeText({ text: hasErrors || checkInPending ? "!" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: hasErrors ? "#b42318" : checkInPending ? "#b7791f" : "#16776c" });
  await chrome.action.setTitle({ title: hasErrors ? "InSession needs attention" : checkInPending ? "InSession activity check-in requested" : "Open InSession attendance dashboard" });
}

function updateErrorBadge(source, hasError, message = "") {
  badgeUpdateQueue = badgeUpdateQueue.then(async () => {
    const stored = await chrome.storage.session.get(ERRORS_KEY);
    const errors = stored[ERRORS_KEY] ?? {};
    if (hasError) errors[source || "unknown"] = message || "InSession encountered an error.";
    else delete errors[source || "unknown"];
    await chrome.storage.session.set({ [ERRORS_KEY]: errors });
    await renderActionBadge();
  }).catch((error) => console.error("[InSession] Could not update the error badge:", error));
}

function updateCheckInPending(meetCode, pending) {
  if (!meetCode) return;
  badgeUpdateQueue = badgeUpdateQueue.then(async () => {
    const stored = await chrome.storage.session.get(CHECK_IN_KEY);
    const pendingMeetings = stored[CHECK_IN_KEY] ?? {};
    if (pending) pendingMeetings[meetCode] = true;
    else delete pendingMeetings[meetCode];
    await chrome.storage.session.set({ [CHECK_IN_KEY]: pendingMeetings });
    await renderActionBadge();
  }).catch((error) => console.error("[InSession] Could not update the activity check-in badge:", error));
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "in-session:report-error") {
    updateErrorBadge(message.source, true, message.message);
  } else if (message?.type === "in-session:clear-error") {
    updateErrorBadge(message.source, false);
  } else if (message?.type === "in-session:check-in-state") {
    updateCheckInPending(message.meetCode, message.pending);
  } else if (message?.type === "in-session:get-errors") {
    chrome.storage.session.get(ERRORS_KEY).then((stored) => sendResponse(stored[ERRORS_KEY] ?? {}));
    return true;
  }
});
