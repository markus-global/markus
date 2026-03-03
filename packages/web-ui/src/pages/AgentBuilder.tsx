import { useState, useCallback, useEffect } from 'react';
import { api, type AgentInfo } from '../api.ts';

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
  dependsOn: string[];
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
  description?: string;
}

const CATEGORIES = ['development', 'devops', 'management', 'productivity', 'general'];

const STEP_TYPES: Record<string, { label: string; icon: string; hint: string; color: string }> = {
  agent_task: { label: 'Agent Task', icon: '⊕', hint: 'An agent executes a task', color: 'bg-blue-500/15 text-blue-400 border-blue-500/20' },
  condition: { label: 'Condition', icon: '◇', hint: 'Branch based on a condition', color: 'bg-amber-500/15 text-amber-400 border-amber-500/20' },
  transform: { label: 'Transform', icon: '⟳', hint: 'Transform data between steps', color: 'bg-green-500/15 text-green-400 border-green-500/20' },
  delay: { label: 'Delay', icon: '◔', hint: 'Pause for a duration', color: 'bg-gray-500/15 text-gray-400 border-gray-500/20' },
};

const TAB_CONFIG = [
  { key: 'template' as const, label: 'Agent Template', icon: '⊕', desc: 'Create reusable agent blueprints' },
  { key: 'workflow' as const, label: 'Workflow', icon: '⇢', desc: 'Build multi-step pipelines' },
  { key: 'team' as const, label: 'Team', icon: '◎', desc: 'Compose agent teams' },
];

function emptyStep(index: number): WorkflowStepForm {
  return { id: `step_${index}`, name: '', type: 'agent_task', agentId: '', dependsOn: [], prompt: '' };
}

