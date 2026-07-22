// RFC-111 PR-A(A2) — GOLDEN lock on the opencode spawn surface. buildOpencodeSpawn
// is the byte-for-byte argv + env the runner used to build inline; if any token
// or env key drifts here, the opencode runtime's launch contract changed under
// the abstraction (the claude driver, PR-B, deliberately produces a DIFFERENT
// cmd/env from the same raw materials — this test pins opencode's).

import { describe, expect, it } from 'bun:test'
import {
  assertOpencodeSpawnSize,
  buildCommand,
  buildOpencodeSpawn,
  MAX_ARG_STRLEN_PAGES,
  MAX_OPENCODE_PROMPT_BYTES,
} from '@/services/runtime/opencode/spawn'

const BASE = {
  agentName: 'my-agent',
  prompt: 'THE PROMPT',
  worktreePath: '/wt',
  runDir: '/runs/t/n/.opencode',
  inlineConfigSerialized: '{"agent":{"my-agent":{}}}',
} as const

describe('buildOpencodeSpawn — argv golden (RFC-111 A2)', () => {
  // The prompt is a TRAILING positional after a `--` end-of-options separator —
  // NOT a bare positional after `run`. opencode's parser is `.strict()`, so a
  // prompt starting with `-` (e.g. the RFC-200 `---` injection boundary) would be
  // scanned as an unknown option → usage dump + exit 1. See spawn.ts buildCommand.
  it('default argv: run/--agent/--format json/--thinking/--dangerously-skip-permissions/-- <prompt>', () => {
    const { cmd } = buildOpencodeSpawn({ ...BASE })
    expect(cmd).toEqual([
      'opencode',
      'run',
      '--agent',
      'my-agent',
      '--format',
      'json',
      '--thinking',
      '--dangerously-skip-permissions',
      '--',
      'THE PROMPT',
    ])
  })

  it('honors opencodeCmd head + --session; --dangerously-skip-permissions is UNCONDITIONAL', () => {
    // flag-audit W0（§3 假旋钮）：`dangerouslySkipPermissions?: boolean` 参数已删——
    // 生产端从未有人传值，且 CLI 模式没有 permission 应答通道，非跳过运行会在第一个
    // tool 提示上挂死（假旋钮）。flag 现在无条件出现。
    // `--session <id>` precedes the `--`/prompt tail (a flag, must stay in the
    // parsed region), so the prompt remains the very last token.
    const { cmd } = buildOpencodeSpawn({
      ...BASE,
      opencodeCmd: ['bun', 'run', '/mock.ts'],
      resumeSessionId: 'opc_9',
    })
    expect(cmd).toEqual([
      'bun',
      'run',
      '/mock.ts',
      'run',
      '--agent',
      'my-agent',
      '--format',
      'json',
      '--thinking',
      '--dangerously-skip-permissions',
      '--session',
      'opc_9',
      '--',
      'THE PROMPT',
    ])
  })

  it('binaryVersion ≥1.18 spells the auto-approve flag --auto (2026-07-21 incident lock)', () => {
    // opencode 1.18.0 REMOVED --dangerously-skip-permissions (renamed --auto,
    // identical describe). On 1.18.3 the legacy spelling is an unknown argument:
    // the strict parser's .fail() swallows the error line and prints the bare
    // `run` usage before exit 1 — every spawn on the machine died that way.
    // The two goldens above pass NO binaryVersion and must stay legacy-spelled
    // byte-for-byte (that is what every TS/shell test stub receives).
    const { cmd } = buildOpencodeSpawn({ ...BASE, binaryVersion: '1.18.3' })
    expect(cmd).toEqual([
      'opencode',
      'run',
      '--agent',
      'my-agent',
      '--format',
      'json',
      '--thinking',
      '--auto',
      '--',
      'THE PROMPT',
    ])
    // Below the rename boundary the legacy spelling is preserved.
    const legacy = buildOpencodeSpawn({ ...BASE, binaryVersion: '1.17.8' })
    expect(legacy.cmd).toContain('--dangerously-skip-permissions')
    expect(legacy.cmd).not.toContain('--auto')
  })

  it('empty resumeSessionId is treated as absent (no --session)', () => {
    const { cmd } = buildOpencodeSpawn({ ...BASE, resumeSessionId: '' })
    expect(cmd).not.toContain('--session')
  })

  it('prompt is the last token, right after the `--` separator (dash-leading safe)', () => {
    // Regression lock for the workgroup outage: the RFC-200 wrapper makes every
    // untrusted-input prompt start with `---`. buildCommand MUST keep it behind
    // `--` so opencode's strict parser never treats it as a flag.
    const dashLeading = '---\n**Untrusted input boundary.** blah'
    const { cmd } = buildOpencodeSpawn({ ...BASE, prompt: dashLeading })
    const sep = cmd.lastIndexOf('--')
    expect(sep).toBeGreaterThan(-1)
    expect(cmd.slice(sep + 1)).toEqual([dashLeading])
    expect(cmd[cmd.length - 1]).toBe(dashLeading)
  })
})

