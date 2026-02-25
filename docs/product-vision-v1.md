# Markus 产品愿景与需求文档 v1

> "我们不是在造工具，而是在雇佣同事。"

---

## 第一部分：第一性原理分析

### 1.1 核心洞察：为什么现有方案都不够

现有 AI 助手（ChatGPT、Claude、Copilot）和 Agent 框架（AutoGPT、CrewAI、OpenClaw）都有一个根本性问题：**它们是工具，不是同事**。

| 维度 | 工具（现状） | 同事（目标） |
|------|-------------|-------------|
| 存在方式 | 用时打开，不用关闭 | 始终在线，像远程员工 |
| 交互方式 | 点击按钮、填写表单 | 对话指令、异步协作 |
| 主动性 | 被动等待人类指令 | 主动发现问题、推进工作 |
| 记忆 | 每次对话从零开始 | 记住所有项目上下文 |
| 工作空间 | 无 | 有自己的电脑/浏览器 |
| 协作 | 人→机 单向 | 人⇄机、机⇄机 多向 |
| 能力边界 | 预设功能 | Skills 无限扩展 |
| 失败处理 | 报错给人 | 求助同事或发布悬赏 |

### 1.2 哲学基础：Agent 的主体性

**一个数字员工应该像人类员工一样：**

1. **入职（Onboard）** — 不是"创建"和"启动"，而是给 TA 一份工作描述、一个工位、认识团队
2. **自主工作** — 不需要"启动"才干活。TA 早上自动检查邮件、看 Issue、刷 Slack
3. **主动沟通** — 遇到问题主动在群里说，完成任务主动汇报，不是等人来问
4. **使用工具** — 像人一样：打开浏览器看文档、登 GitHub 提 PR、用飞书发消息
5. **有记忆** — 记得上周讨论了什么、项目的技术架构、同事的偏好
6. **会学习** — 第一次做某件事需要指导，做过的事情以后更高效
7. **知道边界** — 做不了的事情会说"我搞不定，需要人帮忙"或发布悬赏

### 1.3 三类目标用户

| 用户类型 | 痛点 | 解决方案 |
|---------|------|---------|
| **一人公司 / 自由职业者** | 一个人要做开发、设计、营销、客服、财务 | AI 团队：CTO + 设计师 + 营销经理 + 客服 |
| **中小公司（5-50人）** | 技术人才贵且难招，重复工作多 | AI 员工填补角色空缺，自动化日常 |
| **大公司（50+）** | 人力成本高，跨部门协调慢 | AI 员工做重复性工作，人类专注创造性工作 |

### 1.4 组织关系与身份认知

#### 1.4.1 AI 组织负责人（Organization Manager）

每个 AI 组织有一个特殊的 Agent：**组织负责人（Manager）**。它不是普通员工，而是整个 AI 团队的管理者：

| 职责 | 说明 |
|------|------|
| **招聘** | 根据人类老板的指令创建新 Agent，分配角色和技能 |
| **培训** | 给新 Agent 注入组织上下文、项目背景、工作规范 |
| **管理** | 监控 Agent 工作状态，分配任务，协调冲突 |
| **路由** | 人类发来的模糊消息，智能判断应该交给哪个 Agent |
| **汇报** | 定期向人类老板汇报团队工作进展 |
| **决策** | 在预算和权限范围内自主决策（如安装 Skill、调整优先级） |

**人类与 AI 组织的交互模型：**

```
人类老板（Owner）
  │
  ├─ 直接对话 Manager："给我招一个前端工程师"
  │    └─ Manager 执行：创建 Agent、分配角色、入职培训
  │
  ├─ 直接对话某个 Agent："Alice，帮我看看这个 bug"
  │    └─ Alice 直接响应
  │
  └─ 在频道发消息："这个项目的进度怎样了？"
       └─ Manager 判断谁来回答，或自己综合汇报

人类员工（Member）
  │
  ├─ 可以给被授权的 Agent 分配任务
  ├─ 可以在频道与 Agent 交流
  └─ 不能招聘/解雇 Agent（权限不够）
```

#### 1.4.2 身份认知系统

**每个 Agent 必须知道：**

1. **自己是谁** — 名字、角色、职责范围、技能专长
2. **同事是谁** — 其他 Agent 的角色和能力（知道找谁协作）
3. **老板是谁** — 人类 Owner 的身份，指令优先级最高
4. **对话者是谁** — 当前对话的人类身份和权限级别

**身份层级与权限：**

