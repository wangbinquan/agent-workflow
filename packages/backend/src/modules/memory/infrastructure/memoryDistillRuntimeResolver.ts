import { eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { runtimes } from '@/db/schema'
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

/** RFC-359 W4-D4：一份实现，两个 provider 共用——按名字取运行时档案，缺省回落到内建 kind。 */
export class DrizzleMemoryDistillRuntimeResolver implements MemoryDistillRuntimeResolver {
  constructor(private readonly db: ProviderNeutralDatabase) {}

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

  private async find(name: string): Promise<RuntimeProfileRow | null> {
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

/** 旧名保留为装配别名，PG 装配收敛后删除。 */
export {
  DrizzleMemoryDistillRuntimeResolver as PostgresqlMemoryDistillRuntimeResolver,
  DrizzleMemoryDistillRuntimeResolver as SqliteMemoryDistillRuntimeResolver,
}
