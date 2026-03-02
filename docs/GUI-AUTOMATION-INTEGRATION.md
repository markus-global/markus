# GUI自动化集成指南

## 概述

Markus的GUI自动化功能已经升级，现在支持基于视觉的自动化工具和OmniParser集成。本文档提供完整的集成指南和使用说明。

## 架构设计

### 组件架构
```
┌─────────────────────────────────────────────────────────────┐
│                    Markus Core                               │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │               Skill Registry                        │   │
│  │                                                     │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │   │
│  │  │   Git Skill │  │   GUI Skill │  │  Advanced   │ │   │
│  │  │             │  │             │  │   GUI Skill │ │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘ │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │               @markus/gui Package                   │   │
│  │                                                     │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │   │
│  │  │  VNC Client │  │ OmniParser  │  │  Visual     │ │   │
│  │  │             │  │             │  │ Automation  │ │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘ │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 功能模块
1. **基础GUI功能** - 截图、鼠标控制、键盘输入
2. **OmniParser模块** - GUI元素识别和解析
3. **视觉自动化工具** - 基于元素的自动化操作
4. **高级GUI技能** - 集成所有功能的技能模块

## 安装和配置

### 1. 安装依赖
```bash
# 安装GUI包
cd packages/gui
npm install

# 构建GUI包
npm run build
```

### 2. 配置环境变量
```bash
# 设置截图目录
export MARKUS_SCREENSHOT_DIR="/tmp/markus-screenshots"

# 设置Docker容器ID（如果使用容器化环境）
export MARKUS_CONTAINER_ID="your-container-id"
```

## 使用指南

### 1. 基础使用
```javascript
import { createDefaultSkillRegistry } from '@markus/core';

// 创建基础技能注册表
const registry = await createDefaultSkillRegistry({
  containerId: process.env.MARKUS_CONTAINER_ID,
  screenshotDir: process.env.MARKUS_SCREENSHOT_DIR,
});

// 获取GUI技能
const guiSkill = registry.get('gui');
const tools = guiSkill.instance.tools;

// 使用基础工具
await tools.gui_screenshot.execute({});
await tools.gui_click.execute({ x: 100, y: 200 });
await tools.gui_type.execute({ text: 'Hello World' });
```

### 2. 高级使用（启用OmniParser）
```javascript
import { createDefaultSkillRegistry } from '@markus/core';

// 创建技能注册表，启用高级GUI功能
const registry = await createDefaultSkillRegistry({
  containerId: process.env.MARKUS_CONTAINER_ID,
  screenshotDir: process.env.MARKUS_SCREENSHOT_DIR,
  enableAdvancedGUI: true,  // 启用高级GUI功能
  debug: true,              // 启用调试模式
});

// 获取高级GUI技能
const advancedGuiSkill = registry.get('advanced-gui');
const tools = advancedGuiSkill.instance.tools;

// 使用高级工具
const analysis = await tools.gui_analyze_screen.execute({});
console.log('屏幕分析结果:', JSON.parse(analysis));

// 查找元素
const elements = await tools.gui_find_element.execute({
  text: 'Login',
  type: 'button'
});
console.log('找到的元素:', JSON.parse(elements));

// 点击元素
await tools.gui_click_element.execute({
  elementId: 'button-login-123'
});

// 输入文本到元素
await tools.gui_type_to_element.execute({
  elementId: 'input-username-456',
  text: 'admin'
});

