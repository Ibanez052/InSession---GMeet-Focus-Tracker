const AUTH_HELPER_URL = "https://insession-d7332.web.app/auth-helper.html";
const authHelperOrigin = new URL(AUTH_HELPER_URL).origin;
const authFrame = document.createElement("iframe");
authFrame.src = AUTH_HELPER_URL;
document.body.append(authFrame);

const authFrameReady = new Promise((resolve, reject) => {
  authFrame.addEventListener("load", resolve, { once: true });
  authFrame.addEventListener("error", () => reject(new Error("Could not load the hosted Google sign-in helper.")), { once: true });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen" || message?.type !== "in-session:choose-google-account") return false;

  (async () => {
    await authFrameReady;
    const handleAuthResult = (event) => {
      if (event.source !== authFrame.contentWindow || event.origin !== authHelperOrigin) return;
      if (event.data?.type !== "in-session:google-auth-result") return;
      window.removeEventListener("message", handleAuthResult);
      sendResponse(event.data.accessToken
        ? { accessToken: event.data.accessToken }
        : { message: event.data.message || "Google sign-in did not return an access token." });
    };

    window.addEventListener("message", handleAuthResult);
    authFrame.contentWindow.postMessage({ type: "in-session:choose-google-account" }, authHelperOrigin);
  })().catch((error) => sendResponse({ message: error.message }));

  return true;
});
