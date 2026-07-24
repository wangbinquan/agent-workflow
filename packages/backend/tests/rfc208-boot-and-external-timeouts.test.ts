// RFC-208 PR-5 —— daemon 侧剩余的无界等待。
//
// 与 PR-1 同一主题（「只能重启」类），但这几处的形状不同：不是 permit 泄漏，而是
// daemon 在持有 PID 锁的状态下无限等待外部进程/主机。其中启动探针那条是本次审计里
// **唯一一条连重启都救不回来**的路径：锁已经拿到、端口永远不监听，于是
// `agent-workflow start` 只会告诉你「another daemon is already running」。
//
// 设计门二轮的两条修正锁在这里：
// RFC-226 supersedes the OpenCode half of that historical decision: OpenCode
// is optional and must not execute at boot. The git half remains a hard,
// bounded platform gate because every repository task needs merge-back.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderPlantuml } from '../src/services/plantuml'

const startSource = readFileSync(resolve(import.meta.dir, '..', 'src', 'cli', 'start.ts'), 'utf8')
const gitVersionSource = readFileSync(
  resolve(import.meta.dir, '..', 'src', 'services', 'gitVersion.ts'),
  'utf8',
)

describe('RFC-208 / RFC-226 · boot probes', () => {
  test('OpenCode is absent from the daemon boot gate', () => {
    const boot = startSource.slice(
      startSource.indexOf('export async function startCommand'),
      startSource.indexOf('const gitCaps = await detectGitCapabilities()'),
    )
    expect(boot).not.toContain("getRuntimeDriver('opencode')")
    expect(boot).not.toContain('ocDriver.probe')
    expect(boot).not.toContain('opencode probe ok')
    expect(startSource).toContain('opencodeVersion: null')
  })

  test('the git boot probe remains bounded', () => {
    const call = gitVersionSource.slice(
      gitVersionSource.indexOf("runGit(process.cwd(), ['--version']"),
      gitVersionSource.indexOf("runGit(process.cwd(), ['--version']") + 120,
    )
    expect(call).toContain('timeoutMs')
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

describe('RFC-208 · git cache work is killable, not just race-able', () => {
  const cacheSource = readFileSync(
    resolve(import.meta.dir, '..', 'src', 'services', 'gitRepoCache.ts'),
    'utf8',
  )

  // The pre-existing `withTimeout` here is only a Promise.race: it rejects the
  // CALLER while the git child keeps running and the per-URL serial queue stays
  // held, so the next request for that URL waits behind a corpse. Bounding the
  // child is what actually frees both. Design gate §6-5 / §6-13.
  test('cold clone and both fetch paths pass a timeout to the git child', () => {
    // RFC-205 G1 adapted (2026-07-22): the clone spawn now threads an askpass
    // lease env ALONGSIDE the same timeoutMs (multi-line call). The lock's
    // point — the git child is time-bounded — holds; pin the whitespace-
    // normalised fragment instead of the exact old single-line call.
    expect(cacheSource.replace(/\s+/g, ' ')).toContain('spawnGit(cloneArgs, { timeoutMs,')
    const fetches = cacheSource.match(/runGit\([^\n]*'fetch', '--all'[\s\S]{0,120}?timeoutMs/g)
    // warm reuse (inside resolveCachedRepo) + manual refresh
    expect(fetches?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  test('spawnGit kills the whole process group, like runGit', () => {
    // `git clone` delegates to ssh / credential helpers; killing only the direct
    // child leaves those holding the pipes.
    const fn = cacheSource.slice(
      cacheSource.indexOf('async function spawnGit'),
      cacheSource.indexOf('export interface GitRepoCacheDeps'),
    )
    expect(fn).toContain('detached: true')
    expect(fn).toContain("process.kill(-proc.pid, 'SIGKILL')")
  })

  test('cache-dir deletion is async so it cannot block the event loop', () => {
    // rmSync on a large mirror stalls Bun's single loop for the whole walk —
    // during which no timer can fire, so any racing timeout is inert and every
    // other request to the daemon stalls too.
    const del = cacheSource.slice(
      cacheSource.indexOf('withUrlLock(row.urlHash, async () => {\n    try {'),
      cacheSource.indexOf('deleting DB row anyway'),
    )
    expect(del).toContain('await rm(row.localPath')
    expect(del).not.toContain('rmSync(row.localPath')
  })
})