describe('buildOpencodeSpawn — env golden (RFC-111 A2)', () => {
  it('sets PWD / OPENCODE_CONFIG_DIR / OPENCODE_CONFIG_CONTENT; no inventory/git by default', () => {
    const { env } = buildOpencodeSpawn({ ...BASE })
    expect(env.PWD).toBe('/wt')
    expect(env.OPENCODE_CONFIG_DIR).toBe('/runs/t/n/.opencode')
    expect(env.OPENCODE_CONFIG_CONTENT).toBe('{"agent":{"my-agent":{}}}')
    expect(env.OPENCODE_AW_INVENTORY_OUT).toBeUndefined()
    expect(env.GIT_AUTHOR_NAME).toBeUndefined()
    // inherits the daemon env baseline
    expect('PATH' in env).toBe(true)
  })

  it('sets OPENCODE_AW_INVENTORY_OUT only when provided', () => {
    const { env } = buildOpencodeSpawn({ ...BASE, inventoryOutPath: '/runs/t/n/inventory.json' })
    expect(env.OPENCODE_AW_INVENTORY_OUT).toBe('/runs/t/n/inventory.json')
  })

  it('injects all four GIT_* only when BOTH name and email are non-empty (RFC-067)', () => {
    const both = buildOpencodeSpawn({ ...BASE, gitUserName: 'Ada', gitUserEmail: 'ada@x.io' }).env
    expect(both.GIT_AUTHOR_NAME).toBe('Ada')
    expect(both.GIT_AUTHOR_EMAIL).toBe('ada@x.io')
    expect(both.GIT_COMMITTER_NAME).toBe('Ada')
    expect(both.GIT_COMMITTER_EMAIL).toBe('ada@x.io')

    // half-set → none (defensive XOR guard)
    const half = buildOpencodeSpawn({ ...BASE, gitUserName: 'Ada', gitUserEmail: '' }).env
    expect(half.GIT_AUTHOR_NAME).toBeUndefined()
    const nullEmail = buildOpencodeSpawn({ ...BASE, gitUserName: 'Ada', gitUserEmail: null }).env
    expect(nullEmail.GIT_AUTHOR_NAME).toBeUndefined()
  })
})

// design/test-guard-audit-2026-07-21 gap B4-runtime-5 (Top-14) — a prompt that
// overflows Linux's 128 KiB per-argv-element limit must fail READABLY at spawn
// assembly (the runner turns a buildCommand throw into the node's errorMessage),
// not with a raw E2BIG kernel error once execve is attempted.
describe('opencode prompt argv size guard (B4-runtime-5)', () => {
  const OPTS = { agent: { name: 'a' } } as const

  it('accepts a prompt right at the limit', () => {
    const prompt = 'x'.repeat(MAX_OPENCODE_PROMPT_BYTES)
    expect(() => buildCommand(OPTS, prompt)).not.toThrow()
  })

  it('rejects a prompt one byte over the limit with an actionable message', () => {
    const prompt = 'x'.repeat(MAX_OPENCODE_PROMPT_BYTES + 1)
    expect(() => buildCommand(OPTS, prompt)).toThrow(/prompt-too-large/)
  })

  it('measures BYTES not code units — a CJK prompt overflows below the .length limit', () => {
    // '字' is 3 UTF-8 bytes. A string of MAX/3 + 1 chars is under the char count
    // but over the byte limit, and must still be refused.
    const chars = Math.floor(MAX_OPENCODE_PROMPT_BYTES / 3) + 1
    const prompt = '字'.repeat(chars)
    expect(prompt.length).toBeLessThan(MAX_OPENCODE_PROMPT_BYTES)
    expect(Buffer.byteLength(prompt, 'utf8')).toBeGreaterThan(MAX_OPENCODE_PROMPT_BYTES)
    expect(() => buildCommand(OPTS, prompt)).toThrow(/prompt-too-large/)
  })

  it('the limit leaves headroom under the 128 KiB kernel cap', () => {
    // argv also carries the other flags and shares ARG_MAX with the ~128 KiB
    // env block; the guard must sit strictly below 128 KiB.
    expect(MAX_OPENCODE_PROMPT_BYTES).toBeLessThan(128 * 1024)
  })
})

