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
- Test: `node --test`. Syntax check: `node --check app.js`.

## Log format (in the private repo)
`log/YYYY.csv`, columns `date,order,exercise,sets,note`; sets like
`77x20/60 101x20/60 101x20` (kg x reps / rest seconds after that set, `bw` =
bodyweight). The app appends rows; it never rewrites existing ones.
