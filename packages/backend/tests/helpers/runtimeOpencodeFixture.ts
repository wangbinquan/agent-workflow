import type { RuntimeDiagnosticDependencies } from '@/modules/runtime-management/composition/runtimeManagement'
import { smokeRuntime, type SmokeOptions } from './nativeRuntimeSmoke'

export const FIXTURE_RUNTIME_DIAGNOSTICS = Object.freeze({
  smokeRuntime: (options: SmokeOptions) => smokeRuntime(options),
}) satisfies Readonly<Partial<RuntimeDiagnosticDependencies>>
