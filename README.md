# InSession – GMeet Focus Tracker

A Chrome (Manifest V3) extension for Google Meet that shows whether participants are in the Meet tab or somewhere else. Each participant's extension reports its own status to Firestore, and the host's side panel shows a live attendance dashboard (Start / Pause / End, search, filter).

> **Status: prototype.** This README documents every known issue found in a code review of `content.js`, `popup.js`, `popup.html`, `style.css` and `manifest.json`, together with the planned fix for each. Tick the boxes as items are completed.

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

The Firebase web API key in the source is public configuration. Firestore access is protected by `firestore.rules`; do not use the extension until those rules have been deployed. The side panel uses the host-controls button in the Meet page as a role-detection signal. Google documents that only meeting hosts can access those controls, but this is a UI check and may break if Meet changes its page markup. Firestore rules can verify Google sign-in and session ownership; they cannot verify this page signal, so this is not tamper-proof host authorization.

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
3. **Accurate status and quota:** #2, #3, #4
4. **Scraper behaviour:** #5, #9, #10, #11
5. **Safety and usability:** #20, #22, #24, #25
6. **Polish and repo cleanup:** everything else

---

## A. Broken now

- [x] **1. Popup cannot load Firebase.** `popup.js` imports from `https://www.gstatic.com/firebasejs/...`; MV3 blocks remote scripts, so the popup stays on its placeholder numbers.
  **Fix:** install `firebase` via npm and bundle `popup.js` and `content.js` with Vite or esbuild. This also removes the need for the REST calls in `content.js`.

- [x] **2. Window `blur` tracking is overridden by the heartbeat.** Status now uses both `document.hidden` and `document.hasFocus()`, with a 5-second delay before reporting Away.
  **Fix:** one function everywhere: `active = !document.hidden && document.hasFocus()`. Debounce "away" by about 5 s. Decide how to treat screen sharing and Picture-in-Picture, which also steal focus.

- [x] **3. Closing the tab never marks anyone as left.** Student status heartbeats write server `lastSeen` every 30 seconds; the dashboard shows Left after 60 seconds without an update, and attempts a final `left` write on `pagehide`.
  **Fix:** write a server `lastSeen` every ~30 s. The dashboard shows "Left" when it is older than ~60 s. Also send a final `left` on `pagehide`. Watch the free-tier write quota (20,000 writes/day); 55 students at 30 s is about 6,600 writes per hour.

- [x] **4. Quota burn from polling.** Session state uses one Firestore `onSnapshot` listener per participant, opened only while the participant is in an active Meet call. Status heartbeats are written every 30 seconds while tracking is running.
  **Fix:** replace polling with an `onSnapshot` on the session doc and stop listening outside active calls.

- [x] **5. Participant scraper runs on every client.** The scraper described in the original review is no longer present. Participants report their own status from their extension; the dashboard does not scrape the Meet roster.
  **Resolution:** keep attendance self-reported. A host-only roster scraper is not part of the current design.

## B. Wrong or inconsistent data

- [x] **6. One global session for everyone.** There is a single `session/current` doc and one `students` collection with no meeting code, so two classes using the extension at once get mixed together.
  **Fix:** key sessions by the meeting code from `location.pathname`. Reset local state when the code changes (Meet is a single-page app).

- [ ] **7. Name blacklist rejects real names.** `UI_BLACKLIST` uses `includes()`: "Pineda" is rejected for "pin", "Claudio" for "audio", "Chatterjee" for "chat". Those students are never tracked.
  **Fix:** exact matches only, or drop the blacklist for the narrow `options for X` path.

- [x] **8. Doc ID collisions.** Names are reduced to `[a-z0-9]`, so "José" becomes `jos_`, non-Latin names collapse to underscores, and "Ana-Maria" and "Ana Maria" collide.
  **Fix:** use the auth `uid` as the doc ID and store the name as a field.

- [ ] **9. Ghost and duplicate entries, and nobody is ever removed.** The scraper uses participant-list names while each student reports under their Google Account name; if they differ, one person gets two docs.
  **Fix:** mark scraped entries `source: "scraped"` and merge them when a matching self-report arrives. Mark someone "left" after missing two consecutive roster scans.

- [ ] **10. Scraped people show "Active" though they are not monitored.**
  **Fix:** give them their own status ("Not tracked") and a fourth stat card.

- [ ] **11. The instructor appears as a student** because their own content script also reports status.
  **Fix:** skip reporting when `uid === hostUid`.

- [x] **12. Quick End → Start loses students; pause/resume can leave stale status.** Client status can remain stale across a quick restart or pause/resume.
  **Fix:** give each run a `runId`. Clients reset `lastReportedStatus` whenever it changes, and on resume.

- [ ] **13. Anything not "active" renders as Away.**
  **Fix:** define explicit statuses: `active`, `away`, `left`, `untracked`.

