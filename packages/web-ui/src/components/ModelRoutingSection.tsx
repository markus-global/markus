import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { TaskRoutingConfigDTO, ModelTaskTypeDTO, TaskModelAssignmentDTO } from '../api';
import { ModelSelect, type ModelOption } from './ModelSelect';

interface Props {
  onSave: (data: { taskRouting?: Partial<TaskRoutingConfigDTO>; routingDefaultModel?: { provider: string; model: string } | null }) => Promise<void>;
  configuredProviders: Array<{ name: string; displayName?: string; model: string; models?: Array<{ id: string; name: string }> }>;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const DEBOUNCE_MS = 500;

const TASK_GROUPS: { groupKey: string; tasks: ModelTaskTypeDTO[] }[] = [
  { groupKey: 'text', tasks: ['text_chat', 'text_reasoning', 'text_coding', 'text_translation', 'text_summary'] },
  { groupKey: 'image', tasks: ['image_recognition', 'image_generation'] },
  { groupKey: 'audio', tasks: ['audio_tts', 'audio_stt'] },
  { groupKey: 'video', tasks: ['video_generation'] },
];

interface Suggestion {
  provider: string;
  model: string;
  tier?: string;
}

export function ModelRoutingSection({ onSave, configuredProviders }: Props) {
  const { t } = useTranslation('settings');
  const [assignments, setAssignments] = useState<Partial<Record<ModelTaskTypeDTO, TaskModelAssignmentDTO>>>({});
  const [defaultModel, setDefaultModel] = useState<{ provider: string; model: string } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [fullModelList, setFullModelList] = useState<ModelOption[] | null>(null);
  const [suggestions, setSuggestions] = useState<Record<string, Suggestion | null>>({});
  const [suggestionsLoaded, setSuggestionsLoaded] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<{ taskRouting?: Partial<TaskRoutingConfigDTO>; routingDefaultModel?: { provider: string; model: string } | null } | null>(null);
  const autoFillDone = useRef(false);

  // Load current routing settings
  useEffect(() => {
    fetch('/api/settings/llm/routing', { credentials: 'include' })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data: { taskRouting?: TaskRoutingConfigDTO; routingDefaultModel?: { provider: string; model: string } | null }) => {
        if (data.taskRouting?.assignments) {
          const cleaned = cleanStaleAssignments(data.taskRouting.assignments, configuredProviders);
          setAssignments(cleaned);
        }
        if (data.routingDefaultModel) setDefaultModel(data.routingDefaultModel);
        setLoaded(true);
      })
      .catch(e => { setLoadError(String(e)); setLoaded(true); });
  }, [configuredProviders]);

  // Load full model catalog
  useEffect(() => {
    fetch('/api/models/routing-candidates', { credentials: 'include' })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data: { providers: Array<{ provider: string; displayName: string; models: Array<{ id: string; name: string; tier?: string; qualityScore?: number; costTier?: string; capabilities?: string[] }> }> }) => {
        const models: ModelOption[] = [];
        for (const prov of data.providers) {
          for (const m of prov.models) {
            models.push({
              provider: prov.provider,
              providerLabel: prov.displayName,
              modelId: m.id,
              modelName: m.name,
              tier: m.tier,
              qualityScore: m.qualityScore,
              costTier: m.costTier,
              capabilities: m.capabilities,
            });
          }
        }
        setFullModelList(models);
      })
      .catch(() => setFullModelList(null));
  }, []);

  // Load suggested assignments for auto-prefill
  useEffect(() => {
    fetch('/api/models/suggested-assignments', { credentials: 'include' })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data: { suggestions: Record<string, Suggestion | null> }) => {
        setSuggestions(data.suggestions);
        setSuggestionsLoaded(true);
      })
      .catch(() => setSuggestionsLoaded(true));
  }, []);

  // Auto-prefill: if no assignments exist, use suggestions
  useEffect(() => {
    if (!loaded || !suggestionsLoaded || autoFillDone.current) return;
    autoFillDone.current = true;

    const hasAnyAssignment = Object.keys(assignments).length > 0;
    if (hasAnyAssignment) return;

    const newAssignments: Partial<Record<ModelTaskTypeDTO, TaskModelAssignmentDTO>> = {};
    for (const [taskType, suggestion] of Object.entries(suggestions)) {
      if (suggestion) {
        newAssignments[taskType as ModelTaskTypeDTO] = { provider: suggestion.provider, model: suggestion.model };
      }
    }
    if (Object.keys(newAssignments).length > 0) {
      setAssignments(newAssignments);
      // Also set default model from text_chat suggestion if not already set
      if (!defaultModel && newAssignments.text_chat) {
        setDefaultModel({ provider: newAssignments.text_chat.provider, model: newAssignments.text_chat.model });
        doSave({ taskRouting: { assignments: newAssignments }, routingDefaultModel: { provider: newAssignments.text_chat.provider, model: newAssignments.text_chat.model } });
      } else {
        doSave({ taskRouting: { assignments: newAssignments } });
      }
    }
  }, [loaded, suggestionsLoaded, assignments, suggestions, defaultModel]);

  const doSave = useCallback((payload: { taskRouting?: Partial<TaskRoutingConfigDTO>; routingDefaultModel?: { provider: string; model: string } | null }) => {
    setSaveStatus('saving');
    onSave(payload)
      .then(() => { setSaveStatus('saved'); setTimeout(() => setSaveStatus(prev => prev === 'saved' ? 'idle' : prev), 2000); })
      .catch(() => { setSaveStatus('error'); setTimeout(() => setSaveStatus(prev => prev === 'error' ? 'idle' : prev), 3000); });
  }, [onSave]);

  const debouncedSave = useCallback((newAssignments?: Partial<Record<ModelTaskTypeDTO, TaskModelAssignmentDTO>>, rdm?: { provider: string; model: string } | null) => {
    pendingSaveRef.current = {
      taskRouting: newAssignments !== undefined ? { assignments: newAssignments } : pendingSaveRef.current?.taskRouting,
      routingDefaultModel: rdm !== undefined ? rdm : pendingSaveRef.current?.routingDefaultModel,
    };
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const payload = pendingSaveRef.current;
      pendingSaveRef.current = null;
      if (!payload) return;
      doSave(payload);
    }, DEBOUNCE_MS);
  }, [doSave]);

  const fallbackModels: ModelOption[] = useMemo(() => configuredProviders.flatMap(p =>
    (p.models ?? [{ id: p.model, name: p.model }]).map(m => ({
      provider: p.name,
      providerLabel: p.displayName ?? p.name,
      modelId: m.id,
      modelName: m.name,
    })),
  ), [configuredProviders]);

  const allModels = fullModelList ?? fallbackModels;

  if (!loaded) {
    return (
      <div className="space-y-4">
        <div className="bg-surface-elevated rounded-xl p-5 animate-pulse">
          <div className="h-4 bg-surface-overlay rounded w-1/3 mb-3" />
          <div className="h-3 bg-surface-overlay rounded w-2/3 mb-4" />
          <div className="space-y-2">
            {[1, 2, 3, 4, 5].map(i => <div key={i} className="h-10 bg-surface-overlay rounded-lg" />)}
          </div>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-xs text-red-400">
        {t('modelRouting.loadError', { error: loadError })}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SaveIndicator status={saveStatus} t={t} />

      {/* Default / Fallback Model */}
      <div className="bg-surface-elevated rounded-xl p-5 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-fg-primary">{t('modelRouting.defaultModelTitle')}</h3>
          <p className="text-xs text-fg-tertiary mt-1">{t('modelRouting.defaultModelDesc')}</p>
        </div>
        <div className="max-w-md">
          <ModelSelect
            value={defaultModel ? `${defaultModel.provider}/${defaultModel.model}` : ''}
            options={allModels}
            placeholder={t('modelRouting.defaultModelPlaceholder')}
            onChange={val => {
              if (!val) {
                setDefaultModel(null);
                debouncedSave(undefined, null);
              } else {
                const [provider, ...modelParts] = val.split('/');
                const newDefault = { provider, model: modelParts.join('/') };
                setDefaultModel(newDefault);
                debouncedSave(undefined, newDefault);
              }
            }}
          />
        </div>
      </div>

      {/* Task-Model Assignment Table */}
      <div className="bg-surface-elevated rounded-xl p-5 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-fg-primary">{t('modelRouting.taskAssignTitle')}</h3>
          <p className="text-xs text-fg-tertiary mt-1">{t('modelRouting.taskAssignDesc')}</p>
        </div>

        {configuredProviders.length === 0 && (
          <div className="p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg text-xs text-yellow-400">
            {t('modelRouting.noProvidersHint')}
          </div>
        )}

        {configuredProviders.length > 0 && (
          <div className="space-y-4">
            {TASK_GROUPS.map(group => (
              <TaskGroup
                key={group.groupKey}
                groupKey={group.groupKey}
                tasks={group.tasks}
                assignments={assignments}
                suggestions={suggestions}
                allModels={allModels}
                t={t}
                onAssign={(taskType, assignment) => {
                  const newAssignments = { ...assignments };
                  if (assignment) {
                    newAssignments[taskType] = assignment;
                  } else {
                    delete newAssignments[taskType];
                  }
                  setAssignments(newAssignments);
                  debouncedSave(newAssignments);
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TaskGroup({
  groupKey,
  tasks,
  assignments,
  suggestions,
  allModels,
  t,
  onAssign,
}: {
  groupKey: string;
  tasks: ModelTaskTypeDTO[];
  assignments: Partial<Record<ModelTaskTypeDTO, TaskModelAssignmentDTO>>;
  suggestions: Record<string, Suggestion | null>;
  allModels: ModelOption[];
  t: (key: string) => string;
  onAssign: (taskType: ModelTaskTypeDTO, assignment: TaskModelAssignmentDTO | null) => void;
}) {
  return (
    <div>
      <div className="text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider mb-2 px-1">
        {t(`modelRouting.taskGroups.${groupKey}`)}
      </div>
      <div className="space-y-1">
        {tasks.map(taskType => {
          const assignment = assignments[taskType];
          const suggestion = suggestions[taskType];
          const currentValue = assignment ? `${assignment.provider}/${assignment.model}` : '';
          const filteredModels = filterModelsForTask(allModels, taskType);
          const hasModels = filteredModels.length > 0;
          const tier = assignment ? getTierForModel(allModels, assignment.provider, assignment.model) : undefined;

          return (
            <div
              key={taskType}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg ${
                !hasModels && !assignment ? 'bg-amber-500/5 border border-amber-500/20' : 'bg-surface-overlay/40'
              }`}
            >
              <div className="w-28 shrink-0">
                <span className="text-xs text-fg-primary">{t(`modelRouting.tasks.${taskType}`)}</span>
              </div>
              <div className="flex-1 min-w-0">
                {hasModels ? (
                  <ModelSelect
                    value={currentValue}
                    options={filteredModels}
                    placeholder={suggestion ? `${suggestion.model} (${t('modelRouting.suggested')})` : t('modelRouting.selectModel')}
                    onChange={val => {
                      if (!val) {
                        onAssign(taskType, null);
                      } else {
                        const [provider, ...modelParts] = val.split('/');
                        onAssign(taskType, { provider, model: modelParts.join('/') });
                      }
                    }}
                  />
                ) : (
                  <span className="text-xs text-amber-400">
                    {t('modelRouting.noModelAvailable')}
                    <span className="text-fg-tertiary ml-1">— {t('modelRouting.addProviderHint')}</span>
                  </span>
                )}
              </div>
              <div className="w-14 shrink-0 flex justify-end">
                {tier && <TierBadge tier={tier} />}
                {!tier && assignment && <TierBadge tier="unknown" />}
              </div>
              <div className="w-8 shrink-0 flex justify-end">
                {assignment && (
                  <button
                    onClick={() => onAssign(taskType, null)}
                    className="text-fg-tertiary hover:text-red-400 transition-colors"
                    title={t('modelRouting.clear')}
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function getTierForModel(allModels: ModelOption[], provider: string, modelId: string): string | undefined {
  const model = allModels.find(m => m.provider === provider && m.modelId === modelId);
  return model?.tier;
}

function cleanStaleAssignments(
  assignments: Partial<Record<ModelTaskTypeDTO, TaskModelAssignmentDTO>>,
  configuredProviders: Props['configuredProviders'],
): Partial<Record<ModelTaskTypeDTO, TaskModelAssignmentDTO>> {
  const providerNames = new Set(configuredProviders.map(p => p.name));
  const cleaned: Partial<Record<ModelTaskTypeDTO, TaskModelAssignmentDTO>> = {};
  for (const [key, val] of Object.entries(assignments)) {
    if (val && providerNames.has(val.provider)) {
      cleaned[key as ModelTaskTypeDTO] = val;
    }
  }
  return cleaned;
}

function SaveIndicator({ status, t }: { status: SaveStatus; t: (key: string) => string }) {
  if (status === 'idle') return null;
  const styles: Record<SaveStatus, string> = {
    idle: '',
    saving: 'text-fg-tertiary',
    saved: 'text-green-400',
    error: 'text-red-400',
  };
  const labels: Record<SaveStatus, string> = {
    idle: '',
    saving: t('modelRouting.saving'),
    saved: t('modelRouting.saved'),
    error: t('modelRouting.saveError'),
  };
  return (
    <div className={`text-xs font-medium transition-opacity ${styles[status]}`}>
      {labels[status]}
    </div>
  );
}

function TierBadge({ tier }: { tier: string }) {
  const colors: Record<string, string> = {
    max: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
    pro: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    base: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
    unknown: 'bg-gray-500/10 text-fg-tertiary border-border-default',
  };
  return (
    <span className={`px-1.5 py-0.5 text-[9px] rounded font-semibold uppercase border ${colors[tier] ?? colors.unknown}`}>
      {tier === 'unknown' ? '—' : tier}
    </span>
  );
}

function filterModelsForTask(models: ModelOption[], taskType: ModelTaskTypeDTO): ModelOption[] {
  const TEXT_TASKS: ModelTaskTypeDTO[] = ['text_chat', 'text_reasoning', 'text_coding', 'text_translation', 'text_summary'];

  if (TEXT_TASKS.includes(taskType)) {
    return models.filter(m => {
      if (!m.capabilities || m.capabilities.length === 0) {
        const id = m.modelId.toLowerCase();
        return !isLikelyNonTextModel(id);
      }
      return true;
    });
  }

  const capMap: Record<string, string[]> = {
    image_recognition: ['vision'],
    image_generation: ['imageGeneration'],
    audio_tts: ['audioOutput', 'tts'],
    audio_stt: ['audioInput', 'stt'],
    video_generation: ['videoGeneration'],
    embedding: ['embedding'],
    web_search: ['webSearch'],
  };

  const required = capMap[taskType];
  if (!required) return models;

  return models.filter(m => {
    if (m.capabilities && m.capabilities.length > 0) {
      return required.some(cap => m.capabilities!.includes(cap));
    }
    const id = m.modelId.toLowerCase();
    return inferCapabilityFromName(id, taskType);
  });
}

function isLikelyNonTextModel(modelId: string): boolean {
  const patterns = [/\btts\b/, /\bwhisper\b/, /\bstt\b/, /\bdall-?e\b/, /\bstable.?diffusion\b/, /\bflux\b/, /\bwav2vec\b/, /\bembedding\b/, /\bembed\b/];
  return patterns.some(p => p.test(modelId));
}

function inferCapabilityFromName(modelId: string, taskType: ModelTaskTypeDTO): boolean {
  switch (taskType) {
    case 'image_recognition':
      return /\bvl\b|vision|visual|eye/.test(modelId);
    case 'image_generation':
      return /\bdall-?e\b|flux|stable.?diffusion|sdxl|imagen|wanx|wan[.-]?ai|kolors|playground/.test(modelId);
    case 'audio_tts':
      return /\btts\b|cosy.?voice|speech|bark|xtts|voice/.test(modelId);
    case 'audio_stt':
      return /\bstt\b|whisper|sense.?voice|paraformer|speech.?to.?text|audio/.test(modelId);
    case 'video_generation':
      return /\bvideo\b|wan.*t2v|sora|kling|gen-?[23]/.test(modelId);
    case 'embedding':
      return /\bembed|bge|gte|e5-|text-embedding/.test(modelId);
    case 'web_search':
      return false;
    default:
      return false;
  }
}
