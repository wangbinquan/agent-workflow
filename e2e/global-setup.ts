// One process-wide deterministic external world for every Playwright worker.
// The suite includes the existing smart-HTTP remote plus identity, code hosts,
// MCP, package registries and the PlantUML renderer. Its control URL/token are
// inherited by worker processes so specs can seed and inspect it without
// starting private lookalikes.
import { startSystemMockSuite } from '@agent-workflow/system-mocks'

export default async function globalSetup(): Promise<() => Promise<void>> {
  const suite = await startSystemMockSuite()
  Object.assign(process.env, suite.env)
  return async () => await suite.close()
}
