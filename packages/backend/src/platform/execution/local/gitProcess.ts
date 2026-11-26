// RFC-591 — the generic git process runner: run `git -C <cwd> …` once with the hardening overrides and a non-interactive
// environment, bounded by a timeout or an abort signal (the whole process group is killed), and capture its output. Moved
// verbatim from `util/git.ts`, which keeps the repository semantics (snapshots, rollback, worktrees, submodules, merge
// trees); this runner knows none of them, which is why it is platform: platform's own version probe, worktree backup and
// boot-upgrade environment run git too, and platform depends on no module.

import { hardenGitArgs } from './gitHardening'
import { platformSpawnOptionsForHost } from '@/platform/execution/local/platformExec'
import { raceWithFallback } from '@/platform/execution/local/process'

export interface GitRunResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Non-interactive env for any `git` spawn. Without these, ssh reads `/dev/tty`
 * directly (not stdin) on first connect to an unknown host and hangs the daemon
 * forever — closing stdin doesn't help. Two ssh options + one git option fix it:
 *   - BatchMode=yes — ssh fails fast instead of prompting on tty for any input.
 *   - StrictHostKeyChecking=accept-new — TOFU new hosts into known_hosts but
 *     still reject when a known host's fingerprint changes (MITM defense).
 *   - GIT_TERMINAL_PROMPT=0 — same treatment for HTTPS credential prompts.
 */
/**
 * RFC-359 W57 —— 从继承的环境里清掉会**改写 git 认定的仓库 / 工作区 / 索引**的那几个变量。
 *
 * `GIT_DIR` 的优先级**高于 `-C`**：`-C` 只改工作目录，仓库位置仍以 `GIT_DIR` 为准。所以
 * 只要进程环境里带着它，`git -C <任务工作树> …` 会绕过调用方指定的工作区、打到那一个仓库上。
 * daemon 给每个任务 spawn 的正是这个形状（从 git hook 起的进程、或有人在 shell 里 export 过，
 * 都会让整台机器的任务写错仓库）。
 *
 * 2026-09-10 实撞：一轮带 `GIT_DIR=<真仓库>/.git` 的 `bun test` 让某个夹具的
 * `git add` / `git commit` 打进了开发者的真仓库——main 上凭空多出一笔提交、README 被删到 1 行、
 * 还留下 0 字节的 `index.lock` 死锁。判据见 `rfc359-w57-git-env-repo-isolation.test.ts`。
 *
 * 调用方**显式**经 `opts.env` 注入的同名变量不受影响（`runGit` 在这之后 spread），
 * `snapshotFullState` 的临时索引（RFC-130 D25 的 `GIT_INDEX_FILE`）继续照常工作。
 */
export function nonInteractiveGitEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    // 值为 undefined 即「这次 spawn 不带这个变量」，见 runGit 的 opts.env 说明。
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_NAMESPACE: undefined,
    GIT_SSH_COMMAND: [
      process.env.GIT_SSH_COMMAND ?? 'ssh',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
    ].join(' '),
    GIT_TERMINAL_PROMPT: '0',
    // RFC-287 G6：强制 C locale。失败分类（shared/gitFailureClass.ts）读的是
    // git 的 stderr 原文——在中文/日文等环境里 git 会把「Repository not found」
    // 「Authentication failed」整句翻译掉，特征词匹配当场全灭：网络抖动会被误判
    // 成不可重试、退化回硬失败，G6 直接失效。
    // 只影响**面向机器**的 stderr 解析，不影响任何面向用户的文案（那些走 i18n）。
    LC_ALL: 'C',
    LANG: 'C',
  }
}

/**
 * Run `git -C <cwd> <...args>` and capture stdout/stderr. Never throws.
 *
 * RFC-130 (D25): optional `opts.env` is MERGED OVER `nonInteractiveGitEnv()` so
 * callers can inject per-spawn vars (e.g. `GIT_INDEX_FILE` for a temp index in
 * `snapshotFullState`) without clobbering the non-interactive ssh/https guards.
 * A key whose value is `undefined` unsets that var for this spawn.
 */
