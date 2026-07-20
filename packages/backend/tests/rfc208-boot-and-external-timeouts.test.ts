// RFC-208 PR-5 —— daemon 侧剩余的无界等待。
//
// 与 PR-1 同一主题（「只能重启」类），但这几处的形状不同：不是 permit 泄漏，而是
// daemon 在持有 PID 锁的状态下无限等待外部进程/主机。其中启动探针那条是本次审计里
// **唯一一条连重启都救不回来**的路径：锁已经拿到、端口永远不监听，于是
// `agent-workflow start` 只会告诉你「another daemon is already running」。
//
// 设计门二轮的两条修正锁在这里：
//   · 探针必须**限时但仍 fail-closed**（释放锁 + 退出）。初稿写的「超时后继续启动到
//     监听」是错的——opencode 是必需运行时门禁（cli/start.ts 与 design/design.md
//     §1369），继续监听等于对外提供一个跑不了运行时的 daemon（§6-4）。
//   · git 门禁与 opencode 门禁是同一形状：`gitVersion.ts` 的 runGit(['--version'])
//     同样无超时、同样在持锁期间执行，必须一并纳入（§6-12）。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderPlantuml } from '../src/services/plantuml'

const startSource = readFileSync(resolve(import.meta.dir, '..', 'src', 'cli', 'start.ts'), 'utf8')
const gitVersionSource = readFileSync(
  resolve(import.meta.dir, '..', 'src', 'services', 'gitVersion.ts'),
  'utf8',
)

describe('RFC-208 · boot probes are bounded but still fail closed', () => {
  test('the opencode boot probe passes a timeout', () => {
    // The probe already supports `timeoutMs` (util/opencode.ts arms a
    // detached-process-group SIGKILL only when it is given one); boot simply
    // never passed it.
    const call = startSource.slice(
      startSource.indexOf('ocDriver.probe('),
      startSource.indexOf('ocDriver.probe(') + 160,
    )
    expect(call).toContain('timeoutMs')
  })

  test('the git boot probe passes a timeout too', () => {
    // Same wedge, different binary: a git wrapper (nvm/asdf/mise shim, corporate
    // proxy script) that hangs strands boot just as thoroughly.
    const call = gitVersionSource.slice(
      gitVersionSource.indexOf("runGit(process.cwd(), ['--version']"),
      gitVersionSource.indexOf("runGit(process.cwd(), ['--version']") + 120,
    )
    expect(call).toContain('timeoutMs')
  })

  test('a timed-out probe still releases the lock and exits — never "keep listening"', () => {
    // Guards against the withdrawn design-gate suggestion. If someone later
    // makes boot continue past a failed required-runtime probe, this turns red.
    const gate = startSource.slice(
      startSource.indexOf('opencode version probe'),
      startSource.indexOf('opencode probe ok'),
    )
    expect(gate).toContain('lock.release()')
    expect(gate).toContain('process.exit(1)')
  })
})

describe('RFC-208 · external PlantUML host cannot hang the daemon', () => {
  test('a never-settling PlantUML endpoint fails fast instead of pinning the request', async () => {
    // A user-configured EXTERNAL host — far likelier to black-hole than the
    // local daemon. Every one of the three fallbacks used a bare fetch with no
    // AbortSignal, and `await r.text()` was unbounded as well.
    let sawSignal = false
    const started = Date.now()
    const res = await renderPlantuml({
      endpoint: 'http://plantuml.invalid',
      source: '@startuml\nA -> B\n@enduml',
      authHeader: undefined,
      fetchImpl: ((_url: string, init?: RequestInit) => {
        if (init?.signal) sawSignal = true
        return new Promise<Response>((_ok, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason ?? new DOMException('aborted', 'AbortError'))
          })
        })
      }) as unknown as typeof fetch,
      timeoutMs: 120,
    })

    expect(sawSignal).toBe(true)
    expect(res.kind).toBe('failed')
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 30_000)
})

describe('RFC-208 · a failed filesystem rollback cannot strand a skill operation lock', () => {
  const skillSource = readFileSync(
    resolve(import.meta.dir, '..', 'src', 'services', 'skill.ts'),
    'utf8',
  )

  test('rmSync in the reserve rollback is guarded so abandonOperation always runs', () => {
    // `force: true` only swallows ENOENT. When rmSync threw (EPERM / EBUSY /
    // ENOTEMPTY) the DB rollback below it never ran, leaving the row `reserving`
    // and the op lock ACTIVE — which the orphan sweep cannot reclaim, because it
    // only collects locks whose op is no longer active. Result: that skill name
    // answers 409 forever.
    const rmAt = skillSource.indexOf('rmSync(skillDir')
    const rollback = skillSource.slice(
      rmAt - 200,
      skillSource.indexOf('abandonOperation(tx, opId)'),
    )
    // the cleanup sits inside its own try/catch …
    expect(rollback).toMatch(/try \{[\s\S]*rmSync\(skillDir[\s\S]*\} catch/)
    // and the rollback itself must still be there, after the guarded cleanup
    expect(skillSource.indexOf('rmSync(skillDir')).toBeLessThan(
      skillSource.indexOf('abandonOperation(tx, opId)'),
    )
  })
})
