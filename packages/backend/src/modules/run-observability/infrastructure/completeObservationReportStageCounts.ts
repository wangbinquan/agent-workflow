import { and, eq, or, sql } from 'drizzle-orm'
import { observationReportCounts } from '@/db/schema'
import { affectedRows, type DatabaseTransaction } from '@/platform/persistence/databaseTransaction'

interface CountIdentity {
  readonly section: string
  readonly parent: string
}
interface CountDeclaration extends CountIdentity {
  readonly total: string
}
interface CountRows extends CountIdentity {
  readonly size: bigint
}
const identity = (group: CountIdentity) => JSON.stringify([group.section, group.parent])
const scope = (group: CountIdentity) =>
  and(
    eq(observationReportCounts.section, group.section),
    eq(observationReportCounts.parent, group.parent),
  )
// Each OR arm retains the full composite key for an exact indexed lookup.
const reportScope = (id: string, group: CountIdentity) =>
  and(eq(observationReportCounts.reportId, id), scope(group))
async function currentGroups(
  tx: DatabaseTransaction,
  id: string,
  groups: readonly CountIdentity[],
) {
  const found = await tx
    .select()
    .from(observationReportCounts)
    .where(or(...groups.map((group) => reportScope(id, group))))
    .all()
  return new Map(found.map((group) => [identity(group), group]))
}

/** The original page bounds only the batch; every subsequent page is still staged to EOF. */
export async function declareCompleteReportCounts(
  tx: DatabaseTransaction,
  id: string,
  declarations: readonly CountDeclaration[],
) {
  if (!declarations.length) return
  const seen = new Set<string>()
  for (const declaration of declarations) {
    const key = identity(declaration)
    if (seen.has(key)) throw new Error('Original report count identity duplicated')
    seen.add(key)
  }
  const current = await currentGroups(tx, id, declarations),
    inserts: (typeof observationReportCounts.$inferInsert)[] = [],
    updates: CountDeclaration[] = []
  for (const declaration of declarations) {
    const previous = current.get(identity(declaration))
    if (previous?.declared) throw new Error('Original report count identity duplicated')
    if (previous) updates.push(declaration)
    else inserts.push({ reportId: id, ...declaration, actual: '0', declared: true })
  }
  if (inserts.length) await tx.insert(observationReportCounts).values(inserts).run()
  if (updates.length) {
    const changed = await tx.run(sql`
      with changed(section,parent,total) as (values ${sql.join(
        updates.map((group) => sql`(${group.section},${group.parent},${group.total})`),
        sql`,`,
      )})
      update ${observationReportCounts} as target
      set total=changed.total,declared=${sql.param(true, observationReportCounts.declared)}
      from changed
      where target.report_id=${id} and target.section=changed.section
        and target.parent=changed.parent
        and target.declared=${sql.param(false, observationReportCounts.declared)}
    `)
    if (affectedRows(changed) !== updates.length)
      throw new Error('Original report count identity duplicated')
  }
}

/** Keep each original text-count CAS and arbitrary-precision addition inside the page transaction. */
export async function addCompleteReportGroupRows(
  tx: DatabaseTransaction,
  id: string,
  groups: readonly CountRows[],
) {
  if (!groups.length) return
  const current = await currentGroups(tx, id, groups),
    inserts: (typeof observationReportCounts.$inferInsert)[] = [],
    updates: Array<CountIdentity & { previous: string; actual: string }> = []
  for (const group of groups) {
    const previous = current.get(identity(group))
    if (previous)
      updates.push({
        section: group.section,
        parent: group.parent,
        previous: previous.actual,
        actual: String(BigInt(previous.actual) + group.size),
      })
    else
      inserts.push({
        reportId: id,
        section: group.section,
        parent: group.parent,
        actual: String(group.size),
        total: '0',
        declared: false,
      })
  }
  if (inserts.length) await tx.insert(observationReportCounts).values(inserts).run()
  if (updates.length) {
    const changed = await tx.run(sql`
      with changed(section,parent,previous,actual) as (values ${sql.join(
        updates.map(
          (group) => sql`(${group.section},${group.parent},${group.previous},${group.actual})`,
        ),
        sql`,`,
      )})
      update ${observationReportCounts} as target set actual=changed.actual
      from changed
      where target.report_id=${id} and target.section=changed.section
        and target.parent=changed.parent and target.actual=changed.previous
    `)
    if (affectedRows(changed) !== updates.length)
      throw new Error('Original report row count changed during transfer')
  }
}
