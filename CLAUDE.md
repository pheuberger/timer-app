# CLAUDE.md

## Testing notes (non-obvious)

- There is no build/test tooling; smoke-test by serving the directory and driving it with Playwright + the pre-installed Chromium (`executablePath: /opt/pw-browsers/chromium`).
- The importmap loads three.js from unpkg.com, which sandbox network policy blocks. `npm install three@0.160.0` (registry.npmjs.org is allowed) and have the test server rewrite the importmap URLs in `index.html` to the local package.
- Launch Chromium with `--autoplay-policy=no-user-gesture-required`, otherwise the AudioContext stays suspended and none of the audio paths run.
- Playwright's `fill()` fails on the custom h/m/s inputs — they're collapsed behind the "Custom time" toggle and stay `hidden` in headless. Set `.value` via `page.evaluate` and dispatch an `input` event instead.
- Headless software WebGL renders frames slowly, so wall-clock assertions drift: a 2s timer can already read "Done" ~600ms after start because `evaluate` calls queue behind heavy frames. Assert on end state, not intermediate timing.
- Google Fonts requests fail in the sandbox — ignore those console errors.
