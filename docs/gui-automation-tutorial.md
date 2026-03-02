# GUI自动化教程 - 使用OmniParser和视觉自动化

## 概述

Markus的GUI自动化功能已经升级，现在支持基于视觉的自动化工具和OmniParser集成。本教程将指导您如何使用这些高级功能。

## 基础GUI功能

### 1. 基础工具

基础GUI工具提供基本的桌面控制功能：

```javascript
import { createDefaultSkillRegistry } from '@markus/core';

// 创建技能注册表
const registry = await createDefaultSkillRegistry({
  containerId: 'your-container-id',
  screenshotDir: '/path/to/screenshots'
});

// 获取GUI技能
const guiSkill = registry.getSkill('gui');
const tools = guiSkill.tools;

// 使用基础工具
await tools.gui_screenshot.execute({});
await tools.gui_click.execute({ x: 100, y: 200 });
await tools.gui_type.execute({ text: 'Hello World' });
```

### 2. 基础工具列表

- `gui_screenshot`: 截取屏幕截图
- `gui_click`: 在指定坐标点击
- `gui_double_click`: 双击
- `gui_type`: 输入文本
- `gui_key_press`: 按键组合
- `gui_scroll`: 滚动鼠标
- `gui_get_window_title`: 获取窗口标题

## 高级GUI功能（OmniParser集成）

### 1. 启用高级GUI功能

要使用高级GUI功能，需要在创建技能注册表时启用：

```javascript
import { createDefaultSkillRegistry } from '@markus/core';

// 启用高级GUI功能
const registry = await createDefaultSkillRegistry({
  containerId: 'your-container-id',
  screenshotDir: '/path/to/screenshots',
  enableAdvancedGUI: true,  // 启用高级功能
  debug: true               // 可选：启用调试模式
});

// 获取高级GUI技能
const advancedGuiSkill = registry.getSkill('advanced-gui');
const advancedTools = advancedGuiSkill.tools;
```

### 2. 视觉自动化工具

#### 2.1 屏幕分析

分析当前屏幕，检测所有GUI元素：

```javascript
// 分析屏幕元素
const result = await advancedTools.gui_analyze_screen.execute({});
console.log('Detected elements:', JSON.parse(result).elements);
```

#### 2.2 查找元素

按文本、类型或属性查找GUI元素：

```javascript
// 查找按钮
const buttonResult = await advancedTools.gui_find_element.execute({
  text: 'Submit',
  type: 'button',
  min_confidence: 0.7
});

// 查找输入框
const inputResult = await advancedTools.gui_find_element.execute({
  type: 'input',
  placeholder: 'Enter your name',
  min_confidence: 0.7
});
```

#### 2.3 点击元素

查找并点击GUI元素：

```javascript
// 点击"Submit"按钮
const clickResult = await advancedTools.gui_click_element.execute({
  text: 'Submit',
  type: 'button',
  button: 'left'  // 可选：left, right, middle
});

// 点击链接
const linkResult = await advancedTools.gui_click_element.execute({
  text: 'Click here',
  type: 'link'
});
```

#### 2.4 输入文本到元素

查找输入框并输入文本：

```javascript
// 在用户名输入框中输入文本
const typeResult = await advancedTools.gui_type_to_element.execute({
  text: 'john.doe@example.com',
  label: 'Email',
  placeholder: 'Enter email address'
});

// 在密码输入框中输入文本
const passwordResult = await advancedTools.gui_type_to_element.execute({
  text: 'secretpassword',
  label: 'Password',
  placeholder: 'Enter password'
});
```

#### 2.5 自动化任务

自动化多步骤GUI任务：

```javascript
// 自动化登录任务
const taskResult = await advancedTools.gui_automate_task.execute({
  task_description: 'Automate login to application',
  steps: [
    {
      action: 'click',
      target: 'Username',
      delay_ms: 1000
    },
    {
      action: 'type',
      target: 'Username',
      value: 'testuser',
      delay_ms: 500
    },
    {
      action: 'click',
      target: 'Password',
      delay_ms: 1000
    },
    {
      action: 'type',
      target: 'Password',
      value: 'testpass',
      delay_ms: 500
    },
    {
      action: 'click',
      target: 'Login',
      delay_ms: 2000
    }
  ]
});
```

## 使用示例

### 示例1：自动化网页表单填写

