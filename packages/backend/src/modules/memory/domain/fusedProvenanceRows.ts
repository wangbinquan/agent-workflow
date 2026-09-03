// RFC-353 T9（RFC-294 W4-E3）—— 「某个技能吃进了哪些记忆」的只读投影判据。
//
// 归属：`memories` 的列归 memory，所以「哪几行算这个技能的来源」由 memory 裁定；
// 「怎么按版本分组呈现」是知识演化的事，归 knowledge-evolution（`domain/skillProvenance`）。
//
// 与 `domain/fusionMembership` 的分工：那边管**写**（谁被标记 / 谁被退回），
// 这边管**读**（谁算数）。两边共用同一个不变式——fused ⟺ 该知识在技能的某一版里，
// 所以这里必须同时看 `status === 'fused'` 与 `fusedIntoSkillId`：只看后者会把
// 「曾经融入、后来被回滚退回」的行也算进来（退回时清的是 status 与 provenance，
// 但历史行仍可能残留旧 id，见 RFC-223 的 provenance 修复）。

/** 只读投影要的最小行形状——刻意不吃整行 `Memory`，来源面板不需要正文。 */
export interface FusedMemoryRow {
  readonly id: string
  readonly title: string
  readonly scopeType: 'agent' | 'workflow' | 'repo' | 'repo_group' | 'global'
  readonly scopeId: string | null
  readonly status: string
  readonly fusedIntoSkillId: string | null
  readonly fusedIntoSkillVersion: number | null
}

/** 这一行现在是否真的算「这个技能第 N 版吃进去的知识」。 */
export function countsAsFusedInto(row: FusedMemoryRow, skillId: string): boolean {
  return (
    row.status === 'fused' && row.fusedIntoSkillId === skillId && row.fusedIntoSkillVersion !== null
  )
}

/**
 * 选中 + 定序。顺序取**字典序的 id**，理由同 `domain/fusionMembership#orderMembershipIds`：
 * rowid 顺序是存储实现的副产物，不是承诺，两个 provider 上会漂。
 */
export function fusedIntoSkill(rows: readonly FusedMemoryRow[], skillId: string): FusedMemoryRow[] {
  return rows
    .filter((row) => countsAsFusedInto(row, skillId))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}
