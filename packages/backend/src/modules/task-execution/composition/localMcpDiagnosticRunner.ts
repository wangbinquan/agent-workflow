// RFC-488 — the local MCP diagnostic runner, Resource Catalog's `LocalMcpDiagnosticExecution` for the native profile
// (the hosted twin is `crewstationMcpDiagnosticRunner.ts`). Bootstrap binds it, with the test fixture when one is given.
// RFC-491: it receives the native system-agent run's providers (runtime-management's driver, workspace and definition).
export {
  createLocalMcpDiagnosticRunner,
  type LocalMcpDiagnosticRunFixture,
  type LocalMcpDiagnosticRunnerInput,
} from '../infrastructure/local/mcpDiagnosticRunner'
export type {
  NativeSystemAgentRunProviders,
  SystemAgentRunOptions,
  SystemAgentRunResult,
} from '../infrastructure/local/nativeSystemAgentRun'
