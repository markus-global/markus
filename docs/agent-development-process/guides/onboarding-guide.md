# 新Agent入职指南

## 欢迎加入Markus团队！

本指南将帮助你快速熟悉Markus项目，掌握开发流程，并开始高效工作。

## 第一天：环境配置和基础了解

### 上午：环境配置（2小时）
1. **完成开发环境配置**
   - 按照[开发环境配置指南](development-environment-setup.md)配置环境
   - 验证所有工具安装成功
   - 克隆项目并安装依赖

2. **配置开发工具**
   - 安装VS Code和推荐扩展
   - 配置Git和SSH密钥
   - 设置终端环境

### 下午：项目了解（3小时）
1. **项目结构探索**
   ```bash
   # 查看项目结构
   tree -L 3 -I 'node_modules|dist|coverage'
   
   # 了解主要目录
   ls -la packages/
   ls -la tools/
   ls -la docs/
   ```

2. **代码库浏览**
   - 阅读项目README
   - 查看核心包的结构
   - 了解主要模块的功能

3. **第一次构建和测试**
   ```bash
   # 构建项目
   pnpm build
   
   # 运行测试
   pnpm test
   
   # 验证环境
   pnpm run verify
   ```

## 第二天：开发流程学习

### 上午：标准开发流程（2小时）
1. **学习开发流程**
   - 阅读[主流程文档](../agent-development-workflow.md)
   - 理解Git Worktree概念
   - 学习代码质量检查流程

2. **实践Git Worktree**
   ```bash
   # 创建第一个worktree
   ./tools/git-worktree/create-worktree.sh tsk_onboarding_001 your-name
   
   # 切换到worktree
   cd ../tsk_onboarding_001-your-name
   
   # 验证worktree环境
   git status
   git branch
   ```

### 下午：工具使用（3小时）
1. **质量检查工具**
   ```bash
   # 构建质量检查工具
   cd tools/quality-check
   pnpm install
   pnpm build
   
   # 运行各种检查
   npx @markus/quality-check check all
   npx @markus/quality-check check typescript
   npx @markus/quality-check check eslint
   ```

2. **Git Worktree工具**
   ```bash
   # 构建Git Worktree工具
   cd tools/git-worktree
   pnpm install
   pnpm build
   
   # 使用CLI工具
   npx markus-worktree --help
   npx markus-worktree list
   ```

## 第三天：实际开发练习

### 上午：简单任务开发（2小时）
1. **获取第一个任务**
   - 从任务系统获取简单任务（如文档更新）
   - 任务ID示例：`tsk_practice_001`

2. **完整开发流程实践**
   ```bash
   # 1. 创建worktree
   ./tools/git-worktree/create-worktree.sh tsk_practice_001 your-name
   
   # 2. 切换到worktree
   cd ../tsk_practice_001-your-name
   
   # 3. 开发实现
   # 编辑文件，实现功能
   
   # 4. 运行本地检查
   npx @markus/quality-check check all
   
   # 5. 提交代码
   git add .
   git commit -m "feat(docs): update onboarding guide"
   ```

### 下午：代码评审体验（3小时）
1. **创建Pull Request**
   - 将分支推送到远程仓库
   - 创建Pull Request
   - 按照模板填写PR描述

2. **代码评审参与**
   - 邀请同事评审你的代码
   - 学习如何响应评审意见
   - 实践修改和重新提交

3. **评审他人代码**
   - 评审同事的简单PR
   - 使用[代码评审检查清单](code-review-checklist.md)
   - 提供建设性反馈

## 第四天：深入学习和团队融入

### 上午：高级主题学习（2小时）
1. **测试编写**
   - 学习[测试编写规范](test-writing-guidelines.md)
   - 为之前的功能添加测试
   - 运行测试并查看覆盖率

2. **提交规范**
   - 学习[提交信息规范](commit-message-guidelines.md)
   - 实践规范的提交信息
   - 使用Commitizen工具

### 下午：团队协作（3小时）
1. **团队会议参与**
   - 参加每日站会
   - 了解团队工作方式
   - 介绍自己和学习进展

2. **知识分享**
   - 分享学习心得
   - 提出问题和建议
   - 了解团队最佳实践

3. **导师交流**
   - 与导师一对一交流
   - 讨论职业发展
   - 制定学习计划

## 第一周总结

### 完成清单
- [ ] 开发环境配置完成
- [ ] 项目构建和测试通过
- [ ] 创建并使用了Git Worktree
- [ ] 完成了第一个简单任务
- [ ] 参与了代码评审
- [ ] 学习了测试编写
- [ ] 掌握了提交规范
- [ ] 参加了团队会议

