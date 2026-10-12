const FIRESTORE_API_URL = "https://firestore.googleapis.com/v1/projects/insession-extension/databases/(default)/documents";
const STUDENTS_URL = `${FIRESTORE_API_URL}/students`;
const SESSION_URL = `${FIRESTORE_API_URL}/session/current`;

const studentTableBody = document.getElementById("studentTableBody");
const attendeeCountEl = document.querySelector(".card-yellow .stat-number");
const activeCountEl = document.querySelector(".card-green .stat-number");
const awayCountEl = document.querySelector(".card-red .stat-number");
const searchInput = document.querySelector(".search-input");
const errorMessage = document.getElementById("errorMessage");
const btnStart = document.querySelector(".btn-start");
const btnPause = document.querySelector(".btn-pause");
const btnEnd = document.querySelector(".btn-end");
const filterBtn = document.getElementById("filter-btn");
const filterDropdown = document.getElementById("filterDropdown");
const currentFilterText = document.getElementById("currentFilterText");
const menuItems = filterDropdown ? filterDropdown.querySelectorAll("li") : [];

let currentFilter = "all";
let searchQuery = "";
let studentsData = [];
let sessionState = "idle";
let refreshInProgress = false;

async function firestoreRequest(url, options = {}) {
  const response = await fetch(url, options);
  const responseText = await response.text();
  let body = null;
  if (responseText) {
    try {
      body = JSON.parse(responseText);
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    const details = body?.error?.message || response.statusText;
    throw new Error(`Firestore request failed (${response.status}): ${details}`);
  }
  return body;
}

function firestoreFields(values) {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, { stringValue: value }])
  );
}

