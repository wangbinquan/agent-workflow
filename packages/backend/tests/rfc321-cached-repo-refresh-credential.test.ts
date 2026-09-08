// Regression for the real GitLab CE private-repo refresh failure found during
// the RFC-310 digital-employee cross-repository E2E (2026-08-25).
//
// Cold clone already used the sealed URL through a one-shot RFC-321 credential
// lease, but manual/background refresh ran a bare `git fetch` against the
// sanitized origin. Every private HTTPS cache therefore failed after import
// with "could not read Password ... terminal prompts disabled". These tests use
// a real Basic-authenticated Git smart-HTTP remote so removing the refresh lease
// makes both cases deterministically red.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from 'bun:test'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createInMemoryDb } from '../src/db/client'
import { composeSqliteRepositoryWorkspaceStore } from '../src/modules/source-control/composition'
import { refreshCachedRepo, resolveCachedRepo } from '../src/services/gitRepoCache'
import { refreshDueRepos } from '../src/services/submoduleRefresh'
import { runGit } from '../src/util/git'
import {
  credentialedRemoteUrlFor,
  startGitHttpRemote,
  stopGitHttpRemote,
} from './helpers/gitHttpRemote'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

// 墙钟预算：每条用例的 body 都在真跑 git（init / commit / bare clone / 经 smart-HTTP 的冷
// clone / 再一次 fetch），绿的时候就要 2.7–4.6s（CI run 32835038793 的 Ubuntu 分片 3.4s、
// macOS 分片 4.0–4.6s），静息已贴着 bun 默认 5s 的 55–92%；macOS 分片 3 在 2026-08-25 以
// `timed out after 5000ms` 翻红，随后 bun 回收还在飞的 git 子进程（`killed 1 dangling
// process`）、afterEach 删掉夹具目录、被判超时的 body 继续跑到 `expect` 时抛成
// 「Unhandled error between tests」——三行报错点名的全是 git，主语其实是「没声明预算」。
// 定式见 docs/dev-gotchas.md §测试 / CI（「凡是真的建仓 / 真的拉子进程的用例，文件顶上写
// setDefaultTimeout」；先例 git-repo-cache / rfc199-start-task-workflow-race）。
// 这是墙钟允许量，不是对 refresh 变慢的容忍。
//
// 2026-09-06 把 60s 抬到 120s：同一 commit 的同一 run 里，ubuntu 分片 3.86s 过，而 macOS 分片 2/4 上
// 同文件的另一条同步慢到 9.8s（绿时基线 2.4–4.6s）、这一条撞满 60s 判超时——当时判成「整台 runner 慢了
// 2–4×」。仍然是墙钟允许量：真挂住照样红。
//
// **2026-09-08 订正：上面那句「整台 runner 慢了」是误诊，不要再据它抬超时。**
// CI run 34146373904 → 后继 run（macOS shard 4/4）实测：
//   · 本文件第一条 `background refresh …` **4100.73ms 通过**，正落在 2.7–4.6s 基线上；
//   · 本条 `manual refresh …` **120089.25ms 撞满超时**；
//   · 同分片其余用例除一条 11.6s 的架构守卫外**全部 ≤4.1s**。
// 同一台机器、同一个文件、相邻两条，一条基线速度、一条挂死 —— **runner 没有慢，是这一条挂住了**。
// 原始日志里 118 秒的空窗夹在「`cloned new cached repo` 冷克隆成功」与 bun 的
// `killed 1 dangling process` 之间，且确实**悬着一个 git 子进程**：挂点在冷克隆之后的那次 refresh fetch。
//
// 机理（`src/util/gitCredentialLease.ts`）：一次性租约是通过 `credential.helper=<bun 脚本>` 交进去的，
// **git 对凭据助手没有任何超时**——它会无限期等待该子进程写出 stdout 并退出。于是 macOS runner 上
// Bun 启动一旦卡住，git 就永久阻塞，表现为「墙钟无限大」而不是「慢」。`GIT_TERMINAL_PROMPT=0` /
// `credential.interactive=false` 只挡住了 tty 提示，挡不住这一条。
// 详情与处置建议记在 `docs/audit-backlog.md`。**再撞请去修挂起，不要抬这个数字。**
setDefaultTimeout(120_000)

const box = createSecretBoxFromKey(Buffer.alloc(32, 21))
const roots: string[] = []

type RefreshStage =
  | 'init'
  | 'commit'
  | 'bare-clone'
  | 'resolve-cached-repo'
  | 'manual-refresh'
  | 'background-refresh'
  | 'origin-query'
  | 'cleanup'
