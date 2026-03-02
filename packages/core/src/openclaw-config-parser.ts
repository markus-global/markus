import { generateId, type RoleTemplate, type HeartbeatTask, type Policy, type RoleCategory } from '@markus/shared';

export interface OpenClawRoleConfig {
  memoryConfig?: {
    shortTerm?: number;
    mediumTerm?: number;
    longTerm?: number;
    knowledgeBase?: boolean;
    contextWindow?: number;
  };
  heartbeatTasks?: Array<{
    name: string;
    description: string;
    schedule: string;
  }>;
  knowledgeBase?: string[];
  externalAgentId?: string;
}

/**
 * OpenClaw configuration parser that can parse OpenClaw-style markdown configurations
 * into Markus RoleTemplate objects.
 * 
 * OpenClaw configuration format typically includes:
 * - Identity & Role definition
 * - Capabilities & Tools specification
 * - Memory configuration
 * - Heartbeat tasks
 * - Communication preferences
 * - Knowledge base references
 */
export class OpenClawConfigParser {
  /**
   * Parse an OpenClaw-style markdown configuration into a Markus RoleTemplate
   */
  parse(markdown: string): RoleTemplate {
    const { roleTemplate } = this.parseFullConfig(markdown);
    return roleTemplate;
  }

  /**
   * Parse an OpenClaw-style markdown configuration and return both RoleTemplate and OpenClawRoleConfig
   */
  parseFullConfig(markdown: string): { roleTemplate: RoleTemplate; openClawConfig: OpenClawRoleConfig } {
    try {
      // Validate input
      if (!markdown || typeof markdown !== 'string') {
        throw new Error('Invalid markdown input: must be a non-empty string');
      }
      
      if (!markdown.includes('#')) {
        throw new Error('Invalid OpenClaw configuration: must contain at least one heading');
      }
      
      // Extract basic information
      const name = this.extractNameFromOpenClaw(markdown);
      const description = this.extractDescription(markdown);
      const category = this.inferCategory(markdown);
      
      // Parse OpenClaw-specific sections
      const capabilities = this.parseCapabilities(markdown);
      const memoryConfig = this.parseMemoryConfig(markdown);
      const heartbeatTasks = this.parseHeartbeatTasks(markdown);
      const policies = this.parsePolicies(markdown);
      const knowledgeBase = this.parseKnowledgeBase(markdown);
      
      // Build system prompt combining all sections
      const systemPrompt = this.buildSystemPrompt(
        markdown,
        capabilities,
        memoryConfig,
        heartbeatTasks,
        knowledgeBase
      );
      
      // Extract skills from capabilities
      const skills = this.extractSkills(capabilities);
      
      // Validate required fields
      if (!name.trim()) {
        throw new Error('Failed to extract agent name from configuration');
      }
      
      if (!systemPrompt.trim()) {
        throw new Error('Failed to generate system prompt from configuration');
      }
      
      const roleTemplate: RoleTemplate = {
        id: generateId('role'),
        name,
        description,
        category,
        systemPrompt,
        defaultSkills: skills,
        defaultHeartbeatTasks: heartbeatTasks,
        defaultPolicies: policies,
        builtIn: false, // Mark as external/OpenClaw configuration
      };

      const openClawConfig: OpenClawRoleConfig = {
        memoryConfig: memoryConfig as OpenClawRoleConfig['memoryConfig'],
        heartbeatTasks: heartbeatTasks.map(task => ({
          name: task.name,
          description: task.description,
          schedule: task.cronExpression || '*/5 * * * *' // Default schedule if not specified
        })),
        knowledgeBase,
        externalAgentId: undefined // To be set when integrating external agents
      };
      
      return {
        roleTemplate,
        openClawConfig
      };
    } catch (error) {
      // Re-throw with context
      if (error instanceof Error) {
        throw new Error(`Failed to parse OpenClaw configuration: ${error.message}`);
      }
      throw new Error('Failed to parse OpenClaw configuration: Unknown error');
    }
  }
  
