#!/usr/bin/env node

/**
 * SSE流式响应测试脚本
 * 用于验证SSE流式响应的性能和功能
 */

const http = require('http');
const EventSource = require('eventsource');

// 测试配置
const TEST_CONFIG = {
  host: 'localhost',
  port: 3000,
  agentId: 'test-agent',
  message: '你好，请介绍一下你自己。这是一个测试消息，用于验证流式响应的性能和进度指示器功能。'
};

// 创建EventSource实例
function createEventSource(agentId, message, stream = true) {
  const url = `http://${TEST_CONFIG.host}:${TEST_CONFIG.port}/api/agents/${agentId}/message`;
  const params = new URLSearchParams({
    text: message,
    stream: stream.toString(),
    senderId: 'test-user'
  });
  
  return new EventSource(`${url}?${params.toString()}`);
}

// 运行SSE流式响应测试
async function runSSETest() {
  console.log('🚀 开始SSE流式响应测试...');
  console.log(`📡 连接到: http://${TEST_CONFIG.host}:${TEST_CONFIG.port}`);
  console.log(`🤖 测试Agent: ${TEST_CONFIG.agentId}`);
  console.log(`💬 测试消息: ${TEST_CONFIG.message.substring(0, 50)}...`);
  
  return new Promise((resolve, reject) => {
    const es = createEventSource(TEST_CONFIG.agentId, TEST_CONFIG.message);
    
    let receivedEvents = 0;
    let textContent = '';
    let progressUpdates = 0;
    let startTime = Date.now();
    
    es.onopen = () => {
      console.log('✅ SSE连接已建立');
      startTime = Date.now();
    };
    
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        receivedEvents++;
        
        switch (data.type) {
          case 'text_delta':
            textContent += data.text || '';
            process.stdout.write(data.text || '');
            break;
            
          case 'progress':
            progressUpdates++;
            console.log(`\n📊 进度更新: ${data.current}/${data.total} (${Math.round((data.current / data.total) * 100)}%) - ${data.message}`);
            break;
            
          case 'agent_tool':
            console.log(`\n🔧 工具事件: ${data.tool} - ${data.phase}`);
            break;
            
          case 'done':
            const elapsed = Date.now() - startTime;
            console.log(`\n\n✅ 测试完成!`);
            console.log(`📊 统计信息:`);
            console.log(`  总事件数: ${receivedEvents}`);
            console.log(`  进度更新次数: ${progressUpdates}`);
            console.log(`  总响应长度: ${textContent.length} 字符`);
            console.log(`  总耗时: ${elapsed}ms`);
            console.log(`  平均延迟: ${(elapsed / receivedEvents).toFixed(2)}ms/事件`);
            console.log(`  最终回复: ${data.content.substring(0, 100)}...`);
            
            es.close();
            resolve({
              success: true,
              events: receivedEvents,
              progressUpdates,
              textLength: textContent.length,
              elapsed,
              averageLatency: elapsed / receivedEvents
            });
            break;
            
          case 'error':
            console.log(`\n❌ 错误: ${data.message}`);
            es.close();
            reject(new Error(data.message));
            break;
            
          default:
            console.log(`\n📨 未知事件类型: ${data.type}`);
        }
      } catch (error) {
        console.error(`\n❌ 解析事件数据失败:`, error);
      }
    };
    
    es.onerror = (error) => {
      console.error(`\n❌ SSE连接错误:`, error);
      es.close();
      reject(error);
    };
    
    // 设置超时
    setTimeout(() => {
      console.log('\n⏰ 测试超时 (30秒)');
      es.close();
      reject(new Error('测试超时'));
    }, 30000);
  });
}

// 运行性能测试
async function runPerformanceTest() {
  console.log('\n🔬 开始性能测试...');
  
  const results = [];
  const testMessages = [
    '你好，请简单介绍一下你自己。',
    '请写一个关于人工智能的简短段落。',
    '解释一下什么是机器学习。',
    '请生成一个包含5个项目的待办事项列表。',
    '描述一下流式响应的优势。'
  ];
  
  for (let i = 0; i < testMessages.length; i++) {
    console.log(`\n📝 测试 ${i + 1}/${testMessages.length}: ${testMessages[i]}`);
    
    try {
      const result = await runSSETest();
      results.push(result);
      console.log(`✅ 测试 ${i + 1} 完成`);
    } catch (error) {
      console.error(`❌ 测试 ${i + 1} 失败:`, error.message);
    }
    
    // 等待一下再进行下一个测试
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  // 输出性能统计
  console.log('\n📈 性能测试结果汇总:');
  console.log('='.repeat(50));
  
  const totalEvents = results.reduce((sum, r) => sum + r.events, 0);
  const totalTime = results.reduce((sum, r) => sum + r.elapsed, 0);
  const avgLatency = results.reduce((sum, r) => sum + r.averageLatency, 0) / results.length;
  
  console.log(`总测试次数: ${results.length}`);
  console.log(`总事件数: ${totalEvents}`);
  console.log(`总耗时: ${totalTime}ms`);
  console.log(`平均延迟: ${avgLatency.toFixed(2)}ms/事件`);
  console.log(`平均进度更新次数: ${(results.reduce((sum, r) => sum + r.progressUpdates, 0) / results.length).toFixed(1)}`);
  
  return results;
}

// 主函数
async function main() {
  console.log('🎯 SSE流式响应增强测试');
  console.log('='.repeat(50));
  
  try {
    // 检查服务是否运行
    const healthCheck = await new Promise((resolve) => {
      const req = http.get(`http://${TEST_CONFIG.host}:${TEST_CONFIG.port}/health`, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => resolve(false));
    });
    
    if (!healthCheck) {
      console.log('⚠️  服务未运行，请先启动服务:');
      console.log('   cd packages/org-manager && npm run dev');
      process.exit(1);
    }
    
    // 运行单个测试
    await runSSETest();
    
    // 运行性能测试
    // await runPerformanceTest();
    
    console.log('\n🎉 所有测试完成!');
    
  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    process.exit(1);
  }
}

// 运行主函数
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { runSSETest, runPerformanceTest };