import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { RuntimeDiagnosticTestDependencies } from '../../src/server'
import { smokeRuntime, type SmokeOptions } from '../../src/services/runtimeSmoke'
import { OPENCODE_FFF_CAPABILITY_CODEC } from '../../src/services/runtime/opencode/hermetic'
import {
  OFFICIAL_OPENCODE_BUILD_CODEC,
  snapshotOfficialOpencodeBinary,
  type OfficialOpencodeArch,
  type OfficialOpencodePlatform,
} from '../../src/services/runtime/opencode/officialBuilds'

function fixtureSource(command: readonly string[]): string {
  if (command.length !== 1) throw new Error('fixture command must contain one executable')
  const token = command[0]!
  const path = isAbsolute(token) ? token : Bun.which(token)
  if (path === null) throw new Error('fixture executable not found')
  return realpathSync(path)
}

/**
 * Unit-test analogue of the production official-snapshot boundary.
 *
 * It does not simply return the source fixture: it hashes the exact fixture
 * bytes, admits that digest through snapshotOfficialOpencodeBinary's injected
 * immutable build table, copies into a 0500 private snapshot, and executes only
 * that copy. The injected build row never enters production state.
 */
export async function withFixtureOpencodeSnapshot<T>(
  command: readonly string[],
  callback: (snapshotPath: string) => Promise<T>,
): Promise<T> {
  if (
    (process.platform !== 'darwin' && process.platform !== 'linux') ||
    (process.arch !== 'arm64' && process.arch !== 'x64')
  ) {
    throw new Error('unsupported fixture platform')
  }
  const source = fixtureSource(command)
  const digest = createHash('sha256').update(readFileSync(source)).digest('hex')
  const root = mkdtempSync(join(tmpdir(), 'aw-opencode-fixture-snapshot-'))
  const snapshotPath = join(root, 'opencode')
  try {
    await snapshotOfficialOpencodeBinary(
      {
        command,
        version: '1.18.3',
        snapshotPath,
        platform: process.platform,
        arch: process.arch,
      },
      {
        builds: [
          Object.freeze({
            platform: process.platform as OfficialOpencodePlatform,
            arch: process.arch as OfficialOpencodeArch,
            version: '1.18.3',
            digest,
            codec: OFFICIAL_OPENCODE_BUILD_CODEC,
            fffCapabilityCodec: OPENCODE_FFF_CAPABILITY_CODEC,
          }),
        ],
      },
    )
    return await callback(snapshotPath)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

export const FIXTURE_RUNTIME_DIAGNOSTICS: Readonly<RuntimeDiagnosticTestDependencies> =
  Object.freeze({
    withOfficialOpencodeSnapshot: withFixtureOpencodeSnapshot,
    smokeRuntime: (options: SmokeOptions) =>
      smokeRuntime({
        ...options,
        testOnlyUnverifiedRuntime: true,
      }),
  })
