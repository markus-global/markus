import { useState, useCallback } from 'react';

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

interface TeamForm {
  name: string;
  description: string;
  members: Array<{ templateId: string; name: string; count: number; role: 'manager' | 'worker' }>;
  tags: string;
  category: string;
}

const CATEGORIES = ['development', 'devops', 'management', 'productivity', 'general'];

function emptyStep(index: number): WorkflowStepForm {
  return { id: `step_${index}`, name: '', type: 'agent_task', agentId: '', dependsOn: '', prompt: '' };
}

export function AgentBuilder() {
  const [tab, setTab] = useState<BuilderTab>('template');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

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

  const showResult = useCallback((ok: boolean, message: string) => {
    setResult({ ok, message });
    setTimeout(() => setResult(null), 4000);
  }, []);

  const saveTemplate = useCallback(async () => {
    if (!tplForm.name.trim()) { showResult(false, 'Name is required'); return; }
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
        showResult(true, 'Template created successfully!');
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
        showResult(true, 'Workflow is valid!');
      } else {
        showResult(false, `Validation errors: ${data.errors.join(', ')}`);
      }
    } catch (err) {
      showResult(false, String(err));
    }
  }, [wfForm, showResult]);

  const runWorkflow = useCallback(async () => {
    if (!wfForm.name.trim()) { showResult(false, 'Workflow name is required'); return; }
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
    setSaving(true);
    try {
      const payload = {
        name: teamForm.name,
        description: teamForm.description,
        members: teamForm.members.filter(m => m.templateId),
        tags: teamForm.tags.split(',').map(s => s.trim()).filter(Boolean),
        category: teamForm.category,
      };
      const resp = await fetch('/api/team-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (resp.ok) {
        showResult(true, 'Team template created!');
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
          <div className={`mb-4 px-4 py-3 rounded-lg text-sm ${result.ok ? 'bg-emerald-900/50 text-emerald-300 border border-emerald-700' : 'bg-red-900/50 text-red-300 border border-red-700'}`}>
            {result.message}
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1 mb-6 bg-gray-900 rounded-lg p-1 w-fit">
          {([
            { key: 'template' as const, label: 'Agent Template', icon: '⊕' },
            { key: 'workflow' as const, label: 'Workflow', icon: '⇢' },
            { key: 'team' as const, label: 'Team', icon: '◎' },
          ]).map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${tab === t.key ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'}`}
            >
              <span className="mr-1.5">{t.icon}</span>{t.label}
            </button>
          ))}
        </div>

        {/* Template Builder */}
        {tab === 'template' && (
          <div className="space-y-4">
            <Card title="Basic Information">
              <FormRow label="Name">
                <input className="input-field" value={tplForm.name} onChange={e => setTplForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Senior Developer" />
              </FormRow>
              <FormRow label="Description">
                <textarea className="input-field min-h-[80px]" value={tplForm.description} onChange={e => setTplForm(f => ({ ...f, description: e.target.value }))} placeholder="What this agent does..." />
              </FormRow>
              <div className="grid grid-cols-2 gap-4">
                <FormRow label="Role ID">
                  <input className="input-field" value={tplForm.roleId} onChange={e => setTplForm(f => ({ ...f, roleId: e.target.value }))} placeholder="auto-generated from name" />
                </FormRow>
                <FormRow label="Agent Role">
                  <select className="input-field" value={tplForm.agentRole} onChange={e => setTplForm(f => ({ ...f, agentRole: e.target.value as 'manager' | 'worker' }))}>
                    <option value="worker">Worker</option>
                    <option value="manager">Manager</option>
                  </select>
                </FormRow>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <FormRow label="Category">
                  <select className="input-field" value={tplForm.category} onChange={e => setTplForm(f => ({ ...f, category: e.target.value }))}>
                    {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </FormRow>
                <FormRow label="Skills (comma-separated)">
                  <input className="input-field" value={tplForm.skills} onChange={e => setTplForm(f => ({ ...f, skills: e.target.value }))} placeholder="git, code-review, testing" />
                </FormRow>
              </div>
              <FormRow label="Tags (comma-separated)">
                <input className="input-field" value={tplForm.tags} onChange={e => setTplForm(f => ({ ...f, tags: e.target.value }))} placeholder="senior, backend, python" />
              </FormRow>
            </Card>

            <Card title="System Prompt">
              <textarea
                className="input-field min-h-[160px] font-mono text-xs"
                value={tplForm.systemPrompt}
                onChange={e => setTplForm(f => ({ ...f, systemPrompt: e.target.value }))}
                placeholder="You are a senior software developer specialized in..."
              />
            </Card>

            <Card title="Starter Tasks">
              {tplForm.starterTasks.map((task, i) => (
                <div key={i} className="flex gap-2 mb-2">
                  <input className="input-field flex-1" value={task.title} placeholder="Task title" onChange={e => {
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
                    <option value="medium">Med</option>
                    <option value="high">High</option>
                  </select>
                  <button onClick={() => setTplForm(f => ({ ...f, starterTasks: f.starterTasks.filter((_, j) => j !== i) }))} className="text-red-400 hover:text-red-300 px-2">✕</button>
                </div>
              ))}
              <button
                onClick={() => setTplForm(f => ({ ...f, starterTasks: [...f.starterTasks, { title: '', description: '', priority: 'medium' }] }))}
                className="text-sm text-indigo-400 hover:text-indigo-300"
              >
                + Add Starter Task
              </button>
            </Card>

            <div className="flex justify-end gap-3">
              <button onClick={saveTemplate} disabled={saving} className="btn-primary">
                {saving ? 'Creating...' : 'Create Template'}
              </button>
            </div>
          </div>
        )}

        {/* Workflow Builder */}
        {tab === 'workflow' && (
          <div className="space-y-4">
            <Card title="Workflow Definition">
              <FormRow label="Name">
                <input className="input-field" value={wfForm.name} onChange={e => setWfForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Code Review Pipeline" />
              </FormRow>
              <FormRow label="Description">
                <textarea className="input-field min-h-[60px]" value={wfForm.description} onChange={e => setWfForm(f => ({ ...f, description: e.target.value }))} placeholder="What this workflow does..." />
              </FormRow>
            </Card>

            <Card title="Steps">
              {wfForm.steps.map((step, i) => (
                <div key={step.id} className="bg-gray-800/50 rounded-lg p-4 mb-3 border border-gray-700/50">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-mono text-gray-500">Step {i + 1}: {step.id}</span>
                    {wfForm.steps.length > 1 && (
                      <button onClick={() => setWfForm(f => ({ ...f, steps: f.steps.filter((_, j) => j !== i) }))} className="text-red-400 hover:text-red-300 text-xs">Remove</button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <FormRow label="Name">
                      <input className="input-field" value={step.name} onChange={e => updateStep(i, 'name', e.target.value)} placeholder="Step name" />
                    </FormRow>
                    <FormRow label="Type">
                      <select className="input-field" value={step.type} onChange={e => updateStep(i, 'type', e.target.value)}>
                        <option value="agent_task">Agent Task</option>
                        <option value="condition">Condition</option>
                        <option value="transform">Transform</option>
                        <option value="delay">Delay</option>
                      </select>
                    </FormRow>
                  </div>
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <FormRow label="Agent ID">
                      <input className="input-field" value={step.agentId} onChange={e => updateStep(i, 'agentId', e.target.value)} placeholder="agent-id (for agent_task)" />
                    </FormRow>
                    <FormRow label="Depends On (comma)">
                      <input className="input-field" value={step.dependsOn} onChange={e => updateStep(i, 'dependsOn', e.target.value)} placeholder="step_0, step_1" />
                    </FormRow>
                  </div>
                  <FormRow label="Prompt / Expression">
                    <textarea className="input-field min-h-[60px] font-mono text-xs" value={step.prompt} onChange={e => updateStep(i, 'prompt', e.target.value)} placeholder={step.type === 'agent_task' ? 'Task description or prompt template...' : step.type === 'condition' ? 'steps.prev.output.approved === true' : 'Expression...'} />
                  </FormRow>
                </div>
              ))}
              <button
                onClick={() => setWfForm(f => ({ ...f, steps: [...f.steps, emptyStep(f.steps.length)] }))}
                className="text-sm text-indigo-400 hover:text-indigo-300"
              >
                + Add Step
              </button>
            </Card>

            {/* Workflow DAG Preview */}
            <Card title="DAG Preview">
              <div className="bg-gray-800/30 rounded-lg p-4 font-mono text-xs text-gray-400 min-h-[80px]">
                {wfForm.steps.map((step, i) => {
                  const deps = step.dependsOn.split(',').map(s => s.trim()).filter(Boolean);
                  return (
                    <div key={i} className="mb-1">
                      <span className="text-indigo-400">{step.id}</span>
                      <span className="text-gray-600"> ({step.type})</span>
                      {deps.length > 0 && (
                        <span className="text-gray-500"> ← {deps.join(', ')}</span>
                      )}
                      {step.name && <span className="text-gray-600 ml-2">"{step.name}"</span>}
                    </div>
                  );
                })}
              </div>
            </Card>

            <div className="flex justify-end gap-3">
              <button onClick={validateWorkflow} className="btn-secondary">Validate</button>
              <button onClick={runWorkflow} disabled={saving} className="btn-primary">
                {saving ? 'Starting...' : 'Start Workflow'}
              </button>
            </div>
          </div>
        )}

        {/* Team Builder */}
        {tab === 'team' && (
          <div className="space-y-4">
            <Card title="Team Definition">
              <FormRow label="Team Name">
                <input className="input-field" value={teamForm.name} onChange={e => setTeamForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Dev Squad" />
              </FormRow>
              <FormRow label="Description">
                <textarea className="input-field min-h-[60px]" value={teamForm.description} onChange={e => setTeamForm(f => ({ ...f, description: e.target.value }))} placeholder="Team purpose..." />
              </FormRow>
              <div className="grid grid-cols-2 gap-4">
                <FormRow label="Category">
                  <select className="input-field" value={teamForm.category} onChange={e => setTeamForm(f => ({ ...f, category: e.target.value }))}>
                    {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </FormRow>
                <FormRow label="Tags (comma-separated)">
                  <input className="input-field" value={teamForm.tags} onChange={e => setTeamForm(f => ({ ...f, tags: e.target.value }))} placeholder="agile, sprint" />
                </FormRow>
              </div>
            </Card>

            <Card title="Team Members">
              {teamForm.members.map((member, i) => (
                <div key={i} className="flex gap-2 mb-2 items-end">
                  <div className="flex-1">
                    <label className="text-xs text-gray-500 mb-1 block">Template ID</label>
                    <input className="input-field" value={member.templateId} placeholder="tpl-developer" onChange={e => {
                      const members = [...teamForm.members];
                      members[i] = { ...members[i]!, templateId: e.target.value };
                      setTeamForm(f => ({ ...f, members }));
                    }} />
                  </div>
                  <div className="w-28">
                    <label className="text-xs text-gray-500 mb-1 block">Name</label>
                    <input className="input-field" value={member.name} placeholder="Dev 1" onChange={e => {
                      const members = [...teamForm.members];
                      members[i] = { ...members[i]!, name: e.target.value };
                      setTeamForm(f => ({ ...f, members }));
                    }} />
                  </div>
                  <div className="w-16">
                    <label className="text-xs text-gray-500 mb-1 block">Count</label>
                    <input type="number" min={1} className="input-field" value={member.count} onChange={e => {
                      const members = [...teamForm.members];
                      members[i] = { ...members[i]!, count: Number(e.target.value) || 1 };
                      setTeamForm(f => ({ ...f, members }));
                    }} />
                  </div>
                  <div className="w-24">
                    <label className="text-xs text-gray-500 mb-1 block">Role</label>
                    <select className="input-field" value={member.role} onChange={e => {
                      const members = [...teamForm.members];
                      members[i] = { ...members[i]!, role: e.target.value as 'manager' | 'worker' };
                      setTeamForm(f => ({ ...f, members }));
                    }}>
                      <option value="worker">Worker</option>
                      <option value="manager">Manager</option>
                    </select>
                  </div>
                  {teamForm.members.length > 1 && (
                    <button onClick={() => setTeamForm(f => ({ ...f, members: f.members.filter((_, j) => j !== i) }))} className="text-red-400 hover:text-red-300 px-2 pb-2">✕</button>
                  )}
                </div>
              ))}
              <button
                onClick={() => setTeamForm(f => ({ ...f, members: [...f.members, { templateId: '', name: '', count: 1, role: 'worker' }] }))}
                className="text-sm text-indigo-400 hover:text-indigo-300"
              >
                + Add Member
              </button>
            </Card>

            <div className="flex justify-end gap-3">
              <button onClick={saveTeam} disabled={saving} className="btn-primary">
                {saving ? 'Creating...' : 'Create Team'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  function updateStep(index: number, field: keyof WorkflowStepForm, value: string) {
    setWfForm(f => ({
      ...f,
      steps: f.steps.map((s, i) => i === index ? { ...s, [field]: value } : s),
    }));
  }
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

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
      <h3 className="text-sm font-semibold text-gray-300 mb-4">{title}</h3>
      {children}
    </div>
  );
}

function FormRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <label className="text-xs text-gray-500 mb-1.5 block">{label}</label>
      {children}
    </div>
  );
}
