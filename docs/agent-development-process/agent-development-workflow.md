# Agent标准开发流程

## 概述

本流程定义了Markus项目中Agent开发的标准化流程，旨在提高代码质量、团队协作效率和开发体验。

### 目标
1. **代码质量** - 确保所有代码符合质量标准
2. **团队协作** - 支持多Agent并行开发，避免冲突
3. **开发效率** - 提供标准化的开发工具和流程
4. **知识传承** - 建立可重复的开发和评审流程

## 1. 开发前准备

### 1.1 环境检查
在开始开发前，确保：
- ✅ 本地开发环境已配置（Node.js、pnpm、Git等）
- ✅ 项目依赖已安装（`pnpm install`）
- ✅ 能够访问远程代码仓库

### 1.2 获取任务
1. 从任务系统获取开发任务
2. 明确任务需求和验收标准
3. 评估任务复杂度和预计时间

### 1.3 创建开发环境
使用Git Worktree创建隔离的开发环境：

```bash
# 创建worktree
./tools/git-worktree/create-worktree.sh <task-id> <agent-name>

# 示例
./tools/git-worktree/create-worktree.sh tsk_12345678 ai-god
```

**Worktree命名规范：**
- 格式：`<task-id>-<agent-name>`
- 示例：`tsk_12345678-ai-god`

## 2. 开发过程

### 2.1 代码编写
在worktree中进行开发：
1. 基于最新main分支创建功能分支
2. 遵循代码规范编写代码
3. 编写单元测试和集成测试
4. 保持代码整洁和可维护

### 2.2 本地验证
在开发过程中定期进行本地验证：

1. **代码质量检查**
   ```bash
   # 运行代码质量检查
   npx @markus/quality-check check all
   
   # 或运行特定检查
   npx @markus/quality-check check typescript
   npx @markus/quality-check check eslint
   ```

2. **测试运行**
   ```bash
   # 运行所有测试
   pnpm test
   
   # 运行特定包的测试
   pnpm test --filter @markus/core
   ```

3. **构建验证**
   ```bash
   # 验证代码可以正常构建
   pnpm build
   ```

### 2.3 提交规范
遵循规范的提交消息格式：

```bash
# 格式：<type>(<scope>): <subject>
git commit -m "feat(core): add new agent management API"

# 类型说明：
# - feat: 新功能
# - fix: 修复bug
# - docs: 文档更新
# - style: 代码格式调整
# - refactor: 代码重构
# - test: 测试相关
# - chore: 构建过程或辅助工具变动
```

## 3. 开发完成检查
在提交代码前，必须完成以下检查：

### 3.1 Git Diff检查
检查代码修改是否合理：
```bash
# 运行Git Diff检查
npx @markus/quality-check check git-diff

# 检查内容：
# 1. 是否意外修改了关键配置文件
# 2. 是否包含了敏感信息
# 3. 代码格式是否符合规范
```

### 3.2 TypeScript检查
确保TypeScript代码编译通过：
```bash
# 运行TypeScript检查
npx @markus/quality-check check typescript

# 检查内容：
# 1. 类型定义是否正确
# 2. 编译是否通过
# 3. 是否有未使用的导入
```

### 3.3 ESLint检查
确保代码符合代码规范：
```bash
# 运行ESLint检查
npx @markus/quality-check check eslint

# 检查内容：
# 1. 代码风格是否符合规范
# 2. 是否有潜在的错误
# 3. 代码复杂度是否合理
```

### 3.4 测试检查
确保测试通过且覆盖率达标：
```bash
# 运行测试检查
npx @markus/quality-check check test

# 检查内容：
# 1. 所有测试是否通过
# 2. 测试覆盖率是否达标
# 3. 是否有新增的测试
```

### 3.5 安全检查
检查代码中的安全问题：
```bash
# 运行安全检查
npx @markus/quality-check check security

# 检查内容：
# 1. 是否有已知的安全漏洞
# 2. 是否使用了不安全的依赖
# 3. 是否有硬编码的敏感信息
```

## 4. 提交流程
完成所有检查后，可以提交代码：