type PromiseObservation = 'unobserved' | 'pending' | 'fulfilled' | 'rejected'
type RefreshEvent =
  | `stage-${'start' | 'complete' | 'rejected' | 'pending'}`
  | `spawn-${'start' | 'complete' | 'rejected'}`
  | `exit-observe-${'start' | 'complete' | 'rejected'}`
  | `${'stdout' | 'stderr'}-read-${'start' | 'complete' | 'rejected'}`
  | `${'stdout' | 'stderr' | 'exit'}-${PromiseObservation}`

interface RefreshDiagnostics {
  stage<T>(label: RefreshStage, action: () => T): T
  snapshot(): void
  restore(): void
}

let diagnosticRun = 0
let activeDiagnostics: RefreshDiagnostics | undefined

function refreshDiagnostics(): RefreshDiagnostics {
  if (activeDiagnostics === undefined) throw new Error('refresh diagnostics is not installed')
  return activeDiagnostics
}

function installRefreshDiagnostics(): RefreshDiagnostics {
  const runId = `${process.pid}-${++diagnosticRun}`
  const started = performance.now()
  const cpuStarted = process.cpuUsage()
  const scope = new AsyncLocalStorage<RefreshStage>()
  const pendingStages = new Set<{ label: RefreshStage }>()
  const children: {
    pid: number
    stage: RefreshStage
    stdout: PromiseObservation
    stderr: PromiseObservation
    exit: PromiseObservation
    exitCode: number | null
  }[] = []
  type Child = (typeof children)[number]
  const streams = new WeakMap<ReadableStream, { child: Child; pipe: 'stdout' | 'stderr' }>()
  // Only predefined labels and numeric process/timing observations are emitted.
  // CPU is this test worker's CPU, not an inferred child/grandchild identity.
  const emit = (
    stage: RefreshStage,
    event: RefreshEvent,
    pid: number | null = null,
    exitCode: number | null = null,
  ): void => {
    try {
      const cpu = process.cpuUsage(cpuStarted)
      console.error(
        `[rfc321-process] ${JSON.stringify({
          runId,
          stage,
          event,
          pid,
          wallMs: Math.round(performance.now() - started),
          cpuUserUs: cpu.user,
          cpuSystemUs: cpu.system,
          exitCode,
        })}`,
      )
    } catch {
      // Observation must not replace the original operation's outcome.
    }
  }
  const originalSpawn = Bun.spawn
  const spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
    new Proxy(originalSpawn, {
      apply(target, receiver, args) {
        const stage = scope.getStore()
        if (stage === undefined) return Reflect.apply(target, receiver, args)
        emit(stage, 'spawn-start')
        let proc: ReturnType<typeof Bun.spawn>
        try {
          proc = Reflect.apply(target, receiver, args)
        } catch (error) {
          emit(stage, 'spawn-rejected')
          throw error
        }
        const child: Child = {
          pid: proc.pid,
          stage,
          stdout: 'unobserved',
          stderr: 'unobserved',
          exit: 'pending',
          exitCode: null,
        }
        children.push(child)
        emit(stage, 'spawn-complete', child.pid)
        // Register the existing streams without taking a reader or consuming
        // any bytes. The production caller still owns its original process.
        if (proc.stdout instanceof ReadableStream)
          streams.set(proc.stdout, { child, pipe: 'stdout' })
        if (proc.stderr instanceof ReadableStream)
          streams.set(proc.stderr, { child, pipe: 'stderr' })
        emit(stage, 'exit-observe-start', child.pid)
        void proc.exited.then(
          (exitCode) => {
            child.exit = 'fulfilled'
            child.exitCode = exitCode
            emit(stage, 'exit-observe-complete', child.pid, exitCode)
          },
          () => {
            child.exit = 'rejected'
            emit(stage, 'exit-observe-rejected', child.pid)
          },
        )
        return proc
      },
    }),
  )
  const originalText = Response.prototype.text
  let textSpy: { mockRestore(): void }
  try {
    textSpy = spyOn(Response.prototype, 'text').mockImplementation(function (this: Response) {
      if (scope.getStore() === undefined) return originalText.call(this)
      const observed = this.body === null ? undefined : streams.get(this.body)
      if (observed === undefined) return originalText.call(this)
      const { child, pipe } = observed
      child[pipe] = 'pending'
      emit(child.stage, `${pipe}-read-start`, child.pid)
      let promise: Promise<string>
      try {
        promise = originalText.call(this)
      } catch (error) {
        child[pipe] = 'rejected'
        emit(child.stage, `${pipe}-read-rejected`, child.pid)
        throw error
      }
      void promise.then(
        () => {
          child[pipe] = 'fulfilled'
          emit(child.stage, `${pipe}-read-complete`, child.pid)
        },
        () => {
          child[pipe] = 'rejected'
          emit(child.stage, `${pipe}-read-rejected`, child.pid)
        },
      )
      return promise
    })
  } catch (error) {
    spawnSpy.mockRestore()
    throw error
  }
  return {
    stage<T>(label: RefreshStage, action: () => T): T {
      const pending = { label }
      pendingStages.add(pending)
      emit(label, 'stage-start')
      const finish = (event: 'stage-complete' | 'stage-rejected'): void => {
        pendingStages.delete(pending)
        emit(label, event)
      }
      try {
        const value = scope.run(label, action)
        if (value instanceof Promise)
          void value.then(
            () => finish('stage-complete'),
            () => finish('stage-rejected'),
          )
        else finish('stage-complete')
        return value
      } catch (error) {
        finish('stage-rejected')
        throw error
      }
    },
    snapshot() {
      for (const { label } of pendingStages) emit(label, 'stage-pending')
      for (const child of children) {
        emit(child.stage, `stdout-${child.stdout}`, child.pid)
        emit(child.stage, `stderr-${child.stderr}`, child.pid)
        emit(child.stage, `exit-${child.exit}`, child.pid, child.exitCode)
      }
    },
    restore() {
      try {
        textSpy.mockRestore()
      } finally {
        spawnSpy.mockRestore()
      }
    },
  }
}

