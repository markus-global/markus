# Markus「项目级知识库 + Office 产出物生成与预览」调研与规划（V2）

> 状态：调研规划（阶段一）｜日期：2026-08-29｜作者：CTO
> 范围：两个需求合并为一个产品方向——让「项目」成为知识载体（知识库），让 Agent 能生成、团队能预览各类 Office 产出物。
> **V2 架构定调（老板拍板）**：知识库**统一用交付物（Deliverable）机制管理**，不另起一套独立知识库系统。知识库文档 = `source='knowledge'` 的交付物；Agent 产出物 = `source='agent'`（默认）。搜索/更新/预览/Agent 工具全部复用交付物同一套逻辑，只扩展标签与筛选。

---

## V2 架构总览（核心决策）

**一句话**：知识库是交付物的一个「来源标签」，不是独立系统。

- 交付物表加 `source`（`'agent'` / `'knowledge'`）字段，旧数据默认 `'agent'`。
- 用户绑定的知识库目录 → 扫描后批量注册为 `source='knowledge'` 的交付物（绑定 `project_id`）。
- 预览：与 Agent 产出物**完全同一套**（RightPanel / 产出物页面 / Office 预览组件）。
- 搜索：`deliverable_search` 扩展支持 `source` 过滤 + 全文内容搜索（对 KB 文件扫描时抽取文本入库）。
- Agent 工具：`knowledge_search/read/list` 是 `deliverable_*` 的封装，无需新基建。
- 更新：KB 文件变化 → 重新扫描 → upsert（复用 `status: active/outdated` 表达失效）。
- 项目详情「知识库区块」→ 直接**导航到产出物页面对应筛选**（project + source=knowledge）。

**收益**：单一数据源、单一预览、单一搜索/更新逻辑；不做两套系统；工作量比独立 KB 方案更小。

**关键实现点（新增）**：
1. `deliverables` 加 `source`（默认 `'agent'`）、`knowledge_root`（归属知识库根路径）、`content`（扫描抽取文本，供全文搜索）。
2. `project` 加 `knowledge_base_paths`（JSON，知识库绑定根目录们）。
3. 后台/工具 `knowledge_sync(projectId)`：扫目录 → upsert 为 KB 交付物；文件删除 → 标 outdated/删除；改动 → 重抽内容。
4. `deliverable_search` 扩展：`source` 过滤 + `content LIKE` 全文搜索（复用 sqlite，不引入向量库）。
5. 产出物页加「来源」筛选（全部 / Agent产出 / 知识库）。
6. 项目详情知识库区块：列出该项目 KB 文件 + 「重新同步」 + 「在产出物中查看」（导航+筛选）。
7. 知识库注册入口：产出物页顶部 + 项目详情（绑定目录）。

---

## 一、需求理解（合并后的大需求）

### 需求 A：项目级知识库
1. **Task 页 L1 侧边栏**：每个项目条目右侧增加「编辑」按钮 → 点击在右侧显示项目详情。
2. **项目详情**：可编辑项目信息 + 新增「知识库路径」设置（绑定一个项目知识库目录）。
3. **知识库自动扫描**：扫描目录内文件列表；能识别的文件（markdown/html/pdf/office 等）像交付物一样在右侧预览。
4. **Agent 可参考/可搜索**：Agent 做该项目相关事情时能搜索知识库、读取内容、弹窗预览 html/markdown。

### 需求 B：Office 产出物生成与预览
1. **Agent 生成能力**：能生成 doc/docx/xls/xlsx/ppt/pptx/pdf 等文件。
2. **预览能力**：Team chat 右侧栏浏览器、产出物（Deliverables）页面都能预览这些文件。

### 合并思路
两者共享同一套「**文件类型识别 → 预览渲染**」能力：
- 知识库里的 office 文件预览 = 产出物/右侧栏的 office 预览（同一组件）。
- Agent 生成 office 文件后走既有 `deliverable_create` 登记，预览自然打通。
- 因此先做**统一 Office 预览组件**，再做知识库文件列表复用；先做**Agent Office 生成工具**，与产出物登记衔接。

