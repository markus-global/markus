# Streaming bubble "animated border disappeared": focus mistaken for visibility

Date: 2026-10-08 · Branch: `feat/ui-optimize-1008` · Status: fixed

## Symptom

In the right-hand panel (Team Chat side panel), a turn that is generating:

- the bubble **is visible** (rounded corners, background — all there), but the **rotating sweep border** is
  gone / not rotating;
- the **body text keeps growing in real time**;
- switching to another conversation tab and back sometimes "seemed to fix it", then it went static again.

## Root cause

`animationBudget.ts` had one pause predicate that answered two different questions.

```js
function shouldPause() {
  if (document.visibilityState !== 'visible' || document.hidden) return true;
  return !document.hasFocus();        // ← the defect
}
```
```css
html[data-anim-paused='true'] *, …::before, …::after { animation-play-state: paused !important; }
```

**`!document.hasFocus()` does not imply "the user cannot see this page."** The right panel is an Electron
`WebContentsView` (`packages/desktop/src/embedded-browser.ts`): whenever the user's focus is **anywhere else
inside the same app** (say, the chat composer), this embedded document counts as "unfocused" while the panel
stays **fully visible**. So `data-anim-paused` was **permanently true** for the panel, freezing every
animation inside it.

The consequence was amplified by the ring being a conic-gradient painted on `::after`:

- `::after` still painted → the border **looked present**;
- `border-rotate` was paused and `--border-angle` sat at `0deg` → **it did not rotate**;
- the body is driven by React state → **it kept growing**.

Hence "the border is gone but the content keeps growing". The same predicate also froze the exec-card's
rotating border and every `data-anim-tick` indicator (measured on that page: `data-anim-tick` was `null`,
the tick had never started).

### Live A/B experiment (CDP, single variable)

| | `.streaming-bubble::after` playState | animations on page |
|---|---|---|
| With `data-anim-paused` | `paused` | 2 (all paused) |
| Attribute removed (same millisecond) | `running` | 14 (all running) |

### That comment was stale

The original comment claimed "this build disables Chromium's own occlusion throttling
(`--disable-features=MacWebContentsOcclusion`)", which is why focus stood in as a proxy. **A repo-wide grep
(build scripts included) finds no such switch and no `backgroundThrottling` setting whatsoever** → Chromium's
default throttling is in effect, and `visibilityState` is already accurate for occlusion, minimising and tab
switching. The P0 CPU win is preserved by Chromium itself; `!hasFocus()` was pure collateral damage.

## Design

**Delete the mechanism rather than add a guard**: the pause predicate keeps only the signal that actually
answers "is this page on screen".

```js
function shouldPause() {
  return document.visibilityState !== 'visible' || document.hidden;
}
```

- remove the `!document.hasFocus()` clause;
- remove the now-dead `focus` / `blur` listeners (less code);
- keep `visibilitychange` and `pageshow` (the latter guards against a stale visibility state after wake).

The win is **free**: no more proxy, ask Chromium directly.

## Tests

`packages/web-ui/test/animationBudget.test.ts` — run **red** first (4 failed, exactly the cases that had the
wrong invariant baked in), then corrected:

- `Regression 2026-10-08: page visible but unfocused — do not pause` (the incident guard; the old assertion
  pointed the other way)
- `Regression 2026-10-08: blur / focus do not change the pause state`
- `Window hidden: carries data-anim-paused and does not start the tick at all` (unchanged)
- listener assertions: `focus` / `blur` must be **0**

Results: that file 11/11 green; `npx vitest run --project web-ui` → **793/793 green (50 files)**;
`tsc --noEmit` → 0 errors.

## Residuals (honest)

1. **Occlusion fallback**: if `MacWebContentsOcclusion` were ever re-enabled (or the panel given
   `backgroundThrottling: false`), a window covered by another foreground window but **not minimised** could
   still report `visibilityState === 'visible'`, and animations would keep running. Under the current
   predicate that is "visible but unwatched" at a bounded cost (tick at 4Hz); driving it to zero would need a
   more authoritative occlusion signal.
2. **Merge not done**: `.streaming-bubble::after` is still a per-frame CSS animation (unlike
   `.exec-card-active`, which already moved to the 4Hz tick). Moving it would cut style recalcs during
   streaming from ~120/s to ~4/s, but the ring would jump in 8 steps (visibly choppy). **Deliberately not
   done** — between "smooth" and "background power saving" we keep the look first. If a real
   background-drain complaint shows up during streaming, revisit.

## Rollback

File-level: `git checkout` these two files. No data migration.

```
packages/web-ui/src/animationBudget.ts
packages/web-ui/test/animationBudget.test.ts
```
