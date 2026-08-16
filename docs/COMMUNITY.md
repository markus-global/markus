# Markus Community Guide（社区指南）

Markus 的目标是把「先用起来的人」转化为「留下来共建的人」。本文档是社区入口的单一事实来源（single source of truth）：渠道矩阵、加入方式、运营规则与启动清单。

> 状态图例：🟢 已上线 · 🟡 建设中 · 🔵 规划中

---

## 1. 渠道矩阵

| 渠道 | 语言 | 状态 | 用途 |
|------|------|------|------|
| [GitHub Discussions](https://github.com/markus-global/markus/discussions) | EN/中文 | 🟢 | 问答、Show & Tell、功能讨论、案例征集（官方首选异步渠道） |
| [GitHub Issues](https://github.com/markus-global/markus/issues) | EN | 🟢 | Bug 与具体功能请求（含 good first issue / help wanted） |
| [Blog](https://markus.global/blog) | EN | 🟢 | 教程、发布公告、案例故事 |
| **Discord** | EN（全球） | 🟡 | 实时交流、贡献者协作、发布播报 —— 见下方启动计划 |
| **微信群** | 中文 | 🟡 | 中文用户交流、内测反馈、本地化协作 —— 见下方启动计划 |
| X (Twitter) | EN | 🔵 | 产品动态、社区 showcase（运营团队已在推进） |

**运营原则**：所有渠道最终沉淀回 GitHub（讨论结论 → issue；案例如需公开 → 博客/文档）。Discord/微信群定位为「实时入口」，不替代异步可见的 GitHub 讨论。

---

## 2. Discord（EN / 全球）— 启动计划

**为何选 Discord**：开源 AI 项目社区主流（如 LangChain、LlamaIndex、n8n），支持实时协作、机器人接入、与 GitHub 联动（GitHub bot 可用）。

**目标频道结构**（建议）：

```
#welcome          群规 + 角色领取（Contributor / User / Maintainer）
#general          闲聊与答疑
#show-and-tell    作品展示
#contributing     贡献指引、找搭子、PR 求助
#releases         GitHub 发布自动播报
#core-runtime     core/org-manager 深度讨论（可选，后期热度够了再开）
```

**启动清单（Markus 团队内部 TODO）**

- [ ] 创建 Discord 服务器（建议团队首个身份 → `markus-global`）
- [ ] 配置群规则与 `welcome` 频道（引用我们的 [Code of Conduct](../CODE_OF_CONDUCT.md)）
- [ ] 生成邀请链接（设置不失效），填入下方「邀请链接」栏
- [ ] 接 GitHub 通知机器人（`Github` webhook / Zappier），播报 releases 与 good-first-issue 变动
- [ ] README 社区区块启用 Discord 徽章链接

**邀请链接：** `<!-- TODO: 创建 Discord 服务器后把 invite 链接填到这里，并在 README 中引用 -->`

---

## 3. 微信群（中文）— 启动计划

**为何邀请**：中文用户与贡献者占比较大，微信群 / 公众号是中文社区最自然的入口；同时承担中文文档本地化、内测反馈、以及「把用户转化为 contributor」的贴身支持。

**启动清单（TODO）**

- [ ] 创建官方微信群（维护者或运营联系人建群，开启「群聊邀请确认」防广告）
- [ ] 生成群二维码 → 放入本文档与 README.zh-CN.md
- [ ] 创建「Markus 助手」接待口径：入群后引导看 `CONTRIBUTING.md`、领 good-first-issue
- [ ] 中文本地化协作空间：翻译 `docs/*`、README 维护、术语表统一

**微信群二维码：** `<!-- TODO: 群二维码图片（保持更新，防止过期） -->`

**入群暗号约定**：加入时备注「Markus + GitHub 用户名」（若没有 GitHub 引导先注册，为贡献转化铺路）。

---

## 4. 行为准则

社区所有渠道（GitHub、Discord、微信群、博客）均适用 [Code of Conduct](../CODE_OF_CONDUCT.md)（Contributor Covenant 2.1）。不当行为可向 `conduct@markus.global` 举报。

---

## 5. 从用户到贡献者的转化路径

| 阶段 | 用户动作 | 我们说 |
|------|---------|--------|
| 尝试 | 跑起 Markus、提 issue | README Quick Start → `markus start` |
| 提问 | GitHub Discussion / Discord / 微信 | 值班者 48h 内响应，沉淀 FAQ |
| 反馈 | bug / 功能请求 | 维护者确认 → 转成 issues + 标签 |
| **成为贡献者** | 认领 `good first issue` | CONTRIBUTING 指南 + good-first-issue 清单；第一次 PR 合入后邀请进 Contributor 频道/群（Discord role / 微信群「贡献者」备注） |
| 深度参与 | 写适配器 / 文档 / 测试 | 合入 3+ PR → 提速处理其 PR；邀请加入 Maintainer |

**关键转化点**：第一次被合入是留存率最高的时刻。欢迎流程里明确「你已经是贡献者了」，给与 Role / 徽章 / 致谢。

---

## 6. 维护责任

- **响应时限**：GitHub issues/discussions 48 小时内有人回应（自动 AI 助手 + 人工轮值）；Discord 工作时间 2-4h。
- **举报处理**：`conduct@markus.global` 收件 → 维护团队 48h 内评估 → 按 CoC Enforcement Guidelines 处理。
- **内容边界**：不接受广告/软广；鼓励 showcase 但需真实使用痕迹。

---

## 7. 里程碑

- [x] GitHub Discussions / Issues / Blog 上线
- [ ] Discord 创建并接入（README 可点）
- [ ] 微信群建立（README.zh-CN 可点）
- [ ] 第一个 community case study 上 README「Real Teams on Markus」
- [ ] 首位外部贡献者 PR 合入

*本项目文档维护：欢迎 PR 完善本页（尤其渠道链接与翻译）。*