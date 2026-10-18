# Remote Access — Why It Is Slow, and a Fast-Path Plan

Status: proposal · Author: CTO · Date: 2026-10-17

## 1. Executive summary

The current remote-access path is not "a bit slow" — it is **structurally wrong for the
use case**. Every single HTTP request from a browser on the same LAN as the Markus host
leaves the local network, crosses the Pacific to a Cloudflare edge in Los Angeles, comes
back across the Pacific, and only then reaches the host.

Measured on the owner's machine (2026-10-17, Shanghai, China Telecom):

| Path | TTFB (single request) | 10 concurrent requests | Throughput |
|---|---|---|---|
| `127.0.0.1:8056` (loopback) | 0.55–0.77 ms | — | ~1.3 GB/s |
| `192.168.8.101:8056` (LAN) | **4.4–5.5 ms** | **0.03 s** | line rate |
| `*.trycloudflare.com` (current) | **1190–1710 ms** | **2.70 s** | **289 KB/s (~2.3 Mbps)** |

Edge selection, measured from the same host:

```
$ curl -s https://www.cloudflare.com/cdn-cgi/trace | grep -E 'colo|loc'
ip=112.96.228.108
colo=LAX
loc=CN
```

`colo=LAX` while both endpoints are in Shanghai. The SPA's main bundle is 2.15 MB; it
takes **7.45 s** to load over the tunnel versus 1.6 ms locally.

Root cause classification: **the system has exactly one path, and that path is chosen by a
third party's anycast routing and never adapts.** This is a path-selection problem, not a
protocol-tuning problem.

## 2. How a Cloudflare Tunnel actually routes

`cloudflared` opens outbound, long-lived connections to the Cloudflare edge, resolved from
`region1.v2.argotunnel.com` / `region2.v2.argotunnel.com` and steered by the ISP's anycast
routing. That edge becomes the **permanent anchor** of the tunnel. From this network the
anchor is Los Angeles.

A browser request then travels:

```
browser → nearest CF PoP (LAX for this ISP) → CF backbone → tunnel anchor (LAX)
        → QUIC/TCP session → cloudflared → 127.0.0.1:8056
```

Two consequences:

1. **The China↔US last mile is paid on every request**, even for a visitor sitting in the
   same room. Measured TTFB ≈ 1.2 s is consistent with 2× ~220 ms RTT plus international
   link congestion; 289 KB/s is the congested trans-Pacific bottleneck, not a tunnel limit.
2. **A visitor in another region does not help the tail.** They reach their nearest PoP
   quickly, but the final leg is always LAX→China.

### What does *not* fix it

| Change | Fixes latency? | Why |
|---|---|---|
| `cloudflare_named` (own domain) | **No** | Same anchor, same last mile. It fixes address **stability**, not speed. |
| `tailscale_funnel` | **No** | Funnel is a **relay** ingress, not a peer connection. |
| `--protocol quic` vs `http2` | Marginally | The default is already `auto` (QUIC first, HTTP/2 fallback). It cannot remove the Pacific round trip. |
| Pinning `region*.v2.argotunnel.com` to a Hong Kong CF IP | Maybe, but fragile | Unsupported community trick; CF may reroute; breaks silently. Not shippable. |

## 3. What UU Remote does (and what we cannot copy)

UU Remote's speed comes from **path length**, not from a miracle codec:

1. **P2P direct first** — ICE/STUN hole punching picks the shortest path between the two
   peers; if a direct path exists it is used, and the data never touches a relay.
2. **Relay fallback** — when hole punching fails (symmetric NAT / CGNAT), traffic falls
   back to NetEase's **domestic BGP relay fleet**, which is close to both ends.
3. **UDP private transport** — avoids TCP head-of-line blocking; forward error correction
   instead of retransmission stalls.
4. **Adaptive video pipeline** — hardware encode, frame pacing, bitrate adaptation.

Crucial distinction: **UU Remote ships a native client on both ends.** It does not serve a
web page to a browser.

**A browser cannot do this.** Browsers speak HTTP/HTTPS/WebSocket, and WebRTC data
channels cannot transparently wrap an existing TLS web app. So "make the browser go
peer-to-peer" is not a realistic option. The two things that *do* give UU-like latency to
a browser are:

- **(a) a native/mesh layer on the client device** (WireGuard: Tailscale, NetBird, etc.), or
- **(b) a relay placed physically near both ends** (a VPS in Hong Kong / Singapore / a
  mainland node).

## 4. Target design: tiered path selection

Replace "one hardcoded path" with "**pick the fastest reachable path, and say which one is
in use**".

