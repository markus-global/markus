# 外部 IM 集成设置页：一次性修复交付说明

> 需求 `req_f2610b70e3196b1201d4bf1b`（通用消息网关）· 任务 `tsk_edae00303ad6f30e1b1fc976`
> 分支 `task/tsk_edae00303ad6f30e1b1fc976`（base = main tip `b962a1e0`）
> **不提 PR** —— 交老板手动验证。

---

## 一、摘要

老板在真实环境提的 5 个问题**一次性全部修好**；另外修掉 3 个由「把 `agentId` 改成必填」引发的
连带回归（§五，其中「配好凭据却连不上平台」是会真实掉线的那个）。

| # | 问题 | 状态 |
|---|------|------|
| 1 | 中文界面大量英文 | ✅ 中文界面零英文（Slack/Telegram 等专名除外） |
| 2 | 「可选设置」永远全展开、卡片太长 | ✅ 默认折叠，点击展开 |
| 3 | 绑定 Agent 应必填 + 默认秘书 | ✅ 必填；建实例即绑定秘书（**按角色解析，未硬编码 id**） |
| 4 | **P0** 绑定 Agent「选完就丢」 | ✅ 选中即保留；重渲染 / Save routing / 群列表返回都不再清空 |
| 5 | 两个保存按钮互相破坏 | ✅ routing 只写 `notifyAgentId`，`agentId` 单一写者 |

---

## 二、改动清单（18 改 + 2 新增测试）

**前端 `packages/web-ui`**

| 文件 | 改动 |
|------|------|
| `components/integrations/InstanceCard.tsx` | `instanceAsPlatform` 用 `useMemo` 稳定引用；routing 保存改调新签名 |
| `components/integrations/PlatformCard.tsx` | 草稿重置改为「按已存值指纹」；可选设置默认折叠 |
| `lib/platformIntegrations.ts` | 新增 `statusFingerprint()`（草稿重置的判据） |
| `lib/instanceIntegrations.ts` | `buildRoutingPayload(notifyAgentId)` —— 只写 routing 键 |
| `locales/zh-CN/settings.json`、`locales/en/settings.json` | 补齐 22 个 key + 中文复数 |
| `test/instancesSection.test.tsx`、`test/integrationsSection.test.tsx` | 既有用例随契约更新 |

**后端**

| 文件 | 改动 |
|------|------|
| `comms/src/platforms/registry.ts` | `AGENT_BINDING_FIELD.required: false → true`（一处改，5 平台生效） |
| `org-manager/src/instance-integrations.ts` | 未绑定实例**读取穿透**默认秘书；保存时存量空值视为已有默认（**建实例不写 config**，见 §九） |
| `org-manager/src/platform-integrations.ts` | 新增 `readPlatformValuesForSave()`，供校验与写入共用 |
| `org-manager/src/api-server.ts` | `defaultAgentIdFor()` 复用 `@markus/shared#pickOrgSecretary`；平台接口校验改走同一函数 |
| `cli/src/commands/start.ts` | `isManifestEnabled` 不再让 routing 字段门禁「连接」 |

**新增测试**

| 文件 | 覆盖 |
|------|------|
| `web-ui/test/instanceCardRerender.test.tsx` | (a) 无关重渲染不清空草稿；(b) 新数据到达仍会刷新草稿 |
| `web-ui/test/integrationLocaleKeys.test.ts` | zh/en 与组件实际使用的 key 对齐（防回归） |

---

## 三、P0 根因（已定位到行）与修法

**两处叠加**：

1. `InstanceCard.tsx:243` —— `status={instanceAsPlatform(instance)}` **每次渲染都新建对象**，
   引用永不相等。
2. `PlatformCard.tsx:333` —— `useEffect(() => { setDraft(initialDraft(status)); … }, [status])`
   依赖的是**对象引用**，于是 InstanceCard 的**任意**一次重渲染（改 notification target、
   点 Save routing、群列表异步返回）都会把整个凭证草稿重置回服务端已存值 —— 含刚选好的 `agentId`。

**修法（两处都修，缺一不可）**

- `instanceAsPlatform(instance)` 用 `useMemo(…, [instance])` 稳定引用。
- 重置 effect 的判据从「引用」换成「**已存值内容指纹**」：新增 `statusFingerprint(status)`
  （`lib/platformIntegrations.ts`），只有指纹变化才重置草稿与启用态。
  —— 这样「保存后回读会刷新」仍然成立（内容确实变了），但无关重渲染不会再清空用户的选择。
  **没有删掉 effect**。

---

## 四、其余各项修法要点

**i18n**：zh-CN 与 en **两个** locale 都补齐 `instances.*`、`integrations.agentSelect.*` 共 22 个 key
（此前 zh-CN 整个 `instances.*` 命名空间都不存在）；`1 bot(s)` 改为 i18next 复数
（`instances.botCount` + `botCount_one`，中文「N 个机器人 / 1 个机器人」）；组件内多余的英文
`defaultValue` 兜底一并去掉。