---

## 二、现状盘点（代码层面，已逐项核实）

| 项 | 现状 | 结论 |
|---|---|---|
| L1 侧边栏 | `ProjectSidebar.tsx`（`packages/web-ui/src/components/`），项目条目目前只有「选中过滤」，无每项编辑按钮 | 需加每项编辑按钮（笔图标） |
| 项目详情面板 | **已有** `ProjectSettingsPanel`（`packages/web-ui/src/pages/Work.tsx:2812`），⌘J 打开，支持编辑基本信息 / 展示 tasks / requirements / agents / 删除 | 复用它，新增「知识库」区块 |
| 项目数据模型 | `ProjectInfo`（`api.ts:245`：id/name/description/status/repositories/teamIds/governancePolicy/…）；SQLite `projects` 表无知识库字段 | 需加 `knowledge_base_paths`（JSON 数组）+ 迁移 |
| 交付物数据模型 | `deliverables` 表（`sqlite-storage.ts:274`）：type/title/summary/reference/format/tags/status/task_id/agent_id/project_id/… | 需加 `source`（默认 'agent'）/`knowledge_root`/`content` 列 + 迁移 |
| 交付物搜索 | `search()`（`sqlite-storage.ts:3851`）只 LIKE 匹配 **title/summary/tags 元数据**，不含文件内容 | 需扩展 `source` 过滤 + `content` 全文搜索 |
| 文件预览接口 | `/api/files/preview`（`org-manager/src/api-server.ts:11276`）：image/audio/video → 流式；office（.pdf/.doc/.docx/.xls/.xlsx/.ppt/.pptx）→ **binary 无预览**；文本/json → content | 需扩展 office 预览（新增 `office` 类型返回） |
| 右侧栏 | `RightPanel.tsx` + `EmbeddedBrowser.tsx` 已支持多 tab / 浏览器 / 终端 / 文件预览 / 选中回填 chat | office 预览复用该面板，KB 文件预览复用其 tab 机制 |
| 产出物页 | `Deliverables.tsx` 已有内联预览 + 打开右侧面板 | 复用统一 office 预览组件 |
| Agent 产出机制 | Agent 先写文件到磁盘 → `deliverable_create` 登记；**无 office 生成工具** | 需加 `office_generate` 工具组 |
| office→文本抽取 | **已有** `markitdown` CLI 集成（`core/src/file-converter.ts`，可提取 docx/xlsx/pptx/pdf→markdown） | 知识库文本索引直接复用 |
| Agent 项目工具 | `list_projects` / `get_project` / `update_project` / `project_stats` / `deliverable_*`（`core/src/tools/project-tools.ts`） | 新增 `knowledge_search` / `knowledge_read` / `knowledge_list` 作为 `deliverable_*` 封装（带 source=knowledge 过滤），不用新基建 |
| 工具选择器 | `tool-selector.ts` 已把「知识库」关键字映射到 deliverable 工具组 | KB 工具并入/扩展该组即可被关键词触发 |

---

## 三、调研结论（网络核实）

### 3.1 Office 生成 —— 最佳实践与选型

全部为宽松许可（MIT/Apache-2.0），可安全用于商业产品：

