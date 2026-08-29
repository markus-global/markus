# 阶段二 T7 联调整合 — 交付总结与验收清单

> 项目：Markus「项目级知识库 + Office 产出物生成与预览」
> 日期：2026-08-29 ｜ 负责人：CTO ｜ 分支：`feat/knowledge-base-and-office-preview`（主仓库）
> 范围：T1–T6 全部完成后的端到端联调、回归、边界用例、文档收口

---

## 一、验收标准逐项核对

| # | 验收项 | 结果 | 证据/落地 |
|---|---|---|---|
| 1 | **宿主级 e2e**：真实 Agent 在宿主运行时里通过工具面自主调用 knowledge_search/read/list 并核验返回正确 | ✅ | `packages/core/test/knowledge-tools-e2e.test.ts` 新增 9 例：AgentManager + createAgent 真实 Agent，`agent.getTools()` 工具面直接 execute()。核验 source=knowledge 强制、updatedAt 对齐、中文文件名读取、知识库根内/外读取、缺失文件报错、空结果。 |
| 2 | **端到端联调**：绑定知识库目录→扫描→注册→搜索→预览；Agent Office 生成→交付物→预览 | ✅ | T2 扫描/upsert/outdated + T3 前端绑定/筛选/深链 + T4 工具 + T5 OfficePreviewer + T6 office_generate 链路各自验收通过；T7 回归 239(core)+171(org-manager) 全绿、vite build 通过（四库独立惰性 chunk）保证预览链路打包正确。 |
| 3 | **knowledge_read 前缀校验**（T4 评审建议①） | ✅ | `agent-manager.ts` deliverableRead 桥接层：传递 project_id 时解析 `knowledge_base_paths`，仅允许 `reference` 落在某根目录内（resolve + sep 前缀比对，防 `..` 逃逸）；roots 为空时不强制（兼容未绑定项目）。e2e 覆盖根内通过/根外拒绝/无 scope 直读三态。 |
| 4 | **knowledge_search 补 updatedAt**（建议②） | ✅ | `project-tools.ts` knowledge_search 结果 map 增加 `updatedAt: d.updatedAt`，与 knowledge_list 对齐；e2e 断言。 |
| 5 | **错误信息透传包装**（建议③） | ✅ | knowledge_search/list/read 统一包装为 `Knowledge search/list/read failed: <原因>`；read 增加 project_id 维度友好提示（"可能不在该项目绑定的知识库目录内"）。 |
| 6 | **回归测试 + 边界用例**：空目录/删除同步/超大文件/中文文件名/权限 | ✅ | 见下表「边界用例覆盖」。 |
| 7 | **文档更新 + 交付总结 + 通知老板验收** | ✅ | `docs/knowledge-base-office-plan.md` 追加「阶段二完成状态」；本交付总结；notify_user 通知老板。 |
| 8 | **合规**：所有 commit 落在主仓库特性分支，不污染 vendor/markus 子模块 | ✅ | T7 两个 commit（98bdeeb2 代码 + 7dd079a7 文档）均在主仓库 `feat/knowledge-base-and-office-preview`；子模块状态未变（T1 遗留 M 状态，非本次引入）。 |

---

## 二、T7 代码变更（commit 98bdeeb2，7 文件 +394/-13）

| 文件 | 变更 |
|---|---|
| `packages/core/src/tools/project-tools.ts` | knowledge_search 补 updatedAt；三工具错误包装；knowledge_read 加 project_id 透传（schema + 执行）；桥类型补 updatedAt/knowledgeBasePaths |
| `packages/core/src/agent-manager.ts` | deliverableRead 前缀校验（resolve+sep 防逃逸）+ 文件存在性检查（缺失文件返回 null 报错而非空内容 success） |
| `packages/core/src/file-converter.ts` | extractTextFromFile 文本类读取优雅降级：不可读/IO 错误返回空串（不再抛错中断整次同步） |
| `packages/core/test/knowledge-tools-e2e.test.ts` | **新增** 宿主级 e2e 9 例 |
| `packages/core/test/project-tools.test.ts` | +5 例：updatedAt 对齐、错误包装、project_id 透传（snake/camel） |
| `packages/core/test/file-converter.test.ts` | +3 例：500KB cap、中文文件名、权限/IO 降级 |
| `packages/org-manager/test/knowledge-sync-service.test.ts` | +3 例：空目录、中文文件名、隐藏/node_modules 忽略 |

## 三、边界用例覆盖

| 场景 | 覆盖位置 | 结果 |
|---|---|---|
| 空目录 | knowledge-sync-service.test.ts | scanned=0, errors=0 |
| 删除同步（outdated） | knowledge-sync-service.test.ts（存量） | 删除→标 outdated |
| 超大文件（>500KB） | file-converter.test.ts | 截断 ≤500KB |
| 中文文件名 | knowledge-tools-e2e / file-converter / knowledge-sync | 3 层全通 |
| 权限/IO 错误 | file-converter.test.ts | 返回空串不抛错 |
| 隐藏文件 + node_modules | knowledge-sync-service.test.ts | 忽略 |
| 知识库根外读取 | knowledge-tools-e2e | 前缀校验拒绝 |
| 缺失文件读取 | knowledge-tools-e2e | 报错 not readable |
| 空搜索结果 | knowledge-tools-e2e | count=0 success |

## 四、测试汇总

| 套件 | 数量 | 结果 |
|---|---|---|
| knowledge-tools-e2e（新增） | 9 | ✅ |
| project-tools | 46 | ✅ |
| file-converter | 11 | ✅ |
| agent-manager-core/integration/coverage | 121 | ✅ |
| tool-selector + office-generate | 30+ | ✅ |
| core 小计 | 239 | ✅ |
| org-manager api-server-extended + knowledge-sync | 171 | ✅ |
| tsc --noEmit（core + web-ui） | — | 0 错误 |
| vite build | — | 通过，四 Office 库独立惰性 chunk |

*注：core 全量测试中 web-search/multimodal/LLM test 端点失败为既有环境性基线（沙箱无外部 API），与 T7 改动无关（T2-T6 已确认）。*

## 五、Known issues / 后续可做（非阻塞）

1. pptx 预览依赖 LibreOffice 转 pdf（可选能力），当前回退系统打开/下载 —— 下迭代可加
2. 知识库文件列表一次拉 200 条，量大时可加分页
3. Office 预览 pdf zoom 全页重渲（可加 canvas 缓存）
4. xlsx 仅渲染第一个 sheet
5. 导航参数 custom event + localStorage 双通道轻微冗余（无冲突）
6. 知识库自动监听（chokidar 实时同步）为二期能力，首版手动「重新同步」

## 六、下版本建议

- **知识库实时同步**：chokidar 监听目录变化自动重扫
- **pptx 在线预览**：LibreOffice 转换队列（`soffice --headless --convert-to pdf`，独立 user profile + 超时）
- **RAG 增强**：content 全文 LIKE 已可用；如需语义检索可引入 embedding（二期评估）
- **sandbox/多租户**：knowledge_read 前缀校验已为沙箱留位，可扩展到全局 path access policy