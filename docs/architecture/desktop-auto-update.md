# Desktop auto-update

How the Markus desktop app detects, downloads and installs a new version on each
platform, and what must be true for a release to be installable.

This is the authoritative document for the update path. If code and this page
disagree, the code wins and this page gets a PR in the same change (see
[docs/README.md](../README.md)).

---

## 1. Ownership: one writer per surface

| Surface | Who decides "there is an update" | Who installs it |
|---|---|---|
| Packaged desktop app (dmg / exe / AppImage) | `packages/desktop/src/updater.ts` (single writer of `UpdateState`) | `electron-updater` (`autoUpdater.quitAndInstall`) |
| MAS build | Apple App Store | App Store |
| Browser / LAN access to the server | `/health.updateAvailable` (npm registry version of `@markus-global/cli`) | nobody — the banner links to the website |

Two rules make that table hold:

1. **No second caller of `electron-updater`.** `ipc-handlers.ts` and `menu.ts`
   only call `updater.ts` (`checkForUpdatesNow`, `getUpdateState`,
   `installUpdateNow`). A direct `import('electron-updater')` anywhere else is a
   regression: it bypasses the state machine, the MAS/unpackaged guards, and the
   renderer notification.
2. **The website-link banner is a fallback, not a parallel truth.**
   `web-ui`'s `UpdateNotice` renders the native lifecycle; the legacy banner in
   `App.tsx` is gated behind `!hasDesktopUpdater()`, so a desktop user never sees
   "download from the website" while a real installer is available.

### State machine

`packages/desktop/src/update-policy.ts` (pure, unit-tested) defines:

```
idle ──checking──▶ checking ──available──▶ downloading ──progress──▶ downloading
                                             │
                                             └──downloaded──▶ ready   (terminal until installed)
   any ──error──▶ error ──checking──▶ checking          ready is NEVER downgraded by error/not-available
```

`ready` being terminal is deliberate: a transient network failure after a
successful download must not hide an update the user could install right now.

### Scheduling

- First check 10 s after launch, then every 4 h (`BASE_CHECK_INTERVAL_MS`).
- On consecutive failures the interval doubles, capped at 24 h
  (`nextCheckIntervalMs`). A permanently broken feed must not retry at full rate
  forever.
- The timer is `unref()`ed — polling never keeps the process alive.

### Install policy

- `autoDownload = true`, `autoInstallOnAppQuit = true`: download in the
  background, apply on quit.
- The user can apply immediately via the "Restart to update" button (→
  `installUpdateNow()` → `quitAndInstall(false, true)`).
- `MARKUS_UPDATE_DEBUG=1` logs every transition and forwards electron-updater's
  own logger to the console. This is the only supported way to diagnose
  "the update never arrives" on a user's machine.
- Errors are **not** shown to the user as a banner; a background check that fails
  must not nag. They are logged, and the next check clears the state.

### Platform support matrix

`resolveUpdaterSupport()` in `update-policy.ts` is the single decision point. It
returns a **reason** when it says no, so the log explains itself:

| Platform / mode | Runs? | Why |
|---|---|---|
| macOS, packaged, non-MAS | yes | Squirrel.Mac + `latest-mac.yml` |
| Windows, packaged | yes | `NsisUpdater` + `latest.yml` |
| Linux, packaged, launched from an AppImage | yes | `AppImageUpdater` (needs `$APPIMAGE`) |
| Linux, packaged, deb/rpm install | **no** (`no-appimage-env`) | nothing writable to replace in place |
| MAS build | **no** (`mas`) | App Store owns updates |
| Unpackaged (`electron .`) | **no** (`unpackaged`) | no `app-update.yml` feed → ENOENT |

### Channel policy: stable vs candidate

`channelPolicy(currentVersion)` in `update-policy.ts` is the entire "who gets what"
rule. The channel follows the **installed build** (the Chrome Beta / VS Code
Insiders / Firefox Beta model) — there is no global toggle:

| Running build | Sees | Installs |
|---|---|---|
| stable `0.12.4` | stable releases only | silently, when the app quits |
| candidate `0.12.5-rc.N` | the next candidate **and** the stable release of the same base version | only when the user clicks **Restart to update** |

Two rules produce that table, and both were learned the hard way:

1. **A candidate must not install silently** (`installOnQuit: false`). A broken
   candidate replacing a working build while the user is away is exactly the kind
   of surprise that makes people distrust auto-update. Download stays in the
   background; the switch is the user's.
2. **A candidate must be able to graduate** (`probeStableFirst: true`). The GitHub
   provider only matches tags whose prerelease label equals the running one, so an
   installed `0.12.5-rc.1` would otherwise *never* see `0.12.5` — it would track
   `-rc.*` forever, and once those are deleted it would throw
   `ERR_UPDATER_NO_PUBLISHED_VERSIONS`. Each check therefore probes the stable feed
   first (`allowPrerelease = false`), graduates when the stable version is newer,
   and only then falls back to the candidate feed.

Consequence for testing: a **stable** install cannot see a candidate at all
(GitHub's `latest` excludes prereleases), so exercising the chain on a candidate
requires installing `rc.N` by hand once and then publishing `rc.N+1`.

## 2. Platform requirements

### macOS

- **The feed must point at a `.zip`.** `MacUpdater` calls
  `findFile(files, "zip", ["pkg", "dmg"])` and throws
  `ERR_UPDATER_ZIP_FILE_NOT_FOUND` otherwise. `dmg` alone is not installable —
  this was the actual state of the v0.12.4 feed.
- **Both architectures must be in one `latest-mac.yml`.** `MacUpdater` filters
  entries by arch (`filterFilesForArch`): arm64 Macs prefer arm64 entries, Intel
  Macs exclude them. An arm64-only feed is a dead end for Intel users. Hence
  **one** CI job builds `--mac --arm64 --x64`; two jobs would each write the same
  filename and the last upload would win.
- **Developer ID signature + notarization.** Squirrel.Mac rejects a bundle whose
  identity does not match the running app; Gatekeeper blocks an un-notarized
  replacement. `electron-builder.yml` sets `hardenedRuntime: true` and
  `notarize: true`; `scripts/verify-mac-artifacts.sh --require-developer-id`
  enforces the result on every release.
- **The app must live in `/Applications`.** A bundle run from the mounted DMG is
  translocated and cannot be swapped. The updater detects this
  (`app.isInApplicationsFolder()`) and the UI asks the user to move the app
  instead of offering a button that would fail.
- MAS builds never self-update (`shouldStartUpdater` → `isMas` guard) —
  Guideline 2.4.5.

### Windows

- `latest.yml` + NSIS installer + `.blockmap` for differential download.
- `oneClick: false` does **not** disable auto-update: electron-updater invokes the
  assisted installer with `/S` (silent). Per-user install (`perMachine: false`)
  means no UAC prompt.
- The running `.exe` cannot be replaced, so install happens after process exit.
- Gate: `node scripts/verify-update-feed.mjs --platform win` — the feed must name
  an `.exe` and that `.exe`'s `.blockmap` must exist (missing blockmap still
  works, but every update becomes a ~100 MB full download instead of a delta).

### Linux

- AppImage only: `latest-linux.yml` + in-place replacement of the file named by
  `$APPIMAGE`. Started from anywhere else (deb/rpm/tar.gz) the updater reports
  `no-appimage-env` and does nothing — by design, not a silent failure.
- deb/rpm distribution is the package manager's job; the app must not self-elevate.
- Gate: `node scripts/verify-update-feed.mjs --platform linux` — the feed must
  name an `.AppImage`.

### 3. Release gate

`scripts/verify-update-feed.mjs` reads the **build output**, not the config, and
fails on every failure mode above. It covers all three platforms:

```bash
node scripts/verify-update-feed.mjs --platform mac|win|linux|all
scripts/verify-mac-artifacts.sh [--require-developer-id|--require-notarized]   # mac extras
```

Checks: per-platform artifact selectable (zip per arch / exe + blockmap /
AppImage), version matches the packaged version, sha512 + size matching the files
on disk; on mac additionally 2 DMGs + 2 ZIPs, per-arch `lipo`, `codesign
--verify`, and optionally Gatekeeper + stapled-ticket validation.

It runs in:

- `.github/workflows/build-desktop-test.yml` — every PR (structure only, all
  platforms).
- `.github/workflows/publish.yml` — every release, with `--require-developer-id
  --require-notarized` on mac when the Apple certificate secret is present.

## 4. Where the feed lives (and the two channels)

Builds shipped from 0.12.5-rc.4 onwards read the feed from **our own domain**, not
from GitHub:

```
publish: generic  →  https://markus.global/releases/
```

The website wildcard-forwards `/releases/*` to the R2 bucket (verified
2026-11-27: `/releases/any-name` → 307 → `www.markus.global/releases/any-name` →
`pub-*.r2.dev/releases/any-name`; a missing object 404s at R2). Two consequences
worth keeping in mind:

1. **The storage backend is invisible to the client.** Attaching a custom domain
   later (required before wide rollout — Cloudflare positions `r2.dev` as
   non-production) changes only the website rule; no app build is involved.
2. **Channel = file name, same directory.** `channelPolicy` selects the channel,
   and electron-updater resolves `<channel><platform>.yml`:

| Channel | macOS | Windows | Linux |
|---|---|---|---|
| stable | `latest-mac.yml` | `latest.yml` | `latest-linux.yml` |
| candidate | `rc-mac.yml` | `rc.yml` | `rc-linux.yml` |

A candidate must **never** write `latest*.yml` or `meta.json`: that would hand
every stable user an rc and make `install.sh` advertise it as the latest stable.

### GitHub Release is still published (and that is not a "double-write period")

Builds shipped *before* the generic-provider switch have `provider: github` baked
into their `app-update.yml`, and that cannot be changed from outside. GitHub
Releases therefore keep being published by the workflow, which means:

| Installed build | Reads | Dies out |
|---|---|---|
| ≤ 0.12.5-rc.3 (provider: github) | the GitHub Release feed | when it upgrades to a build that reads R2 |
| ≥ 0.12.5-rc.4 (provider: generic) | `markus.global/releases/` | — |

Both channels carry the same artifacts from the same release run, so nothing has
to be coordinated and no extra release is needed: the old channel simply empties
itself as installs move forward. Which channel a machine uses is determined by
its bundled `app-update.yml`, **not** by its version number.

## 5. What a release must contain on macOS

Attached to the GitHub release and referenced by `latest-mac.yml`:

| Asset | Why |
|---|---|
| `Markus-<version>-arm64-mac.zip`, `Markus-<version>-mac.zip` | what Squirrel.Mac installs |
| `Markus-<version>-arm64.dmg`, `Markus-<version>.dmg` | human download from the website |
| `latest-mac.yml` | the feed both arches read |

Missing zip ⇒ macOS users can never auto-update, and the failure is invisible to
them. That is why the gate exists.

## 6. Verifying a change end to end

Ordered from cheapest to most authoritative — do not stop at the first green:

1. `pnpm --filter @markus/desktop build:typecheck` + `pnpm test` (state machine).
2. `pnpm test:web-ui` (`UpdateNotice` behaviour with the real locale files).
3. Build locally: `pnpm dist --mac --arm64 --x64 --publish never`, then
   `scripts/verify-mac-artifacts.sh`.
4. Real upgrade: install the previous release, point it at a feed containing the
   new build, confirm the version number actually changes after restart. This is
   the only step that proves the whole chain; steps 1–3 can be green while the
   installer still refuses.