### 4.1 提交到本地仓库
```bash
# 添加所有修改
git add .

# 提交代码（使用规范的提交消息）
git commit -m "feat(core): add new agent management API"

# 或者使用交互式提交
git commit
```

### 4.2 推送到远程仓库
```bash
# 推送到远程分支
git push origin <branch-name>

# 示例
git push origin feature/tsk_12345678-ai-god
```

### 4.3 创建Pull Request
在代码仓库平台创建Pull Request：
1. **标题格式**：`[<task-id>] <description>`
2. **描述内容**：
   - 任务背景和需求
   - 实现方案概述
   - 测试结果和覆盖率
   - 相关文档链接
3. **关联任务**：在PR描述中关联任务ID

### 4.4 预提交钩子
项目已配置预提交钩子，会自动运行：
1. **代码格式化** - 使用Prettier格式化代码
2. **基础检查** - 运行TypeScript和ESLint检查
3. **测试运行** - 运行相关测试

## 5. 代码评审流程
代码评审是确保代码质量的关键环节：

### 5.1 评审人员
- **至少2个评审者**：1个主要评审者 + 1个次要评审者
- **评审者资格**：熟悉相关代码库的Agent
- **避免利益冲突**：评审者不应是代码作者

### 5.2 评审内容
评审者需要检查以下内容：

#### 5.2.1 代码质量
- ✅ 代码是否符合项目规范
- ✅ 命名是否清晰、一致
- ✅ 函数和方法是否职责单一
- ✅ 代码复杂度是否合理
- ✅ 是否有重复代码

#### 5.2.2 功能实现
- ✅ 是否满足任务需求
- ✅ 是否有边界条件处理
- ✅ 错误处理是否完善
- ✅ 性能是否可接受
- ✅ 是否有竞态条件

#### 5.2.3 测试覆盖
- ✅ 是否有足够的单元测试
- ✅ 测试是否覆盖主要场景
- ✅ 测试是否易于理解和维护
- ✅ 集成测试是否完整

#### 5.2.4 文档和注释
- ✅ 代码注释是否清晰
- ✅ API文档是否完整
- ✅ README是否更新
- ✅ 变更日志是否记录

### 5.3 评审流程
1. **作者请求评审**：创建PR并@相关评审者
2. **评审者检查**：在24小时内完成初步评审
3. **反馈和修改**：作者根据反馈修改代码
4. **再次评审**：评审者确认修改
5. **批准合并**：至少2个评审者批准后合并

### 5.4 评审工具
使用以下工具辅助代码评审：
- **GitHub/GitLab PR功能**：行级评论、讨论线程
- **代码质量工具**：自动检查代码问题
- **测试覆盖率报告**：验证测试完整性

## 6. 合并和部署
评审通过后，代码可以合并：

### 6.1 合并策略
- **Squash合并**：将多个提交合并为一个
- **Rebase合并**：保持线性提交历史
- **常规合并**：保留所有提交记录

### 6.2 合并前检查
合并前确保：
- ✅ 所有评审意见已解决
- ✅ CI/CD流水线通过
- ✅ 测试覆盖率达标
- ✅ 文档已更新

### 6.3 部署流程
1. **自动部署**：代码合并后自动触发部署
2. **环境验证**：在测试环境验证功能
3. **生产发布**：确认无误后发布到生产环境
4. **监控告警**：监控新功能运行状态

## 7. 异常处理
开发过程中可能遇到的问题：

### 7.1 代码冲突
当多人修改同一文件时：
1. **定期同步**：定期从main分支拉取最新代码
2. **及时解决**：发现冲突立即解决
3. **沟通协调**：与相关开发者沟通修改

### 7.2 检查失败
当质量检查失败时：
1. **分析原因**：查看失败的具体原因
2. **本地修复**：在本地修复问题
3. **重新检查**：修复后重新运行检查

### 7.3 评审阻塞
当评审被阻塞时：
1. **主动沟通**：主动联系评审者
2. **寻求帮助**：请求其他Agent协助评审
3. **升级处理**：如长时间无响应，向管理者报告

## 8. 工具和资源

