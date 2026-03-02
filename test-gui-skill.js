import { createDefaultSkillRegistry } from './packages/core/dist/skills/index.js';

async function testGUISkill() {
  console.log('Testing GUI skill registration...');
  
  const registry = await createDefaultSkillRegistry();
  const skills = registry.list();
  
  console.log('Registered skills:', skills.map(s => s.name));
  
  const guiSkill = registry.get('gui');
  if (guiSkill) {
    console.log('✓ GUI skill found');
    console.log('GUI skill manifest:', {
      name: guiSkill.manifest.name,
      version: guiSkill.manifest.version,
      description: guiSkill.manifest.description,
      tools: guiSkill.tools.map(t => t.name),
    });
    
    // Test one of the tools
    const screenshotTool = guiSkill.tools.find(t => t.name === 'gui_screenshot');
    if (screenshotTool) {
      console.log('\nTesting screenshot tool...');
      try {
        const result = await screenshotTool.execute({});
        console.log('Screenshot tool result:', JSON.parse(result));
      } catch (error) {
        console.log('Screenshot tool error (expected):', error.message);
      }
    }
    
    // Test click tool
    const clickTool = guiSkill.tools.find(t => t.name === 'gui_click');
    if (clickTool) {
      console.log('\nTesting click tool...');
      try {
        const result = await clickTool.execute({ x: 100, y: 200 });
        console.log('Click tool result:', JSON.parse(result));
      } catch (error) {
        console.log('Click tool error (expected):', error.message);
      }
    }
  } else {
    console.log('✗ GUI skill not found');
  }
}

testGUISkill().catch(console.error);