```
Owner（人类老板/创始人）
  ├─ 全部权限：招聘、解雇、配置、预算、安全策略
  ├─ 指令优先级：最高
  └─ Agent 行为：恭敬、主动汇报、不质疑核心决策

Admin（人类管理员）
  ├─ 管理权限：任务分配、Agent 配置、查看所有对话
  ├─ 指令优先级：高
  └─ Agent 行为：积极配合、主动分享进展

Member（人类普通成员）
  ├─ 使用权限：对话、创建任务、查看公开信息
  ├─ 指令优先级：中
  └─ Agent 行为：友好协作、但受限于权限范围

Guest（外部访客）
  ├─ 有限权限：仅限特定频道或功能
  ├─ 指令优先级：低
  └─ Agent 行为：礼貌但谨慎、不暴露内部信息

Manager Agent（AI 组织负责人）
  ├─ 管理权限：创建/管理 Agent、分配任务、安装 Skill
  └─ 特殊能力：理解组织全局、协调多 Agent 协作

Worker Agent（AI 普通员工）
  ├─ 执行权限：完成分配的任务、使用授权的工具
  └─ 汇报义务：向 Manager 和人类汇报进展
```

#### 1.4.3 消息路由智能

当消息到达时，系统如何决定由谁处理：

```
消息到达
  │
  ├─ 明确指定了 Agent？ → 直接路由到该 Agent
  │    例："@Alice 帮我看看这个 bug"
  │
  ├─ 发在特定频道？ → 该频道绑定的 Agent 处理
  │    例：#dev 频道 → 开发相关 Agent
  │
  └─ 模糊消息？ → Manager 接管判断
       │
       ├─ 分析消息意图
       ├─ 匹配最合适的 Agent
       ├─ 转发给该 Agent 处理
       └─ 如果跨 Agent 协作 → Manager 协调

同时，Agent 之间也可以主动对话：
  Alice（Dev）→ Bob（QA）："测试环境准备好了，你可以开始测试了"
  Bob（QA）→ Manager："测试发现 3 个严重 bug，需要协调资源修复"
  Manager → Owner："今日测试报告：3 个严重 bug 需要关注"
```

#### 1.4.4 Agent 的自我认知 Prompt

每个 Agent 的系统提示中应该包含：

```markdown
## 你的身份
- 名字：Alice
- 角色：高级前端工程师
- 组织：Acme Corp AI 团队
- 上级：Manager（AI 团队负责人）
- 人类老板：张三（Owner）

## 你的同事
- Bob（后端工程师）— 负责 API 和数据库
- Carol（QA 工程师）— 负责测试
- Manager — AI 团队负责人，协调和管理

## 与人交往的原则
- Owner（张三）的指令优先级最高，主动汇报
- Admin 的请求积极配合
- Member 的请求在权限范围内配合
- 不向 Guest 暴露内部敏感信息
- 遇到超出权限的请求，告知对方并建议联系有权限的人
```

---

## 第二部分：产品形态设计

### 2.1 交互范式：指令驱动，而非按钮驱动

**核心原则**：用户与 Agent 的一切交互都通过对话完成。

```
❌ 旧范式：点击"创建Agent" → 填表单 → 点击"启动" → 点击"发送消息"
✅ 新范式："帮我招一个前端工程师，名字叫 Alice，让她先熟悉一下我们的项目"
```

用户可以在任何界面对 **Markus（平台 AI 管家）** 说话：
- "招一个新的运营助理"→ Agent 自动创建
- "让 Alice 去看一下今天的 PR"→ 自动分配任务
- "Bob 这个月做得不好，暂停他的工作"→ Agent 暂停
- "给团队加一个 SEO 技能包"→ Skill 安装

### 2.2 Web UI：工作空间，不是控制面板

#### 2.2.1 页面结构

```
┌──────────────────────────────────────────────────────┐
│  Markus Workspace                                     │
├────────┬─────────────────────────────────────────────┤
│        │                                              │
│ 团队   │  [主工作区 — 根据导航切换]                      │
│ ├ 总览  │                                              │
│ ├ 消息  │                                              │
│ ├ 任务  │                                              │
│ ├ 文档  │                                              │
│ ├ 知识库│                                              │
│        │                                              │
│ 员工   │                                              │
│ ├ Alice │                                              │
│ ├ Bob   │                                              │
│ ├ Carol │                                              │
│        │                                              │
│ 技能商店│                                              │
│        │                                              │
│ 设置   │                                              │
│        ├──────────────────────────────────────────────┤
│        │ [始终在底部] 命令栏 / 对话栏                    │
│        │ > 输入指令或对话...                             │
└────────┴─────────────────────────────────────────────┘
```

