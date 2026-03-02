# Agent标准开发流程

## 概述
本目录包含Markus项目中Agent开发的标准化流程文档、工具和培训材料。

## 文档结构

### 核心文档
1. **[主流程文档](agent-development-workflow.md)** - 完整的Agent开发流程指南
2. **[设计方案](design.md)** - 流程设计思路和架构
3. **[开发环境配置指南](guides/development-environment-setup.md)** - 环境配置说明

### 工具指南
1. **[Git Worktree使用指南](guides/git-worktree-guide.md)** - Git Worktree管理工具使用说明
2. **[代码质量检查工具](../tools/quality-check/README.md)** - 代码质量自动化检查工具
3. **[Git Worktree管理工具](../tools/git-worktree/README.md)** - 工作树管理CLI工具

### 标准和规范
1. **[代码评审检查清单](guides/code-review-checklist.md)** - 代码评审标准和检查项
2. **[提交信息规范](guides/commit-message-guidelines.md)** - Git提交消息格式规范
3. **[测试编写规范](guides/test-writing-guidelines.md)** - 单元测试和集成测试编写指南

### 培训材料
1. **[团队培训材料](guides/team-training.md)** - 完整的团队培训课程
2. **[新Agent入职指南](guides/onboarding-guide.md)** - 新成员快速上手指南
3. **[最佳实践分享](guides/best-practices.md)** - 开发最佳实践和经验分享

## 快速开始

### 1. 环境准备
```bash
# 克隆项目
git clone <repository-url>
cd markus

# 安装依赖
pnpm install

# 验证环境
pnpm build
pnpm test
```

### 2. 开始开发
```bash
# 创建worktree（使用脚本）
./tools/git-worktree/create-worktree.sh tsk_12345678 ai-god

# 或使用CLI工具
cd tools/git-worktree
npm run build
npx markus-worktree create -t tsk_12345678 -a ai-god

# 切换到worktree
cd ../tsk_12345678-ai-god
```

### 3. 开发流程
1. **开发前**：阅读任务需求，创建worktree
2. **开发中**：编写代码，运行本地检查
3. **提交前**：运行完整质量检查
4. **提交后**：创建PR，等待评审

### 4. 质量检查
```bash
# 安装质量检查工具
cd tools/quality-check
npm install
npm run build

# 运行检查
npx @markus/quality-check check all
```

## 工具介绍

### 1. Git Worktree管理工具
位于 `tools/git-worktree/`，提供以下功能：
- 创建和管理隔离的开发环境
- 自动分支管理
- 状态跟踪和清理

### 2. 代码质量检查工具
位于 `tools/quality-check/`，提供以下检查：
- Git Diff检查
- TypeScript编译检查
- ESLint代码规范检查
- 测试覆盖率检查
- 安全检查

### 3. Shell脚本工具
- `create-worktree.sh` - 快速创建worktree的脚本
- 预提交钩子脚本
- 自动化检查脚本

## 培训计划

### 新Agent培训
1. **第一天**：环境配置和基础流程
2. **第二天**：工具使用和代码编写
3. **第三天**：代码评审和团队协作
4. **第四天**：实践练习和考核

### 定期培训
- 每月一次流程回顾
- 每季度一次最佳实践分享
- 根据需要组织专题培训

## 维护和更新

### 文档维护
- 主维护者：AI God
- 更新频率：根据需要及时更新
- 版本控制：使用Git管理文档变更

### 流程改进
1. **反馈收集**：定期收集使用反馈
2. **问题分析**：分析流程中的问题
3. **改进实施**：实施改进措施
4. **效果评估**：评估改进效果

### 版本历史
- **v1.0.0** (2024-03-02)：初始版本发布
- 包含完整的开发流程、工具和培训材料

## 贡献指南

### 文档贡献
1. Fork项目
2. 创建功能分支
3. 更新文档
4. 提交PR
5. 等待评审和合并

### 工具贡献
1. 在tools目录下创建新工具
2. 提供完整的文档
3. 添加测试用例
4. 遵循项目代码规范

### 问题反馈
1. 在GitHub创建Issue
2. 描述问题和建议
3. 提供相关上下文
4. 等待处理

## 联系方式
- **项目负责人**：Jason (Organization Manager)
- **流程维护者**：AI God
- **技术支持**：开发团队

## 许可证
本项目文档采用MIT许可证，详见LICENSE文件。