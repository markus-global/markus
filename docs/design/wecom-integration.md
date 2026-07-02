# WeCom (企业微信) 集成设计文档

> **文档状态**: 追认 — Wave 1 MVP 实现后补写
> **对应实现**: PR #234 → feature/gap-filling
> **最后更新**: 2026-07-02

---

## 1. 概述

### 1.1 文档目的

本文档追认 Markus 平台企业微信（WeCom）IM 集成的设计决策与架构方案。企业微信集成是 Markus 补齐国内 IM 生态入口的关键组件，对标 WorkBuddy 的微信生态能力。

### 1.2 集成范围 (MVP)

| 维度 | 当前 MVP 范围 | 未来扩展 |
|------|--------------|---------|
| 消息方向 | 双向：接收回调消息 + 主动发送 | — |
| 消息类型 | 仅文本 (text) | 图片、文件、markdown |
| 消息回复 | 新消息（不支持线程回复） | — |
| 认证方式 | corpid + corpsecret → access_token | — |
| 回调协议 | HTTP Webhook (GET echostr + POST 加密消息) | — |
| 加解密 | AES-256-CBC + SHA1 签名验证 | — |
| 消息去重 | ❌ 未实现 | 需补 |

---

## 2. 5 层 IM 集成模式中 WeCom 的适配位置

Markus 遵循 5 层 IM 集成架构模式，WeCom 在各层的适配情况如下：

| 层级 | 包 | 职责 | WeCom 覆盖文件 | 变更类型 |
|------|-----|------|---------------|---------|
| **L0** | `@markus/shared` | 平台类型定义 | `src/types/message.ts` — `MessagePlatform` 增加 `'wecom'` | 枚举扩展 |
| | | 集成配置类型 | `src/types/integration.ts` — `IntegrationPlatform` 增加 `'wecom'` | 枚举扩展 |
| **L1** | `@markus/comms` | Adapter 接口契约 | `src/adapter.ts` — `CommAdapter` 接口（无需修改，面向接口编程） | 无修改 |
| | | WeCom Adapter 实现 | `src/wecom/adapter.ts` — `WeComAdapter` (362行) | **新建核心文件** |
| | | WeCom API 客户端 | `src/wecom/client.ts` — `WeComClient` (226行) | **新建核心文件** |
| | | 模块导出 | `src/wecom/index.ts` + `src/index.ts` | 导出追加 |
| | | 消息路由 | `src/router.ts` — `MessageRouter`（无需修改，泛化路由） | 无修改 |
| **L1** | `@markus/storage` | SQLite 持久化 | 复用现有 integrations 表 (`platform` = `'wecom'`) | 无修改 |
| **L3** | `@markus/org-manager` | REST API | 复用集成 CRUD 端点 (`/api/integrations`) | 无修改 |
| **前端** | `@markus/web-ui` | 配置 UI | `Integrations.tsx` — 下拉选择新增 `wecom` 选项 | UI 扩展 |

**关键设计决策**: WeCom 完全复用现有的 `CommAdapter` 接口和 `IntegrationConfig` 类型体系，无需对基础设施层做任何侵入式修改。所有 WeCom 特有的协议逻辑（XML、SHA1、AES-256-CBC）封装在 `WeComAdapter` 和 `WeComClient` 内部。

---

## 3. 协议对比：WeCom vs 其他 IM 平台

| 维度 | WeCom | Feishu | Slack | Telegram | WhatsApp |
|------|-------|--------|-------|----------|----------|
| **传输协议** | HTTP (REST) | HTTP + WebSocket | HTTP + Socket Mode | HTTP | HTTP |
| **消息格式** | **XML (CDATA)** | JSON | JSON | JSON | JSON |
| **认证方式** | corpid+corpsecret → token | appId+appSecret → token | Bot token (`xoxb-`) | Bot token → getMe | Permanent token |
| **签名算法** | **SHA1** (sorted params) | HMAC-SHA256 | HMAC-SHA256 | Secret token header | HMAC-SHA256 |
| **加密** | **AES-256-CBC** (必选可配) | AES-256-CBC (可选) | 无 | 无 | 无 |
| **URL 验证** | **SHA1 + AES 解密 echostr** | echo challenge JSON | challenge JSON | 通过 API setWebhook | challenge GET |
| **线程回复** | ❌ 不支持 | ✅ reply to message_id | ✅ thread_ts | ✅ reply_to_message_id | ❌ 不支持 |
| **富文本** | ❌ 仅文本 | ✅ post 富文本 + 卡片 | ✅ Blocks | ✅ Markdown/HTML | ❌ 仅文本 |
| **更新/删除消息** | ❌ 不支持 | ✅ 支持 | ✅ 支持 | ⚠️ 仅更新 | ❌ 不支持 |
| **去重** | ❌ 未实现 | ✅ event_id 去重 | ✅ event.ts 去重 | ❌ 未实现 | ❌ 未实现 |
| **WebSocket** | ❌ 不支持 | ✅ 长连接 + 心跳 | ✅ Socket Mode | ❌ 不支持 | ❌ 不支持 |