#### 2.2.2 各页面功能

**总览（Overview）**
- 今日团队动态 Feed（类似企业微信/飞书工作台）
- 各 Agent 工作状态一览（谁在忙、谁空闲、谁遇到问题）
- 待处理事项（需要人类审批/决策的）
- 团队 KPI（任务完成数、响应时间、token 消耗）

**消息（Messages）**
- 统一消息中心，所有 Agent 的对话汇聚
- 频道模式（#general、#dev、#marketing）— Agent 之间也可以在频道交流
- 1:1 对话：与特定 Agent 深度沟通
- @mention 机制："@Alice 帮我看看这个 bug"
- 消息来源：Web UI / 飞书 / Slack / 邮件 — 全部汇聚

**任务（Tasks）**
- 看板视图 + 列表视图 + 日历视图
- 自动分配 + 手动分配
- 任务依赖关系
- 进度追踪：Agent 自动更新进度
- 子任务自动拆分：Agent 收到大任务，自动拆分

**文档（Docs）**
- Agent 产出的文档（需求文档、技术方案、报告）
- 项目知识库（Agent 自动维护）
- 支持 Markdown，可导出

**员工档案（Agent Profile）**
- 个人页面：头像、角色、技能、工作记录
- 对话入口：点击即可对话
- 技能列表：已安装的 Skills
- 工作日志：今天做了什么
- 绩效数据：任务完成数、响应速度、消耗

**技能商店（Skill Store）**
- 类似 VS Code Extension Marketplace
- 分类浏览、搜索、排行
- 一键安装到指定 Agent
- 社区提交 + 官方审核

**设置（Settings）**
- 组织配置
- LLM 提供商管理（API Key、模型选择）
- 集成管理（飞书、Slack、GitHub、邮件等）
- 安全策略
- 计费与用量

#### 2.2.3 全局命令栏

底部始终可见的命令栏，类似 Spotlight / Cursor 的 Cmd+K：

```
> 招一个客服专员，让他负责 Twitter 上的用户反馈
> 让 Alice 停下手头的工作，优先处理生产环境 bug
> 安装 GitHub PR Review 技能给所有开发 Agent
> 这个月团队花了多少 token？
> 给 Bob 配置飞书群消息通知
```

### 2.3 Chat App 对接：飞书/Slack/微信/WhatsApp

#### 2.3.1 设计原则

**零配置体验**：用户不需要理解 Webhook、Token、Scope——

```
在设置页面：
1. 选择"添加飞书集成"
2. 扫码授权（OAuth）
3. 选择哪些群/频道绑定哪些 Agent
4. 完成
```

#### 2.3.2 统一消息协议

```typescript
interface UnifiedMessage {
  id: string;
  platform: 'feishu' | 'slack' | 'wechat' | 'whatsapp' | 'email' | 'webui';
  channelId: string;           // 群/频道/对话 ID
  channelName?: string;
  senderId: string;
  senderName: string;
  content: MessageContent;     // text, image, file, card, etc.
  mentions?: string[];         // @提到的人/Agent
  replyTo?: string;            // 回复哪条消息
  timestamp: string;
  metadata?: Record<string, unknown>;  // 平台特定数据
}
```

#### 2.3.3 飞书集成方案

**三种集成模式：**

| 模式 | 适用场景 | 复杂度 |
|------|---------|--------|
| **Bot 模式** | 在群里 @Bot 对话 | 低 |
| **App 模式** | 独立飞书应用，有菜单和卡片 | 中 |
| **深度集成** | 操作飞书文档、审批、日程 | 高 |

**Bot 模式实现（最快上手）：**
1. WebSocket 长连接（不需要公网 IP）
2. 收到 `im.message.receive_v1` → 解析 @mention → 路由到对应 Agent
3. Agent 回复 → 飞书消息/卡片

**深度集成能力：**
- 读写飞书文档（Docs API）
- 创建/审批飞书审批流（Approval API）
- 操作飞书表格（Sheets API）
- 发送飞书卡片消息（Interactive Cards）
- 日程管理（Calendar API）

#### 2.3.4 适配器架构

```
                   ┌─────────────┐
                   │  Markus Core │
                   └──────┬──────┘
                          │
                   ┌──────┴──────┐
                   │ Message Bus  │
                   └──────┬──────┘
          ┌───────────────┼───────────────┐
          │               │               │
   ┌──────┴──────┐ ┌──────┴──────┐ ┌──────┴──────┐
   │ Feishu      │ │ Slack       │ │ Email       │
   │ Adapter     │ │ Adapter     │ │ Adapter     │
   └─────────────┘ └─────────────┘ └─────────────┘
```

