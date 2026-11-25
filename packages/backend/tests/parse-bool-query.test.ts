// flag-audit W0（§5.6）——HTTP 布尔 query 统一解析口的回归锁。
// 收口前同一语义四种口径：oidc `?force` 仅认 'true'（`?force=1` 静默 false）、
// memories 认 'true'|'1'、cached-repos/runtime 认 '1'|'true'、tasks `?cascade`
// 用 `!== 'false'` 默认真双重否定（任何拼错值静默当 true）。统一后：
// 1/true/0/false（大小写不敏感）+ 声明式 default + 非法值 422 fail-loud。

import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { parseBoolQuery } from '../src/platform/http/requestParsing'
import { ValidationError } from '../src/platform/errors/domainErrors'

async function probe(query: string, def: boolean): Promise<boolean> {
  const app = new Hono()
  let out: boolean | Error | undefined
  app.get('/t', (c) => {
    try {
      out = parseBoolQuery(c, 'flag', { default: def })
    } catch (e) {
      out = e as Error
    }
    return c.body(null, 204)
  })
  await app.request(`/t${query}`)
  if (out instanceof Error) throw out
  if (out === undefined) throw new Error('handler did not run')
  return out
}

describe('parseBoolQuery（flag-audit W0 统一口径）', () => {
  test('1/true/TRUE → true；0/false/False → false（大小写不敏感）', async () => {
    expect(await probe('?flag=1', false)).toBe(true)
    expect(await probe('?flag=true', false)).toBe(true)
    expect(await probe('?flag=TRUE', false)).toBe(true)
    expect(await probe('?flag=0', true)).toBe(false)
    expect(await probe('?flag=false', true)).toBe(false)
    expect(await probe('?flag=False', true)).toBe(false)
  })

  test('缺省 / 空值走调用方 default（cascade 默认真、force 默认假两种形态都覆盖）', async () => {
    expect(await probe('', true)).toBe(true)
    expect(await probe('', false)).toBe(false)
    expect(await probe('?flag=', true)).toBe(true)
  })

  test('非法值 422 fail-loud（旧口径的「拼错静默取默认」病根拆除）', async () => {
    await expect(probe('?flag=yes', false)).rejects.toBeInstanceOf(ValidationError)
    await expect(probe('?flag=truthy', true)).rejects.toBeInstanceOf(ValidationError)
  })
})
