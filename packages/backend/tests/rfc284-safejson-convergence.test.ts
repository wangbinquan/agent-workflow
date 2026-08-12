// RFC-284 T5（2026-08-12 审计 N20 / 设计门路 2 P1）——safeJson 语义族收口锁。
//
// 20 份本地拷贝分三个语义族（{}×13 / throw×4 / 异文案×1），已按族收敛为
// util/http.ts 的两个 util。本测试三层锁：
//   1. 计数锁：routes/services 里本地 `async function safeJson` 定义只剩
//      T28 豁免清单（webhook 两路由——RFC-283 在途，removeWhen=RFC-284 T28）；
//   2. wire 行为锁（{} 族）：坏 JSON → {} → 下游 zod 报字段级 validation-error；
//   3. wire 行为锁（throw 族）：坏 JSON → ValidationError('invalid-json')，
//      intentSessions 的历史文案 "request body must be JSON" 字节保持。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { safeJsonOrEmpty, safeJsonOrThrowInvalid } from '../src/util/http'
import { ValidationError } from '../src/util/errors'

const SRC_ROOT = join(import.meta.dir, '../src')

// T28 已落地（webhook CRUD 抽 service，2026-08-12）：清单按约清空——safeJson
// 全仓唯一定义在 util/http.ts，任何新的本地定义直接红。
const LOCAL_DEF_ALLOWLIST = new Set<string>()

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (p.endsWith('.ts')) acc.push(p)
  }
  return acc
}

describe('RFC-284 T5 — safeJson convergence', () => {
  test('local safeJson definitions only remain on the T28 allowlist', () => {
    const offenders: string[] = []
    for (const file of walk(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file)
      if (rel === 'util/http.ts') continue
      const src = readFileSync(file, 'utf8')
      if (/async function safeJson\(/.test(src) && !LOCAL_DEF_ALLOWLIST.has(rel)) {
        offenders.push(rel)
      }
    }
    expect(offenders).toEqual([])
    // 豁免清单不许过期：webhook 两件仍必须真的持有本地定义（T28 收编时删本清单）。
    for (const rel of LOCAL_DEF_ALLOWLIST) {
      expect(/async function safeJson\(/.test(readFileSync(join(SRC_ROOT, rel), 'utf8'))).toBe(true)
    }
  })

  const badJson = () => new Request('http://localhost/x', { method: 'POST', body: '{not-json' })

  test('{} family: bad JSON parses to {} (downstream zod owns the error)', async () => {
    expect(await safeJsonOrEmpty(badJson())).toEqual({})
  })

  test('good JSON round-trips through both utils', async () => {
    const mk = () => new Request('http://localhost/x', { method: 'POST', body: '{"a":1}' })
    expect(await safeJsonOrEmpty(mk())).toEqual({ a: 1 })
    expect(await safeJsonOrThrowInvalid(mk())).toEqual({ a: 1 })
  })

  test("throw family: bad JSON → ValidationError('invalid-json') with the historical default message", async () => {
    expect.assertions(3)
    try {
      await safeJsonOrThrowInvalid(badJson())
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError)
      expect((err as ValidationError).code).toBe('invalid-json')
      expect((err as Error).message).toBe('request body is not valid JSON')
    }
  })

  test('intentSessions historical message stays byte-identical via the message param', async () => {
    expect.assertions(1)
    try {
      await safeJsonOrThrowInvalid(badJson(), 'request body must be JSON')
    } catch (err) {
      expect((err as Error).message).toBe('request body must be JSON')
    }
  })
})