async function authenticatedFixture() {
  const diagnostics = refreshDiagnostics()
  const root = mkdtempSync(join(tmpdir(), 'aw-private-refresh-'))
  const appHome = mkdtempSync(join(tmpdir(), 'aw-private-refresh-home-'))
  roots.push(root, appHome)
  const working = join(root, 'working')
  const bare = join(root, 'remote.git')
  await diagnostics.stage('init', () => runGit(root, ['init', '-q', '-b', 'main', working]))
  await diagnostics.stage('commit', () =>
    runGit(working, [
      '-c',
      'user.name=Refresh Test',
      '-c',
      'user.email=refresh@example.test',
      'commit',
      '--allow-empty',
      '-q',
      '-m',
      'init',
    ]),
  )
  await diagnostics.stage('bare-clone', () => runGit(root, ['clone', '--bare', working, bare]))
  const url = credentialedRemoteUrlFor(bare, 'refresh-bot', 'refresh-secret')
  const db = createInMemoryDb(MIGRATIONS)
  const cached = await diagnostics.stage('resolve-cached-repo', () =>
    resolveCachedRepo(
      { store: composeSqliteRepositoryWorkspaceStore(db), appHome, secretBox: box },
      { url },
    ),
  )
  return { appHome, cached, db, url }
}

beforeAll(async () => {
  await startGitHttpRemote()
})

beforeEach(() => {
  activeDiagnostics = installRefreshDiagnostics()
})

afterEach(() => {
  const diagnostics = activeDiagnostics
  const cleanup = () => {
    while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
  }
  try {
    diagnostics?.snapshot()
    if (diagnostics === undefined) cleanup()
    else diagnostics.stage('cleanup', cleanup)
  } finally {
    try {
      diagnostics?.snapshot()
    } finally {
      try {
        diagnostics?.restore()
      } finally {
        activeDiagnostics = undefined
      }
    }
  }
})

afterAll(() => {
  stopGitHttpRemote()
})

describe('private cached-repo refresh credential lease', () => {
  test('manual refresh unseals the URL for one fetch and keeps origin credential-free', async () => {
    const diagnostics = refreshDiagnostics()
    const { appHome, cached, db } = await authenticatedFixture()

    const refreshed = await diagnostics.stage('manual-refresh', () =>
      refreshCachedRepo(
        { store: composeSqliteRepositoryWorkspaceStore(db), appHome, secretBox: box },
        cached.cached.id,
      ),
    )
    expect(refreshed.fetchOk).toBe(true)

    const origin = await diagnostics.stage('origin-query', () =>
      runGit(cached.cached.localPath, ['remote', 'get-url', 'origin']),
    )
    expect(origin.exitCode).toBe(0)
    expect(origin.stdout).not.toContain('refresh-secret')
    expect(readdirSync(appHome).filter((name) => name.startsWith('.gitcred-'))).toEqual([])
  })

  test('background refresh threads the same SecretBox into the cached fetch', async () => {
    const diagnostics = refreshDiagnostics()
    const { appHome, cached, db } = await authenticatedFixture()
    const now = Date.now()
    const result = await diagnostics.stage('background-refresh', () =>
      refreshDueRepos(
        composeSqliteRepositoryWorkspaceStore(db),
        { submoduleAutoRefresh: { enabled: true, intervalMs: 1, onlyRecentDays: 30 } },
        { appHome, secretBox: box, now: () => now },
      ),
    )

    expect(result).toEqual({ refreshed: 1, failed: 0 })
    expect(readdirSync(appHome).filter((name) => name.startsWith('.gitcred-'))).toEqual([])
    expect(cached.cached.urlRedacted).not.toContain('refresh-secret')
  })
})
