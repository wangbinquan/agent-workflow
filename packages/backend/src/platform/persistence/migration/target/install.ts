import type { HistoryConnection } from '../../schema/history/connection'
import { persistenceDialect } from '../../nativeDialect'
import { installConversionHistoryHead } from '../../schema/history/apply'
import type { HistoryVersion } from '../../schema/history/types'
import type { MetaTableDeclaration } from '../../schema/history/meta'
import type { ConversionTargetConnection } from '../run/types'

export async function installConversionTarget(
  target: ConversionTargetConnection,
  input: {
    head: HistoryVersion
    metaTables: readonly MetaTableDeclaration[]
    generationId: string
    now: number
    initialize?: (tx: HistoryConnection) => Promise<void>
  },
) {
  for (const sql of persistenceDialect(target.provider).suspendForeignKeys)
    await target.execute(sql)
  return target.transaction(async (tx) => {
    const installed = await installConversionHistoryHead(tx, {
      version: input.head,
      metaTables: input.metaTables,
      generationId: input.generationId,
      now: () => input.now,
    })
    await input.initialize?.(tx)
    return installed
  })
}