**可选设置折叠**：`PlatformCard` 的 Options 块默认折叠，必填/凭证区保持默认可见。

**必填 + 默认秘书**：`required: true` 改在 manifest 一处。默认值**按角色解析**：
`defaultAgentIdFor(orgId)` 复用 `@markus/shared` 里**已经存在**的规范谓词
`pickOrgSecretary`（`OrgService` 与网关迁移用的是同一个，避免「同一事实两个实现」），
再用 `agentRepo.listAll()` 过滤本 org。**未硬编码 `agt_…`**。
该默认在**两个**点生效：未绑定实例**读取时穿透**（前端直接显示秘书）→ 保存时存量空值视为
已有默认（首次真实保存即把绑定**物化**进 config，**升级不卡死**；org 完全没有秘书时仍如实
拦截并报错，不静默绑错人）。
**建实例时绝不写 config**（修订版，见 §九）：`agentId` 是路由键、不是凭据；若在创建时写入，
`hasConfig`（= 已存 config 非空）会一出生即为 true，而页面把它当作「凭据已配置」的代理 ——
会隐藏飞书「一键扫码创建」面板、并在空 bot 上显示「断开连接」。

**两个保存按钮**：选择「**routing 只写 routing 键**」——`buildRoutingPayload` 现在只返回
`{ notifyAgentId }`，不再回放 `instance.values`。凭证（含 `agentId`）的唯一写者是凭证区的
「保存」，routing 只拥有 `notifyAgentId`。
验证步骤（先在 credentials 区把 agent 改成 C，再改 notification target 为 T，再点 Save routing，
最后刷新页面）：应看到 **agent = C、notify = T**，而不是 agent 被打回旧值。

---

## 五、连带回归：把 `agentId` 改成必填之后暴露出的 3 个问题（已修）

改「必填」时跑全量回归，暴露出 13 个失败。按根因归类只有 2 类（+ 1 处用例过时）：

**① 连接被门禁误伤（真实事故级）**
`cli/src/commands/start.ts#isManifestEnabled` 的判据是「**所有** required 字段都已就绪才算启用」。
`agentId` 一旦变成 required，**飞书/Telegram 即便凭据配好也不会再连接** —— 真实环境里表现为
「集成突然掉线」。这违反第一性原理：`agentId` 是**路由**字段，绝不可能是**连接**凭据。
修法：连接门禁只看「连接所需」字段，routing 字段（`type: 'agent'`）不参与。

**② 旧平台接口 400**
`POST /api/settings/integrations/:platform` 在 handler 里**自己又校验了一遍**（用未加默认值的
`readPlatformValues`），绕过默认秘书 → 保存被 400 拦下。
修法：抽出 `readPlatformValuesForSave(deps, manifest)`，让**校验**与**写入**读同一个函数
（规则单一来源），不再各写一份。

**③ 用例过时（非缺陷）**：1 条断言 `missing === ['appSecret']`，现在应含 `agentId`（无秘书的裸环境）。
相关 API 测试的 mock storage 补了一个最小秘书行，让默认值链路被**真实走到**，而不是靠放宽断言蒙过去。

---

## 六、验证步骤（老板手动，建议按序）

> 前置：`pnpm -w build`（或直接跑 dev）。页面：设置 → 外部 IM 集成。

1. **P0 绑定不丢**：展开任一实例 → 「绑定 Agent」选 Secretary → 再改「Notification target」→
   确认绑定仍是 Secretary（不再变回 "Not bound"）→ 点「Save routing」→ **刷新页面** →
   绑定仍在，且卡片头部显示 `→ Secretary`。
2. **中文零英文**：切到中文，逐项扫该页：应无 `ROUTING` / `Not bound` / `Save routing` /
   `Each bot is an instance…` / `1 bot(s)` / `No bots yet.` 等英文串（Slack/Telegram 除外）。
3. **可选设置默认折叠**：卡片「可选设置 / Options」默认收起，点开才显示非必填字段。
4. **必填 + 默认秘书**：新建一个 bot（新建实例）→ 打开后「绑定 Agent」已默认选中秘书，
   不需要先选才能保存；清空绑定再保存应被拦下并提示（说明必填真的生效）。
5. **两个保存按钮不互踩**：按 §四末尾那 4 步操作，确认 agent 与 notify 各归各的写者。

---

## 七、回归结果（本机实测，修订版 v2）

| 项 | 结果 |
|---|------|
| `npx tsc -b` | ✅ 0 error（修订后复跑） |
| 全量 `npx vitest run` | ✅ **6438 passed** / 10 skipped / **1 failed** |
| 唯一失败 | `cli/test/commands-start-integration.test.ts > auto-runs quickInit when config is missing`（60s 超时）。**既有环境性 flaky，与本轮无关**：评审已独立复现（quickInit 网络挂起、非断言失败），stash 回 base 同样失败。 |
| eslint（web-ui/org-manager/cli/comms 的 src） | 唯一 error 是 `cli/src/commands/start.ts:77 '@markus/shared' import is duplicated`，**base 已存在**（本轮未动该文件 import）。零新增告警。 |
| 受影响包单独复跑 | org-manager + web-ui：115 files / **2144 passed**；comms + cli：**602 passed** / 1 failed（同上 flaky）。 |