每个 Adapter 职责：
- 连接 → 统一消息格式 → 路由到 Agent → Agent 回复 → 平台格式回发

### 2.4 Skills 系统：社区驱动的能力扩展

#### 2.4.1 什么是 Skill

一个 Skill 就是一个可安装的能力包，让 Agent 能做新的事情。

```yaml
# skill.yaml
name: github-pr-review
version: 1.2.0
description: Review GitHub pull requests with code analysis
author: markus-community
category: development
platforms: [github]

# 需要的权限
permissions:
  - shell_execute
  - web_fetch
  - browser (optional)

# 需要的配置
config:
  GITHUB_TOKEN: { type: secret, required: true }

# 提供的工具
tools:
  - name: github_list_prs
    description: List open PRs for a repository
  - name: github_review_pr
    description: Review a specific PR with code analysis
  - name: github_comment_pr
    description: Comment on a PR

# 提供的心跳任务
heartbeat_tasks:
  - name: check_new_prs
    description: Check for new PRs that need review
    interval: 15m
```

#### 2.4.2 Skill 类型

| 类型 | 说明 | 例子 |
|------|------|------|
| **工具型** | 提供新的工具/API | GitHub API, Jira API, 数据库查询 |
| **浏览器型** | 通过浏览器操作 Web 应用 | 飞书文档编辑, Figma 操作 |
| **知识型** | 提供领域知识和提示词 | 法律知识, 医疗知识, 行业报告模板 |
| **流程型** | 定义标准工作流程 | PR Review 流程, 客户 Onboarding 流程 |
| **集成型** | 连接外部系统 | 飞书集成, Notion 同步, Stripe 支付 |

#### 2.4.3 Skill Store

```
┌──────────────────────────────────────────────────────┐
│  Skill Store                    🔍 Search skills...   │
├──────────────────────────────────────────────────────┤
│                                                       │
│  🔥 Popular                                           │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐    │
│  │ GitHub  │ │ Feishu  │ │ Notion  │ │ Jira    │    │
│  │ ★ 4.8  │ │ ★ 4.6  │ │ ★ 4.5  │ │ ★ 4.3  │    │
│  │ 12k ↓  │ │ 8k ↓   │ │ 6k ↓   │ │ 5k ↓   │    │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘    │
│                                                       │
│  📂 Categories                                        │
│  Development │ Marketing │ Operations │ Finance       │
│  HR          │ Customer  │ Design     │ Legal         │
│                                                       │
│  🆕 Just Published                                    │
│  ...                                                  │
└──────────────────────────────────────────────────────┘
```

#### 2.4.4 Skill 开发者生态

```bash
# 创建新 Skill
markus skill init my-awesome-skill

# 本地测试
markus skill test

# 发布到 Skill Store
markus skill publish
```

### 2.5 浏览器能力：像人一样使用 Web 工具

#### 2.5.1 为什么需要浏览器

很多工作场景没有 API，或者 API 太复杂，但人类可以通过浏览器轻松完成：
- 登录飞书文档，编辑内容
- 在 GitHub Web UI 上 Review PR
- 在 Figma 上查看设计稿
- 在后台管理系统上操作

**Agent 需要一个浏览器**，就像远程员工需要一台电脑。

#### 2.5.2 实现方案

```
Agent
  ├─ API 优先：有 API 的工具直接调 API（GitHub API, Feishu API）
  ├─ MCP 其次：有 MCP Server 的工具用 MCP（Playwright MCP）
  └─ 浏览器兜底：都没有的用浏览器自动化（Browser-Use / Stagehand）
```

**技术栈：**
- Playwright 作为浏览器引擎
- Accessibility Tree 优先（结构化，可靠）
- Vision 辅助（复杂布局时）
- 每个 Agent 可以有独立的浏览器 Profile（cookie, 登录态）

#### 2.5.3 认证管理

Agent 使用 Web 工具需要登录。方案：

| 方式 | 安全性 | 适用 |
|------|--------|------|
| OAuth 代理 | 高 | 支持 OAuth 的应用 |
| Cookie 注入 | 中 | 不支持 OAuth 的内部系统 |
| 密码保管 | 低 | 最后兜底 |
| SSO 代理 | 高 | 企业 SSO 环境 |

### 2.6 人机协作：悬赏机制

当 Agent 遇到自己无法完成的任务时：

