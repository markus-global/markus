#!/usr/bin/env node

/**
 * GUI自动化功能测试
 * 测试GUI自动化包的核心功能
 */

import { createLogger } from '@markus/shared';
import { DockerScreenshotProvider, screenshotToBase64 } from '../src/screenshot.js';
import { DesktopInput } from '../src/input.js';
import { OmniParser } from '../src/omniparser.js';
import { VisualAutomation } from '../src/visual-automation.js';

const log = createLogger('gui-test');

async function testScreenshot() {
  log.info('Testing screenshot functionality...');
  
  const provider = new DockerScreenshotProvider('gui-container', ':1');
  
  try {
    // 测试截图捕获
    const result = await provider.capture('/tmp/test_screenshot.png');
    log.info('Screenshot captured:', {
      path: result.path,
      width: result.width,
      height: result.height,
      timestamp: result.timestamp
    });
    
    // 测试base64转换
    const base64 = screenshotToBase64(result.path);
    log.info('Base64 conversion successful, length:', base64.length);
    
    return true;
  } catch (error) {
    log.error('Screenshot test failed:', error);
    return false;
  }
}

async function testInput() {
  log.info('Testing input functionality...');
  
  const input = new DesktopInput('gui-container', ':1');
  
  try {
    // 测试获取鼠标位置
    const position = await input.getMousePosition();
    log.info('Current mouse position:', position);
    
    // 测试获取活动窗口标题
    const windowTitle = await input.getActiveWindowTitle();
    log.info('Active window title:', windowTitle);
    
    return true;
  } catch (error) {
    log.error('Input test failed:', error);
    return false;
  }
}

async function testOmniParser() {
  log.info('Testing OmniParser functionality...');
  
  const parser = new OmniParser('info');
  
  try {
    // 测试分析屏幕（模拟模式）
    const analysis = await parser.analyzeScreenshot('/tmp/test_screenshot.png');
    log.info('Screen analysis completed:', {
      elements: analysis.elements.length,
      resolution: analysis.resolution,
      timestamp: analysis.timestamp
    });
    
    return true;
  } catch (error) {
    log.error('OmniParser test failed:', error);
    return false;
  }
}

async function testVisualAutomation() {
  log.info('Testing VisualAutomation functionality...');
  
  const automation = new VisualAutomation({
    debug: true,
    containerId: 'gui-container',
    display: ':1'
  });
  
  try {
    // 测试捕获和分析
    const result = await automation.captureAndAnalyze();
    log.info('Visual automation completed:', {
      elements: result.elements.length,
      screenshotPath: result.screenshotPath,
      timestamp: result.timestamp
    });
    
    // 测试查找元素
    const elements = await automation.findElements('button');
    log.info('Found button elements:', elements.length);
    
    return true;
  } catch (error) {
    log.error('VisualAutomation test failed:', error);
    return false;
  }
}

async function runAllTests() {
  log.info('Starting GUI automation tests...');
  
  const results = {
    screenshot: false,
    input: false,
    omniParser: false,
    visualAutomation: false
  };
  
  try {
    // 测试截图功能
    results.screenshot = await testScreenshot();
    
    // 测试输入功能
    results.input = await testInput();
    
    // 测试OmniParser
    results.omniParser = await testOmniParser();
    
    // 测试VisualAutomation
    results.visualAutomation = await testVisualAutomation();
    
    // 输出测试结果
    log.info('Test results:', results);
    
    const allPassed = Object.values(results).every(result => result);
    if (allPassed) {
      log.info('✅ All GUI automation tests passed!');
    } else {
      log.warn('⚠️ Some GUI automation tests failed');
    }
    
    return allPassed;
    
  } catch (error) {
    log.error('Test suite failed:', error);
    return false;
  }
}

// 运行测试
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests().then(success => {
    process.exit(success ? 0 : 1);
  }).catch(error => {
    log.error('Test runner error:', error);
    process.exit(1);
  });
}

export { runAllTests };