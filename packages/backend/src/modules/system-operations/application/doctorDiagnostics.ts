import type { ApplicationConfigurationQueries } from '../public/queries'
import type { CheckResult, DoctorResult } from '../domain/doctorDiagnostics'
import type { DoctorDiagnosticsFactory, DoctorRuntimeSelectionRef } from './ports/doctorDiagnostics'

export async function runDoctorDiagnostics(
  factory: DoctorDiagnosticsFactory,
  selected?: ApplicationConfigurationQueries,
): Promise<DoctorResult> {
  const checks: CheckResult[] = []
  const diagnostics = factory.create({ configuration: selected })
  const loadRuntimeConfiguration = diagnostics.loadRuntimeConfiguration
  if (typeof loadRuntimeConfiguration !== 'function')
    throw new TypeError('Doctor diagnostics is missing loadRuntimeConfiguration')

  // 1. opencode binary
  let runtimeSelection: DoctorRuntimeSelectionRef
  try {
    runtimeSelection = await loadRuntimeConfiguration.call(diagnostics)
  } catch {
    // ignore — separate check below catches config issues
  }
  // RFC-227: this is an availability probe only. OpenCode versions are
  // telemetry; protocol behavior is checked by Runtime Test / actual use.
  const probe = await diagnostics.probeRuntime(runtimeSelection)
  if (probe.ran !== true) {
    checks.push({
      name: 'opencode binary',
      ok: false,
      message: `'${probe.binary}' not found or not executable; install opencode and ensure PATH or set 'opencodePath' in config`,
    })
  } else {
    checks.push({
      name: 'opencode binary',
      ok: true,
      message:
        probe.version === null
          ? `${probe.binary} (version not reported; protocol test required)`
          : `${probe.version} (reported version; protocol test required)`,
    })
  }

  // 2. git binary (required) + ssh (optional, advisory — RFC-254 T21)
  checks.push(await diagnostics.git())
  checks.push(await diagnostics.ssh())

  // 3. app home writable
  checks.push(await diagnostics.home())

  // 4. config loads
  checks.push(await diagnostics.configuration())

  // 5. installation diagnostic from the selected complete family
  checks.push(await diagnostics.installation())

  // 6. migrations present
  checks.push(await diagnostics.migrations())

  // 7. RFC-108/RFC-213/RFC-349: provider-aware integrity, lifecycle and
  // sealed-credential decryptability. PostgreSQL never probes retained SQLite.
  checks.push(...(await diagnostics.database()))

  // 8. Backup inventory is filesystem-owned and provider-neutral.
  checks.push(await diagnostics.backups())

  const ok = checks.every((c) => c.ok)
  return { ok, checks }
}