// misc impl-gate [medium] b56190a3 (2× Codex re-review) — buildOpencodeEnv injects
// OPENCODE_CONFIG_CONTENT (a large inline agent/MCP/config) with NO size check, so
// on Linux one oversized value crosses MAX_ARG_STRLEN and execve fails with a raw
// E2BIG. assertOpencodeSpawnSize turns that into a readable runtime-spawn-failed.
//
// Scoped through two rounds of false-reject bugs:
//  - the first cut used a fixed 240 KiB TOTAL budget on a WRONG "macOS ARG_MAX =
//    256 KiB" premise (it is ~1 MiB) and measured inherited process.env;
//  - the second used a fixed 128 KiB per-string cap, which is only MAX_ARG_STRLEN
//    on a 4 KiB-page kernel — Linux arm64 with 16/64 KiB pages has a 512 KiB/2 MiB
//    real limit, so a legitimate large config was false-rejected there.
// The guard now checks ONLY OPENCODE_CONFIG_CONTENT, ONLY on Linux, against
// 32 × the RUNTIME page size, and SKIPS when the page size can't be probed. The
// total argv+env budget is left to a future platform-aware guard.
describe('opencode inline-config size guard (misc impl-gate b56190a3)', () => {
  const under = '{"agent":{"a":{}}}'
  const KEY_OVERHEAD = 'OPENCODE_CONFIG_CONTENT'.length + 1 /* '=' */ + 1 /* NUL */
  // A value that fills 32 × 4 KiB pages — over the cap on a 4 KiB kernel.
  const over4k = 'x'.repeat(MAX_ARG_STRLEN_PAGES * 4096)

  it('rejects an oversized config against 32 × the (injected) page size', () => {
    expect(() =>
      assertOpencodeSpawnSize(
        { OPENCODE_CONFIG_CONTENT: over4k },
        { platform: 'linux', pageSize: 4096 },
      ),
    ).toThrow(/spawn-config-too-large/)
  })

  it('does NOT false-reject on a large-page kernel — the SAME value fits under 32 × 64 KiB', () => {
    // The arm64 regression the 2nd Codex round caught: 128 KiB is fine when
    // MAX_ARG_STRLEN is 32 × 64 KiB = 2 MiB.
    expect(() =>
      assertOpencodeSpawnSize(
        { OPENCODE_CONFIG_CONTENT: over4k },
        { platform: 'linux', pageSize: 65536 },
      ),
    ).not.toThrow()
  })

  it('scales the cap with page size at the exact KEY=VALUE\\0 boundary (4/16/64 KiB)', () => {
    for (const page of [4096, 16384, 65536]) {
      const cap = MAX_ARG_STRLEN_PAGES * page
      const atCap = 'x'.repeat(cap - KEY_OVERHEAD) // whole entry == cap exactly
      const overByOne = 'x'.repeat(cap - KEY_OVERHEAD + 1)
      expect(() =>
        assertOpencodeSpawnSize(
          { OPENCODE_CONFIG_CONTENT: atCap },
          { platform: 'linux', pageSize: page },
        ),
      ).not.toThrow()
      expect(() =>
        assertOpencodeSpawnSize(
          { OPENCODE_CONFIG_CONTENT: overByOne },
          { platform: 'linux', pageSize: page },
        ),
      ).toThrow(/spawn-config-too-large/)
    }
  })

  it('skips entirely when the page size cannot be probed (never false-reject)', () => {
    expect(() =>
      assertOpencodeSpawnSize(
        { OPENCODE_CONFIG_CONTENT: over4k },
        { platform: 'linux', pageSize: null },
      ),
    ).not.toThrow()
  })

  it('measures BYTES not code units — a CJK config overflows below .length', () => {
    const cap = MAX_ARG_STRLEN_PAGES * 4096
    const cjk = '字'.repeat(Math.floor(cap / 3) + 1)
    expect(cjk.length).toBeLessThan(cap)
    expect(() =>
      assertOpencodeSpawnSize(
        { OPENCODE_CONFIG_CONTENT: cjk },
        { platform: 'linux', pageSize: 4096 },
      ),
    ).toThrow(/spawn-config-too-large/)
  })

  it('does NOT reject on macOS — no per-string cap there', () => {
    expect(() =>
      assertOpencodeSpawnSize(
        { OPENCODE_CONFIG_CONTENT: over4k },
        { platform: 'darwin', pageSize: 4096 },
      ),
    ).not.toThrow()
  })

  it('NEVER inspects inherited env — a huge ambient variable cannot fail a valid spawn', () => {
    // The regression the 1st Codex round caught: a legitimate big env var breaking
    // every spawn. Only OPENCODE_CONFIG_CONTENT is measured.
    expect(() =>
      assertOpencodeSpawnSize(
        { SOME_INHERITED_VAR: over4k, OPENCODE_CONFIG_CONTENT: under },
        { platform: 'linux', pageSize: 4096 },
      ),
    ).not.toThrow()
  })

  it('accepts a normal inline config on Linux', () => {
    expect(() =>
      assertOpencodeSpawnSize(
        { OPENCODE_CONFIG_CONTENT: under },
        { platform: 'linux', pageSize: 4096 },
      ),
    ).not.toThrow()
  })

  it('buildOpencodeSpawn wires the guard (throws on a config over even a 64 KiB-page limit)', () => {
    // >2 MiB exceeds 32 × even a 64 KiB page, so buildOpencodeSpawn's own probe
    // (real getconf on Linux) must reject it there; macOS has no per-string cap.
    const huge = 'x'.repeat(2 * 1024 * 1024 + 128)
    const call = () => buildOpencodeSpawn({ ...BASE, inlineConfigSerialized: huge })
    if (process.platform === 'linux') {
      expect(call).toThrow(/spawn-config-too-large/)
    } else {
      expect(call).not.toThrow()
      // Prove the wiring: the env it produced trips the guard under the Linux rule.
      expect(() =>
        assertOpencodeSpawnSize(call().env, { platform: 'linux', pageSize: 4096 }),
      ).toThrow(/spawn-config-too-large/)
    }
  })
})
