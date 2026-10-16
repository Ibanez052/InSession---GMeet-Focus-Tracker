# InSession – GMeet Focus Tracker

A Chrome (Manifest V3) extension for Google Meet that shows whether participants are in the Meet tab or somewhere else. Each participant's extension reports its own status to Firestore, and the host's side panel shows a live attendance dashboard (Start / Pause / End, search, filter).

> **Status: prototype.** This README tracks known issues and planned improvements. Checked items are implemented or no longer apply to the participant self-reporting design.

## Build and Firebase setup

The Firebase SDK is bundled locally. Install dependencies and build the unpacked extension with Node.js and npm:

```sh
npm ci
npm run build
```

For local development, keep the extension loaded from the repository root (the folder containing the top-level `manifest.json`). Clicking the extension's toolbar icon opens its dashboard in Chrome's side panel. The root manifest points Chrome at the bundled side panel, content script, and service worker in `dist/`, so rebuilding does not change the extension ID used by OAuth. The generated `dist/` folder also contains a standalone manifest for packaging; loading that folder separately creates a different unpacked-extension ID unless a stable manifest key is configured.

Before signing in or tracking participants:

1. In Firebase Authentication, enable **Google** and **Anonymous** sign-in providers.
2. In the Google Cloud project associated with Firebase, create an OAuth client of type **Chrome Extension**. Enter the extension ID shown in `chrome://extensions` as its Item ID. Google will generate a separate client ID ending in `.apps.googleusercontent.com`.
3. Set the generated Chrome Extension OAuth client ID in `manifest.json`, then rebuild the extension.
4. In Firebase Authentication's Authorized domains settings, add `chrome-extension://<your-extension-id>`.
5. Deploy the included Firestore rules with the Firebase CLI: `firebase deploy --only firestore:rules --project insession-d7332`.

The Firebase web API key in the source is public configuration. Firestore access is protected by `firestore.rules`; do not use the extension until those rules have been deployed. The side panel uses the host-controls button in the Meet page as a role-detection signal. Google documents that only meeting hosts can access those controls, but this is a UI check and may break if Meet changes its page markup. Firestore rules can verify Google sign-in and session ownership; they cannot verify this page signal, so this is not tamper-proof host authorization. Attendance data is stored in Cloud Firestore (not Firebase Storage) only while a session is active or awaiting a successful export. Ending a session downloads a CSV and then removes the session and attendee documents from Firestore.

## Current files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest, side panel, service worker, and content script on `meet.google.com` |
| `src/content/content.js` | Runs in Meet tabs: identity, active-call session listener, and participant self-reporting |
| `popup.js` / `popup.html` / `style.css` | Side panel dashboard (Firebase JS SDK, live `onSnapshot` listeners) |

## Target design

All fixes below fit one redesign:

- Firebase Auth for everyone (`chrome.identity` Google sign-in after host-controls UI detection, anonymous or Google sign-in for participants).
- Sessions keyed by Meet code: `sessions/{meetCode}/students/{uid}`.
- Firebase SDK **bundled locally** (Vite or esbuild). No remote scripts.
- `onSnapshot` listeners instead of polling.
- Firestore security rules enforce who may write what.

## Suggested order of work

1. **Foundation:** #1, #17, #18, #19 (loading, auth, rules, host-only controls)
2. **Data model:** #6, #8, #12 (per-meeting sessions, uid-based IDs, run IDs)
3. **Accurate tracking:** #2, #3, #4, #7, #13, #15, #16
4. **Safety and usability:** #20, #22, #23, #24, #25
5. **Polish and repo cleanup:** #31, #33, #34

---

## A. Broken now

- [x] **1. Popup cannot load Firebase.** `popup.js` imports from `https://www.gstatic.com/firebasejs/...`; MV3 blocks remote scripts, so the popup stays on its placeholder numbers.
  **Fix:** install `firebase` via npm and bundle `popup.js` and `content.js` with Vite or esbuild. This also removes the need for the REST calls in `content.js`.

- [x] **2. Window `blur` tracking is overridden by the heartbeat.** Status now uses both `document.hidden` and `document.hasFocus()`, with a 5-second delay before reporting Away.
  **Fix:** one function everywhere: `active = !document.hidden && document.hasFocus()`. Debounce "away" by about 5 s. Decide how to treat screen sharing and Picture-in-Picture, which also steal focus.

