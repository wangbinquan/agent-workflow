// Fixture inputs shared by in-process L1 and the real start/auto CLI processes.
// No conversion or acceptance implementation is replaced.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { composeLocalEpochSwitchDependencies } from '@/bootstrap/epochMigration'
import { createContentInventoryAdapter } from '@/modules/system-operations/composition/epochMigration'
import type { BuiltRelease } from './build'
import { invariant, UPGRADE_TIME, type Snapshot } from './data'
import { captureSource, type SourceCensus } from './source'

export function supplyMatrixInputs(
  epoch: ReturnType<typeof composeLocalEpochSwitchDependencies>,
  built: Pick<BuiltRelease, 'release' | 'provider' | 'before' | 'contract' | 'home' | 'seeds'>,
  expected: { rows: Snapshot },
  captured: (census: SourceCensus) => void,
): void {
  epoch.now = () => UPGRADE_TIME
  const dryRun = epoch.conversion.dryRun.bind(epoch.conversion)
  epoch.conversion.dryRun = async (request) => {
    if (!request.source.preflight.requiresOfflineUpgrade)
      captured(await captureSource(request.source, built, expected))
    return dryRun(request)
  }
  const objects = new Map(
    built.seeds.flatMap((seed) =>
      (seed.content ?? [])
        .filter((file) => file.objectId)
        .map((file) => [file.objectId!, file] as const),
    ),
  )
  if (!objects.size) return
  epoch.content = createContentInventoryAdapter({
    objects: {
      async stat(id) {
        const file = objects.get(id)
        invariant(file, `unknown fixture object ${id}`)
        const bytes = readFileSync(join(built.home, file.path))
        return { id, sha256: file.sha256, size: bytes.length }
      },
      async open(object) {
        const file = objects.get(object.id)
        invariant(file, `unknown fixture object ${object.id}`)
        return new Response(readFileSync(join(built.home, file.path))).body!
      },
    },
  })
  epoch.defaultContentRoot = {
    kind: 'app-home',
    root: built.home,
    runsSupplied: true,
    objects: 'crewstation',
  }
}