  /**
   * Extract title from markdown (first # heading)
   */
  private extractTitle(md: string): string {
    const match = md.match(/^#\s+(.+)$/m);
    return match?.[1]?.trim() ?? '';
  }

  /**
   * Extract name from OpenClaw format (looks for **Name:** field)
   */
  private extractNameFromOpenClaw(md: string): string {
    // Look for **Name:** field in the Identity section
    const identitySection = this.extractSection(md, ['# Identity', '## Identity']);
    if (identitySection) {
      const nameMatch = identitySection.match(/\*\*Name:\*\*\s*(.+)/i);
      if (nameMatch?.[1]) {
        return nameMatch[1].trim();
      }
    }
    
    // Fall back to title extraction
    return this.extractTitle(md) || 'OpenClaw Agent';
  }
  
  /**
   * Extract description (first paragraph after title)
   */
  private extractDescription(md: string): string {
    const lines = md.split('\n');
    let inDescription = false;
    const descriptionLines: string[] = [];
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      // Skip empty lines at start
      if (!inDescription && !trimmed) continue;
      
      // Stop at next heading or list
      if (trimmed.startsWith('#') && inDescription) break;
      if (trimmed.startsWith('-') || trimmed.startsWith('*')) break;
      
      // Start collecting after title
      if (trimmed && !trimmed.startsWith('#') && !inDescription) {
        inDescription = true;
      }
      
      if (inDescription && trimmed) {
        descriptionLines.push(trimmed);
      }
    }
    
    return descriptionLines.join(' ').slice(0, 200); // Limit description length
  }
  
  /**
   * Infer category from content
   */
  private inferCategory(md: string): RoleCategory {
    const lower = md.toLowerCase();
    if (lower.includes('develop') || lower.includes('engineer') || lower.includes('code') || lower.includes('design')) return 'engineering';
    if (lower.includes('product') || lower.includes('pm')) return 'product';
    if (lower.includes('operation') || lower.includes('ops') || lower.includes('manager')) return 'operations';
    if (lower.includes('market') || lower.includes('sales')) return 'marketing';
    if (lower.includes('customer') || lower.includes('support') || lower.includes('service')) return 'customer_service';
    if (lower.includes('financ') || lower.includes('account')) return 'finance';
    if (lower.includes('legal') || lower.includes('compliance')) return 'legal';
    return 'custom';
  }
  
