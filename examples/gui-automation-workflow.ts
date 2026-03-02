#!/usr/bin/env node

/**
 * GUI自动化工作流示例
 * 演示如何使用GUI自动化工具进行桌面应用操作
 */

import { createLogger } from '@markus/shared';
import { createAgent } from '@markus/core';
import { createGUITool } from '@markus/core/dist/tools/gui.js';

const log = createLogger('gui-workflow');

/**
 * 示例1：基本的GUI自动化工作流
 * 演示截图、分析和简单操作
 */
async function basicGUIAutomation() {
  log.info('开始基本GUI自动化工作流...');

  // 创建GUI工具
  const guiTool = createGUITool({
    containerId: 'gui-container',
    display: ':1',
    debug: true,
  });

  try {
    // 1. 获取屏幕信息
    log.info('获取屏幕信息...');
    const screenInfo = await guiTool.execute({
      action: 'get_screen_info',
    }, {} as any);
    log.info('屏幕信息:', screenInfo);

    // 2. 捕获屏幕截图
    log.info('捕获屏幕截图...');
    const screenshot = await guiTool.execute({
      action: 'capture_screenshot',
      returnBase64: false,
    }, {} as any);
    log.info('截图已保存到:', screenshot.path);

    // 3. 分析屏幕
    log.info('分析屏幕内容...');
    const analysis = await guiTool.execute({
      action: 'analyze_screen',
    }, {} as any);
    log.info(`找到 ${analysis.elements.length} 个GUI元素`);

    // 显示前5个元素
    analysis.elements.slice(0, 5).forEach((element, index) => {
      log.info(`元素 ${index + 1}: ${element.type} (${element.x}, ${element.y}) - ${element.text || element.label || '无标签'}`);
    });

    // 4. 查找特定元素（例如按钮）
    log.info('查找按钮元素...');
    const buttons = await guiTool.execute({
      action: 'find_element',
      query: 'button',
      elementType: 'button',
      maxResults: 3,
    }, {} as any);
    log.info(`找到 ${buttons.count} 个按钮`);

    // 5. 如果找到按钮，点击第一个
    if (buttons.elements.length > 0) {
      const firstButton = buttons.elements[0];
      log.info(`点击按钮: ${firstButton.label || firstButton.text || '未知按钮'} (${firstButton.x}, ${firstButton.y})`);
      
      const clickResult = await guiTool.execute({
        action: 'click',
        x: firstButton.x + firstButton.width / 2,
        y: firstButton.y + firstButton.height / 2,
      }, {} as any);
      log.info('点击结果:', clickResult);

      // 等待一下
      await new Promise(resolve => setTimeout(resolve, 1000));

      // 6. 输入文本
      log.info('输入文本...');
      const typeResult = await guiTool.execute({
        action: 'type_text',
        text: 'Hello from Markus GUI Automation!',
        delayMs: 50,
      }, {} as any);
      log.info('输入结果:', typeResult);
    }

    log.info('基本GUI自动化工作流完成！');
  } catch (error) {
    log.error('GUI自动化失败:', error);
  }
}

/**
 * 示例2：使用Agent进行GUI自动化
 * 演示如何将GUI工具集成到Agent中
 */
