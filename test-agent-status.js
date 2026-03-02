import { Agent } from './packages/core/dist/index.js';

async function testAgentStatus() {
  console.log('=== 测试Agent状态管理 ===');
  
  // 创建Agent
  const agent = new Agent({
    id: 'test-agent',
    name: 'Test Agent',
    role: 'Tester',
    description: 'Test agent for status management',
    model: 'gpt-4',
    tools: [],
  });

  // 启动Agent
  await agent.start();
  
  console.log('1. Agent初始状态:', agent.getState().status);
  
  // 模拟任务执行
  console.log('\n2. 模拟任务执行...');
  agent.setStatus('working');
  console.log('   Agent状态:', agent.getState().status);
  
  // 模拟任务完成
  console.log('\n3. 模拟任务完成...');
  agent.setStatus('idle');
  console.log('   Agent状态:', agent.getState().status);
  
  // 测试并发任务状态
  console.log('\n4. 测试并发任务状态...');
  
  // 模拟多个任务
  agent.setStatus('working');
  console.log('   开始任务1，Agent状态:', agent.getState().status);
  
  // 模拟任务完成
  agent.setStatus('idle');
  console.log('   所有任务完成，Agent状态:', agent.getState().status);
  
  console.log('\n=== 测试完成 ===');
}

testAgentStatus().catch(console.error);