async function writeDocument(url, values) {
  const query = new URLSearchParams();
  Object.keys(values).forEach((field) => query.append("updateMask.fieldPaths", field));
  await firestoreRequest(`${url}?${query}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: firestoreFields(values) })
  });
}

function showError(error) {
  console.error("[InSession] Firestore operation failed:", error);
  if (errorMessage) {
    errorMessage.textContent = error.message || "Unable to connect to Firestore.";
    errorMessage.hidden = false;
  }
}

function clearError() {
  if (errorMessage) {
    errorMessage.textContent = "";
    errorMessage.hidden = true;
  }
}

function updateButtonStyles() {
  if (!btnStart || !btnPause || !btnEnd) return;

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
  } else {
    btnStart.style.opacity = "1";
    btnStart.style.pointerEvents = "auto";
    btnStart.textContent = "Start";
    btnPause.style.opacity = "0.4";
    btnPause.style.pointerEvents = "none";
    btnEnd.style.opacity = "0.4";
    btnEnd.style.pointerEvents = "none";
  }
}

function renderUI() {
  const total = studentsData.length;
  const activeCount = studentsData.filter((student) => student.status === "active").length;
  const awayCount = studentsData.filter((student) => student.status === "away").length;

  if (attendeeCountEl) attendeeCountEl.textContent = total;
  if (activeCountEl) activeCountEl.textContent = `${activeCount}/${total}`;
  if (awayCountEl) awayCountEl.textContent = `${awayCount}/${total}`;
  if (!studentTableBody) return;

  const filtered = studentsData.filter((student) => {
    const matchesFilter = currentFilter === "all" || student.status === currentFilter;
    const matchesSearch = (student.name || "").toLowerCase().includes(searchQuery.toLowerCase());
    return matchesFilter && matchesSearch;
  });
  studentTableBody.replaceChildren();

  if (filtered.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 2;
    cell.textContent = "No participants found.";
    cell.style.cssText = "text-align: center; padding: 24px; color: #888;";
    row.appendChild(cell);
    studentTableBody.appendChild(row);
    return;
  }

  filtered.forEach((student) => {
    const isActive = student.status === "active";
    const row = document.createElement("tr");
    const nameCell = document.createElement("td");
    const statusCell = document.createElement("td");
    const badge = document.createElement("span");
    const dot = document.createElement("span");

    nameCell.className = "col-student";
    nameCell.textContent = student.name || "Unknown";
    statusCell.className = "col-status";
    badge.className = `status-badge ${isActive ? "badge-active" : "badge-away"}`;
    badge.style.cursor = "pointer";
    badge.dataset.id = student.id;
    badge.dataset.status = student.status || "away";
    dot.className = "badge-dot";
    badge.append(dot, document.createTextNode(isActive ? " Active" : " Away"));
    statusCell.appendChild(badge);
    row.append(nameCell, statusCell);
    studentTableBody.appendChild(row);
  });
}

async function refreshData() {
  if (refreshInProgress) return;
  refreshInProgress = true;

  try {
    const [studentsResponse, sessionResponse] = await Promise.all([
      firestoreRequest(STUDENTS_URL),
      fetch(SESSION_URL)
    ]);

    let newSessionState = "idle";
    if (sessionResponse.ok) {
      const session = await sessionResponse.json();
      newSessionState = session.fields?.status?.stringValue || "idle";
    } else if (sessionResponse.status !== 404) {
      const body = await sessionResponse.json().catch(() => null);
      throw new Error(`Firestore request failed (${sessionResponse.status}): ${body?.error?.message || sessionResponse.statusText}`);
    }

    studentsData = (studentsResponse.documents || []).map((document) => ({
      id: document.name.split("/").pop(),
      name: document.fields?.name?.stringValue || "",
      status: document.fields?.status?.stringValue || "away"
    }));
    studentsData.sort((a, b) => a.name.localeCompare(b.name));
    sessionState = newSessionState;
    updateButtonStyles();
    renderUI();
    clearError();
  } catch (error) {
    showError(error);
  } finally {
    refreshInProgress = false;
  }
}

async function runAction(action) {
  try {
    await action();
    await refreshData();
  } catch (error) {
    showError(error);
  }
}

if (btnStart) {
  btnStart.addEventListener("click", () => runAction(() => writeDocument(SESSION_URL, {
    status: "running",
    startedAt: new Date().toISOString()
  })));
}

if (btnPause) {
  btnPause.addEventListener("click", () => runAction(() => writeDocument(SESSION_URL, {
    status: "paused",
    pausedAt: new Date().toISOString()
  })));
}

if (btnEnd) {
  btnEnd.addEventListener("click", async () => {
    const confirmEnd = confirm("Are you sure you want to end this attendance session? This will clear all participant data.");
    if (!confirmEnd) return;

    btnEnd.disabled = true;
    await runAction(async () => {
      await writeDocument(SESSION_URL, {
        status: "ended",
        endedAt: new Date().toISOString()
      });
      const snapshot = await firestoreRequest(STUDENTS_URL);
      await Promise.all((snapshot.documents || []).map((document) =>
        firestoreRequest(`${FIRESTORE_API_URL}/${encodeURIComponent(document.name.split("/").pop())}`, {
          method: "DELETE"
        })
      ));
    });
    btnEnd.disabled = false;
  });
}

if (studentTableBody) {
  studentTableBody.addEventListener("click", async (event) => {
    const badge = event.target.closest(".status-badge");
    if (!badge) return;

    const studentId = badge.dataset.id;
    const nextStatus = badge.dataset.status === "active" ? "away" : "active";
    await runAction(() => writeDocument(
      `${STUDENTS_URL}/${encodeURIComponent(studentId)}`,
      { status: nextStatus }
    ));
  });
}

if (searchInput) {
  searchInput.addEventListener("input", (event) => {
    searchQuery = event.target.value.trim();
    renderUI();
  });
}

if (filterBtn && filterDropdown) {
  filterBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    filterDropdown.classList.toggle("show");
  });

  menuItems.forEach((item) => {
    item.addEventListener("click", () => {
      menuItems.forEach((menuItem) => menuItem.classList.remove("active"));
      item.classList.add("active");
      if (currentFilterText) currentFilterText.textContent = item.textContent;
      currentFilter = item.dataset.value || "all";
      renderUI();
      filterDropdown.classList.remove("show");
    });
  });

  document.addEventListener("click", (event) => {
    if (!filterDropdown.contains(event.target) && !filterBtn.contains(event.target)) {
      filterDropdown.classList.remove("show");
    }
  });
}

refreshData();
setInterval(refreshData, 3000);
