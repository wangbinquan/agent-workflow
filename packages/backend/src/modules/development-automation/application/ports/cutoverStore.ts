// RFC-310 PR-9 —— cutover 持久化 port（application 不摸 DB，队形同 MissionStore）。

import type { CutoverState } from '../../domain/cutover'

export interface CutoverStore {
  /** 读 durable cutover 状态（缺行/坏行回 INITIAL——domain.parseCutoverState 语义）。 */
  readState(): Promise<CutoverState>
  writeState(state: CutoverState, now: number): Promise<void>
}
