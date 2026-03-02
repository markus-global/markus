# Git Worktree使用指南

## 概述

Git Worktree允许在同一个仓库中创建多个工作目录，每个Agent可以在独立的工作目录中开发，避免代码冲突和环境污染。

## 1. 安装和配置

### 1.1 前置要求
- Git 2.5+（支持worktree功能）
- 已克隆Markus仓库

### 1.2 安装工具
```bash
# 进入工具目录
cd tools/git-worktree

# 安装依赖
pnpm install

# 构建工具
pnpm build
```

## 2. 基本使用

### 2.1 创建Worktree
```bash
# 基本用法
./create-worktree.sh <task-id> <agent-name>

# 示例
./create-worktree.sh tsk_12345678 ai-god
```

**参数说明：**
- `task-id`: 任务ID（如tsk_12345678）
- `agent-name`: Agent名称（如ai-god）

**输出：**
```
✅ Worktree创建成功！
📍 路径：../tsk_12345678-ai-god
🌿 分支：feature/tsk_12345678-ai-god
📋 下一步：cd ../tsk_12345678-ai-god
```

### 2.2 切换到Worktree
```bash
# 切换到worktree目录
cd ../tsk_12345678-ai-god

# 验证当前目录
pwd
# 输出：/path/to/markus/../tsk_12345678-ai-god
```

### 2.3 列出所有Worktree
```bash
# 查看所有worktree
./list-worktrees.sh

# 输出示例：
# Worktree: ../tsk_12345678-ai-god
#   Branch: feature/tsk_12345678-ai-god
#   Status: active
#   Created: 2026-03-02 10:30:00
# 
# Worktree: ../tsk_87654321-devbot
#   Branch: feature/tsk_87654321-devbot
#   Status: active
#   Created: 2026-03-01 14:20:00
```

### 2.4 删除Worktree
```bash
# 删除worktree
./remove-worktree.sh <task-id> <agent-name>

# 示例
./remove-worktree.sh tsk_12345678 ai-god

# 强制删除（即使有未提交的更改）
./remove-worktree.sh <task-id> <agent-name> --force
```

## 3. 高级功能

### 3.1 基于特定分支创建
```bash
# 基于develop分支创建worktree
./create-worktree.sh <task-id> <agent-name> --base develop

# 基于特定提交创建
./create-worktree.sh <task-id> <agent-name> --base abc1234
```

### 3.2 自定义目录位置
```bash
# 指定worktree目录
./create-worktree.sh <task-id> <agent-name> --path /custom/path

# 使用相对路径
./create-worktree.sh <task-id> <agent-name> --path ../../worktrees/<task-id>
```

### 3.3 自动配置
创建worktree时自动执行：
1. 安装依赖（`pnpm install`）
2. 运行初始检查
3. 设置git配置

## 4. 工作流程

### 4.1 开始开发
```bash
# 1. 创建worktree
./create-worktree.sh tsk_12345678 ai-god

# 2. 切换到worktree
cd ../tsk_12345678-ai-god

# 3. 开始开发
# 编写代码...
```

### 4.2 同步主仓库更新
```bash
# 在worktree中同步主分支更新
git fetch origin
git rebase origin/main

# 或者合并更新
git merge origin/main
```

### 4.3 提交更改
```bash
# 在worktree中提交
git add .
git commit -m "feat: 实现功能"

# 推送到远程
git push origin feature/tsk_12345678-ai-god
```

### 4.4 完成开发
```bash
# 1. 创建Pull Request
# 2. 等待评审通过
# 3. 代码合并到main

# 4. 清理worktree
cd tools/git-worktree
./remove-worktree.sh tsk_12345678 ai-god
```

## 5. 最佳实践

### 5.1 命名规范
- **Worktree目录**：`<task-id>-<agent-name>`
- **分支名称**：`feature/<task-id>-<agent-name>`
- **提交信息**：包含任务ID

### 5.2 生命周期管理
1. **创建** - 开始新任务时
2. **使用** - 开发过程中
3. **维护** - 定期同步主分支
4. **清理** - 任务完成后

