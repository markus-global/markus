import {
  ModelCatalogService,
  estimateQualityScore,
  tierFromQualityScore,
  costTierFromPrice,
} from '@markus/core';

// Simple JWT-lite using HMAC-SHA256 (no external deps required)
export async function signToken(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  return `${data}.${sigB64}`;
}

export async function verifyToken(token: string, secret: string): Promise<Record<string, unknown> | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const data = `${parts[0]}.${parts[1]}`;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const sigBytes = Uint8Array.from(atob(parts[2]!.replace(/-/g, '+').replace(/_/g, '/')), c =>
      c.charCodeAt(0)
    );
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(data));
    if (!valid) return null;
    const payload = JSON.parse(atob(parts[1]!)) as Record<string, unknown>;
    if (payload['exp'] && (payload['exp'] as number) < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

const PBKDF2_ITERATIONS = 10000;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = Array.from(salt)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256
  );
  const hashHex = Array.from(new Uint8Array(bits))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `pbkdf2:${PBKDF2_ITERATIONS}:${saltHex}:${hashHex}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts[0] !== 'pbkdf2') return false;
  let iterations: number;
  let saltHex: string;
  let expectedHash: string;
  if (parts.length === 4) {
    iterations = parseInt(parts[1]!, 10);
    saltHex = parts[2]!;
    expectedHash = parts[3]!;
  } else if (parts.length === 3) {
    iterations = 100000;
    saltHex = parts[1]!;
    expectedHash = parts[2]!;
  } else {
    return false;
  }
  const salt = Uint8Array.from((saltHex.match(/.{2}/g) ?? []).map(b => parseInt(b, 16)));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256
  );
  const hashHex = Array.from(new Uint8Array(bits))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return hashHex === expectedHash;
}

export function stripProviderPrefix(catalogId: string): string {
  return ModelCatalogService.stripProviderPrefix(catalogId);
}

interface ModelEnrichment {
  tier?: string;
  costTier?: string;
  capabilities?: string[];
  mode?: string;
}

export function enrichModelFromCatalog(
  modelId: string,
  builtinTier: string | undefined,
  catalog: ModelCatalogService | undefined,
): ModelEnrichment {
  const catalogEntry = catalog?.getModelInfo(modelId);
  const tier = builtinTier ?? tierFromQualityScore(
    estimateQualityScore(modelId, catalogEntry?.capabilities?.reasoning, catalogEntry?.inputCostPer1MTokens),
  );
  const costTier = catalogEntry
    ? costTierFromPrice(catalogEntry.inputCostPer1MTokens)
    : undefined;
  const capabilities = catalogEntry
    ? Object.entries(catalogEntry.capabilities)
        .filter(([, v]) => v)
        .map(([k]) => k)
    : undefined;
  const mode = catalogEntry?.mode;
  return { tier, costTier, capabilities, mode };
}

export function generateInviteToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const result: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = decodeURIComponent(part.slice(0, eqIdx).trim());
    const val = decodeURIComponent(part.slice(eqIdx + 1).trim());
    if (key) result[key] = val;
  }
  return result;
}
