// 回归防护 —— clarify 续跑载荷的解码必须认得**问题派发**那一种血统。
//
// 为什么这条测试存在：`legacySqliteTaskQuestionDispatch` 释放的是同一个 clarify
// park（`gate.kind === 'clarify'`），但它写下的血统是
// `{ sourceNodeRunIds: [], rerunNodeRunIds }`——没有单一 origin run。
// `decodeClaimedClarifyContinuation` 却只接受「答复」那一种形状（恰好一个 source、
// 零个 rerun），于是每一条问题派发续跑在 daemon 重启后都解码失败：
// pre-drive 抛 `clarify gate continuation payload does not match its durable decision`，
// 任务驱动根本没开始，评审门永远不再出现。
// e2e `rfc294-human-gate-restart`「question dispatch recovers the committed
// continuation after SIGKILL before wake」死在这条上。
//
// 判据：派发血统 ⇒ 无需 clarify 收敛（返回 null ⇒ pre-drive 直接 ready）；
// 答复血统 ⇒ 照旧解出 origin；真正畸形的载荷 ⇒ 照旧 fail closed。

import { describe, expect, test } from 'bun:test'
import { decodeClaimedClarifyContinuation } from '../src/modules/task-execution/application/claimedClarifyContinuation'

const base = {
  v: 1,
  operationId: '01M0RFC333OPERATION0000000',
  gate: { kind: 'clarify', ref: 'clarify:01M0RFC333ORIGINRUN000000' },
}

describe('clarify gate continuation decode', () => {
  test('a question-dispatch continuation needs no clarify convergence', () => {
    const payload = JSON.stringify({
      ...base,
      continuationLineage: {
        sourceNodeRunIds: [],
        rerunNodeRunIds: ['01M0RFC333RERUNRUN00000000'],
      },
    })
    expect(decodeClaimedClarifyContinuation(payload)).toBeNull()
  })

  test('an answered clarify continuation still resolves its exact origin run', () => {
    const payload = JSON.stringify({
      ...base,
      continuationLineage: {
        sourceNodeRunIds: ['01M0RFC333ORIGINRUN000000'],
        rerunNodeRunIds: [],
      },
    })
    expect(decodeClaimedClarifyContinuation(payload)).toEqual({
      operationId: base.operationId,
      gateRef: base.gate.ref,
      originNodeRunId: '01M0RFC333ORIGINRUN000000',
    })
  })

  test('a non-clarify gate is not this decoder’s business', () => {
    const payload = JSON.stringify({
      ...base,
      gate: { kind: 'review', ref: 'review:01M0RFC333REVIEWRUN000000' },
      continuationLineage: { sourceNodeRunIds: [], rerunNodeRunIds: [] },
    })
    expect(decodeClaimedClarifyContinuation(payload)).toBeNull()
  })

  test('a malformed clarify payload still fails closed', () => {
    for (const lineage of [
      { sourceNodeRunIds: ['a', 'b'], rerunNodeRunIds: [] },
      { sourceNodeRunIds: [''], rerunNodeRunIds: [] },
      { sourceNodeRunIds: ['01M0RFC333ORIGINRUN000000'], rerunNodeRunIds: ['x'] },
      { sourceNodeRunIds: 'nope', rerunNodeRunIds: [] },
    ]) {
      expect(() =>
        decodeClaimedClarifyContinuation(JSON.stringify({ ...base, continuationLineage: lineage })),
      ).toThrow('does not match its durable decision')
    }
    expect(() => decodeClaimedClarifyContinuation('{')).toThrow('is not valid JSON')
  })
})
