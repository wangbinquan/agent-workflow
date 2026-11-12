// RFC-488 — the local MCP diagnostic runner, Resource Catalog's `LocalMcpDiagnosticExecution` for the native profile
// (the hosted twin is `crewstationMcpDiagnosticRunner.ts`). Bootstrap binds it, with the test fixture when one is given.
export {
  createLocalMcpDiagnosticRunner,
  type LocalMcpDiagnosticRunFixture,
  type LocalMcpDiagnosticRunnerInput,
} from '../infrastructure/local/mcpDiagnosticRunner'
