// Per-test native generations, with immutable per-suite installation templates.
import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import type { PostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { migrationPostgresqlRuntime } from '@/platform/persistence/migration/freeze/postgresqlDatabases'
import {
  postgresqlHistoryConnection,
  sqliteHistoryConnection,
  type HistoryConnection,
} from '@/platform/persistence/schema/history/connection'
import {
  createRfc395FixtureDatabase,
  createRfc395FixtureRuntime,
  type FixtureDatabase,
} from './rfc395FixturePostgresql'

export class Rfc395FixtureGeneration {
  private database: Database | undefined
  private runtimeValue: (PostgresqlDatabaseRuntime & { cancelQueries(): Promise<void> }) | undefined
  private physical: FixtureDatabase | undefined
  private readonly templates = new Map<string, Buffer | FixtureDatabase>()
  private installed = false
  private stopping = false
  private pending: Promise<void> | undefined

  private assertRunning(): void {
    if (this.stopping) throw new Error('RFC-395 fixture setup was cancelled')
  }
  private run(work: () => Promise<void>): Promise<void> {
    if (this.pending) throw new Error('RFC-395 fixture installation is already in progress')
    const operation = work().finally(() => {
      if (this.pending === operation) this.pending = undefined
    })
    this.pending = operation
    return operation
  }

  constructor(
    readonly provider: DatabaseProvider,
    private readonly root: string,
    private readonly sourceUrl: string | undefined,
  ) {}

  get sqlite(): Database {
    if (!this.database) throw new Error('Not a live SQLite fixture')
    return this.database
  }
  get runtime(): PostgresqlDatabaseRuntime {
    if (!this.runtimeValue) throw new Error('Not a live PostgreSQL fixture')
    return this.runtimeValue
  }
  get native(): HistoryConnection {
    return this.provider === 'sqlite'
      ? sqliteHistoryConnection(this.sqlite)
      : postgresqlHistoryConnection(this.runtime.providerPool())
  }
  private openSqlite(path: string): void {
    this.database = new Database(path)
    this.database.exec('PRAGMA foreign_keys = ON')
  }
  private openPostgresql(): void {
    const runtime = createRfc395FixtureRuntime({
      generationId: 'dbg_rfc395_r2_engine',
      config: {
        provider: 'postgresql',
        urlEnv: 'R2_ENGINE_URL',
        poolMax: 2,
        connectTimeoutMs: 10_000,
        statementTimeoutMs: 30_000,
        idleTimeoutMs: 30_000,
      },
      env: { R2_ENGINE_URL: this.physical!.url },
    })
    this.runtimeValue = {
      ...migrationPostgresqlRuntime(runtime),
      cancelQueries: runtime.cancelQueries,
    }
  }
  reset(): Promise<void> {
    this.stopping = false
    return this.run(async () => {
      await this.disposeCurrent()
      this.assertRunning()
      this.installed = false
      if (this.provider === 'sqlite') {
        this.openSqlite(join(this.root, `${crypto.randomUUID()}.sqlite`))
      } else {
        if (!this.sourceUrl) throw new Error('PostgreSQL fixture requires a test database URL')
        this.physical = await createRfc395FixtureDatabase(this.sourceUrl)
        this.assertRunning()
        this.openPostgresql()
      }
    })
  }
  /** A second install in one test is an upgrade of its current rows, never a snapshot reset. */
  install(key: string, install: () => Promise<void>): Promise<void> {
    this.assertRunning()
    return this.run(async () => {
      await this.installSnapshot(key, install)
    })
  }
  private async installSnapshot(key: string, install: () => Promise<void>): Promise<void> {
    if (this.installed) return await install()
    const cached = this.templates.get(key)
    if (cached) {
      if (Buffer.isBuffer(cached)) {
        const path = this.sqlite.filename
        this.sqlite.close()
        writeFileSync(path, cached)
        this.openSqlite(path)
      } else {
        await this.disposeCurrent()
        this.assertRunning()
        this.physical = await createRfc395FixtureDatabase(this.sourceUrl!, cached)
        this.assertRunning()
        this.openPostgresql()
      }
    } else {
      await install()
      this.assertRunning()
      if (this.provider === 'sqlite') this.templates.set(key, this.sqlite.serialize())
      else {
        // CREATE DATABASE ... TEMPLATE requires zero sessions on the source database.
        await this.runtime.close()
        this.runtimeValue = undefined
        try {
          this.templates.set(key, await createRfc395FixtureDatabase(this.sourceUrl!, this.physical))
        } finally {
          if (!this.stopping) this.openPostgresql()
        }
      }
    }
    this.assertRunning()
    this.installed = true
  }
  private async disposeCurrent(): Promise<void> {
    this.database?.close()
    this.database = undefined
    try {
      await this.runtimeValue?.close()
    } finally {
      this.runtimeValue = undefined
      await this.physical?.drop()
      this.physical = undefined
    }
  }
  async closeCurrent(): Promise<void> {
    this.stopping = true
    // Setup may be between CREATE DATABASE and assigning the result. Drain it before DROP.
    const closed = await Promise.allSettled([this.runtimeValue?.close()])
    await this.pending?.catch(() => undefined)
    const disposed = await Promise.allSettled([this.disposeCurrent()])
    const errors = [...closed, ...disposed].flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    )
    if (errors.length) throw new AggregateError(errors, 'RFC-395 current fixture cleanup')
  }
  async cancelQueries(): Promise<void> {
    await this.runtimeValue?.cancelQueries()
  }
  async close(): Promise<void> {
    const current = await Promise.allSettled([this.closeCurrent()])
    const results = [
      ...current,
      ...(await Promise.allSettled(
        [...this.templates.values()].flatMap((template) =>
          Buffer.isBuffer(template) ? [] : [template.drop()],
        ),
      )),
    ]
    this.templates.clear()
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    )
    if (errors.length) throw new AggregateError(errors, 'RFC-395 fixture generations cleanup')
  }
}
