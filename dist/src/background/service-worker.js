chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .then(() => updateErrorBadge("side-panel-setup", false))
  .catch((error) => {
    console.error("[InSession] Could not configure the side panel:", error);
    updateErrorBadge("side-panel-setup", true);
  });

const ERRORS_KEY = "inSessionErrors";
let badgeUpdateQueue = Promise.resolve();

function updateErrorBadge(source, hasError, message = "") {
  badgeUpdateQueue = badgeUpdateQueue.then(async () => {
    const stored = await chrome.storage.session.get(ERRORS_KEY);
    const errors = stored[ERRORS_KEY] ?? {};
    if (hasError) errors[source || "unknown"] = message || "InSession encountered an error.";
    else delete errors[source || "unknown"];
    await chrome.storage.session.set({ [ERRORS_KEY]: errors });
    const hasErrors = Object.keys(errors).length > 0;
    await chrome.action.setBadgeText({ text: hasErrors ? "!" : "" });
    await chrome.action.setBadgeBackgroundColor({ color: hasErrors ? "#b42318" : "#16776c" });
    await chrome.action.setTitle({ title: hasErrors ? "InSession needs attention" : "Open InSession attendance dashboard" });
  }).catch((error) => console.error("[InSession] Could not update the error badge:", error));
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "in-session:report-error") {
    updateErrorBadge(message.source, true, message.message);
  } else if (message?.type === "in-session:clear-error") {
    updateErrorBadge(message.source, false);
  } else if (message?.type === "in-session:get-errors") {
    chrome.storage.session.get(ERRORS_KEY).then((stored) => sendResponse(stored[ERRORS_KEY] ?? {}));
    return true;
  }
});
