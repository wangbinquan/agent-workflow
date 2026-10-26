import { describeV1Providers, type V1Harness } from './rfc395V1Harness'
import { writeV2SourceRows } from './rfc395V2SourceRows'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import type { ConversionInput } from '@/platform/persistence/migration/conversion/plan'
import type { ConversionContribution } from '@/platform/persistence/migration/conversion/rule'
import type { LookupBuilder, LookupKey } from '@/platform/persistence/migration/conversion/lookups'
import {
  TASK_FACTS,
  TASK_MOUNTS,
  RUN_FRAMES,
  type TaskFacts,
  type TaskMountFacts,
  type RunFrame,
} from '@/platform/persistence/migration/conversion/lookups/keys'
import type { ContentInventory } from '@/platform/persistence/migration/conversion/content'
import type { VersionedSourceReader } from '@/platform/persistence/migration/sourceTypes'
import { join } from 'node:path'

export const emptyV2Content: ContentInventory = {
  async stat() {
    return {
      state: 'absent',
      cause: 'originally-absent',
      evidence: 'fixture deliberately supplied no content',
    }
  },
  async read() {
    throw new Error('No fixture content')
  },
}
export interface V2LookupFixtures {
  readonly taskFacts?: readonly TaskFacts[]
  readonly taskMounts?: readonly TaskMountFacts[]
  readonly runFrames?: readonly RunFrame[]
}
export function fixtureLookup<V>(
  key: LookupKey<V>,
  entries: readonly (readonly [string, V])[],
): LookupBuilder<V> {
  return {
    key,
    sources: [],
    build(_staged, put) {
      for (const [id, value] of entries) put(id, value)
    },
  }
}
export function v2LookupFixtures(fixtures: V2LookupFixtures): ConversionContribution {
  const lookups: LookupBuilder<unknown>[] = []
  if (fixtures.taskFacts)
    lookups.push(
      fixtureLookup(
        TASK_FACTS,
        fixtures.taskFacts.map((value) => [value.taskId, value]),
      ),
    )
  if (fixtures.taskMounts)
    lookups.push(
      fixtureLookup(
        TASK_MOUNTS,
        fixtures.taskMounts.map((value) => [value.taskId, value]),
      ),
    )
  if (fixtures.runFrames)
    lookups.push(
      fixtureLookup(
        RUN_FRAMES,
        fixtures.runFrames.map((value) => [value.runId, value]),
      ),
    )
  return { rules: [], validators: [], lookups }
}
export interface V2Harness {
  readonly sourceHarness: V1Harness
  install: V1Harness['install']
  write(table: string, rows: Parameters<typeof writeV2SourceRows>[2]): Promise<void>
  input(
    contributions: readonly ConversionContribution[],
    options?: Partial<Omit<ConversionInput, 'source' | 'preflight' | 'contributions'>> & {
      readonly source?: VersionedSourceReader
      readonly fixtures?: V2LookupFixtures
    },
  ): Promise<ConversionInput>
}
/** V1 delegates to the canonical dual-provider harness and installs only frozen SQL/history plans. */
export function describeV2Providers(name: string, body: (h: V2Harness) => void): void {
  describeV1Providers(name, (h) =>
    body({
      sourceHarness: h,
      install: h.install,
      write: (table, rows) => writeV2SourceRows(h, table, rows),
      async input(contributions, options = {}) {
        const { fixtures, source = await h.source(), ...overrides } = options
        const preflight = await source.preflight()
        return {
          source,
          preflight,
          target: persistenceSchema,
          contributions: [...contributions, v2LookupFixtures(fixtures ?? {})],
          content: emptyV2Content,
          scratchRoot: join(h.operationRoot, 'v2-scratch'),
          planTime: 123,
          chunkLimit: 3,
          targetGeneration: 'dbg_rfc395_v2_fixture',
          candidateBuild: 'v2-core-a-fixture',
          sourceBackupId: null,
          contentManifestDigest: 'fixture:no-content',
          sourceScope: [
            ...new Set(
              contributions.flatMap((contribution) =>
                contribution.rules.flatMap((rule) => rule.claims),
              ),
            ),
          ],
          ...overrides,
        }
      },
    }),
  )
}