  /**
   * Parse capabilities section from OpenClaw config
   * Format: ## Capabilities / ## Skills / ## Tools
   */
  private parseCapabilities(md: string): string[] {
    const capabilities: string[] = [];
    
    // Extract from each section type independently (not just the first match)
    for (const header of ['## Capabilities', '## Skills', '## Tools']) {
      const section = this.extractSection(md, [header]);
      if (section) {
        const items = section
          .split('\n')
          .map(line => line.replace(/^[-*]\s*/, '').trim())
          .filter(line => line && !line.startsWith('#'));
        capabilities.push(...items);
      }
    }
    
    // Also check for skills listed in Identity section
    const identitySection = this.extractSection(md, ['## Identity']);
    if (identitySection) {
      const lines = identitySection.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.toLowerCase().includes('skills:')) {
          const match = trimmed.match(/skills:\s*(.+)$/i);
          if (match) {
            const skillsStr = match[1].trim();
            const skills = skillsStr.split(/[,;]|\s+and\s+/)
              .map(s => s.trim())
              .filter(s => s);
            capabilities.push(...skills);
          }
        }
      }
    }
    
    return capabilities;
  }
  
  /**
   * Parse memory configuration section
   * Format: ## Memory / ## Knowledge / ## Context
   */
  private parseMemoryConfig(md: string): Record<string, unknown> {
    const sections = this.extractSection(md, ['## Memory', '## Knowledge', '## Context']);
    if (!sections) return {};
    
    const config: Record<string, unknown> = {};
    const lines = sections.split('\n');
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      
      // Strip bullet points if present
      const cleanLine = trimmed.replace(/^[-*]\s*/, '');
      
      // Parse key-value pairs like "short-term: 1000 tokens"
      const match = cleanLine.match(/^([^:]+):\s*(.+)$/);
      if (match) {
        const key = match[1].trim().toLowerCase();
        const value = match[2].trim();
        
        // Convert hyphenated keys to camelCase for OpenClawMemoryConfig
        const camelCaseKey = key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        config[camelCaseKey] = this.parseValue(value);
      }
    }
    
    return config;
  }
  
  /**
   * Parse heartbeat tasks section
   * Format: ## Heartbeat / ## Periodic Tasks / ## Scheduled Tasks
   */
  private parseHeartbeatTasks(md: string): HeartbeatTask[] {
    const sections = this.extractSection(md, ['## Heartbeat', '## Heartbeat Tasks', '## Periodic Tasks', '## Scheduled Tasks']);
    if (!sections) return [];
    
    const tasks: HeartbeatTask[] = [];
    const lines = sections.split('\n');
    let currentTask: Partial<HeartbeatTask> = {};
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      // Task name (starts with ### or bullet point)
      if (trimmed.startsWith('###') || trimmed.match(/^[-*]\s+\S/)) {
        // Save previous task if exists
        if (currentTask.name && currentTask.description) {
          tasks.push({
            name: currentTask.name,
            description: currentTask.description,
            enabled: true,
            ...(currentTask.cronExpression && { cronExpression: currentTask.cronExpression }),
            ...(currentTask.intervalMs && { intervalMs: currentTask.intervalMs }),
          });
        }
        
        // Start new task
        currentTask = {};
        
        // Extract task name
        let taskName = trimmed;
        if (trimmed.startsWith('###')) {
          taskName = trimmed.replace(/^###\s*/, '');
          currentTask.name = taskName.trim();
        } else {
          // Remove bullet point
          taskName = trimmed.replace(/^[-*]\s*/, '');
          
          // Check if there's a colon separating name and description
          const colonMatch = taskName.match(/^([^:]+):\s*(.+)$/);
          if (colonMatch) {
            currentTask.name = colonMatch[1].trim();
            currentTask.description = colonMatch[2].trim();
          } else {
            // No colon, use entire line as name and description
            currentTask.name = taskName.trim();
            currentTask.description = taskName.trim();
          }
        }
      }
      // Task description continuation
      else if (trimmed && currentTask.name && !trimmed.startsWith('#')) {
        // Check for schedule information
        const scheduleMatch = trimmed.match(/\*\*Schedule:\*\*\s*(.+)/i);
        if (scheduleMatch) {
          const scheduleText = scheduleMatch[1].trim();
          
          // Parse cron expression
          const cronMatch = scheduleText.match(/cron expression:\s*([^\s]+)/i);
          if (cronMatch) {
            currentTask.cronExpression = cronMatch[1];
          }
          
          // Parse interval in seconds
          const intervalMatch = scheduleText.match(/every\s+(\d+)\s+seconds?/i);
          if (intervalMatch) {
            currentTask.intervalMs = parseInt(intervalMatch[1]) * 1000;
          }
          
          // Parse interval in minutes
          const minutesMatch = scheduleText.match(/every\s+(\d+)\s+minutes?/i);
          if (minutesMatch) {
            currentTask.intervalMs = parseInt(minutesMatch[1]) * 60 * 1000;
          }
          
          // Parse interval in hours
          const hoursMatch = scheduleText.match(/every\s+(\d+)\s+hours?/i);
          if (hoursMatch) {
            currentTask.intervalMs = parseInt(hoursMatch[1]) * 60 * 60 * 1000;
          }
          
          // Parse interval in days
          const daysMatch = scheduleText.match(/every\s+(\d+)\s+days?/i);
          if (daysMatch) {
            currentTask.intervalMs = parseInt(daysMatch[1]) * 24 * 60 * 60 * 1000;
          }
        } else {
          // Regular description text
          if (currentTask.description) {
            currentTask.description += ' ' + trimmed;
          } else {
            currentTask.description = trimmed;
          }
        }
      }
    }
    
    // Add last task
    if (currentTask.name && currentTask.description) {
      tasks.push({
        name: currentTask.name,
        description: currentTask.description,
        enabled: true,
        ...(currentTask.cronExpression && { cronExpression: currentTask.cronExpression }),
        ...(currentTask.intervalMs && { intervalMs: currentTask.intervalMs }),
      });
    }
    
    return tasks;
  }
  
  /**
   * Parse policies section
   * Format: ## Policies / ## Rules / ## Guidelines
   */
  private parsePolicies(md: string): Policy[] {
    const sections = this.extractSection(md, ['## Policies', '## Rules', '## Guidelines']);
    if (!sections) return [];
    
    const policies: Policy[] = [];
    const lines = sections.split('\n');
    let currentPolicy: Partial<Policy> = {};
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      // Policy name (starts with ### or bullet point)
      if (trimmed.startsWith('###') || trimmed.match(/^[-*]\s*/)) {
        // Save previous policy if exists
        if (currentPolicy.name && currentPolicy.description) {
          policies.push({
            name: currentPolicy.name,
            description: currentPolicy.description,
            rules: [], // Empty rules array
          });
        }
        
        // Start new policy
        currentPolicy = {};
        
        // Extract policy name
        let policyName = trimmed;
        if (trimmed.startsWith('###')) {
          policyName = trimmed.replace(/^###\s*/, '');
          currentPolicy.name = policyName.trim();
        } else {
          // Remove bullet point
          policyName = trimmed.replace(/^[-*]\s*/, '');
          
          // Check if there's a colon separating name and description
          const colonMatch = policyName.match(/^([^:]+):\s*(.+)$/);
          if (colonMatch) {
            currentPolicy.name = colonMatch[1].trim();
            currentPolicy.description = colonMatch[2].trim();
          } else {
            // No colon, use entire line as name and description
            currentPolicy.name = policyName.trim();
            currentPolicy.description = policyName.trim();
          }
        }
      }
      // Policy description continuation
      else if (trimmed && currentPolicy.name && !trimmed.startsWith('#')) {
        if (currentPolicy.description) {
          currentPolicy.description += ' ' + trimmed;
        } else {
          currentPolicy.description = trimmed;
        }
      }
    }
    
    // Add last policy
    if (currentPolicy.name && currentPolicy.description) {
      policies.push({
        name: currentPolicy.name,
        description: currentPolicy.description,
        rules: [], // Empty rules array
      });
    }
    
    return policies;
  }
  
  /**
   * Parse knowledge base section
   * Format: ## Knowledge Base / ## References
   */
  private parseKnowledgeBase(md: string): string[] {
    const sections = this.extractSection(md, ['## Knowledge Base', '## References']);
    if (!sections) return [];
    
    return sections
      .split('\n')
      .map(line => line.replace(/^[-*]\s*/, '').trim())
      .filter(line => line && !line.startsWith('#'));
  }
  
  /**
   * Parse value from string (could be number, boolean, or string)
   */
  private parseValue(value: string): unknown {
    // Try to parse as number (handle units like "1000 tokens")
    const numMatch = value.match(/^(\d+)\s*(?:tokens|kb|mb|gb)?$/i);
    if (numMatch) {
      const num = Number(numMatch[1]);
      if (!isNaN(num)) return num;
    }
    
    // Try to parse as boolean
    const lower = value.toLowerCase();
    if (lower === 'true' || lower === 'false') return lower === 'true';
    
    // Return as string
    return value;
  }
  
  /**
   * Extract skills from capabilities list
   */
  private extractSkills(capabilities: string[]): string[] {
    // Map OpenClaw capability names to Markus skill names
    const skillMap: Record<string, string> = {
      'shell_execute': 'shell_execute',
      'file_read_write': 'file_read_write',
      'git_operations': 'git_operations',
      'web_search': 'web_search',
      'code_review': 'code_review',
      'test_runner': 'test_runner',
      'team_management': 'team-management',
      'task_routing': 'task-routing',
      'task_delegation': 'task-delegation',
      'progress_reporting': 'progress-reporting',
      'resource_planning': 'resource-planning',
      'onboarding': 'onboarding',
      'conflict_resolution': 'conflict-resolution',
      'communication': 'communication',
      'testing': 'test_runner', // Map generic "Testing" to test_runner
      'debugging': 'debugging', // Keep as-is if no direct mapping
      'documentation': 'documentation', // Keep as-is
    };
    
    return capabilities
      .map(cap => {
        const lower = cap.toLowerCase();
        for (const [key, skill] of Object.entries(skillMap)) {
          if (lower.includes(key)) return skill;
        }
        // If no mapping found, use the capability name normalized
        return lower.replace(/\s+/g, '_');
      })
      .filter((skill): skill is string => skill !== null);
  }
  
  /**
   * Build system prompt from original markdown, removing parsed sections
   */
  private buildSystemPrompt(
    originalMd: string,
    capabilities: string[],
    memoryConfig: Record<string, unknown>,
    heartbeatTasks: HeartbeatTask[],
    knowledgeBase: string[]
  ): string {
    let cleanedMd = originalMd;
    
    // Remove sections that will be handled by Markus
    cleanedMd = this.removeSection(cleanedMd, ['## Capabilities', '## Skills', '## Tools']);
    cleanedMd = this.removeSection(cleanedMd, ['## Memory', '## Knowledge', '## Context']);
    cleanedMd = this.removeSection(cleanedMd, ['## Heartbeat', '## Heartbeat Tasks']);
    cleanedMd = this.removeSection(cleanedMd, ['## Policies', '## Rules', '## Guidelines']);
    cleanedMd = this.removeSection(cleanedMd, ['## Knowledge Base', '## References']);
    
    // Add capabilities section back in Markus format
    const parts: string[] = [cleanedMd.trim()];
    
    if (capabilities.length > 0) {
      parts.push('\n## Core Competencies');
      capabilities.forEach(cap => parts.push(`- ${cap}`));
    }
    
    // Add memory configuration if present
    if (Object.keys(memoryConfig).length > 0) {
      parts.push('\n## Memory Configuration');
      Object.entries(memoryConfig).forEach(([key, value]) => {
        parts.push(`- ${key}: ${value}`);
      });
    }
    
    // Add heartbeat tasks if present
    if (heartbeatTasks.length > 0) {
      parts.push('\n## Heartbeat Tasks');
      heartbeatTasks.forEach(task => {
        parts.push(`- ${task.name}: ${task.description}`);
      });
    }
    
    // Add policies section (will be added by the agent based on parsed policies)
    // Note: Policies are handled separately in the RoleTemplate
    
    // Add knowledge base references section
    if (knowledgeBase.length > 0) {
      parts.push('\n## Knowledge Base References');
      knowledgeBase.forEach(ref => parts.push(`- ${ref}`));
    }
    
    return parts.join('\n').trim();
  }
  
  /**
   * Remove a section from markdown
   */
  private removeSection(md: string, possibleHeaders: string[]): string {
    let result = md;
    for (const header of possibleHeaders) {
      const headerIndex = result.indexOf(header);
      if (headerIndex === -1) continue;
      
      // Find the end of this section (next ## or # header, or end of string)
      let sectionEnd = result.length;
      for (let i = headerIndex + header.length; i < result.length; i++) {
        if (result.substring(i, i + 3) === "\n##" || result.substring(i, i + 2) === "\n#") {
          sectionEnd = i;
          break;
        }
      }
      
      // Remove the section
      const beforeSection = result.substring(0, headerIndex);
      const afterSection = result.substring(sectionEnd);
      result = beforeSection + afterSection;
    }
    return result;
  }
  
  /**
   * Extract a specific section from markdown
   */
  private extractSection(md: string, possibleHeaders: string[]): string | null {
    for (const header of possibleHeaders) {
      const headerIndex = md.indexOf(header);
      if (headerIndex === -1) continue;
      
      // Find the end of this section (next ## or # header at the start of a line, or end of string)
      let sectionEnd = md.length;
      for (let i = headerIndex + header.length; i < md.length; i++) {
        // Check for newline followed by # or ## (but not ### which is a sub-header)
        if (md[i] === '\n' && i + 1 < md.length) {
          // Check for # header (not followed by another #)
          if (md[i + 1] === '#' && (i + 2 >= md.length || md[i + 2] !== '#')) {
            sectionEnd = i;
            break;
          }
          // Check for ## header (not followed by another #)
          if (i + 2 < md.length && md[i + 1] === '#' && md[i + 2] === '#' && 
              (i + 3 >= md.length || md[i + 3] !== '#')) {
            sectionEnd = i;
            break;
          }
        }
      }
      
      // Extract content after header (skip newline after header)
      let contentStart = headerIndex + header.length;
      while (contentStart < md.length && (md[contentStart] === "\n" || md[contentStart] === "\r")) {
        contentStart++;
      }
      
      const content = md.substring(contentStart, sectionEnd).trim();
      return content;
    }
    return null;
  }

  /**
   * Check if the given markdown content is in OpenClaw format
   */
  isOpenClawFormat(markdown: string): boolean {
    // OpenClaw format typically includes specific headers
    const openclawHeaders = [
      '# Identity & Role',
      '# Capabilities & Tools',
      '# Memory Configuration',
      '# Heartbeat Tasks',
      '# Communication Preferences',
      '# Knowledge Base'
    ];

    // Check if any of the OpenClaw headers are present
    for (const header of openclawHeaders) {
      if (markdown.includes(header)) {
        return true;
      }
    }

    // Also check for common OpenClaw patterns
    const openclawPatterns = [
      /## Memory Configuration/i,
      /## Heartbeat Tasks/i,
      /## Knowledge Base/i
    ];

    for (const pattern of openclawPatterns) {
      if (pattern.test(markdown)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Convert a Markus RoleTemplate to OpenClaw format markdown
   */
  toOpenClawFormat(role: RoleTemplate): string {
    const sections: string[] = [];

    // Identity & Role section
    sections.push('# Identity & Role');
    sections.push('');
    sections.push(`**Name:** ${role.name}`);
    sections.push(`**Description:** ${role.description || 'No description provided'}`);
    sections.push(`**Category:** ${role.category || 'general'}`);
    sections.push('');

    // Capabilities & Tools section
    sections.push('# Capabilities & Tools');
    sections.push('');
    if (role.defaultSkills && role.defaultSkills.length > 0) {
      sections.push('## Core Skills');
      role.defaultSkills.forEach(skill => {
        sections.push(`- ${skill}`);
      });
      sections.push('');
    }
    sections.push('');

    // Memory Configuration section
    sections.push('# Memory Configuration');
    sections.push('');
    sections.push('| Memory Type | Capacity |');
    sections.push('|-------------|----------|');
    sections.push('| Short-term  | 10,000 tokens |');
    sections.push('| Medium-term | 50,000 tokens |');
    sections.push('| Long-term   | Unlimited |');
    sections.push('| Knowledge Base | Enabled |');
    sections.push('| Context Window | 8,192 tokens |');
    sections.push('');

    // Heartbeat Tasks section
    sections.push('# Heartbeat Tasks');
    sections.push('');
    if (role.defaultHeartbeatTasks && role.defaultHeartbeatTasks.length > 0) {
      role.defaultHeartbeatTasks.forEach(task => {
        sections.push(`## ${task.name}`);
        sections.push(task.description);
        if (task.cronExpression) {
          sections.push(`**Schedule:** Cron expression: ${task.cronExpression}`);
        } else if (task.intervalMs) {
          sections.push(`**Schedule:** Every ${task.intervalMs / 1000} seconds`);
        } else {
          sections.push(`**Schedule:** Not specified`);
        }
        sections.push('');
      });
    } else {
      sections.push('No heartbeat tasks configured.');
      sections.push('');
    }

    // Communication Preferences section
    sections.push('# Communication Preferences');
    sections.push('');
    sections.push('- **Primary Channel:** Direct messaging');
    sections.push('- **Response Time:** Within 30 seconds');
    sections.push('- **Format:** Structured messages with clear action items');
    sections.push('');

    // Knowledge Base section
    sections.push('# Knowledge Base');
    sections.push('');
    sections.push('## Internal Knowledge');
    sections.push('- Project documentation');
    sections.push('- Team guidelines');
    sections.push('- Best practices');
    sections.push('');
    sections.push('## External References');
    sections.push('- Official documentation');
    sections.push('- Community resources');
    sections.push('- Technical specifications');
    sections.push('');

    return sections.join('\n');
  }
}
