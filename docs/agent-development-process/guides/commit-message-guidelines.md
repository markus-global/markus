# 提交信息规范指南

## 概述
本指南定义Markus项目中Git提交信息的标准格式和规范，确保提交历史清晰、可读、可维护。

## 提交信息格式

### 标准格式
```
<type>(<scope>): <subject>

<body>

<footer>
```

### 格式说明
1. **类型（type）**：提交的类型（必需）
2. **范围（scope）**：影响的范围（可选）
3. **主题（subject）**：简短的描述（必需）
4. **正文（body）**：详细的描述（可选）
5. **页脚（footer）**：引用和元数据（可选）

## 类型（Type）

### 主要类型
| 类型 | 说明 | 示例 |
|------|------|------|
| `feat` | 新功能 | `feat(core): add agent management API` |
| `fix` | 修复bug | `fix(comms): handle message sending errors` |
| `docs` | 文档更新 | `docs(readme): update installation guide` |
| `style` | 代码格式调整 | `style(ui): fix indentation in components` |
| `refactor` | 代码重构 | `refactor(core): extract common utilities` |
| `test` | 测试相关 | `test(api): add unit tests for auth module` |
| `chore` | 构建过程或辅助工具变动 | `chore(deps): update typescript to v5.3` |
| `perf` | 性能优化 | `perf(db): optimize database queries` |
| `ci` | CI/CD相关 | `ci(github): add automated tests workflow` |
| `build` | 构建系统相关 | `build(webpack): update configuration` |
| `revert` | 回滚提交 | `revert: revert "feat: add new feature"` |

### 类型选择指南
- **功能开发**：使用 `feat`
- **问题修复**：使用 `fix`
- **文档更新**：使用 `docs`
- **代码改进**：使用 `refactor`
- **测试相关**：使用 `test`
- **工具配置**：使用 `chore`

## 范围（Scope）

### 常见范围
| 范围 | 说明 | 示例 |
|------|------|------|
| `core` | 核心功能 | `feat(core): add task scheduling` |
| `comms` | 通信模块 | `fix(comms): fix telegram adapter` |
| `ui` | 用户界面 | `style(ui): update button styles` |
| `api` | API接口 | `feat(api): add new endpoints` |
| `db` | 数据库 | `perf(db): optimize queries` |
| `auth` | 认证授权 | `fix(auth): handle token expiration` |
| `test` | 测试相关 | `test(api): add integration tests` |
| `deps` | 依赖更新 | `chore(deps): update packages` |
| `ci` | CI/CD | `ci(github): add deployment workflow` |
| `docs` | 文档 | `docs(readme): update examples` |

### 范围选择指南
- 使用包名或模块名作为范围
- 如果影响多个范围，可以省略或使用 `*`
- 范围应该简洁明了

## 主题（Subject）

### 主题要求
1. **长度**：不超过50个字符
2. **格式**：使用祈使句，现在时态
3. **大小写**：首字母小写，不要使用句号
4. **内容**：清晰描述提交内容

### 好 vs 差
| 好的主题 | 差的主题 |
|----------|----------|
| `feat(core): add agent lifecycle management` | `feat(core): added agent lifecycle management` |
| `fix(comms): resolve message queue issue` | `fix(comms): fixing message queue problem` |
| `docs(readme): update installation steps` | `docs(readme): updated installation steps` |

## 正文（Body）

### 正文要求
1. **可选**：简单变更可以省略正文
2. **长度**：每行不超过72个字符
3. **内容**：解释**为什么**和**如何**，而不是**做了什么**
4. **格式**：使用Markdown格式

### 正文示例
```
feat(core): add agent task scheduling

- Add task scheduler with priority queue
- Implement task retry mechanism with exponential backoff
- Add task timeout handling
- Update agent interface to support task management

The new scheduling system allows agents to handle multiple
tasks concurrently with proper priority and error handling.
This improves overall system throughput and reliability.

Closes #123
```

## 页脚（Footer）

### 页脚内容
1. **引用问题**：`Closes #123`, `Fixes #456`
2. **重大变更**：`BREAKING CHANGE: ...`
3. **相关提交**：`Related to #789`

### 页脚示例
```
Closes #123
Fixes #456
Related to #789

BREAKING CHANGE: The API response format has changed.
All clients must update to the new format.
```

## 完整示例