| 格式 | 库 | 许可证 | 说明 |
|---|---|---|---|
| **docx** | `docx` (npm) | MIT | 声明式 API（标题/段落/表格/图片），Node + 浏览器双端，成熟活跃 ✅推荐 |
| **xlsx** | `exceljs` | MIT | 读写、公式、样式、合并单元格，活跃（4.4.0）✅推荐 |
| **pptx** | `pptxgenjs` | MIT | 生成 OOXML pptx（兼容 PowerPoint/Keynote/LibreOffice），Node + 浏览器 ✅推荐 |
| **pdf（文本类）** | `pdf-lib` | MIT | 轻量生成/编辑，无原生依赖 |
| **pdf（HTML/MD→PDF）** | Electron `webContents.printToPDF` | — | 桌面端**零额外依赖**最优方案（Chromium 自带打印）✅推荐 |
| 旧格式转换（.doc/.xls/.ppt→新格式/PDF） | LibreOffice headless（`soffice --headless --convert-to`） | MPL-2.0（外部二进制，不打包） | **可选增强**：macOS 需 brew 安装（~700MB），检测不到则优雅降级 |

**关键判断**：
- 首版**只做新格式**（docx/xlsx/pptx/pdf）生成；.doc/.xls/.ppt 旧格式不生成（读写都难，产出价值低）。
- 生成全部用**纯 JS 库**（无原生依赖，Electron 打包安全、跨平台一致）。
- LibreOffice 定位为**可选**能力：用于「旧格式读取解析」「pptx→pdf 预览」「office→PDF 转换」。作为环境能力探测（`command -v soffice`），不可用时不阻塞主流程。

### 3.2 Office 预览 —— 最佳实践与选型

| 格式 | 库 | 许可证 | 方案 |
|---|---|---|---|
| **docx** | `docx-preview` | Apache-2.0（0.3.7 起，已核实） | 纯前端 docx→HTML 渲染，质量好 ✅推荐 |
| **xlsx** | `xlsx`（SheetJS） | Apache-2.0 | 解析工作簿 + 前端自绘表格 ✅推荐 |
| **pdf** | `pdf.js`（Mozilla） | Apache-2.0 | 成熟渲染，支持缩放/文本层 ✅推荐 |
| **pptx** | 前端库（pptxviewjs / pptx-preview.js / @js-preview）均不成熟 | — | **首选**：LibreOffice→pdf→pdf.js；无 LO 则回退「下载 / 系统打开」 |
| 兜底 | `api.system.openPath`（已有） | — | 所有 office 文件提供「用系统默认应用打开 / 下载原文件」 |

**许可安全结论**：docx-preview、xlsx、pdf.js 均为 Apache-2.0，**无 LGPL/GPL 传染风险**（docx-preview 早期是 LGPL，0.3.7 起改为 Apache-2.0，已核实），可放心打包进商业 Electron 应用。

### 3.3 知识库 —— 实现要点（V2：统一交付物机制）

| 环节 | 方案 | 说明 |
|---|---|---|
| 数据承载 | **复用 `deliverables` 表**，加 `source='knowledge'` + `knowledge_root` + `content` | 旧数据默认 `source='agent'`；KB 文档与 Agent 产出物同表同逻辑 |
| 绑定 | `project.knowledge_base_paths`（JSON 数组，多个根目录） | 项目详情/产出物页均可设 |
| 同步 | `knowledge_sync`：扫目录 → 逐个 **upsert** 为 KB 交付物（绑定 project_id）；新增/修改 → 重抽内容；删除 → 标 `outdated`/删除 | 首版手动触发（项目详情/产出物页「重新同步」按钮），二期 chokidar 自动监听 |
| 全文搜索 | `deliverable_search` 扩展：`source` 过滤 + `content LIKE` 全文搜索（sqlite 原生，复用现机制） | 不引入 embedding/RAG；文本由 markitdown / 直接读取抽取 |
| 文本抽取 | markdown/html/text/json/csv 直接读；pdf→pdf.js 文本层；docx→mammoth；xlsx→exceljs；统一优先复用已有 markitdown CLI | 无 markitdown 时：文本类照常索引，二进制类退化（仅文件名/提示） |
| 预览 UI | **复用** RightPanel 多 tab + 产出物页；KB 文件点击 → 右侧开 tab 预览；markdown/html 走 ContentRenderer，office 走统一 OfficePreviewer | 与 Agent 产出物零差异 |
| 项目详情知识库区块 | 列出该项目 KB 文件（复用产出物列表组件）→ 「在产出物中查看」**导航到 Deliverables 页 + 筛选 project & source=knowledge** | 不重复造列表页 |
| Agent 交互 | `knowledge_search`/`knowledge_read`/`knowledge_list` 封装 `deliverable_search`/文件预览（默认 source=knowledge） | 提示词引导；返回命中片段注入上下文 |

