// RFC-284 T26（审计 N26）——env 开关唯一登记面的同步守卫。
//
// 为什么存在：AGENT_WORKFLOW_*/AW_* 开关散在 cli/start、driver、scriptRun 等处，
// 从无统一登记，审计时只能全仓 grep 盘点。docs/env-flags.md 现在是唯一登记面；
// 本测试把「登记完整」变成可执行契约：src（backend+shared）里出现的每个同形
// token，登记表里必须能找到（含于任一行即可——族条目如 `AW_PORT_<NAME>` 以前缀
// 子串覆盖 `AW_PORT_`）。新增开关未登记即红；删除开关后残留的登记行不拦截
// （历史「已删除」节允许保留）。
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const BACKEND_SRC = resolve(import.meta.dir, '..', 'src')
const SHARED_SRC = resolve(import.meta.dir, '..', '..', 'shared', 'src')
const DOC = resolve(import.meta.dir, '..', '..', '..', 'docs', 'env-flags.md')

const ENV_TOKEN_RE = /(?:AGENT_WORKFLOW|AW)_[A-Z0-9_]+/g

function collectTokens(dir: string, out: Set<string>): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      collectTokens(p, out)
      continue
    }
    if (!/\.tsx?$/.test(name)) continue
    for (const m of readFileSync(p, 'utf8').matchAll(ENV_TOKEN_RE)) out.add(m[0])
  }
}

describe('rfc284 T26: env 开关登记面同步', () => {
  test('src 出现的每个 AGENT_WORKFLOW_*/AW_* token 都在 docs/env-flags.md 有记载', () => {
    const tokens = new Set<string>()
    collectTokens(BACKEND_SRC, tokens)
    collectTokens(SHARED_SRC, tokens)
    expect(tokens.size).toBeGreaterThan(10) // 扫描面失效（目录搬迁等）时先红这里

    const doc = readFileSync(DOC, 'utf8')
    const missing = [...tokens].filter((t) => !doc.includes(t)).sort()
    expect(missing).toEqual([])
  })

  test('已删除的 env 通道不得回潮：AW_RUNTIME_STATUS_PROBE_TIMEOUT_MS 不在 src 出现', () => {
    const tokens = new Set<string>()
    collectTokens(BACKEND_SRC, tokens)
    collectTokens(SHARED_SRC, tokens)
    expect(tokens.has('AW_RUNTIME_STATUS_PROBE_TIMEOUT_MS')).toBe(false)
  })
})