```javascript
async function automateFormFilling() {
  const registry = await createDefaultSkillRegistry({
    containerId: 'web-browser-container',
    screenshotDir: '/tmp/screenshots',
    enableAdvancedGUI: true
  });
  
  const guiSkill = registry.getSkill('advanced-gui');
  const tools = guiSkill.tools;
  
  // 1. 导航到表单页面
  // 2. 填写表单
  await tools.gui_type_to_element.execute({
    text: 'John Doe',
    label: 'Full Name'
  });
  
  await tools.gui_type_to_element.execute({
    text: 'john@example.com',
    label: 'Email'
  });
  
  await tools.gui_type_to_element.execute({
    text: 'This is a test message',
    label: 'Message'
  });
  
  // 3. 提交表单
  await tools.gui_click_element.execute({
    text: 'Submit',
    type: 'button'
  });
  
  console.log('Form submitted successfully');
}
```

### 示例2：自动化软件安装

```javascript
async function automateSoftwareInstallation() {
  const registry = await createDefaultSkillRegistry({
    containerId: 'installer-container',
    screenshotDir: '/tmp/screenshots',
    enableAdvancedGUI: true
  });
  
  const guiSkill = registry.getSkill('advanced-gui');
  const tools = guiSkill.tools;
  
  // 1. 启动安装程序
  // 2. 点击"Next"按钮
  await tools.gui_click_element.execute({
    text: 'Next',
    type: 'button'
  });
  
  // 3. 接受许可协议
  await tools.gui_click_element.execute({
    text: 'I Agree',
    type: 'button'
  });
  
  // 4. 选择安装路径
  await tools.gui_click_element.execute({
    text: 'Browse',
    type: 'button'
  });
  
  // 5. 输入安装路径
  await tools.gui_type_to_element.execute({
    text: '/opt/myapp',
    label: 'Installation Path'
  });
  
  // 6. 完成安装
  await tools.gui_click_element.execute({
    text: 'Install',
    type: 'button'
  });
  
  // 7. 等待安装完成
  await new Promise(resolve => setTimeout(resolve, 30000));
  
  // 8. 点击"Finish"
  await tools.gui_click_element.execute({
    text: 'Finish',
    type: 'button'
  });
  
  console.log('Software installation completed');
}
```

## 最佳实践

### 1. 错误处理

```javascript
async function safeAutomation() {
  try {
    const result = await tools.gui_click_element.execute({
      text: 'Submit',
      type: 'button'
    });
    
    const parsed = JSON.parse(result);
    if (!parsed.success) {
      console.warn('Element not found, trying alternative...');
      // 尝试替代方案
    }
  } catch (error) {
    console.error('Automation failed:', error);
    // 回退到基础方法
    await tools.gui_screenshot.execute({});
    // 手动分析或重试
  }
}
```

### 2. 重试机制

```javascript
async function retryAutomation(tool, args, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const result = await tool.execute(args);
      const parsed = JSON.parse(result);
      if (parsed.success) {
        return parsed;
      }
    } catch (error) {
      console.warn(`Attempt ${i + 1} failed:`, error);
    }
    
    // 等待后重试
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  throw new Error(`Automation failed after ${maxRetries} attempts`);
}
```

### 3. 性能优化

- 使用适当的延迟：在操作之间添加合理的延迟
- 缓存截图：避免重复截图
- 批量操作：将相关操作组合在一起
- 使用调试模式：开发时启用调试模式，生产环境关闭

## 故障排除

### 常见问题

1. **元素找不到**
   - 检查元素文本是否准确
   - 降低置信度阈值
   - 使用更通用的选择器

2. **自动化失败**
   - 检查容器是否正常运行
   - 验证截图目录权限
   - 确保VNC连接正常

3. **性能问题**
   - 减少截图频率
   - 优化元素查找条件
   - 使用更快的硬件

### 调试技巧

```javascript
// 启用调试模式
const registry = await createDefaultSkillRegistry({
  containerId: 'test-container',
  screenshotDir: '/tmp/screenshots',
  enableAdvancedGUI: true,
  debug: true  // 启用详细日志
});

// 手动截图分析
const screenshot = await tools.gui_screenshot.execute({});
console.log('Screenshot info:', JSON.parse(screenshot));

// 分析屏幕元素
const analysis = await tools.gui_analyze_screen.execute({});
console.log('Screen analysis:', JSON.parse(analysis));
```

## 总结

Markus的高级GUI自动化功能提供了强大的视觉自动化能力，结合OmniParser的智能元素识别，可以自动化复杂的GUI任务。通过本教程，您应该能够：

1. 启用和使用高级GUI功能
2. 使用视觉自动化工具
3. 创建自动化任务脚本
4. 处理常见问题和优化性能

如需更多帮助，请参考API文档或联系支持团队。