/**
 * Chromium proxy-rule translation.
 *
 * Deliberately free of any Electron import so it can be unit-tested in the plain
 * node environment: the rules are the one part of the "the panel follows the same
 * proxy as the backend" feature that can be wrong without anything crashing — a
 * mistranslated bypass entry silently sends some hosts through the proxy (or
 * bypasses it) and looks like a network problem, not a typo.
 *
 * Our documented `noProxy` syntax (Settings → 网络代理):
 *   - exact hostname            `api.internal`
 *   - `.suffix`                 `.corp.example`  (domain + subdomains)
 *   - CIDR                      `10.0.0.0/8`
 *
 * Chromium's `proxyBypassRules` syntax:
 *   - `<local>`                 implicit loopback / private ranges
 *   - `*.host.tld`              host and subdomains
 *   - CIDR                      supported as-is
 *   - bare hostname             supported as-is
 */

/** Map one documented noProxy entry to Chromium's bypass syntax. */
function toChromiumRule(raw: string): string {
  const rule = raw.trim();
  // `.corp.example` means "this domain and everything under it" for us; Chromium
  // spells that `*.corp.example`. Keeping the leading dot would make Chromium treat
  // it as a literal suffix match on a hostname that starts with a dot — never true.
  return rule.startsWith('.') ? `*${rule}` : rule;
}

/**
 * Build the full `proxyBypassRules` string for an embedded session.
 *
 * `<local>` is always first: the Settings UI documents loopback and private ranges
 * as bypassed by default, and Chromium will not infer that on its own once explicit
 * `proxyRules` are set.
 */
export function toChromiumBypassRules(noProxy: readonly string[]): string {
  const rules = noProxy
    .map(toChromiumRule)
    .filter((rule) => rule.length > 0);
  return ['<local>', ...rules].join(',');
}
