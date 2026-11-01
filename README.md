# Gym Log

A small phone web app for logging gym workouts into a CSV file in your own
(private) GitHub repository. It suggests the next exercise, the weight, reps and
rest from your history, so most entries are a single tap.

- Plain HTML/CSS/JavaScript, no third-party code, no build step, no server.
- Data goes straight from the phone to the GitHub API; nothing else is contacted.
- Works offline: entries are queued on the phone and saved when the connection returns.

## Setup
1. Enable GitHub Pages for this repo: Settings → Pages → Deploy from a branch → `main` / root.
2. Create a fine-grained personal access token: only your log repository,
   Repository permissions → Contents: Read and write, with an expiry date.
3. Open the Pages URL on the phone, add it to the home screen, and enter the
   user, repository, branch and token in Settings.

## Development
`node --test` runs the unit tests (Node's built-in runner).