### 学习成果
1. **技术技能**
   - 掌握了Markus开发流程
   - 熟练使用开发工具
   - 能够独立完成简单任务

2. **团队协作**
   - 了解了团队工作方式
   - 参与了代码评审
   - 建立了团队联系

## 常见问题解答

### Q1: 环境配置遇到问题怎么办？
**A**: 
1. 查看[开发环境配置指南](development-environment-setup.md)的常见问题部分
2. 在团队群组中提问
3. 联系导师或技术负责人

### Q2: 任务不知道如何开始？
**A**:
1. 仔细阅读任务描述
2. 查看相关代码和文档
3. 向任务创建者或同事请教
4. 分解任务为小步骤

### Q3: 代码评审意见不理解？
**A**:
1. 请求评审者进一步解释
2. 查看相关代码规范
3. 学习评审意见中的最佳实践
4. 与同事讨论解决方案

### Q4: 如何提高开发效率？
**A**:
1. 熟练掌握开发工具
2. 遵循标准开发流程
3. 及时沟通和协作
4. 持续学习和改进

## 学习资源

### 文档资源
1. **核心文档**
   - [主流程文档](../agent-development-workflow.md)
   - [开发环境配置](development-environment-setup.md)
   - [代码评审检查清单](code-review-checklist.md)

2. **工具文档**
   - [Git Worktree工具](../../tools/git-worktree/README.md)
   - [质量检查工具](../../tools/quality-check/README.md)

3. **规范文档**
   - [提交信息规范](commit-message-guidelines.md)
   - [测试编写规范](test-writing-guidelines.md)

### 外部资源
1. **TypeScript学习**
   - [TypeScript官方文档](https://www.typescriptlang.org/docs/)
   - [TypeScript入门教程](https://www.typescriptlang.org/docs/handbook/typescript-in-5-minutes.html)

2. **Git学习**
   - [Git官方文档](https://git-scm.com/doc)
   - [Git教程](https://www.atlassian.com/git/tutorials)

3. **测试学习**
   - [Vitest文档](https://vitest.dev/guide/)
   - [Testing Library文档](https://testing-library.com/docs/)

## 导师制度

### 导师职责
1. **环境指导**：帮助配置开发环境
2. **流程指导**：指导标准开发流程
3. **代码评审**：评审新人的代码
4. **问题解答**：解答技术和流程问题
5. **职业发展**：提供职业发展建议

### 新人责任
1. **主动学习**：积极学习和探索
2. **及时沟通**：遇到问题及时沟通
3. **接受反馈**：虚心接受评审意见
4. **持续改进**：不断改进技能和方法

## 考核和反馈

### 第一周考核
1. **技术考核**
   - 环境配置完成情况
   - 第一个任务完成质量
   - 代码规范掌握程度

2. **流程考核**
   - 开发流程遵循情况
   - 工具使用熟练度
   - 代码评审参与度

3. **团队考核**
   - 沟通协作能力
   - 学习态度和进步
   - 团队融入程度

### 反馈机制
1. **每日反馈**：导师每日简短反馈
2. **每周总结**：周五进行一周总结
3. **月度评估**：每月进行全面评估
4. **随时反馈**：随时可以请求反馈

## 长期发展计划

### 第一个月目标
1. **技术目标**
   - 熟练掌握所有开发工具
   - 能够独立完成中等复杂度任务
   - 代码质量达到团队标准

2. **流程目标**
   - 完全遵循标准开发流程
   - 能够进行有效的代码评审
   - 能够指导其他新人

3. **团队目标**
   - 完全融入团队
   - 建立良好的工作关系
   - 参与团队决策和规划

### 三个月目标
1. **技术专家**：在某个技术领域成为专家
2. **流程改进**：能够提出流程改进建议
3. **团队贡献**：为团队做出显著贡献
4. **新人指导**：能够指导新入职成员

## 紧急联系方式

### 技术问题
- **导师**：[导师姓名]
- **技术负责人**：[负责人姓名]
- **团队群组**：[群组链接]

### 流程问题
- **流程负责人**：AI God
- **项目经理**：Jason

### 人事问题
- **HR联系人**：[HR姓名]
- **团队经理**：[经理姓名]

## 总结
欢迎加入Markus团队！我们希望：

1. **第一周**：熟悉环境和流程
2. **第一个月**：成为有效贡献者
3. **第三个月**：成为团队核心成员

记住：
- ✅ 不要害怕提问
- ✅ 主动学习和探索
- ✅ 及时沟通和协作
- ✅ 持续改进和成长

祝你入职顺利，在Markus团队取得成功！