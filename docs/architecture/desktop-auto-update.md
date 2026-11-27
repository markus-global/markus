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

- `latest.yml` + NSIS installer + `.blockmap` for differential download. Already
  working; no self-update code differs per platform beyond the guard.
- `oneClick: false` does **not** disable auto-update: electron-updater invokes the
  assisted installer with `/S` (silent).
- The running `.exe` cannot be replaced, so install happens after process exit.

### Linux

- AppImage: `latest-linux.yml` + in-place file replacement (requires the
  `APPIMAGE` env var, set by the AppImage runtime).
- deb/rpm distribution is the package manager's job — the app must not
  self-elevate.

## 3. Release gate

`scripts/verify-mac-update-feed.mjs` reads the **build output**, not the config,
and fails on every failure mode above:

```bash
node scripts/verify-mac-update-feed.mjs                # after a mac build
scripts/verify-mac-artifacts.sh [--require-developer-id]
```

Checks: 2 DMGs + 2 ZIPs, per-arch correctness (`lipo`), signatures
(`codesign --verify`), notarization (`spctl`, `stapler validate`, only with
`--require-developer-id`), and the feed (zip-only, both arches, sha512 and size
matching the files on disk).

It runs in:

- `.github/workflows/build-desktop-test.yml` — every PR (structure only).
- `.github/workflows/publish.yml` — every release, with `--require-developer-id`
  when the Apple certificate secret is present.

## 4. What a release must contain on macOS

Attached to the GitHub release and referenced by `latest-mac.yml`:

| Asset | Why |
|---|---|
| `Markus-<version>-arm64-mac.zip`, `Markus-<version>-mac.zip` | what Squirrel.Mac installs |
| `Markus-<version>-arm64.dmg`, `Markus-<version>.dmg` | human download from the website |
| `latest-mac.yml` | the feed both arches read |

Missing zip ⇒ macOS users can never auto-update, and the failure is invisible to
them. That is why the gate exists.

## 5. Verifying a change end to end

Ordered from cheapest to most authoritative — do not stop at the first green:

1. `pnpm --filter @markus/desktop build:typecheck` + `pnpm test` (state machine).
2. `pnpm test:web-ui` (`UpdateNotice` behaviour with the real locale files).
3. Build locally: `pnpm dist --mac --arm64 --x64 --publish never`, then
   `scripts/verify-mac-artifacts.sh`.
4. Real upgrade: install the previous release, point it at a feed containing the
   new build, confirm the version number actually changes after restart. This is
   the only step that proves the whole chain; steps 1–3 can be green while the
   installer still refuses.
