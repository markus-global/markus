"use strict";

// Custom Windows code-signer for electron-builder, backed by Certum's
// "Code Signing in the Cloud" (SimplySign) certificate via the `ssign` client.
//
// electron-builder calls this once per file that needs signing — the app
// executable (Markus.exe), the NSIS uninstaller, and the final installer —
// signing each in place with an RFC3161 timestamp. Because signing happens
// inside electron-builder's pipeline, the .blockmap and latest.yml are
// generated from the already-signed installer, so electron-updater stays
// consistent. (DLLs / .node addons are intentionally NOT signed — that is
// electron-builder's default and the industry norm.)
//
// TOTP window handling — the important bit:
//   `ssign` performs one SimplySign OAuth login per run, using a 6-digit TOTP
//   code derived from CERTUM_OTP. That code is only valid for a ~30s window,
//   and Certum rejects reusing the same code for a second login. Since each
//   file is a separate `ssign` run, two runs inside the same 30s window would
//   compute the SAME code and the second login would fail. To avoid that we
//   remember the window of the last login and, if the next sign would fall in
//   it, wait for the next window so every login gets a fresh code. (Signing
//   itself is unlimited within Certum's session; only the login is rate-bound.)
//
// Environment (set by CI):
//   SSIGN_PATH    absolute path to ssign(.exe); falls back to "ssign" on PATH
//   CERTUM_EMAIL  SimplySign login email
//   CERTUM_OTP    TOTP seed (base32 from the SimplySign QR code) — long-lived,
//                 treat like a private key
//
// When the credentials are absent (forks, local `--dir` builds, dry runs) the
// file is left unsigned instead of failing the build.
const { execFileSync } = require("node:child_process");

const TOTP_WINDOW_MS = 30_000;
// Fire slightly after the window boundary so the freshly-rolled code has its
// full lifetime left when ssign logs in.
const POST_BOUNDARY_BUFFER_MS = 1_500;
const MAX_ATTEMPTS = 3;

// Persisted across calls within the single electron-builder process.
let lastLoginWindow = -1;

const windowOf = ts => Math.floor(ts / TOTP_WINDOW_MS);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Block until we're in a TOTP window we haven't logged in with yet.
async function waitForFreshWindow() {
  while (windowOf(Date.now()) === lastLoginWindow) {
    const nextBoundary = (lastLoginWindow + 1) * TOTP_WINDOW_MS;
    const waitMs = nextBoundary - Date.now() + POST_BOUNDARY_BUFFER_MS;
    console.log(`[sign] waiting ${Math.ceil(waitMs / 1000)}s for a fresh TOTP window`);
    await sleep(Math.max(waitMs, 250));
  }
}

exports.default = async function sign(configuration) {
  const file = configuration.path;

  if (!process.env.CERTUM_EMAIL || !process.env.CERTUM_OTP) {
    console.warn(`[sign] CERTUM_EMAIL/CERTUM_OTP not set — leaving ${file} UNSIGNED`);
    return;
  }

  const ssign = process.env.SSIGN_PATH || "ssign";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await waitForFreshWindow();
    const win = windowOf(Date.now());
    lastLoginWindow = win; // reserve this window even if the run fails

    console.log(`[sign] signing ${file} (attempt ${attempt}/${MAX_ATTEMPTS})`);
    try {
      // ssign reads CERTUM_EMAIL / CERTUM_OTP from the environment and signs in
      // place with a Certum RFC3161 timestamp. Inherit stdio so failures surface.
      execFileSync(ssign, [file], { stdio: "inherit", env: process.env });
      return;
    } catch (e) {
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`[sign] failed to sign ${file} after ${MAX_ATTEMPTS} attempts: ${e.message}`);
      }
      console.warn(`[sign] attempt ${attempt} failed (${e.message}); retrying in the next TOTP window`);
    }
  }
};
