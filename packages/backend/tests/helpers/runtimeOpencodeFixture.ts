import type { RuntimeDiagnosticTestDependencies } from '../../src/server'
import { smokeRuntime, type SmokeOptions } from '../../src/services/runtimeSmoke'

export const FIXTURE_RUNTIME_DIAGNOSTICS: Readonly<RuntimeDiagnosticTestDependencies> =
  Object.freeze({
    smokeRuntime: (options: SmokeOptions) => smokeRuntime(options),
  })
