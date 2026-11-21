# Marketplace orphan tables — frozen snapshot (C10-0C / master-plan G7)

> **This is a FROZEN SNAPSHOT, not a live copy.** Readings taken
> **2026-11-21T16:14:24.278Z** (first) and **2026-11-21T16:28:32.054Z** (re-verification),
> both from `~/.markus/data.db` opened **read-only**. The live database is the
> authority; this file is the readable git archive of rows that no code path can
> reach. Never "sync" this file against the DB — a second live copy is exactly the
> drift this record exists to prevent.

## Verdict (Owner, 2026-11-19): no migration, no DROP

`marketplace_templates` (2 rows) and `marketplace_skills`
(1 rows) still hold data in old-user databases, but PR #462 (A3,
Owner-merged) deleted their CREATE statements and repos: source has **zero**
read/write paths (verified by grep at base 5ea5efd4 and enforced by the
architecture-guard rule `no-orphan-marketplace`, which fails the build if any
reader/writer is seeded). "Table exists, data exists, nobody can read it" was the
unsafe state — the ambiguity, not the rows. The Owner adjudicated: **freeze, do
not delete**. Dropping tables on existing installs would be a data migration;
the 3 rows are harmless where they sit.

## Schema fork — intentional, documented, not closed by deletion

- **Fresh databases** never create these tables (#462 removed the CREATEs).
- **Existing databases** keep the tables and their rows frozen in place. Old-user
  compatibility wins; the rows are unreachable by design.
- **No migration entry** closes the fork (no DROP, no data movement). This card
  added zero entries to the storage migration list.
- The only new enforcement is source-level: the resurrection guard
  `no-orphan-marketplace` in `scripts/architecture-guard.mjs` (self-tested every
  run; a seeded reader fails the guard — verified 2026-11-21T16:26Z).

## Row-count readings (before / after this card's work)

| Table | First reading 2026-11-21T16:14:24.278Z | Re-verification 2026-11-21T16:28:32.054Z |
|---|---|---|
| `marketplace_templates` | 2 | 2 |
| `marketplace_skills` | 1 | 1 |

The card performed **no writes** to the live database; both readings were taken
with `node:sqlite` `{ readOnly: true }`. Row equality between the two readings
was asserted programmatically (deepStrictEqual over all columns, all rows).

## Verbatim rows — all columns, byte-faithful

### `marketplace_templates` (2 rows)

Schema as it exists in the live DB (`sqlite_master`):

```sql
CREATE TABLE marketplace_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'community',
  status TEXT NOT NULL DEFAULT 'draft',
  version TEXT NOT NULL DEFAULT '1.0.0',
  author_id TEXT,
  author_name TEXT NOT NULL,
  role_id TEXT NOT NULL,
  agent_role TEXT NOT NULL DEFAULT 'worker',
  skills TEXT NOT NULL DEFAULT '[]',
  llm_provider TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  category TEXT NOT NULL,
  icon TEXT,
  heartbeat_interval_ms INTEGER,
  starter_tasks TEXT DEFAULT '[]',
  config TEXT DEFAULT '{}',
  download_count INTEGER NOT NULL DEFAULT 0,
  avg_rating INTEGER NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'public',
  forked_from TEXT,
  fork_count INTEGER DEFAULT 0,
  version_history TEXT DEFAULT '[]',
  org_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT
)
```

Rows (JSON, exact values incl. NULLs; string columns that contain JSON are stored
as strings in the DB and appear here as strings):

```json
[
  {
    "id": "mkt-tpl_0653de7dd854f0b2de6055cb",
    "name": "技术合伙人",
    "description": "作为技术联合创始人，帮助你从零构建真实可用的产品，包含探索、规划、构建、打磨、交付五个阶段",
    "source": "community",
    "status": "draft",
    "version": "1.0.0",
    "author_id": null,
    "author_name": "AI Builder",
    "role_id": "developer",
    "agent_role": "manager",
    "skills": "[\"产品规划\",\"技术架构\",\"代码开发\",\"项目管理\",\"用户体验设计\",\"部署运维\",\"文档编写\"]",
    "llm_provider": null,
    "tags": "[\"技术合伙人\",\"产品开发\",\"创业\",\"敏捷开发\",\"技术咨询\"]",
    "category": "development",
    "icon": null,
    "heartbeat_interval_ms": null,
    "starter_tasks": "[]",
    "config": "{\"temperature\":0.7,\"toolWhitelist\":[\"shell_execute\",\"file_read\",\"file_write\",\"file_edit\",\"git_status\",\"git_diff\",\"git_commit\",\"git_log\"],\"requiredEnv\":[\"git\",\"node\",\"python3\",\"docker\",\"pnpm\"]}",
    "download_count": 0,
    "avg_rating": 0,
    "rating_count": 0,
    "visibility": "public",
    "forked_from": null,
    "fork_count": 0,
    "version_history": "[]",
    "org_id": null,
    "created_at": "2026-03-12T10:10:13.733Z",
    "updated_at": "2026-03-12T10:10:13.733Z",
    "published_at": null
  },
  {
    "id": "mkt-tpl_c52a6421a00b884adb713e50",
    "name": "技术联合创始人",
    "description": "你的技术联合创始人，帮助你打造真实可用的产品。从需求探索到产品交付，全程让你掌控方向，用通俗语言解释技术决策，分阶段构建并确保产品质量。",
    "source": "community",
    "status": "published",
    "version": "1.0.0",
    "author_id": null,
    "author_name": "Builder",
    "role_id": "",
    "agent_role": "manager",
    "skills": "[\"产品设计\",\"技术架构\",\"项目管理\",\"代码开发\",\"测试部署\"]",
    "llm_provider": null,
    "tags": "[\"技术联创\",\"产品开发\",\"全栈开发\",\"敏捷开发\",\"产品交付\"]",
    "category": "productivity",
    "icon": null,
    "heartbeat_interval_ms": null,
    "starter_tasks": "[]",
    "config": "{\"systemPrompt\":\"## 角色定位\\n你 就是用户的技术联合创始人。你的任务是帮用户打造一个真实可用的产品——能让他自己用、分享给别人，甚至直接发布上线。所有具体的构建工作由你负责，但要让他全程知情并保有最终决定权。\\n\\n---\\n\\n## 你的工作方式\\n\\n### 第一阶段：探索\\n•通过提问，真正理解用户实际需要什么（不局限于表面描述）\\n•如果觉得哪里不合理，大胆挑战用户的假设\\n•帮用户区分哪些是\\\"现阶段必备\\\"，哪些可以\\\"后期再加\\\"\\n•如果用户想法太大，请告诉用户，并建议一个更聪明的起点\\n\\n### 第二阶段：规划\\n•明确给出第一个版本的具体构建内容\\n•用大白话解释技术实现思路\\n•评估复杂度（简单 / 中等 / 复杂）\\n•列出用户需要准备的资源（账号、第三方服务、需做的决策等）\\n•展示最终产品的大致轮廓\\n\\n### 第三阶段：构建\\n•分阶段进行，让用户能随时看到进展并反馈\\n•边做边解释你的每一步（用户想了解学习）\\n•每步都测试，没问题再继续\\n•遇到关键决策点时，停下来和用户确认\\n•如果碰到问题，给用户几个备选方案，而不是自行决定\\n\\n### 第四阶段：打磨\\n•让产品看起来专业，不像黑客马拉松的临时作品\\n•优雅处理边界情况和各类错误\\n•确保产品运行流畅，并根据需要适配不同设备\\n•添加那些能让产品感觉\\\"真正完成\\\"的细节\\n\\n### 第五阶段：交付\\n•如果用户想上线，就帮用户部署好\\n•提供清晰的说明，告诉用户如何使用、维护和修改\\n•完整记录一切，让用户不依赖这次对话也能继续\\n•告诉用户下一个版本可以增加或改进什么\\n\\n---\\n\\n## 与用户合作的准则\\n\\n•视用户为产品负责人。用户做决定，你来实现。\\n•别用技术黑话轰炸用户。请用用户能懂的语言解释所有事情。\\n•如果用户搞得太复杂或方向不对，请直接指出来。\\n•坦诚告知局限性。用户宁愿调整预期，也不想最后失望。\\n•动作要快，但别快到让用户跟不上你的节奏。\\n\\n---\\n\\n## 核心原则\\n\\n•不仅要产品能跑起来——更要成为用户自豪展示的作品。\\n•这是真实产品，不是演示模型，也不是原型，而是真正可用的东西。\\n•确保用户全程掌控、全程知情。\\n•每次提交代码或更新进度时，清晰说明\\\"这是什么、为什么这么做、接下来做什么\\\"。\\n•主动识别风险和潜在问题，不回避困难对话。\\n\\n---\\n\\n## 技术能力\\n\\n你具备以下能力，能够独立完成从设计到部署的完整流程：\\n•产品设计：需求分析、功能规划、用户体验优化\\n•技术架构：选择合适的技术栈、设计系统架构、评估技术风险\\n•全栈开发：前端、后端、数据库、API设计\\n•测试与质量：编写测试用例、确保代码质量、处理边界情况\\n•部署运维：应用部署、监控设置、维护文档\\n\\n当遇到超出你能力范围的问题时，明确告知用户并建议寻求专业帮助。\\n\\n---\\n\\n## 决策框架\\n\\n当需要做技术决策时，遵循以下原则：\\n1. **简单优先**：能用简单方案解决就不用复杂的\\n2. **用户视角**：考虑用户实际使用场景，而非技术酷炫度\\n3. **可扩展性**：但不要过度设计，为未来预留合理空间\\n4. **成本意识**：考虑时间、金钱、学习成本\\n\\n---\\n\\n## 输出格式\\n\\n•使用清晰的结构化输出\\n•重要的决定和进度用总结性语言突出\\n•代码和技术细节需要时提供，但解释要通俗\\n•保持友好、专业的语气，像真正的合伙人那样沟通\",\"llmProvider\":\"anthropic\",\"llmModel\":\"claude-sonnet-4-20250514\",\"temperature\":0.8,\"toolWhitelist\":[\"shell_execute\",\"file_read\",\"file_write\",\"file_edit\",\"glob_find\",\"grep_search\",\"web_fetch\",\"web_search\",\"git_status\",\"git_diff\",\"git_log\",\"git_branch\",\"memory_save\",\"memory_search\",\"memory_list\"],\"requiredEnv\":[\"git\",\"node\",\"python3\",\"docker\"]}",
    "download_count": 0,
    "avg_rating": 0,
    "rating_count": 0,
    "visibility": "public",
    "forked_from": null,
    "fork_count": 0,
    "version_history": "[]",
    "org_id": null,
    "created_at": "2026-03-12T14:14:34.996Z",
    "updated_at": "2026-03-12T14:14:34.996Z",
    "published_at": "2026-03-12T14:14:34.996Z"
  }
]
```

### `marketplace_skills` (1 row)

Schema (`sqlite_master`):

```sql
CREATE TABLE marketplace_skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'community',
  status TEXT NOT NULL DEFAULT 'draft',
  version TEXT NOT NULL DEFAULT '1.0.0',
  author_id TEXT,
  author_name TEXT NOT NULL,
  category TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  tools TEXT NOT NULL DEFAULT '[]',
  readme TEXT,
  required_permissions TEXT DEFAULT '[]',
  required_env TEXT DEFAULT '[]',
  config TEXT DEFAULT '{}',
  download_count INTEGER NOT NULL DEFAULT 0,
  avg_rating INTEGER NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'public',
  forked_from TEXT,
  fork_count INTEGER DEFAULT 0,
  version_history TEXT DEFAULT '[]',
  org_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT
)
```

Rows:

```json
[
  {
    "id": "zhihu-publishing",
    "name": "Zhihu Publishing",
    "description": "知乎专栏文章发布自动化技能 - 使用 Chrome DevTools 浏览器自动化在知乎专栏发布文章。包含 React textarea InputEvent 注入、受控组件处理、发布验证等最佳实践。",
    "source": "local",
    "status": "published",
    "version": "1.0.0",
    "author_id": "agt_2a2092cc9dd9e1127a29c551",
    "author_name": "社区运营专员B",
    "category": "browser",
    "tags": "[\"browser\",\"zhihu\",\"automation\",\"chrome\"]",
    "tools": "[]",
    "readme": null,
    "required_permissions": "[]",
    "required_env": "[]",
    "config": "{}",
    "download_count": 0,
    "avg_rating": 0,
    "rating_count": 0,
    "visibility": "public",
    "forked_from": null,
    "fork_count": 0,
    "version_history": "[]",
    "org_id": null,
    "created_at": "2026-04-16 14:43:20",
    "updated_at": "2026-04-16 14:43:20",
    "published_at": null
  }
]
```

## How to re-verify (read-only)

```sh
node -e "const{DatabaseSync}=require('node:sqlite');\
const db=new DatabaseSync(process.env.HOME+'/.markus/data.db',{readOnly:true});\
for(const t of ['marketplace_templates','marketplace_skills'])\
console.log(t,JSON.stringify(db.prepare('SELECT * FROM '+t).all(),null,2));"
```

Diff the output against the JSON blocks above. If they differ, the LIVE DB
changed after this snapshot — that is a fact about the DB, not a reason to edit
this record.

---
*Recorded by C10-0E+0C (task tsk_10117dfa3008c50609ae78be), base 5ea5efd4
(origin/feat/refactor-plan). Plan SSOT: docs/design/c10-external-adapters-plan-2026-11-19.md §C10-0C.*
