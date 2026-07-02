---
sidebar_position: 2
---

# Remote Access

This guide covers several methods to expose your Markus instance to the internet securely.

## Cloudflare Tunnel (Recommended)

Cloudflare Tunnel creates an encrypted tunnel without opening firewall ports.

### Setup

1. Install `cloudflared` on your server.
2. Authenticate with your Cloudflare account:

```bash
cloudflared tunnel login
```

3. Create and route a tunnel:

```bash
cloudflared tunnel create markus
cloudflared tunnel route dns markus markus.yourdomain.com
```

4. Create a config file at `~/.cloudflared/config.yml`:

```yaml
tunnel: <tunnel-uuid>
credentials-file: /root/.cloudflared/<tunnel-uuid>.json

ingress:
  - hostname: markus.yourdomain.com
    service: http://localhost:8056
  - service: http_status:404
```

5. Start the tunnel as a systemd service:

```bash
cloudflared service install
```

## Tailscale

Tailscale creates a secure WireGuard mesh network. Install it on both your server and client devices, then access Markus via the server's Tailscale IP (e.g., `http://100.x.x.x:8056`).

No extra configuration is needed — Tailscale handles auth and encryption automatically.

## FRP / ngrok

### ngrok (Quick Testing)

```bash
ngrok http 8056
```

This exposes a temporary `https://<random>.ngrok.io` URL — useful for demos and testing only.

### FRP (Self-Hosted)

FRP consists of a **server** (frps) and a **client** (frpc).

**Server** (`frps.toml`):
```toml
bindPort = 7000
```

**Client** (`frpc.toml`):
```toml
serverAddr = "your-server-ip"
serverPort = 7000

[[proxies]]
name = "markus"
type = "tcp"
localIP = "127.0.0.1"
localPort = 8056
remotePort = 8056
```

Then access Markus at `http://your-server-ip:8056`.

---

**Recommendation:** Use Cloudflare Tunnel for production — it's free, secure, and requires no open ports.