| Tier | Path | Expected latency | Throughput | Prerequisite |
|---|---|---|---|---|
| **T0** | LAN direct `http://<lan-ip>:<port>` | 4–5 ms | line rate | same Wi-Fi/LAN |
| **T1** | WireGuard mesh direct (`tailscale_serve` / NetBird) | 5–30 ms | uplink-bound | client installed on both ends |
| **T2** | Nearby relay (FRP / rathole on HK/SG VPS, `custom` kind) | 30–60 ms | VPS bandwidth | one VPS + domain |
| **T3** | Cloudflare tunnel (`cloudflare_quick` / `_named`) | 1200–1700 ms | ~289 KB/s | zero config |

T3 stays — it is the only tier that works for **sharing a public link with a stranger who
installs nothing**. It should simply stop being the *only* option and stop being the
*default* for the owner's own devices.

### Honesty requirement

The UI must display the **active tier and its measured cost**, e.g.
`Path: LAN · 4.6 ms` or `Path: Cloudflare LAX · 1280 ms`. A user who is told "remote access
is on" while every click costs 1.3 s will (correctly) conclude the product is broken.

## 5. Implementation plan

### P0 — Verify and surface what we already have (1–2 days)

The LAN tier and the WireGuard tier largely exist and were never verified:

- `192.168.8.101:8056` already answers `200 {"status":"ok"}` at 4.6 ms — the server is
  already bound to `*:<port>`. **This works today and is not exposed anywhere in the UI.**
- `tailscale_serve` is implemented (`packages/remote/src/providers/tailscale.ts`) but
  flagged unverified in the handoff doc.

Work:
1. Local address discovery (mDNS/Bonjour `_markus._tcp` + interface enumeration) and a
   "LAN access" card in Settings → Remote Access showing `http://<lan-ip>:<port>`.
2. Auth/cookie behaviour on plain-HTTP LAN origins (`Secure` flag must not be required;
   document the trust boundary: anyone on the LAN can reach the page, so the local login
   must stay mandatory).
3. Real-hardware verification of `tailscale_serve` and a **direct-vs-relay indicator**
   (`tailscale status --json` → `Relay: "direct"` or a DERP name). Surface it, do not fake it.

### P1 — Make the tunnel path measurable and honest (2–3 days)

1. `GET /api/diag/net` returning `cf-ray`, `colo`, `tcp/tls/ttfb` timings for the local
   port; the settings panel renders the active path + measured latency.
2. Probe-based tier selection with a documented preference order and a manual override.
3. Front-end payload work (independent of network tier, benefits all of them):
   - main bundle is **2.15 MB** — code splitting + Brotli; target < 700 KB initial.
   - batch/parallelise the startup API fan-out; one cold load currently issues many
     sequential calls, each paying a full round trip.
   - WebSocket instead of polling for run/agent state.

### P2 — Add the nearby-relay tier (1–2 weeks)

1. Harden the `custom` kind: health check, URL stability, `X-Forwarded-Proto` handling,
   and a one-command FRP/rathole recipe in the setup guide.
2. Setup wizard step: "I have a VPS → here is the 3-line config".
3. Optional: managed relay for users without a VPS (cost decision, see §6).

### P3 — Not recommended: build our own P2P stack

ICE/STUN/TURN + UDP transport + FEC + a relay fleet is months of work, still needs relays
for CGNAT, and **cannot serve a browser**. WireGuard mesh delivers ~90 % of the benefit for
a fraction of the cost.

## 6. Risks and open decisions

| Item | Honest assessment |
|---|---|
| **China CGNAT** | Both China Telecom/Unicom mobile and many home links are CGNAT. Hole punching for T1 may fail; the fallback (DERP) is overseas and can be as slow as today's tunnel. Must be measured per-network, not assumed. |
| **Mainland relay** | Serving a website from a mainland VPS on 80/443 requires ICP filing. HK/SG avoids it at 30–60 ms. |
| **Cost** | T2 needs ~$5–15/month VPS. A managed remote-access relay is a product decision, not an engineering one. |
| **Quick tunnels** | Documented by Cloudflare as testing-oriented, no SLA, may be rate-limited. Fine for demos, not for "this is my production access". |
| **TLS on T0/T1** | Plain HTTP on LAN/tailnet means no browser-trusted cert. Acceptable inside a trusted network if the app's own login stays mandatory; do not silently downgrade the public tiers. |

## 7. Recommendation

1. **Today**: expose T0 (LAN). It is already working at 4.6 ms and costs almost nothing to
   surface. This alone removes the "remote access feels broken" complaint for the
   at-home case.
2. **This week**: verify T1 (`tailscale_serve`) on real hardware and add the
   direct-vs-relay indicator. For the owner's own devices this is the UU-like experience
   without writing a single line of transport code.
3. **Next**: P1 measurement + payload work; then T2 for public sharing at usable speed.
4. **Keep T3** strictly as the zero-install/public-link tier, and label it as such in the UI.

Decision needed from the owner: whether T2 is a **self-hosted recipe** (user brings a VPS)
or a **managed relay** (we operate it, product cost + compliance).