### 8.1 开发工具
- **Git Worktree管理工具**：`./tools/git-worktree/`
- **代码质量检查工具**：`./tools/quality-check/`
- **代码格式化工具**：Prettier配置
- **测试框架**：Vitest + Testing Library

### 8.2 配置说明
- **TypeScript配置**：`tsconfig.base.json`
- **ESLint配置**：项目级配置
- **Prettier配置**：`.prettierrc.json`
- **测试配置**：`vitest.config.ts`

### 8.3 文档资源
- **开发指南**：`docs/agent-development-process/`
- **API文档**：各包的README和类型定义
- **部署文档**：部署和运维指南
- **故障排除**：常见问题解决方案

## 9. 最佳实践

### 9.1 代码编写
- **小步提交**：频繁提交小改动
- **清晰命名**：使用有意义的变量和函数名
- **单一职责**：每个函数/类只做一件事
- **防御性编程**：处理边界条件和异常

### 9.2 测试策略
- **测试驱动**：先写测试，再写实现
- **全面覆盖**：覆盖正常、边界、异常场景
- **独立测试**：测试之间不相互依赖
- **快速反馈**：测试运行速度快

### 9.3 团队协作
- **及时沟通**：遇到问题及时沟通
- **互相评审**：积极参与代码评审
- **知识共享**：分享经验和最佳实践
- **持续改进**：定期回顾和改进流程

## 10. 附录

### 10.1 术语表
- **Agent**：自动化开发助手
- **Worktree**：Git工作树，隔离的开发环境
- **PR**：Pull Request，代码合并请求
- **CI/CD**：持续集成/持续部署

### 10.2 常见问题
**Q: 如何创建新的worktree？**
A: 使用 `./tools/git-worktree/create-worktree.sh <task-id> <agent-name>`

**Q: 代码质量检查失败怎么办？**
A: 查看失败详情，修复问题后重新运行检查

**Q: 评审者长时间不响应怎么办？**
A: 先私信提醒，如无响应则@其他评审者或管理者

**Q: 如何更新开发流程？**
A: 提交PR修改流程文档，经过评审后合并

### 10.3 更新记录
- **2024-03-02**：创建初始版本
- **2024-03-02**：添加代码质量检查工具集成
- **2024-03-02**：完善评审流程和最佳实践

---

**文档维护者**：AI God  
**最后更新**：2024-03-02  
**版本**：1.0.0
# 运行Git Diff检查
npx @markus/quality-check check git-diff

# 检查特定文件
git diff --name-only
```

### 3.2 代码规范检查
确保代码符合项目规范：
```bash
# TypeScript类型检查
npx @markus/quality-check check typescript

# ESLint代码风格检查
npx @markus/quality-check check eslint

# 安全检查
npx @markus/quality-check check security
```

### 3.3 测试覆盖率检查
确保测试覆盖率达到要求：
```bash
# 运行测试并检查覆盖率
npx @markus/quality-check check test

# 查看覆盖率报告
pnpm test --coverage
```

### 3.4 预提交钩子
项目已配置预提交钩子，会自动运行：
1. 代码格式化检查
2. TypeScript编译检查
3. 单元测试运行

## 4. 提交流程

### 4.1 提交到本地仓库
```bash
# 添加所有修改文件
git add .

# 或添加特定文件
git add src/feature.ts

# 提交更改
git commit -m "feat(core): implement new feature"

# 查看提交历史
git log --oneline -5
```

### 4.2 推送到远程仓库
```bash
# 推送到远程分支
git push origin feature-branch-name

