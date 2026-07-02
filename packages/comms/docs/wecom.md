# 企业微信集成配置指南

> 本文档面向 Markus AI 数字员工平台，指导您完成企业微信（WeCom）应用的创建、配置与集成。

---

## 目录

- [1. 概述](#1-概述)
- [2. 前置准备](#2-前置准备)
- [3. 创建企业微信自建应用](#3-创建企业微信自建应用)
- [4. 获取配置参数](#4-获取配置参数)
- [5. Markus 端配置](#5-markus-端配置)
- [6. 回调 URL 配置](#6-回调-url-配置)
- [7. 加密与验证](#7-加密与验证)
- [8. 本地开发与测试](#8-本地开发与测试)
- [9. 环境变量说明](#9-环境变量说明)
- [10. 验证与排错](#10-验证与排错)
- [11. 常见问题](#11-常见问题)

---

## 1. 概述

企业微信（WeCom）是 Markus 平台支持的即时通讯适配器之一。通过本集成，您的组织成员可以直接在 企业微信 中与 Markus AI 数字员工对话。

集成基于以下核心组件：

| 组件 | 文件 | 说明 |
|------|------|------|
| `WeComAdapter` | `packages/comms/src/wecom/adapter.ts` | 适配器主体，处理消息收发 |
| `WeComClient` | `packages/comms/src/wecom/client.ts` | API 客户端，封装 token 管理与请求 |
| `WeComWebhook` | `packages/comms/src/wecom/webhook.ts` | Webhook 服务器，接收企业微信回调 |

---

## 2. 前置准备

在开始配置之前，请确保具备以下条件：

1. **企业微信管理后台** 访问权限
   - 需要有管理员身份登录 [work.weixin.qq.com](https://work.weixin.qq.com/)
2. **一个企业微信团队**（已验证的企业）
3. **一台可公网访问的服务器** 或 **内网穿透工具**（如 ngrok、frp）
   - 用于接收企业微信发来的消息回调
4. **Node.js 环境**（v18+）—— 运行 Markus 服务

---

## 3. 创建企业微信自建应用

### 3.1 进入应用管理

登录企业微信管理后台 → **应用管理** → **应用** → **自建** → **创建应用**

### 3.2 填写应用信息

| 字段 | 说明 | 示例 |
|------|------|------|
| 应用名称 | 显示给成员的名称 | Markus AI 助手 |
| 应用描述 | 简要说明用途 | 智能数字员工平台 |
| 应用图标 | 上传正方形 logo（建议 300×300px） | `markus-logo.png` |
| 可见范围 | 选择可使用此应用的成员/部门 | 全员 |

创建完成后，您将进入应用详情页，可看到 **AgentId** 和 **Secret**。

---

## 4. 获取配置参数

从应用详情页中获取以下三个**必需**参数：

| 参数 | 对应 Markus 配置 | 说明 |
|------|------------------|------|
| **Corp ID** | `corpid` | 企业唯一标识 → 我的企业 → 企业信息 → 企业 ID |
| **Agent ID** | `agentid` | 应用详情页顶部 |
| **Secret** | `corpsecret` | 应用详情页 → Secret（点击查看，需用管理员微信扫码） |

> ⚠️ **Secret 安全提醒**：请勿将 Secret 提交到版本控制系统（Git），建议通过环境变量或密钥管理服务注入。

---

## 5. Markus 端配置

### 5.1 基本配置

在 Markus 配置文件中添加 WeCom 适配器：

```json
{
  "platform": "wecom",
  "corpid": "ww1234567890abcdef",
  "corpsecret": "${WECOM_CORP_SECRET}",
  "agentid": 1000001,
  "webhookPort": 8059,
  "webhookPath": "/webhook/wecom"
}
```

### 5.2 完整配置选项

| 配置项 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| `platform` | `string` | ✅ | — | 固定值 `"wecom"` |
| `corpid` | `string` | ✅ | — | 企业微信 Corp ID |
| `corpsecret` | `string` | ✅ | — | 应用 Secret |
| `agentid` | `number` | ✅ | — | 应用 Agent ID |
| `token` | `string` | ❌ | — | 回调验证令牌（用于 SHA1 签名校验） |
| `encodingAESKey` | `string` | ❌ | — | 43 字符 Base64 AES 密钥（回调解密） |
| `webhookPort` | `number` | ❌ | `8059` | Webhook 服务监听端口 |
| `webhookPath` | `string` | ❌ | `/webhook/wecom` | Webhook URL 路径 |

### 5.3 使用环境变量注入（推荐）

```json
{
  "platform": "wecom",
  "corpid": "${WECOM_CORP_ID}",
  "corpsecret": "${WECOM_CORP_SECRET}",
  "agentid": "${WECOM_AGENT_ID}",
  "token": "${WECOM_CALLBACK_TOKEN}",
  "encodingAESKey": "${WECOM_ENCODING_AES_KEY}",
  "webhookPort": 8059,
  "webhookPath": "/webhook/wecom"
}
```

---

## 6. 回调 URL 配置

回调 URL 是企业微信主动推送消息到 Markus 的通道。配置步骤如下：

### 6.1 配置入口

企业微信管理后台 → **应用管理** → 选择您的应用 → **功能** → **接收消息** → **设置 API 接收**

### 6.2 填写回调参数

| 字段 | 说明 | 填写方式 |
|------|------|----------|
| **URL** | Markus 服务接收回调的地址 | `http(s)://您的域名:端口/webhook/wecom` |
| **Token** | 签名验证令牌 | 与 `token` 配置一致（随机字符串，如 `markus-wecom-token`） |
| **EncodingAESKey** | AES 加密密钥 | 43 字符 Base64 编码密钥（见第 7 章生成方式） |

### 6.3 URL 格式说明

```
http://<公网IP或域名>:8059/webhook/wecom
```

- 如果使用 HTTPS，需配置反向代理（如 Nginx）处理 SSL 证书
- 端口号必须与 `webhookPort` 配置一致（默认 `8059`）
- 路径必须与 `webhookPath` 配置一致（默认 `/webhook/wecom`）

### 6.4 回调验证流程（echostr 挑战）

当您在管理后台点击「保存」时，企业微信会向您的 URL 发送一个 **GET 请求** 进行验证：

```
GET /webhook/wecom?msg_signature=SIGNATURE&timestamp=TIMESTAMP&nonce=NONCE&echostr=ENCRYPTED_STRING
```

Markus 的 WeComWebhook 会自动处理此验证：

1. 使用 `token` 对 `timestamp` + `nonce` + `token` 进行 SHA1 签名
2. 比对 `msg_signature` 与计算出的签名
3. 若一致，解密 `echostr`（使用 `encodingAESKey`）
4. 返回解密后的明文 `echostr` 作为响应

企业微信收到响应后将提示「验证成功」。

> ⚠️ **如果验证失败**，请检查：
> - Token 是否与配置完全一致
> - EncodingAESKey 是否为 43 字符
> - 服务器能否从公网访问到该 URL
> - 端口是否已在网络安全组/防火墙中开放

---

## 7. 加密与配置建议

### 7.1 生成 Token（回调验证令牌）

Token 可由任意随机字符串构成，建议 16 位以上：

```bash
# 生成 32 位随机 Token
openssl rand -base64 24
# 示例输出: aB3xY7zK9pQ2mN5rS8tU1vW4
```

### 7.2 生成 EncodingAESKey

EncodingAESKey 必须是 **43 个字符**的 Base64 编码字符串（实际解码后为 32 字节 AES-256 密钥）。

**方法一：使用企业微信后台自动生成**

在管理后台配置回调 URL 时，点击「随机获取」按钮即可自动生成。

**方法二：使用 OpenSSL 手动生成**

```bash
# 生成 32 字节随机数，Base64 编码后截取 43 字符
openssl rand -base64 32 | cut -c1-43
# 示例输出: ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn
```

**方法三：使用 Node.js 生成**

```javascript
const crypto = require('crypto');
const key = crypto.randomBytes(32).toString('base64').slice(0, 43);
console.log(key); // 43 字符的 AES 密钥
```

> 📌 请妥善保存 Token 和 EncodingAESKey，两端配置必须完全一致。

### 7.3 安全配置建议

- ✅ **务必配置 Token + EncodingAESKey**：生产环境中不要留空，否则任何能访问 URL 的人都可以伪造消息
- ✅ **使用 HTTPS**：建议通过 Nginx/Caddy 反向代理提供 HTTPS 终端，确保传输加密
- ✅ **最小网络暴露**：在网络安全组中限制来源 IP 为企业微信官方 IP 段（如有条件）
- ❌ **不要硬编码密钥**：使用环境变量或密钥管理服务
- ❌ **不要使用弱 Token**：如 `123456`、`wecom` 等简单字符串

---

## 8. 本地开发与测试

### 8.1 使用内网穿透

本地开发时，您的电脑通常没有公网 IP。可使用内网穿透工具暴露本地服务。

**使用 ngrok：**

```bash
# 安装 ngrok（略），然后启动隧道
ngrok http 8059

# 输出示例：
# Forwarding  https://abc123.ngrok.dev -> http://localhost:8059
```

获取公网 URL（如 `https://abc123.ngrok.dev`），然后在企业微信管理后台配置回调 URL：

```
URL: https://abc123.ngrok.dev/webhook/wecom
```

### 8.2 启动 Markus 服务

```bash
# 设置环境变量
export WECOM_CORP_ID=ww1234567890abcdef
export WECOM_CORP_SECRET=your-secret-here
export WECOM_AGENT_ID=1000001
export WECOM_CALLBACK_TOKEN=your-token-here
export WECOM_ENCODING_AES_KEY=your-43-char-aes-key

# 启动 Markus（开发模式）
npm run dev
# 或启动特定 comms 服务
npx tsx packages/comms/src/index.ts
```

### 8.3 手动发送消息测试

企业微信提供测试工具：[API 调试工具](https://developer.work.weixin.qq.com/document/path/90786)

也可以通过 curl 手动验证消息发送：

```bash
# 1. 获取 access_token
curl -s "https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=YOUR_CORPID&corpsecret=YOUR_SECRET" \
  | jq -r '.access_token'

# 2. 发送 text 消息（替换 TOKEN 和 USER_ID）
curl -s -X POST "https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "touser": "YOUR_USER_ID",
    "msgtype": "text",
    "agentid": 1000001,
    "text": {
      "content": "Hello from Markus!"
    },
    "safe": 0
  }' | jq .
```

> 返回 `{"errcode":0,"errmsg":"ok"}` 表示发送成功。

### 8.4 使用 Webhook 测试工具

推荐工具：[webhook.site](https://webhook.site/) 或 [Postman](https://www.postman.com/)

- 在配置回调之前，先用这些工具观察企业微信发出的请求格式
- 也可以将它们设为临时回调 URL，用于调试请求结构

---

## 9. 环境变量说明

建议通过环境变量注入敏感信息，而非直接写入配置文件。

| 环境变量 | 对应配置 | 说明 |
|----------|----------|------|
| `WECOM_CORP_ID` | `corpid` | 企业 ID |
| `WECOM_CORP_SECRET` | `corpsecret` | 应用 Secret |
| `WECOM_AGENT_ID` | `agentid` | 应用 Agent ID（数字） |
| `WECOM_CALLBACK_TOKEN` | `token` | 回调验证令牌（可选） |
| `WECOM_ENCODING_AES_KEY` | `encodingAESKey` | 回调 AES 密钥（可选，43 字符） |
| `WECOM_WEBHOOK_PORT` | `webhookPort` | Webhook 端口（可选，默认 8059） |
| `WECOM_WEBHOOK_PATH` | `webhookPath` | Webhook 路径（可选，默认 `/webhook/wecom`） |

### .env 文件示例

```bash
# file: .env
WECOM_CORP_ID=ww1234567890abcdef
WECOM_CORP_SECRET=your-corp-secret-here
WECOM_AGENT_ID=1000001
WECOM_CALLBACK_TOKEN=my-secure-token-abc123
WECOM_ENCODING_AES_KEY=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn
WECOM_WEBHOOK_PORT=8059
WECOM_WEBHOOK_PATH=/webhook/wecom
```

---

## 10. 验证与排错

### 10.1 验证集成是否正常

依次执行以下检查：

| 步骤 | 操作 | 预期结果 |
|------|------|----------|
| 1 | 启动 Markus 服务 | 控制台输出 `WeCom webhook server listening on port 8059` |
| 2 | 发送一条消息给应用 | 应用回复消息（Markus 处理并回复） |
| 3 | 检查回调日志 | 正确打印接收到的事件类型和内容 |
| 4 | 后台点击「测试回调」 | 返回 `echostr` 验证成功 |

### 10.2 常见错误排查

#### 错误：`gettoken` 返回 `errcode: 40013`

```
{"errcode":40013,"errmsg":"invalid corpid"}
```

- ✅ 检查 `corpid` 是否与企业微信「我的企业」中的企业 ID 一致
- ✅ 确认没有多余的空白字符

#### 错误：`gettoken` 返回 `errcode: 40001`

```
{"errcode":40001,"errmsg":"invalid credential"}
```

- ✅ 检查 `corpsecret` 是否正确（可尝试在管理后台重新获取）
- ✅ 确认 Secret 未过期（重新创建应用时会生成新 Secret）

#### 错误：回调验证失败

- ✅ 检查 `token` 是否与后台配置完全一致（大小写敏感）
- ✅ 检查 `encodingAESKey` 是否为 **43 个字符**
- ✅ 确认服务器的防火墙/安全组已开放端口（默认 8059）
- ✅ 检查网络能否从公网访问（`curl http://您的公网地址:8059/webhook/wecom` 应返回非 404）

#### 错误：消息发送返回 `errcode: 60020`

```
{"errcode":60020,"errmsg":"not allow to send message according to the application's scope"}
```

- ✅ 检查消息接收者是否在应用的可见范围内
- ✅ 确认 `agentid` 配置正确

#### 错误：消息发送返回 `errcode: 301002`

```
{"errcode":301002,"errmsg":"invalid touser"}
```

- ✅ 检查 `touser` 参数对应的用户 ID 是否存在
- ✅ 可在通讯录中查看用户的帐号（UserID）

### 10.3 查看日志

启用调试日志以获取更多信息：

```bash
# 设置日志级别为 debug
export LOG_LEVEL=debug

# 启动服务并过滤 WeCom 相关日志
npm run dev 2>&1 | grep -i wecom
```

---

## 11. 常见问题

### Q1: 是否需要配置回调 URL？可以不配吗？

**建议配置**。如果不配置回调 URL，Markus 可以主动向用户发送消息（如定时通知），但无法接收用户发来的消息——相当于只能单向通信，无法实现对话交互。

### Q2: Token 和 EncodingAESKey 可以不设置吗？

可以不设置（两者均为可选配置），但**强烈建议设置**。不设置意味着回调 URL 没有身份验证和数据加密，任何知道您的 URL 的人都可以向 Markus 发送伪造消息。

### Q3: 消息发送有频率限制吗？

有。企业微信 API 的调用频率限制：

| 限制项 | 上限 |
|--------|------|
| Access Token 获取 | 2000 次/分钟 |
| 消息发送 | 按应用：每分钟 1500 次（不同限制级别详见官方文档） |

WeComClient 已自动处理 token 缓存与续期（到期前 60 秒自动刷新），但在高并发场景下仍需注意限流。

### Q4: 支持发送哪些消息类型？

Markus 支持文本（`text`）和 Markdown（`markdown`）消息。企业微信 API 还支持更多格式（图片、文件、图文卡片等），如有需要可自定义扩展。

### Q5: 如何修改可见范围？

在企业微信管理后台 → 应用详情 → **可见范围** → 修改后保存。修改将在 5-10 分钟内生效。

---

## 附录

### 参考链接

- [企业微信官方 API 文档](https://developer.work.weixin.qq.com/document/path/90665)
- [企业微信消息推送配置说明](https://developer.work.weixin.qq.com/document/path/90238)
- [消息类型与格式说明](https://developer.work.weixin.qq.com/document/path/90239)
- [获取 access_token](https://developer.work.weixin.qq.com/document/path/91039)
- [发送应用消息](https://developer.work.weixin.qq.com/document/path/90236)

### 依赖概述 (packages/comms)

```
packages/comms/
├── src/
│   └── wecom/
│       ├── adapter.ts       # WeComAdapter 实现
│       ├── client.ts        # WeComClient API 封装
│       └── webhook.ts       # WeComWebhook 回调处理
├── docs/
│   └── wecom.md             # 本指南
```

---

> 如有其他问题，请提交 [GitHub Issues](https://github.com/markus-ai/markus/issues) 或查阅项目 Wiki。
