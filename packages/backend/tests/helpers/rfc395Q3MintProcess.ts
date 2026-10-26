// Child process for Q-3: real native clients, durable mint, then an event-driven parent barrier.
import '@/bootstrap/persistenceSchema'
import { openDb } from '@/db/client'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { seedSequenceTask, mintSequenceRun } from './rfc374Fixtures'

async function main() {
  const generationId = 'dbg_q3_multiprocess'
  let close: () => Promise<void>
  let db: PersistenceDb
  if (process.env.Q3_PROVIDER === 'sqlite') {
    const sqlite = openDb({
      path: process.env.Q3_SQLITE_PATH!,
      generationId,
      skipMigrations: true,
      journalMode: 'preserve',
      busyTimeoutMs: 30000,
    })
    db = sqlite
    close = async () => {
      sqlite.$client.close()
    }
  } else {
    const runtime = createPostgresqlDatabaseRuntime({
      generationId,
      config: {
        provider: 'postgresql',
        urlEnv: 'Q3_DATABASE_URL',
        poolMax: 1,
        connectTimeoutMs: 10000,
        statementTimeoutMs: 30000,
        idleTimeoutMs: 1000,
      },
      env: process.env,
    })
    db = createPostgresqlDatabaseClient(runtime)
    close = () => runtime.close()
  }
  try {
    if (process.env.Q3_MODE === 'seed') {
      const taskId = await databaseSessionFor(db).transaction(async (tx) => {
        const id = await seedSequenceTask(tx)
        await mintSequenceRun(tx, id, { id: 'q3-before-kill' })
        return id
      })
      process.stdout.write(`Q3_READY=${JSON.stringify({ taskId, pid: process.pid })}\n`)
      await Bun.stdin.text() // Parent SIGKILL happens after the business commit acknowledgement.
      return
    }
    process.stdout.write(`Q3_READY=${JSON.stringify({ pid: process.pid })}\n`)
    await Bun.stdin.text()
    for (let i = 0; i < 4; i++)
      await mintSequenceRun(db, process.env.Q3_TASK_ID!, { id: `q3-${process.env.Q3_WRITER}-${i}` })
  } finally {
    await close()
  }
}
if (import.meta.main) await main()
