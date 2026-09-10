// Agent 引用声明的两道校验：分支端口必须是自己声明过的 output；引用的 runtime 必须存在且可用。
//
// RFC-359 W57：这两条此前各被抄了一份——`assertBranchPortsDeclared` 在
// `digitalEmployeeAgentTemplateCatalog.ts` 有一份私有副本（本文件明明已经导出了它），
// `assertRuntimeReference` 则在该文件与
// `aggregateAdapters/postgresqlResourcePackageMutationArms.ts` 各一份，**逐字相同**，
// 唯一差别是事务的类型名（`ResourceCatalogTransaction` / `PostgresqlResourceCatalogTransaction`，
// 两者都是 `DatabaseTransaction` 派生）。它们抛的是**用户可见的校验错误**
// （`branch-port-not-declared` / `runtime-not-found` / `runtime-disabled`），
// 多一份实现就是多一条可能给出不同措辞或不同判据的路径。

import type { CreateAgent } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'

import { runtimes } from '@/db/schema'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
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

/** `previous` 是本次改动前引用的 runtime：已经在用的那个即便被停用也放行，换成别的才拦。 */
export async function assertRuntimeReference(input: {
  readonly transaction: DatabaseTransaction
  readonly name: string | null | undefined
  readonly previous?: string
}): Promise<void> {
  if (input.name === null || input.name === undefined) return
  const row = await input.transaction
    .select({ name: runtimes.name, enabled: runtimes.enabled })
    .from(runtimes)
    .where(eq(runtimes.name, input.name))
    .get()
  if (row === undefined) {
    throw new ValidationError(
      'runtime-not-found',
      `agent references unknown runtime: ${input.name}`,
      {
        notFound: [input.name],
      },
    )
  }
  if (!row.enabled && input.name !== input.previous) {
    throw new ValidationError(
      'runtime-disabled',
      `agent references disabled runtime: ${input.name}; enable it or pick another`,
      { disabled: [input.name] },
    )
  }
}
