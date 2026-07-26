// RFC-227 gated real macOS evidence for the OpenCode child provider.
// Run on a capable macOS host with:
//   RUN_SANDBOX_ITEST=1 bun test packages/backend/tests/rfc227-seatbelt-integration.test.ts

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
  )
})
