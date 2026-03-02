# 开发环境配置指南

## 概述
本指南详细说明如何配置Markus Agent开发环境，确保所有开发者使用统一的环境配置。

## 系统要求

### 硬件要求
- **内存**：至少8GB RAM（推荐16GB）
- **存储**：至少10GB可用空间
- **处理器**：现代多核处理器

### 软件要求
- **操作系统**：macOS 10.15+ / Windows 10+ / Linux (Ubuntu 20.04+)
- **Node.js**：18.x 或 20.x（推荐LTS版本）
- **Git**：2.30+
- **包管理器**：pnpm 8.x+

## 环境配置步骤

### 1. 安装基础软件

#### macOS
```bash
# 安装Homebrew（如果未安装）
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 安装Node.js和pnpm
brew install node@18
brew install pnpm

# 安装Git
brew install git
```

#### Ubuntu/Debian
```bash
# 更新包列表
sudo apt update

# 安装Node.js（使用NodeSource仓库）
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# 安装pnpm
npm install -g pnpm

# 安装Git
sudo apt install -y git
```

#### Windows
1. 下载并安装 [Node.js 18 LTS](https://nodejs.org/)
2. 使用PowerShell安装pnpm：
   ```powershell
   npm install -g pnpm
   ```
3. 下载并安装 [Git for Windows](https://gitforwindows.org/)

### 2. 验证安装
```bash
# 验证Node.js版本
node --version  # 应该显示 v18.x.x 或 v20.x.x

# 验证pnpm版本
pnpm --version  # 应该显示 8.x.x

# 验证Git版本
git --version   # 应该显示 2.30+
```

### 3. 配置Git
```bash
# 设置用户名和邮箱
git config --global user.name "Your Name"
git config --global user.email "your.email@example.com"

# 设置默认分支名称
git config --global init.defaultBranch main

# 设置行尾处理（Windows用户需要）
git config --global core.autocrlf true

# 设置推送默认行为
git config --global push.default current

# 设置别名（可选但推荐）
git config --global alias.co checkout
git config --global alias.br branch
git config --global alias.ci commit
git config --global alias.st status
git config --global alias.unstage 'reset HEAD --'
git config --global alias.last 'log -1 HEAD'
```

### 4. 配置SSH密钥（推荐）
```bash
# 生成SSH密钥
ssh-keygen -t ed25519 -C "your.email@example.com"

# 将公钥添加到GitHub/GitLab
cat ~/.ssh/id_ed25519.pub

# 测试SSH连接
ssh -T git@github.com
```

## 项目设置

### 1. 克隆项目
```bash
# 使用SSH（推荐）
git clone git@github.com:your-org/markus.git

# 或使用HTTPS
git clone https://github.com/your-org/markus.git

# 进入项目目录
cd markus
```

### 2. 安装依赖
```bash
# 安装项目依赖
pnpm install

# 验证安装
pnpm list
```

### 3. 构建项目
```bash
# 构建所有包
pnpm build

# 验证构建
pnpm test
```

## 编辑器配置

### VS Code推荐配置

#### 必需扩展
1. **TypeScript支持**
   - TypeScript and JavaScript Language Features（内置）
   - ESLint

2. **Git支持**
   - GitLens
   - Git Graph

3. **代码质量**
   - Prettier - Code formatter
   - Error Lens

4. **测试支持**
   - Vitest

#### 推荐设置
```json
{
  "editor.formatOnSave": true,
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": true
  },
  "typescript.preferences.importModuleSpecifier": "relative",
  "typescript.updateImportsOnFileMove.enabled": "always",
  "git.autofetch": true,
  "git.confirmSync": false,
  "terminal.integrated.defaultProfile.linux": "bash",
  "terminal.integrated.defaultProfile.osx": "zsh",
  "terminal.integrated.defaultProfile.windows": "PowerShell"
}
```

### 其他编辑器
- **WebStorm**：内置TypeScript和Git支持
- **Neovim/Vim**：需要配置TypeScript和Git插件
- **Sublime Text**：需要安装TypeScript和Git插件

## 开发工具配置

### 1. Git Worktree工具
```bash
# 构建Git Worktree工具
cd tools/git-worktree
pnpm install
pnpm build

# 全局安装（可选）
pnpm link --global
```

### 2. 质量检查工具
```bash
# 构建质量检查工具
cd tools/quality-check
pnpm install
pnpm build

# 全局安装（可选）
pnpm link --global
```

### 3. Shell脚本权限
```bash
# 设置脚本可执行权限
chmod +x tools/git-worktree/create-worktree.sh
chmod +x scripts/*.sh
```

## 环境验证

### 1. 运行完整验证脚本
```bash
# 运行环境验证
./scripts/verify-environment.sh

# 或手动验证
pnpm run verify
```

### 2. 手动验证步骤
```bash
# 1. 验证Node.js和包管理器
node --version
pnpm --version

# 2. 验证Git配置
git config --list | grep -E "user\.(name|email)"

# 3. 验证项目依赖
pnpm list --depth=0

# 4. 验证构建
pnpm build

# 5. 验证测试
pnpm test

# 6. 验证工具
npx @markus/quality-check --version
npx markus-worktree --help
```

## 常见问题解决

### 1. 依赖安装失败
**问题**：`pnpm install` 失败
**解决方案**：
```bash
# 清理缓存
pnpm store prune

# 删除node_modules和lock文件
rm -rf node_modules pnpm-lock.yaml

# 重新安装
pnpm install
```

### 2. 构建失败
**问题**：`pnpm build` 失败
**解决方案**：
```bash
# 检查TypeScript错误
pnpm type-check

# 清理构建产物
pnpm clean

# 重新构建
pnpm build
```

### 3. Git配置问题
**问题**：Git操作需要频繁输入密码
**解决方案**：
```bash
# 配置Git凭证存储
git config --global credential.helper store

# 或使用SSH密钥
# 参考前面的SSH配置步骤
```

### 4. 权限问题
**问题**：脚本没有执行权限
**解决方案**：
```bash
# 添加执行权限
chmod +x script-name.sh

# 或使用pnpm运行
pnpm run script-name
```

## 性能优化

### 1. 磁盘空间优化
```bash
# 清理pnpm存储
pnpm store prune

# 清理构建缓存
pnpm clean

# 删除不需要的文件
find . -name "node_modules" -type d -prune -exec rm -rf {} \;
```

### 2. 构建速度优化
```bash
# 使用并行构建
pnpm -r build --parallel

# 启用构建缓存
# 在项目配置中启用TurboRepo或类似工具
```

### 3. 测试速度优化
```bash
# 只运行变更的测试
pnpm test --changed

# 使用测试缓存
pnpm test --coverage=false
```

## 团队协作配置

### 1. 共享配置
```bash
# 安装共享的Git钩子
pnpm prepare

# 安装共享的编辑器配置
# 项目应包含 .editorconfig 和 .vscode/settings.json
```

### 2. 代码规范
```bash
# 安装并配置ESLint
pnpm lint

# 安装并配置Prettier
pnpm format

# 验证代码规范
pnpm lint:check
```

### 3. 预提交钩子
```bash
# 项目应配置husky或类似工具
# 在提交前自动运行：
# 1. 代码格式化
# 2. 代码检查
# 3. 测试运行
```

## 维护和更新

### 1. 定期更新
```bash
# 更新Node.js
# 使用nvm或系统包管理器

# 更新pnpm
pnpm add -g pnpm@latest

# 更新项目依赖
pnpm update
```

### 2. 环境备份
```bash
# 导出环境配置
node --version > environment.txt
pnpm --version >> environment.txt
git --version >> environment.txt

# 备份重要配置
cp ~/.gitconfig ~/backup/gitconfig.backup
```

### 3. 问题诊断
```bash
# 收集环境信息
./scripts/diagnose-environment.sh

# 或手动收集
echo "=== Environment Info ===" > diagnosis.txt
node --version >> diagnosis.txt
pnpm --version >> diagnosis.txt
git --version >> diagnosis.txt
uname -a >> diagnosis.txt
```

## 总结
正确配置开发环境是高效开发的基础。遵循本指南可以确保：
1. ✅ 统一的环境配置
2. ✅ 高效的开发工具
3. ✅ 顺畅的团队协作
4. ✅ 快速的问题解决

如果在配置过程中遇到问题，请参考常见问题解决部分或联系团队支持。