async function agentGUIAutomation() {
  log.info('开始Agent GUI自动化工作流...');

  try {
    // 创建带有GUI工具的Agent
    const agent = await createAgent({
      name: 'GUI Automation Agent',
      role: 'GUI自动化专家',
      instructions: `
        你是一个GUI自动化专家，负责操作桌面应用和网页界面。
        你可以使用GUI工具进行截图、分析、点击和输入操作。
        
        你的任务包括：
        1. 捕获屏幕截图并分析内容
        2. 查找特定的GUI元素（按钮、输入框、文本等）
        3. 执行鼠标和键盘操作
        4. 自动化重复的GUI任务
        
        请根据用户请求执行相应的GUI操作。
      `,
      tools: [
        createGUITool({
          containerId: 'gui-container',
          display: ':1',
          debug: true,
        }),
      ],
    });

    log.info('Agent已创建，开始执行GUI任务...');

    // 示例任务：打开应用并执行操作
    const tasks = [
      {
        description: '获取当前屏幕信息',
        prompt: '请获取当前屏幕的分辨率和状态信息',
      },
      {
        description: '捕获并分析屏幕',
        prompt: '请捕获屏幕截图并分析其中的GUI元素，告诉我找到了什么',
      },
      {
        description: '查找并点击按钮',
        prompt: '请查找屏幕上的按钮元素，如果有的话，点击第一个按钮',
      },
      {
        description: '输入文本',
        prompt: '请在当前焦点位置输入文本："Markus GUI Automation Test"',
      },
    ];

    for (const task of tasks) {
      log.info(`执行任务: ${task.description}`);
      const response = await agent.run(task.prompt);
      log.info(`Agent响应: ${response}`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    log.info('Agent GUI自动化工作流完成！');
  } catch (error) {
    log.error('Agent GUI自动化失败:', error);
  }
}

/**
 * 示例3：完整的GUI自动化场景
 * 模拟一个实际的自动化任务
 */
async function completeGUIScenario() {
  log.info('开始完整GUI自动化场景...');

  const guiTool = createGUITool({
    containerId: 'gui-container',
    display: ':1',
    debug: true,
  });

  try {
    // 场景：自动化网页表单填写
    log.info('场景：自动化网页表单填写');
    
    // 1. 初始截图
    log.info('1. 捕获初始屏幕...');
    const initialScreenshot = await guiTool.execute({
      action: 'capture_screenshot',
    }, {} as any);
    log.info('初始截图已保存');

    // 2. 分析表单元素
    log.info('2. 分析表单元素...');
    const formAnalysis = await guiTool.execute({
      action: 'analyze_screen',
    }, {} as any);

    // 查找输入框
    const inputFields = formAnalysis.elements.filter(el => 
      el.type.includes('input') || el.type.includes('text') || el.type.includes('field')
    );
    log.info(`找到 ${inputFields.length} 个输入字段`);

    // 3. 填写表单
    for (let i = 0; i < Math.min(inputFields.length, 3); i++) {
      const field = inputFields[i];
      const centerX = field.x + field.width / 2;
      const centerY = field.y + field.height / 2;

      log.info(`填写字段 ${i + 1}: ${field.label || field.text || '未知字段'}`);

      // 点击输入框
      await guiTool.execute({
        action: 'click',
        x: centerX,
        y: centerY,
      }, {} as any);

      // 输入文本
      await guiTool.execute({
        action: 'type_text',
        text: `Test Data ${i + 1}`,
        delayMs: 100,
      }, {} as any);

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // 4. 查找并点击提交按钮
    log.info('3. 查找提交按钮...');
    const buttons = await guiTool.execute({
      action: 'find_element',
      query: 'submit',
      elementType: 'button',
      maxResults: 5,
    }, {} as any);

    const submitButton = buttons.elements.find(btn => 
      btn.text?.toLowerCase().includes('submit') || 
      btn.label?.toLowerCase().includes('submit') ||
      btn.text?.toLowerCase().includes('提交')
    );

    if (submitButton) {
      log.info(`找到提交按钮: ${submitButton.text || submitButton.label}`);
      const btnCenterX = submitButton.x + submitButton.width / 2;
      const btnCenterY = submitButton.y + submitButton.height / 2;

      await guiTool.execute({
        action: 'click',
        x: btnCenterX,
        y: btnCenterY,
      }, {} as any);
      log.info('已点击提交按钮');
    } else {
      log.info('未找到提交按钮，尝试点击第一个按钮');
      if (buttons.elements.length > 0) {
        const firstBtn = buttons.elements[0];
        const btnCenterX = firstBtn.x + firstBtn.width / 2;
        const btnCenterY = firstBtn.y + firstBtn.height / 2;

        await guiTool.execute({
          action: 'click',
          x: btnCenterX,
          y: btnCenterY,
        }, {} as any);
      }
    }

    // 5. 最终截图
    log.info('4. 捕获最终屏幕...');
    const finalScreenshot = await guiTool.execute({
      action: 'capture_screenshot',
    }, {} as any);
    log.info('最终截图已保存');

    log.info('完整GUI自动化场景完成！');
    log.info(`初始截图: ${initialScreenshot.path}`);
    log.info(`最终截图: ${finalScreenshot.path}`);

  } catch (error) {
    log.error('完整GUI场景失败:', error);
  }
}

/**
 * 主函数
 */
async function main() {
  log.info('启动GUI自动化工作流示例...');

  try {
    // 运行示例
    await basicGUIAutomation();
    await new Promise(resolve => setTimeout(resolve, 2000));

    await agentGUIAutomation();
    await new Promise(resolve => setTimeout(resolve, 2000));

    await completeGUIScenario();

    log.info('所有GUI自动化示例完成！');
  } catch (error) {
    log.error('GUI自动化示例运行失败:', error);
    process.exit(1);
  }
}

// 运行主函数
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('未捕获的错误:', error);
    process.exit(1);
  });
}

export {
  basicGUIAutomation,
  agentGUIAutomation,
  completeGUIScenario,
};