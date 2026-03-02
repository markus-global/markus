# GUI自动化模块架构设计

## 概述
GUI自动化模块为Markus数字员工提供桌面应用、网页界面等GUI操作的自动化能力。核心组件包括VNC客户端、屏幕截图、元素识别（OmniParser）和输入模拟。

## 架构设计

### 1. 核心组件

```
packages/gui/
├── src/
│   ├── index.ts              # 主入口
│   ├── vnc-client.ts         # VNC客户端（RFB协议）
│   ├── screenshot.ts         # 屏幕截图和图像处理
│   ├── input.ts              # 鼠标键盘输入模拟
│   ├── element-detector.ts   # GUI元素识别（OmniParser集成）
│   ├── gui-automator.ts      # GUI自动化控制器
│   ├── gui-agent-tools.ts    # Agent工具接口
│   └── types.ts              # 类型定义
├── test/                     # 测试文件
└── package.json
```

### 2. 组件职责

#### 2.1 VNC客户端 (vnc-client.ts)
- 实现RFB（Remote Framebuffer）协议
- 支持VNC 3.3/3.7/3.8协议版本
- 提供屏幕帧缓冲和输入事件处理
- 支持密码认证

#### 2.2 屏幕截图 (screenshot.ts)
- 从VNC连接捕获屏幕图像
- 支持区域截图和全屏截图
- 图像格式转换（PNG, JPEG, base64）
- 图像预处理（缩放、灰度化、边缘检测）

#### 2.3 元素识别 (element-detector.ts)
- 集成OmniParser进行GUI元素识别
- 支持按钮、输入框、菜单、列表等元素检测
- 提供元素位置、大小、文本内容等信息
- 支持模板匹配和OCR识别

#### 2.4 输入模拟 (input.ts)
- 鼠标操作：移动、点击、拖拽、滚动
- 键盘操作：按键、组合键、文本输入
- 触摸屏模拟（可选）
- 输入事件队列和时序控制

#### 2.5 GUI自动化控制器 (gui-automator.ts)
- 协调各组件工作流
- 提供高级自动化API
- 错误处理和重试机制
- 状态管理和日志记录

#### 2.6 Agent工具接口 (gui-agent-tools.ts)
- 将GUI功能暴露为Agent工具
- 符合AgentToolHandler接口规范
- 提供工具描述和参数验证

### 3. 技术选型

#### 3.1 VNC协议实现
- 使用原生Node.js TCP socket
- 实现RFB协议解析器
- 支持多种编码格式（Raw, CopyRect, RRE, Hextile）

#### 3.2 图像处理
- 使用Sharp库进行图像处理
- 支持OpenCV.js进行高级图像分析
- 集成Tesseract.js进行OCR

#### 3.3 OmniParser集成
- 研究OmniParser开源实现或API
- 提供元素检测和识别接口
- 支持自定义元素模板

### 4. API设计

#### 4.1 低级API
```typescript
interface VNCClient {
  connect(config: VNCConfig): Promise<void>;
  disconnect(): Promise<void>;
  captureScreen(region?: ScreenRegion): Promise<ImageData>;
  sendMouseEvent(x: number, y: number, button: MouseButton): Promise<void>;
  sendKeyEvent(key: string, pressed: boolean): Promise<void>;
}

interface ElementDetector {
  detectElements(image: ImageData): Promise<GUIElement[]>;
  findElement(image: ImageData, query: ElementQuery): Promise<GUIElement | null>;
  extractText(image: ImageData, region: ScreenRegion): Promise<string>;
}
```

#### 4.2 高级API
```typescript
interface GUIAutomator {
  launch(): Promise<void>;
  screenshot(path?: string): Promise<ScreenshotResult>;
  click(element: GUIElement | Position): Promise<void>;
  type(text: string, element?: GUIElement): Promise<void>;
  waitForElement(query: ElementQuery, timeout?: number): Promise<GUIElement>;
  executeWorkflow(steps: AutomationStep[]): Promise<void>;
}
```

#### 4.3 Agent工具
```typescript
const guiTools = [
  {
    name: 'gui_screenshot',
    description: 'Capture screenshot of desktop',
    inputSchema: { /* ... */ },
    execute: async () => { /* ... */ }
  },
  {
    name: 'gui_click_element',
    description: 'Click on GUI element by text or type',
    inputSchema: { /* ... */ },
    execute: async () => { /* ... */ }
  },
  // ... 更多工具
];
```

### 5. 集成方案

#### 5.1 与Docker沙箱集成
- 在Agent容器中运行VNC服务器（x11vnc/tigervnc）
- 通过Docker exec执行GUI操作
- 共享屏幕截图目录

#### 5.2 与Agent系统集成
- 通过技能注册表注册GUI技能
- 提供GUI工具给Agent使用
- 支持工具权限控制

#### 5.3 配置管理
```typescript
interface GUIConfig {
  vnc: {
    host: string;
    port: number;
    password?: string;
  };
  screenshot: {
    dir: string;
    format: 'png' | 'jpeg';
    quality: number;
  };
  detection: {
    engine: 'omniparser' | 'opencv' | 'tesseract';
    confidence: number;
    timeout: number;
  };
}
```

### 6. 实施计划

#### Phase 1: 基础功能
1. 完善VNC客户端RFB协议实现
2. 增强屏幕截图和图像处理
3. 实现基本输入模拟

#### Phase 2: 元素识别
1. 集成OmniParser或替代方案
2. 实现元素检测和识别
3. 添加OCR支持

#### Phase 3: 高级自动化
1. 实现GUI自动化控制器
2. 添加工作流支持
3. 完善错误处理和重试

#### Phase 4: 集成和优化
1. 与Agent系统深度集成
2. 性能优化和缓存
3. 添加监控和日志

### 7. 测试策略

#### 7.1 单元测试
- 各组件独立测试
- Mock VNC服务器和输入设备
- 图像处理算法验证

#### 7.2 集成测试
- 完整GUI自动化流程测试
- 与Docker沙箱集成测试
- Agent工具调用测试

#### 7.3 端到端测试
- 真实GUI应用自动化测试
- 跨平台兼容性测试
- 性能和稳定性测试

### 8. 安全考虑

#### 8.1 访问控制
- VNC连接密码保护
- 工具权限分级
- 操作审计日志

#### 8.2 资源限制
- 截图存储空间限制
- 操作频率限制
- 内存使用监控

#### 8.3 隐私保护
- 敏感信息模糊处理
- 截图自动清理
- 用户数据隔离

## 总结

GUI自动化模块是Markus数字员工真正工作的关键能力。通过VNC远程控制和OmniParser元素识别，Agent能够操作各种桌面应用和网页界面，实现真正的自动化工作流。

本架构设计提供了可扩展、可维护的实现方案，支持从基础操作到高级自动化的完整功能栈。