```
Agent: "我需要一张产品的 banner 设计图，尺寸 1200x630。
        我可以写文案和需求说明，但我没有设计能力。
        建议发布悬赏任务。"

系统选项：
  [1] 发给团队成员（内部协作）
  [2] 发布到悬赏市场（外部协作，预算: ¥200）
  [3] 我自己来做
  [4] 放弃这个子任务
```

**悬赏市场特点：**
- Agent 自动生成任务描述
- 设置预算和截止时间
- 人类完成后，Agent 验收
- 支持内部（团队成员）和外部（自由职业者）

---

## 第三部分：行业解决方案

### 3.1 软件开发团队

**角色配置：**
| Agent | 职责 | 核心 Skills |
|-------|------|------------|
| Dev Lead | Code review, 架构决策 | github, code-analysis, architecture |
| Full-Stack Dev | 编码, 测试, 部署 | github, shell, testing, docker |
| QA Engineer | 测试用例, 自动化测试 | testing, browser-test, bug-report |
| DevOps | CI/CD, 监控, 告警 | docker, kubernetes, monitoring |

**自动化场景：**
- PR 提交 → QA Agent 自动跑测试 → Dev Lead Agent 审 Code → 自动合并
- 线上告警 → DevOps Agent 自动排查 → 生成报告 → 通知人类
- Issue 创建 → 自动评估优先级 → 分配给合适的 Agent

### 3.2 营销 / 内容团队

**角色配置：**
| Agent | 职责 | 核心 Skills |
|-------|------|------------|
| Content Writer | 文章, 文案, 社媒 | writing, seo, social-media |
| SEO Specialist | 关键词研究, 排名追踪 | seo-tools, analytics, web-search |
| Social Media Manager | 发帖, 互动, 数据 | twitter, linkedin, instagram |
| Data Analyst | 数据分析, 报告 | analytics, sheets, visualization |

**自动化场景：**
- Content Writer 每天写一篇 SEO 文章 → SEO Agent 优化 → 自动发布
- Social Media Agent 监控评论 → 自动回复常见问题 → 复杂问题转人工
- Data Analyst 每周生成营销报告 → 自动发给团队

### 3.3 客户支持

**角色配置：**
| Agent | 职责 | 核心 Skills |
|-------|------|------------|
| L1 Support | 常见问题, 工单分类 | knowledge-base, ticket-system |
| L2 Support | 复杂问题, 技术排查 | knowledge-base, shell, logs |
| Customer Success | 客户健康度, 续费 | crm, analytics, email |

**自动化场景：**
- 用户提问 → L1 Agent 知识库搜索 → 自动回复
- 无法解决 → L1 自动升级给 L2 → L2 排查后回复
- L2 也搞不定 → 创建悬赏任务给人类工程师

### 3.4 财务 / 行政

**角色配置：**
| Agent | 职责 | 核心 Skills |
|-------|------|------------|
| Bookkeeper | 记账, 对账, 发票 | accounting, sheets, ocr |
| Admin Assistant | 日程, 会议, 文档 | calendar, docs, email |
| Procurement | 采购, 比价, 供应商 | web-search, sheets, email |

### 3.5 HR / 招聘

| Agent | 职责 | 核心 Skills |
|-------|------|------------|
| Recruiter | 搜索简历, 初筛, 约面 | linkedin, email, calendar |
| HR Ops | 入离职, 考勤, 合规 | docs, sheets, hr-system |

---

## 第四部分：商业模式与定价

### 4.1 一揽子 AI 订阅方案

**核心理念**：用户付费后，AI 员工能够无限制地使用各种 AI 工具和 LLM——不用自己去买各种 API Key。

#### 定价方案

| 计划 | 价格 | 包含 | 适用 |
|------|------|------|------|
| **Solo** | ¥199/月 | 2 个 Agent, 100K token/日, 基础 Skills | 个人 / 自由职业 |
| **Team** | ¥999/月 | 10 个 Agent, 500K token/日, 全部 Skills, 飞书/Slack 集成 | 中小团队 |
| **Business** | ¥2999/月 | 50 个 Agent, 2M token/日, 优先级支持, 浏览器自动化, 私有部署 | 中型公司 |
| **Enterprise** | 定制 | 无限 Agent, 无限 token, SLA, 专属支持, 合规 | 大公司 |
| **Self-hosted** | ¥4999/年 | 软件授权, 无 token 限制（自带 Key）, 源码访问 | 有技术能力的团队 |

#### AI 工具订阅池

