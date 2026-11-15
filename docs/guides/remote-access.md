# Remote Access Guide

> **Architecture v2 — "bring your own tunnel".** Earlier versions routed all remote
> traffic through a single Markus-operated VPS (signal server + TURN + in-band
> HTTP/WS proxy). That is gone. Your tunnel carries the data; Markus Hub only
> provides the **entry domain**, an **endpoint registry**, and a **login gate**.
>
> Normative interface: [`docs/architecture/remote-access.md`](../architecture/remote-access.md) (frozen, T1).
> Shared types: `packages/remote/src/contract.ts`. UI logic: `packages/web-ui/src/lib/remoteAccess.ts`.

---

## 0. What changed

| | Old (v1) | New (v2) |
|---|---|---|
| Data path | through our Relay/TURN VPS | **your own tunnel** (Cloudflare / Tailscale / your proxy) |
| Cost/quality | on us, single choke point | on the tunnel provider's free tier; scales with you |
| Public address | our relay | a tunnel hostname you own or get for free |
| Hub's job | signal + relay + proxy | entry domain + endpoint registry + auth gate |
| Public entry | relay URL | `https://{user}.remote.markus.global` → **302** to your tunnel after login |

The remote access section of the app is now an **onboarding wizard**: pick a
method, run (or delegate) the setup, watch six steps, then share a ready link.

---

## 1. Architecture

```
Your phone / laptop
        │  1. open  https://{user}.remote.markus.global
        ▼
Markus Hub  ── 2. login gate (Hub session cookie, Domain=.markus.global)
        │
        │  3. 302 redirect → your registered public URL
        ▼
Your tunnel  (cloudflared / tailscale / your proxy)
        │
        ▼
Your local Markus  (http://127.0.0.1:8056, the local api-server)
```

* **No traffic passes through Markus servers.** Hub never proxies the data — it
  answers one request with a `302`.
* **Hub keeps an endpoint registry** (`remote_endpoints`): which local install
  owns which public URL, health, and a server-side encrypted secret used to
  verify ownership. The local agent registers on startup and on address change.
* **Ownership is proven** with a challenge–response handshake (the Hub calls your
  tunnel at `verifyPath` and expects the `verifyToken`), with strict SSRF
  protection on the target address.

---

## 2. Connection methods

The wizard shows every method with **门槛 / 稳定性 / 账号? / 域名?** badges and a
live **binary-detected ✓** marker (`cloudflared` / `tailscale` found on this
machine).

| Method | Public address | Account | Domain needed | Setup | Stability |
|---|---|---|---|---|---|
| **Cloudflare Quick Tunnel** | random `*.trycloudflare.com` | no | no | easy | address changes on restart |
| **Cloudflare Named Tunnel** ★ | your own domain | yes | yes | moderate | stable |
| **Tailscale Funnel** | `*.ts.net` (public) | yes | no | easy | stable |
| **Tailscale Serve** | tailnet only (not public) | yes | no | easy | stable |
| **Custom relay / proxy** | whatever you run (frp, ngrok, nginx…) | — | — | advanced | depends on you |

★ **Recommended for long-term use** — a named tunnel gives you a stable address.

> **Mainland China:** Cloudflare and Tailscale free tiers can be unstable.
> A self-hosted **FRP** relay is usually the better choice there.

---

## 3. Setup — path A: run it yourself

Choose a method, then copy the commands for your platform (the wizard offers
macOS / Linux / Windows). When they are running, click **"I've run it"**.

### 3.1 Cloudflare Quick Tunnel (fastest to try)

```bash
brew install cloudflared                      # macOS
# or: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
cloudflared tunnel --url http://127.0.0.1:8056
```

`cloudflared` prints an `https://<random>.trycloudflare.com` URL. The wizard
picks it up, registers it, verifies it, and turns **Ready**.

> The random hostname changes every restart — Markus detects the change and
> updates the registry automatically (the entry link stays the same).

### 3.2 Cloudflare Named Tunnel (stable, recommended)

```bash
cloudflared tunnel login
cloudflared tunnel create markus
cloudflared tunnel route dns markus markus.example.com
cloudflared tunnel run --url http://127.0.0.1:8056 markus
```

You now have a **fixed** hostname on your own domain.

