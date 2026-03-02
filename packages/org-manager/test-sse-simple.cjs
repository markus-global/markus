#!/usr/bin/env node

/**
 * SSE流式响应简单测试
 * 使用原生HTTP客户端测试SSE流式响应
 */

const http = require('http');

// 测试配置
const TEST_CONFIG = {
  host: 'localhost',
  port: 3000,
  agentId: 'test-agent',
  message: '你好，请介绍一下你自己。这是一个测试消息，用于验证流式响应的性能和进度指示器功能。'
};

// 使用原生HTTP客户端测试SSE
function testSSEWithHTTP() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: TEST_CONFIG.host,
      port: TEST_CONFIG.port,
      path: `/api/agents/${TEST_CONFIG.agentId}/message?text=${encodeURIComponent(TEST_CONFIG.message)}&stream=true&senderId=test-user`,
      method: 'POST',
      headers: {
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      }
    };
    
    console.log(`🚀 发送SSE请求到: ${options.path}`);
    
    const req = http.request(options, (res) => {
      console.log(`📡 响应状态码: ${res.statusCode}`);
      console.log(`📡 响应头:`, res.headers);
      
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      
      let buffer = '';
      let receivedEvents = 0;
      let textContent = '';
      let progressUpdates = 0;
      let startTime = Date.now();
      
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        
        // 处理SSE事件
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // 保留未完成的行
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.substring(6));
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
                  reject(new Error(data.message));
                  break;
              }
            } catch (error) {
              console.error(`❌ 解析事件失败:`, error.message);
            }
          }
        }
      });
      
      res.on('end', () => {
        console.log('\n📭 响应结束');
        if (!textContent) {
          reject(new Error('没有收到任何响应内容'));
        }
      });
      
      res.on('error', (error) => {
        console.error(`❌ 响应错误:`, error.message);
        reject(error);
      });
    });
    
    req.on('error', (error) => {
      console.error(`❌ 请求错误:`, error.message);
      reject(error);
    });
    
    req.setTimeout(30000, () => {
      console.log('\n⏰ 请求超时 (30秒)');
      req.destroy();
      reject(new Error('请求超时'));
    });
    
    req.end();
  });
}

// 测试非流式响应作为对比
function testNonStreaming() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: TEST_CONFIG.host,
      port: TEST_CONFIG.port,
      path: `/api/agents/${TEST_CONFIG.agentId}/message`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk.toString();
      });
      
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          console.log(`✅ 非流式响应完成`);
          console.log(`📊 响应长度: ${result.reply?.length || 0} 字符`);
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
    });
    
    req.on('error', reject);
    
    req.write(JSON.stringify({
      text: TEST_CONFIG.message,
      stream: false,
      senderId: 'test-user'
    }));
    
    req.end();
  });
}

// 主函数
async function main() {
  console.log('🎯 SSE流式响应增强测试');
  console.log('='.repeat(50));
  
  try {
    // 检查服务健康状态
    const healthCheck = await new Promise((resolve) => {
      const req = http.get(`http://${TEST_CONFIG.host}:${TEST_CONFIG.port}/api/health`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            console.log(`✅ 服务健康检查: ${result.status}`);
            console.log(`📊 版本: ${result.version}, 活跃Agent: ${result.agents}`);
            resolve(true);
          } catch {
            resolve(false);
          }
        });
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => resolve(false));
    });
    
    if (!healthCheck) {
      console.log('❌ 服务不可用');
      process.exit(1);
    }
    
    console.log('\n1️⃣ 测试非流式响应（作为对比）');
    console.log('-'.repeat(40));
    const nonStreamResult = await testNonStreaming();
    
    console.log('\n\n2️⃣ 测试SSE流式响应');
    console.log('-'.repeat(40));
    const sseResult = await testSSEWithHTTP();
    
    console.log('\n\n📈 测试结果对比:');
    console.log('='.repeat(50));
    console.log(`非流式响应: ${nonStreamResult.reply?.length || 0} 字符`);
    console.log(`流式响应: ${sseResult.textLength} 字符`);
    console.log(`流式响应事件数: ${sseResult.events}`);
    console.log(`流式响应进度更新: ${sseResult.progressUpdates}`);
    console.log(`流式响应耗时: ${sseResult.elapsed}ms`);
    
    console.log('\n🎉 测试完成!');
    
  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    process.exit(1);
  }
}

// 运行主函数
if (require.main === module) {
  main().catch(console.error);
}