import { useState, useCallback, useEffect } from 'react';

type BuilderTab = 'template' | 'workflow' | 'team';

interface TemplateForm {
  name: string;
  description: string;
  roleId: string;
  agentRole: 'manager' | 'worker';
  skills: string;
  tags: string;
  category: string;
  systemPrompt: string;
  starterTasks: Array<{ title: string; description: string; priority: 'low' | 'medium' | 'high' }>;
}

interface WorkflowStepForm {
  id: string;
  name: string;
  type: 'agent_task' | 'condition' | 'transform' | 'delay';
  agentId: string;
  dependsOn: string;
  prompt: string;
}

interface WorkflowForm {
  name: string;
  description: string;
  steps: WorkflowStepForm[];
}

interface TeamMemberForm {
  templateId: string;
  name: string;
  count: number;
  role: 'manager' | 'worker';
}

interface TeamForm {
  name: string;
  description: string;
  members: TeamMemberForm[];
  tags: string;
  category: string;
}

interface AvailableTemplate {
  id: string;
  name: string;
  agentRole: string;
  category: string;
}

const CATEGORIES = ['development', 'devops', 'management', 'productivity', 'general'];

const STEP_TYPE_INFO: Record<string, { label: string; hint: string; color: string }> = {
  agent_task: { label: 'Agent Task', hint: 'Execute a task using a specific agent', color: 'bg-blue-500/15 text-blue-400' },
  condition: { label: 'Condition', hint: 'Branch the workflow based on a condition', color: 'bg-amber-500/15 text-amber-400' },
  transform: { label: 'Transform', hint: 'Transform data between steps', color: 'bg-green-500/15 text-green-400' },
  delay: { label: 'Delay', hint: 'Wait a specified duration (ms)', color: 'bg-gray-500/15 text-gray-400' },
};

const TAB_CONFIG = [
  { key: 'template' as const, label: 'Agent Template', icon: '⊕', desc: 'Create reusable agent definitions' },
  { key: 'workflow' as const, label: 'Workflow', icon: '⇢', desc: 'Design multi-step agent pipelines' },
  { key: 'team' as const, label: 'Team', icon: '◎', desc: 'Compose multi-agent teams' },
];

function emptyStep(index: number): WorkflowStepForm {
  return { id: `step_${index}`, name: '', type: 'agent_task', agentId: '', dependsOn: '', prompt: '' };
}

