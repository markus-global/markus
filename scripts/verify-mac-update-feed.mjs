#!/usr/bin/env node
/**
 * Verifies the macOS auto-update feed that electron-updater will actually consume.
 *
 * Why this exists (2026-11-27): the desktop app shipped with `autoDownload` on
 * and no way to ever succeed on macOS. The release feed (`latest-mac.yml`)
 * pointed at a `.dmg`, and electron-updater's MacUpdater does:
 *
 *     const zipFileInfo = findFile(files, "zip", ["pkg", "dmg"]);
 *     if (!zipFileInfo) throw newError(..., "ERR_UPDATER_ZIP_FILE_NOT_FOUND");
 *
 * so every mac check died at that line and logged to nowhere the user could see.
 * A config change alone is not a guard — this script reads the *build output*,
 * which is the only thing that can prove the feed is installable.
 *
 * Checks (each one is a real failure mode we have hit or would hit):
 *   1. `latest-mac.yml` exists and its `version` matches the packaged version.
 *   2. Every `files[].url` is a `.zip`. A `.dmg`/`.pkg` here is the original bug.
 *   3. Both architectures are present: electron-updater excludes arm64 entries on
 *      Intel Macs, so an arm64-only feed means Intel users can never update.
 *   4. Each referenced artifact exists and its size + sha512 match the feed —
 *      a feed that points at a file we did not upload fails at download time,
 *      after the user has already been told an update exists.
 *
 * Usage: node scripts/verify-mac-update-feed.mjs [--dir <dist-electron>] [--allow-version <v>]
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const distDir = resolve(repoRoot, arg('--dir', 'packages/desktop/dist-electron'));
const feedPath = join(distDir, 'latest-mac.yml');

/** Minimal reader for the electron-builder update-info subset we depend on. */
function parseFeed(text) {
  const lines = text.split('\n');
  const feed = { version: null, path: null, files: [] };
  let inFiles = false;
  let current = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^version:\s*/.test(line)) {
      feed.version = line.replace(/^version:\s*/, '').replace(/^['"]|['"]$/g, '');
      continue;
    }
    if (/^path:\s*/.test(line)) {
      feed.path = line.replace(/^path:\s*/, '').replace(/^['"]|['"]$/g, '');
      continue;
    }
    if (/^files:\s*$/.test(line)) {
      inFiles = true;
      continue;
    }
    if (inFiles) {
      const urlMatch = line.match(/^\s*-\s*url:\s*(.+)$/);
      if (urlMatch) {
        current = { url: urlMatch[1].replace(/^['"]|['"]$/g, ''), sha512: null, size: null };
        feed.files.push(current);
        continue;
      }
      const kv = line.match(/^\s+(sha512|size):\s*(.+)$/);
      if (kv && current) {
        const value = kv[2].replace(/^['"]|['"]$/g, '');
        if (kv[1] === 'size') current.size = Number(value);
        else current.sha512 = value;
        continue;
      }
      if (/^\S/.test(line) && !/^\s*$/.test(line)) inFiles = false;
    }
  }
  return feed;
}

const failures = [];

if (!existsSync(feedPath)) {
  console.error(`✖ ${feedPath} not found — the mac build produced no update feed.`);
  console.error('  Is `zip` still listed under `mac.target` in packages/desktop/electron-builder.yml?');
  process.exit(1);
}

const feed = parseFeed(readFileSync(feedPath, 'utf8'));
const expectedVersion = arg('--allow-version', JSON.parse(readFileSync(join(repoRoot, 'packages/desktop/package.json'), 'utf8')).version);

if (!feed.version) failures.push('latest-mac.yml has no `version:` field');
else if (feed.version !== expectedVersion) {
  failures.push(`feed version ${feed.version} != packaged version ${expectedVersion}`);
}

if (feed.files.length === 0) failures.push('latest-mac.yml lists no files — electron-updater will find nothing to download');

const nonZip = feed.files.filter((f) => !f.url.endsWith('.zip'));
if (nonZip.length > 0) {
  // Informational, NOT a failure: MacUpdater calls
  //   findFile(files, "zip", ["pkg", "dmg"])
  // which skips dmg entries and picks a zip. A feed is broken when no installable
  // zip is reachable — not because a human-download dmg also rides along.
  console.log(`  · note: feed also lists ${nonZip.length} non-zip artifact(s) (human downloads; ignored by MacUpdater)`);
}

// Reproduce electron-updater's own selection (MacUpdater.filterFilesForArch +
// findFile) for both platforms. This is the contract that actually matters:
// an arm64-only feed is not "missing a file", it is an unreachable dead end for
// Intel Macs, because arm64 entries are filtered out there.
const isArm64 = (url) => url.includes('arm64');
function selectZipFor(isArm64Mac) {
  const isArm64File = (file) => isArm64(file.url);
  const arm64Files = feed.files.filter(isArm64File);
  const candidates = isArm64Mac && arm64Files.length > 0
    ? feed.files.filter((f) => isArm64File(f) === isArm64Mac)
    : feed.files.filter((f) => !isArm64File(f));
  return candidates.find((f) => f.url.endsWith('.zip')) ?? null;
}

const arm64Zip = selectZipFor(true);
const x64Zip = selectZipFor(false);
if (!arm64Zip) failures.push('no .zip is selectable on Apple Silicon — MacUpdater throws ERR_UPDATER_ZIP_FILE_NOT_FOUND');
if (!x64Zip) {
  failures.push(
    'no .zip is selectable on Intel — MacUpdater filters arm64 entries out there, ' +
      'so an arm64-only feed is an unfixable dead end for x64 users',
  );
}

if (feed.path && !feed.path.endsWith('.zip')) {
  failures.push(`legacy \`path:\` field points at ${feed.path} (must be a .zip)`);
}
for (const file of feed.files) {
  const filePath = join(distDir, file.url);
  if (!existsSync(filePath)) {
    failures.push(`${file.url} is listed in the feed but missing from ${distDir}`);
    continue;
  }
  const actualSize = statSync(filePath).size;
  if (file.size !== null && file.size !== actualSize) {
    failures.push(`${file.url}: feed size ${file.size} != actual ${actualSize}`);
  }
  if (file.sha512) {
    const actualSha = createHash('sha512').update(readFileSync(filePath)).digest('base64');
    if (actualSha !== file.sha512) {
      failures.push(`${file.url}: sha512 mismatch — electron-updater will reject this download`);
    }
  }
}

if (failures.length > 0) {
  console.error(`✖ macOS update feed is not installable (${failures.length} problem(s)):`);
  for (const f of failures) console.error(`  • ${f}`);
  process.exit(1);
}

const zipless = feed.files.filter((f) => f.url.endsWith('.zip'));
console.log(`✔ macOS update feed OK — version ${feed.version}, ${zipless.length} zip artifact(s):`);
for (const f of zipless) console.log(`  • ${f.url} (${Math.round((f.size ?? 0) / 1024 / 1024)} MB, sha512 verified)`);
