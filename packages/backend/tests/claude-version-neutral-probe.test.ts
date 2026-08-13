// 2026-08-13 CodeAgent regression: a claude-code-compatible custom binary can
// complete the real protocol smoke test while reporting an opaque `--version`.
// Version output is telemetry, so an exit-0 probe must remain available without
// requiring an X.Y.Z shape or enforcing Claude's advisory minimum.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeClaudeCode } from '../src/services/runtime/claudeCode/probe'
import { fakeBinaryPath, writeFakeBinary } from './fixtures/fakeBinary'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function versionBinary(stdout: string, exitCode = 0): string {
  const root = mkdtempSync(join(tmpdir(), 'aw-claude-version-'))
  roots.push(root)
  const binary = fakeBinaryPath(root, 'claude')
  writeFakeBinary(binary, { stdout, exitCode })
  return binary
}

describe('version-neutral Claude-compatible runtime probe', () => {
  for (const [label, output, expectedVersion] of [
    ['opaque CodeAgent build', 'CodeAgentCLI build-20260813\n', null],
    ['older semver', '1.0.0 (custom Claude-compatible fork)\n', '1.0.0'],
    ['official semver', '2.1.193 (Claude Code)\n', '2.1.193'],
    ['future semver', '999.0.0 (Claude-compatible fork)\n', '999.0.0'],
  ] as const) {
    test(`${label} is available regardless of the reported version`, async () => {
      const probe = await probeClaudeCode(versionBinary(output), { quiet: true })
      expect(probe).toMatchObject({
        ran: true,
        compatible: true,
        version: expectedVersion,
      })
      expect(probe.incompatibleReason).toBeUndefined()
    })
  }

  test('non-zero --version remains unavailable', async () => {
    const probe = await probeClaudeCode(versionBinary('opaque failure\n', 9), { quiet: true })
    expect(probe).toMatchObject({ ran: false, compatible: false, version: null })
  })
})
