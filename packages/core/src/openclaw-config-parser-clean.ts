import { generateId, type RoleTemplate, type Policy, type RoleCategory } from '@markus/shared';

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
    const lines = markdown.split('\n');
    
    // Extract basic information
    const name = this.extractTitle(markdown) || 'OpenClaw Agent';
    const description = this.extractDescription(markdown);
    const category = this.inferCategory(markdown);
    
    // Parse OpenClaw-specific sections
    const capabilities = this.parseCapabilities(markdown);
    const memoryConfig = this.parseMemoryConfig(markdown);
    const heartbeatChecklist = this.parseHeartbeatChecklist(markdown);
    const policies = this.parsePolicies(markdown);
    const knowledgeBase = this.parseKnowledgeBase(markdown);
    
    // Build system prompt combining all sections
    const systemPrompt = this.buildSystemPrompt(
      markdown,
      capabilities,
      memoryConfig,
      [],
      knowledgeBase
    );
    
    // Extract skills from capabilities
    const skills = this.extractSkills(capabilities);
    
    return {
      id: generateId('role'),
      name,
      description,
      category,
      systemPrompt,
      defaultSkills: skills,
      heartbeatChecklist,
      defaultPolicies: policies,
      builtIn: false,
    };
  }
  
  /**
   * Extract title from markdown (first # heading)
   */
  private extractTitle(md: string): string {
    const match = md.match(/^#\s+(.+)$/m);
    return match?.[1]?.trim() ?? '';
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
    if (lower.includes('develop') || lower.includes('engineer') || lower.includes('code')) return 'engineering';
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
    const sections = this.extractSection(md, ['## Capabilities', '## Skills', '## Tools']);
    if (!sections) return [];
    
    return sections
      .split('\n')
      .map(line => line.replace(/^[-*]\s*/, '').trim())
      .filter(line => line && !line.startsWith('#'));
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
        const key = match[1].trim().toLowerCase().replace(/\s+/g, '_');
        const value = match[2].trim();
        config[key] = this.parseValue(value);
      }
    }
    
    return config;
  }
  
  /**
   * Parse heartbeat section as raw checklist text.
   */
  private parseHeartbeatChecklist(md: string): string {
    const section = this.extractSection(md, ['## Heartbeat', '## Periodic Tasks', '## Scheduled Tasks']);
    return section?.trim() ?? '';
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
      
      // Policy name (starts with ### or -)
      if (trimmed.startsWith('###') || trimmed.match(/^[-*]\s*[^:]+:/)) {
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
        } else {
          // Remove bullet point and capture name before colon
          policyName = trimmed.replace(/^[-*]\s*/, '');
        }
        
        // Remove colon and everything after for policy name
        currentPolicy.name = policyName.replace(/:.*$/, '').trim();
        
        // Check for inline description
        const inlineDesc = trimmed.match(/:?\s*(.+)$/);
        if (inlineDesc && inlineDesc[1]) {
          currentPolicy.description = inlineDesc[1].trim();
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
    // Try to parse as number
    const num = Number(value);
    if (!isNaN(num)) return num;
    
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
    };
    
    return capabilities
      .map(cap => {
        const lower = cap.toLowerCase();
        for (const [key, skill] of Object.entries(skillMap)) {
          if (lower.includes(key)) return skill;
        }
        return null;
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
    heartbeatTasks: { name: string; description: string }[],
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
      // Escape regex special characters in header
      const escapedHeader = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`^${escapedHeader}\\s*$\\n([\\s\\S]*?)(?=^##\\s|^#\\s|$)`, 'gm');
      result = result.replace(regex, '');
    }
    return result;
  }
  
  /**
   * Extract a specific section from markdown
   */
  private extractSection(md: string, possibleHeaders: string[]): string | null {
    for (const header of possibleHeaders) {
      // Escape regex special characters in header
      const escapedHeader = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`^${escapedHeader}\\s*$\\n([\\s\\S]*?)(?=^##\\s|^#\\s|$)`, 'm');
      const match = md.match(regex);
      if (match) {
        return match[1].trim();
      }
    }
    return null;
  }
}