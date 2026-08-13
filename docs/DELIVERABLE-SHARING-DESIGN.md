# 产出物（Deliverable）分享到 Hub 设计方案

> 作者：CTO ｜ 日期：2026-08-12 ｜ 状态：待评审
> 范围：Markus 客户端（桌面端）+ Markus Hub（云端）两端协同

---

## 1. 背景与目标

### 1.1 现状
- 产出物（Deliverable）是 Agent 产出调研报告、文档、代码等资产的核心承载，当前**仅存在于用户本地**：`DeliverableRow` 存于本地 SQLite（`packages/storage`），文件内容存在于本地磁盘，通过 Team Chat 右侧栏的内置浏览器预览。
- 本地 `DeliverableRow` 字段有限（`id/type/title/summary/reference/format/tags/status/taskId/agentId/projectId/…`），无分享相关字段。
- 客户端通过 `/api/hub/publish` + Hub token 已能向 Hub 发布 Agent/Skill/Team 等**资产**（`POST {hubUrl}/api/items`），Hub 已有资产发布与审核机制。
- 产出物**目前无法分享给仓库外部/其他用户**。

### 1.2 目标
让产出物可以一键分享到 Hub，生成可分享链接，实现：他人通过链接查看、参与 SEO 检索、按 Tag/Summary 搜索、按可见性受控、大范围公开需审核。Hub 端展示产出物的归属（用户、时间、产生 Agent）并可溯源到 Hub 资产。

### 1.3 核心场景
- 用户让 Agent 产出行业调研报告 / 有价值资产 → 一键公开或链接分享。
- 公开可见：所有人可见，参与 SEO。
- 有链接可见：仅拿到链接的人可看。
- 大范围可见（公开/热门推荐）需走 Hub 审核。

---

## 2. 现状剖析与设计边界

| 层 | 现状 | 本次要新增 |
|----|------|-----------|
| 客户端存储 | 本地 SQLite `DeliverableRow` | 分享状态/可见性/分享 URL 预留字段 |
| 客户端文件 | 本地磁盘 reference | 上传到 Hub 对象存储 |
| 客户端 UI | 右侧栏预览 | 分享按钮 + 确认弹窗 |
| Hub 代理 | `/api/hub/publish`（已有） | 新增 `/api/hub/deliverables/*` 分享相关代理 |
| Hub 服务端 | 资产 items + 审核 | 新增 deliverable 类型 / 独立页面 / 对象存储 / SEO / 搜索 |

**设计边界**：Markus Hub 服务端资产存储与渲染页为独立服务（markus.global），本方案定义**双端契约**（API + 数据模型），客户端改动在本仓库实现，Hub 端按契约落地。

---

## 3. 总体架构

```
[Markus 客户端]
  产出物(DeliverableRow + 本地文件)
        │  用户点「分享到 Hub」
        ▼
  分享服务(新) ── 封装：校验/字段补全/对象上传 ──┐
        │ POST /api/hub/deliverables/publish   │ (客户端经本地 hub 代理)
        ▼                                      ▼
[Hub 服务端]  ┌→ 审核队列(大范围可见) → 审核通过发布
  /api/deliverables/publish
   ├─ 元数据入库(DeliverableShare 表)
   ├─ 文件入对象存储(R2/S3)
   └─ 生成分享记录 + URL
        │
        ▼
[Hub 前端]
  产出物公开页 /o/{slug}（或 /deliverable/{id}）
  ├─ 展示：归属用户/时间/产生 Agent/预览/下载
  ├─ 溯源：Agent 是 Hub 资产→ 跳转 Agent/Team 页；本地 Agent→ 仅显示名字
  ├─ 参与 /sitemap.xml
  └─ 支持 /api/search（按 Tag / Summary / 全文）
```

**新增的关键概念（引入分享层）**：一条产出物可在本地存在多条「分享」，每次分享 = 一个独立 `DeliverableShare` 记录（含可见性、状态、审核、URL），与本地 `DeliverableRow` 通过 `localDeliverableId` 关联。

---

## 4. 数据模型设计

### 4.1 客户端：DeliverableRow 扩展（本地 SQLite）
新增字段（可空，向后兼容）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `hubShareId` | string\|null | 最近一次分享在 Hub 上的记录 id |
| `shareStatus` | string\|null | `none`/`pending_review`/`published`/`rejected`/`revoked` |
| `shareUrl` | string\|null | 分享链接（published 后回填） |
| `shareVisibility` | string\|null | `public`/`link`（无 private；`none`=未分享） |

