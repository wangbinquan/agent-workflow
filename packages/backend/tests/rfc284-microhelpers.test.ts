// RFC-284 T7（2026-08-12 审计 N20）——三组微 helper 收口锁。
//
// hash：sha1Hex/sha256Hex 与 node:crypto 直算**逐字节对拍**（凭据链
// patStore/sessionStore、webhook dedup 键、workflow 候选哈希等承重面靠它）；
// monotonic：同毫秒/回拨语义；race：竞速语义。外加唯一性锁：
//   - `createHash('sha1')` 在 src 仅 util/hash.ts 一处；
//   - `createHash('sha256')` 仅存合法集合（多步 builder 族 + raw-digest +
//     shared 镜像桥），单步 idiom 副本若回潮此集合必涨；
//   - `Math.max(Date.now(),` 仅 util/time.ts；drained-race 模式仅 util/process.ts。

import { describe, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { sha1Hex, sha256Hex } from '../src/util/hash'
import { monotonicNow } from '../src/util/time'
import { raceWithFallback } from '../src/util/process'

const SRC_ROOT = join(import.meta.dir, '../src')

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (p.endsWith('.ts')) acc.push(p)
  }
  return acc
}

describe('RFC-284 T7 — hash 字节对拍', () => {
  test('sha1Hex/sha256Hex 与 node:crypto 直算逐字节一致（string 与 bytes 两形态）', () => {
    const s = '带中文と unicode 🎯 payload'
    const b = randomBytes(64)
    expect(sha1Hex(s)).toBe(createHash('sha1').update(s).digest('hex'))
    expect(sha1Hex(b)).toBe(createHash('sha1').update(b).digest('hex'))
    expect(sha256Hex(s)).toBe(createHash('sha256').update(s).digest('hex'))
    expect(sha256Hex(b)).toBe(createHash('sha256').update(b).digest('hex'))
    // 迁移点曾用显式 'utf8'——默认编码对 string 同义，钉死这个等价性。
    expect(sha256Hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'))
  })
})

describe('RFC-284 T7 — monotonicNow', () => {
  test('时钟前进取 now；同毫秒/回拨取 prev+1（严格递增）', () => {
    expect(monotonicNow(0)).toBeGreaterThan(0)
    const future = Date.now() + 60_000
    expect(monotonicNow(future)).toBe(future + 1)
    const prev = monotonicNow(0)
    expect(monotonicNow(prev)).toBeGreaterThan(prev)
  })
})

describe('RFC-284 T7 — raceWithFallback', () => {
  test('快 promise 赢；慢 promise 到窗即 fallback', async () => {
    expect(await raceWithFallback(Promise.resolve('fast'), 50, 'fb')).toBe('fast')
    const never = new Promise<string>(() => {})
    const t0 = Date.now()
    expect(await raceWithFallback(never, 30, 'fb')).toBe('fb')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25)
  })
})

describe('RFC-284 T7 — 唯一性文本锁', () => {
  const hits = (needle: RegExp): string[] => {
    const out: string[] = []
    for (const f of walk(SRC_ROOT)) {
      if (needle.test(readFileSync(f, 'utf8'))) out.push(relative(SRC_ROOT, f))
    }
    return out.sort()
  }

  test("createHash('sha1') 仅 util/hash.ts", () => {
    expect(hits(/createHash\('sha1'\)/)).toEqual(['util/hash.ts'])
  })

  test("createHash('sha256') 仅存合法集合（builder 族/raw-digest/镜像桥）", () => {
    expect(hits(/createHash\('sha256'\)/)).toEqual(
      [
        'util/hash.ts',
        // 多步 builder（循环/链式多段 update）——不属单步 idiom：
        'modules/resource-catalog/infrastructure/legacy/skillHash.ts',
        'services/structuralDiff/digest.ts',
        'services/codeIntel/snapshot.ts',
        // RFC-310 evidence/baseline/workspace 流式 hash（64KB chunk 循环 update，
        // 峰值内存有界——Bun fetch 不背压教训，见 dev-gotchas）：
        'modules/development-automation/infrastructure/evidenceStore.ts',
        'modules/development-automation/infrastructure/gitBaselineReader.ts',
        'modules/development-automation/infrastructure/actionWorkspace.ts',
        'modules/development-automation/infrastructure/uploadPlacement.ts',
        // RFC-308 policy/profile content-addressed receipts:
        'modules/source-control/domain/taskCommitPolicy.ts',
        'modules/source-control/domain/workspaceExcludeProfile.ts',
        // raw digest（base64url(digest()) 非 hex idiom）：
        'auth/oidc/flow.ts',
        // shared 无 node:crypto 的 16 行镜像桥（设计门确认保留）：
        'services/mcpOperationRevision.ts',
        'services/pluginOperationRevision.ts',
      ].sort(),
    )
  })

  test('monotonic 公式仅 util/time.ts；drained-race 模式仅 util/process.ts', () => {
    expect(hits(/Math\.max\(Date\.now\(\)/)).toEqual(['util/time.ts'])
    expect(hits(/Promise\.race\(\[p, new Promise/)).toEqual(['util/process.ts'])
  })
})
