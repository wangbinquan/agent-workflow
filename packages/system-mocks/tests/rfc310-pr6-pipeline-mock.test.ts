// RFC-310 PR-6 T70 —— pipeline provider mock 的完整用例防护（用户裁决④）。
//
// 锁 mock 的 HTTP 合同与故障注入面：①trigger 幂等（同 idempotencyKey 永远
// 同 runRef）；②retry-response-lost（首次 500 但 run 已建，同 key 重试
// adopted:true，绝无第二个 run）；③rerun attempt 递增 + 幂等 + running 409；
// ④outage 整站 503；⑤partial 响应不带 head 绑定；⑥head race 读 N 次后翻转；
// ⑦大流端点（64MB）流式 hash 一致且 content-length 精确。
// bun test --randomize 会打乱同 describe 内 test 顺序：每个 test 用独立
// headSha 的 seed，互不共享可变状态。

import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'

import {
  startPipelineProviderMock,
  type StartedPipelineProviderMock,
} from '../src/development/pipeline-provider'

setDefaultTimeout(120_000)

let provider: StartedPipelineProviderMock

beforeAll(async () => {
  provider = await startPipelineProviderMock()
})

afterAll(async () => {
  await provider.close()
})

function gate(overrides: Partial<Parameters<typeof provider.mock.seed>[0]['gates'][number]> = {}) {
  return {
    gateKey: 'unit',
    required: true,
    status: 'fail' as const,
    runRef: 'r1',
    attempt: 1,
    retryability: 'safe' as const,
    failureCategories: ['unit-test'],
    logs: [],
    ...overrides,
  }
}