---

## 四、产品方案

### 4.1 UI 流程（V2）
1. **L1 侧边栏**：项目条目右侧 hover 出现「✎ 编辑」按钮 → 打开右侧项目详情（复用 `ProjectSettingsPanel`，等价于现有 ⌘J）。
2. **项目详情 → 知识库区块**：
   - 绑定知识库路径（多目录，可增删）；「重新同步」按钮 + 同步状态；
   - 列出该项目 `source='knowledge'` 的文件（复用产出物列表组件），点击 → 右侧栏打开预览 tab；
   - 「在产出物中查看」→ 跳转 Deliverables 页并自动筛选 `project=X & source=knowledge`。
3. **产出物页**：顶部加「来源」筛选（全部 / Agent产出 / 知识库）+「绑定知识库目录」入口；office 交付物走统一 OfficePreviewer，不再显示「无法预览」。
4. **预览**：markdown/html/text/json → 现有渲染；pdf → pdf.js；docx → docx-preview；xlsx → SheetJS 表格；pptx → LibreOffice 转 pdf（可选）或下载；全部提供「系统打开 / 下载」。

### 4.2 后端 API（新增/扩展，V2）
- `PUT /api/projects/:id` — 支持 `knowledgeBasePaths`（存储层加列）。
- `POST /api/projects/:id/knowledge/sync` — 扫描知识库目录 → upsert 为 `source='knowledge'` 交付物（含文本抽取），返回同步结果。
- `GET /api/deliverables` — 扩展 `source` 筛选参数。
- `GET /api/files/preview?path=` — 扩展：office 文件返回 `{ type:'office', format:'docx|xlsx|pptx|pdf', ... }`；PDF 提供 streamUrl 走 pdf.js。
- `deliverable_search` — 扩展 `source` 过滤 + `content` 全文搜索。

### 4.3 Agent 工具（V2：知识库工具 = 交付物工具封装）
- `knowledge_search(query, project_id)` — 封装 `deliverable_search`（默认 source=knowledge）+ 全文内容命中。
- `knowledge_read(path)` — 复用文件预览/读取接口取内容。
- `knowledge_list(project_id)` — 封装 `deliverable_list`（source=knowledge）。
- `office_generate(format, outputPath, content)` — 生成 docx/xlsx/pptx/pdf（结构化 JSON：标题/段落/表格/sheets/slides）。
- `office_convert(inputPath, targetFormat)` — 可选，LibreOffice 探测到才暴露。
- `get_project` / `update_project` 返回值扩展 `knowledgeBasePaths`。

### 4.4 前端新增组件（V2）
- `OfficePreviewer.tsx`：统一 office 预览容器（按格式分发到 docx-preview / SheetJS / pdf.js）。
- `ProjectKnowledgePanel`：项目详情内知识库区块（路径绑定 + 同步 + 文件列表 + 导航到产出物）。
- `ProjectSidebar`：每项加编辑按钮。
- 产出物页：来源筛选 + 知识库绑定入口。

### 4.5 依赖新增（均宽松许可）
- core（Agent 侧生成）：`docx`、`exceljs`、`pptxgenjs`、`pdf-lib`
- org-manager / storage（同步与索引）：`mammoth`（docx 文本，可选）
- web-ui（预览渲染）：`docx-preview`、`xlsx`、`pdfjs-dist`

---

## 五、任务拆解与依赖图（DAG，V2）

