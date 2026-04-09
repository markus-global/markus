/**
 * Agent Platform Connector Descriptor
 *
 * Defines how Markus discovers, installs, and integrates with external agent
 * platforms (OpenClaw, Hermes, etc.) in a brand-agnostic way.
 *
 * Descriptors live in:
 *   - Built-in: <cli>/connectors/*.json  (shipped with @markus-global/cli)
 *   - User:     ~/.markus/connectors/*.json
 */

export interface ConnectorDescriptor {
  /** Unique platform identifier (e.g. "openclaw", "hermes") */
  platform: string;

  /** Human-readable name */
  displayName: string;

  /** Short description */
  description: string;

  /** Platform homepage */
  homepage?: string;

  /** How to detect if this platform is already installed */
  detection: ConnectorDetection;

  /** How to install this platform from scratch */
  installation: ConnectorInstallation;

  /** How Markus integrates with this platform once installed */
  integration: ConnectorIntegration;

  /** Default capabilities to register when connecting */
  defaultCapabilities?: string[];

  /** Default agent name when connecting */
  defaultAgentName?: string;
}

export interface ConnectorDetection {
  /** Config file paths to check (supports ~ for homedir) */
  configPaths: string[];

  /** CLI binary name to check in PATH */
  binaryName?: string;

  /** Process name to check if running */
  processName?: string;

  /** Agent Card URL to probe */
  agentCardUrl?: string;
}

export interface ConnectorInstallation {
  /** npm package name for `npm install -g` */
  npmPackage?: string;

  /** Alternative install script URL */
  installScript?: string;

  /** Alternative install command */
  installCommand?: string;

  /** Post-install initialization command */
  initCommand?: string;

  /** Start command (daemon mode) */
  startCommand?: string;

  /** Stop command */
  stopCommand?: string;
}

export interface ConnectorIntegration {
  /** How the external platform authenticates with Markus gateway */
  type: 'gateway' | 'a2a' | 'mcp';

  /** Config file format */
  configFormat: 'json' | 'json5' | 'yaml' | 'toml';

  /** Path to the config file (supports ~) */
  configPath: string;

  /**
   * JSON path within config where Markus token should be written.
   * Uses dot notation (e.g. "integrations.markus.token")
   */
  tokenField: string;

  /**
   * JSON path within config where Markus URL should be written.
   */
  urlField: string;

  /**
   * JSON path for reading LLM provider configs from the external platform.
   * Used during `markus init --import-from=<platform>`.
   */
  llmProvidersField?: string;

  /** Directory where integration skills/plugins should be installed */
  skillDir?: string;

  /** Name of the skill template to copy from markus templates */
  skillTemplateName?: string;
}
