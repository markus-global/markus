# @markus/gui - GUI自动化包

GUI自动化包为Markus Agent提供了桌面应用和网页界面的自动化能力。它集成了VNC客户端、屏幕截图、输入控制和视觉分析功能。

## 功能特性

- **屏幕截图**: 从Docker容器中捕获屏幕截图
- **输入控制**: 通过xdotool控制鼠标和键盘
- **视觉分析**: 使用OmniParser分析GUI元素
- **VNC集成**: 支持VNC协议连接远程桌面
- **自动化控制**: 提供高级自动化API

## 安装

```bash
# 在项目根目录
npm install
npm run build
```

## 快速开始

### 基本使用

```typescript
import { createGUIAutomationController } from '@markus/gui';

// 创建GUI自动化控制器
const controller = createGUIAutomationController({
  containerId: 'gui-container',
  display: ':1',
  debug: true
});

// 获取屏幕信息
const screenInfo = await controller.getScreenInfo();

// 捕获屏幕截图
const screenshot = await controller.captureScreenshot();

// 分析屏幕
const analysis = await controller.analyzeScreen();

// 执行自动化命令
await controller.executeCommand({
  type: 'click',
  x: 100,
  y: 200
});
```

### 直接使用底层API

```typescript
import { DockerScreenshotProvider, DesktopInput, OmniParser } from '@markus/gui';

// 截图提供者
const screenshotProvider = new DockerScreenshotProvider('gui-container', ':1');
const screenshot = await screenshotProvider.capture('/tmp/screenshot.png');

// 输入控制
const input = new DesktopInput('gui-container', ':1');
await input.moveMouse(100, 200);
await input.click(100, 200);
await input.type('Hello World');

// 视觉分析
const parser = new OmniParser('info');
const analysis = await parser.analyzeScreenshot('/tmp/screenshot.png');
```

## 组件说明

### 1. DockerScreenshotProvider

从Docker容器中捕获屏幕截图。使用ImageMagick的`import`命令。

```typescript
const provider = new DockerScreenshotProvider(containerId, display);
const result = await provider.capture(outputPath);
```

### 2. DesktopInput

通过xdotool控制Docker容器中的鼠标和键盘。

```typescript
const input = new DesktopInput(containerId, display);
await input.moveMouse(x, y);
await input.click(x, y);
await input.type(text);
await input.keyPress('ctrl', 'c');
```

### 3. OmniParser

分析屏幕截图，识别GUI元素（按钮、输入框、文本等）。

```typescript
const parser = new OmniParser(debugMode);
const analysis = await parser.analyzeScreenshot(screenshotPath);
```

### 4. VisualAutomation

高级自动化API，整合了截图、分析和输入功能。

```typescript
const automation = new VisualAutomation(options);
const result = await automation.captureAndAnalyze();
const elements = await automation.findElements('button');
await automation.clickElement(element);
```

### 5. GUIAutomationController

面向Agent的自动化控制器，提供标准化的API接口。

```typescript
const controller = createGUIAutomationController(config);
const response = await controller.executeCommand(command);
```

## 环境要求

### Docker容器配置

GUI自动化需要在Docker容器中运行桌面环境。推荐使用以下镜像：

1. **Firefox容器**: `jlesage/firefox:latest`
2. **Chrome容器**: `selenium/standalone-chrome:latest`
3. **VNC桌面**: `consol/ubuntu-xfce-vnc:latest`

### 容器内需要安装的工具

```bash
# 在容器内安装必要工具
apt-get update && apt-get install -y \
  xdotool \
  imagemagick \
  x11-apps \
  xvfb \
  x11vnc
```

## 示例

### 运行示例

```bash
# 启动Docker容器
docker-compose up -d gui-container

# 运行示例
npm run example

# 运行测试
npm run test
```

### 基本自动化示例

参考 `examples/basic-automation.ts` 查看完整的自动化示例。

## 开发

### 构建

```bash
npm run build
```

### 开发模式

```bash
npm run dev
```

### 清理

```bash
npm run clean
```

## 架构设计

```
GUI自动化架构
├── 数据层 (Data Layer)
│   ├── DockerScreenshotProvider - 截图捕获
│   └── DesktopInput - 输入控制
├── 分析层 (Analysis Layer)
│   └── OmniParser - GUI元素识别
├── 控制层 (Control Layer)
│   ├── VisualAutomation - 高级自动化
│   └── GUIAutomationController - Agent接口
└── 协议层 (Protocol Layer)
    └── VNCClient - VNC协议支持
```

## 注意事项

1. **性能**: 屏幕截图和视觉分析可能消耗较多资源
2. **延迟**: 网络延迟可能影响自动化操作的响应时间
3. **兼容性**: 不同桌面环境可能需要调整配置
4. **安全**: 确保VNC连接使用密码保护

## 故障排除

### 常见问题

1. **截图失败**: 检查DISPLAY环境变量和容器权限
2. **输入无效**: 确认xdotool已安装且容器有输入权限
3. **VNC连接失败**: 检查端口映射和防火墙设置

### 调试

启用调试模式查看详细日志：

```typescript
const controller = createGUIAutomationController({
  debug: true,
  // ...其他配置
});
```

## 路线图

- [ ] 集成真正的计算机视觉库
- [ ] 支持更多输入设备
- [ ] 添加录制和回放功能
- [ ] 支持多显示器
- [ ] 添加OCR文本识别

## 许可证

MIT