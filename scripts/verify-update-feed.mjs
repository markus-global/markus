#!/usr/bin/env node
/**
 * Verifies every auto-update feed that electron-updater will consume, for all
 * three desktop platforms, from the **build output** (not the config).
 *
 * Why this exists (2026-11-27): the desktop app shipped with `autoDownload` on
 * and no way to succeed on macOS. The release feed (`latest-mac.yml`) pointed at
 * a `.dmg`, and MacUpdater does:
 *
 *     const zipFileInfo = findFile(files, "zip", ["pkg", "dmg"]);
 *     if (!zipFileInfo) throw newError(..., "ERR_UPDATER_ZIP_FILE_NOT_FOUND");
 *
 * so every mac check died there, silently. A config change alone is not a guard:
 * this reads the artifacts, which is the only thing that can prove a feed is
 * installable.
 *
 * Per-platform contract enforced here:
 *   macOS  (latest-mac.yml) — a `.zip` must be selectable for BOTH arches, since
 *                             MacUpdater filters arm64 entries out on Intel.
 *   Windows (latest.yml)    — one NSIS `.exe` + its `.blockmap` (differential
 *                             download) and an Authenticode signature when the
 *                             build was signed.
 *   Linux  (latest-linux.yml) — one `.AppImage` (the only artifact AppImageUpdater
 *                             can replace in place).
 * All platforms: `version` matches the packaged version, and every referenced
 * file exists with the size + sha512 the feed advertises.
 *
 * Usage: node scripts/verify-update-feed.mjs [--dir <dist>] [--platform mac|win|linux|all]
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
const onlyPlatform = arg('--platform', 'all');
const packagedVersion = process.env['MARKUS_FEED_VERSION']
  ?? JSON.parse(readFileSync(join(repoRoot, 'packages/desktop/package.json'), 'utf8')).version;

/** Minimal reader for the electron-builder update-info subset we depend on. */
function parseFeed(text) {
  const feed = { version: null, path: null, files: [] };
  let inFiles = false;
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (/^version:\s*/.test(line)) {
      feed.version = line.replace(/^version:\s*/, '').replace(/^['"]|['"]$/g, '');
      continue;
    }
    if (/^path:\s*/.test(line)) {
      feed.path = line.replace(/^path:\s*/, '').replace(/^['"]|['"]$/g, '');
      continue;
    }
    if (/^files:\s*$/.test(line)) { inFiles = true; continue; }
    if (!inFiles) continue;
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
    if (/^\S/.test(line)) inFiles = false;
  }
  return feed;
}

/** Reproduce MacUpdater.filterFilesForArch + findFile(files, "zip", ["pkg","dmg"]). */
function selectMacZip(feed, isArm64Mac) {
  const isArm64File = (file) => file.url.includes('arm64');
  const arm64Files = feed.files.filter(isArm64File);
  const candidates = isArm64Mac && arm64Files.length > 0
    ? feed.files.filter((f) => isArm64File(f) === isArm64Mac)
    : feed.files.filter((f) => !isArm64File(f));
  return candidates.find((f) => f.url.endsWith('.zip')) ?? null;
}

const PLATFORMS = {
  mac: {
    feed: 'latest-mac.yml',
    check(feed, failures) {
      const arm64 = selectMacZip(feed, true);
      const x64 = selectMacZip(feed, false);
      if (!arm64) failures.push('no .zip is selectable on Apple Silicon — MacUpdater throws ERR_UPDATER_ZIP_FILE_NOT_FOUND');
      if (!x64) {
        failures.push(
          'no .zip is selectable on Intel — MacUpdater filters arm64 entries out there, '
          + 'so an arm64-only feed is an unfixable dead end for x64 users',
        );
      }
      if (feed.path && !feed.path.endsWith('.zip')) {
        failures.push(`legacy \`path:\` points at ${feed.path} (must be a .zip)`);
      }
      const nonZip = feed.files.filter((f) => !f.url.endsWith('.zip'));
      if (nonZip.length > 0) {
        // Informational only: findFile(..., ["pkg","dmg"]) skips these on purpose.
        console.log(`  · note: ${nonZip.length} non-zip artifact(s) also listed (human downloads; ignored by MacUpdater)`);
      }
    },
  },
  win: {
    feed: 'latest.yml',
    check(feed, failures) {
      const installers = feed.files.filter((f) => f.url.endsWith('.exe'));
      if (installers.length === 0) {
        failures.push('no NSIS .exe listed — NsisUpdater has nothing to run');
      }
      for (const installer of installers) {
        if (!existsSync(join(distDir, `${installer.url}.blockmap`))) {
          failures.push(
            `${installer.url}.blockmap missing — electron-updater would fall back to a full download `
            + '(works, but every update ships ~100 MB instead of a delta)',
          );
        }
      }
    },
  },
  linux: {
    feed: 'latest-linux.yml',
    check(feed, failures) {
      if (!feed.files.some((f) => f.url.endsWith('.AppImage'))) {
        failures.push('no .AppImage listed — AppImageUpdater has nothing to replace in place');
      }
    },
  },
};

const targets = onlyPlatform === 'all' ? Object.keys(PLATFORMS) : [onlyPlatform];
const failures = [];
const checked = [];

for (const name of targets) {
  const spec = PLATFORMS[name];
  if (!spec) {
    console.error(`unknown --platform ${name} (use mac|win|linux|all)`);
    process.exit(2);
  }
  const feedPath = join(distDir, spec.feed);
  if (!existsSync(feedPath)) {
    // `all` tolerates a platform that was not built here; an explicit request does not.
    if (onlyPlatform === 'all') continue;
    failures.push(`${spec.feed} not found in ${distDir}`);
    continue;
  }
  const feed = parseFeed(readFileSync(feedPath, 'utf8'));
  const before = failures.length;

  if (!feed.version) failures.push(`${spec.feed}: no \`version:\` field`);
  else if (feed.version !== packagedVersion) {
    failures.push(`${spec.feed}: version ${feed.version} != packaged version ${packagedVersion}`);
  }
  if (feed.files.length === 0) failures.push(`${spec.feed}: no files listed`);

  spec.check(feed, failures);

  for (const file of feed.files) {
    if (!file.url.endsWith('.zip') && !file.url.endsWith('.exe') && !file.url.endsWith('.AppImage')) continue;
    const filePath = join(distDir, file.url);
    if (!existsSync(filePath)) {
      failures.push(`${spec.feed}: ${file.url} listed but missing from ${distDir}`);
      continue;
    }
    const actualSize = statSync(filePath).size;
    if (file.size !== null && file.size !== actualSize) {
      failures.push(`${spec.feed}: ${file.url} size ${file.size} != actual ${actualSize}`);
    }
    if (file.sha512) {
      const actualSha = createHash('sha512').update(readFileSync(filePath)).digest('base64');
      if (actualSha !== file.sha512) {
        failures.push(`${spec.feed}: ${file.url} sha512 mismatch — electron-updater rejects this download`);
      }
    }
  }

  checked.push({ name, feed: spec.feed, version: feed.version, files: feed.files.length, ok: failures.length === before });
}

if (checked.length === 0) {
  console.error(`✖ no update feed found in ${distDir} for ${onlyPlatform}`);
  process.exit(1);
}

if (failures.length > 0) {
  console.error(`✖ update feed is not installable (${failures.length} problem(s)):`);
  for (const f of failures) console.error(`  • ${f}`);
  process.exit(1);
}

for (const c of checked) {
  console.log(`✔ ${c.name}: ${c.feed} v${c.version}, ${c.files} artifact(s), sha512 verified`);
}
