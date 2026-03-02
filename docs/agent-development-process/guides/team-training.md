# Agent开发团队培训材料

## 培训目标
1. 掌握Markus Agent标准开发流程
2. 熟练使用开发工具和自动化检查
3. 理解代码评审流程和最佳实践
4. 能够高效协作完成开发任务

## 培训大纲

### 第一部分：开发环境准备（30分钟）
#### 1.1 环境要求
- Node.js 18+ 和 pnpm
- Git 2.30+
- 代码编辑器（VS Code推荐）

#### 1.2 项目初始化
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

#### 1.3 开发工具配置
- VS Code扩展推荐
- Git配置优化
- 终端环境设置

### 第二部分：标准开发流程（60分钟）
#### 2.1 任务获取和准备
- 任务系统使用
- 需求分析和评估
- 开发计划制定

#### 2.2 Git Worktree使用
```bash
# 创建worktree
./tools/git-worktree/create-worktree.sh tsk_12345678 ai-god

# 切换到worktree
cd ../tsk_12345678-ai-god

# 验证worktree
git status
git branch
```

#### 2.3 开发过程
- 代码编写规范
- 本地验证流程
- 提交规范

#### 2.4 代码质量检查
```bash
# 运行所有检查
npx @markus/quality-check check all

# 运行特定检查
npx @markus/quality-check check typescript
npx @markus/quality-check check eslint
npx @markus/quality-check check test
```

### 第三部分：代码评审流程（45分钟）
#### 3.1 评审准备
- 如何准备代码评审
- 评审前检查清单
- PR描述规范

#### 3.2 评审执行
- 评审内容和方法
- 评审意见表达
- 评审工具使用

#### 3.3 评审后处理
- 如何响应评审意见
- 修改和重新提交
- 评审结果处理

### 第四部分：工具使用详解（45分钟）
#### 4.1 质量检查工具
```bash
# 安装和配置
cd tools/quality-check
npm install
npm run build

# 使用示例
npx @markus/quality-check --help
npx @markus/quality-check list
npx @markus/quality-check check git-diff --config ./markus-check.config.json
```

#### 4.2 Git Worktree工具
```bash
# 工具安装
cd tools/git-worktree
npm install
npm run build

# 使用示例
npx markus-worktree --help
npx markus-worktree create -t tsk_12345678 -a ai-god
npx markus-worktree list
npx markus-worktree switch tsk_12345678-ai-god
```

#### 4.3 其他开发工具
- 测试框架使用
- 调试工具
- 性能分析工具

### 第五部分：最佳实践和案例（30分钟）
#### 5.1 代码编写最佳实践
- 函数设计原则
- 错误处理模式
- 性能优化技巧

#### 5.2 团队协作最佳实践
- 沟通规范
- 知识共享
- 问题解决流程

#### 5.3 实际案例分析
- 成功案例分享
- 常见问题解决
- 经验教训总结

## 实践练习

### 练习1：创建开发环境
**目标**：使用Git Worktree创建隔离的开发环境

**步骤**：
1. 获取一个测试任务（tsk_test_001）
2. 使用create-worktree.sh创建worktree
3. 切换到worktree并验证环境
4. 在worktree中创建一个简单的功能

**验收标准**：
- [ ] Worktree创建成功
- [ ] 能够正常切换和开发
- [ ] 代码可以正常提交

### 练习2：代码质量检查
**目标**：使用质量检查工具验证代码

**步骤**：
1. 在worktree中编写一些测试代码
2. 运行各种质量检查
3. 根据检查结果修复问题
4. 验证所有检查通过

**验收标准**：
- [ ] TypeScript检查通过
- [ ] ESLint检查通过
- [ ] 测试检查通过
- [ ] 安全检查通过

### 练习3：代码评审模拟
**目标**：模拟完整的代码评审流程

**步骤**：
1. 两人一组，一人为作者，一人为评审者
2. 作者提交一个简单的PR
3. 评审者进行代码评审
4. 作者根据评审意见修改
5. 评审者批准合并

**验收标准**：
- [ ] PR描述完整规范
- [ ] 评审意见具体有用
- [ ] 问题得到解决
- [ ] 代码成功合并

## 考核标准

### 理论知识考核（30%）
- 开发流程理解
- 工具使用知识
- 评审流程掌握

### 实践能力考核（40%）
- 环境搭建能力
- 工具使用熟练度
- 问题解决能力

### 团队协作考核（30%）
- 沟通表达能力
- 代码评审质量
- 团队协作意识

## 培训资源

### 文档资源
1. **主流程文档**：`docs/agent-development-process/agent-development-workflow.md`
2. **设计文档**：`docs/agent-development-process/design.md`
3. **工具文档**：各工具的README.md
4. **检查清单**：`docs/agent-development-process/guides/code-review-checklist.md`

### 工具资源
1. **质量检查工具**：`tools/quality-check/`
2. **Git Worktree工具**：`tools/git-worktree/`
3. **示例配置**：各工具的配置文件示例

### 参考资源
1. **TypeScript官方文档**：https://www.typescriptlang.org/docs/
2. **Git官方文档**：https://git-scm.com/doc
3. **ESLint配置指南**：https://eslint.org/docs/latest/use/configure/

## 常见问题解答

### Q1: Worktree和普通分支有什么区别？
**A**: Worktree提供完全隔离的开发环境，每个worktree有自己的工作目录，可以同时在不同worktree中工作，而分支共享同一个工作目录。

### Q2: 质量检查失败怎么办？
**A**: 
1. 查看失败的具体原因
2. 根据错误信息修复问题
3. 重新运行检查
4. 如果问题复杂，可以寻求帮助

### Q3: 评审意见有分歧怎么办？
**A**:
1. 基于事实和数据讨论
2. 参考项目规范和最佳实践
3. 必要时寻求第三方意见
4. 记录决策过程和原因

### Q4: 如何提高开发效率？
**A**:
1. 熟练掌握开发工具
2. 遵循标准开发流程
3. 及时沟通和协作
4. 持续学习和改进

## 培训反馈

### 培训效果评估
- **知识掌握**：通过测试和练习评估
- **技能应用**：通过实际项目评估
- **满意度**：通过问卷调查收集

### 持续改进
- 定期收集培训反馈
- 更新培训材料和内容
- 优化培训方式和方法

## 总结
通过本培训，Agent应该能够：
1. ✅ 独立完成开发环境搭建
2. ✅ 熟练使用标准开发流程
3. ✅ 有效进行代码评审
4. ✅ 高效使用开发工具
5. ✅ 良好地进行团队协作

培训不是终点，而是起点。在实际工作中不断实践和改进，才能真正掌握这些技能。