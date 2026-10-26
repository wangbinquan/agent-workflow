// RFC-395 II-a A3：旧房间用例经 owner selection 投影构造输入，断言仍覆盖原业务语义。
import { projectWorkgroupRunSelections } from './workgroupSelectionFixture'
import * as room from '@/modules/resource-catalog/application/workgroups/workgroupRoomProjection'

export type HostRunLite = Omit<room.HostRunLite, 'selection'>
export type RoundLedgerRow = Omit<room.RoundLedgerRow, 'selection'>
export type {
  MemberLite,
  RoundedWorkgroupMode,
} from '@/modules/resource-catalog/application/workgroups/workgroupRoomProjection'
export { roundedModeOf } from '@/modules/resource-catalog/application/workgroups/workgroupRoomProjection'

type HistoryArgs = Parameters<typeof room.deriveWorkgroupRunHistory>
type ProjectionInput = [
  HistoryArgs[0],
  HistoryArgs[1],
  readonly HostRunLite[],
  HistoryArgs[3],
  HistoryArgs[4],
  HistoryArgs[5]?,
]

export async function deriveWorkgroupRunHistory(...args: ProjectionInput) {
  return room.deriveWorkgroupRunHistory(
    args[0],
    args[1],
    await projectWorkgroupRunSelections(args[2]),
    args[3],
    args[4],
    args[5],
  )
}

export async function deriveMemberCurrentRuns(...args: ProjectionInput) {
  return room.deriveMemberCurrentRuns(
    args[0],
    args[1],
    await projectWorkgroupRunSelections(args[2]),
    args[3],
    args[4],
    args[5],
  )
}

export async function deriveBudgetUsed(
  mode: room.RoundedWorkgroupMode,
  rows: readonly RoundLedgerRow[],
) {
  return room.deriveBudgetUsed(mode, await projectWorkgroupRunSelections(rows))
}
