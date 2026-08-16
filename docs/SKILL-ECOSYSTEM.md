# 技能生态兼容适配器（Skill Ecosystem Adapter）

> **一句话**：Markus 技能与主流外部技能生态「双向兼容」——`markus skill import` 把
> skills.sh / SkillHub / OpenClaw / SOUL.md / AgentScope / MCP-server 等外部技能
> 自动归一化为 Markus 格式（skill.json + SKILL.md），`markus skill export` 把
> Markus 技能渲染回外部格式发布到社区。配合既有 `discover_tools search/install`，
> Markus 生态可直接消费 **8 万+ 社区技能**，同时你的技能也能反向发布出去。

---

## 1. 支持的生态格式

| 格式 | 标识 | 检测特征 | 说明 |
| --- | --- | --- | --- |
| Claude Code / skills.sh | `claude` | 目录含 `SKILL.md`（带 YAML frontmatter） | skills.sh 上 8 万+ 技能的主流形态 |
| SkillHub / ClawHub | `skillhub` | `SKILL.md` 或 `skills/` 子目录、`clawhub.json` | 技能包可含图标/资源/多技能 |
| OpenClaw | `openclaw` | `config.json5` / `AGENTS.md` / `agents/` | OpenClaw 技能目录，可带 MCP 配置 |
| OpenClaw SOUL | `soul` | 目录含 `SOUL.md` | 灵魂包（人格 + 指令） |
| AgentScope | `agentscope` | `@tool` 装饰的 `.py` + `README.md` | 阿里 AgentScope 工具脚本技能（近似适配） |
| 通用 MCP-server | `mcp-server` | `mcp.json` / `.mcp.json`（含 `mcpServers`） | 纯 MCP 服务器配置型技能 |

> **AgentScope 说明**：AgentScope 社区尚未形成统一"技能包"标准，本适配器按
> 「工具脚本 + 说明文档」近似处理：导入时保留 `.py` 工具文件并把 `@tool` 函数写入
> 指令；导出时生成 `README.md + SKILL.md（+ tool_stub.py）`，供开发者接入 AgentScope 环境。

---

## 2. 字段映射（外部 → Markus）

| 外部字段 | Markus 字段 | 备注 |
| --- | --- | --- |
| `SKILL.md` frontmatter `name` | `skill.json.name` | kebab-case 归一化 |
| `description` | `description` | |
| `version` / `license` / `author` | 同名 | `LICENSE` 文件 / `package.json` 自动识别 |
| `allowed-tools` | `skill.requiredPermissions` | `shell*→shell`、`file/read/write→file`、`web/http→network`、`browser*→browser` |
| `mcp.json` / `config.json5.mcpServers` | `skill.mcpServers` | 自动解析 JSON5（去注释/尾逗号/键引号） |
| `tags` | `tags` | |
| 描述关键词 | `category` | 关键词推断（development/devops/data/browser/…） |
| `SOUL.md` 正文 | `SKILL.md` 指令 | 保留原文 |
| 图标 / README / LICENSE / 脚本 | 附加文件 | 导入时一并复制 |

---

## 3. CLI 用法

```bash
# 列出已安装技能
markus skill list

# 导入外部技能包（自动检测格式 → 归一化为 Markus 格式）
markus skill import ~/Downloads/clawhub-skill.zip  --force
markus skill import ./skills/pdf-tables          --name pdf-tools
markus skill import ~/projects/agent-scope-skill --to ~/.markus/skills/my-scope

# 导出 Markus 技能到外部生态（默认输出 ./<name>-<format>/）
markus skill export pdf-tools --format claude
markus skill export pdf-tools --format openclaw --out ~/publish
markus skill export pdf-tools --format soul
markus skill export pdf-tools --format mcp-server
markus skill export pdf-tools --format agentscope
markus skill export pdf-tools --from ~/.markus/skills/pdf-tools  # 或直接指定目录

# 查看支持的格式与检测规则
markus skill formats
```

所有命令支持 `--json` 机器可读输出。

---

## 4. Agent 内使用（discover_tools）

Agent 可在对话中直接导入本地外部技能目录：

```json
{
  "mode": "import",
  "path": "/path/to/external-skill-directory",
  "name": "optional-rename"
}
```

导入成功后技能即注册到运行时注册表，随后用常规方式激活：

```json
{ "name": ["<skill-name>"] }
```

---

## 5. 架构

```
packages/core/src/skills/codec/
├── types.ts            # 格式枚举 + NormalizedSkill 中间表示
├── detect.ts           # 按目录特征检测格式（优先级见 markus skill formats）
├── frontmatter.ts      # 最小化 YAML frontmatter 解析/渲染（不引入 yaml 依赖）
├── parse.ts            # 各格式 → NormalizedSkill（含权限映射 / JSON5 / MCP 提取）
├── render.ts           # NormalizedSkill → 外部格式文件（纯函数）
├── import-export.ts    # 落地：写 skill.json + SKILL.md + 附加文件 / 渲染输出
└── index.ts            # 公共 API
```

- 入口在 `packages/core/src/skills/codec/index.ts`，经 `@markus/core` 导出。
- 服务层封装：`@markus/org-manager` 的 `importSkillFromDirectory / exportSkillToFormat`
  （含运行时注册表刷新），CLI 与 `discover_tools import` 模式共用同一实现。
- 新增格式只需：`detect.ts` 加信号 → `parse.ts` 加解析函数 → `render.ts` 加渲染器。

---

## 6. README 引用片段（可直接复制）

```markdown
### 🌍 生态兼容：8 万+ 社区技能即插即用

Markus 自带技能生态适配器，与主流 AI 技能生态**双向打通**：

- **导入**：`markus skill import <path>` 自动识别并归一化
  skills.sh（8 万+ 社区技能）、SkillHub/ClawHub、OpenClaw、SOUL.md、AgentScope、
  MCP-server 等格式为 Markus 技能——无需改代码，装完即用。
- **导出**：`markus skill export <name> --format claude` 把 Markus 技能渲染成外部
  标准格式，直接发布到 skills.sh / SkillHub / OpenClaw 等社区。
- **Agent 内闭环**：对话中 `discover_tools({ mode: "import" })` 导入本地技能包，
  即刻注册并激活，无需重启。
```

---

## 7. 已知限制

- 外部技能的 `mcpServers` 依赖本地运行环境（如 `npx`/`uvx` 已安装）才能生效。
- AgentScope 为近似适配（无社区统一标准）；MCP 服务器指令类技能请优先使用 `mcp-server` 格式。
- 导入不执行远端代码，仅做文件复制与元数据归一化；运行外部技能脚本时请自行评估信任边界。