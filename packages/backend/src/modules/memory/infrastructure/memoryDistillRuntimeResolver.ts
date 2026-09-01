import { eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { runtimes } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { RUNTIME_KINDS } from '@/services/runtime'
import type {
  MemoryDistillRuntimeResolver,
  ResolvedMemoryDistillRuntime,
} from '../application/ports/distillWorkStore'

interface RuntimeProfileRow {
  readonly protocol: 'opencode' | 'claude-code'
  readonly binaryPath: string | null
  readonly model: string | null
  readonly isSandbox: boolean
}

function pick(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function fallback(protocol: 'opencode' | 'claude-code' = 'opencode') {
  return {
    protocol,
    binaryPath: null,
    model: null,
    isSandbox: false,
  } satisfies ResolvedMemoryDistillRuntime
}

abstract class BaseMemoryDistillRuntimeResolver implements MemoryDistillRuntimeResolver {
  protected abstract find(name: string): Promise<RuntimeProfileRow | null>

  async resolve(
    input: Parameters<MemoryDistillRuntimeResolver['resolve']>[0],
  ): Promise<ResolvedMemoryDistillRuntime> {
    const runtimeName = pick(input.runtimeName)
    if (runtimeName !== null) return await this.resolveName(runtimeName)
    const legacyModel = pick(input.deprecatedModel)
    if (legacyModel !== null) return { ...fallback(), model: legacyModel }
    return await this.resolveName(pick(input.defaultRuntime) ?? 'opencode')
  }

  private async resolveName(name: string): Promise<ResolvedMemoryDistillRuntime> {
    const row = await this.find(name)
    if (row !== null) return row
    return RUNTIME_KINDS.includes(name as 'opencode' | 'claude-code')
      ? fallback(name as 'opencode' | 'claude-code')
      : fallback()
  }
}

export class SqliteMemoryDistillRuntimeResolver extends BaseMemoryDistillRuntimeResolver {
  constructor(private readonly db: DbClient) {
    super()
  }

  protected async find(name: string): Promise<RuntimeProfileRow | null> {
    return (
      this.db
        .select({
          protocol: runtimes.protocol,
          binaryPath: runtimes.binaryPath,
          model: runtimes.model,
          isSandbox: runtimes.isSandbox,
        })
        .from(runtimes)
        .where(eq(runtimes.name, name))
        .limit(1)
        .get() ?? null
    )
  }
}

export class PostgresqlMemoryDistillRuntimeResolver extends BaseMemoryDistillRuntimeResolver {
  constructor(private readonly db: PostgresqlDatabaseClient) {
    super()
  }

  protected async find(name: string): Promise<RuntimeProfileRow | null> {
    const rows = await this.db
      .select({
        protocol: runtimes.protocol,
        binaryPath: runtimes.binaryPath,
        model: runtimes.model,
        isSandbox: runtimes.isSandbox,
      })
      .from(runtimes)
      .where(eq(runtimes.name, name))
      .limit(1)
    return rows[0] ?? null
  }
}
