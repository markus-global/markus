/**
 * Auth / wallet login URLs that should not be persisted as right-panel tabs.
 * Mirrors packages/desktop embedded-browser isAuthPopupUrl (magic / oauth hosts).
 */
export function isEphemeralAuthBrowserUrl(raw: string): boolean {
  const u = (raw || '').trim();
  if (!u || u === 'about:blank') return false;
  let hostname = '';
  let pathname = '';
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`);
    hostname = parsed.hostname.toLowerCase();
    pathname = parsed.pathname.toLowerCase();
  } catch {
    const lower = u.toLowerCase();
    return lower.includes('magic.link')
      || lower.includes('/oauth')
      || lower.includes('/authorize')
      || lower.includes('walletconnect');
  }

  if (
    hostname === 'magic.link'
    || hostname.endsWith('.magic.link')
    || hostname === 'privy.io'
    || hostname.endsWith('.privy.io')
    || hostname.endsWith('.walletconnect.com')
    || hostname === 'verify.walletconnect.com'
    || hostname === 'accounts.google.com'
    || hostname === 'appleid.apple.com'
    || hostname === 'login.microsoftonline.com'
    || hostname.endsWith('.auth0.com')
    || hostname.endsWith('.okta.com')
    || hostname.endsWith('.clerk.accounts.dev')
    || hostname.endsWith('.dynamic.xyz')
    || hostname.endsWith('.web3auth.io')
  ) {
    return true;
  }

  return pathname.includes('/oauth')
    || pathname.includes('/authorize')
    || pathname.includes('/auth/login')
    || pathname.includes('/auth/callback')
    || pathname.includes('/auth/connect');
}
