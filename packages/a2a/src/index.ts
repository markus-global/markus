/** @deprecated A2ABus is no longer used — inter-agent messaging goes through the Mailbox. Kept for backward compat. */
export { A2ABus, type A2AHandler } from './bus.js';
export { DelegationManager, type DelegationResult } from './delegation.js';
export { CollaborationManager, type CollaborationSession } from './collaboration.js';
export { StructuredMessageManager } from './structured.js';
export type {
  A2AEnvelope,
  A2AMessageType,
  TaskDelegation,
  TaskUpdate,
  InfoRequest,
  InfoResponse,
  CollaborationInvite,
  AgentCard,
  ResourceRequest,
  ResourceResponse,
  ProgressSync,
  CapabilityDiscovery,
  StatusBroadcast,
} from './protocol.js';
