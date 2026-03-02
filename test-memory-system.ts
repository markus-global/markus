import { EnhancedMemorySystem } from './packages/core/src/enhanced-memory-system';

// Test the current memory system
async function testMemorySystem() {
  console.log('Testing EnhancedMemorySystem...');
  
  // Create enhanced memory system
  const memory = new EnhancedMemorySystem('./test-data');
  
  // Test adding knowledge
  console.log('Adding knowledge entry...');
  memory.addKnowledge({
    id: 'test-1',
    category: 'test',
    title: 'Test Knowledge',
    content: 'This is a test knowledge entry',
    tags: ['test', 'memory'],
    source: 'test',
    metadata: { test: true }
  });
  
  // Test searching knowledge
  console.log('Searching knowledge...');
  const results = memory.searchKnowledge({ text: 'test' });
  console.log('Search results:', results.length);
  
  // Test memory summary
  console.log('Getting memory summary...');
  const summary = memory.getMemorySummary();
  console.log('Summary:', {
    totalEntries: summary.totalEntries,
    knowledgeBaseSize: summary.knowledgeBaseSize
  });
  
  // Test agent context
  console.log('Getting agent context...');
  const context = memory.getAgentContext('test-agent', 'test query');
  console.log('Context length:', context.length);
  
  console.log('Test completed!');
}

testMemorySystem().catch(console.error);