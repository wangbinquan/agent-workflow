// RFC-225 — versioned workgroup persistence.
//
// A workgroup is one editable document: metadata, runtime config, ordered
// roster and leader relation. Every production content write is fenced by the
// stable workgroup id + expected version and returns an exact in-transaction
// receipt. Launched tasks remain isolated by their frozen config snapshot.
// RFC-401 T6 (proposal G5): only the reads remain here; workgroup rows are written by
// `workgroupMutationParticipant.ts`.

import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { type Workgroup, type WorkgroupDetail } from '@agent-workflow/shared'

import { eq, inArray } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { workgroupToDetail, workgroupFromCopiedRows } from '../workgroupPersistence'
export {
  workgroupDraftSnapshotOf,
  workgroupSnapshotHashOf,
  workgroupRevisionOf,
  workgroupToDetail,
} from '../workgroupPersistence'

type WorkgroupRow = PersistenceTables['workgroups']['$inferSelect']
type MemberRow = PersistenceTables['workgroupMembers']['$inferSelect']

export async function listWorkgroups(db: PersistenceDb): Promise<Workgroup[]> {
  const { workgroups, workgroupMembers } = tablesOf(db)
  const rows = await db.select().from(workgroups)
  if (rows.length === 0) return []
  const memberRows = await db
    .select()
    .from(workgroupMembers)
    .where(
      inArray(
        workgroupMembers.workgroupId,
        rows.map((row) => row.id),
      ),
    )
  const byGroup = new Map<string, MemberRow[]>()
  for (const member of memberRows) {
    const list = byGroup.get(member.workgroupId)
    if (list === undefined) byGroup.set(member.workgroupId, [member])
    else list.push(member)
  }
  return rows.map((row) => rowToWorkgroup(row, byGroup.get(row.id) ?? []))
}

export async function getWorkgroupById(
  db: PersistenceDb,
  id: string,
): Promise<WorkgroupDetail | null> {
  const { workgroups } = tablesOf(db)
  const row = await db.select().from(workgroups).where(eq(workgroups.id, id)).limit(1)
  return row[0] === undefined ? null : getWorkgroupDetailByRow(db, row[0])
}

/** New canonical agent ids referenced by `next` that `prev` did not reference. */
export function diffNewAgentMemberIds(
  prev: Pick<Workgroup, 'members'> | null,
  next: { members: ReadonlyArray<{ memberType: string; agentId?: string }> },
): string[] {
  const previous = new Set(
    (prev?.members ?? []).flatMap((member) =>
      member.memberType === 'agent' && member.agentId ? [member.agentId] : [],
    ),
  )
  return [
    ...new Set(
      next.members.flatMap((member) => {
        if (member.memberType !== 'agent') return []
        return member.agentId && !previous.has(member.agentId) ? [member.agentId] : []
      }),
    ),
  ]
}

async function getWorkgroupDetailByRow(
  db: PersistenceDb,
  row: WorkgroupRow,
): Promise<WorkgroupDetail> {
  const { workgroupMembers } = tablesOf(db)
  const members = await db
    .select()
    .from(workgroupMembers)
    .where(eq(workgroupMembers.workgroupId, row.id))
  return workgroupToDetail(rowToWorkgroup(row, members))
}

export function rowToWorkgroup(row: WorkgroupRow, memberRows: MemberRow[]): Workgroup {
  return workgroupFromCopiedRows(row, memberRows.slice())
}