# 如果远程分支不存在，创建并推送
git push -u origin feature-branch-name
```

### 4.3 创建Pull Request
1. 访问GitHub/GitLab仓库页面
2. 点击"New Pull Request"按钮
3. 选择正确的源分支和目标分支
4. 填写PR描述：
   - **标题**：清晰描述功能/修复
   - **描述**：详细说明变更内容、测试情况、相关任务
   - **标签**：添加适当的标签（bug, feature, enhancement等）
   - **审查者**：@mention至少2位审查者

## 5. 代码评审流程

### 5.1 评审标准
代码评审应关注以下方面：

**功能实现**
- ✅ 功能是否符合需求
- ✅ 是否有边界情况处理
- ✅ 性能是否可接受

**代码质量**
- ✅ 代码是否清晰易读
- ✅ 是否有重复代码
- ✅ 命名是否规范
- ✅ 错误处理是否完善

**测试覆盖**
- ✅ 是否有足够的单元测试
- ✅ 测试是否覆盖主要场景
- ✅ 集成测试是否完整

**安全考虑**
- ✅ 是否有潜在的安全风险
- ✅ 敏感信息是否妥善处理
- ✅ 权限检查是否完善

### 5.2 评审流程
1. **初步检查**（24小时内）
   - 审查者查看PR描述和代码变更
   - 运行自动化检查
   - 提供初步反馈

2. **详细评审**（48小时内）
   - 逐行审查代码
   - 提出具体修改建议
   - 讨论技术方案

3. **修改和重新评审**
   - 开发者根据反馈修改代码
   - 重新提交修改
   - 审查者确认修改

4. **批准和合并**
   - 至少2位审查者批准
   - 所有检查通过
   - 合并到main分支

### 5.3 评审工具
使用以下工具辅助代码评审：

1. **GitHub/GitLab Review功能**
   - 行内评论
   - 建议修改
   - 批准/拒绝

2. **自动化检查**
   - CI/CD流水线
   - 代码质量检查
   - 测试覆盖率

3. **代码审查清单**
   - 使用标准审查清单
   - 确保不遗漏重要检查项

## 6. 合并和部署

### 6.1 合并到main分支
满足以下条件后可以合并：

1. **必要条件**
   - ✅ 至少2位审查者批准
   - ✅ 所有CI/CD检查通过
   - ✅ 代码冲突已解决
   - ✅ 测试覆盖率达标

2. **合并方式**
   ```bash
   # 推荐使用Squash Merge
   git merge --squash feature-branch
   
   # 或Rebase Merge
   git rebase main
   ```

3. **合并后清理**
   ```bash
   # 删除本地分支
   git branch -d feature-branch
   
   # 删除远程分支
   git push origin --delete feature-branch
   
   # 清理worktree
   ./tools/git-worktree/cleanup-worktree.sh <worktree-name>
   ```

### 6.2 部署流程
代码合并到main分支后自动触发部署：

1. **CI/CD流水线**
   - 自动运行完整测试套件
   - 构建生产版本
   - 运行安全扫描

2. **部署环境**
   - **开发环境**：自动部署，用于功能验证
   - **测试环境**：手动触发，用于集成测试
   - **生产环境**：审批后部署，用于正式发布

3. **部署验证**
   - 监控部署状态
   - 验证功能是否正常
   - 回滚机制准备

## 7. 异常处理流程

### 7.1 代码冲突处理
当出现代码冲突时：

1. **本地冲突解决**
   ```bash
   # 更新本地main分支
   git checkout main
   git pull origin main
   
   # 回到功能分支并rebase
   git checkout feature-branch
   git rebase main
   
   # 解决冲突
   # 编辑冲突文件
   git add .
   git rebase --continue
   ```

2. **远程冲突解决**
   - 使用GitHub/GitLab的冲突解决工具
   - 或通过命令行解决后强制推送

### 7.2 构建失败处理
当构建失败时：

1. **检查失败原因**
   ```bash
   # 查看构建日志
   cat build.log
   
   # 运行本地构建验证
   pnpm build
   ```

2. **常见问题解决**
   - 依赖版本冲突：更新package.json
   - TypeScript错误：修复类型定义
   - 测试失败：修复测试代码

### 7.3 紧急修复流程
对于生产环境紧急问题：

1. **创建hotfix分支**
   ```bash
   # 从main创建hotfix分支
   git checkout -b hotfix/issue-description main
   ```

2. **快速开发和测试**
   - 最小化修改
   - 重点测试修复部分
   - 快速代码评审

3. **紧急合并和部署**
   - 简化评审流程
   - 快速部署到生产
   - 后续补充完整测试

## 8. 最佳实践

### 8.1 开发实践
1. **小步提交**：频繁提交，每次提交解决一个问题
2. **清晰提交信息**：使用规范格式，说明变更原因
3. **代码审查**：主动请求审查，积极回应反馈
4. **测试驱动**：先写测试，再实现功能

### 8.2 协作实践
1. **及时沟通**：遇到问题及时寻求帮助
2. **知识共享**：分享学习经验和最佳实践
3. **互相评审**：积极参与他人代码评审
4. **持续改进**：定期回顾和优化开发流程

### 8.3 工具使用
1. **IDE配置**：统一开发工具和配置
2. **自动化脚本**：充分利用现有工具
3. **监控告警**：设置合理的监控和告警

## 9. 附录

### 9.1 常用命令参考
```bash
# Git Worktree管理
./tools/git-worktree/create-worktree.sh <task-id> <agent-name>
./tools/git-worktree/list-worktrees.sh
./tools/git-worktree/cleanup-worktree.sh <worktree-name>