describe('rfc310 pr6 T70 — pipeline provider mock', () => {
  test('trigger is idempotent by key; response-lost run is adopted, never duplicated', async () => {
    const head = '1'.repeat(40)
    provider.mock.seed({ headSha: head, targetSha: 'f'.repeat(40), gates: [] })
    const post = (key: string) =>
      fetch(`${provider.url}/pipelines/${head}/trigger`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gateKeys: ['unit'], idempotencyKey: key }),
      })
    const first = await post('k1')
    expect(first.status).toBe(201)
    const firstBody = (await first.json()) as { runRef: string; adopted: boolean }
    expect(firstBody.adopted).toBe(false)
    const second = await post('k1')
    expect(second.status).toBe(200)
    const secondBody = (await second.json()) as { runRef: string; adopted: boolean }
    expect(secondBody.runRef).toBe(firstBody.runRef)
    expect(secondBody.adopted).toBe(true)
    // 不同 key ⇒ 新 run（幂等域按 key 隔离）。
    const third = await post('k2')
    const thirdBody = (await third.json()) as { runRef: string }
    expect(thirdBody.runRef).not.toBe(firstBody.runRef)

    // response-lost：首次 500 但 run 已创建；同 key 重试 adopt。
    const lostHead = '2'.repeat(40)
    provider.mock.seed({
      headSha: lostHead,
      targetSha: 'f'.repeat(40),
      gates: [],
      retryResponseLost: true,
    })
    const lostPost = () =>
      fetch(`${provider.url}/pipelines/${lostHead}/trigger`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gateKeys: ['unit'], idempotencyKey: 'lost-1' }),
      })
    const lostFirst = await lostPost()
    expect(lostFirst.status).toBe(500)
    const lostRetry = await lostPost()
    expect(lostRetry.status).toBe(200)
    const lostBody = (await lostRetry.json()) as { adopted: boolean; runRef: string }
    expect(lostBody.adopted).toBe(true)
    // 状态面只有这一个 run（trigger 创建的 gate 只出现一次）。
    const state = (await (await fetch(`${provider.url}/pipelines/${lostHead}`)).json()) as {
      gates: { gateKey: string; runRef: string }[]
    }
    expect(state.gates.filter((g) => g.gateKey === 'unit')).toHaveLength(1)
    expect(state.gates[0]!.runRef).toBe(lostBody.runRef)
  })

  test('rerun bumps attempt, is idempotent by key, and refuses a running gate with 409', async () => {
    const head = '3'.repeat(40)
    provider.mock.seed({
      headSha: head,
      targetSha: 'f'.repeat(40),
      gates: [
        gate({ runRef: 'rr-1' }),
        gate({ gateKey: 'lint', runRef: 'rr-2', status: 'running' }),
      ],
    })
    const rerun = (runRef: string, gateKey: string, key: string) =>
      fetch(`${provider.url}/pipelines/${head}/runs/${runRef}/rerun`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gateKey, idempotencyKey: key }),
      })
    const first = await rerun('rr-1', 'unit', 'rk1')
    expect(first.status).toBe(201)
    expect(((await first.json()) as { attempt: number }).attempt).toBe(2)
    // 同 key 重放：同 attempt，不再自增。
    const replay = await rerun('rr-1', 'unit', 'rk1')
    expect(replay.status).toBe(200)
    expect(((await replay.json()) as { attempt: number }).attempt).toBe(2)
    // running gate 拒绝。
    expect((await rerun('rr-2', 'lint', 'rk2')).status).toBe(409)
    // 未知 run/gate 404。
    expect((await rerun('nope', 'unit', 'rk3')).status).toBe(404)
  })

  test('outage seeds 503 everywhere; partial omits bindings; head/target races flip after N reads', async () => {
    const partialHead = '4'.repeat(40)
    provider.mock.seed({
      headSha: partialHead,
      targetSha: 'f'.repeat(40),
      gates: [gate()],
      partial: true,
    })
    const partial = (await (await fetch(`${provider.url}/pipelines/${partialHead}`)).json()) as {
      headSha?: string
      targetSha?: string
      gates: unknown[]
    }
    expect(partial.headSha).toBeUndefined()
    expect(partial.targetSha).toBeUndefined()
    expect(partial.gates).toHaveLength(1)

    const raceHead = '5'.repeat(40)
    const newHead = '6'.repeat(40)
    provider.mock.seed({
      headSha: raceHead,
      targetSha: 'f'.repeat(40),
      gates: [gate()],
      headRace: { flipAfterReads: 2, newHeadSha: newHead },
    })
    const read = async () =>
      ((await (await fetch(`${provider.url}/pipelines/${raceHead}`)).json()) as { headSha: string })
        .headSha
    expect(await read()).toBe(raceHead)
    expect(await read()).toBe(raceHead)
    expect(await read()).toBe(newHead) // 第三次读：head 前进了（fence 素材）

    const targetRaceHead = 'a'.repeat(40)
    const oldTarget = 'b'.repeat(40)
    const newTarget = 'c'.repeat(40)
    provider.mock.seed({
      headSha: targetRaceHead,
      targetSha: oldTarget,
      gates: [gate()],
      targetRace: { flipAfterReads: 1, newTargetSha: newTarget },
    })
    const readTarget = async () =>
      (
        (await (await fetch(`${provider.url}/pipelines/${targetRaceHead}`)).json()) as {
          targetSha: string
        }
      ).targetSha
    expect(await readTarget()).toBe(oldTarget)
    expect(await readTarget()).toBe(newTarget)

    // outage：注入后整站 503（独立 provider 实例避免污染其他 test）。
    const outage = await startPipelineProviderMock()
    try {
      outage.mock.seed({
        headSha: '7'.repeat(40),
        targetSha: 'f'.repeat(40),
        gates: [],
        outage: true,
      })
      expect((await fetch(`${outage.url}/pipelines/${'7'.repeat(40)}`)).status).toBe(503)
      expect(
        (
          await fetch(`${outage.url}/pipelines/${'7'.repeat(40)}/trigger`, {
            method: 'POST',
            body: JSON.stringify({ gateKeys: ['unit'], idempotencyKey: 'x' }),
          })
        ).status,
      ).toBe(503)
    } finally {
      await outage.close()
    }
  })

  test('64MB log stream: exact content-length, stable hash, chunked consumption', async () => {
    const head = '8'.repeat(40)
    const bytes = 64 * 1024 * 1024
    provider.mock.seed({
      headSha: head,
      targetSha: 'f'.repeat(40),
      gates: [gate({ runRef: 'big-run', logs: [{ logId: 'big', bytes }] })],
    })
    const res = await fetch(`${provider.url}/runs/big-run/logs/big`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe(String(bytes))
    const hash = createHash('sha256')
    let total = 0
    const reader = res.body!.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
      total += value.byteLength
    }
    expect(total).toBe(bytes)
    // 同一 seed 的流内容确定：再读一遍 hash 一致。
    const res2 = await fetch(`${provider.url}/runs/big-run/logs/big`)
    const hash2 = createHash('sha256')
    const reader2 = res2.body!.getReader()
    for (;;) {
      const { done, value } = await reader2.read()
      if (done) break
      hash2.update(value)
    }
    expect(hash2.digest('hex')).toBe(hash.digest('hex'))
  })
})