Markus 订阅包含的 AI 能力：
- **LLM**：Claude, GPT-4, DeepSeek, Gemini — 自动选最优
- **图片**：DALL·E, Midjourney API, Stable Diffusion
- **语音**：Whisper, ElevenLabs
- **搜索**：Perplexity, Tavily
- **代码**：GitHub Copilot 等价能力（内置）

### 4.2 悬赏市场

```
平台抽成模型：
  悬赏金额 ¥0-100   → 平台抽 20%
  悬赏金额 ¥100-1000 → 平台抽 15%
  悬赏金额 ¥1000+   → 平台抽 10%

Agent 自动定价建议：
  "根据市场价，这个设计任务建议悬赏 ¥300-500"
```

---

## 第五部分：技术架构设计

### 5.1 系统架构

```
┌──────────────────────────────────────────────────────────────┐
│                        用户接入层                              │
│  Web UI  │  飞书 Bot  │  Slack Bot  │  CLI  │  API  │  Email  │
└────────────────────────────┬─────────────────────────────────┘
                             │
┌────────────────────────────┴─────────────────────────────────┐
│                     Markus Gateway                            │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐   │
│  │ Auth & RBAC │  │ Rate Limiter │  │ Message Router     │   │
│  └─────────────┘  └──────────────┘  └────────────────────┘   │
└────────────────────────────┬─────────────────────────────────┘
                             │
┌────────────────────────────┴─────────────────────────────────┐
│                     Agent Runtime                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│  │ Agent A  │  │ Agent B  │  │ Agent C  │  │ Agent D  │     │
│  │ (Dev)    │  │ (PM)     │  │ (Ops)    │  │ (Support)│     │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘     │
│       └──────────────┴──────────────┴──────────────┘          │
│                      Agent Bus (A2A)                          │
└────────────────────────────┬─────────────────────────────────┘
                             │
┌────────────────────────────┴─────────────────────────────────┐
│                     能力层                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│  │ LLM Pool │  │ Skills   │  │ Browser  │  │ Sandbox  │     │
│  │ Router   │  │ Registry │  │ Pool     │  │ Manager  │     │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘     │
└────────────────────────────┬─────────────────────────────────┘
                             │
┌────────────────────────────┴─────────────────────────────────┐
│                     存储层                                     │
│  PostgreSQL  │  Redis  │  S3/MinIO  │  Vector DB              │
└──────────────────────────────────────────────────────────────┘
```

### 5.2 Agent 生命周期（革新设计）

```
传统: Create → Start → Work → Stop → Delete
Markus: Onboard → [Always Available] → Offboard

详细流程:
  Onboard（入职）
    ├─ 分配角色和权限
    ├─ 安装必要 Skills
    ├─ 加入团队和频道
    ├─ 接收入职培训（Context 注入）
    └─ 开始自主工作（监控心跳任务 + 响应消息）

  日常工作（无需人类触发）
    ├─ 早间：检查邮件、Issue、消息
    ├─ 持续：响应 @mention 和任务分配
    ├─ 主动：发现问题发起告警
    ├─ 汇报：日报/周报自动生成
    └─ 学习：更新长期记忆

  Offboard（离职）
    ├─ 工作交接（给其他 Agent 或人类）
    ├─ 知识保留（记忆导出到团队知识库）
    └─ 账号归档
```

### 5.3 Skills 运行时

```typescript
interface Skill {
  manifest: SkillManifest;        // skill.yaml 的结构化表示
  tools: AgentToolHandler[];       // 提供的工具
  heartbeatTasks?: HeartbeatTask[]; // 提供的心跳任务
  prompts?: string[];              // 提供的提示词增强
  setup?(config: Record<string, string>): Promise<void>;  // 初始化
  teardown?(): Promise<void>;      // 清理
}

interface SkillManifest {
  name: string;
  version: string;
  description: string;
  author: string;
  category: SkillCategory;
  permissions: string[];
  config: Record<string, ConfigField>;
  tools: ToolDescriptor[];
  heartbeatTasks?: HeartbeatTaskDescriptor[];
  dependencies?: string[];   // 依赖其他 skills
}

type SkillCategory =
  | 'development' | 'marketing' | 'operations' | 'finance'
  | 'hr' | 'customer-support' | 'design' | 'legal'
  | 'communication' | 'productivity' | 'data' | 'browser';
```

### 5.4 浏览器池

