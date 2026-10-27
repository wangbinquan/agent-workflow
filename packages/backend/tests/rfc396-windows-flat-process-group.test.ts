// RFC-396 —— 锁住「Windows 上受管 spawn 保持扁平」这条修复（2026-10-26）。
//
// 为什么这条测试存在：Windows 上的 care 旅程（e2e/rfc396-graph-care-repair.spec.ts:402）每轮都
// 停在首次 profile 证明。验证执行器无条件 `detached: true`，编译后的 Bun 1.4.3 调用器经 `.cmd`
// 跑 profile 时，Bun.file 只收到 0 字节 stdout；同一夹具不 detached 时完整收到 198 字节证明
// （design/RFC-396-adaptive-graph-development/windows-profile-acceptance-2026-10-24.json）。
// 平台内核与版本探针早已是「POSIX 自成进程组、Windows 保持扁平、树杀走 Job Object / taskkill」，
// 只有验证执行器和外部适配器执行器例外。修复后四处共用 detachedProcessGroup 一个判据。
//
// 真实的 Windows 行为由 CI 上 Windows 的 care e2e 验收；这里锁纯判据与四处接线。
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { detachedProcessGroup } from '../src/util/process'

const SRC = resolve(import.meta.dir, '..', 'src')
const EXECUTORS = [
  'modules/development-automation/infrastructure/local/verificationCommandEffects.ts',
  'modules/integration/infrastructure/local/developmentAdapterProgram.ts',
]
const SITES = ['util/process.ts', 'platform/execution/local/managedProcess.ts', ...EXECUTORS]

/** Source without comments, so a rationale that quotes `detached: true` cannot satisfy or trip a check. */
function code(rel: string): string {
  return readFileSync(resolve(SRC, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('RFC-396 Windows keeps owned spawns flat', () => {
  test('only POSIX hosts make an owned spawn a detached process-group leader', () => {
    expect(detachedProcessGroup('win32')).toBe(false)
    for (const platform of ['linux', 'darwin', 'freebsd'] as const)
      expect(detachedProcessGroup(platform)).toBe(true)
    expect(detachedProcessGroup()).toBe(process.platform !== 'win32')
  })

  test('every owned spawn uses the shared rule instead of an unconditional group', () => {
    for (const rel of SITES) {
      const src = code(rel)
      expect(src, rel).toContain('detached: detachedProcessGroup()')
      expect(src, rel).not.toMatch(/detached:\s*true/)
      expect(src, rel).not.toMatch(/detached:\s*process\.platform/)
    }
  })

  test('the negative-PGID reap only runs where a process group exists', () => {
    for (const rel of EXECUTORS) {
      const src = code(rel)
      expect(src, rel).toMatch(
        /if \(timedOut && detachedProcessGroup\(\)\)\s*await reapDetachedGroup\(/,
      )
      expect(src.match(/reapDetachedGroup\(/g), rel).toHaveLength(1)
    }
    expect(code('util/process.ts')).toContain(
      'if (detachedProcessGroup()) await reapDetachedGroup(',
    )
  })
})