### 示例1：新功能
```
feat(core): add agent health monitoring

- Add health check endpoint at /api/health
- Implement agent status tracking
- Add health metrics collection
- Update agent interface with health methods

The health monitoring system provides real-time visibility
into agent status and performance. This helps with debugging
and system maintenance.

Closes #234
```

### 示例2：Bug修复
```
fix(comms): handle network timeout in slack adapter

- Add timeout configuration for slack API calls
- Implement retry logic for failed messages
- Update error handling to provide better error messages
- Add unit tests for timeout scenarios

Previously, network timeouts would cause message loss.
The new implementation retries failed messages and provides
better error reporting.

Fixes #567
```

### 示例3：文档更新
```
docs(readme): update quick start guide

- Add step-by-step installation instructions
- Include troubleshooting section
- Update API usage examples
- Add links to related documentation

The updated guide makes it easier for new developers
to get started with the project.

Related to #890
```

### 示例4：重构
```
refactor(core): extract configuration management

- Move configuration logic to separate module
- Add configuration validation
- Update all modules to use new configuration API
- Add configuration tests

This refactor improves code organization and makes
configuration management more maintainable.

No functional changes.
```

## 提交工作流

### 1. 小步提交
```bash
# 频繁提交小改动
git add file1.ts file2.ts
git commit -m "feat(core): add initial implementation"

git add file3.ts
git commit -m "feat(core): add error handling"

git add test/
git commit -m "test(core): add unit tests"
```

### 2. 交互式提交
```bash
# 使用交互式提交添加详细描述
git commit
```

### 3. 修正提交
```bash
# 修正上次提交
git add forgotten-file.ts
git commit --amend

# 或修改提交信息
git commit --amend -m "feat(core): add complete feature"
```

## 工具支持

### 1. Commitizen
```bash
# 安装Commitizen
pnpm add -g commitizen

# 使用交互式提交
git cz
```

### 2. Commitlint
```bash
# 安装Commitlint
pnpm add @commitlint/config-conventional @commitlint/cli --save-dev

# 配置commitlint.config.js
module.exports = {
  extends: ['@commitlint/config-conventional']
};
```

### 3. Git钩子
```bash
# 使用husky添加提交钩子
pnpm add husky --save-dev

# 配置提交信息检查
npx husky add .husky/commit-msg 'npx --no -- commitlint --edit "$1"'
```

## 常见错误和修正

### 错误1：类型错误
**错误**：`added new feature`
**修正**：`feat: add new feature`

### 错误2：时态错误
**错误**：`fixed bug`
**修正**：`fix: resolve bug`

### 错误3：缺少范围
**错误**：`feat: update something`
**修正**：`feat(module): update something`

### 错误4：太长主题
**错误**：`feat(core): add new feature that does many things including...`
**修正**：`feat(core): add multi-function feature`

## 团队协作

### 1. 代码评审
- 提交信息是代码评审的一部分
- 评审者应该检查提交信息质量
- 不规范的提交信息应该要求修正

### 2. 发布说明
- 提交信息用于自动生成发布说明
- 清晰的提交信息简化发布流程
- 类型和范围帮助分类变更

### 3. 历史追踪
- 规范的提交信息便于历史追踪
- 可以按类型或范围过滤历史
- 便于问题溯源和影响分析

## 自动化工具

### 1. 自动生成发布说明
```bash
# 使用conventional-changelog
pnpm add conventional-changelog-cli --save-dev

# 生成CHANGELOG.md
npx conventional-changelog -p angular -i CHANGELOG.md -s
```

### 2. 语义化版本
```bash
# 使用standard-version
pnpm add standard-version --save-dev

# 自动版本管理和发布说明
npx standard-version
```

### 3. Git历史分析
```bash
# 按类型统计提交
git log --oneline | grep -E "^feat|^fix|^docs" | wc -l

# 查看特定范围的提交
git log --oneline --grep="feat(core):"

# 生成贡献统计
git shortlog -sn --no-merges
```

## 总结
规范的提交信息带来以下好处：
1. ✅ **可读的历史**：清晰的提交历史便于理解
2. ✅ **自动化工具**：支持自动化发布和文档生成
3. ✅ **团队协作**：统一的格式便于团队协作
4. ✅ **问题追踪**：便于问题溯源和影响分析

遵循本指南，确保所有提交信息都符合规范。