export function AgentBuilder() {
  const [tab, setTab] = useState<BuilderTab>('template');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [availableTemplates, setAvailableTemplates] = useState<AvailableTemplate[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);

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
      .then((d: { templates: AvailableTemplate[] }) => setAvailableTemplates(d.templates ?? []))
      .catch(() => {});
    api.agents.list()
      .then(d => setAgents(d.agents))
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
        showResult(true, 'Template created! Find it in the Template Marketplace.');
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
      if (data.valid) showResult(true, 'Workflow is valid and ready to run!');
      else showResult(false, `Validation errors: ${data.errors.join(', ')}`);
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
      if (resp.ok) showResult(true, `Workflow started: ${data.executionId} (${data.status})`);
      else showResult(false, data.error ?? 'Failed to start workflow');
    } catch (err) {
      showResult(false, String(err));
    } finally {
      setSaving(false);
    }
  }, [wfForm, showResult]);

  const saveTeam = useCallback(async () => {
    if (!teamForm.name.trim()) { showResult(false, 'Team name is required'); return; }
    const validMembers = teamForm.members.filter(m => m.templateId);
    if (validMembers.length === 0) { showResult(false, 'Add at least one member with a template'); return; }
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
        showResult(true, 'Team template created! Find it in the Template Marketplace under Team Templates.');
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

  function updateStep(index: number, patch: Partial<WorkflowStepForm>) {
    setWfForm(f => ({
      ...f,
      steps: f.steps.map((s, i) => i === index ? { ...s, ...patch } : s),
    }));
  }

  function toggleStepDep(stepIndex: number, depId: string) {
    setWfForm(f => ({
      ...f,
      steps: f.steps.map((s, i) => {
        if (i !== stepIndex) return s;
        const deps = s.dependsOn.includes(depId)
          ? s.dependsOn.filter(d => d !== depId)
          : [...s.dependsOn, depId];
        return { ...s, dependsOn: deps };
      }),
    }));
  }

  return (
    <div className="h-full overflow-y-auto p-6 bg-gray-950">
      <div className="max-w-4xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white mb-1">Builder</h1>
          <p className="text-gray-500 text-sm">Create custom agent templates, workflows, and team compositions</p>
        </div>

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

        {/* ── TEMPLATE BUILDER ─────────────────────────────────────────── */}
        {tab === 'template' && (
          <div className="space-y-5">
            <Card title="Basic Information">
              <div className="grid grid-cols-2 gap-4">
                <FormRow label="Name" required>
                  <input className="input-field" value={tplForm.name} onChange={e => setTplForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Senior Backend Developer" />
                </FormRow>
                <FormRow label="Agent Role">
                  <div className="flex gap-2">
                    {(['worker', 'manager'] as const).map(r => (
                      <button
                        key={r}
                        onClick={() => setTplForm(f => ({ ...f, agentRole: r }))}
                        className={`flex-1 py-2 px-3 rounded-lg text-xs font-medium border transition-colors capitalize ${
                          tplForm.agentRole === r
                            ? r === 'manager' ? 'bg-purple-500/15 text-purple-400 border-purple-500/30' : 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30'
                            : 'bg-gray-800 text-gray-500 border-gray-700 hover:border-gray-600'
                        }`}
                      >
                        {r === 'manager' ? '★ Manager' : '◆ Worker'}
                      </button>
                    ))}
                  </div>
                </FormRow>
              </div>
              <FormRow label="Description" required>
                <textarea className="input-field min-h-[70px]" value={tplForm.description} onChange={e => setTplForm(f => ({ ...f, description: e.target.value }))} placeholder="What does this agent specialize in? Describe its expertise and responsibilities..." />
              </FormRow>
              <div className="grid grid-cols-3 gap-4">
                <FormRow label="Category">
                  <select className="input-field" value={tplForm.category} onChange={e => setTplForm(f => ({ ...f, category: e.target.value }))}>
                    {CATEGORIES.map(c => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
                  </select>
                </FormRow>
                <FormRow label="Skills" hint="comma-separated">
                  <input className="input-field" value={tplForm.skills} onChange={e => setTplForm(f => ({ ...f, skills: e.target.value }))} placeholder="git, code-analysis" />
                </FormRow>
                <FormRow label="Tags" hint="comma-separated">
                  <input className="input-field" value={tplForm.tags} onChange={e => setTplForm(f => ({ ...f, tags: e.target.value }))} placeholder="senior, backend" />
                </FormRow>
              </div>
            </Card>

            <Card title="System Prompt" hint="The core instructions that define this agent's behavior">
              <textarea
                className="input-field min-h-[140px] font-mono text-xs leading-relaxed"
                value={tplForm.systemPrompt}
                onChange={e => setTplForm(f => ({ ...f, systemPrompt: e.target.value }))}
                placeholder={"You are a senior backend developer specialized in:\n- Node.js / TypeScript microservices\n- PostgreSQL database design\n- REST & GraphQL API development\n\nYou write clean, well-tested code and always consider edge cases..."}
              />
            </Card>

            <Card title="Starter Tasks" hint="Pre-defined tasks for onboarding — shown when the agent is first hired">
              {tplForm.starterTasks.map((task, i) => (
                <div key={i} className="flex gap-2 mb-2 items-center">
                  <input className="input-field flex-1" value={task.title} placeholder="e.g. Set up project scaffolding" onChange={e => {
                    const tasks = [...tplForm.starterTasks];
                    tasks[i] = { ...tasks[i]!, title: e.target.value };
                    setTplForm(f => ({ ...f, starterTasks: tasks }));
                  }} />
                  <select className="input-field w-24" value={task.priority} onChange={e => {
                    const tasks = [...tplForm.starterTasks];
                    tasks[i] = { ...tasks[i]!, priority: e.target.value as 'low' | 'medium' | 'high' };
                    setTplForm(f => ({ ...f, starterTasks: tasks }));
                  }}>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                  <button onClick={() => setTplForm(f => ({ ...f, starterTasks: f.starterTasks.filter((_, j) => j !== i) }))} className="text-red-400 hover:text-red-300 px-1.5 text-lg">&times;</button>
                </div>
              ))}
              <button
                onClick={() => setTplForm(f => ({ ...f, starterTasks: [...f.starterTasks, { title: '', description: '', priority: 'medium' }] }))}
                className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
              >
                + Add Starter Task
              </button>
            </Card>

            <ActionBar>
              <button onClick={saveTemplate} disabled={saving} className="btn-primary">
                {saving ? 'Creating...' : 'Create Template'}
              </button>
            </ActionBar>
          </div>
        )}

        {/* ── WORKFLOW BUILDER ──────────────────────────────────────────── */}
        {tab === 'workflow' && (
          <div className="space-y-5">
            <Card title="Workflow Definition">
              <div className="grid grid-cols-2 gap-4">
                <FormRow label="Name" required>
                  <input className="input-field" value={wfForm.name} onChange={e => setWfForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Code Review Pipeline" />
                </FormRow>
                <FormRow label="Description">
                  <input className="input-field" value={wfForm.description} onChange={e => setWfForm(f => ({ ...f, description: e.target.value }))} placeholder="What does this workflow accomplish?" />
                </FormRow>
              </div>
            </Card>

            <Card title={`Steps (${wfForm.steps.length})`} hint="Define each step. Steps can depend on others to form a pipeline.">
              {wfForm.steps.map((step, i) => (
                <div key={step.id} className="bg-gray-800/30 rounded-xl p-4 mb-3 border border-gray-700/30">
                  {/* Step header */}
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="w-7 h-7 rounded-lg bg-indigo-500/20 text-indigo-400 flex items-center justify-center text-xs font-bold">{i + 1}</span>
                      <span className="text-xs font-mono text-gray-600">{step.id}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {/* Step type selector — visual toggle instead of dropdown */}
                      {Object.entries(STEP_TYPES).map(([val, info]) => (
                        <button
                          key={val}
                          onClick={() => updateStep(i, { type: val as WorkflowStepForm['type'] })}
                          title={info.hint}
                          className={`px-2 py-1 rounded text-[10px] font-medium border transition-colors ${
                            step.type === val ? info.color : 'bg-gray-800 text-gray-600 border-gray-700 hover:border-gray-600'
                          }`}
                        >
                          {info.icon} {info.label}
                        </button>
                      ))}
                      {wfForm.steps.length > 1 && (
                        <button onClick={() => setWfForm(f => ({ ...f, steps: f.steps.filter((_, j) => j !== i) }))} className="text-red-400/50 hover:text-red-300 text-xs ml-2">&times;</button>
                      )}
                    </div>
                  </div>

                  {/* Step body */}
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <FormRow label="Step Name">
                      <input className="input-field" value={step.name} onChange={e => updateStep(i, { name: e.target.value })} placeholder={
                        step.type === 'agent_task' ? 'e.g. Analyze code' : step.type === 'condition' ? 'e.g. Check approval' : step.type === 'delay' ? 'e.g. Wait for review' : 'e.g. Format output'
                      } />
                    </FormRow>
                    {step.type === 'agent_task' ? (
                      <FormRow label="Assigned Agent">
                        <select
                          className="input-field"
                          value={step.agentId}
                          onChange={e => updateStep(i, { agentId: e.target.value })}
                        >
                          <option value="">Select an agent...</option>
                          {agents.map(a => (
                            <option key={a.id} value={a.id}>{a.name} — {a.role}</option>
                          ))}
                        </select>
                      </FormRow>
                    ) : (
                      <FormRow label={step.type === 'delay' ? 'Duration' : 'Expression'}>
                        <input
                          className="input-field font-mono text-xs"
                          value={step.type === 'delay' ? step.prompt : ''}
                          onChange={e => updateStep(i, { prompt: e.target.value })}
                          placeholder={step.type === 'delay' ? '5000 (ms)' : ''}
                          disabled={step.type !== 'delay'}
                        />
                      </FormRow>
                    )}
                  </div>

                  {/* Dependencies — clickable chips */}
                  {i > 0 && (
                    <div className="mb-3">
                      <label className="text-[11px] text-gray-500 mb-1.5 block">Depends on</label>
                      <div className="flex flex-wrap gap-1.5">
                        {wfForm.steps.slice(0, i).map((prev, pi) => {
                          const isSelected = step.dependsOn.includes(prev.id);
                          return (
                            <button
                              key={prev.id}
                              onClick={() => toggleStepDep(i, prev.id)}
                              className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-all ${
                                isSelected
                                  ? 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30'
                                  : 'bg-gray-800 text-gray-600 border-gray-700 hover:border-gray-600 hover:text-gray-400'
                              }`}
                            >
                              {isSelected ? '✓ ' : ''}{pi + 1}. {prev.name || prev.id}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Task prompt — only for agent_task, condition, transform */}
                  {step.type !== 'delay' && (
                    <FormRow label={step.type === 'condition' ? 'Condition Expression' : step.type === 'transform' ? 'Transform Expression' : 'Task Prompt'}>
                      <textarea
                        className="input-field min-h-[60px] font-mono text-xs"
                        value={step.prompt}
                        onChange={e => updateStep(i, { prompt: e.target.value })}
                        placeholder={
                          step.type === 'condition' ? 'steps.step_0.output.approved === true'
                          : step.type === 'transform' ? '({ summary: steps.step_0.output.result })'
                          : 'Describe what the agent should do in this step...'
                        }
                      />
                    </FormRow>
                  )}
                </div>
              ))}
              <button
                onClick={() => setWfForm(f => ({ ...f, steps: [...f.steps, emptyStep(f.steps.length)] }))}
                className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
              >
                + Add Step
              </button>
            </Card>

            {/* Pipeline Preview */}
            <Card title="Pipeline Preview">
              <div className="bg-gray-800/20 rounded-lg p-4 min-h-[50px]">
                {wfForm.steps.length === 0 ? (
                  <div className="text-center text-gray-600 text-sm py-2">Add steps to see the pipeline</div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    {wfForm.steps.map((step, i) => {
                      const info = STEP_TYPES[step.type];
                      const agent = agents.find(a => a.id === step.agentId);
                      return (
                        <div key={step.id} className="flex items-center gap-2">
                          {i > 0 && <span className="text-gray-600 text-lg">→</span>}
                          <div className={`px-3 py-2 rounded-lg border text-xs ${info?.color ?? 'bg-gray-800 text-gray-400'}`}>
                            <div className="font-medium">{step.name || step.id}</div>
                            {agent && <div className="text-[10px] opacity-60 mt-0.5">@{agent.name}</div>}
                            {step.dependsOn.length > 1 && <div className="text-[10px] opacity-50 mt-0.5">waits for {step.dependsOn.length} steps</div>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </Card>

            <ActionBar>
              <button onClick={validateWorkflow} className="btn-secondary">Validate</button>
              <button onClick={runWorkflow} disabled={saving} className="btn-primary">
                {saving ? 'Starting...' : 'Start Workflow'}
              </button>
            </ActionBar>
          </div>
        )}

        {/* ── TEAM BUILDER ─────────────────────────────────────────────── */}
        {tab === 'team' && (
          <div className="space-y-5">
            <Card title="Team Definition">
              <div className="grid grid-cols-2 gap-4">
                <FormRow label="Team Name" required>
                  <input className="input-field" value={teamForm.name} onChange={e => setTeamForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Marketing Department" />
                </FormRow>
                <FormRow label="Category">
                  <select className="input-field" value={teamForm.category} onChange={e => setTeamForm(f => ({ ...f, category: e.target.value }))}>
                    {CATEGORIES.map(c => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
                  </select>
                </FormRow>
              </div>
              <FormRow label="Description">
                <textarea className="input-field min-h-[60px]" value={teamForm.description} onChange={e => setTeamForm(f => ({ ...f, description: e.target.value }))} placeholder="What is this team responsible for?" />
              </FormRow>
              <FormRow label="Tags" hint="comma-separated">
                <input className="input-field" value={teamForm.tags} onChange={e => setTeamForm(f => ({ ...f, tags: e.target.value }))} placeholder="marketing, content, seo" />
              </FormRow>
            </Card>

            <Card title={`Members (${teamForm.members.filter(m => m.templateId).length})`} hint="Click a template below to add it, or configure members manually.">
              {/* Quick-add palette */}
              {availableTemplates.length > 0 && (
                <div className="mb-4 p-3 bg-gray-800/20 rounded-lg border border-gray-700/20">
                  <div className="text-[11px] text-gray-500 mb-2 font-medium uppercase tracking-wider">Quick Add</div>
                  <div className="flex flex-wrap gap-1.5">
                    {availableTemplates.map(t => (
                      <button
                        key={t.id}
                        onClick={() => setTeamForm(f => ({ ...f, members: [...f.members, { templateId: t.id, name: t.name, count: 1, role: (t.agentRole === 'manager' ? 'manager' : 'worker') as 'manager' | 'worker' }] }))}
                        className="px-2.5 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 rounded-lg border border-gray-700 hover:border-gray-600 transition-colors"
                      >
                        + {t.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {teamForm.members.map((member, i) => (
                <div key={i} className="bg-gray-800/20 rounded-xl p-4 mb-2.5 border border-gray-700/20">
                  <div className="flex items-center gap-3">
                    {/* Number + role badge */}
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 ${
                      member.role === 'manager' ? 'bg-purple-500/20 text-purple-400' : 'bg-cyan-500/20 text-cyan-400'
                    }`}>
                      {member.role === 'manager' ? '★' : (i + 1)}
                    </div>

                    {/* Template selector */}
                    <div className="flex-1 min-w-0">
                      {availableTemplates.length > 0 ? (
                        <select
                          className="input-field"
                          value={member.templateId}
                          onChange={e => {
                            const sel = availableTemplates.find(t => t.id === e.target.value);
                            const members = [...teamForm.members];
                            members[i] = {
                              ...members[i]!,
                              templateId: e.target.value,
                              name: sel?.name ?? members[i]!.name,
                              role: (sel?.agentRole === 'manager' ? 'manager' : 'worker') as 'manager' | 'worker',
                            };
                            setTeamForm(f => ({ ...f, members }));
                          }}
                        >
                          <option value="">Select template...</option>
                          {availableTemplates.map(t => (
                            <option key={t.id} value={t.id}>{t.name}</option>
                          ))}
                        </select>
                      ) : (
                        <input className="input-field" value={member.templateId} placeholder="tpl-developer" onChange={e => {
                          const members = [...teamForm.members];
                          members[i] = { ...members[i]!, templateId: e.target.value };
                          setTeamForm(f => ({ ...f, members }));
                        }} />
                      )}
                    </div>

                    {/* Display name */}
                    <input className="input-field w-36" value={member.name} placeholder="Display name" onChange={e => {
                      const members = [...teamForm.members];
                      members[i] = { ...members[i]!, name: e.target.value };
                      setTeamForm(f => ({ ...f, members }));
                    }} />

                    {/* Count */}
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] text-gray-600">×</span>
                      <input type="number" min={1} max={10} className="input-field w-14 text-center" value={member.count} onChange={e => {
                        const members = [...teamForm.members];
                        members[i] = { ...members[i]!, count: Math.max(1, Number(e.target.value) || 1) };
                        setTeamForm(f => ({ ...f, members }));
                      }} />
                    </div>

                    {/* Role toggle */}
                    <button
                      onClick={() => {
                        const members = [...teamForm.members];
                        members[i] = { ...members[i]!, role: member.role === 'manager' ? 'worker' : 'manager' };
                        setTeamForm(f => ({ ...f, members }));
                      }}
                      className={`px-2 py-1 rounded text-[10px] font-medium border transition-colors capitalize ${
                        member.role === 'manager' ? 'bg-purple-500/15 text-purple-400 border-purple-500/20' : 'bg-cyan-500/15 text-cyan-400 border-cyan-500/20'
                      }`}
                      title="Click to toggle role"
                    >
                      {member.role}
                    </button>

                    {/* Remove */}
                    {teamForm.members.length > 1 && (
                      <button onClick={() => setTeamForm(f => ({ ...f, members: f.members.filter((_, j) => j !== i) }))} className="text-red-400/50 hover:text-red-300 text-sm">&times;</button>
                    )}
                  </div>
                </div>
              ))}
              <button
                onClick={() => setTeamForm(f => ({ ...f, members: [...f.members, { templateId: '', name: '', count: 1, role: 'worker' }] }))}
                className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
              >
                + Add Member
              </button>
            </Card>

            {/* Team Summary */}
            {teamForm.members.some(m => m.templateId) && (
              <Card title="Team Summary">
                <div className="flex items-center gap-4 text-sm">
                  <div className="text-gray-400">
                    <span className="text-white font-semibold">{teamForm.members.reduce((s, m) => s + (m.templateId ? m.count : 0), 0)}</span> agents
                  </div>
                  {teamForm.members.some(m => m.role === 'manager') && (
                    <div className="text-purple-400 text-xs">
                      ★ {teamForm.members.filter(m => m.role === 'manager' && m.templateId).map(m => m.name || m.templateId).join(', ')}
                    </div>
                  )}
                  <div className="ml-auto flex flex-wrap gap-1">
                    {teamForm.members.filter(m => m.templateId).map((m, i) => (
                      <span key={i} className={`px-2 py-0.5 text-[10px] rounded-full border ${
                        m.role === 'manager' ? 'bg-purple-500/10 text-purple-400 border-purple-500/15' : 'bg-cyan-500/10 text-cyan-400 border-cyan-500/15'
                      }`}>
                        {m.name || m.templateId}{m.count > 1 ? ` ×${m.count}` : ''}
                      </span>
                    ))}
                  </div>
                </div>
              </Card>
            )}

            <ActionBar>
              <button onClick={saveTeam} disabled={saving} className="btn-primary">
                {saving ? 'Creating...' : 'Create Team Template'}
              </button>
            </ActionBar>
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
      dependsOn: s.dependsOn,
      taskConfig: s.type === 'agent_task' && s.prompt ? { prompt: s.prompt } : undefined,
      condition: s.type === 'condition' && s.prompt ? { expression: s.prompt, trueBranch: [], falseBranch: [] } : undefined,
      transform: s.type === 'transform' ? s.prompt : undefined,
      delayMs: s.type === 'delay' ? (Number(s.prompt) || 1000) : undefined,
    })),
  };
}

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-gray-200">{title}</h3>
        {hint && <p className="text-xs text-gray-600 mt-0.5">{hint}</p>}
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
        {hint && <span className="text-gray-600 ml-1.5 font-normal">{hint}</span>}
      </label>
      {children}
    </div>
  );
}

function ActionBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-end gap-3 pb-6">
      {children}
    </div>
  );
}