**牙齿检验（含本轮新增）**：
- P0：`instanceCardRerender.test.tsx` 断言「重渲染后草稿仍保留所选 agent」——修复前必红。
- 阻塞项 A（本轮）：临时把「建实例写入默认秘书」改回后，`instance-integrations.test.ts` 两条用例
  立即转红（`AssertionError: expected true to be false`，断言的正是 `status.hasConfig`）；
  恢复修复后 52 passed 全绿。

---

## 八、已知残余（如实列出）

1. **「可选设置」折叠判据是按 `type !== 'agent' && !required` 的通用字段分区**，不是新机制；
   若将来出现「非必填但属于连接凭据」的字段，它会落进折叠区 —— 目前 5 个平台没有这种字段。
2. **`isManifestEnabled` 的 routing 排除按 `type: 'agent'` 判定**，而非新增 manifest 标记位。
   语义够用（agent 类型永远不是连接凭据），但若将来要更严格的「连接字段」声明，应升级为
   manifest 显式标记 —— 本轮不引入新机制，保持改动面最小。
3. **本机无法验证真实飞书长连接路径**（需公网/真实凭据）：P0 与默认秘书均已用真实数据探针 +
   浏览器实测覆盖，但「连接成功」这一步仍建议老板在本机带凭据点一次。
4. **旧平台接口 `POST /api/settings/integrations/:platform` 现在也会要求 agentId**（若 org 无秘书则
   400）。生产环境 org 必有秘书，故实际不影响；已在测试中用真实秘书行覆盖。若老板认为旧接口
   不应要求该字段，可另行拍板 —— 本轮按需求「改一处即全平台生效」执行。
5. 未提 PR（按任务约定），改动停留在分支 `task/tsk_edae00303ad6f30e1b1fc976`。
6. **契约放宽（评审登记项，非阻塞）**：`missingRequiredFields` 现在对**所有** required 字段都
   「已存值即满足」（此前字符串必填字段只在「提交了空串」时才算缺失）。这是 routing-only 保存
   （只提交 `notifyAgentId`）所必需，但属契约放宽：旧平台接口
   `POST /api/settings/integrations/:platform` 省略任一**已存**必填字段也会被接受（原先 400）。
7. **接线缺口（观察，非本轮缺陷）**：`components/integrations/platformExtras.tsx` 的
   `PLATFORM_EXTRAS` 目前**没有任何生产代码引用** —— `Settings.tsx` 只渲染 `<InstancesSection />`
   且未传 `extras`，因此 `FeishuExtras`（一键扫码面板 / 群列表）当前不会在页面上挂载。
   这是**本轮之前就存在**的问题，与本轮 5 项修复无因果关系；本轮新增的 UI 回归测试通过**显式传入**
   `PLATFORM_EXTRAS` 来固定 `FeishuExtras` 的契约。是否补上生产接线由老板拍板（未擅自扩面）。

---

## 九、修订记录（第 2 轮，评审 §二 阻塞项 A）

评审在隔离 worktree 复验后指出：第 1 轮「建实例即写入默认秘书」会**立刻污染 `hasConfig`**
（`buildInstanceStatus` 的 `hasConfig = Object.keys(config).length > 0` 读的是**原始已存 config**），
使任何新建 bot 一出生 `hasConfig` 即为 true；而消费方把 `hasConfig` 当「凭据已配置」的代理
（`FeishuExtras` 的 `credentialsStored`、`PlatformCard` 的 `configured`）→ 空 bot 上隐藏扫码面板、
误显「断开连接」。这正是本页主路径的真实回归。

**采纳评审建议 (b)（改动面更小、语义更干净）**：
- `createInstance` **不再写 config**（回到 `config: {}`）；默认秘书改为**纯读取穿透** —— 与第 1 轮
  已实现的 `buildInstanceStatus` 读穿透、`saveInstance` 首次保存物化**直接复用**，无需新增机制。
- 语义回到单一事实：`hasConfig` 恒等于「org 存过东西」；routing 默认绝不冒充凭据。
- 测试同步：不再固化 `hasConfig: true`，改为断言「`agentId === 秘书` 且 `hasConfig === false`
  且原始 config 为空」，并保留「首次保存后物化」断言。
- **新增回归测试**：`web-ui/test/instancesSection.test.tsx` —— 新建飞书实例（仅带默认 agent、
  无凭据）→ 断言 **扫码面板 `feishu-register` 可见**、**无 `integration-disconnect`**；
  另加一条反向用例（凭据已存 → Disconnect 出现）防止矫枉过正。
  `org-manager/test/instance-integrations.test.ts` 同步断言新建 bot `hasConfig === false`（守住服务端根因）。

**仅做阻塞项 A + 提交 + handoff 更新**，未改动评审已通过的任何一项。