**WeCom 的核心差异**: 唯一使用 XML 消息格式 + SHA1 签名 + 双阶段 URL 验证（SHA1 签名 + AES 解密 echostr）的平台。

---

## 4. WeCom 特有机制详解

### 4.1 消息加解密机制 (AES-256-CBC)

企业微信使用 AES-256-CBC 对回调消息进行加密，其密钥体系与其他平台有显著不同。

#### 密钥派生

```
encodingAESKey (43 字符 Base64 字符串)
       │
       ▼ Base64 解码
AES Key (32 字节 / 256 位)
       │
       ▼ subarray(0, 16)
IV (16 字节，取 AES Key 的前 16 字节)
```

**实现代码** (`client.ts`):
```typescript
const aesKey = Buffer.from(this.config.encodingAESKey, 'base64');
if (aesKey.length !== 32) {
  throw new Error(`Invalid encodingAESKey: expected 32 bytes after Base64 decode, got ${aesKey.length}`);
}
const iv = aesKey.subarray(0, 16);
const decipher = createDecipheriv('aes-256-cbc', aesKey, iv);
```

> ⚠️ **特性说明**: WeCom 的 IV 取自 AES Key 的前 16 字节，这是一个非标准约定。相比之下，Feishu 使用 `scrypt(encryptKey, 'key', 32)` 派生 32 字节密钥和独立 IV。

#### 解密载荷布局

解密后的二进制数据布局（需手工移除 PKCS7 padding 后解析）：

```
Offset 0..15:   随机 16 字节 (random bytes, 直接丢弃)
Offset 16..19:  消息体长度 (4 字节, Big-Endian uint32)
Offset 20..N:   消息 XML 内容 (N = 20 + msgLen)
Offset N..end:  corpid 后缀 (用于验证)
```

**实现代码** (`client.ts`):
```typescript
// 移除 PKCS7 padding
const pad = decrypted[decrypted.length - 1];
decrypted = decrypted.subarray(0, decrypted.length - pad);

// 解析: random(16) + msgLen(4 BE) + msgXml + corpid
const msgLen = decrypted.readUInt32BE(16);
const msgXml = decrypted.subarray(20, 20 + msgLen).toString('utf-8');
const suffix = decrypted.subarray(20 + msgLen).toString('utf-8');
if (suffix !== this.config.corpid) {
  log.warn('WeCom decrypted payload corpid mismatch');
}
```

#### PKCS7 填充

- 块大小: 32 字节（AES-256-CBC 固定值）
- 填充值: 每个填充字节的值等于填充长度（如缺 5 字节则填充 `0x05 0x05 0x05 0x05 0x05`）
- 实现使用 `setAutoPadding(false)` 手动处理

---

### 4.2 签名验证流程 (SHA1)

企业微信使用 SHA1 签名验证消息完整性，流程与 Feishu/Slack 的 HMAC 不同。

#### 签名算法

```
params = [token, timestamp, nonce, encrypted]
params.sort()  // 字母序排序
raw = params.join('')  // 拼接成字符串
msg_signature = SHA1(raw)
```

**实现代码** (`client.ts`):
```typescript
verifySignature(msgSignature: string, timestamp: string, nonce: string, encrypted: string): boolean {
  if (!this.config.token) {
    return true;  // 无 token 时跳过验证
  }
  const arr = [this.config.token, timestamp, nonce, encrypted].sort();
  const str = arr.join('');
  const hash = createHash('sha1').update(str).digest('hex');
  return hash === msgSignature.toLowerCase();
}
```

#### URL 验证 (echostr challenge)

当在企微管理后台配置回调 URL 时，企微服务器发送 GET 请求：
```
GET /webhook/wecom?msg_signature=xxx&timestamp=xxx&nonce=xxx&echostr=xxx
```

处理流程：
1. 验证 SHA1 签名（使用配置的 token）
2. 如果配置了 encodingAESKey，用 AES-256-CBC 解密 echostr
3. 返回解密后的明文字符串作为 HTTP 响应体

