/**
 * Apply Hub Admin-configured recommended models into local LLM routing.
 *
 * Greenfield (new install): may set defaultProvider=markus and fill empty/invalid slots.
 * Upgrade (existing BYOK): only fills empty/obsolete slots; never changes defaultProvider
 * unless force=true (user clicked "Restore Markus recommendations").
 */

import type {
  CapabilityModelAssignment,
  CapabilityRoutingConfig,
  ModelCapabilityType,
} from '@markus/shared';

export const RECOMMENDED_CAPABILITY_KEYS: ModelCapabilityType[] = [
  'text',
  'image_recognition',
  'image_generation',
  'audio_tts',
  'audio_stt',
  'video_generation',
];

export type HubRecommendations = Partial<Record<ModelCapabilityType, string | null | undefined>>;

/**
 * True when a model id is empty or not a usable OpenRouter slug for Markus Provider.
 * Markus Provider expects OR slugs (e.g. `deepseek/deepseek-v4-flash`).
 * Bare `markus-*` ids (no `/`) are never valid.
 */
export function isObsoleteMarkusModel(model: string | undefined | null): boolean {
  if (!model || !model.trim()) return true;
  const m = model.trim();
  if (/^markus-/i.test(m) && !m.includes('/')) return true;
  return false;
}

export interface LlmConfigSnapshot {
  defaultProvider?: string;
  providers?: Record<string, { apiKey?: string; authType?: string } | undefined>;
  routingDefaultModel?: { provider: string; model: string } | null;
  capabilityRouting?: CapabilityRoutingConfig | null;
}

/**
 * True when the user has no third-party BYOK/OAuth and has not customized
 * routing away from factory defaults — safe to make Markus the default.
 */
export function isGreenfieldLlmConfig(llm: LlmConfigSnapshot): boolean {
  const providers = llm.providers ?? {};
  for (const [name, p] of Object.entries(providers)) {
    if (name === 'markus') continue;
    if (!p) continue;
    if (typeof p.apiKey === 'string' && p.apiKey.trim().length > 0) return false;
    if (p.authType === 'oauth') return false;
  }

  const dp = llm.defaultProvider;
  // Factory default in DEFAULT_CONFIG is `anthropic`. Anything else (except
  // markus / empty) means the user already chose a provider.
  if (dp && dp !== 'anthropic' && dp !== 'markus') return false;

  if (llm.routingDefaultModel?.provider && llm.routingDefaultModel?.model) {
    if (!isObsoleteMarkusModel(llm.routingDefaultModel.model)) return false;
  }

  const assignments = llm.capabilityRouting?.assignments ?? {};
  for (const [cap, a] of Object.entries(assignments)) {
    if (!a?.model) continue;
    if (cap && !isObsoleteMarkusModel(a.model)) return false;
  }

  return true;
}

export interface ApplyRecommendedOptions {
  force?: boolean;
  /** When true (and not force), also set defaultProvider=markus. */
  greenfield?: boolean;
}

export interface ApplyRecommendedResult {
  changed: boolean;
  defaultProvider?: string;
  routingDefaultModel?: { provider: string; model: string };
  capabilityRouting: CapabilityRoutingConfig;
  markusActiveModel?: string;
}

function shouldWriteAssignment(
  existing: CapabilityModelAssignment | undefined,
  force: boolean,
): boolean {
  if (force) return true;
  if (!existing?.model) return true;
  return isObsoleteMarkusModel(existing.model);
}

/**
 * Merge Hub recommendations into a routing snapshot. Does not touch other providers.
 */
