import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyANqfXC4W5-Ji6DwnzhtTHqLu_MVdz97T0",
  authDomain: "insession-d7332.firebaseapp.com",
  projectId: "insession-d7332",
  storageBucket: "insession-d7332.firebasestorage.app",
  messagingSenderId: "433861086598",
  appId: "1:433861086598:web:e08efb76a52df6f9897007",
};
const auth = getAuth(initializeApp(firebaseConfig));
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });
const parentOrigin = "chrome-extension://beihnncofapjnpgfkphgocbdkigiedod";

window.addEventListener("message", async (event) => {
  if (event.source !== parent || event.origin !== parentOrigin
    || event.data?.type !== "in-session:choose-google-account") return;

  try {
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    parent.postMessage({ type: "in-session:google-auth-result", accessToken: credential?.accessToken }, parentOrigin);
  } catch (error) {
    parent.postMessage({
      type: "in-session:google-auth-result",
      message: error.code === "auth/popup-closed-by-user" ? "Google account selection was canceled." : error.message,
    }, parentOrigin);
  }
});
