# 开发环境配置指南

## 概述
本文档指导如何配置Markus项目的开发环境，确保所有开发者使用统一的环境配置。

## 1. 系统要求

### 1.1 操作系统
- **推荐**：macOS 12+ / Ubuntu 20.04+ / Windows 10+
- **架构**：x86_64 或 ARM64

### 1.2 硬件要求
- **内存**：至少8GB RAM（推荐16GB）
- **存储**：至少10GB可用空间
- **CPU**：至少4核处理器

## 2. 基础软件安装

### 2.1 Node.js和npm
```bash
# 使用nvm安装Node.js（推荐）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash

# 重新加载shell配置
source ~/.bashrc  # 或 source ~/.zshrc

# 安装Node.js LTS版本
nvm install --lts
nvm use --lts

# 验证安装
node --version  # 应该显示v18.x或v20.x
npm --version   # 应该显示9.x或10.x
```

### 2.2 pnpm包管理器
```bash
# 安装pnpm
npm install -g pnpm

# 验证安装
pnpm --version  # 应该显示8.x或9.x

# 配置pnpm存储路径（可选）
pnpm config set store-dir ~/.pnpm-store
```

### 2.3 Git
```bash
# macOS
brew install git

# Ubuntu/Debian
sudo apt-get update
sudo apt-get install git

# Windows
# 下载并安装Git for Windows：https://git-scm.com/download/win

# 配置Git
git config --global user.name "Your Name"
git config --global user.email "your.email@example.com"
git config --global core.autocrlf input
git config --global core.eol lf
```

## 3. 开发工具安装

### 3.1 IDE/编辑器
**推荐使用Visual Studio Code**

1. **下载安装**：https://code.visualstudio.com/
2. **安装扩展**：
   - TypeScript and JavaScript Language Features
   - ESLint
   - Prettier - Code formatter
   - GitLens
   - Docker
   - REST Client

3. **VSCode配置**：
```json
{
  "editor.formatOnSave": true,
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": true
  },
  "typescript.preferences.importModuleSpecifier": "relative",
  "files.eol": "\n",
  "editor.tabSize": 2,
  "editor.insertSpaces": true
}
```

### 3.2 终端工具
**推荐使用iTerm2 (macOS) 或 Windows Terminal**

1. **iTerm2配置**：
   - 下载：https://iterm2.com/
   - 配置主题和字体

2. **Zsh和Oh My Zsh**（可选但推荐）：
```bash
# 安装Zsh
brew install zsh

# 安装Oh My Zsh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"

# 安装插件
git clone https://github.com/zsh-users/zsh-autosuggestions ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-autosuggestions
git clone https://github.com/zsh-users/zsh-syntax-highlighting.git ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-syntax-highlighting

# 配置~/.zshrc
plugins=(git zsh-autosuggestions zsh-syntax-highlighting)
```

## 4. 项目环境配置

### 4.1 克隆代码仓库
```bash
# 克隆项目
git clone https://github.com/your-org/markus.git
cd markus

# 配置远程仓库（如果需要）
git remote add upstream https://github.com/original-repo/markus.git
```

### 4.2 安装项目依赖
```bash
# 安装所有依赖
pnpm install

# 验证安装
pnpm list
```

### 4.3 环境变量配置
创建环境配置文件：
```bash
# 复制示例配置文件
cp .env.example .env

# 编辑环境变量
# 根据实际需求配置以下变量：
# - DATABASE_URL
# - API_KEYS
# - LOG_LEVEL
# - 其他服务配置
```

## 5. 数据库配置

### 5.1 PostgreSQL（如果项目使用）
```bash
# macOS
brew install postgresql@14
brew services start postgresql@14

# Ubuntu/Debian
sudo apt-get install postgresql postgresql-contrib
sudo systemctl start postgresql

# 创建数据库
createdb markus_dev
createdb markus_test
```

### 5.2 Redis（如果项目使用）
```bash
# macOS
brew install redis
brew services start redis

# Ubuntu/Debian
sudo apt-get install redis-server
sudo systemctl start redis-server
```

## 6. 开发工具配置

### 6.1 代码质量工具
```bash
# 安装全局工具（可选）
pnpm add -g @markus/quality-check

# 配置预提交钩子
cp tools/quality-check/scripts/pre-commit .git/hooks/
chmod +x .git/hooks/pre-commit
```

### 6.2 Git Worktree工具
```bash
# 确保工具可执行
chmod +x tools/git-worktree/*.sh

# 测试工具
./tools/git-worktree/create-worktree.sh test-task test-agent
```

