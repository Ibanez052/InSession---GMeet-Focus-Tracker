import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth/web-extension";

export const firebaseConfig = {
  apiKey: "AIzaSyANqfXC4W5-Ji6DwnzhtTHqLu_MVdz97T0",
  authDomain: "insession-d7332.firebaseapp.com",
  projectId: "insession-d7332",
  storageBucket: "insession-d7332.firebasestorage.app",
  messagingSenderId: "433861086598",
  appId: "1:433861086598:web:e08efb76a52df6f9897007",
  measurementId: "G-LPET87538V"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
