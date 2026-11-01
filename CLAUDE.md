# Gym Log (web app)

Phone web app for logging gym workouts. It reads and appends to a CSV log in the
owner's private GitHub repo through the GitHub API. Hosted with GitHub Pages from
`main` (root). This repository is PUBLIC.

## Working agreement (owner's standing instructions)
- The owner is the architect; Claude does the implementation. Commit, push and merge
  to `main` yourself. Do not ask about minor technical details; decide and move on.
- Still ask before adding ANY third-party component (libraries, packages, CDN
  scripts, web fonts, icons, GitHub Actions, external services). Browser built-ins
  and the Node/Python standard libraries are fine.
- Consider security in every change; report trade-offs that matter to the owner.

## Owner's device and field-test results
- iPhone 16e, latest iOS (as of Nov 2026). App added to the home screen from Chrome
  and run as a home-screen web app (iOS web apps always use WebKit, also from Chrome).
- 2026-11-01 field test: real saves to GitHub, offline queue + retry, and resuming
  after closing the app all worked. Screen Wake Lock keeps the screen on during the
  rest countdown.
- Web Audio beeps did not play (phone not in silent mode). The owner does not want
  sound: the rest timer is visual only. Do not add sound back.

## Workout flow
Choose exercise → weight → reps → rest. Choosing a rest starts a countdown and
immediately shows the next set's weight question (with suggested reps); the
countdown stays on top until the reps of that set are entered.

## Security model
- No dependencies, no build step. Only same-origin files plus `api.github.com`
  (enforced by the CSP meta tag in `index.html`; keep it strict).
- Never insert data as HTML: build DOM with `h()` / textContent only.
- The token lives only in the phone's localStorage. Never commit tokens, the owner's
  user/repo names, or any real log data. Tests use made-up data.
- All `<user>.github.io` Pages sites share one origin (and localStorage). The owner
  should not host other Pages sites on this account; clear only this app's keys.
- `sw.js` caches only same-origin app files, never API responses.

## Files
- `logic.js` – pure logic (CSV, log format, validation, suggestions). Unit-tested.
- `app.js` – UI, GitHub API, sync queue, rest timer.
- `index.html`, `style.css`, `manifest.webmanifest`, `sw.js`, `icon-*.png`.
- `tools/make_icons.py` – regenerates icons (stdlib only).
- Unit tests: `node --test`. Syntax check: `node --check app.js`.
- Browser test: `node e2e/run.cjs` (headless Chromium via the pre-installed Playwright,
  approved by the owner for testing only; it is not an app dependency). It serves the
  app locally, fakes the GitHub API and walks through a whole workout, offline queue,
  write conflict, XSS attempt and offline start. Run it after UI changes.
- Bump `CACHE` in `sw.js` when app files change.

## Log format (in the private repo)
`log/YYYY.csv`, columns `date,order,exercise,sets,note`; sets like
`77x20/60 101x20/60 101x20` (kg x reps / rest seconds after that set, `bw` =
bodyweight). The app appends rows; it never rewrites existing ones.