# 代码质量检查
npx @markus/quality-check check all
npx @markus/quality-check check git-diff
npx @markus/quality-check check typescript
npx @markus/quality-check check eslint
npx @markus/quality-check check test
npx @markus/quality-check check security

# 开发流程
pnpm install          # 安装依赖
pnpm build            # 构建项目
pnpm test             # 运行测试
pnpm lint             # 代码检查
```

### 9.2 相关文档
- [Git Worktree使用指南](./guides/git-worktree-guide.md)
- [代码质量检查工具文档](../../tools/quality-check/README.md)
- [代码评审清单](./code-review-checklist.md)
- [开发环境配置指南](./development-environment-setup.md)

### 9.3 联系和支持
- **技术问题**：在团队频道讨论
- **流程问题**：联系流程负责人
- **工具问题**：联系工具维护者
- **紧急问题**：使用紧急联系通道

---
*最后更新：2026-03-02*
*版本：1.0.0*
在提交前运行本地检查：

```bash
# 运行代码质量检查
npx markus-check run-all

# 运行测试
pnpm test

# 构建验证
pnpm build
```

### 2.3 提交代码
遵循提交规范：

```bash
# 添加修改文件
git add .

# 提交更改
git commit -m "feat: 实现用户认证功能

- 添加JWT认证中间件
- 实现用户登录/注册API
- 添加单元测试
- 更新API文档

Closes #123"
```

**提交信息规范：**
```
<type>: <subject>

<body>

<footer>
```

**类型（type）：**
- `feat`: 新功能
- `fix`: 修复bug
- `docs`: 文档更新
- `style`: 代码格式调整
- `refactor`: 代码重构
- `test`: 测试相关
- `chore`: 构建或工具更新

## 3. 代码质量检查

### 3.1 自动化检查
使用Markus质量检查工具：

```bash
# 运行所有检查
npx markus-check run-all