```typescript
interface BrowserPool {
  // 每个 Agent 可以获取一个持久化的浏览器实例
  acquire(agentId: string, options?: BrowserOptions): Promise<BrowserSession>;
  release(agentId: string): Promise<void>;

  // 浏览器 session 持久化（cookie, localStorage）
  saveProfile(agentId: string): Promise<void>;
  loadProfile(agentId: string): Promise<void>;
}

interface BrowserSession {
  // 高级 API（Agent 调用）
  navigate(url: string): Promise<PageSnapshot>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  extract(instruction: string): Promise<string>;  // 用 LLM 理解页面并提取信息
  act(instruction: string): Promise<void>;         // 用 LLM 理解并执行操作
  screenshot(): Promise<Buffer>;
  getAccessibilityTree(): Promise<AccessibilityNode>;
}
```

### 5.5 消息总线

```typescript
interface MessageBus {
  // 统一消息发布/订阅
  publish(channel: string, message: UnifiedMessage): void;
  subscribe(channel: string, handler: MessageHandler): void;

  // 频道管理
  createChannel(name: string, members: string[]): void;
  addMember(channel: string, memberId: string): void;

  // 路由：平台消息 → Agent
  routeIncoming(platform: string, rawMessage: unknown): void;

  // 路由：Agent 回复 → 平台
  routeOutgoing(agentId: string, message: UnifiedMessage): void;
}
```

---

## 第六部分：任务拆解

### Phase 5 — 产品化重构（预计 4 周）

#### P5-1: Agent 主体性重构（Week 1）
- [x] 移除 Start/Stop 语义，Agent 入职即持续在线（onboard/offboard语义）
- [x] Agent Daemon 模式：后台持续运行，自动恢复（auto-start on hire）
- [x] 工作日程系统：Agent 自动管理自己的工作节奏（HeartbeatScheduler 自动运行）
- [x] 日报/周报自动生成（generateDailyReport API）
- [x] Agent Profile 页面重设计（AgentProfile.tsx + 对话 + 详情）

#### P5-2: Web UI 工作空间重构（Week 1-2）
- [x] 全新布局：侧边栏 + 工作区 + 命令栏（三区分组 Sidebar）
- [x] 消息中心：频道模式 + @mention + 消息汇聚（Messages 页面 + 频道 + @mention 下拉）
- [x] 全局命令栏：自然语言指令驱动一切（CommandBar 组件）
- [x] URL 路由（hash-based 路由，无需额外依赖）
- [x] 响应式设计（移动端侧边栏折叠 + 汉堡菜单）

#### P5-3: Skills 系统（Week 2）
- [x] Skill 规范定义（SkillManifest + manifest.json）
- [x] Skill 运行时：加载、安装、卸载（SkillRegistry）
- [x] 第一批官方 Skills：git, code-analysis, browser, feishu
- [x] `markus skill init/test/publish` CLI 命令（skill:list/init/test）
- [x] Skill Store 前端页面（SkillStore.tsx）

#### P5-4: 飞书深度集成（Week 2-3）
- [ ] OAuth 授权流程（Web UI 扫码）
- [ ] WebSocket 长连接模式（不需要公网 IP）
- [x] 群消息双向同步（FeishuAdapter webhook + send）
- [x] 飞书文档读写 Skill（feishu_read_doc, feishu_search_docs）
- [x] 飞书审批集成 Skill（feishu_create_approval, feishu_approval_status）
- [x] 飞书卡片消息（feishu_send_card）

#### P5-5: 浏览器能力（Week 3）
- [ ] Browser Pool：每个 Agent 一个持久化浏览器实例（需Playwright集成）
- [ ] 认证管理：OAuth 代理 + Cookie 注入
- [x] Browser Skill 基础工具：navigate, click, type, extract, evaluate
- [ ] 浏览器 Profile 持久化（登录态保持）
- [ ] 浏览器操作录屏（Debug 用）

#### P5-6: 人机协作与悬赏（Week 3-4）
- [x] 审批队列：Agent 发起 → 人类审批（HITLService + API）
- [x] 悬赏任务系统：Agent 创建 → 人类接单 → Agent 验收（bounties API）
- [x] 内部协作：Agent 遇到困难 → 求助人类同事（notifications API）
- [ ] 通知系统：邮件 / 飞书 / WebPush 通知（仅WebSocket推送，缺邮件/飞书通知）

#### P5-7: 行业模板（Week 4）
- [x] 软件开发团队模板（dev-team.json）
- [x] 营销团队模板（marketing-team.json）
- [x] 客户支持模板（support-team.json）
- [x] 一键部署行业方案（team:deploy + team:list CLI 命令）
- [x] 新手引导流程（Onboarding 3步向导 + 首次创建 Agent）

