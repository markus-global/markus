# Security Policy

## Reporting a vulnerability

Please report security issues **privately**. Do not open a public issue, and do not
post details in Discord, X, or anywhere else before a fix is available.

- **GitHub private vulnerability reporting** — use the *Report a vulnerability*
  button on the repository's Security tab. This is the preferred channel.
- **Email** — `security@markus.global` if GitHub is not an option.

Please include: affected version/commit, the route or component involved, and steps
to reproduce. A proof of concept helps but is not required.

## What to expect

| Stage | Target |
|-------|--------|
| Acknowledgement | within 48 hours |
| Triage and severity assessment | within 7 days |
| Fix or a committed timeline | within 30 days for Critical/High |
| Progress updates | when something material changes, and at least weekly for Critical issues |

We will tell you when a patched release ships. We will not ask you to sign an NDA,
and we are happy to credit you — tell us the name and link you want used.

## Scope

In scope: the Markus application (API server, desktop shell, web UI, CLI, agent
runtime, storage) and the official build/release pipeline.

Out of scope: findings that require a compromised host or an already-authenticated
administrator to trigger; reports from automated scanners without a demonstrated
impact; social engineering; denial of service through sheer volume.

## Our own baseline

Markus ships a local-first API server. The invariants we hold ourselves to, and that
reports are measured against:

1. `/api/*` is deny-by-default — every route needs a session unless it is listed in
   the public allowlist (auth, health, gateway with its own bearer token, license).
   The corollary we got wrong once: an endpoint the login flow itself depends on
   must live under that allowlist, not under an authenticated prefix. The Hub
   connect handshake (`GET /api/auth/hub-connect-status`) is the poll that returns
   a finished Hub sign-in to a page that has no session yet; it carries the random
   per-attempt `cs_…` session id as its credential and never borrows the locally
   stored Hub token.
2. Interfaces that decide *what this machine can reach* (remote access, bind
   address, file writes to the local filesystem) are owner-only.
3. User-supplied workflow expressions are evaluated by a restricted evaluator, never
   by `eval`/`new Function`.
4. The API binds loopback by default; exposing it to a network is an explicit user
   decision.

If you find a place where one of these does not hold, that is a vulnerability — we
want to hear about it.
