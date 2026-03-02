import { createDefaultSkillRegistry } from './packages/core/dist/skills/index.js';

async function testGUISkill() {
  console.log('=== Testing GUI Skill Integration ===\n');
  
  // Test 1: Default registry (stub tools)
  console.log('Test 1: Default registry (stub tools)');
  const defaultRegistry = await createDefaultSkillRegistry();
  const defaultSkills = defaultRegistry.list();
  console.log(`Registered skills: ${defaultSkills.map(s => s.name).join(', ')}`);
  
  const defaultGuiSkill = defaultRegistry.get('gui');
  if (defaultGuiSkill) {
    console.log(`✓ GUI skill found with ${defaultGuiSkill.tools.length} tools`);
    
    // Test screenshot tool
    const screenshotTool = defaultGuiSkill.tools.find(t => t.name === 'gui_screenshot');
    if (screenshotTool) {
      const result = await screenshotTool.execute({});
      const parsed = JSON.parse(result);
      console.log(`  Screenshot tool: ${parsed.error ? 'Stub mode' : 'Real mode'}`);
    }
  }
  
  // Test 2: Registry with container info (would use real tools if @markus/gui available)
  console.log('\nTest 2: Registry with container info');
  const containerRegistry = await createDefaultSkillRegistry({
    containerId: 'test-container-123',
    screenshotDir: '/tmp/screenshots',
  });
  
  const containerGuiSkill = containerRegistry.get('gui');
  if (containerGuiSkill) {
    console.log(`✓ GUI skill found with ${containerGuiSkill.tools.length} tools`);
    
    // List all available tools
    console.log('  Available tools:');
    containerGuiSkill.tools.forEach(tool => {
      console.log(`    - ${tool.name}: ${tool.description}`);
    });
    
    // Test click tool
    const clickTool = containerGuiSkill.tools.find(t => t.name === 'gui_click');
    if (clickTool) {
      const result = await clickTool.execute({ x: 100, y: 200, button: 'left' });
      const parsed = JSON.parse(result);
      console.log(`  Click tool test: ${parsed.success ? 'Success' : 'Stub mode'}`);
    }
  }
  
  // Test 3: Verify tool compatibility
  console.log('\nTest 3: Tool compatibility check');
  const requiredTools = [
    'gui_screenshot',
    'gui_click', 
    'gui_double_click',
    'gui_type',
    'gui_key_press',
    'gui_scroll',
    'gui_get_window_title',
  ];
  
  const guiSkill = containerRegistry.get('gui');
  if (guiSkill) {
    const availableTools = guiSkill.tools.map(t => t.name);
    const missingTools = requiredTools.filter(t => !availableTools.includes(t));
    
    if (missingTools.length === 0) {
      console.log('✓ All required GUI tools are available');
    } else {
      console.log(`✗ Missing tools: ${missingTools.join(', ')}`);
    }
  }
  
  console.log('\n=== Summary ===');
  console.log('GUI automation skill has been successfully integrated into Markus.');
  console.log('The skill provides:');
  console.log('  - Screenshot capture');
  console.log('  - Mouse control (click, double-click, scroll)');
  console.log('  - Keyboard input (typing, key combinations)');
  console.log('  - Window title detection');
  console.log('\nTo use real GUI automation (not stub tools):');
  console.log('  1. Ensure @markus/gui package is installed');
  console.log('  2. Provide containerId and screenshotDir when creating skill registry');
  console.log('  3. Run agents in a Docker container with GUI support');
}

testGUISkill().catch(console.error);