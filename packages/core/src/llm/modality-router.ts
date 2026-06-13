import { createLogger, type ModelTaskType, type TaskModelAssignment, type ProviderCapabilities } from '@markus/shared';
import type { MultiModalProviderInterface } from './provider.js';
import type { LLMRouter } from './router.js';

const log = createLogger('modality-router');

type Modality = 'chat' | 'image_gen' | 'tts' | 'stt' | 'video_gen' | 'embedding';

const TASK_TO_MODALITY: Record<ModelTaskType, Modality> = {
  text_chat: 'chat',
  text_reasoning: 'chat',
  text_coding: 'chat',
  text_translation: 'chat',
  text_summary: 'chat',
  image_recognition: 'chat',
  image_generation: 'image_gen',
  audio_tts: 'tts',
  audio_stt: 'stt',
  video_generation: 'video_gen',
  embedding: 'embedding',
  web_search: 'chat',
};

/**
 * ModalityRouter sits alongside LLMRouter to route non-chat modalities
 * (image gen, TTS, STT, video gen) to the appropriate provider.
 *
 * For chat/text tasks, it delegates to LLMRouter.
 * For other modalities, it maintains its own provider registry.
 */
export class ModalityRouter {
  private modalityProviders = new Map<Modality, MultiModalProviderInterface[]>();
  private taskAssignments = new Map<ModelTaskType, TaskModelAssignment>();

  constructor(private llmRouter: LLMRouter) {}

  /**
   * Register a provider for one or more modalities.
   * If the provider declares capabilities, modalities are inferred automatically.
   */
  registerProvider(provider: MultiModalProviderInterface, capabilities?: ProviderCapabilities): void {
    const caps = capabilities ?? provider.getCapabilities?.();
    if (!caps) {
      log.warn(`Provider ${provider.name} has no declared capabilities, skipping modality registration`);
      return;
    }

    const modalities: Modality[] = [];
    if (caps.chat) modalities.push('chat');
    if (caps.imageGeneration) modalities.push('image_gen');
    if (caps.tts) modalities.push('tts');
    if (caps.stt) modalities.push('stt');
    if (caps.videoGeneration) modalities.push('video_gen');
    if (caps.embedding) modalities.push('embedding');

    for (const modality of modalities) {
      const existing = this.modalityProviders.get(modality) ?? [];
      existing.push(provider);
      this.modalityProviders.set(modality, existing);
    }

    log.info(`Registered provider ${provider.name} for modalities: ${modalities.join(', ')}`);
  }

  /**
   * Set a manual task assignment (from config).
   */
  setTaskAssignment(taskType: ModelTaskType, assignment: TaskModelAssignment): void {
    this.taskAssignments.set(taskType, assignment);
  }

  /**
   * Clear all task assignments.
   */
  clearTaskAssignments(): void {
    this.taskAssignments.clear();
  }

  /**
   * Load task assignments from a config record.
   */
  loadAssignments(assignments: Partial<Record<ModelTaskType, TaskModelAssignment>>): void {
    this.clearTaskAssignments();
    for (const [taskType, assignment] of Object.entries(assignments)) {
      if (assignment) {
        this.setTaskAssignment(taskType as ModelTaskType, assignment);
      }
    }
  }

  /**
   * Resolve a provider for a given modality. Used by multimodal tools
   * to find the right provider for image gen, TTS, STT, etc.
   */
  resolveForModality(modality: Modality): MultiModalProviderInterface | undefined {
    const providers = this.modalityProviders.get(modality);
    if (!providers || providers.length === 0) return undefined;
    return providers[0];
  }

  /**
   * Resolve a provider for a given task type. Checks manual assignments first,
   * then falls back to modality-based resolution.
   */
  resolveForTask(taskType: ModelTaskType): MultiModalProviderInterface | undefined {
    const assignment = this.taskAssignments.get(taskType);
    if (assignment) {
      const modality = TASK_TO_MODALITY[taskType];
      const providers = this.modalityProviders.get(modality) ?? [];
      const match = providers.find(p => p.name === assignment.provider);
      if (match) return match;
      log.warn(`Assigned provider ${assignment.provider} not found for task ${taskType}, falling back`);
    }

    const modality = TASK_TO_MODALITY[taskType];
    return this.resolveForModality(modality);
  }

  /**
   * List all registered modalities and their provider counts.
   */
  getStatus(): Record<string, number> {
    const status: Record<string, number> = {};
    for (const [modality, providers] of this.modalityProviders) {
      status[modality] = providers.length;
    }
    return status;
  }
}
