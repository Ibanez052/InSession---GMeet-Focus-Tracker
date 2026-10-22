// Light/dark theme for the side panel
(() => {
  const KEY = "insession-theme";
  const root = document.documentElement;
  const media = window.matchMedia("(prefers-color-scheme: dark)");

  const readStored = () => {
    try {
      const value = localStorage.getItem(KEY);
      return value === "light" || value === "dark" ? value : null;
    } catch { return null; }
  };
  const effectiveTheme = () => readStored() ?? (media.matches ? "dark" : "light");

  function syncButton() {
    const button = document.getElementById("theme-toggle");
    if (!button) return;
    const dark = effectiveTheme() === "dark";
    button.dataset.mode = dark ? "dark" : "light";
    button.setAttribute("aria-pressed", String(dark));
    const label = dark ? "Switch to light mode" : "Switch to dark mode";
    button.setAttribute("aria-label", label);
    button.title = label;
  }

  function apply() {
    const stored = readStored();
    if (stored) root.dataset.theme = stored;
    else delete root.dataset.theme; // follow the system setting
    syncButton();
  }

  apply();
  media.addEventListener("change", apply);
  document.addEventListener("DOMContentLoaded", () => {
    syncButton();
    document.getElementById("theme-toggle")?.addEventListener("click", () => {
      const next = effectiveTheme() === "dark" ? "light" : "dark";
      try { localStorage.setItem(KEY, next); } catch { /* storage unavailable */ }
      apply();
    });
  });
})();
