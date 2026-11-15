export { RemoteAccessAgent, type RemoteAccessConfig, type RemoteAccessStatus } from './agent.js';

// ── Frozen remote-access contract (T1) ────────────────────────────────────────
// Single source of truth shared by the local CLI (TunnelManager / RegistryClient)
// and the Markus Hub (endpoint registry + entry gate). See
// docs/architecture/remote-access.md for the normative prose.
export * from './contract.js';

// ── Local tunnel orchestration (T6) ───────────────────────────────────────────
// The TunnelManager supervises the user's own tunnel binary (cloudflared /
// tailscale); it replaces the WebRTC relay network that used to live in
// `agent.ts`.
export {
  TunnelManager,
  type TunnelStatus,
  type TunnelManagerConfig,
  type TunnelManagerDeps,
  type TunnelRegistry,
  type TimerPort,
  type TimerHandle,
} from './tunnel-manager.js';
export { spawnDetached, type TunnelProcess, type SpawnOptions, type SpawnFn } from './process-group.js';
export * from './url-parse.js';
export * from './providers/index.js';

// ── Hub registry client + local verify-server + secret stores (T7) ─────────────
export {
  RegistryClient,
  RemoteRegistryError,
  type RegistryClientOptions,
  type RegistryErrorCode,
  type RotationSignatureParams,
  resolveHubBaseUrl,
  endpointPath,
  signRotationRequest,
  verifyRotationSignature,
  sha256Hex,
  generateNonce,
  DEFAULT_HUB_URL,
  ENDPOINTS_PATH,
} from './registry-client.js';

export {
  LOCAL_VERIFY_PATH,
  buildLocalVerifyResponse,
  handleLocalVerifyRequest,
  createLocalVerifyHandler,
  type VerifyTokenSource,
} from './verify-server.js';

export {
  HUB_TOKEN_ENV_KEY,
  ENTRY_HOST_SUFFIX,
  buildEntryUrl,
  hubUsernameFromToken,
  endpointSecretEnvKey,
  persistEndpointSecret,
  persistEndpointSecretForTunnel,
  readEndpointSecret,
  clearEndpointSecret,
  persistHubToken,
  resolveHubToken,
  legacyHubTokenPath,
} from './remote-secrets.js';

// ── Remote status payload + controller wiring (T8) ─────────────────────────────
// The API server holds ONE of these controllers and broadcasts
// `getRemoteStatus()` verbatim; all status shaping lives here.
export {
  type RemoteStatusCompat,
  buildCompatPayload,
  legacyStatusToV2,
} from './remote-status.js';

export {
  type RemoteController,
  type TunnelSource,
  type LegacySource,
  createTunnelController,
  createLegacyController,
} from './remote-controller.js';

// ── Path B: "hand it to an Agent" plan builder (T10) ──────────────────────────
export {
  AGENT_SETUP_PLAN_VERSION,
  AGENT_SETUP_PLATFORMS,
  DEFAULT_LOCAL_API_PORT,
  buildAgentTunnelTaskContract,
  buildAgentSetupPrompt,
  buildAgentSetupPlan,
  type AgentSetupPlatform,
  type AgentSetupPlanInput,
  type AgentSetupPlan,
} from './agent-setup.js';
