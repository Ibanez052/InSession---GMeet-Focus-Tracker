import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { 
  getFirestore, 
  collection, 
  onSnapshot, 
  doc, 
  updateDoc,
  setDoc,
  getDocs,
  deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// --- FIREBASE CONFIG ---
const firebaseConfig = {
  apiKey: "AIzaSyDryYH8McIxJWq4I5HXF3TGm3wWkKpVUk",
  authDomain: "insession-extension.firebaseapp.com",
  projectId: "insession-extension",
  storageBucket: "insession-extension.firebasestorage.app",
  messagingSenderId: "855288159063",
  appId: "1:855288159063:web:e1caa50cd74b91c1347c12",
  measurementId: "G-TN7W1DCSQM"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const studentsCol = collection(db, "students");
const sessionDocRef = doc(db, "session", "current");

// UI Elements
const studentTableBody = document.getElementById("studentTableBody");
const attendeeCountEl = document.querySelector(".card-yellow .stat-number");
const activeCountEl = document.querySelector(".card-green .stat-number");
const awayCountEl = document.querySelector(".card-red .stat-number");
const searchInput = document.querySelector(".search-input");

// Action Buttons
const btnStart = document.querySelector(".btn-start");
const btnPause = document.querySelector(".btn-pause");
const btnEnd = document.querySelector(".btn-end");

// Filter Controls
const filterBtn = document.getElementById("filter-btn");
const filterDropdown = document.getElementById("filterDropdown");
const currentFilterText = document.getElementById("currentFilterText");
const menuItems = filterDropdown ? filterDropdown.querySelectorAll("li") : [];

let currentFilter = "all";
let searchQuery = "";
let studentsData = [];
let sessionState = "idle"; // "idle" | "running" | "paused" | "ended"

// --- 1. SESSION STATE LISTENER ---
onSnapshot(sessionDocRef, (snap) => {
  if (snap.exists()) {
    sessionState = snap.data().status || "idle";
  } else {
    sessionState = "idle";
  }
  updateButtonStyles();
});

function updateButtonStyles() {
  if (sessionState === "running") {
    btnStart.style.opacity = "0.4";
    btnStart.style.pointerEvents = "none";
    btnPause.style.opacity = "1";
    btnPause.style.pointerEvents = "auto";
    btnPause.textContent = "Pause";
    btnEnd.style.opacity = "1";
    btnEnd.style.pointerEvents = "auto";
  } else if (sessionState === "paused") {
    btnStart.style.opacity = "1";
    btnStart.style.pointerEvents = "auto";
    btnStart.textContent = "Resume";
    btnPause.style.opacity = "0.4";
    btnPause.style.pointerEvents = "none";
    btnEnd.style.opacity = "1";
    btnEnd.style.pointerEvents = "auto";
  } else { // "idle" or "ended"
    btnStart.style.opacity = "1";
    btnStart.style.pointerEvents = "auto";
    btnStart.textContent = "Start";
    btnPause.style.opacity = "0.4";
    btnPause.style.pointerEvents = "none";
    btnEnd.style.opacity = "0.4";
    btnEnd.style.pointerEvents = "none";
  }
}

// Button Click Handlers
btnStart.addEventListener("click", async () => {
  await setDoc(sessionDocRef, {
    status: "running",
    startedAt: new Date().toISOString()
  }, { merge: true });
});

btnPause.addEventListener("click", async () => {
  await setDoc(sessionDocRef, {
    status: "paused",
    pausedAt: new Date().toISOString()
  }, { merge: true });
});

btnEnd.addEventListener("click", async () => {
  const confirmEnd = confirm("Are you sure you want to end this attendance session? This will clear all participant data.");
  if (!confirmEnd) return;

  btnEnd.disabled = true;

  try {
    // 1. Set session status to ended
    await setDoc(sessionDocRef, {
      status: "ended",
      endedAt: new Date().toISOString()
    }, { merge: true });

    // 2. Fetch and delete all student documents
    const snapshot = await getDocs(studentsCol);
    const deletePromises = snapshot.docs.map((docSnap) => deleteDoc(docSnap.ref));
    await Promise.all(deletePromises);

    console.log("[InSession] Session ended and participant documents cleared.");
  } catch (err) {
    console.error("[InSession] Failed to clear documents on session end:", err);
  } finally {
    btnEnd.disabled = false;
  }
});

// --- 2. STUDENTS LISTENER ---
onSnapshot(studentsCol, (snapshot) => {
  studentsData = [];
  snapshot.forEach((docSnap) => {
    studentsData.push({ id: docSnap.id, ...docSnap.data() });
  });

  studentsData.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  renderUI();
});

function renderUI() {
  const total = studentsData.length;
  const activeCount = studentsData.filter(s => s.status === "active").length;
  const awayCount = studentsData.filter(s => s.status === "away").length;

  if (attendeeCountEl) attendeeCountEl.textContent = total;
  if (activeCountEl) activeCountEl.textContent = `${activeCount}/${total}`;
  if (awayCountEl) awayCountEl.textContent = `${awayCount}/${total}`;

  const filtered = studentsData.filter((student) => {
    const matchesFilter = currentFilter === "all" || student.status === currentFilter;
    const matchesSearch = (student.name || "")
      .toLowerCase()
      .includes(searchQuery.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  if (!studentTableBody) return;
  studentTableBody.innerHTML = "";

  if (filtered.length === 0) {
    studentTableBody.innerHTML = `
      <tr>
        <td colspan="2" style="text-align: center; padding: 24px; color: #888;">
          No participants found.
        </td>
      </tr>
    `;
    return;
  }

  filtered.forEach((student) => {
    const tr = document.createElement("tr");
    const isActive = student.status === "active";

    tr.innerHTML = `
      <td class="col-student">${student.name || "Unknown"}</td>
      <td class="col-status">
        <span class="status-badge ${isActive ? 'badge-active' : 'badge-away'}" 
              style="cursor: pointer;" 
              data-id="${student.id}" 
              data-status="${student.status}">
          <span class="badge-dot"></span> 
          ${isActive ? 'Active' : 'Away'}
        </span>
      </td>
    `;
    studentTableBody.appendChild(tr);
  });
}

// Manual Status Override
if (studentTableBody) {
  studentTableBody.addEventListener("click", async (e) => {
    const badge = e.target.closest(".status-badge");
    if (!badge) return;

    const studentId = badge.getAttribute("data-id");
    const currentStatus = badge.getAttribute("data-status");
    const nextStatus = currentStatus === "active" ? "away" : "active";

    const studentDocRef = doc(db, "students", studentId);
    await updateDoc(studentDocRef, { status: nextStatus });
  });
}

// Search
if (searchInput) {
  searchInput.addEventListener("input", (e) => {
    searchQuery = e.target.value.trim();
    renderUI();
  });
}

// Dropdown
if (filterBtn && filterDropdown) {
  filterBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    filterDropdown.classList.toggle("show");
  });

  menuItems.forEach((item) => {
    item.addEventListener("click", () => {
      menuItems.forEach((li) => li.classList.remove("active"));
      item.classList.add("active");

      if (currentFilterText) currentFilterText.textContent = item.textContent;
      currentFilter = item.getAttribute("data-value");

      renderUI();
      filterDropdown.classList.remove("show");
    });
  });

  document.addEventListener("click", (e) => {
    if (!filterDropdown.contains(e.target) && !filterBtn.contains(e.target)) {
      filterDropdown.classList.remove("show");
    }
  });
}