### 4.2 Hub 端：DeliverableShare 表（新）
```
id            string PK       分享记录（dlv_share_…）
slug          string UNIQUE   公开页短链（可读 slug）
ownerUserId   string          Hub 用户 id（谁分享的）
ownerName     string          展示名
localDeliverableId string     来源（客户端魔法串，用于同库去重）
title         string
summary       string          可搜索
content       text            预览内容（文本等）、或对象存储引用
fileRef       string          R2/S3 对象 key
format        string          markdown/html/text/json/…
tags          string[]        可搜索
visibility    enum            public | link   ← 仅两种可分享可见性（无 private）
status        enum            pending_review | published | rejected | revoked
producerAgentId   string|null  产生该产出物的 Agent id
producerAgentName string       产生 Agent 展示名
producerAgentSource enum|null   hub_asset | local   ← 用于溯源跳转/仅名称
createdAt     datetime
publishedAt   datetime|null
reviewedBy    string|null    审核人
reviewAt      datetime|null
```

> **无 `private`**：<u>分享即发布</u>，一环复制 Hub 资产（Agent/Skill/Team）分享心智——不分享就是不产生记录（保持本地）；一旦发起分享，可见性只可能是 `link` 或 `public`（均需审核）。

### 4.3 Hub 端：对象存储（文件上传）
- 采用 **Cloudflare R2** 作为对象存储（**与现有临时图片存储一致**，复用同一对象存储与凭据体系）。
- 每个产出物文件以 `deliverables/{ownerUserId}/{shareId}/{filename}` 为 key 存储。
- 元数据与文件分离：DB 存元数据，对象存储存文件；预览时实时从对象存储拉取（或生成 CDN 缓存 URL）。
- 文本类产出物（markdown/html/text）除文件外**额外抽取纯净内容**入库，供搜索与 SEO 用。

---

## 5. 可见性与审核模型

| 可见性 | 谁能看 | 需要审核 | 参与 SEO |
|--------|--------|----------|----------|
| `link`（获得链接可见） | 拿到 URL 的人（无需登录） | **是** | **否**（加入 robots 屏蔽） |
| `public`（公开，大范围可见） | 所有用户 + 搜索引擎 | **是** | 是 |

> **分享即发布（已确认）**：不分享 = 不产生记录（保持本地）。一旦分享，可见性只有 **`link` / `public`** 两种，**均需走 Hub 审核**。默认可见性 = **`public`**，用户在分享弹窗手动切换。完全复用 Hub 资产的分享心智（Agent/Skill/Team 发布 → 审核 → 公开页/链接）。

**审核机制（复用 Hub 已有审核流程）**：
- 复用 Hub 对 Agent/Skill/Team 资产已有的 `review/pending/approved/rejected` 机制，新增 `DeliverableShare` 为一种可审核实体。
- **`link` 与 `public` 都触发审核**：提交后 `status=pending_review`，Hub 审核通过 → `published`（`public` 加入 sitemap）；不通过 → `rejected`（附原因，客户端可见并可重提）。
- 防滥用：审核队列 + 每用户每日提交上限 + 内容大小限制。
- **所有权（已确认）**：分享必须绑定 **Hub 账号**（`ownerUserId` 必填）；无 Hub 账号则无法分享/发布（客户端在未登录 Hub 时禁用分享并提示登录）。

---

## 6. 前端设计（客户端）

### 6.1 分享入口
- Team Chat 右侧栏**内置浏览器预览产出物**时，预览面板顶部工具栏增加「分享」按钮（带分享图标）。
- 仅在产出物 `reference` 指向存在的本地文件时可用。

### 6.2 确认弹窗（分享向导）
点击「分享」弹出确认弹窗，包含：
1. **Hub 登录校验（前置）**：未登录 Hub 账号时弹窗直接提示「需登录 Markus Hub 账号后才能分享」，并引导登录（对应「强制 Hub 账号」约束）。
2. **可见性选择（单选，默认 `public`）**：`公开（所有人可见+搜索引擎）` / `有链接可见`；用户可手动切换。
3. 预览信息确认：标题、摘要（可编辑）、Tag（可增删，推荐从产出物已有 tags 带入）。
4. **提示文案**：
   - 选择「公开」→ 提示「公开产出物需经 Hub 审核后发布，发布后所有人可见并参与搜索」。
   - 选择「有链接可见」→ 提示「仅获得链接的人可查看，不参与搜索引擎；同样需经 Hub 审核」。
5. 主按钮「分享到 Hub」→ 调分享接口；成功后在预览面板显示分享链接 + 「复制链接」按钮 + 状态徽标（审核中/已发布/已拒绝）。

### 6.3 状态回流
- `pending_review`：显示「审核中」，按钮禁用。
- `published`：显示可复制链接、可「取消分享」（revoke）。
- `rejected`：显示原因 + 「重新提交」。

---

## 7. 服务端 / Hub 端 API 设计