export function AgentBuilder() {
  const [tab, setTab] = useState<BuilderTab>('template');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [availableTemplates, setAvailableTemplates] = useState<AvailableTemplate[]>([]);

  const [tplForm, setTplForm] = useState<TemplateForm>({
    name: '', description: '', roleId: '', agentRole: 'worker',
    skills: '', tags: '', category: 'development', systemPrompt: '',
    starterTasks: [],
  });

  const [wfForm, setWfForm] = useState<WorkflowForm>({
    name: '', description: '', steps: [emptyStep(0)],
  });

  const [teamForm, setTeamForm] = useState<TeamForm>({
    name: '', description: '',
    members: [{ templateId: '', name: '', count: 1, role: 'worker' }],
    tags: '', category: 'development',
  });

  useEffect(() => {
    fetch('/api/templates')
      .then(r => r.json())
      .then((d: { templates: AvailableTemplate[] }) => {
        setAvailableTemplates(d.templates ?? []);
      })
      .catch(() => {});
  }, []);

  const showResult = useCallback((ok: boolean, message: string) => {
    setResult({ ok, message });
    setTimeout(() => setResult(null), 5000);
  }, []);

  const saveTemplate = useCallback(async () => {
    if (!tplForm.name.trim()) { showResult(false, 'Name is required'); return; }
    if (!tplForm.description.trim()) { showResult(false, 'Description is required'); return; }
    setSaving(true);
    try {
      const payload = {
        name: tplForm.name,
        description: tplForm.description,
        roleId: tplForm.roleId || tplForm.name.toLowerCase().replace(/\s+/g, '-'),
        agentRole: tplForm.agentRole,
        skills: tplForm.skills.split(',').map(s => s.trim()).filter(Boolean),
        tags: tplForm.tags.split(',').map(s => s.trim()).filter(Boolean),
        category: tplForm.category,
        source: 'custom',
        systemPrompt: tplForm.systemPrompt,
        starterTasks: tplForm.starterTasks,
      };
      const resp = await fetch('/api/marketplace/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (resp.ok) {
        showResult(true, 'Template created successfully! You can now find it in the Template Marketplace.');
        setTplForm({ name: '', description: '', roleId: '', agentRole: 'worker', skills: '', tags: '', category: 'development', systemPrompt: '', starterTasks: [] });
      } else {
        const data = await resp.json() as { error?: string };
        showResult(false, data.error ?? 'Failed to create template');
      }
    } catch (err) {
      showResult(false, String(err));
    } finally {
      setSaving(false);
    }
  }, [tplForm, showResult]);

  const validateWorkflow = useCallback(async () => {
    const workflow = buildWorkflowPayload(wfForm);
    try {
      const resp = await fetch('/api/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'validate', workflow }),
      });
      const data = await resp.json() as { valid: boolean; errors: string[] };
      if (data.valid) {
        showResult(true, 'Workflow is valid and ready to run!');
      } else {
        showResult(false, `Validation errors: ${data.errors.join(', ')}`);
      }
    } catch (err) {
      showResult(false, String(err));
    }
  }, [wfForm, showResult]);

  const runWorkflow = useCallback(async () => {
    if (!wfForm.name.trim()) { showResult(false, 'Workflow name is required'); return; }
    if (wfForm.steps.every(s => !s.name.trim())) { showResult(false, 'At least one step needs a name'); return; }
    setSaving(true);
    try {
      const workflow = buildWorkflowPayload(wfForm);
      const resp = await fetch('/api/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow, inputs: {} }),
      });
      const data = await resp.json() as { executionId?: string; status?: string; error?: string };
      if (resp.ok) {
        showResult(true, `Workflow started: ${data.executionId} (${data.status})`);
      } else {
        showResult(false, data.error ?? 'Failed to start workflow');
      }
    } catch (err) {
      showResult(false, String(err));
    } finally {
      setSaving(false);
    }
  }, [wfForm, showResult]);

  const saveTeam = useCallback(async () => {
    if (!teamForm.name.trim()) { showResult(false, 'Team name is required'); return; }
    const validMembers = teamForm.members.filter(m => m.templateId);
    if (validMembers.length === 0) { showResult(false, 'Add at least one member with a template ID'); return; }
    setSaving(true);
    try {
      const payload = {
        name: teamForm.name,
        description: teamForm.description,
        members: validMembers,
        tags: teamForm.tags.split(',').map(s => s.trim()).filter(Boolean),
        category: teamForm.category,
      };
      const resp = await fetch('/api/team-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (resp.ok) {
        showResult(true, 'Team template created successfully!');
        setTeamForm({ name: '', description: '', members: [{ templateId: '', name: '', count: 1, role: 'worker' }], tags: '', category: 'development' });
      } else {
        const data = await resp.json() as { error?: string };
        showResult(false, data.error ?? 'Failed to create team');
      }
    } catch (err) {
      showResult(false, String(err));
    } finally {
      setSaving(false);
    }
  }, [teamForm, showResult]);

  function updateStep(index: number, field: keyof WorkflowStepForm, value: string) {
    setWfForm(f => ({
      ...f,
      steps: f.steps.map((s, i) => i === index ? { ...s, [field]: value } : s),
    }));
  }

  return (
    <div className="h-full overflow-y-auto p-6 bg-gray-950">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white mb-1">Agent Builder</h1>
          <p className="text-gray-500 text-sm">Create custom agent templates, multi-step workflows, and team compositions</p>
        </div>

        {/* Result banner */}
        {result && (
          <div className={`mb-4 px-4 py-3 rounded-lg text-sm flex items-center gap-2 ${
            result.ok
              ? 'bg-emerald-900/40 text-emerald-300 border border-emerald-700/50'
              : 'bg-red-900/40 text-red-300 border border-red-700/50'
          }`}>
            <span className="text-lg">{result.ok ? '✓' : '!'}</span>
            <span>{result.message}</span>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-2 mb-6">
          {TAB_CONFIG.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex-1 p-3 rounded-xl text-left transition-all border ${
                tab === t.key
                  ? 'bg-indigo-600/15 border-indigo-500/40 text-white'
                  : 'bg-gray-900 border-gray-800 text-gray-400 hover:border-gray-700 hover:text-gray-300'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">{t.icon}</span>
                <span className="text-sm font-medium">{t.label}</span>
              </div>
              <div className="text-xs mt-0.5 opacity-60">{t.desc}</div>
            </button>
          ))}
        </div>

        {/* Template Builder */}
        {tab === 'template' && (
          <div className="space-y-5">
            <Card title="Basic Information" description="Define the core identity of your agent template.">
              <FormRow label="Name" hint="A clear, descriptive name for this agent type" required>
                <input className="input-field" value={tplForm.name} onChange={e => setTplForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Senior Backend Developer" />
              </FormRow>
              <FormRow label="Description" hint="What does this agent specialize in?" required>
                <textarea className="input-field min-h-[80px]" value={tplForm.description} onChange={e => setTplForm(f => ({ ...f, description: e.target.value }))} placeholder="A backend developer specialized in Node.js, databases, and API design..." />
              </FormRow>
              <div className="grid grid-cols-2 gap-4">
                <FormRow label="Role ID" hint="Unique identifier (auto-generated if empty)">
                  <input className="input-field" value={tplForm.roleId} onChange={e => setTplForm(f => ({ ...f, roleId: e.target.value }))} placeholder="auto-generated from name" />
                </FormRow>
                <FormRow label="Agent Role" hint="Manager agents can delegate to workers">
                  <select className="input-field" value={tplForm.agentRole} onChange={e => setTplForm(f => ({ ...f, agentRole: e.target.value as 'manager' | 'worker' }))}>
                    <option value="worker">Worker</option>
                    <option value="manager">Manager</option>
                  </select>
                </FormRow>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <FormRow label="Category" hint="Helps organize templates in the marketplace">
                  <select className="input-field" value={tplForm.category} onChange={e => setTplForm(f => ({ ...f, category: e.target.value }))}>
                    {CATEGORIES.map(c => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
                  </select>
                </FormRow>
                <FormRow label="Skills" hint="Comma-separated list of tool skills">
                  <input className="input-field" value={tplForm.skills} onChange={e => setTplForm(f => ({ ...f, skills: e.target.value }))} placeholder="git, code-analysis, browser" />
                </FormRow>
              </div>
              <FormRow label="Tags" hint="Keywords for search and discovery">
                <input className="input-field" value={tplForm.tags} onChange={e => setTplForm(f => ({ ...f, tags: e.target.value }))} placeholder="senior, backend, python, api" />
              </FormRow>
            </Card>

            <Card title="System Prompt" description="The core instructions that define this agent's behavior and personality.">
              <textarea
                className="input-field min-h-[160px] font-mono text-xs leading-relaxed"
                value={tplForm.systemPrompt}
                onChange={e => setTplForm(f => ({ ...f, systemPrompt: e.target.value }))}
                placeholder={"You are a senior backend developer specialized in:\n- Node.js / TypeScript microservices\n- PostgreSQL database design\n- REST & GraphQL API development\n- Performance optimization and monitoring\n\nYou write clean, well-tested code and always consider edge cases..."}
              />
              {!tplForm.systemPrompt && (
                <p className="text-xs text-gray-600 mt-2 italic">
                  Tip: A good system prompt describes the agent's expertise, work style, and any specific guidelines it should follow.
                </p>
              )}
            </Card>

            <Card title="Starter Tasks" description="Pre-defined tasks that appear when the agent is first created. Great for onboarding.">
              {tplForm.starterTasks.length === 0 && (
                <div className="text-center py-4 text-gray-600 text-sm">
                  No starter tasks yet. Add tasks that this agent should tackle first when hired.
                </div>
              )}
              {tplForm.starterTasks.map((task, i) => (
                <div key={i} className="flex gap-2 mb-2 items-center">
                  <input className="input-field flex-1" value={task.title} placeholder="e.g. Set up project scaffolding" onChange={e => {
                    const tasks = [...tplForm.starterTasks];
                    tasks[i] = { ...tasks[i]!, title: e.target.value };
                    setTplForm(f => ({ ...f, starterTasks: tasks }));
                  }} />
                  <select className="input-field w-28" value={task.priority} onChange={e => {
                    const tasks = [...tplForm.starterTasks];
                    tasks[i] = { ...tasks[i]!, priority: e.target.value as 'low' | 'medium' | 'high' };
                    setTplForm(f => ({ ...f, starterTasks: tasks }));
                  }}>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                  <button onClick={() => setTplForm(f => ({ ...f, starterTasks: f.starterTasks.filter((_, j) => j !== i) }))} className="text-red-400 hover:text-red-300 px-2 text-lg" title="Remove task">&times;</button>
                </div>
              ))}
              <button
                onClick={() => setTplForm(f => ({ ...f, starterTasks: [...f.starterTasks, { title: '', description: '', priority: 'medium' }] }))}
                className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors mt-1"
              >
                + Add Starter Task
              </button>
            </Card>

            <div className="flex justify-end gap-3 pb-4">
              <button onClick={saveTemplate} disabled={saving} className="btn-primary">
                {saving ? 'Creating...' : 'Create Template'}
              </button>
            </div>
          </div>
        )}

        {/* Workflow Builder */}
        {tab === 'workflow' && (
          <div className="space-y-5">
            <Card title="Workflow Definition" description="Define a multi-step pipeline where agents collaborate to complete complex tasks.">
              <FormRow label="Name" hint="A descriptive name for this workflow" required>
                <input className="input-field" value={wfForm.name} onChange={e => setWfForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Code Review Pipeline" />
              </FormRow>
              <FormRow label="Description" hint="What does this workflow accomplish?">
                <textarea className="input-field min-h-[60px]" value={wfForm.description} onChange={e => setWfForm(f => ({ ...f, description: e.target.value }))} placeholder="Runs static analysis, then hands off to a reviewer, and finally creates a summary report..." />
              </FormRow>
            </Card>

            <Card title="Steps" description={`Define the steps in your workflow. Steps can depend on each other to form a DAG. (${wfForm.steps.length} step${wfForm.steps.length !== 1 ? 's' : ''})`}>
              {wfForm.steps.map((step, i) => (
                <div key={step.id} className="bg-gray-800/40 rounded-xl p-4 mb-3 border border-gray-700/40 relative">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="w-6 h-6 rounded-lg bg-indigo-500/20 text-indigo-400 flex items-center justify-center text-xs font-bold">{i + 1}</span>
                      <span className="text-xs font-mono text-gray-500">{step.id}</span>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${STEP_TYPE_INFO[step.type]?.color ?? ''}`}>
                        {STEP_TYPE_INFO[step.type]?.label ?? step.type}
                      </span>
                    </div>
                    {wfForm.steps.length > 1 && (
                      <button onClick={() => setWfForm(f => ({ ...f, steps: f.steps.filter((_, j) => j !== i) }))} className="text-red-400/60 hover:text-red-300 text-xs transition-colors">Remove</button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <FormRow label="Name" hint="Human-readable step name">
                      <input className="input-field" value={step.name} onChange={e => updateStep(i, 'name', e.target.value)} placeholder="e.g. Run code analysis" />
                    </FormRow>
                    <FormRow label="Type" hint={STEP_TYPE_INFO[step.type]?.hint ?? ''}>
                      <select className="input-field" value={step.type} onChange={e => updateStep(i, 'type', e.target.value)}>
                        {Object.entries(STEP_TYPE_INFO).map(([val, info]) => (
                          <option key={val} value={val}>{info.label}</option>
                        ))}
                      </select>
                    </FormRow>
                  </div>
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <FormRow label="Agent ID" hint={step.type === 'agent_task' ? 'Which agent executes this step' : 'Not needed for this step type'}>
                      <input
                        className="input-field"
                        value={step.agentId}
                        onChange={e => updateStep(i, 'agentId', e.target.value)}
                        placeholder={step.type === 'agent_task' ? 'e.g. agt_12345' : '(optional)'}
                        disabled={step.type !== 'agent_task'}
                      />
                    </FormRow>
                    <FormRow label="Depends On" hint={i === 0 ? 'First step has no dependencies' : `IDs of steps that must complete first (e.g. step_0)`}>
                      <input className="input-field" value={step.dependsOn} onChange={e => updateStep(i, 'dependsOn', e.target.value)} placeholder={i === 0 ? '(none — first step)' : `step_0${i > 1 ? ', step_1' : ''}`} />
                    </FormRow>
                  </div>
                  <FormRow label={step.type === 'delay' ? 'Duration (ms)' : step.type === 'condition' ? 'Condition Expression' : step.type === 'transform' ? 'Transform Expression' : 'Task Prompt'} hint={
                    step.type === 'delay' ? 'Milliseconds to wait (e.g. 5000 for 5 seconds)'
                    : step.type === 'condition' ? 'JavaScript expression that evaluates to true/false'
                    : step.type === 'transform' ? 'Expression to transform data between steps'
                    : 'The task description or prompt sent to the agent'
                  }>
                    <textarea className="input-field min-h-[60px] font-mono text-xs" value={step.prompt} onChange={e => updateStep(i, 'prompt', e.target.value)} placeholder={
                      step.type === 'delay' ? '5000'
                      : step.type === 'condition' ? 'steps.step_0.output.approved === true'
                      : step.type === 'transform' ? '({ summary: steps.step_0.output.result })'
                      : 'Review the code changes and provide feedback on code quality, performance, and security...'
                    } />
                  </FormRow>
                </div>
              ))}
              <button
                onClick={() => setWfForm(f => ({ ...f, steps: [...f.steps, emptyStep(f.steps.length)] }))}
                className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
              >
                + Add Step
              </button>
            </Card>

            {/* Visual DAG Preview */}
            <Card title="Pipeline Preview" description="Visual representation of your workflow's step dependencies.">
              <div className="bg-gray-800/30 rounded-lg p-4 min-h-[60px]">
                {wfForm.steps.length === 0 ? (
                  <div className="text-center text-gray-600 text-sm py-4">Add steps to see the pipeline preview</div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {wfForm.steps.map((step, i) => {
                      const deps = step.dependsOn.split(',').map(s => s.trim()).filter(Boolean);
                      return (
                        <div key={i} className="flex items-center gap-3">
                          <div className="w-6 h-6 rounded-lg bg-indigo-500/20 text-indigo-400 flex items-center justify-center text-xs font-bold shrink-0">{i + 1}</div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`px-2.5 py-1 rounded-lg text-xs font-medium border ${STEP_TYPE_INFO[step.type]?.color ?? 'bg-gray-800 text-gray-400'} border-current/20`}>
                              {step.name || step.id}
                            </span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded ${STEP_TYPE_INFO[step.type]?.color ?? ''}`}>
                              {STEP_TYPE_INFO[step.type]?.label ?? step.type}
                            </span>
                            {deps.length > 0 && (
                              <span className="text-xs text-gray-600">
                                <span className="text-gray-600">&#8592; </span>
                                {deps.map((d, di) => (
                                  <span key={d}>
                                    {di > 0 && ', '}
                                    <span className="text-gray-500">{d}</span>
                                  </span>
                                ))}
                              </span>
                            )}
                            {step.agentId && (
                              <span className="text-[10px] text-gray-600 font-mono">@{step.agentId}</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </Card>

            <div className="flex justify-end gap-3 pb-4">
              <button onClick={validateWorkflow} className="btn-secondary">Validate</button>
              <button onClick={runWorkflow} disabled={saving} className="btn-primary">
                {saving ? 'Starting...' : 'Start Workflow'}
              </button>
            </div>
          </div>
        )}

        {/* Team Builder */}
        {tab === 'team' && (
          <div className="space-y-5">
            <Card title="Team Definition" description="Define a team of agents that work together. Each member is created from an agent template.">
              <FormRow label="Team Name" hint="Give your team a memorable name" required>
                <input className="input-field" value={teamForm.name} onChange={e => setTeamForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Backend Development Squad" />
              </FormRow>
              <FormRow label="Description" hint="What is this team's purpose?">
                <textarea className="input-field min-h-[60px]" value={teamForm.description} onChange={e => setTeamForm(f => ({ ...f, description: e.target.value }))} placeholder="A development team for building and maintaining the backend API services..." />
              </FormRow>
              <div className="grid grid-cols-2 gap-4">
                <FormRow label="Category" hint="Team specialization area">
                  <select className="input-field" value={teamForm.category} onChange={e => setTeamForm(f => ({ ...f, category: e.target.value }))}>
                    {CATEGORIES.map(c => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
                  </select>
                </FormRow>
                <FormRow label="Tags" hint="Keywords for search and discovery">
                  <input className="input-field" value={teamForm.tags} onChange={e => setTeamForm(f => ({ ...f, tags: e.target.value }))} placeholder="agile, backend, api" />
                </FormRow>
              </div>
            </Card>

            <Card title="Team Members" description={`Add agents to your team by selecting their template. (${teamForm.members.length} member${teamForm.members.length !== 1 ? 's' : ''})`}>
              {availableTemplates.length > 0 && (
                <div className="mb-4 p-3 bg-gray-800/30 rounded-lg border border-gray-700/30">
                  <div className="text-xs text-gray-500 mb-2">Available Templates (click to add)</div>
                  <div className="flex flex-wrap gap-1.5">
                    {availableTemplates.map(t => (
                      <button
                        key={t.id}
                        onClick={() => setTeamForm(f => ({ ...f, members: [...f.members, { templateId: t.id, name: t.name, count: 1, role: (t.agentRole === 'manager' ? 'manager' : 'worker') as 'manager' | 'worker' }] }))}
                        className="px-2.5 py-1 text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 rounded-lg border border-gray-700 transition-colors"
                        title={`Add ${t.name} (${t.id})`}
                      >
                        + {t.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {teamForm.members.map((member, i) => (
                <div key={i} className="bg-gray-800/30 rounded-xl p-4 mb-3 border border-gray-700/30">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="w-6 h-6 rounded-lg bg-cyan-500/20 text-cyan-400 flex items-center justify-center text-xs font-bold">{i + 1}</span>
                      <span className="text-xs text-gray-500">Member {i + 1}</span>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-medium capitalize ${member.role === 'manager' ? 'bg-purple-500/15 text-purple-400' : 'bg-cyan-500/15 text-cyan-400'}`}>
                        {member.role}
                      </span>
                    </div>
                    {teamForm.members.length > 1 && (
                      <button onClick={() => setTeamForm(f => ({ ...f, members: f.members.filter((_, j) => j !== i) }))} className="text-red-400/60 hover:text-red-300 text-xs transition-colors">Remove</button>
                    )}
                  </div>
                  <div className="grid grid-cols-4 gap-3">
                    <div className="col-span-2">
                      <FormRow label="Template" hint="Which agent template to use">
                        {availableTemplates.length > 0 ? (
                          <select
                            className="input-field"
                            value={member.templateId}
                            onChange={e => {
                              const selected = availableTemplates.find(t => t.id === e.target.value);
                              const members = [...teamForm.members];
                              members[i] = {
                                ...members[i]!,
                                templateId: e.target.value,
                                name: selected?.name ?? members[i]!.name,
                                role: (selected?.agentRole === 'manager' ? 'manager' : 'worker') as 'manager' | 'worker',
                              };
                              setTeamForm(f => ({ ...f, members }));
                            }}
                          >
                            <option value="">Select template...</option>
                            {availableTemplates.map(t => (
                              <option key={t.id} value={t.id}>{t.name} ({t.id})</option>
                            ))}
                          </select>
                        ) : (
                          <input className="input-field" value={member.templateId} placeholder="tpl-developer" onChange={e => {
                            const members = [...teamForm.members];
                            members[i] = { ...members[i]!, templateId: e.target.value };
                            setTeamForm(f => ({ ...f, members }));
                          }} />
                        )}
                      </FormRow>
                    </div>
                    <div>
                      <FormRow label="Display Name" hint="Name for this member">
                        <input className="input-field" value={member.name} placeholder="Dev 1" onChange={e => {
                          const members = [...teamForm.members];
                          members[i] = { ...members[i]!, name: e.target.value };
                          setTeamForm(f => ({ ...f, members }));
                        }} />
                      </FormRow>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <FormRow label="Count" hint="">
                        <input type="number" min={1} max={10} className="input-field" value={member.count} onChange={e => {
                          const members = [...teamForm.members];
                          members[i] = { ...members[i]!, count: Math.max(1, Number(e.target.value) || 1) };
                          setTeamForm(f => ({ ...f, members }));
                        }} />
                      </FormRow>
                      <FormRow label="Role" hint="">
                        <select className="input-field" value={member.role} onChange={e => {
                          const members = [...teamForm.members];
                          members[i] = { ...members[i]!, role: e.target.value as 'manager' | 'worker' };
                          setTeamForm(f => ({ ...f, members }));
                        }}>
                          <option value="worker">Worker</option>
                          <option value="manager">Manager</option>
                        </select>
                      </FormRow>
                    </div>
                  </div>
                </div>
              ))}
              <button
                onClick={() => setTeamForm(f => ({ ...f, members: [...f.members, { templateId: '', name: '', count: 1, role: 'worker' }] }))}
                className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
              >
                + Add Member Manually
              </button>
            </Card>

            <div className="flex justify-end gap-3 pb-4">
              <button onClick={saveTeam} disabled={saving} className="btn-primary">
                {saving ? 'Creating...' : 'Create Team'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function buildWorkflowPayload(form: WorkflowForm) {
  return {
    id: `wf-custom-${Date.now()}`,
    name: form.name,
    description: form.description,
    version: '1.0.0',
    author: 'user',
    steps: form.steps.map(s => ({
      id: s.id,
      name: s.name,
      type: s.type,
      agentId: s.agentId || undefined,
      dependsOn: s.dependsOn.split(',').map(d => d.trim()).filter(Boolean),
      taskConfig: s.type === 'agent_task' && s.prompt ? { prompt: s.prompt } : undefined,
      condition: s.type === 'condition' && s.prompt ? { expression: s.prompt, trueBranch: [], falseBranch: [] } : undefined,
      transform: s.type === 'transform' ? s.prompt : undefined,
      delayMs: s.type === 'delay' ? (Number(s.prompt) || 1000) : undefined,
    })),
  };
}

function Card({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-gray-200">{title}</h3>
        {description && <p className="text-xs text-gray-600 mt-0.5">{description}</p>}
      </div>
      {children}
    </div>
  );
}

function FormRow({ label, hint, required, children }: { label: string; hint?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <label className="text-xs text-gray-400 mb-1.5 block">
        {label}
        {required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {children}
      {hint && <p className="text-[11px] text-gray-600 mt-1">{hint}</p>}
    </div>
  );
}
