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
      const worktreePath = join(appHome, 'worktrees', 'task')
      const scratchPath = join(appHome, 'runs', 'task', 'scratch')
      const privateHome = join(appHome, 'runs', 'task', 'home')
      const privateTmp = join(appHome, 'runs', 'task', 'tmp')
      const sealPath = join(appHome, 'runs', 'task', 'seal')
      for (const path of [
        appHome,
        realHome,
        worktreePath,
        scratchPath,
        privateHome,
        privateTmp,
        sealPath,
      ]) {
        mkdirSync(path, { recursive: true })
      }

      const secretPath = join(appHome, 'secret.key')
      const worktreeOutput = join(worktreePath, 'output.txt')
      const sealedArtifact = join(sealPath, 'opencode')
      writeFileSync(secretPath, 'TOP-SECRET')
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
        bindReadOnly: [sealPath],
        env: {
          HOME: privateHome,
          TMPDIR: privateTmp,
          PATH: '/usr/bin:/bin',
        },
        command: ['/bin/sh'],
      })
      const profile = renderNetlessSeatbeltProfile(manifest)

      expect(await runSeatbelt(profile, ['/bin/cat', secretPath])).not.toBe(0)
      expect(
        await runSeatbelt(profile, [
          '/bin/sh',
          '-c',
          'printf WORKTREE_OK > "$1"',
          'rfc227',
          worktreeOutput,
        ]),
      ).toBe(0)
      expect(readFileSync(worktreeOutput, 'utf8')).toBe('WORKTREE_OK')
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