**实现代码** (`client.ts`):
```typescript
verifyEchoStr(msgSignature, timestamp, nonce, echostr): string {
  const valid = this.verifySignature(msgSignature, timestamp, nonce, echostr);
  if (!valid) throw new Error('signature mismatch');
  
  if (this.config.encodingAESKey) {
    return this.decrypt(echostr);  // AES-256-CBC 解密
  }
  return echostr;  // 无加密时返回原始 echostr
}
```

---

### 4.3 XML CDATA 解析

企业微信是 Markus 中唯一使用 XML 消息格式的 IM 平台。所有文本值使用 CDATA 包裹。

#### CDATA 提取 (`extractCdata`)

```typescript
// 输入的 XML 片段
// <FromUserName><![CDATA[user1]]></FromUserName>
// 或纯文本（降级）：<MsgType>text</MsgType>

private extractCdata(xml: string, tag: string): string {
  // 优先匹配 CDATA 格式
  const cdataRe = new RegExp(`<${tag}>\\s*<!\\[CDATA\\[(.*?)\\]\\]>\\s*</${tag}>`, 's');
  const cdataMatch = xml.match(cdataRe);
  if (cdataMatch) return cdataMatch[1].trim();

  // 降级：纯文本格式
  const plainRe = new RegExp(`<${tag}>\\s*(.*?)\\s*</${tag}>`, 's');
  const plainMatch = xml.match(plainRe);
  return plainMatch ? plainMatch[1].trim() : '';
}
```

> ⚠️ 使用正则而非 XML 解析器，因为企微的 XML 格式固定且简单，无需引入 XML 解析依赖。

#### 两层 XML 解析

| 层次 | 方法 | 用途 | XML 结构 |
|------|------|------|---------|
| **外层加密信封** | `parseEncryptedXml()` | 提取加密载荷 | `<xml><ToUserName/>...<Encrypt/>...<AgentID/></xml>` |
| **内层明文消息** | `parseMessageXml()` | 提取消息字段 | `<xml><FromUserName/><MsgType/><Content/><MsgId/><AgentID/><CreateTime/></xml>` |

---

### 4.4 Webhook 双路由

WeComAdapter 的 HTTP webhook 服务器处理两种路由：

| 方法 | 路径 | 用途 | 处理流程 |
|------|------|------|---------|
| `GET` | `/webhook/wecom` | URL 验证 (echostr) | 签名验证 → AES 解密 → 返回明文 |
| `POST` | `/webhook/wecom` | 加密消息回调 | 读 body → 解析 XML 信封 → 验签 → 解密 → 解析消息 XML → 响应 SUCCESS → 异步处理 |

**路由逻辑** (`adapter.ts`):
```typescript
if (req.method === 'GET' && url.pathname === webhookPath) {
  await this.handleEchoVerify(req, res, url);  // URL 验证
}
if (req.method === 'POST' && url.pathname === webhookPath) {
  await this.handleIncomingMessage(req, res, url);  // 消息回调
}
res.writeHead(404);
```

---

## 5. 适配器类结构

### 5.1 类图

```
┌──────────────────────────────────────────────┐
│           «interface» CommAdapter            │
│  ──────────────────────────────────────────── │
│  + readonly platform: string                 │
│  + connect(config): Promise<void>            │
│  + disconnect(): Promise<void>               │
│  + sendMessage(channelId, content, opts):    │
│      Promise<string>                         │
│  + sendReply(channelId, replyToId, content): │
│      Promise<string>                         │
│  + onMessage(handler): void                  │
│  + isConnected(): boolean                    │
└──────────────────────┬───────────────────────┘
                       │ implements
┌──────────────────────▼───────────────────────────────────┐
│                    WeComAdapter                           │
│  ─────────────────────────────────────────────────────── │
│  - config: WeComAdapterConfig                            │
│  - client: WeComClient                                   │
│  - handlers: IncomingMessageHandler[]                    │
│  - server: HTTP.Server                                   │
│  - connected: boolean                                    │
│  ─────────────────────────────────────────────────────── │
│  - setupWebhookServer(): Promise<void>                   │
│  - handleEchoVerify(req, res, url): Promise<void>        │
│  - handleIncomingMessage(req, res, url): Promise<void>   │
│  - extractCdata(xml, tag): string                        │
│  - parseMessageXml(xml): WeComIncomingMessage            │
│  - parseEncryptedXml(xml): {toUserName, encrypt, agentId}│
│  - readRawBody(req): Promise<string>                     │
└──────────────────────┬───────────────────────────────────┘
                       │ owns
┌──────────────────────▼───────────────────────────────────┐
│                     WeComClient                           │
│  ─────────────────────────────────────────────────────── │
│  - config: WeComConfig                                   │
│  - apiBase: string (= 'https://qyapi.weixin.qq.com')    │
│  - accessToken: string | undefined                       │
│  - tokenExpiresAt: number (= 0)                          │
│  ─────────────────────────────────────────────────────── │
│  + getAccessToken(): Promise<string>                     │
│  + sendTextMessage(content, toUser?): Promise<string>    │
│  + verifySignature(msgSig, ts, nonce, encrypted): boolean│
│  + decrypt(encryptedBase64): string                      │
│  + verifyEchoStr(msgSig, ts, nonce, echostr): string     │
└──────────────────────────────────────────────────────────┘
```

