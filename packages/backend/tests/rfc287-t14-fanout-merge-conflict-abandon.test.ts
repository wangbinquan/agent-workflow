// RFC-287 T14 —— fanout 两条线（分片 L5 / 聚合 L6）撞不可解冲突时也必须 abandon。
//
// 这是 RFC-187 T8 那个 bug 的**同一份**，只是当年只给工作组主机线修了：
//
//   `mergeBackAndSettle` 在返回 `conflict-human` **之前**就已经把行落库成
//   merge_state='conflict-human'（isolatedAgentRun.ts 的 park-conflict-human）。
//   那个状态是一句承诺——「人会在**被保留的**解冲突 iso 里把它合完，随后的 resume
//   会重新合并」——所以 DAG 线走这条路时会 keepIso 并把任务停在 awaiting_human。
//   可 fanout 的两条线许不起这个承诺：它们返回 `keep: false`，骨架随即丢弃 iso 并
//   删掉 pin refs。于是库里留着一句没人能兑现的承诺，而
//   `replayConflictHumanResolutions` 在**每个**任务的 runTask 入口都跑——下次 resume
//   会去找已经被 GC 的 base/node 提交，抛错，把**整个任务**打挂。
//
// 迁移前（63adfb66^ 的 7984 / 8411）两条线同样只 return failed、不 abandon，所以这
// 是**既存缺陷**而非 RFC-287 的迁移回归；用户拍板在本 RFC 内一并补掉，照抄 L1 的
// 先例：这份 delta 是真的被丢弃了，状态就该如实说 abandoned。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { allowedFromForMergeEvent, targetForMergeEvent } from '@agent-workflow/shared'

const SCHED = readFileSync(
  resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
  'utf8',
)
const NODE_MECHANICS = readFileSync(
  resolve(
    import.meta.dir,
    '..',
    'src',
    'modules',
    'task-execution',
    'composition',
    'nodeMechanics.ts',
  ),
  'utf8',
)

/** 截出一段 `disposition: {` 声明块——按缩进配平，避免跨到兄弟线上去。 */
function dispositionAfter(anchor: string): string {
  const at = SCHED.indexOf(anchor)
  expect(at).toBeGreaterThan(0)
  const declAt = SCHED.indexOf('disposition: {', at)
  expect(declAt).toBeGreaterThan(at)
  // 到下一个同级 `},\n` 收尾即可——射程给足但不跨函数。
  return SCHED.slice(declAt, declAt + 2400)
}

describe('RFC-287 T14 — fanout 撞冲突必须落 abandon（既存缺陷，用户拍板本 RFC 内补）', () => {
  test('前提：conflict-human → abandoned 是合法转移（否则整条修法不成立）', () => {
    const ev = { kind: 'abandon', reason: 'fanout-shard-merge-conflict-unresolved' } as const
    expect(targetForMergeEvent(ev)).toBe('abandoned')
    expect(JSON.stringify(allowedFromForMergeEvent(ev))).toContain('conflict-human')
  })

  test('分片线（L5）：onConflictHuman 在返回 failed 之前 abandon', () => {
    const decl = dispositionAfter('conflictNodeRunId: shardRunId')
    // `await` 必须写进正则（二轮门自查实证）：改成 fire-and-forget 的 `void` 时，
    // abandon 的落库会与骨架随后的 iso discard 竞争——而这条 finding 的要害恰恰
    // 是「库里留下一句没人兑现的承诺」，落库时序就是全部。只锁三个片段依次出现的
    // 话，`void` 版本照样全绿。
    expect(decl).toMatch(
      /onConflictHuman:[\s\S]{0,800}await tryTransitionMergeState\([\s\S]{0,300}fanout-shard-merge-conflict-unresolved[\s\S]{0,400}merge-back-conflict/,
    )
  })

  test('聚合线（L6）：onConflictHuman 在返回 failed 之前 abandon', () => {
    const decl = dispositionAfter('conflictNodeRunId: aggRunId')
    // `await` 必须写进正则（二轮门自查实证）：改成 fire-and-forget 的 `void` 时，
    // abandon 的落库会与骨架随后的 iso discard 竞争——而这条 finding 的要害恰恰
    // 是「库里留下一句没人兑现的承诺」，落库时序就是全部。只锁三个片段依次出现的
    // 话，`void` 版本照样全绿。
    expect(decl).toMatch(
      /onConflictHuman:[\s\S]{0,800}await tryTransitionMergeState\([\s\S]{0,300}fanout-agg-merge-conflict-unresolved[\s\S]{0,400}merge-back-conflict/,
    )
  })

  // abandon 的**理由**正是「树留不住」。若哪天有人把这条路径改成 keep: true（真的
  // 保留解冲突 iso），那 abandon 就该同步撤掉、改回 conflict-human 停人工——两者
  // 必须一起动。这条断言就是那个联动的守卫。
  test('两条线的冲突路径都必须保持 keep:false（abandon 的前提）', () => {
    for (const anchor of ['conflictNodeRunId: shardRunId', 'conflictNodeRunId: aggRunId']) {
      const decl = dispositionAfter(anchor)
      const conflictDecl = /onConflictHuman: \(detail\) => \(\{[\s\S]*?\n {10}\}\),/.exec(decl)
      expect(conflictDecl, anchor).not.toBeNull()
      expect(conflictDecl![0]).toContain('keep: false')
      expect(conflictDecl![0]).not.toMatch(/keep: true/)
    }
  })

  // 三条线（工作组 + fanout 两条）现在用的是同一套处置，理由 slug 各自不同以便审计
  // 能区分是哪条线丢的。少任何一条都说明有线又退回「留状态不留树」。
  test('三条 keep:false 的线都各有自己的 abandon 理由 slug', () => {
    for (const [reason, owner] of [
      ['wg-merge-conflict-unresolved', NODE_MECHANICS],
      ['fanout-shard-merge-conflict-unresolved', SCHED],
      ['fanout-agg-merge-conflict-unresolved', SCHED],
    ] as const) {
      expect(owner, reason).toContain(reason)
    }
  })
})
