import { useState, useEffect } from 'react';
import { api, type AgentInfo } from '../api.ts';
import { navBus } from '../navBus.ts';

const BUILDERS = [
  {
    roleId: 'agent-father',
    roleName: 'Agent Father',
    icon: '✦',
    color: 'from-indigo-500 to-purple-600',
    borderColor: 'border-indigo-500/30 hover:border-indigo-400/50',
    bgColor: 'bg-indigo-500/10',
    desc: 'AI Agent Architect',
    detail: 'Design and create powerful AI agents through natural conversation. Describe the agent you need and Agent Father will configure it with the right role, skills, tools, and system prompt.',
    examples: [
      'A senior full-stack developer who specializes in React and Node.js',
      'A DevOps engineer for CI/CD pipeline management',
      'A code reviewer who enforces best practices',
    ],
  },
  {
    roleId: 'team-factory',
    roleName: 'Team Factory',
    icon: '◈',
    color: 'from-cyan-500 to-blue-600',
    borderColor: 'border-cyan-500/30 hover:border-cyan-400/50',
    bgColor: 'bg-cyan-500/10',
    desc: 'AI Team Composer',
    detail: 'Compose optimal agent teams for any project. Describe your goal and Team Factory will design the lineup with the right mix of managers, developers, reviewers, and specialists.',
    examples: [
      'A web development team with PM, developers, and QA',
      'A content team for a tech blog',
      'A data engineering squad',
    ],
  },
  {
    roleId: 'skill-architect',
    roleName: 'Skill Architect',
    icon: '⬡',
    color: 'from-emerald-500 to-teal-600',
    borderColor: 'border-emerald-500/30 hover:border-emerald-400/50',
    bgColor: 'bg-emerald-500/10',
    desc: 'AI Skill Designer',
    detail: 'Create new agent skills and tool definitions. Describe the capability you want and Skill Architect will design the complete skill manifest with tools, schemas, and permissions.',
    examples: [
      'A skill that analyzes Git repos and generates changelogs',
      'A web scraping skill for extracting structured data',
      'A database migration tool with rollback support',
    ],
  },
];

export function AgentBuilder() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);

  useEffect(() => {
    api.agents.list().then(d => setAgents(d.agents)).catch(() => {});
  }, []);

  const navigateToBuilder = (roleId: string, roleName: string) => {
    const builderAgent = agents.find(a => a.role === roleName || a.name === roleName);
    if (builderAgent) {
      localStorage.setItem('markus_select_builder', builderAgent.id);
    } else {
      localStorage.setItem('markus_select_builder', roleId);
    }
    navBus.navigate('chat');
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-10">
        <div className="mb-10">
          <h1 className="text-2xl font-bold text-gray-100">Builder</h1>
          <p className="text-sm text-gray-500 mt-2">
            Create agents, teams, and skills through AI-powered conversations.
            Choose a builder to get started.
          </p>
        </div>

        <div className="grid gap-5">
          {BUILDERS.map(b => (
            <button
              key={b.roleId}
              onClick={() => navigateToBuilder(b.roleId, b.roleName)}
              className={`group text-left w-full rounded-xl border ${b.borderColor} bg-gray-900/60 p-6 transition-all hover:bg-gray-900/80 hover:shadow-lg`}
            >
              <div className="flex items-start gap-5">
                <div className={`w-14 h-14 rounded-xl ${b.bgColor} flex items-center justify-center text-2xl shrink-0`}>
                  {b.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-1.5">
                    <h3 className={`text-lg font-semibold bg-gradient-to-r ${b.color} bg-clip-text text-transparent`}>
                      {b.roleName}
                    </h3>
                    <span className="text-[10px] text-gray-600 font-medium uppercase tracking-wider">{b.desc}</span>
                    {agents.find(a => a.role === b.roleName || a.name === b.roleName) && (
                      <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" title="Agent online" />
                    )}
                  </div>
                  <p className="text-sm text-gray-400 leading-relaxed">{b.detail}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {b.examples.map((ex, i) => (
                      <span key={i} className="text-[11px] text-gray-600 bg-gray-800/60 rounded-full px-3 py-1 border border-gray-800">
                        &ldquo;{ex}&rdquo;
                      </span>
                    ))}
                  </div>
                </div>
                <svg className="w-5 h-5 text-gray-700 group-hover:text-gray-400 transition-colors shrink-0 mt-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </div>
            </button>
          ))}
        </div>

        {agents.length > 0 && !agents.some(a => BUILDERS.some(b => a.role === b.roleName || a.name === b.roleName)) && (
          <div className="mt-8 p-4 rounded-lg border border-amber-800/30 bg-amber-900/10 text-amber-400 text-xs">
            Builder agents have not been created yet. They will be automatically seeded on next server restart.
          </div>
        )}
      </div>
    </div>
  );
}
