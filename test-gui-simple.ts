#!/usr/bin/env node

/**
 * 简单GUI技能测试
 */

console.log('=== 测试GUI技能创建 ===');

// 直接导入构建后的文件
import { createAdvancedGUISkill } from './packages/core/dist/skills/builtin/advanced-gui-skill.js';

async function test() {
  try {
    console.log('1. 创建GUI技能...');
    const skill = await createAdvancedGUISkill();
    
    console.log('✅ GUI技能创建成功');
    console.log(`技能名称: ${skill.manifest.name}`);
    console.log(`技能描述: ${skill.manifest.description}`);
    console.log(`技能版本: ${skill.manifest.version}`);
    console.log(`工具数量: ${skill.tools.length}`);
    
    console.log('\n2. 列出可用工具:');
    skill.tools.forEach((tool, i) => {
      console.log(`  ${i+1}. ${tool.name} - ${tool.description}`);
    });
    
    console.log('\n3. 测试工具参数:');
    if (skill.tools.length > 0) {
      const tool = skill.tools[0];
      console.log(`工具: ${tool.name}`);
      console.log('参数模式:', tool.inputSchema);
    }
    
    console.log('\n✅ 测试完成 - GUI技能已成功集成到系统中');
    return true;
  } catch (error) {
    console.error('❌ 测试失败:', error);
    return false;
  }
}

// 运行测试
test().then(success => {
  process.exit(success ? 0 : 1);
});