- [x] **3. Closing the tab never marks anyone as left.** Student status heartbeats write server `lastSeen` every 30 seconds; leaving the detected Meet call sends a prompt `left` update after a brief confirmation, with `pagehide` as a best-effort fallback. The dashboard shows **Not reporting** after 60 seconds without an update if those writes are interrupted; **Left** is reserved for an explicit leave update.
  **Fix:** write a server `lastSeen` every ~30 s. Show "Not reporting" when it is older than ~60 s. Also send a final `left` when the Meet call ends and on `pagehide`. Watch the free-tier write quota (20,000 writes/day); 55 students at 30 s is about 6,600 writes per hour.

- [x] **4. Quota burn from polling.** Session state uses one Firestore `onSnapshot` listener per participant, opened only while the participant is in an active Meet call. Status heartbeats are written every 30 seconds while tracking is running.
  **Fix:** replace polling with an `onSnapshot` on the session doc and stop listening outside active calls.

- [x] **5. Participant scraper runs on every client.** The scraper described in the original review is no longer present. Participants report their own status from their extension; the dashboard does not scrape the Meet roster.
  **Resolution:** keep attendance self-reported. A host-only roster scraper is not part of the current design.

## B. Wrong or inconsistent data

- [x] **6. One global session for everyone.** There is a single `session/current` doc and one `students` collection with no meeting code, so two classes using the extension at once get mixed together.
  **Fix:** key sessions by the meeting code from `location.pathname`. Reset local state when the code changes (Meet is a single-page app).

- [x] **7. Name blacklist rejects real names.** The blacklist was removed. Names are read from the account/self-name elements and are checked only for basic validity, so ordinary names such as "Pineda", "Claudio", and "Chatterjee" are accepted.

- [x] **8. Doc ID collisions.** Names are reduced to `[a-z0-9]`, so "José" becomes `jos_`, non-Latin names collapse to underscores, and "Ana-Maria" and "Ana Maria" collide.
  **Fix:** use the auth `uid` as the doc ID and store the name as a field.

- [x] **9. Scraped and self-reported entries can duplicate.** This no longer applies: InSession does not scrape the participant roster; each installed extension reports its own attendee record.

- [x] **10. Scraped people show "Active" without being monitored.** This no longer applies because there are no scraped attendee records.

- [x] **11. The instructor appears as a student** because their own content script also reports status. The content script skips host status reports, and the dashboard filters and removes any stale host student record.
  **Fix:** skip reporting when `uid === hostUid`; clean up legacy host records from the student list.

- [x] **12. Quick End → Start loses students; pause/resume can leave stale status.** Client status can remain stale across a quick restart or pause/resume.
  **Fix:** give each run a `runId`. Clients reset `lastReportedStatus` whenever it changes, and on resume.

- [x] **13. Unknown or stale status is shown as Away/Left.** The dashboard handles `active`, `away`, and `left` explicitly. Invalid status values and stale/missing heartbeats display as **Not reporting**, with their own filter and badge.

- [x] **14. Client-side timestamps.**
  **Fix:** use `serverTimestamp()`.

## C. Fragile Meet scraping

- [ ] **15. Meet detection depends on localized UI labels.** Meeting detection now requires a valid Meet-code URL and an exact leave-action label; broad `*="call"` matching is gone, and Meet UI selectors are kept together in `MEET_UI`. The accessible leave-action label is still English-only, so localized Meet interfaces need follow-up support.

- [x] **16. Tracking loops run outside meetings.** Participant heartbeats now start only while a meeting is active and its session is running, and stop when either condition ends. Identity lookup happens only when a status report is due; the popup uses tab activation/update events instead of polling the active tab.

## D. Security and privacy

- [x] **17. No authentication.** Chrome identity Google sign-in is wired into the popup and has been confirmed working.
  **Fix:** `chrome.identity` Google sign-in for the host, anonymous or Google sign-in for students. Add the `identity` permission to the manifest.

