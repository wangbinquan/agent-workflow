// Regression: any `git` spawn from the daemon must run with non-interactive
// env, otherwise ssh's first-connect host-key prompt — which reads `/dev/tty`,
// not stdin — hangs the daemon forever even though spawnGit/runGit set
// `stdin: 'ignore'`. Locks in the fix to that hang.
//
// Two layers of coverage:
//   1. Behavioral test on `nonInteractiveGitEnv()` itself.
//   2. Source-level grep that both git spawn sites pass it as `env:`. If a
//      future refactor reintroduces `env: process.env` (or omits `env`), this
//      test goes red before the daemon ever hangs in prod.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { nonInteractiveGitEnv } from '@/util/git'
import { envRecordGet } from '@agent-workflow/shared'

describe('nonInteractiveGitEnv()', () => {
  test('forces ssh BatchMode + accept-new and disables git terminal prompt', () => {
    const env = nonInteractiveGitEnv()
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    const ssh = env.GIT_SSH_COMMAND ?? ''
    expect(ssh).toContain('BatchMode=yes')
    expect(ssh).toContain('StrictHostKeyChecking=accept-new')
    // Leads with an `ssh` invocation so git actually calls openssh.
    expect(ssh.trim().startsWith('ssh')).toBe(true)
  })

  test('layers on top of caller-provided GIT_SSH_COMMAND, not replaces it', () => {
    const prev = process.env.GIT_SSH_COMMAND
    try {
      process.env.GIT_SSH_COMMAND = 'ssh -i /tmp/custom_id'
      const env = nonInteractiveGitEnv()
      expect(env.GIT_SSH_COMMAND).toContain('/tmp/custom_id')
      expect(env.GIT_SSH_COMMAND).toContain('BatchMode=yes')
      expect(env.GIT_SSH_COMMAND).toContain('StrictHostKeyChecking=accept-new')
    } finally {
      if (prev === undefined) delete process.env.GIT_SSH_COMMAND
      else process.env.GIT_SSH_COMMAND = prev
    }
  })

  test('passes through unrelated env (e.g. PATH)', () => {
    const env = nonInteractiveGitEnv()
    // RFC-254 T32: look the name up CASE-FOLDED, because Windows spells it
    // `Path`. `process.env` there is a case-insensitive proxy, so
    // `process.env.PATH` reads fine — but `nonInteractiveGitEnv` SPREADS it
    // into a plain object, and a plain object keeps only the real key. `.PATH`
    // on the result was therefore `undefined` on Windows while the value was
    // sitting right there under `Path`.
    //
    // The production code is correct as written: it forwards every real key, so
    // git receives the platform's own spelling and finds its PATH. Only this
    // assertion assumed the POSIX one.
    expect(envRecordGet(env, 'PATH', process.platform)).toBe(
      envRecordGet(process.env, 'PATH', process.platform),
    )
    expect(envRecordGet(env, 'PATH', process.platform)).not.toBeUndefined()
  })
})

describe('git spawn sites wire nonInteractiveGitEnv()', () => {
  const SPAWN_SITES = ['src/util/git.ts', 'src/services/gitRepoCache.ts']
  for (const rel of SPAWN_SITES) {
    test(`${rel} passes nonInteractiveGitEnv() to every Bun.spawn`, () => {
      const path = resolve(import.meta.dir, '..', rel)
      const src = readFileSync(path, 'utf-8')
      const lines = src.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (!/Bun\.spawn\(\{/.test(lines[i]!)) continue
        // Look up to 20 lines ahead for the matching object literal closing.
        const block = lines.slice(i, Math.min(lines.length, i + 20)).join('\n')
        // Heuristic: only enforce on `git` invocations (other Bun.spawn calls
        // in this file — none today, but future-proofing — shouldn't trip).
        if (!/cmd:\s*\[\s*['"]git['"]/.test(block)) continue
        if (!block.includes('nonInteractiveGitEnv()')) {
          throw new Error(
            `${rel}:${i + 1} spawns 'git' without env: nonInteractiveGitEnv() — ` +
              `would re-introduce the ssh host-key-prompt hang. Block:\n${block}`,
          )
        }
      }
    })
  }
})