| 任务 | 内容 | 依赖 |
|---|---|---|
| **T1 数据模型扩展** | `projects` 表加 `knowledge_base_paths`（JSON）；`deliverables` 表加 `source`(默认 'agent')/`knowledge_root`/`content` 列 + 迁移；`ProjectInfo`/`get_project`/`update_project`/`deliverable_create`/search/list 支持新字段与 `source` 参数 | — |
| **T2 后端：知识库同步 + 预览扩展** | `knowledge_sync`（扫目录→upsert KB 交付物 + 文本抽取 + outdated 标记）；`deliverable_search` 扩展 source 过滤 + content 全文搜索；`/api/deliverables` 加 source 筛选；`/api/files/preview` 扩展 office 类型；`/api/projects/:id/knowledge/sync` | T1 |
| **T3 前端：L1 编辑按钮 + 知识库区块 + 产出物页筛选** | ProjectSidebar 每项编辑按钮；ProjectSettingsPanel 加知识库区块（路径绑定/同步/列表/导航到产出物）；Deliverables 页加来源筛选 + 知识库绑定入口 | T2 |
| **T4 Agent 知识库工具** | `knowledge_search/read/list`（封装 deliverable_*，默认 source=knowledge）；提示词与 tool-selector 接入 | T2 |
| **T5 前端：统一 Office 预览组件** | `OfficePreviewer`（docx-preview/SheetJS/pdf.js + pptx 可选 LO 转换）；接入 RightPanel 与 Deliverables 页 | T2（preview 扩展） |
| **T6 Agent：Office 生成工具** | `office_generate`（docx/exceljs/pptxgenjs/pdf-lib/printToPDF）+ 可选 `office_convert`（LibreOffice） | — |
| **T7 联调整合** | 端到端联调（KB 预览 office ↔ 产出物 ↔ 右侧栏 ↔ Agent 工具）、边界测试、用户文档、发布 | T3,T4,T5,T6 |

**并行流**：
- 主线：T1 → T2 →（T3、T4、T5 三路并行）
- 并行支线：T6 自始至终独立推进（不与主线抢依赖）
- 收口：T7 依赖全部子任务

```
T1 ──▶ T2 ──┬──▶ T3 ─┐
            ├──▶ T4 ─┼──▶ T7（联调/测试/文档）
            ├──▶ T5 ─┘
T6 ──────────────────┘  （全程并行，Office 生成工具）
```

---

## 六、里程碑与风险

### 里程碑（阶段二开发，确认后启动）
- M1：数据层 + 后端 KB 服务 + preview 扩展（T1、T2）
- M2：前端 KB 面板 + Office 预览组件（T3、T5）
- M3：Agent KB 工具 + Office 生成工具（T4、T6）
- M4：联调、测试、文档、发布（T7）

### 风险与对策
| 风险 | 等级 | 对策 |
|---|---|---|
| pptx 预览无成熟纯前端方案 | 中 | LibreOffice 转 pdf（可选）→ pdf.js；无 LO 时回退下载/系统打开 |
| 旧格式（doc/xls/ppt）兼容 | 中 | 首版只承诺新格式；旧格式仅「系统打开」；LO 可选增强 |
| markitdown 未安装导致 office 文本抽取缺失 | 低 | KB 索引降级为文件名；Agent 提示需要安装；不阻塞 |
| 打包体积（pdf.js + docx-preview + xlsx 较大） | 低 | 按需 lazy-load（动态 import），仅打开 office 时加载 |
| KB 目录很大（文件多） | 中 | 扫描限制深度 + 忽略隐藏/常见大目录（node_modules/.git）；文件树懒加载 |
| LibreOffice 进程转换并发 | 低 | 单一转换队列 + 超时 + 独立 user profile（`-env:UserInstallation`） |

---

*本文件为阶段一（调研规划）交付物。老板确认后，按第五节任务图进入阶段二真实开发。*
