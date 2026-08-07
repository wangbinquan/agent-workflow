// RFC-227 gated real macOS evidence for the OpenCode child provider.
// Run on a capable macOS host with:
//   RUN_SANDBOX_ITEST=1 bun test packages/backend/tests/rfc227-seatbelt-integration.test.ts

import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  NetlessSubprocessManifestSchema,
  renderNetlessSeatbeltProfile,
} from '@/services/runtime/opencode/sealedSubprocess'
import { wrapSpawnPlanSandbox, type SandboxCtx } from '@/services/sandbox'
import { probeSandboxMechanism } from '@/services/sandbox/probe'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const seatbeltTest =
  process.platform === 'darwin' && process.env.RUN_SANDBOX_ITEST === '1' ? test : test.skip

/**
 * 这两个用例要跑真 `sandbox-exec` 与真 `curl`，而 bun 的默认用例超时是 5s。
 *
 * 本机（Apple Silicon）整文件 380ms，但 GitHub 的 macOS runner 慢一个数量级：
 * 2026-08-07 连续观测到 5009ms / 5015ms —— **正好卡在 5000ms 线上**，于是同一
 * 份代码时红时绿（红 run 与前一个绿 run 之间的全部差异是两个 .md 文件各一行）。
 * 耗时是结构性的：沙箱内那次 `curl --max-time 2` **预期被网络围栏拦住**，也就
 * 必然走满 2 秒，外层再有一次 curl 与多次 `sandbox-exec` 冷启动。
 *
 * 所以放宽超时而不是让它继续抖：30s 对本机是 79 倍余量、对 runner 也有 6 倍，
 * 真挂起仍会失败（不是把上限抬到永不触发）。
 */
const SEATBELT_TEST_TIMEOUT_MS = 30_000