// 自动化任务
await tools.gui_automate_task.execute({
  task: 'login',
  steps: [
    { action: 'find', target: 'username input' },
    { action: 'type', text: 'admin' },
    { action: 'find', target: 'password input' },
    { action: 'type', text: 'password123' },
    { action: 'find', target: 'login button' },
    { action: 'click' }
  ]
});
```

## 工具参考

### 基础工具
| 工具名称 | 描述 | 参数 |
|---------|------|------|
| `gui_screenshot` | 截取屏幕截图 | 无 |
| `gui_click` | 在指定坐标点击 | `x`, `y`, `button` |
| `gui_double_click` | 双击 | `x`, `y` |
| `gui_type` | 输入文本 | `text` |
| `gui_key_press` | 按键组合 | `keys` |
| `gui_scroll` | 滚动鼠标 | `deltaX`, `deltaY` |
| `gui_get_window_title` | 获取窗口标题 | 无 |

### 高级工具（OmniParser集成）
| 工具名称 | 描述 | 参数 |
|---------|------|------|
| `gui_analyze_screen` | 分析屏幕元素 | `mode` (可选) |
| `gui_find_element` | 查找GUI元素 | `text`, `type`, `attributes` |
| `gui_click_element` | 点击GUI元素 | `elementId`, `button` |
| `gui_type_to_element` | 输入文本到元素 | `elementId`, `text` |
| `gui_automate_task` | 自动化多步骤任务 | `task`, `steps` |

## OmniParser功能

### 元素识别
OmniParser可以识别以下GUI元素类型：
- **按钮** (button)
- **输入框** (input, textarea)
- **标签** (label)
- **复选框** (checkbox)
- **单选框** (radio)
- **下拉菜单** (select)
- **菜单项** (menu-item)
- **图标** (icon)
- **链接** (link)

### 元素属性
每个识别的元素包含以下属性：
- `id`: 元素唯一标识符
- `type`: 元素类型
- `text`: 元素文本内容
- `bounds`: 元素边界框 `{x, y, width, height}`
- `attributes`: 额外属性（如颜色、字体、状态等）
- `confidence`: 识别置信度

## 示例应用

### 1. 自动化登录流程
```javascript
async function automateLogin(username, password) {
  const registry = await createDefaultSkillRegistry({
    containerId: 'test-container',
    screenshotDir: '/tmp/screenshots',
    enableAdvancedGUI: true
  });
  
  const tools = registry.get('advanced-gui').instance.tools;
  
  // 1. 分析屏幕
  const analysis = JSON.parse(await tools.gui_analyze_screen.execute({}));
  
  // 2. 查找用户名输入框
  const usernameInput = JSON.parse(await tools.gui_find_element.execute({
    type: 'input',
    attributes: { placeholder: 'Username' }
  }));
  
  // 3. 输入用户名
  await tools.gui_type_to_element.execute({
    elementId: usernameInput.id,
    text: username
  });
  
  // 4. 查找密码输入框
  const passwordInput = JSON.parse(await tools.gui_find_element.execute({
    type: 'input',
    attributes: { type: 'password' }
  }));
  
  // 5. 输入密码
  await tools.gui_type_to_element.execute({
    elementId: passwordInput.id,
    text: password
  });
  
  // 6. 查找登录按钮
  const loginButton = JSON.parse(await tools.gui_find_element.execute({
    type: 'button',
    text: 'Login'
  }));
  
  // 7. 点击登录按钮
  await tools.gui_click_element.execute({
    elementId: loginButton.id
  });
  
  return { success: true, message: '登录流程完成' };
}
```

### 2. 自动化数据录入
```javascript
async function automateDataEntry(data) {
  const tools = await getAdvancedGUITools();
  
  for (const item of data) {
    // 查找对应的输入字段
    const field = JSON.parse(await tools.gui_find_element.execute({
      text: item.fieldName
    }));
    
    // 输入数据
    await tools.gui_type_to_element.execute({
      elementId: field.id,
      text: item.value
    });
  }
  
  // 提交表单
  const submitButton = JSON.parse(await tools.gui_find_element.execute({
    type: 'button',
    text: 'Submit'
  }));
  
  await tools.gui_click_element.execute({
    elementId: submitButton.id
  });
}
```

## 故障排除

### 常见问题

#### 1. GUI工具返回错误
**问题**: `GUI tools require containerId and screenshotDir parameters`
**解决方案**: 确保在创建技能注册表时提供正确的参数：
```javascript
const registry = await createDefaultSkillRegistry({
  containerId: 'your-container-id',  // 必须提供
  screenshotDir: '/path/to/screenshots',  // 必须提供
  enableAdvancedGUI: true
});
```

#### 2. OmniParser无法识别元素
**问题**: 元素识别置信度低
**解决方案**:
- 确保屏幕截图清晰
- 调整元素查找参数
- 使用更具体的属性进行查找

#### 3. 依赖包缺失
**问题**: `Cannot find package '@markus/gui'`
**解决方案**:
```bash
cd packages/gui
npm install
npm run build
```

### 调试模式
启用调试模式以获取详细日志：
```javascript
const registry = await createDefaultSkillRegistry({
  containerId: 'test-container',
  screenshotDir: '/tmp/screenshots',
  enableAdvancedGUI: true,
  debug: true  // 启用调试模式
});
```

## 性能优化

### 1. 缓存屏幕分析结果
```javascript
let cachedAnalysis = null;

async function getScreenAnalysis() {
  if (!cachedAnalysis) {
    const tools = await getAdvancedGUITools();
    cachedAnalysis = JSON.parse(await tools.gui_analyze_screen.execute({}));
  }
  return cachedAnalysis;
}
```

### 2. 批量操作
```javascript
// 批量查找元素
async function batchFindElements(queries) {
  const tools = await getAdvancedGUITools();
  const results = [];
  
  for (const query of queries) {
    const result = JSON.parse(await tools.gui_find_element.execute(query));
    results.push(result);
  }
  
  return results;
}
```

## 扩展开发

### 1. 添加自定义GUI工具
```typescript
import type { AgentToolHandler } from '@markus/core';

export function createCustomGUITool(): AgentToolHandler {
  return {
    name: 'custom_gui_tool',
    description: 'Custom GUI automation tool',
    inputSchema: {
      type: 'object',
      properties: {
        // 定义参数
      },
      required: []
    },
    execute: async (args) => {
      // 实现工具逻辑
      return JSON.stringify({ success: true });
    }
  };
}
```

### 2. 扩展OmniParser
```typescript
import { OmniParser } from '@markus/gui';

export class ExtendedOmniParser extends OmniParser {
  async recognizeCustomElements(screenshot: Buffer): Promise<GUIElement[]> {
    // 实现自定义元素识别逻辑
    return [];
  }
}
```

## 最佳实践

1. **错误处理**: 始终处理GUI操作可能失败的情况
2. **超时设置**: 为长时间运行的操作设置超时
3. **资源清理**: 使用后清理截图等临时文件
4. **日志记录**: 记录重要的GUI操作和结果
5. **测试验证**: 在生产环境前充分测试自动化流程

## 版本历史

### v0.2.0 (当前)
- 集成OmniParser进行GUI元素识别
- 添加视觉自动化工具
- 支持基于元素的自动化操作
- 提供高级GUI技能模块

### v0.1.0
- 基础GUI功能（截图、鼠标、键盘）
- VNC客户端集成
- 基础GUI技能模块

---

**注意**: 完整的GUI自动化功能需要正确的环境设置和依赖包安装。在生产环境中使用前，请确保所有组件都已正确配置和测试。