- [x] **14. Client-side timestamps.**
  **Fix:** use `serverTimestamp()`.

## C. Fragile Meet scraping

- [ ] **15. English-only labels and a loose `isInMeeting()`.** It depends on "Leave call", "options for", "(You)", "Google Account:". Any button with "call" in its label matches, and `[data-call-ended]` stays true after the call ends.
  **Fix:** combine the URL pattern (`abc-defg-hij`) with structural checks. Remove `[data-call-ended]` and `*="call"`. Keep all selectors in one config object so a Meet UI change is a one-file fix.

- [ ] **16. Loops run forever, even outside meetings.** `getMyName` Method D scans every `span, div` repeatedly until it succeeds, and the intervals never stop.
  **Fix:** start the loops on join and stop them on leave. Retry the identity lookup with backoff instead of scanning continuously.

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

- [x] **19. Host and participant UI roles.** The side panel only offers instructor sign-in and host controls when the Meet page exposes its host-controls button. Other users get the participant status view. This depends on Meet's UI markup and is not a security boundary: Firestore rules cannot verify the role signal, and a determined signed-in user could bypass the extension UI.
  **Deployment:** redeploy `firestore.rules` after merging rule changes. The current rules require Google sign-in and preserve session ownership, but do not independently verify the actual Meet host.

- [x] **20. Markup injection via `innerHTML`.** Student names are user-controlled and inserted unescaped. MV3 blocks inline handlers, which limits the damage, but it should still be fixed.
  **Fix:** build rows with `createElement` and `textContent`.

- [ ] **21. Firebase API key is public in the repo.**
  **Fix:** treat it as public. Protection comes from the rules (and optionally App Check), not from hiding the key.

- [ ] **22. Participant privacy notice and retention.** A notice now appears on the Meet page while a non-host's session is running. It explains which status data is shared, that only the Meet tab is monitored, and that session data currently has no automatic deletion. Tracking remains limited to a running session. The retention duration and deletion process still need a product decision before this item is complete.
  **Remaining:** choose a retention period and implement/document the corresponding deletion behavior.

- [ ] **23. Clients can be spoofed or disabled.** Rules stop students writing as someone else, but a determined student can still disable the extension.
  **Fix:** treat "no signal" as its own flag rather than "present".

## E. Features and UX

- [ ] **24. Silent `catch {}` blocks.** Failures (quota, rule denials, network) are invisible.
  **Fix:** log errors, show an error state with retry in the popup, and set a badge on the extension icon.

- [ ] **25. Ending a session deletes everything.** There is no history, no focus-time data and no export.
  **Fix:** archive instead of delete. Store accumulated away time per student and add a CSV export.

- [x] **26. Manual status override fights live reports.**
  **Fix:** store it as a separate `override` field with a visible marker, add an undo, or remove the feature.

- [ ] **27. Logout does nothing** (`href="#logout"`).
  **Fix:** wire it to Firebase `signOut`, or hide it until auth exists.

- [x] **28. Popup layout.** The dashboard now opens in Chrome's resizable side panel, and the attendee table scrolls within the available panel height with a sticky header.
  **Fix:** use a responsive side panel, remove the centering, and give the table a scrolling body with a sticky header.

- [ ] **29. Hard-coded numbers in `popup.html`** (55, 49/55, 6/56 – the last is also a typo).
  **Fix:** show "–" until real data arrives.

- [x] **30. Accessibility and wording.** The filter uses a native keyboard-accessible `<select>` with a CSS chevron; search and filter controls have accessible labels, Away wording is consistent, and decorative icons have empty alt text.
  **Fix:** use "Away" everywhere, a CSS chevron, `aria-label` on the search box, a proper dropdown role or a `<select>`, and `alt=""` on decorative icons.

- [ ] **31. CSS cleanup.** Unused `.brand-logo svg` and `.brand-text` rules, a duplicate `padding-left`, and inline styles in the HTML and JS.
  **Fix:** remove dead rules and move inline styles into classes.

## F. Repo and manifest

- [ ] **32. GitHub is behind the local copy** (the GitHub `manifest.json` lacks the `action`/`default_popup` entry).
  **Fix:** commit and push.

- [ ] **33. Documentation.** There was no README, LICENSE or setup guide.
  **Fix:** this README is the start. Still to add: Firebase project setup, rules deployment, how to load the unpacked extension, the build step, and a LICENSE.

- [ ] **34. Manifest gaps.** Name and description are inconsistent ("InSession Collector" vs "InSession"), there are no `icons` (16/48/128), no service worker, and no `identity` permission.
  **Fix:** align naming, add icons, add a background service worker if needed, and add the new permissions.

---

## Progress

34 issues total: 14 implementation items done. Firestore rules are deployed to `insession-d7332`, and Google sign-in is working.