### 3.3 Tailscale Funnel (public, stable)

```bash
tailscale up
tailscale funnel 8056
# → https://<machine>.<tailnet>.ts.net
```

### 3.4 Tailscale Serve (private — tailnet only, no public exposure)

```bash
tailscale serve 8056
```

Nothing is published to the internet; only your own devices can reach it.

### 3.5 Custom relay (frp / ngrok / nginx)

Run your own reverse proxy pointing at `http://127.0.0.1:8056`, then either let
the wizard discover it, or use **"Enter address manually"** in the failure state
and paste the public HTTPS URL. The Hub will verify it the same way.

---

## 4. Setup — path B: let an Agent do it

Choose the method, then **"Let an Agent do it"**. An Agent installs the binary,
starts the tunnel, and reports status back into the same wizard — you watch the
same six steps. (Agent runtime lands in T10; until then the panel tells you it is
unavailable and points you at path A.)

---

## 5. The setup wizard (six steps)

```
install → start → resolve address → register → verify → ready
```

| Step | What happens |
|---|---|
| **Install** | the binary is present (or you installed it) |
| **Start** | the tunnel process is running |
| **Resolve address** | the public URL is parsed from the tunnel's output |
| **Register** | the endpoint is written to the Hub registry |
| **Verify** | Hub proves ownership (challenge–response) and checks SSRF safety |
| **Ready** | you can share the link |

Status arrives live over the WebSocket (`remote:status`), so the wizard advances
without a page refresh.

---

## 6. Ready panel

Once ready, the panel shows two things — **they are different addresses**:

* **Share this entry** — `https://{user}.remote.markus.global`
  Give **this** to people. It needs a Hub login and is protected by the auth
  gate. Copy button + QR code included.
* **Actual tunnel address** — your real tunnel hostname (e.g. `*.trycloudflare.com`).
  This is what the `302` redirects *to*. After login, your browser's address bar
  will show **this** domain, not `remote.markus.global` — that is expected.

Liveness is shown as **● Online / Degraded / ({{ms}} ms latency)**, with three
actions: **[Restart] [Rotate address] [Turn off]**.

---

## 7. Abnormal states

The wizard never fails silently.

| Symptom | What you see | What to do |
|---|---|---|
| Tunnel dropped after being ready | **"Reconnecting…"** (auto-retry, page updates on recovery) | wait; or **Restart** |
| Verification failed | explicit reason + **Retry** + **Enter address manually** | retry, or paste the URL if discovery got it wrong |
| Address unreachable / blocked | reason `unreachable` + hint | your network may block it — **switch method** |
| Token mismatch | reason spelled out | the address may belong to someone else — re-run setup |
| `cloudflared`/`tailscale` missing | badge shows **not found**, commands warn | run the install command first |

Verification failure reasons surface verbatim from the contract
(`verifyReasonUnreachable`, `non_https`, `blocked_target`, `too_many_redirects`,
`response_too_large`, `token_mismatch`, `malformed_response`).

---

## 8. Security boundary — **read this**

A tunnel exposes your local Markus **directly to the internet**. The entry gate
protects the *entry domain*; anyone who learns your **tunnel address** reaches
Markus directly. Treat it as a public server:

1. **Always set a password** on your local Markus before exposing it.
2. **Put an identity layer in front of the tunnel** — strongly recommended:
   * **Cloudflare Access** (Zero Trust) for cloudflared tunnels, or
   * **Tailscale ACLs**, or use **Tailscale Serve** (tailnet-only, not public).
3. Keep `cloudflared` / `tailscale` updated; rotate the tunnel if you suspect a leak.
4. The Hub stores only an **encrypted secret** (server-side) to verify you own the
   endpoint — it never receives your traffic or your data.

---

## 9. Honest limits

* **The address bar jumps to your tunnel domain** after login. The pretty entry
  link is a front door, not the room.
* **Free tunnels are rate-limited** and are not meant for heavy traffic.
* **Quick tunnels change hostname on restart.** We auto-sync the registry, but
  anyone you gave the *tunnel* address (not the entry link) will need the new one.
* **Mainland China:** Cloudflare/Tailscale free tiers may be unstable — use FRP.
* The legacy WebRTC relay path is retained only as a migration fallback for
  existing installs; it is not offered for new setups.

