# Remote Access Guide

This guide covers how to make your local Markus instance accessible from the internet — for remote team collaboration, external agent (OpenClaw) integration, or mobile access.

---

## Quick Comparison

| Method | Setup Time | Requires Domain | Requires Public Server | Security | Best For |
|--------|-----------|-----------------|----------------------|----------|----------|
| **Cloudflare Tunnel** | 5 min | Yes (free) | No | High (built-in WAF + DDoS) | Recommended default |
| **Tailscale** | 3 min | No | No | Very High (WireGuard mesh) | Private team access |
| **FRP** | 15 min | Optional | Yes (need a VPS) | Medium | China mainland, self-hosted |
| **ngrok** | 2 min | No | No | Medium | Quick demos / testing |

---

## Option 1: Cloudflare Tunnel (Recommended)

Zero-trust tunnel — no open inbound ports, free HTTPS, built-in DDoS protection. Works with WebSocket out of the box.

### Prerequisites

- A domain name (can use a free one via Cloudflare registrar)
- A free Cloudflare account

### Setup

```bash
# 1. Install cloudflared
# macOS
brew install cloudflared
# Linux
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared

# 2. Authenticate with Cloudflare
cloudflared tunnel login

# 3. Create a tunnel
cloudflared tunnel create markus

# 4. Route your subdomain to the tunnel
cloudflared tunnel route dns markus markus.yourdomain.com

# 5. Create config file
mkdir -p ~/.cloudflared
cat > ~/.cloudflared/config.yml << 'EOF'
tunnel: markus
credentials-file: ~/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: markus.yourdomain.com
    service: http://localhost:8056
  - service: http_status:404
EOF

# 6. Run the tunnel
cloudflared tunnel run markus
```

### Run as a System Service (Recommended)

```bash
# Install as a system service so it auto-starts
sudo cloudflared service install
```

### Access Markus

Once the tunnel is running, visit `https://markus.yourdomain.com` from anywhere.

### Add Authentication with Cloudflare Access (Optional but Recommended)

1. Go to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. Navigate to **Access > Applications > Add an application**
3. Set the application domain to `markus.yourdomain.com`
4. Add an authentication policy (e.g., email OTP, Google SSO, GitHub SSO)

This adds a login page in front of your Markus instance — even before traffic reaches your server.

---

## Option 2: Tailscale (Best for Private Teams)

Creates a WireGuard-based mesh VPN. Every device gets a stable IP. No ports exposed to the public internet at all.

### Setup

```bash
# 1. Install Tailscale on your server
# macOS
brew install tailscale
# Linux
curl -fsSL https://tailscale.com/install.sh | sh

# 2. Start and authenticate
sudo tailscale up

# 3. Note your Tailscale IP
tailscale ip -4
# e.g., 100.64.x.x

# 4. Start Markus normally
pnpm dev
```

### Access Markus

Each team member installs Tailscale on their device and joins the same Tailnet. Then access:

```
http://100.64.x.x:8056    # API
http://100.64.x.x:8057    # Web UI (dev mode)
```

### Enable HTTPS (Optional)

```bash
# Tailscale provides free HTTPS certificates for your machine name
tailscale cert your-machine.tailnet-name.ts.net

# Then access via:
# https://your-machine.tailnet-name.ts.net:8056
```

### Share with External Users (Tailscale Funnel)

```bash
# Expose port 8056 to the public internet through Tailscale's infrastructure
tailscale funnel 8056
```

This gives you a public URL like `https://your-machine.tailnet-name.ts.net/`.

---

## Option 3: FRP (Best for China Mainland / Self-Hosted)

If you have a VPS with a public IP (e.g., Alibaba Cloud, Tencent Cloud), FRP is a reliable and fast option.

### Server Side (VPS with public IP)

```bash
# Download frps
wget https://github.com/fatedier/frp/releases/latest/download/frp_0.61.1_linux_amd64.tar.gz
tar xzf frp_*.tar.gz
cd frp_*

# Create frps config
cat > frps.toml << 'EOF'
bindPort = 7000
auth.token = "your-secret-token-change-me"

# Dashboard (optional)
webServer.addr = "0.0.0.0"
webServer.port = 7500
webServer.user = "admin"
webServer.password = "admin"

vhostHTTPPort = 80
vhostHTTPSPort = 443
EOF

# Run
./frps -c frps.toml
```