- [x] **18. Open Firestore rules.** Rules are defined in `firestore.rules` and have been deployed to the `insession-d7332` Firebase project. Unauthenticated clients are denied; keep the project ID and API key treated as public configuration.
  **Fix:** replace the rules and test them in the emulator. Sketch:
  ```
  function googleSignedIn() {
    return request.auth != null
      && request.auth.token.firebase.sign_in_provider == "google.com";
  }
  match /sessions/{code} {
    allow read: if request.auth != null;
    allow create: if googleSignedIn() && request.resource.data.hostUid == request.auth.uid;
    allow update, delete: if googleSignedIn() && resource.data.hostUid == request.auth.uid;
    match /students/{uid} {
      allow create, update: if request.auth.uid == uid
        && get(/databases/$(database)/documents/sessions/$(code)).data.status == "running";
      allow read, delete: if get(/databases/$(database)/documents/sessions/$(code)).data.hostUid == request.auth.uid;
    }
  }
  ```
  The `status == "running"` check also stops students being recreated after End. Rule `get()` calls count as reads, so keep heartbeats at 30 s or slower.
  **Deployment:** this branch adds duration fields and run ID validation to participant writes. Redeploy `firestore.rules` after merging this change.

- [x] **19. Host and participant UI roles.** The side panel offers instructor sign-in and host controls when the Meet page exposes host-control labels. The participant view includes a retry button for delayed or missed detection. This depends on Meet's UI markup and is not a security boundary: Firestore rules cannot verify the role signal, and a determined signed-in user could bypass the extension UI.
  **Deployment:** redeploy `firestore.rules` after merging rule changes. The current rules require Google sign-in and preserve session ownership, but do not independently verify the actual Meet host.

- [x] **20. Markup injection via `innerHTML`.** Student names are user-controlled and inserted unescaped. MV3 blocks inline handlers, which limits the damage, but it should still be fixed.
  **Fix:** build rows with `createElement` and `textContent`.

- [x] **21. Firebase API key is public in the repo.** This is expected for client-side Firebase configuration. Firestore rules protect data access; the key is not an authorization secret.

- [x] **22. Participant privacy notice and retention.** The notice explains the data shared and the cleanup flow. The host downloads attendance when ending the session; Firestore records are deleted only after Chrome confirms the CSV download. If the download fails or is canceled, the ended session remains available for retry.

- [ ] **23. Clients can be spoofed or disabled.** Rules stop students writing as someone else, but a determined student can still disable the extension.
  **Fix:** treat "no signal" as its own flag rather than "present".

## E. Features and UX

- [ ] **24. Silent `catch {}` blocks.** Failures (quota, rule denials, network) are invisible.
  **Fix:** log errors, show an error state with retry in the popup, and set a badge on the extension icon.

- [x] **25. Ending a session deletes everything.** Ending now exports a CSV with each participant's final status and estimated active/away time, then deletes session and attendee records from Firestore after the download completes. Durations are heartbeat-based estimates, not exact timers. The downloaded CSV is the host's attendance record; InSession does not keep server-side session history. Participants need the updated extension for duration estimates; older clients still appear in the export, but their duration values are marked unavailable.

- [x] **26. Manual status override fights live reports.**
  **Fix:** store it as a separate `override` field with a visible marker, add an undo, or remove the feature.

- [x] **27. Logout does nothing.** Sign-out is a button wired to Firebase `signOut`.

- [x] **28. Popup layout.** The dashboard now opens in Chrome's resizable side panel, and the attendee table scrolls within the available panel height with a sticky header.
  **Fix:** use a responsive side panel, remove the centering, and give the table a scrolling body with a sticky header.

- [x] **29. Hard-coded numbers in `popup.html`.** Counters start at "–" and update from live attendee data.

- [x] **30. Accessibility and wording.** The filter uses a native keyboard-accessible `<select>` with a CSS chevron; search and filter controls have accessible labels, Away wording is consistent, and decorative icons have empty alt text.
  **Fix:** use "Away" everywhere, a CSS chevron, `aria-label` on the search box, a proper dropdown role or a `<select>`, and `alt=""` on decorative icons.

- [ ] **31. CSS cleanup.** Unused `.brand-logo svg` and `.brand-text` rules, a duplicate `padding-left`, and inline styles in the HTML and JS.
  **Fix:** remove dead rules and move inline styles into classes.

## F. Repo and manifest

- [x] **32. GitHub is behind the local copy.** The action and side-panel manifest changes are merged into `main`.

- [ ] **33. Documentation.** This README covers Firebase setup, rules deployment, and the build/unpacked-extension workflow. A project LICENSE is still needed.

- [ ] **34. Manifest icons.** The name, identity/downloads permissions, action entry, side panel, and background service worker are present. Add standard 16/48/128 extension icons and declare them in the manifest.

---

## Progress

Firestore rules are deployed to `insession-d7332`, and Google sign-in is working. Some original review items have been rewritten because the implementation no longer uses the scraper-based design.