### 6.3 Docker（可选）
```bash
# 安装Docker Desktop
# macOS: https://docs.docker.com/desktop/install/mac-install/
# Windows: https://docs.docker.com/desktop/install/windows-install/
# Linux: https://docs.docker.com/engine/install/

# 验证安装
docker --version
docker-compose --version
```

## 7. 验证环境配置

### 7.1 运行构建
```bash
# 构建项目
pnpm build

# 如果构建成功，说明TypeScript配置正确
```

### 7.2 运行测试
```bash
# 运行所有测试
pnpm test

# 运行特定包的测试
pnpm test --filter @markus/core
```

### 7.3 运行开发服务器
```bash
# 启动开发服务器
pnpm dev

# 验证服务是否正常启动
curl http://localhost:3000/health
```

## 8. 常见问题解决

### 8.1 依赖安装失败
```bash
# 清理缓存并重新安装
rm -rf node_modules
pnpm store prune
pnpm install
```

### 8.2 TypeScript编译错误
```bash
# 检查TypeScript配置
npx tsc --noEmit

# 修复类型错误
# 或更新类型定义
```

### 8.3 测试运行失败
```bash
# 检查测试环境
pnpm test -- --help

# 查看测试日志
cat test.log
```

### 8.4 数据库连接问题
```bash
# 检查数据库服务状态
pg_isready  # PostgreSQL
redis-cli ping  # Redis

# 检查连接配置
echo $DATABASE_URL
```

## 9. 环境维护

### 9.1 定期更新
```bash
# 更新Node.js版本
nvm install --lts
nvm use --lts

# 更新项目依赖
pnpm update

# 更新全局工具
pnpm add -g pnpm@latest
```

### 9.2 备份配置
```bash
# 备份环境变量
cp .env .env.backup

# 备份Git配置
git config --list > git-config-backup.txt
```

### 9.3 清理空间
```bash
# 清理pnpm存储
pnpm store prune

# 清理Docker
docker system prune -a

# 清理临时文件
rm -rf dist node_modules/.cache
```

## 10. 团队协作配置

### 10.1 Git配置
```bash
# 设置默认分支
git config --global init.defaultBranch main

# 设置推送行为
git config --global push.default current

# 设置合并策略
git config --global pull.rebase true
```

### 10.2 代码签名（可选）
```bash
# 生成GPG密钥
gpg --full-generate-key

# 配置Git使用GPG签名
git config --global user.signingkey <your-key-id>
git config --global commit.gpgsign true
```

### 10.3 SSH密钥配置
```bash
# 生成SSH密钥
ssh-keygen -t ed25519 -C "your.email@example.com"

# 添加到ssh-agent
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/id_ed25519

# 将公钥添加到GitHub/GitLab
cat ~/.ssh/id_ed25519.pub
```

---
## 附录

### A. 快速安装脚本
```bash
#!/bin/bash
# Markus开发环境快速安装脚本

echo "开始安装Markus开发环境..."

# 安装Node.js和pnpm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
source ~/.bashrc
nvm install --lts
npm install -g pnpm

# 克隆项目
git clone https://github.com/your-org/markus.git
cd markus

# 安装依赖
pnpm install

# 配置环境
cp .env.example .env

echo "安装完成！请编辑.env文件配置环境变量。"
```

### B. 环境检查脚本
```bash
#!/bin/bash
# 环境检查脚本

echo "=== Markus开发环境检查 ==="

# 检查基础工具
echo "1. 检查基础工具..."
command -v node >/dev/null 2>&1 && echo "✅ Node.js: $(node --version)" || echo "❌ Node.js未安装"
command -v pnpm >/dev/null 2>&1 && echo "✅ pnpm: $(pnpm --version)" || echo "❌ pnpm未安装"
command -v git >/dev/null 2>&1 && echo "✅ Git: $(git --version)" || echo "❌ Git未安装"

# 检查项目配置
echo "\n2. 检查项目配置..."
[ -f "package.json" ] && echo "✅ package.json存在" || echo "❌ package.json不存在"
[ -d "node_modules" ] && echo "✅ node_modules存在" || echo "❌ node_modules不存在"

# 检查环境变量
echo "\n3. 检查环境变量..."
[ -f ".env" ] && echo "✅ .env文件存在" || echo "⚠️ .env文件不存在（请运行: cp .env.example .env）"

echo "\n=== 检查完成 ==="
```

### C. 相关资源
- [Node.js官方文档](https://nodejs.org/en/docs/)
- [pnpm文档](https://pnpm.io/)
- [Git文档](https://git-scm.com/doc)
- [TypeScript文档](https://www.typescriptlang.org/docs/)
- [VSCode文档](https://code.visualstudio.com/docs)

---
*版本：1.0.0*
*最后更新：2026-03-02*