### Client Side (Your Machine Running Markus)

```bash
# Download frpc
# macOS: brew install frpc
# Or download from https://github.com/fatedier/frp/releases

cat > frpc.toml << 'EOF'
serverAddr = "your-vps-ip"
serverPort = 7000
auth.token = "your-secret-token-change-me"

[[proxies]]
name = "markus-api"
type = "tcp"
localIP = "127.0.0.1"
localPort = 8056
remotePort = 8056

[[proxies]]
name = "markus-web"
type = "tcp"
localIP = "127.0.0.1"
localPort = 8057
remotePort = 8057
EOF

./frpc -c frpc.toml
```

### Access Markus

```
http://your-vps-ip:8056    # API
http://your-vps-ip:8057    # Web UI
```

For HTTPS, add nginx with Let's Encrypt on your VPS as a reverse proxy.

---

## Option 4: ngrok (Quick Testing)

Simplest setup for temporary access. Not recommended for production.

```bash
# Install
brew install ngrok   # macOS
# or: snap install ngrok   # Linux

# Authenticate (free account at ngrok.com)
ngrok config add-authtoken <your-token>

# Expose Markus API
ngrok http 8056
```

ngrok gives you a random URL like `https://abc123.ngrok-free.app`. Share it for testing.

---

## Security Checklist

Before exposing Markus to the internet, ensure:

- [ ] **Change the admin password** — complete the onboarding wizard to set your own credentials, or set `ADMIN_PASSWORD` in your `.env` or `markus.json` (initial default is `markus123`)
- [ ] **Change the gateway secret** — set `GATEWAY_SECRET` in your `.env` (default is `markus-gateway-default-secret-change-me`)
- [ ] **Use HTTPS** — Cloudflare Tunnel and Tailscale provide this automatically; for FRP, add nginx + Let's Encrypt
- [ ] **Enable authentication layer** — Cloudflare Access (free), Tailscale ACLs, or nginx basic auth in front
- [ ] **Review CORS** — current default allows all origins (`*`); for production, restrict to your domain
- [ ] **Firewall** — do not expose ports 8056/8058 directly to `0.0.0.0`; always use a tunnel or reverse proxy

### Recommended Architecture

```
Internet
    │
    ▼
┌─────────────────────────┐
│  Cloudflare / Tailscale │  ← TLS termination + auth
│  (Zero-trust tunnel)    │
└────────────┬────────────┘
             │ (localhost only)
             ▼
┌─────────────────────────┐
│  Markus API (:8056)     │  ← HTTP + WebSocket
│  Markus Web UI (:8057)  │  ← Vite dev / static files
│  Comm Adapter (:8058)   │  ← Internal only
└─────────────────────────┘
```

---

## External Agent (OpenClaw) Gateway Access

If you need external AI agents to connect to your Markus instance:

1. Expose only the API port (8056) via your chosen tunnel method
2. Set a strong `GATEWAY_SECRET` in your environment
3. External agents register via `POST /api/gateway/register` and authenticate via `POST /api/gateway/auth`
4. All gateway communication uses HMAC-SHA256 signed Bearer tokens with 24-hour expiry
5. See [API Reference](./API.md) for full gateway endpoint documentation

---

## FAQ

**Q: Can I run Markus on a cloud VPS directly?**
A: Yes. Deploy with Docker (`deploy/docker-compose.yml`), then put nginx or Caddy in front for HTTPS. No tunnel needed since the VPS already has a public IP.

**Q: Which option works best in China?**
A: FRP with a domestic cloud VPS (Alibaba Cloud / Tencent Cloud). Cloudflare and Tailscale may have connectivity issues behind the GFW.

**Q: Can I combine Tailscale + Cloudflare?**
A: Yes. Use Tailscale for daily team access (zero-config, fast), and Cloudflare Tunnel for public-facing endpoints (external agents, webhooks).

**Q: Do I need a domain name?**
A: Only for Cloudflare Tunnel. Tailscale, FRP, and ngrok work without one.
