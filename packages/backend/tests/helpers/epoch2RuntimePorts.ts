import { DatabaseCommittedReviewArtifactReader } from '@/modules/collaboration/infrastructure/committedReviewArtifactReader'
import { createFileReviewArtifactContent } from '@/modules/collaboration/infrastructure/local/fileReviewArtifactContent'
import { afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLocalRuntimeContent } from '@/bootstrap/contentRuntime'
import { createActiveHistoryRestrictionProvider } from '@/modules/system-operations/composition/epochInstallation'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
const homes: string[] = []
const bindings = new WeakMap<PersistenceDb, ReturnType<typeof build>>()
function build(db: PersistenceDb) {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-epoch2-runtime-test-'))
  homes.push(appHome)
  return {
    content: createLocalRuntimeContent(db, appHome),
    historyRestrictions: createActiveHistoryRestrictionProvider(),
  }
}
function removeHomes(): void {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
}
// `bun test` removes the homes after each file. Scripts that reuse these ports outside the test
// runner (scripts/perf-run.ts through productionPerformanceApplication) cannot register
// `afterAll` — Bun throws at import — so they remove the homes when the process exits.
try {
  afterAll(removeHomes)
} catch {
  process.once('exit', removeHomes)
}
/** Real epoch-2 metadata provider, including failures for absent installation evidence. */
export function epoch2RuntimeTestPorts(db: PersistenceDb) {
  let ports = bindings.get(db)
  if (!ports) {
    ports = build(db)
    bindings.set(db, ports)
  }
  return ports
}

/** Reuse the writer transport; the file port is only for explicit legacy refs. */
export function epoch2ReviewReader(db: PersistenceDb, appHome: string) {
  return new DatabaseCommittedReviewArtifactReader(
    db,
    createFileReviewArtifactContent(appHome),
    epoch2RuntimeTestPorts(db).content,
  )
}
