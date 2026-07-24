import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeDiagnosticTestDependencies } from '../../src/server'
import { smokeRuntime, type SmokeOptions } from '../../src/services/runtimeSmoke'
import { snapshotRuntimeOpencodeBinary } from '../../src/services/runtime/opencode/runtimeBinary'

/**
 * Deterministic test analogue of the production runtime-snapshot boundary.
 *
 * It does not simply return the source fixture: it resolves and hashes the
 * exact fixture bytes, copies them into a 0500 private snapshot, and executes
 * only that copy. No reported version or platform tuple participates.
 */
export async function withFixtureOpencodeSnapshot<T>(
  command: readonly string[],
  callback: (snapshotPath: string) => Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'aw-opencode-fixture-snapshot-'))
  const snapshotPath = join(root, 'opencode')
  try {
    await snapshotRuntimeOpencodeBinary({ command, snapshotPath })
    return await callback(snapshotPath)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

export const FIXTURE_RUNTIME_DIAGNOSTICS: Readonly<RuntimeDiagnosticTestDependencies> =
  Object.freeze({
    withRuntimeOpencodeSnapshot: withFixtureOpencodeSnapshot,
    smokeRuntime: (options: SmokeOptions) =>
      smokeRuntime({
        ...options,
        testOnlyUnverifiedRuntime: true,
      }),
  })
