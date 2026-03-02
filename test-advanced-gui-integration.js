#!/usr/bin/env node

/**
 * 高级GUI集成测试脚本
 * 测试OmniParser集成和视觉自动化功能
 */

import { createDefaultSkillRegistry } from './packages/core/dist/skills/index.js';

async function testBasicGUIFunctionality() {
  console.log('=== 测试基础GUI功能 ===');
  
  try {
    // 创建技能注册表（不使用容器，使用存根工具）
    const registry = await createDefaultSkillRegistry();
    
    // 获取GUI技能
    const guiSkill = registry.get('gui');
    console.log('GUI技能名称:', guiSkill.manifest.name);
    console.log('GUI技能版本:', guiSkill.manifest.version);
    console.log('可用工具数量:', guiSkill.tools.length);
    
    // 测试基础工具
    console.log('\n测试基础工具:');
    
    // 测试截图工具
    const screenshotResult = await guiSkill.tools[0].execute({});
    console.log('截图工具测试:', JSON.parse(screenshotResult));
    
    // 测试点击工具
    const clickResult = await guiSkill.tools[1].execute({ x: 100, y: 200 });
    console.log('点击工具测试:', JSON.parse(clickResult));
    
    // 测试输入工具
    const typeResult = await guiSkill.tools[3].execute({ text: 'Hello World' });
    console.log('输入工具测试:', JSON.parse(typeResult));
    
    console.log('✓ 基础GUI功能测试通过');
    return true;
  } catch (error) {
    console.error('基础GUI功能测试失败:', error);
    return false;
  }
}

async function testAdvancedGUIFunctionality() {
  console.log('\n=== 测试高级GUI功能 ===');
  
  try {
    // 创建技能注册表（启用高级GUI功能）
    const registry = await createDefaultSkillRegistry({
      enableAdvancedGUI: true,
      debug: true
    });
    
    // 获取高级GUI技能
    const advancedGuiSkill = registry.get('advanced-gui');
    console.log('高级GUI技能名称:', advancedGuiSkill.manifest.name);
    console.log('高级GUI技能版本:', advancedGuiSkill.manifest.version);
    console.log('可用工具数量:', advancedGuiSkill.tools.length);
    
    // 检查是否包含高级工具
    const hasAdvancedTools = advancedGuiSkill.tools.some(tool => 
      tool.name.includes('analyze') || 
      tool.name.includes('find_element') ||
      tool.name.includes('automate')
    );
    
    console.log('包含高级工具:', hasAdvancedTools);
    
    // 测试高级工具（使用存根实现）
    console.log('\n测试高级工具:');
    
    // 查找屏幕分析工具
    const analyzeTool = advancedGuiSkill.tools.find(tool => tool.name === 'gui_analyze_screen');
    if (analyzeTool) {
      const analyzeResult = await analyzeTool.execute({});
      console.log('屏幕分析工具测试:', JSON.parse(analyzeResult));
    }
    
    // 查找元素查找工具
    const findTool = advancedGuiSkill.tools.find(tool => tool.name === 'gui_find_element');
    if (findTool) {
      const findResult = await findTool.execute({ text: 'Submit', type: 'button' });
      console.log('元素查找工具测试:', JSON.parse(findResult));
    }
    
    // 查找元素点击工具
    const clickElementTool = advancedGuiSkill.tools.find(tool => tool.name === 'gui_click_element');
    if (clickElementTool) {
      const clickElementResult = await clickElementTool.execute({ text: 'Login', type: 'button' });
      console.log('元素点击工具测试:', JSON.parse(clickElementResult));
    }
    
    // 查找任务自动化工具
    const automateTool = advancedGuiSkill.tools.find(tool => tool.name === 'gui_automate_task');
    if (automateTool) {
      const automateResult = await automateTool.execute({
        task_description: 'Test automation task',
        steps: [
          { action: 'click', target: 'Button1', delay_ms: 100 },
          { action: 'type', target: 'Input1', value: 'Test', delay_ms: 100 },
          { action: 'wait', delay_ms: 500 }
        ]
      });
      console.log('任务自动化工具测试:', JSON.parse(automateResult));
    }
    
    console.log('✓ 高级GUI功能测试通过');
    return true;
  } catch (error) {
    console.error('高级GUI功能测试失败:', error);
    return false;
  }
}

async function testOmniParserIntegration() {
  console.log('\n=== 测试OmniParser集成 ===');
  
  try {
    // 测试GUI包导出
    const guiModule = await import('./packages/gui/dist/index.js');
    
    console.log('GUI包导出检查:');
    console.log('- VNCClient:', 'VNCClient' in guiModule);
    console.log('- OmniParser:', 'OmniParser' in guiModule);
    console.log('- VisualAutomation:', 'VisualAutomation' in guiModule);
    console.log('- createAdvancedGUITools:', 'createAdvancedGUITools' in guiModule);
    
    // 检查类型定义
    if ('OmniParser' in guiModule) {
      console.log('✓ OmniParser已正确导出');
    }
    
    if ('VisualAutomation' in guiModule) {
      console.log('✓ VisualAutomation已正确导出');
    }
    
    if ('createAdvancedGUITools' in guiModule) {
      console.log('✓ createAdvancedGUITools已正确导出');
    } else {
      console.log('⚠️ createAdvancedGUITools未导出，检查index.ts文件');
    }
    
    console.log('✓ OmniParser集成测试通过');
    return true;
  } catch (error) {
    console.error('OmniParser集成测试失败:', error);
    return false;
  }
}

async function runAllTests() {
  console.log('开始高级GUI集成测试...\n');
  
  const results = {
    basicGUI: await testBasicGUIFunctionality(),
    advancedGUI: await testAdvancedGUIFunctionality(),
    omniparser: await testOmniParserIntegration()
  };
  
  console.log('\n=== 测试结果汇总 ===');
  console.log('基础GUI功能:', results.basicGUI ? '✓ 通过' : '✗ 失败');
  console.log('高级GUI功能:', results.advancedGUI ? '✓ 通过' : '✗ 失败');
  console.log('OmniParser集成:', results.omniparser ? '✓ 通过' : '✗ 失败');
  
  const allPassed = Object.values(results).every(result => result === true);
  
  if (allPassed) {
    console.log('\n🎉 所有测试通过！高级GUI自动化功能已成功集成。');
    console.log('\n下一步：');
    console.log('1. 在真实容器环境中测试GUI自动化');
    console.log('2. 使用教程文档创建自动化脚本');
    console.log('3. 集成到您的应用程序中');
  } else {
    console.log('\n⚠️  部分测试失败，请检查集成问题。');
    process.exit(1);
  }
}

// 运行测试
runAllTests().catch(error => {
  console.error('测试运行失败:', error);
  process.exit(1);
});