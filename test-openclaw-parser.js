import { OpenClawConfigParser } from './packages/core/src/openclaw-config-parser.js';
import { EnhancedRoleLoader } from './packages/core/src/enhanced-role-loader.js';
import { readFileSync } from 'fs';

async function testParser() {
  console.log('=== Testing OpenClaw Configuration Parser ===\n');
  
  // Test 1: Parse OpenClaw configuration
  const parser = new OpenClawConfigParser();
  const openclawConfig = readFileSync('templates/roles/openclaw-developer/openclaw.md', 'utf-8');
  
  console.log('1. Parsing OpenClaw configuration...');
  const role = parser.parse(openclawConfig);
  
  console.log(`   Role Name: ${role.name}`);
  console.log(`   Description: ${role.description}`);
  console.log(`   Category: ${role.category}`);
  console.log(`   Skills: ${role.defaultSkills.length}`);
  role.defaultSkills.forEach((skill, i) => console.log(`     ${i+1}. ${skill}`));
  console.log(`   Heartbeat Tasks: ${role.defaultHeartbeatTasks.length}`);
  role.defaultHeartbeatTasks.forEach((task, i) => console.log(`     ${i+1}. ${task.name}: ${task.description}`));
  console.log(`   Policies: ${role.defaultPolicies.length}`);
  role.defaultPolicies.forEach((policy, i) => console.log(`     ${i+1}. ${policy.name}: ${policy.rules.length} rules`));
  
  // Test 2: Enhanced Role Loader
  console.log('\n2. Testing Enhanced Role Loader...');
  const loader = new EnhancedRoleLoader();
  
  // List available roles
  const roles = loader.listAvailableRoles();
  console.log('   Available roles:');
  roles.forEach((r, i) => console.log(`     ${i+1}. ${r.name} (${r.format})`));
  
  // Load OpenClaw role
  console.log('\n   Loading OpenClaw role...');
  try {
    const openclawRole = loader.loadRole('openclaw-developer');
    console.log(`     Loaded: ${openclawRole.name} (${openclawRole.sourceFormat})`);
    console.log(`     Source: ${openclawRole.sourcePath}`);
  } catch (error) {
    console.log(`     Error: ${error.message}`);
  }
  
  // Load Markus role
  console.log('\n   Loading Markus role...');
  try {
    const markusRole = loader.loadRole('developer');
    console.log(`     Loaded: ${markusRole.name} (${markusRole.sourceFormat})`);
    console.log(`     Source: ${markusRole.sourcePath}`);
  } catch (error) {
    console.log(`     Error: ${error.message}`);
  }
  
  // Test 3: Export to OpenClaw format
  console.log('\n3. Exporting to OpenClaw format...');
  const openclawFormat = parser.toOpenClawFormat(role);
  console.log(`   Generated ${openclawFormat.length} characters`);
  console.log('   First 200 chars:', openclawFormat.substring(0, 200) + '...');
  
  // Test 4: Format detection
  console.log('\n4. Testing format detection...');
  console.log(`   Is OpenClaw format? ${parser.isOpenClawFormat(openclawConfig)}`);
  
  const markusConfig = readFileSync('templates/roles/developer/ROLE.md', 'utf-8');
  console.log(`   Is Markus format OpenClaw? ${parser.isOpenClawFormat(markusConfig)}`);
  
  console.log('\n=== Test Complete ===');
}

testParser().catch(console.error);