### 5.2 生命周期

```
connect(config)
  │
  ├── 1. 创建 WeComClient 实例
  ├── 2. getAccessToken() → 验证 corpid + corpsecret
  ├── 3. webhookPort 有值？→ setupWebhookServer() 启动 HTTP 监听
  └── 4. connected = true

disconnect()
  │
  ├── 1. server?.close() → 停止 HTTP 监听
  ├── 2. client = undefined → 清除客户端
  └── 3. connected = false
```

### 5.3 消息流 (Inbound)

```
企微服务器 → POST /webhook/wecom?msg_signature=...&timestamp=...&nonce=...
  │
  │  Body: <xml><ToUserName/><Encrypt>base64...</Encrypt><AgentID/></xml>
  │
  ▼
1. parseEncryptedXml(rawBody) → 提取 Encrypt 字段
  │
  ▼
2. client.verifySignature(...) → SHA1 签名验证
  │  └─ 失败 → 返回 403
  ▼
3. client.decrypt(encrypt) → AES-256-CBC 解密
  │  └─ 失败 → 返回 403
  ▼
4. parseMessageXml(decryptedXml) → WeComIncomingMessage
  │  └─ 失败 → 返回 400
  ▼
5. 响应 200 + <xml><return_code>SUCCESS</return_code></xml>
  │  (立即响应，企微要求快速返回)
  ▼
6. msgType === 'text' && content 有值？
  ├── 是 → 构造 Message 对象 → 通知所有 handlers
  └── 否 → 静默丢弃（event、image 等非文本类型）
```

---

## 6. 与其他适配器的模式对比

### 6.1 功能矩阵

| 功能 | Feishu | Slack | Telegram | WhatsApp | **WeCom** |
|------|--------|-------|----------|----------|-----------|
| 发送文本 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 线程回复 | ✅ | ✅ | ✅ | ❌ | ❌ |
| 富文本消息 | ✅ post | ✅ Blocks | ✅ Markdown | ❌ | ❌ |
| 卡片消息 | ✅ 完整框架 | 通过 Blocks | ❌ | ❌ | ❌ |
| 更新消息 | ✅ | ✅ | ⚠️ 仅新增 | ❌ | ❌ |
| 删除消息 | ✅ | ✅ | ⚠️ 记录日志 | ✅ (no-op) | ❌ |
| 事件去重 | ✅ event_id | ✅ event.ts | ❌ | ❌ | ❌ |
| WebSocket 模式 | ✅ 长连接 | ✅ Socket Mode | ❌ | ❌ | ❌ |
| 文件发送 | ✅ | ✅ | ✅ | ✅ | ❌ |
| 图片发送 | ✅ | ✅ | ✅ | ✅ | ❌ |

### 6.2 WeCom 的独特约束

1. **XML 独占**: 唯一使用 XML 协议的平台，其他全部使用 JSON
2. **非对称加解密**: 唯一同时要求 SHA1 签名 + AES-256-CBC 加密的平台
3. **无线程模型**: 企微消息 API 不支持 `thread_ts` / `reply_to_message_id`，`sendReply()` 退化为发送新消息
4. **纯文本限制**: 不支持富文本、卡片、文件或图片消息
5. **无去重机制**: 未实现 event_id 去重（Feishu/Slack 均有实现）
6. **token 生命周期**: 2 小时有效期，60 秒提前刷新

---

## 7. 配置与部署

### 7.1 必填配置

| 字段 | 类型 | 说明 | 获取位置 |
|------|------|------|---------|
| `corpid` | `string` | 企业微信 Corp ID | 管理后台「我的企业」→ 企业信息 |
| `corpsecret` | `string` | 自建应用 Secret | 管理后台「应用管理」→ 应用详情 |
| `agentid` | `number` | 自建应用 Agent ID | 管理后台「应用管理」→ 应用详情 |

