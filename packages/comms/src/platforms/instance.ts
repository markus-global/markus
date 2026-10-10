/**
 * `BotInstance` — one configured bot on one platform.
 *
 * ── Why this exists (issue #340 → messaging-gateway.md §4) ───────────────────
 *
 * A **platform** is a manifest (`registry.ts`): a declarative record of the
 * fields it needs, the capabilities it offers and the adapter factory that
 * speaks its wire protocol. A **bot instance** is one *configuration* of that
 * manifest with credentials — the thing that actually connects.
 *
 * Before this concept existed, "the platform" *was* the bot identity: the router
 * keyed adapters by platform and the `integrations` table was keyed by
 * `(org, platform)`, so an org could physically hold one Telegram bot and no
 * more — a second registration silently overwrote the first. With instances,
 * "5 Telegram bots" is five instances, each with its own credentials, each
 * mapping to whatever agent it serves. `platform` stays the manifest id; an
 * instance never redefines the platform.
 */

import type { PlatformCapabilities } from './registry.js';

export interface BotInstance {
  /**
   * Stable, unique per bot. Real instance rows carry their `platform_instances`
   * id (`bi_…`). The implicit legacy bot — a platform that has no instance row —
   * uses the **platform id** as its instance id, which is exactly the single
   * connection slot every pre-instance build had.
   */
  id: string;
  /** Manifest id, e.g. `telegram`. */
  platform: string;
  /** Human label; unique per `(orgId, platform, label)` in storage. */
  label: string;
  /** Resolved credentials + platform fields (manifest fields + preserved extras). */
  config: Record<string, unknown>;
  /** Manifest capabilities, optionally narrowed by the instance row. */
  capabilities: PlatformCapabilities;
  /** Whether startup should connect it. */
  enabled: boolean;
}
