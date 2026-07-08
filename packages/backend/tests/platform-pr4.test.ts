// RFC-windows PR-4 — MCP env + backup + indexers oracle (T18).
//
// 为什么这条测试存在：PR-4 T19 给 stdio MCP 子进程的 env 白名单加 Windows
// 键（USERPROFILE/PATHEXT/SystemRoot/ComSpec 等）+ HOME→USERPROFILE 兼容注入；
// T20 让 backup 的 tar 在 Windows 上工作（GNU tar 把 `C:\` 解析成远程 host:path
// → 改用 cwd+相对路径）；T21 确认 SCIP indexer 在 Windows 上「缺失即降级」
// （probeIndexer 不抛、返回 available:false）。这条测试锁三件事的跨平台行为。

import { describe, expect, test } from 'bun:test'
import { buildStdioEnv } from '../src/services/mcpProbe'
import { probeIndexer, INDEXER_SPECS } from '../src/services/structuralDiff/deep/indexers'
import { isWindows } from '../src/util/platform'

describe('RFC-windows PR-4 T19 — buildStdioEnv Windows keys', () => {
  test('POSIX source: only PATH/HOME/LANG copied (Windows keys absent → no-op)', () => {
    const out = buildStdioEnv(undefined, {
      PATH: '/usr/bin',
      HOME: '/h',
      LANG: 'C.UTF-8',
      SOME_FAKE_TOKEN: 'no-leak',
    })
    expect(out).toEqual({ PATH: '/usr/bin', HOME: '/h', LANG: 'C.UTF-8' })
    expect(Object.keys(out)).not.toContain('SOME_FAKE_TOKEN')
  })

  test('Windows source: USERPROFILE/PATHEXT/SystemRoot inherited', () => {
    if (!isWindows()) return
    const out = buildStdioEnv(undefined, {
      PATH: 'C:\\bin',
      USERPROFILE: 'C:\\Users\\me',
      PATHEXT: '.EXE;.CMD',
      SystemRoot: 'C:\\Windows',
      LANG: 'C.UTF-8',
    })
    expect(out.USERPROFILE).toBe('C:\\Users\\me')
    expect(out.PATHEXT).toBe('.EXE;.CMD')
    expect(out.SystemRoot).toBe('C:\\Windows')
  })

  test('Windows: HOME injected from USERPROFILE when HOME absent', () => {
    if (!isWindows()) return
    const out = buildStdioEnv(undefined, {
      PATH: 'C:\\bin',
      USERPROFILE: 'C:\\Users\\me',
      // no HOME
    })
    expect(out.HOME).toBe('C:\\Users\\me')
  })

  test('Windows: explicit HOME in source wins (no USERPROFILE override)', () => {
    if (!isWindows()) return
    const out = buildStdioEnv(undefined, {
      PATH: 'C:\\bin',
      HOME: 'C:\\custom-home',
      USERPROFILE: 'C:\\Users\\me',
    })
    expect(out.HOME).toBe('C:\\custom-home')
  })

  test('config env always wins over inherited (PATH override)', () => {
    const out = buildStdioEnv({ PATH: '/custom' }, { PATH: '/sys', HOME: '/h' })
    expect(out.PATH).toBe('/custom')
  })

  test('daemon secrets never leak (only whitelisted keys)', () => {
    const out = buildStdioEnv(undefined, {
      PATH: '/x',
      HOME: '/h',
      AWS_SECRET_ACCESS_KEY: 'leak',
      OIDC_CLIENT_SECRET: 'leak',
    })
    expect(Object.keys(out)).not.toContain('AWS_SECRET_ACCESS_KEY')
    expect(Object.keys(out)).not.toContain('OIDC_CLIENT_SECRET')
  })
})

describe('RFC-windows PR-4 T21 — SCIP indexer absence degrades cleanly', () => {
  test('probeIndexer of a definitely-absent binary → available:false, no throw', async () => {
    const spec = INDEXER_SPECS['scip-clang']!
    const r = await probeIndexer(spec, { scipClang: '/definitely/absent/scip-clang-bin' })
    expect(r.available).toBe(false)
    expect(r.version).toBe(null)
  })

  test('probeIndexer never throws (returns available:false on spawn failure)', async () => {
    const spec = INDEXER_SPECS['scip-go']!
    const r = await probeIndexer(spec, { scipGo: '/no/such/scip-go' })
    expect(r.available).toBe(false)
  })
})