### 7.2 选填配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `token` | `string` | — | 回调验证 Token，用于 SHA1 签名（管理后台「回调配置」设置） |
| `encodingAESKey` | `string` | — | 43 字符 Base64 AES 密钥（管理后台「回调配置」设置） |
| `webhookPort` | `number` | `8059` | Webhook HTTP 服务器监听端口 |
| `webhookPath` | `string` | `/webhook/wecom` | Webhook URL 路径 |

### 7.3 网络要求

- WeChat API 域名: `qyapi.weixin.qq.com` (出站)
- Webhook 服务器需要**公网可达**或通过 ngrok 等工具暴露内网端口
- 回调 URL 格式: `http://<public-host>:8059/webhook/wecom`
- 腾讯云/企业微信推荐的 HTTPS 部署（生产环境）

---

## 8. 安全考量

| 风险 | 缓解措施 | 实现状态 |
|------|---------|---------|
| 回调消息伪造 | SHA1 签名验证 | ✅ 已实现 |
| 回调消息泄露 | AES-256-CBC 加密 | ✅ 已实现 |
| token 泄露 | token 可选（无 token 时不验签，仅建议开发环境） | ✅ 已实现 |
| Secret 泄露 | 配置存储时由 API 层 `sanitizeConfig()` 过滤敏感字段 | ✅ 遵循通用模式 |
| Replay 攻击 | ❌ 未实现时间戳验证 | ⚠️ 需补 |
| Webhook 源 IP 白名单 | ❌ 未实现 | ⚠️ 需补 |

---

## 9. 测试策略

WeCom 适配器的测试覆盖对标其他 IM 平台，现有测试文件：

| 测试文件 | 行数 | 覆盖范围 |
|---------|------|---------|
| `wecom-adapter.test.ts` | 479 行 | 生命周期、消息收发、XML 解析、Webhook 双路由、签名验证错误路径 |
| `wecom-client.test.ts` | 331 行 | Token 获取/缓存/刷新、消息发送、SHA1 验证、AES-256-CBC 解密、URL 验证 |

测试模式：mock 工厂 + 私有属性注入 + `getFreePort()` + 真实 HTTP 请求 + `vi.stubGlobal('fetch')`。

---

## 10. 设计决策记录

| 决策 | 方案 | 备选 | 理由 |
|------|------|------|------|
| XML 解析使用正则 | 手写 `extractCdata()` 正则 | `fast-xml-parser` 等库 | 企微 XML 结构固定且简单，避免额外依赖 |
| 加密密钥 IV 取法 | AES Key 前 16 字节 | 独立随机 IV | 企微协议硬性约定，非标准 |
| 无去重 | 暂不实现 | event_id 去重表 | MVP 范围控制，后续迭代补 |
| `sendReply` 退化为新消息 | `sendTextMessage()` | 抛出异常 | 最大可用性：至少让消息送达 |
| webhookPort 可选 | 无端口时为 send-only | 始终启动 webhook | 支持纯发送场景（如通知推送） |
| token 为空时跳过验签 | `return true` | 抛出异常 | 降低配置门槛，方便快速测试 |

---

## 11. 后续迭代计划

| 优先级 | 功能 | 说明 |
|--------|------|------|
| P0 | 事件去重 | 引入 event_id 去重表，防止重复处理回调 |
| P1 | Replay 防护 | 添加时间戳窗口验证（如 5 分钟内） |
| P1 | IP 白名单 | 验证企微官方 IP 段 |
| P2 | 消息类型扩展 | 支持图片、文件、markdown 消息 |
| P2 | 多媒体发送 | 上传素材 → 发送 media_id |

---

## 附录 A: 相关文件清单

| 文件 | 行数 | 说明 |
|------|------|------|
| `packages/comms/src/wecom/adapter.ts` | 362 | WeComAdapter 主实现 |
| `packages/comms/src/wecom/client.ts` | 226 | WeComClient API + 加密 |
| `packages/comms/src/wecom/index.ts` | 3 | 模块导出 |
| `packages/comms/src/adapter.ts` | 27 | CommAdapter 接口（未修改） |
| `packages/comms/test/wecom-adapter.test.ts` | 479 | 适配器测试 |
| `packages/comms/test/wecom-client.test.ts` | 331 | 客户端测试 |
| `packages/shared/src/types/message.ts` | 45 | MessagePlatform 扩展 |
| `packages/shared/src/types/integration.ts` | 120 | IntegrationPlatform 扩展 |