export async function runGit(
  cwd: string,
  args: string[],
  opts?: {
    env?: Record<string, string | undefined>
    stdin?: string
    timeoutMs?: number
    /**
     * RFC-287 G7：取消要**真杀** git，而不是等它跑完。
     *
     * 没有它的后果是用户可见的：点了取消，界面立刻回到 canceled，但一个正在克隆
     * 几百 MB 的 `git clone` 还在后台跑几分钟——占着带宽与磁盘，任务的工作树还会
     * 在「已取消」之后才被创建出来。杀法与 timeoutMs 那条完全一致（进程组 +
     * SIGKILL），因为 git 会自由派生（credential helper、ssh、`!` 别名走 shell），
     * 只杀直接子进程会留下孙进程握着管道。
     */
    signal?: AbortSignal
  },
): Promise<GitRunResult> {
  const proc = Bun.spawn({
    ...platformSpawnOptionsForHost(),
    // RFC-252 G1: every daemon-side git spawn carries the hardening overrides.
    // `-c` outranks EVERY config scope (system/global/local/worktree/modules), so
    // this is the only mechanism that can beat what an agent writes into the git
    // dir it legitimately owns. See ./gitHardening.ts for the threat model and
    // the measured evidence.
    cmd: ['git', ...hardenGitArgs(['-C', cwd, ...args])],
    // Explicit env passthrough — Bun.spawn under `bun test` does not pick up
    // post-startup process.env mutations otherwise, which makes per-test env
    // injection (e.g. GIT_CONFIG_GLOBAL) unreliable. In production this is a
    // no-op since process.env is fixed at daemon start.
    env:
      opts?.env === undefined ? nonInteractiveGitEnv() : { ...nonInteractiveGitEnv(), ...opts.env },
    stdout: 'pipe',
    stderr: 'pipe',
    // RFC-187 §4-2: `update-index --index-info` reads entries from stdin — the
    // ONLY plumbing shape git offers for surgical index edits. Callers that
    // don't pass `stdin` keep the historical ignore (no behavior change).
    stdin: opts?.stdin === undefined ? 'ignore' : new TextEncoder().encode(opts.stdin),
    // RFC-208: with a timeout the child runs in its OWN process group so the
    // timer can SIGKILL the whole tree. git delegates freely (credential
    // helpers, ssh, `!`-aliases through a shell), and killing only the direct
    // child leaves those grandchildren alive holding the pipes — the exact
    // failure util/opencode.ts already learned. Without a timeout the historical
    // flat spawn is kept byte-for-byte.
    ...(opts?.timeoutMs !== undefined || opts?.signal !== undefined ? { detached: true } : {}),
  })

  // 进程组 SIGKILL——timeoutMs 与 signal 共用同一条杀法（见上面 RFC-208 的理由）。
  const killTree = (): void => {
    try {
      process.kill(-proc.pid, 'SIGKILL')
    } catch {
      proc.kill('SIGKILL')
    }
  }

  let aborted = false
  const onAbort = (): void => {
    aborted = true
    killTree()
  }
  if (opts?.signal !== undefined) {
    if (opts.signal.aborted) onAbort()
    else opts.signal.addEventListener('abort', onAbort, { once: true })
  }
  const detachAbort = (): void => {
    opts?.signal?.removeEventListener('abort', onAbort)
  }

  if (opts?.timeoutMs === undefined) {
    if (opts?.signal === undefined) {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { stdout, stderr, exitCode }
    }
    // 带 signal：与 timeout 分支同构——先等退出，再给管道读取一个上限（存活的
    // 孙进程可能继承写端，让 `.text()` 永远等不到 EOF）。
    try {
      const outPromise = new Response(proc.stdout).text().catch(() => '')
      const errPromise = new Response(proc.stderr).text().catch(() => '')
      const exitCode = await proc.exited
      const stdout = await raceWithFallback(outPromise, 250, '')
      const stderr = await raceWithFallback(errPromise, 250, '')
      if (!aborted) return { stdout, stderr, exitCode }
      // 取消必须可诊断，且绝不能被误判成成功——被 SIGKILL 的进程按平台可能报 0/null。
      return {
        stdout,
        stderr: `${stderr}\ngit aborted (canceled; killed)`.trim(),
        exitCode: exitCode === 0 ? GIT_ABORTED_EXIT_CODE : exitCode,
      }
    } finally {
      detachAbort()
    }
  }

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    killTree()
  }, opts.timeoutMs)
  try {
    // Await the exit FIRST, then bound the pipe reads: a surviving grandchild
    // can inherit the write end and keep `.text()` from ever seeing EOF even
    // after the direct child is reaped (util/opencode.ts §probe).
    const outPromise = new Response(proc.stdout).text().catch(() => '')
    const errPromise = new Response(proc.stderr).text().catch(() => '')
    const exitCode = await proc.exited
    const stdout = await raceWithFallback(outPromise, 250, '')
    const stderr = await raceWithFallback(errPromise, 250, '')
    if (!timedOut) return { stdout, stderr, exitCode }
    return {
      stdout,
      // Timeouts must be diagnosable, and must never be mistaken for success:
      // a SIGKILLed process can surface exitCode 0/null depending on platform.
      stderr: `${stderr}\ngit timed out after ${opts.timeoutMs}ms (killed)`.trim(),
      exitCode: exitCode === 0 ? GIT_TIMEOUT_EXIT_CODE : exitCode,
    }
  } finally {
    clearTimeout(timer)
    detachAbort()
  }
}

/** Conventional "timed out" exit status (matches coreutils `timeout`). */
export const GIT_TIMEOUT_EXIT_CODE = 124
/** 取消（AbortSignal）导致的终止；与超时区分，便于上层给出不同文案。 */
export const GIT_ABORTED_EXIT_CODE = 125