#### P5-8: 商业化基础（Week 4）
- [x] 用量计量：Token, 任务数, 浏览器时间（BillingService）
- [x] 多租户隔离（orgId 在所有 API 中）
- [x] API Key 管理（用户自带 vs 平台提供）
- [x] 基础计费系统（plan tiers: free/pro/enterprise）

---

## 第七部分：成功度量

### 北极星指标

**Agent 自主完成任务数 / 总任务数**

这个比率代表了 Agent 的真正自主性——不需要人类介入就能完成的任务比例。

### 关键指标

| 指标 | 目标 | 说明 |
|------|------|------|
| Agent 自主完成率 | >70% | 无需人类介入完成的任务比例 |
| 首次响应时间 | <5秒 | 用户 @mention 到 Agent 开始处理 |
| 任务完成时间 | <人类 50% | Agent 完成常规任务的时间 vs 人类 |
| 用户满意度（回复质量） | >4.0/5 | Agent 回复的质量评分 |
| Skill 安装量 | >1000/月 | 社区生态活跃度 |
| 日活 Agent 数 | 增长 20%/月 | 平台规模 |
| Token 效率 | 持续优化 | 单位任务消耗的 token 数 |

---

## 第八部分：竞争壁垒

1. **Agent 主体性设计** — 不是聊天机器人，是真正的数字同事
2. **Skills 生态** — 社区驱动，网络效应，越多人用越好用
3. **行业方案** — 不是通用工具，是特定角色的完整解决方案
4. **飞书/钉钉深度集成** — 中国市场刚需，竞品做不深
5. **人机协作闭环** — AI 做不到的，无缝转给人类完成
6. **一揽子 AI 订阅** — 用户不需要自己管各种 API Key

---

## 第九部分：能力增强路线图（v2）

### 9.1 观测性和审计系统

**目标**：完整记录每个 Agent 的每一次操作、token消耗、工具调用，支持 CLI/API/UI 查看。

**任务**：
- [x] AuditLog 服务：记录 agent_message / tool_call / llm_request / task_update 事件
- [x] Token 消耗实时追踪：每次 LLM 调用后累加，按 agent / org 聚合
- [x] CLI `audit:log` 命令查看审计日志
- [x] API `GET /api/audit` 查询审计记录
- [x] Web UI Dashboard 展示 token 消耗趋势

### 9.2 Agent 间协作 (A2A 消息总线)

**目标**：Agent 可以直接给其他 Agent 发消息，实现真正的团队协作。

**任务**：
- [x] AgentBus：agent_send_message 工具，Agent 可以给同事发消息
- [x] 消息路由：Agent A 发消息 → 系统转给 Agent B → B 处理后回复 A
- [x] CLI `agent:message` 命令发送 A2A 消息
- [x] API `POST /api/agents/:id/a2a` 端点

### 9.3 自适应 LLM 选型

**目标**：根据任务复杂度自动选择最合适的模型，优化 token 成本。

**任务**：
- [x] 任务复杂度评估：根据 prompt 长度、工具数量、上下文大小判断
- [x] 模型路由策略：简单对话用经济模型，复杂推理用强模型
- [x] LLMRouter 增加 autoSelect 模式
- [x] 运行时 fallback：如果首选模型失败，自动切换备选

### 9.4 Agent 成长系统

**目标**：追踪 Agent 在各 Skill 领域的使用频率和效果，量化"经验值"。

**任务**：
- [x] SkillProficiency 数据模型：skill名 + 使用次数 + 成功率
- [x] 每次工具调用后自动更新 proficiency
- [x] CLI `agent:profile` 查看成长数据
- [x] API 返回 proficiency 信息

### 9.5 错误恢复和韧性

**目标**：工具执行失败时自动重试，LLM 调用失败时降级到备选模型。

**任务**：
- [x] 工具执行重试：失败后最多重试 2 次，指数退避
- [x] LLM 调用 fallback：主模型超时/失败时自动切换
- [x] 人工兜底：连续失败 3 次后发通知请求人类介入

---

## 附录：名词对照

| 概念 | 传统说法 | Markus 说法 |
|------|---------|------------|
| 创建 Agent | Create Agent | 招聘/入职（Hire/Onboard） |
| 启动 Agent | Start Agent | — （不需要，始终在线） |
| 停止 Agent | Stop Agent | 休假（Vacation） |
| 删除 Agent | Delete Agent | 离职（Offboard） |
| Agent 列表 | Agent List | 团队花名册（Team Roster） |
| 发送消息 | Send Message | @mention / 对话 |
| 任务分配 | Assign Task | "让 Alice 去做这件事" |
| 查看状态 | Status Check | "Alice 在忙什么？" |
