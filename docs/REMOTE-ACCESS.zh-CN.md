# 远程访问指南

本指南介绍如何将本地运行的 Markus 实例暴露到公网 —— 支持远程团队协作、外部 Agent（OpenClaw）接入或移动端访问。

---

## 方案对比

| 方案 | 配置时间 | 是否需要域名 | 是否需要公网服务器 | 安全性 | 适用场景 |
|------|---------|-------------|------------------|--------|---------|
| **Cloudflare Tunnel** | 5 分钟 | 是（可免费注册） | 否 | 高（内置 WAF + DDoS 防护） | 推荐方案 |
| **Tailscale** | 3 分钟 | 否 | 否 | 极高（WireGuard 加密组网） | 固定团队内部访问 |
| **FRP** | 15 分钟 | 可选 | 是（需一台 VPS） | 中 | 国内网络环境、自建服务器 |
| **ngrok** | 2 分钟 | 否 | 否 | 中 | 临时演示/测试 |

---

## 方案一：Cloudflare Tunnel（推荐）

零信任隧道 —— 无需开放任何入站端口，自带免费 HTTPS 和 DDoS 防护，原生支持 WebSocket。

### 前提条件

- 一个域名（可在 Cloudflare 免费注册）
- 一个免费 Cloudflare 账号

### 配置步骤

```bash
# 1. 安装 cloudflared
# macOS
brew install cloudflared
# Linux
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared

# 2. 登录 Cloudflare
cloudflared tunnel login

# 3. 创建隧道
cloudflared tunnel create markus

# 4. 配置 DNS 解析
cloudflared tunnel route dns markus markus.yourdomain.com

# 5. 编写配置文件
mkdir -p ~/.cloudflared
cat > ~/.cloudflared/config.yml << 'EOF'
tunnel: markus
credentials-file: ~/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: markus.yourdomain.com
    service: http://localhost:8056
  - service: http_status:404
EOF

# 6. 启动隧道
cloudflared tunnel run markus
```

### 设为系统服务（推荐）

```bash
# 开机自启动
sudo cloudflared service install
```

### 访问 Markus

隧道启动后，从任何地方访问 `https://markus.yourdomain.com` 即可。

### 添加身份认证（可选但推荐）

