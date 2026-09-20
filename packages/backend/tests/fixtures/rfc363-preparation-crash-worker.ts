// Hosted-only real process: terminate at an acknowledged durable Git checkpoint,
// then open the same real SQLite file / PostgreSQL generation in a fresh process.
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { DatabaseConfig } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { openDb } from '@/db/client'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createRepositoryPreparationJournal } from '@/modules/source-control/infrastructure/repositoryPreparationJournal'
import { createRepositoryPreparationEffects } from '@/modules/source-control/infrastructure/repositoryPreparationEffects'
import { composeRepositoryWorkspaceStore } from '@/modules/source-control/infrastructure/repositoryWorkspaceStore'
import { cleanupRepositoryWorkspace } from '@/modules/source-control/application/repositoryPreparationCleanup'
import { prepareRepositoryWorkspace } from '@/modules/source-control/application/repositoryPreparation'
import {
  repositoryPreparationFactsJson,
  repositoryPreparationRevision,
} from '@/modules/source-control/domain/repositoryPreparationFacts'
import { decodeRepositoryLaunchRef } from '@/modules/source-control/domain/repositoryLaunchRef'
import { ensureCachedRepoIdentity } from '@/services/gitRepoCache'
import { sha256Hex } from '@/util/hash'

interface Input {
  root: string
  taskId: string
  operation: string
  snapshot: string
  source: string
  remote: string
  workingBranch?: string
  provider:
    | { kind: 'sqlite' }
    | {
        kind: 'postgresql'
        config: Extract<DatabaseConfig, { provider: 'postgresql' }>
        generationId: string
      }
}
const file = process.argv[2]
if (file === undefined) throw new Error('missing worker input')
const input = JSON.parse(readFileSync(file, 'utf8')) as Input
let db: ProviderNeutralDatabase
let close: () => Promise<void>
if (input.provider.kind === 'sqlite') {
  const opened = openDb({
    path: join(input.root, 'db.sqlite'),
    migrationsFolder: resolve(import.meta.dir, '..', '..', 'db', 'migrations'),
  })
  db = opened
  close = async () => {
    opened.$client.close()
  }
} else {
  const runtime = createPostgresqlDatabaseRuntime({
    config: input.provider.config,
    generationId: input.provider.generationId,
  })
  db = createPostgresqlDatabaseClient(runtime)
  close = () => runtime.close()
}
try {
  const journal = createRepositoryPreparationJournal(db)
  const store = composeRepositoryWorkspaceStore(db)
  const operation = decodeRepositoryLaunchRef('operation', input.operation)
  const snapshot = decodeRepositoryLaunchRef('preparation', input.snapshot)
  const appHome = join(input.root, 'home')
  if ((await journal.operation(operation)) === null) {
    const identity = await ensureCachedRepoIdentity({ store, appHome }, { url: input.remote })
    const repository = await store.findCachedRepoById(identity.cachedRepoId)
    if (repository === null) throw new Error('missing source identity')
    const factsJson = repositoryPreparationFactsJson({
      version: 1,
      kind: 'repository',
      groups: [],
      groupName: null,
      repositories: [
        {
          id: repository.id,
          revision: repositoryPreparationRevision(repository),
          urlHash: repository.urlHash,
          defaultBranch: repository.defaultBranch,
        },
      ],
      layout: {
        repos: [
          {
            cachedRepoId: repository.id,
            repoUrlRedacted: input.remote,
            ref: 'main',
            subdir: '',
            mountPath: '',
            readonly: false,
            viaGroups: [],
          },
        ],
        nodes: [],
      },
    })
    await journal.seal({
      id: input.source,
      requestKey: input.source,
      requestDigest: 'crash-oracle',
      kind: 'repository',
      factsJson,
      createdAt: 1,
    })
    await journal.freeze({
      id: snapshot,
      sourceRef: input.source,
      revision: `sha256:${sha256Hex(factsJson)}`,
      factsJson,
      createdAt: 1,
    })
    await journal.plan({ id: operation, snapshotRef: snapshot, now: 1 })
  }
  const effects = createRepositoryPreparationEffects({
    taskId: input.taskId,
    appHome,
    repositoryWorkspace: store,
    gitCommitIdentity: null,
    ...(input.workingBranch === undefined ? {} : { workingBranch: input.workingBranch }),
    assertCurrent: async () => {},
    ...(process.env.RFC363_MODE === 'stop' ? { signal: AbortSignal.abort('user-cancel') } : {}),
    workspaceCleanupHook: async (event) => {
      if (event.stage !== process.env.RFC363_CRASH_POINT) return
      writeFileSync(join(input.root, 'ready.tmp'), JSON.stringify(event))
      renameSync(join(input.root, 'ready.tmp'), join(input.root, 'ready.json'))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
      throw new Error('cleanup crash latch unexpectedly released')
    },
    worktreeLifecycleHook: async (event) => {
      if (event.stage !== process.env.RFC363_CRASH_POINT) return
      // The journaled materializer has awaited the real database checkpoint
      // before forwarding this hook. No callback can advance after the sentinel.
      writeFileSync(join(input.root, 'ready.tmp'), JSON.stringify(event))
      renameSync(join(input.root, 'ready.tmp'), join(input.root, 'ready.json'))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
      throw new Error('crash latch unexpectedly released')
    },
  })
  const outcome =
    process.env.RFC363_MODE === 'cleanup'
      ? await cleanupRepositoryWorkspace({ journal, operation, effects, now: Date.now })
      : await prepareRepositoryWorkspace({
          journal,
          operation,
          source: snapshot,
          effects,
          now: Date.now,
        })
  writeFileSync(
    join(input.root, 'result.json'),
    JSON.stringify({ outcome, row: await journal.operation(operation) }),
  )
} finally {
  await close()
}
