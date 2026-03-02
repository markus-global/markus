#!/usr/bin/env node

/**
 * GUI自动化基础示例
 * 演示如何使用GUI自动化包进行屏幕截图、分析和输入操作
 */

import { createGUIAutomationController } from '../src/gui-automation-controller.js';
import { createLogger } from '@markus/shared';

const log = createLogger('gui-example');

async function main() {
  log.info('Starting GUI automation example...');

  // 创建GUI自动化控制器
  const controller = createGUIAutomationController({
    containerId: 'gui-container',
    display: ':1',
    debug: true
  });

  try {
    // 1. 获取屏幕信息
    log.info('Getting screen info...');
    const screenInfo = await controller.getScreenInfo();
    log.info('Screen info:', screenInfo);

    // 2. 捕获屏幕截图
    log.info('Capturing screenshot...');
    const screenshotResult = await controller.captureScreenshot();
    if (screenshotResult.success) {
      log.info('Screenshot captured successfully');
      log.info('Screenshot data length:', screenshotResult.data?.screenshot?.length || 0);
    } else {
      log.error('Failed to capture screenshot:', screenshotResult.message);
    }

    // 3. 分析屏幕
    log.info('Analyzing screen...');
    const analysisResult = await controller.analyzeScreen();
    if (analysisResult.success) {
      log.info('Screen analysis completed');
      const elements = analysisResult.data?.analysis?.elements || [];
      log.info(`Found ${elements.length} GUI elements`);
      
      // 显示前几个元素
      elements.slice(0, 3).forEach((element, index) => {
        log.info(`Element ${index + 1}:`, {
          type: element.type,
          position: `(${element.x}, ${element.y})`,
          size: `${element.width}x${element.height}`,
          text: element.text || '(no text)'
        });
      });
    } else {
      log.error('Failed to analyze screen:', analysisResult.message);
    }

    // 4. 执行简单的鼠标操作（模拟）
    log.info('Performing mouse operations...');
    
    // 移动鼠标到中心位置
    const screenWidth = screenInfo.data?.width || 1920;
    const screenHeight = screenInfo.data?.height || 1080;
    const centerX = Math.floor(screenWidth / 2);
    const centerY = Math.floor(screenHeight / 2);
    
    const moveResult = await controller.executeCommand({
      type: 'move_mouse',
      x: centerX,
      y: centerY
    });
    
    if (moveResult.success) {
      log.info(`Mouse moved to (${centerX}, ${centerY})`);
    } else {
      log.error('Failed to move mouse:', moveResult.message);
    }

    // 5. 执行点击操作
    const clickResult = await controller.executeCommand({
      type: 'click',
      x: centerX,
      y: centerY
    });
    
    if (clickResult.success) {
      log.info(`Clicked at (${centerX}, ${centerY})`);
    } else {
      log.error('Failed to click:', clickResult.message);
    }

    // 6. 执行键盘输入
    const typeResult = await controller.executeCommand({
      type: 'type_text',
      text: 'Hello, GUI Automation!'
    });
    
    if (typeResult.success) {
      log.info('Typed text successfully');
    } else {
      log.error('Failed to type text:', typeResult.message);
    }

    // 7. 查找特定元素
    const findResult = await controller.executeCommand({
      type: 'find_element',
      query: 'button',
      elementType: 'button'
    });
    
    if (findResult.success) {
      const elements = findResult.data?.elements || [];
      log.info(`Found ${elements.length} button elements`);
    } else {
      log.error('Failed to find elements:', findResult.message);
    }

    log.info('GUI automation example completed successfully!');

  } catch (error) {
    log.error('Error in GUI automation example:', error);
  }
}

// 运行示例
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { main };