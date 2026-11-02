// Agent 引用声明的两道校验：分支端口必须是自己声明过的 output；引用的 runtime 必须存在且可用。
//
// RFC-401 A1：runtime 判定改为经查询接口的一份实现（`assertAgentRuntime`），由唯一的 agent 写入参与者调用；普通 CRUD
// 的装配可以注入 runtime registry 查询，其余入口读事务内的 `runtimes` 表，两者数据源相同。
//
// RFC-359 W57：这两条此前各被抄了一份——`assertBranchPortsDeclared` 在
// `digitalEmployeeAgentTemplateCatalog.ts` 有一份私有副本（本文件明明已经导出了它），
// `assertRuntimeReference` 则在该文件与
// `aggregateAdapters/postgresqlResourcePackageMutationArms.ts` 各一份，**逐字相同**，
// 唯一差别是事务的类型名（`ResourceCatalogTransaction` / `PostgresqlResourceCatalogTransaction`，
// 两者都是 `PersistenceTx` 派生）。它们抛的是**用户可见的校验错误**
// （`branch-port-not-declared` / `runtime-not-found` / `runtime-disabled`），
// 多一份实现就是多一条可能给出不同措辞或不同判据的路径。

import { tablesOf } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import type { CreateAgent } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'

import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import { ValidationError } from '@/util/errors'

export function assertBranchPortsDeclared(
  agent: Pick<CreateAgent, 'outputs' | 'branchPorts'>,
): void {
  if (agent.branchPorts === undefined || agent.branchPorts.length === 0) return
  const outputs = new Set(agent.outputs)
  const missing = agent.branchPorts.filter((port) => !outputs.has(port))
  if (missing.length === 0) return
  throw new ValidationError(
    'branch-port-not-declared',
    `agent branchPorts reference undeclared output port(s): ${missing.join(', ')}`,
    { notFound: missing },
  )
}

/** Closed runtime-registry projection: whether a runtime exists and whether it is enabled. */
export interface AgentRuntimeProfileLookup {
  get(name: string): Promise<Readonly<{ enabled: boolean }> | null>
}

/** The `runtimes` table read in the caller's transaction (RFC-401 A1: the participant's default lookup). */
export function transactionRuntimeLookup(transaction: PersistenceTx): AgentRuntimeProfileLookup {
  return Object.freeze({
    async get(name: string) {
      const { runtimes } = tablesOf(transaction)
      const row = await first(
        transaction
          .select({ enabled: runtimes.enabled })
          .from(runtimes)
          .where(eq(runtimes.name, name)),
      )
      return row === undefined ? null : Object.freeze({ enabled: row.enabled })
    },
  })
}

/** `previous` 是本次改动前引用的 runtime：已经在用的那个即便被停用也放行，换成别的才拦。 */
export async function assertAgentRuntime(
  lookup: AgentRuntimeProfileLookup,
  name: string | null | undefined,
  previous?: string,
): Promise<void> {
  if (name === null || name === undefined) return
  const profile = await lookup.get(name)
  if (profile === null) {
    throw new ValidationError('runtime-not-found', `agent references unknown runtime: ${name}`, {
      notFound: [name],
    })
  }
  if (!profile.enabled && name !== previous) {
    throw new ValidationError(
      'runtime-disabled',
      `agent references disabled runtime: ${name}; enable it or pick another`,
      { disabled: [name] },
    )
  }
}
