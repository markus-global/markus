"use strict";

// Custom Windows code-signer for electron-builder, backed by Certum's
// "Code Signing in the Cloud" (SimplySign) certificate via the `ssign` client.
//
// electron-builder calls this once per file that needs signing — the app
// executable (Markus.exe), nested helper .exe files pulled in via asarUnpack
// (e.g. node-pty's OpenConsole.exe), the NSIS uninstaller, and the final
// installer — signing each in place with an RFC3161 timestamp. Because signing
// happens inside electron-builder's pipeline, the .blockmap and latest.yml are
// generated from the already-signed installer, so electron-updater stays
// consistent. (DLLs / .node addons are intentionally NOT signed — that is
// electron-builder's default and the industry norm.)
//
// Already-signed vendor binaries (OpenConsole.exe ships Microsoft-signed) must
// be skipped: ssign refuses to assemble a second signature ("file already has
// a signature"). Keeping the vendor Authenticode is correct for those helpers.
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
const fs = require("node:fs");

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

/**
 * True when the PE already has an Authenticode certificate table.
 * Avoids burning a SimplySign login on vendor-signed helpers that ssign
 * cannot re-sign (error: "file already has a signature").
 */
function peHasAuthenticode(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const header = Buffer.alloc(4096);
    const n = fs.readSync(fd, header, 0, header.length, 0);
    if (n < 0x40 || header.readUInt16LE(0) !== 0x5a4d) return false; // MZ

    const peOffset = header.readUInt32LE(0x3c);
    const need = peOffset + 24 + 112; // COFF + PE32+ optional with data dirs
    let buf = header;
    if (need > n) {
      buf = Buffer.alloc(need);
      fs.readSync(fd, buf, 0, need, 0);
    }
    if (buf.length < peOffset + 6) return false;
    if (buf.readUInt32LE(peOffset) !== 0x00004550) return false; // PE\0\0

    const optionalMagic = buf.readUInt16LE(peOffset + 24);
    // PE32 = 0x10b (data dirs at +96 from optional start → pe+120)
    // PE32+ = 0x20b (data dirs at +112 from optional start → pe+136)
    let certDirOffset;
    if (optionalMagic === 0x20b) certDirOffset = peOffset + 24 + 144; // DataDirectory[4]
    else if (optionalMagic === 0x10b) certDirOffset = peOffset + 24 + 128;
    else return false;

    if (buf.length < certDirOffset + 8) return false;
    const certTableRva = buf.readUInt32LE(certDirOffset);
    const certTableSize = buf.readUInt32LE(certDirOffset + 4);
    return certTableRva !== 0 && certTableSize !== 0;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function isAlreadySignedError(err) {
  const msg = `${err && err.message ? err.message : err}`;
  // ssign prints the cause on stderr (stdio inherit); Node's error is usually
  // just "Command failed". Also match the cause text if ever captured.
  return /already has a signature/i.test(msg);
}

exports.default = async function sign(configuration) {
  const file = configuration.path;

  if (!process.env.CERTUM_EMAIL || !process.env.CERTUM_OTP) {
    console.warn(`[sign] CERTUM_EMAIL/CERTUM_OTP not set — leaving ${file} UNSIGNED`);
    return;
  }

  if (peHasAuthenticode(file)) {
    console.log(`[sign] skip (already Authenticode-signed): ${file}`);
    return;
  }

  const ssign = process.env.SSIGN_PATH || "ssign";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await waitForFreshWindow();
    const win = windowOf(Date.now());
    lastLoginWindow = win; // reserve this window even if the run fails

    console.log(`[sign] signing ${file} (attempt ${attempt}/${MAX_ATTEMPTS})`);
    try {
      // Capture stderr so "file already has a signature" can be treated as skip
      // even if the PE probe missed an edge case.
      execFileSync(ssign, [file], {
        stdio: ["ignore", "inherit", "pipe"],
        env: process.env,
        encoding: "utf8",
      });
      return;
    } catch (e) {
      const stderr = e && e.stderr ? String(e.stderr) : "";
      if (stderr) process.stderr.write(stderr);
      if (isAlreadySignedError(e) || /already has a signature/i.test(stderr)) {
        console.log(`[sign] skip (ssign: already signed): ${file}`);
        return;
      }
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`[sign] failed to sign ${file} after ${MAX_ATTEMPTS} attempts: ${e.message}`);
      }
      console.warn(`[sign] attempt ${attempt} failed (${e.message}); retrying in the next TOTP window`);
    }
  }
};
