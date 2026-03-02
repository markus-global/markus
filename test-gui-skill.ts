import { createAdvancedGUISkill } from './packages/core/src/skills/builtin/advanced-gui-skill.js';
import { createLogger } from '@markus/shared';

const log = createLogger('test-gui-skill');

async function testGUISkill() {
  log.info('Testing GUI skill creation...');
  
  try {
    // Create GUI skill without container info (should use stub tools)
    const guiSkill = await createAdvancedGUISkill();
    
    log.info('GUI skill created successfully');
    log.info('Skill name:', guiSkill.name);
    log.info('Skill description:', guiSkill.description);
    log.info('Number of tools:', guiSkill.tools.length);
    
    // List available tools
    guiSkill.tools.forEach((tool, index) => {
      log.info(`Tool ${index + 1}: ${tool.name} - ${tool.description}`);
    });
    
    // Test a simple tool execution
    if (guiSkill.tools.length > 0) {
      const firstTool = guiSkill.tools[0];
      log.info(`Testing tool: ${firstTool.name}`);
      
      // Create a mock context
      const mockContext = {
        agentId: 'test-agent',
        agentName: 'Test Agent',
        screenshotDir: '/tmp/screenshots',
        containerId: 'test-container'
      };
      
      try {
        const result = await firstTool.execute({}, mockContext);
        log.info('Tool execution result:', result);
      } catch (error) {
        log.error('Tool execution failed:', { error });
      }
    }
    
    return true;
  } catch (error) {
    log.error('Failed to create GUI skill:', { error });
    return false;
  }
}

// Run test
testGUISkill().then(success => {
  if (success) {
    log.info('✅ GUI skill test passed!');
    process.exit(0);
  } else {
    log.error('❌ GUI skill test failed!');
    process.exit(1);
  }
}).catch(error => {
  log.error('❌ GUI skill test crashed:', { error });
  process.exit(1);
});