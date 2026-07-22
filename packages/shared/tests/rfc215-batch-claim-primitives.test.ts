// RFC-215 T1 — fc 批量认领的 shared 原语锁：wg_task_results 逐卡汇报解析、
// batch shardKey 单一编解码、clarify askerKey 跨批稳定（design §6.1/§3.1/§6.3）。
// 这些原语是引擎 6 个 `batch:` 消费点（design §9 清单）共享的单一事实源——
// 任何一处 fork 私有解析都会在恢复/重排队路径静默错配，故在源头锁死格式。
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  buildBatchShardKey,
  parseBatchShardKey,
  parseWgTaskResultsPort,
  WG_FC_CLAIM_BATCH_LIMIT,
  WG_PORT_TASK_RESULTS,
  wgClarifyAskerKey,
} from '../src'

describe('RFC-215 — parseWgTaskResultsPort', () => {
  test('valid batch report parses with per-item defaults', () => {
    const r = parseWgTaskResultsPort(
      JSON.stringify([
        { task: 1, summary: 'did A' },
        { task: 2, status: 'failed', summary: 'blocked on X' },
      ]),
      2,
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value[0]?.status).toBe('done') // default
      expect(r.value[1]?.status).toBe('failed')
      expect(r.missing).toEqual([])
    }
  })

  test('missing coverage is NOT a parse error — reported via missing[]', () => {
    const r = parseWgTaskResultsPort(JSON.stringify([{ task: 2, summary: 'only two' }]), 3)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.missing).toEqual([1, 3])
  })

  test('out-of-range and duplicate task indexes reject the whole port', () => {
    const oob = parseWgTaskResultsPort(JSON.stringify([{ task: 4, summary: 'x' }]), 3)
    expect(oob.ok).toBe(false)
    if (!oob.ok) expect(oob.errors.join(' ')).toContain('out of range')

    const dup = parseWgTaskResultsPort(
      JSON.stringify([
        { task: 1, summary: 'a' },
        { task: 1, summary: 'b' },
      ]),
      2,
    )
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.errors.join(' ')).toContain('duplicate')
  })

  test('malformed JSON / wrong shape / empty summary rejected', () => {
    expect(parseWgTaskResultsPort('not json', 1).ok).toBe(false)
    expect(parseWgTaskResultsPort('{"task":1}', 1).ok).toBe(false)
    expect(parseWgTaskResultsPort(JSON.stringify([{ task: 1, summary: '' }]), 1).ok).toBe(false)
  })

  test('array cap rides WG_FC_CLAIM_BATCH_LIMIT', () => {
    const over = Array.from({ length: WG_FC_CLAIM_BATCH_LIMIT + 1 }, (_, i) => ({
      task: i + 1,
      summary: 's',
    }))
    expect(parseWgTaskResultsPort(JSON.stringify(over), WG_FC_CLAIM_BATCH_LIMIT + 1).ok).toBe(false)
    expect(WG_PORT_TASK_RESULTS).toBe('wg_task_results')
  })
})

describe('RFC-215 — batch shardKey codec', () => {
  test('build → parse round-trips memberId and ids', () => {
    const key = buildBatchShardKey('01MEMBERAAAA', ['01CARDA', '01CARDB', '01CARDC'])
    expect(key).toBe('batch:01MEMBERAAAA:01CARDA+01CARDB+01CARDC')
    expect(parseBatchShardKey(key)).toEqual({
      memberId: '01MEMBERAAAA',
      assignmentIds: ['01CARDA', '01CARDB', '01CARDC'],
    })
  })

  test('non-batch shard keys return null (msg:, plain card id, null)', () => {
    expect(parseBatchShardKey(null)).toBeNull()
    expect(parseBatchShardKey('msg:m-a:01M1')).toBeNull()
    expect(parseBatchShardKey('01CARDA')).toBeNull()
    expect(parseBatchShardKey('batch:')).toBeNull()
    expect(parseBatchShardKey('batch:member-only')).toBeNull()
    expect(parseBatchShardKey('batch:m:')).toBeNull()
  })
})

describe('RFC-215 — clarify askerKey collapses batch to the member (design §6.3)', () => {
  const LEADER = '__wg_leader__'

  test('two different batches of the same member share ONE asker key', () => {
    const k1 = wgClarifyAskerKey('__wg_member__', buildBatchShardKey('m-a', ['c1', 'c2']), LEADER)
    const k2 = wgClarifyAskerKey('__wg_member__', buildBatchShardKey('m-a', ['c3']), LEADER)
    expect(k1).toBe('asg:batch:m-a')
    expect(k1).toBe(k2) // 预算连续、stop 指令跨批仍命中（RFC-207 R12 旁路封堵）
  })

  test('single-card (lw) and message-turn asker keys unchanged', () => {
    expect(wgClarifyAskerKey('__wg_member__', '01CARDA', LEADER)).toBe('asg:01CARDA')
    expect(wgClarifyAskerKey('__wg_member__', 'msg:m-a:01M1', LEADER)).toBe('mem:m-a')
    expect(wgClarifyAskerKey(LEADER, null, LEADER)).toBe('leader')
  })

  // RFC-215 finding 回归锁（design §9 第六消费点）：批 shardKey 的 askerKey 曾 fork
  // 私有 `.split(':')[1]`，与其余 5 个 `batch:` 消费点漂移风险。锁死它走单源
  // parseBatchShardKey、且不含手工 split(':')——批 key 格式一旦变，askerKey 身份随单源
  // 联动而非静默错配（预算计数 + stop 指令都 key 在它上）。行为等价由上面两条断言锁。
  test('askerKey 走单源 parseBatchShardKey，不再手工 split(":")', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'schemas', 'workgroup.ts'),
      'utf-8',
    )
    const start = src.indexOf('export function wgClarifyAskerKey')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('\nexport ', start + 1))
    expect(body).toContain('parseBatchShardKey')
    expect(body).not.toContain(".split(':')")
  })
})