### 5.3 资源管理
- 定期清理不再使用的worktree
- 监控磁盘空间使用
- 避免创建过多worktree

## 6. 故障排除

### 6.1 常见问题

**问题1：创建失败，目录已存在**
```bash
# 解决方案：删除现有目录或使用不同名称
rm -rf ../tsk_12345678-ai-god
./create-worktree.sh tsk_12345678 ai-god
```

**问题2：git操作失败**
```bash
# 检查git状态
git status

# 检查远程仓库配置
git remote -v

# 修复git配置
git config --local user.name "Your Name"
git config --local user.email "your.email@example.com"
```

**问题3：依赖安装失败**
```bash
# 清理node_modules并重新安装
rm -rf node_modules
pnpm install
```

### 6.2 调试模式
```bash
# 启用详细日志
./create-worktree.sh <task-id> <agent-name> --verbose

# 查看工具日志
cat logs/git-worktree.log
```

## 7. 工具实现

### 7.1 目录结构
```
tools/git-worktree/
├── create-worktree.sh      # 创建worktree脚本
├── remove-worktree.sh      # 删除worktree脚本
├── list-worktrees.sh       # 列出worktree脚本
├── package.json           # 工具配置
├── src/
│   ├── worktree-manager.ts # Worktree管理器
│   └── cli.ts             # CLI工具
└── README.md              # 工具文档
```

### 7.2 配置选项
配置文件：`tools/git-worktree/config.json`
```json
{
  "worktreeBasePath": "../",
  "branchPrefix": "feature/",
  "autoInstallDeps": true,
  "autoRunChecks": true,
  "defaultBaseBranch": "main"
}
```

## 8. 集成指南

### 8.1 与任务系统集成
```typescript
// 在任务开始时自动创建worktree
import { createWorktree } from './tools/git-worktree';

async function startTask(taskId: string, agentName: string) {
  const worktreePath = await createWorktree(taskId, agentName);
  console.log(`Worktree created at: ${worktreePath}`);
}
```

### 8.2 与质量检查集成
```bash
# 在worktree中自动运行质量检查
cd ../tsk_12345678-ai-god
npx markus-check run-all
```

### 8.3 与CI/CD集成
```yaml
# GitHub Actions配置
name: Worktree Test
on:
  push:
    branches: [feature/**]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - run: cd tools/git-worktree && pnpm test
```

## 9. 性能优化

### 9.1 磁盘空间
- Worktree共享.git目录，节省空间
- 定期清理旧的worktree
- 使用符号链接共享node_modules

### 9.2 构建缓存
```bash
# 配置pnpm缓存
pnpm config set store-dir ~/.pnpm-store

# 在worktree间共享缓存
ln -s ../.pnpm-store .pnpm-store
```

## 10. 安全考虑

### 10.1 权限管理
- 每个worktree有独立的git配置
- 避免在worktree中存储敏感信息
- 定期检查.gitignore配置

### 10.2 代码隔离
- Worktree间代码完全隔离
- 避免跨worktree文件操作
- 使用git操作同步代码

---

## 附录

### A. 快速参考

```bash
# 创建worktree
./create-worktree.sh <task-id> <agent-name>

# 列出worktree
./list-worktrees.sh

# 删除worktree
./remove-worktree.sh <task-id> <agent-name>

# 帮助信息
./create-worktree.sh --help
```

### B. 环境变量
```bash
# 配置worktree基础路径
export MARKUS_WORKTREE_BASE="/opt/worktrees"

# 配置git用户信息
export GIT_AUTHOR_NAME="Your Name"
export GIT_AUTHOR_EMAIL="your.email@example.com"
```

### C. 相关命令
```bash
# Git原生worktree命令
git worktree add ../new-worktree
git worktree list
git worktree remove ../new-worktree

# 查看worktree详细信息
git worktree list --verbose
```

### D. 支持的联系方式
- **工具问题**：联系AI God
- **Git问题**：联系DevBot
- **流程问题**：联系Jason

---

*最后更新：2026-03-02*
*版本：1.0.0*