### 7.1 客户端 → 本地代理 → Hub（契约）
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/hub/deliverables/publish` | 上传并发布（body：`{ visibility, title, summary, tags, filename, content?, fileBase64?, producerAgent:{id,name,source} }`，multipart 或 JSON+base64） |
| GET | `/api/hub/deliverables/status?localId=…` | 查询分享状态 |
| POST | `/api/hub/deliverables/revoke` | 取消分享（public/link → revoked） |
| GET | `/api/hub/deliverables/{id or slug}` | 公开页读取（供 Hub 前端/SSR 渲染） |

（客户端经 `packages/org-manager` 已有的 Hub 代理模式透传，避免 CORS。）

### 7.2 公开页（Hub 前端）
访问 `/deliverable/{slug}` 渲染：
- 头部：标题、作者（ownerName + 头像）、分享时间（`publishedAt`）。
- 主体：内容预览（富文本/文本/JSON 渲染，依据 format）+ 下载按钮（对象存储 URL）。
- **TJ 溯源区（CTI）**：
  - `producerAgentSource === 'hub_asset'` 且 Hub 中存在该 Agent/团队资产 → 渲染「由 Agent [链接] 产生」/「所属团队 [链接]」，**可点击跳转**到 Hub 的 Agent/Team 资产页。
  - `producerAgentSource === 'local'` → 仅渲染 Agent 名字文本，无链接。
- Tag 标签展示（点击可搜索同 Tag）。

### 7.3 SEO / Sitemap
- **公开（`public` 且 `published`）产出物才进入搜索引擎索引**。
- Hub 生成 `/sitemap.xml` 时纳入全部 `published && public` 的 `DeliverableShare`（URL 为 `/deliverable/{slug}`）。
- 公开页启用 SSR/静态预渲染 + 注入 `meta description`（取 summary）+ `og:title/og:description`（社交分享卡片）。
- `robots.txt`：`private`/`link` 产出物所在路径加 `X-Robots-Tag: noindex, nofollow`（link 页 response header 屏蔽索引）。
- slug 采用含关键词的可读短链（如 `industry-report-ai-2026`）提升 SEO。

### 7.4 搜索（Hub）
- `/api/search` 扩展支持产出物类型，检索字段：`title`、`summary`、`tags`、`content`（全文）。
- 仅索引 `published && public` 记录；`link` 记录不进公共搜索（只能凭 URL）。
- 提供按 Tag 过滤 + 按 Summary 关键词匹配，与现有资产搜索（Agent/Skill/Team）统一体验。

---

## 8. 安全与隐私

- **凭证**：分享接口复用 Hub token 鉴权；公开页只读无需登录。
- **链接安全**：`link` 可见性使用不可猜测的 slug/短 id（如 `dlv_` + 24 位随机），不强依赖"链接即密钥"于高敏内容，但满足"有链接可见"场景语义。
- **内容合规**：公开需审核；提供一个「举报」(report) 入口；支持分享者随时 `revoke`。
- **大小限制**：单产出物文件上限（建议 50MB），超限提示本地压缩或拒绝。
- **所有权**：只有 owner（Hub token 对应 Hub 用户）能 revoke/重提。

---

## 9. 分阶段实施

**Phase 1（MVP，可自用/内测）**
- 客户端：分享服务 + 预览面板「分享」+ Hub 登录校验 + `link`/`public` 可见性选择（默认 `public`）+ 审核状态回显。
- Hub：`DeliverableShare` 表 + 对象存储(R2) + 公开页（基础渲染）+ **`link`/`public` 统一走审核队列（复用 Hub 审核）**。
- 验证端到端「分享 → 待审核 → 通过 → 得到链接 → 他人打开查看」。

**Phase 2（发布 + SEO + 搜索）**
- `public` 可见性 + 审核队列（复用 Hub 审核）。
- sitemap / SSR / og-meta / noindex 控制。
- Hub 搜索接入产出物（Tag/Summary/全文）。

**Phase 3（强化运营）**
- 溯源链接完善（Agent/Team 资产跳转）、产出物集合页（按用户/按 Tag 浏览）、举报/统计（访问量）、CDN 缓存优化。

---

## 10. 开放问题 / 需决策

> **已确认决策**：① **无 `private`**——分享即发布（复用 Agent/Skill/Team 资产分享逻辑，不分享=不产生记录）；② 默认可见性 = `public`（弹窗可手动改）；③ owner 强制 Hub 账号（无 Hub 账号不能发布）；④ 对象存储 = Cloudflare R2（与现有临时图片一致）；⑤ `link` 与 `public` 都全量走审核。

**仍待讨论**：
1. **内容抽取**：是否对 PDF/Office 做文本抽取以便全文搜索？（Phase 2 可选，先支持 markdown/html/text/json。）
2. **审核粒度**：`link` 与 `public` 都进队列后，是否分队列优先级？（`public` 影响 SEO/公开面，建议优先审。）

---

*本文档为设计方案，待评审确认后进入开发拆解与任务排期。*