async function runSeatbelt(profile: string, command: readonly string[]): Promise<number> {
  const child = Bun.spawn(['/usr/bin/sandbox-exec', '-p', profile, ...command], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  return child.exited
}

async function runCommand(command: readonly string[]): Promise<number> {
  const child = Bun.spawn([...command], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  return child.exited
}

describe('RFC-227 REAL macOS Seatbelt provider (gated)', () => {
  seatbeltTest(
    'denies app secrets, seal writes, and child network while preserving worktree writes',
    async () => {
      const status = await probeSandboxMechanism('darwin')
      if (!status.available) return

      const root = realpathSync(mkdtempSync(join(tmpdir(), 'rfc227-seatbelt-real-')))
      roots.push(root)
      const appHome = join(root, 'app-home')
      const realHome = join(root, 'real-home')
      const scratchRepo = join(appHome, 'scratch', 'task')
      const worktreePath = join(appHome, 'iso', 'task', 'run')
      const scratchPath = join(appHome, 'runs', 'task', 'scratch')
      const privateHome = join(appHome, 'runs', 'task', 'home')
      const privateTmp = join(appHome, 'runs', 'task', 'tmp')
      const sealPath = join(appHome, 'runs', 'task', 'seal')
      for (const path of [
        appHome,
        realHome,
        scratchRepo,
        join(worktreePath, '..'),
        scratchPath,
        privateHome,
        privateTmp,
        sealPath,
      ]) {
        mkdirSync(path, { recursive: true })
      }
      expect(
        await runCommand(['/usr/bin/git', '-C', scratchRepo, 'init', '-q', '-b', 'main']),
      ).toBe(0)
      expect(
        await runCommand([
          '/usr/bin/git',
          '-C',
          scratchRepo,
          '-c',
          'user.name=agent-workflow',
          '-c',
          'user.email=agent-workflow@localhost',
          'commit',
          '-q',
          '--allow-empty',
          '-m',
          'scratch root',
        ]),
      ).toBe(0)
      expect(
        await runCommand([
          '/usr/bin/git',
          '-C',
          scratchRepo,
          'worktree',
          'add',
          '-q',
          '--detach',
          worktreePath,
          'HEAD',
        ]),
      ).toBe(0)
      const gitCommonDir = realpathSync(join(scratchRepo, '.git'))

      const secretPath = join(appHome, 'secret.key')
      const canonicalSecretPath = join(scratchRepo, 'canonical-only.txt')
      const worktreeOutput = join(worktreePath, 'output.txt')
      const sealedArtifact = join(sealPath, 'opencode')
      writeFileSync(secretPath, 'TOP-SECRET')
      writeFileSync(canonicalSecretPath, 'CANONICAL-SECRET')
      writeFileSync(sealedArtifact, 'SEALED')

      const manifest = NetlessSubprocessManifestSchema.parse({
        codec: 1,
        mode: 'shell',
        provider: {
          providerId: 'macos-seatbelt',
          config: { sandboxExecPath: '/usr/bin/sandbox-exec' },
        },
        worktreePath,
        scratchPath,
        appHome,
        realHome,
        gitCommonDirs: [gitCommonDir],
        bindReadOnly: [sealPath],
        env: {
          HOME: privateHome,
          TMPDIR: privateTmp,
          PATH: '/usr/bin:/bin',
        },
        command: ['/bin/sh'],
      })
      const profile = renderNetlessSeatbeltProfile(manifest)
      const runnerCtx: SandboxCtx = {
        mode: 'enforce',
        status: { mechanism: 'seatbelt', available: true, detail: null },
        appHome,
        taskWorktrees: [worktreePath],
        runDir: join(appHome, 'runs', 'task'),
      }

      expect(await runSeatbelt(profile, ['/bin/cat', secretPath])).not.toBe(0)
      expect(await runSeatbelt(profile, ['/bin/cat', canonicalSecretPath])).not.toBe(0)
      const childSeatbeltCommand = [
        '/usr/bin/sandbox-exec',
        '-p',
        profile,
        '/bin/sh',
        '-c',
        'printf WORKTREE_OK > "$1"',
        'rfc227',
        worktreeOutput,
      ]
      const spawnCommand = wrapSpawnPlanSandbox(
        childSeatbeltCommand,
        runnerCtx,
        'provider-child-only',
      )
      expect(spawnCommand.filter((entry) => entry === '/usr/bin/sandbox-exec')).toHaveLength(1)
      expect(await runCommand(spawnCommand)).toBe(0)
      expect(readFileSync(worktreeOutput, 'utf8')).toBe('WORKTREE_OK')
      // `git add` writes the linked worktree index under the external common
      // dir. This is the production failure mode: ordinary file writes worked
      // while every Git command died behind the child-only Seatbelt mask.
      expect(
        await runSeatbelt(profile, ['/usr/bin/git', '-C', worktreePath, 'add', 'output.txt']),
      ).toBe(0)
      expect(
        await runSeatbelt(profile, [
          '/bin/sh',
          '-c',
          'printf MUTATED >> "$1"',
          'rfc227',
          sealedArtifact,
        ]),
      ).not.toBe(0)
      expect(readFileSync(sealedArtifact, 'utf8')).toBe('SEALED')

      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: () => new Response('reachable'),
      })
      try {
        const url = `http://127.0.0.1:${server.port}/`
        const outside = Bun.spawn(['/usr/bin/curl', '--silent', '--fail', '--max-time', '2', url], {
          stdout: 'ignore',
          stderr: 'ignore',
        })
        expect(await outside.exited).toBe(0)
        expect(
          await runSeatbelt(profile, [
            '/usr/bin/curl',
            '--silent',
            '--fail',
            '--max-time',
            '2',
            url,
          ]),
        ).not.toBe(0)
      } finally {
        server.stop(true)
      }
    },
    SEATBELT_TEST_TIMEOUT_MS,
  )

  // RFC-252 G2 —— 真 sandbox-exec 证据：masks 之外从「可写」变成「只读」。
  //
  // 改动前 macOS child 是 `(allow default)`，masks 之外一律可写；本机实测
  // `/opt/homebrew/bin` 是 `drwxrwxrwx`，child 可以覆写任意 brew 二进制，等用户或 daemon
  // 下次执行即在沙箱外获得执行。Linux 侧 `--ro-bind / /` 从来没有这条通道。
  //
  // 用 `/Users/Shared` 做证据点：它是 macOS 上真实存在、非 root 可写、且**不在** masks
  // 也不在写例外（`/dev`、`/var/folders`）里的位置 —— 正是这类位置构成植入面。
  // 成对断言：不加沙箱必须写得进去（否则本用例是恒绿空断言），加了必须写不进去。
  seatbeltTest(
    'RFC-252 G2: masks 之外只读——不可写入但仍可读可执行',
    async () => {
      const status = await probeSandboxMechanism('darwin')
      if (!status.available) return

      const root = realpathSync(mkdtempSync(join(tmpdir(), 'rfc252-g2-')))
      roots.push(root)
      const appHome = join(root, 'app-home')
      const realHome = join(root, 'real-home')
      const worktreePath = join(appHome, 'worktree')
      const scratchPath = join(appHome, 'scratch')
      const privateHome = join(appHome, 'home')
      const privateTmp = join(appHome, 'tmp')
      for (const path of [appHome, realHome, worktreePath, scratchPath, privateHome, privateTmp]) {
        mkdirSync(path, { recursive: true })
      }

      const profile = renderNetlessSeatbeltProfile(
        NetlessSubprocessManifestSchema.parse({
          codec: 1,
          mode: 'shell',
          provider: {
            providerId: 'macos-seatbelt',
            config: { sandboxExecPath: '/usr/bin/sandbox-exec' },
          },
          worktreePath,
          scratchPath,
          appHome,
          realHome,
          gitCommonDirs: [],
          bindReadOnly: [],
          env: { HOME: privateHome, TMPDIR: privateTmp, PATH: '/usr/bin:/bin' },
          command: ['/bin/sh'],
        }),
      )

      const outsideTarget = join('/Users/Shared', `rfc252-g2-${process.pid}.probe`)
      const write = (target: string): string[] => ['/bin/sh', '-c', `: > ${target}`]
      try {
        // 对照组：这个位置**确实**是可写的，否则下面的 deny 断言毫无意义。
        expect(await runCommand(write(outsideTarget))).toBe(0)
        rmSync(outsideTarget, { force: true })

        expect(await runSeatbelt(profile, write(outsideTarget))).not.toBe(0)
        expect(existsSync(outsideTarget)).toBe(false)
      } finally {
        rmSync(outsideTarget, { force: true })
      }

      // 只读而非遮蔽：masks 之外仍可读、可执行（`/opt/homebrew/bin/python3` 照样能跑）。
      expect(await runSeatbelt(profile, ['/usr/bin/true'])).toBe(0)
      expect(await runSeatbelt(profile, ['/bin/sh', '-c', 'test -r /usr/bin/true'])).toBe(0)

      // 本任务自己的工作面照常可写，功能未被搞坏。
      expect(await runSeatbelt(profile, write(join(worktreePath, 'out.txt')))).toBe(0)
      expect(await runSeatbelt(profile, write(join(privateHome, 'rc')))).toBe(0)
      // /dev 写例外生效，否则连 `> /dev/null` 都会失败。
      expect(await runSeatbelt(profile, ['/bin/sh', '-c', 'echo hi > /dev/null'])).toBe(0)
    },
    SEATBELT_TEST_TIMEOUT_MS,
  )
})