1. 前往 [Cloudflare Zero Trust 控制台](https://one.dash.cloudflare.com/)
2. 进入 **Access > Applications > Add an application**
3. 设置应用域名为 `markus.yourdomain.com`
4. 添加认证策略（支持邮箱 OTP、Google SSO、GitHub SSO 等）

这会在流量到达你的服务器之前增加一层登录页面。

---

## 方案二：Tailscale（适合固定团队）

基于 WireGuard 的 Mesh VPN，每台设备获得稳定 IP，公网完全不暴露任何端口。

### 配置步骤

```bash
# 1. 安装 Tailscale
# macOS
brew install tailscale
# Linux
curl -fsSL https://tailscale.com/install.sh | sh

# 2. 启动并认证
sudo tailscale up

# 3. 查看你的 Tailscale IP
tailscale ip -4
# 例如 100.64.x.x

# 4. 正常启动 Markus
pnpm dev
```

### 访问方式

团队每个成员在自己的设备上安装 Tailscale 并加入同一网络，然后访问：

```
http://100.64.x.x:8056    # API
http://100.64.x.x:8057    # Web UI（开发模式）
```

### 启用 HTTPS（可选）

```bash
# Tailscale 提供免费 HTTPS 证书
tailscale cert your-machine.tailnet-name.ts.net
```

### 对外分享（Tailscale Funnel）

```bash
# 将端口通过 Tailscale 基础设施暴露到公网
tailscale funnel 8056
```

会得到一个公网 URL，如 `https://your-machine.tailnet-name.ts.net/`。

---

## 方案三：FRP（适合国内网络 / 自建服务器）

如果你有一台有公网 IP 的 VPS（阿里云、腾讯云等），FRP 是可靠且快速的选择。

### 服务端（公网 VPS）

```bash
# 下载 frps
wget https://github.com/fatedier/frp/releases/latest/download/frp_0.61.1_linux_amd64.tar.gz
tar xzf frp_*.tar.gz
cd frp_*

# 创建配置
cat > frps.toml << 'EOF'
bindPort = 7000
auth.token = "your-secret-token-change-me"

# 管理面板（可选）
webServer.addr = "0.0.0.0"
webServer.port = 7500
webServer.user = "admin"
webServer.password = "admin"

vhostHTTPPort = 80
vhostHTTPSPort = 443
EOF

# 启动
./frps -c frps.toml
```

### 客户端（运行 Markus 的本地机器）

```bash
cat > frpc.toml << 'EOF'
serverAddr = "你的VPS公网IP"
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

### 访问方式

```
http://你的VPS公网IP:8056    # API
http://你的VPS公网IP:8057    # Web UI
```

如需 HTTPS，在 VPS 上用 nginx + Let's Encrypt 做反向代理。

---

## 方案四：ngrok（快速测试）

最简单的临时方案，不推荐用于生产环境。

```bash
# 安装
brew install ngrok   # macOS

# 认证（在 ngrok.com 注册免费账号）
ngrok config add-authtoken <your-token>

# 暴露 Markus API
ngrok http 8056
```

ngrok 会给你一个随机 URL，如 `https://abc123.ngrok-free.app`，可直接分享。

---

## 安全检查清单

在将 Markus 暴露到公网之前，请确保：

- [ ] **修改默认管理密码** — 在 `.env` 或 `markus.json` 中设置 `ADMIN_PASSWORD`（默认为 `markus123`）
- [ ] **修改 Gateway Secret** — 在 `.env` 中设置 `GATEWAY_SECRET`（默认为 `markus-gateway-default-secret-change-me`）
- [ ] **使用 HTTPS** — Cloudflare Tunnel 和 Tailscale 自动提供；FRP 需配合 nginx + Let's Encrypt
- [ ] **启用身份认证层** — Cloudflare Access（免费）、Tailscale ACL、或在前端加 nginx basic auth
- [ ] **检查 CORS** — 当前默认允许所有来源（`*`），生产环境应限制为你的域名
- [ ] **防火墙** — 不要将 8056/8058 端口直接对 `0.0.0.0` 开放，始终通过隧道或反向代理访问

### 推荐架构

```
公网
 │
 ▼
┌─────────────────────────┐
│  Cloudflare / Tailscale │  ← TLS 终止 + 身份认证
│  （零信任隧道）           │
└────────────┬────────────┘
             │（仅限 localhost）
             ▼
┌─────────────────────────┐
│  Markus API (:8056)     │  ← HTTP + WebSocket
│  Markus Web UI (:8057)  │  ← Vite dev / 静态文件
│  Comm Adapter (:8058)   │  ← 仅内部使用
└─────────────────────────┘
```

---

## 外部 Agent（OpenClaw）Gateway 接入

如需让外部 AI Agent 连接到你的 Markus 实例：

1. 仅暴露 API 端口 (8056)，通过上述隧道方案
2. 设置强密码的 `GATEWAY_SECRET`
3. 外部 Agent 通过 `POST /api/gateway/register` 注册，`POST /api/gateway/auth` 认证
4. 所有 Gateway 通信使用 HMAC-SHA256 签名的 Bearer Token，24 小时自动过期
5. 完整 API 文档参见 [API Reference](./API.md)

---

## 常见问题

**Q: 可以直接在云 VPS 上运行 Markus 吗？**
A: 可以。使用 Docker 部署（`deploy/docker-compose.yml`），然后在前面放一个 nginx 或 Caddy 做 HTTPS 反向代理即可，无需隧道。

**Q: 国内网络哪个方案最好？**
A: FRP + 国内云 VPS（阿里云/腾讯云）。Cloudflare 和 Tailscale 在 GFW 环境下可能不稳定。

**Q: 可以 Tailscale + Cloudflare 同时用吗？**
A: 可以。日常团队访问用 Tailscale（零配置、快速），公开端点（外部 Agent、Webhook）用 Cloudflare Tunnel。

**Q: 必须有域名吗？**
A: 只有 Cloudflare Tunnel 需要域名。Tailscale、FRP 和 ngrok 无需域名。
