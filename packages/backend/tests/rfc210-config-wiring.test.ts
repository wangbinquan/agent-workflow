// RFC-210 T9 — settings → resolveSubmoduleParams 的接线（修 RFC-034 的断链）。
//
// 为什么这条测试存在：
//
// RFC-034 定义了 `gitRecurseSubmodules` / `gitSubmoduleJobs` 两个 settings，
// `util/git.ts:416` 还留了一句注释宣称 "Caller (services/task.ts startTask) wires
// this through from settings.gitRecurseSubmodules"。**那条接线从未存在**：全仓没有
// 任何生产代码读 `config.gitRecurseSubmodules`，实际行为恒为 'auto' / jobs=4。
//
// 断链之所以能长期不被发现，是因为唯一"锁"这两个字段的测试
// （packages/frontend/tests/repos-submodule-wiring.test.ts）只断言 **shared schema
// 的源码文本里出现过这两个标识符** —— 字段存在但没人读，这种断言照样绿。
//
// 所以这里锁的是**行为**：给一个真实的 config.json，settings 必须真的改变
// syncSubmodules 发出的 argv。'never' 时更要做到一个 submodule 进程都不 spawn。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import { resolveSubmoduleParams } from '@/services/gitRepoCache'
import { syncSubmodules } from '@/services/gitSubmodule'

let home = ''
let prevHome: string | undefined

function writeConfig(patch: Record<string, unknown>): void {
  writeFileSync(join(home, 'config.json'), JSON.stringify({ ...DEFAULT_CONFIG, ...patch }, null, 2))
}

/** Records argv instead of running git. */
function argvSpy() {
  const calls: string[][] = []
  const impl = async (_dir: string, args: string[]) => {
    calls.push(args)
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return { calls, impl: impl as never }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aw-rfc210-wire-'))
  prevHome = process.env.AGENT_WORKFLOW_HOME
  process.env.AGENT_WORKFLOW_HOME = home
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
  else process.env.AGENT_WORKFLOW_HOME = prevHome
  if (home !== '') rmSync(home, { recursive: true, force: true })
})

describe('RFC-210 settings → submodule params', () => {
  test('no config file ⟹ pre-RFC-210 defaults, and NO config file is created', () => {
    const r = resolveSubmoduleParams(undefined, undefined)
    expect(r.mode).toBe('auto')
    expect(r.jobs).toBe(4)
    // loadConfig writes defaults when the path is missing; a git helper must not
    // have that side effect, hence the existsSync gate in front of it.
    expect(() => rmSync(join(home, 'config.json'))).toThrow()
  })

  test('gitRecurseSubmodules from settings actually takes effect', () => {
    writeConfig({ gitRecurseSubmodules: 'never' })
    expect(resolveSubmoduleParams(undefined, undefined).mode).toBe('never')
    writeConfig({ gitRecurseSubmodules: 'always' })
    expect(resolveSubmoduleParams(undefined, undefined).mode).toBe('always')
  })

  test('gitSubmoduleJobs from settings actually takes effect (and stays clamped)', () => {
    writeConfig({ gitSubmoduleJobs: 8 })
    expect(resolveSubmoduleParams(undefined, undefined).jobs).toBe(8)
    writeConfig({ gitSubmoduleJobs: 32 })
    expect(resolveSubmoduleParams(undefined, undefined).jobs).toBe(32)
  })

  test('an explicit argument still outranks settings', () => {
    writeConfig({ gitRecurseSubmodules: 'never', gitSubmoduleJobs: 8 })
    const r = resolveSubmoduleParams('always', 2)
    expect(r.mode).toBe('always')
    expect(r.jobs).toBe(2)
  })

  test('a malformed config degrades to defaults instead of throwing', () => {
    writeFileSync(join(home, 'config.json'), '{ this is not json')
    const r = resolveSubmoduleParams(undefined, undefined)
    expect(r.mode).toBe('auto')
    expect(r.jobs).toBe(4)
  })

  test("mode 'never' from settings ⟹ zero submodule git processes (AC-11)", async () => {
    writeConfig({ gitRecurseSubmodules: 'never' })
    const { mode, jobs } = resolveSubmoduleParams(undefined, undefined)
    const spy = argvSpy()
    const res = await syncSubmodules('/repo', { mode, jobs, runGitImpl: spy.impl })
    expect(spy.calls).toEqual([])
    expect(res.ok).toBe(true)
  })

  test('settings-driven jobs reach the actual argv', async () => {
    writeConfig({ gitSubmoduleJobs: 16 })
    const { mode, jobs } = resolveSubmoduleParams('always', undefined)
    const spy = argvSpy()
    await syncSubmodules('/repo', { mode, jobs, runGitImpl: spy.impl })
    expect(spy.calls[1]).toEqual(['submodule', 'update', '--init', '--recursive', '--jobs', '16'])
  })
})