# 运行特定检查
npx markus-check check git-diff
npx markus-check check typescript
npx markus-check check eslint
npx markus-check check test
npx markus-check check security
```

### 3.2 检查内容
1. **Git Diff检查** - 检查代码变更是否合理
2. **TypeScript检查** - 类型检查和语法验证
3. **ESLint检查** - 代码风格和规范检查
4. **测试检查** - 测试覆盖率和质量检查
5. **安全检查** - 安全漏洞和敏感信息检查

### 3.3 检查配置
配置文件：`markus-check.config.json`

```json
{
  "gitDiff": {
    "enabled": true,
    "excludePatterns": ["*.md", "*.json"],
    "maxLinesChanged": 500
  },
  "typescript": {
    "enabled": true,
    "strict": true
  },
  "eslint": {
    "enabled": true,
    "config": ".eslintrc.js"
  },
  "test": {
    "enabled": true,
    "coverageThreshold": 80
  },
  "security": {
    "enabled": true,
    "scanPatterns": ["**/*.ts", "**/*.js"]
  }
}
```

## 4. 代码评审流程

### 4.1 创建Pull Request
1. 推送代码到远程仓库
2. 创建Pull Request
3. 填写PR描述，包括：
   - 功能说明
   - 测试覆盖情况
   - 相关文档更新
   - 检查清单

### 4.2 评审分配
系统自动分配评审人员：
1. 基于技能匹配
2. 考虑当前负载
3. 设置评审截止时间（通常24小时内）

### 4.3 评审标准
评审人员检查以下内容：

**代码质量：**
- ✅ 代码可读性和可维护性
- ✅ 遵循编码规范
- ✅ 适当的注释和文档
- ✅ 错误处理和边界情况

**功能实现：**
- ✅ 满足需求规格
- ✅ 测试覆盖充分
- ✅ 性能考虑
- ✅ 安全性考虑

**架构设计：**
- ✅ 设计合理
- ✅ 模块化程度
- ✅ 扩展性考虑
- ✅ 与现有系统集成

### 4.4 评审结果
1. **通过** - 代码质量良好，可以合并
2. **需要修改** - 需要修复一些问题
3. **拒绝** - 需要重大修改或重新设计

## 5. 合并和部署

### 5.1 代码合并
评审通过后：
1. 解决所有评审意见
2. 确保CI/CD流水线通过
3. 合并到main分支
4. 删除功能分支

### 5.2 部署流程
1. **开发环境** - 自动部署
2. **测试环境** - 手动触发
3. **生产环境** - 审批后部署

### 5.3 版本发布
遵循语义化版本控制：
- `MAJOR.MINOR.PATCH`
- 重大变更：`MAJOR+1.0.0`
- 新功能：`MINOR+1`
- Bug修复：`PATCH+1`

## 6. 异常处理

### 6.1 常见问题
1. **代码冲突** - 使用rebase解决冲突
2. **检查失败** - 根据错误信息修复
3. **评审阻塞** - 及时沟通，寻求帮助

### 6.2 紧急修复
对于紧急bug修复：
1. 创建hotfix分支
2. 快速开发和测试
3. 简化评审流程
4. 紧急部署

## 7. 工具和资源

### 7.1 开发工具
- **Git Worktree管理** - `tools/git-worktree/`
- **代码质量检查** - `tools/quality-check/`
- **代码评审工具** - 集成到任务系统

### 7.2 文档资源
- 开发流程文档
- 代码规范文档
- API文档
- 部署指南

### 7.3 培训材料
- 新Agent入职培训
- 工具使用教程
- 最佳实践分享

## 8. 持续改进

### 8.1 流程反馈
定期收集反馈：
1. 开发体验调查
2. 流程效率评估
3. 工具使用反馈

### 8.2 流程优化
基于反馈优化流程：
1. 识别瓶颈和问题
2. 提出改进方案
3. 实施优化措施
4. 评估改进效果

### 8.3 知识管理
1. 维护知识库
2. 分享最佳实践
3. 定期技术分享
4. 建立导师制度

---

## 附录

### A. 快速开始指南

```bash
# 1. 获取任务
# 从任务系统获取任务ID

# 2. 创建worktree
./tools/git-worktree/create-worktree.sh <task-id> <agent-name>

# 3. 切换到worktree
cd ../<task-id>-<agent-name>

# 4. 开始开发
# 编写代码...

# 5. 本地检查
npx markus-check run-all
pnpm test

# 6. 提交代码
git add .
git commit -m "feat: 实现功能"

# 7. 创建PR
git push origin <branch-name>
# 在GitHub/GitLab创建PR

# 8. 等待评审
# 根据评审意见修改

# 9. 合并代码
# 评审通过后合并
```

### B. 检查清单

**开发前：**
- [ ] 明确任务需求
- [ ] 评估工作量
- [ ] 创建worktree

**开发中：**
- [ ] 遵循代码规范
- [ ] 编写测试
- [ ] 定期提交

**提交前：**
- [ ] 运行质量检查
- [ ] 通过所有测试
- [ ] 更新文档

**评审中：**
- [ ] 及时响应评审意见
- [ ] 修复发现问题
- [ ] 保持良好沟通

**合并后：**
- [ ] 验证部署
- [ ] 更新任务状态
- [ ] 清理worktree

### C. 联系方式
- **流程问题**：联系Jason（组织经理）
- **技术问题**：联系DevBot或Linus
- **工具问题**：查看工具文档或联系AI God

---

*最后更新：2026-03-02*
*版本：1.0.0*