export function applyHubRecommendedRouting(
  current: {
    defaultProvider?: string;
    routingDefaultModel?: { provider: string; model: string } | null;
    capabilityRouting?: CapabilityRoutingConfig | null;
  },
  recs: HubRecommendations,
  opts: ApplyRecommendedOptions = {},
): ApplyRecommendedResult {
  const force = !!opts.force;
  const greenfield = !!opts.greenfield;
  const assignments: CapabilityRoutingConfig['assignments'] = {
    ...(current.capabilityRouting?.assignments ?? {}),
  };
  let changed = false;
  let routingDefaultModel = current.routingDefaultModel ?? undefined;
  let markusActiveModel: string | undefined;
  let defaultProvider: string | undefined;

  if (force || greenfield) {
    if (current.defaultProvider !== 'markus') {
      defaultProvider = 'markus';
      changed = true;
    }
  }

  const textId = recs.text?.trim() || null;
  if (textId) {
    const rdm = routingDefaultModel;
    const needsRdm = force
      || !rdm?.model
      || isObsoleteMarkusModel(rdm.model)
      || (greenfield && rdm.provider !== 'markus');
    if (needsRdm) {
      routingDefaultModel = { provider: 'markus', model: textId };
      markusActiveModel = textId;
      changed = true;
    }
  }

  for (const cap of RECOMMENDED_CAPABILITY_KEYS) {
    if (cap === 'text') continue;
    const modelId = recs[cap]?.trim() || null;
    const existing = assignments[cap];
    if (!modelId) {
      // Hub has no recommendation for this capability — leave the slot empty.
      // Clear previous Markus-sourced / force / greenfield assignments so we do
      // not keep factory defaults (gpt-image-1, aura-2, …) that paint Settings red.
      // Preserve non-Markus (BYOK) picks unless force restore.
      const wasMarkus = existing?.provider === 'markus';
      if (existing?.model && (force || greenfield || wasMarkus)) {
        delete assignments[cap];
        changed = true;
      }
      continue;
    }
    if (!shouldWriteAssignment(existing, force)) continue;
    assignments[cap] = { provider: 'markus', model: modelId };
    changed = true;
  }

  return {
    changed,
    defaultProvider,
    routingDefaultModel: routingDefaultModel ?? undefined,
    capabilityRouting: { assignments },
    markusActiveModel,
  };
}

/** Build Hub live catalog URL from a Hub base (e.g. http://localhost:3003). */
export function markusCatalogUrlFromHub(hubUrl: string): string {
  return `${hubUrl.replace(/\/+$/, '')}/api/models/live/markus`;
}

/**
 * True when a URL looks like a Worker proxy base (should live in `proxyUrl`,
 * not OpenRouter `baseUrl`). Empty is treated as missing OR base.
 */
export function isLegacyMarkusProxyBaseUrl(baseUrl: string | undefined | null): boolean {
  if (!baseUrl) return true;
  return /localhost:8787|127\.0\.0\.1:8787|workers\.dev|markus-proxy/i.test(baseUrl);
}

/** Derive Hub `/api/models/recommended` URL from a live catalog modelsUrl. */
export function recommendedUrlFromModelsUrl(modelsUrl: string): string | null {
  try {
    const u = new URL(modelsUrl);
    // .../api/models/live/markus → .../api/models/recommended
    u.pathname = u.pathname.replace(/\/models\/live\/[^/]+\/?$/, '/models/recommended');
    if (!u.pathname.includes('/models/recommended')) {
      u.pathname = u.pathname.replace(/\/?$/, '') + '/api/models/recommended';
    }
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

export async function fetchHubRecommendations(
  modelsUrlOrHubBase: string,
): Promise<{ recommendations: HubRecommendations; region?: string } | null> {
  let url = modelsUrlOrHubBase;
  if (!url.includes('/models/recommended')) {
    if (url.includes('/models/live/')) {
      url = recommendedUrlFromModelsUrl(url) ?? url;
    } else {
      url = modelsUrlOrHubBase.replace(/\/+$/, '') + '/api/models/recommended';
    }
  }
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as {
      recommendations?: HubRecommendations;
      region?: string;
    };
    return {
      recommendations: data.recommendations ?? {},
      region: data.region,
    };
  } catch {
    return null;
  }
}
