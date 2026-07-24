// RFC-227 — OpenCode reported versions are telemetry, never admission policy.
//
// Regression: production previously rejected every version below 1.18.3 and
// treated an exit-0 custom/non-semver version as incompatible before any
// protocol behavior could be tested.

import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeOpencode } from '../src/util/opencode'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function versionBinary(stdout: string): string {
  const root = mkdtempSync(join(tmpdir(), 'aw-rfc227-version-'))
  roots.push(root)
  const binary = join(root, 'opencode')
  const encoded = Buffer.from(stdout).toString('base64')
  writeFileSync(
    binary,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s' '${encoded}' | base64 -d
  exit 0
fi
exit 64
`,
  )
  chmodSync(binary, 0o755)
  return binary
}

describe('RFC-227 version-neutral OpenCode probe', () => {
  for (const [label, output, expectedVersion] of [
    ['older semver', 'opencode 0.9.0\n', '0.9.0'],
    ['former pin', 'opencode 1.18.3\n', '1.18.3'],
    ['newer semver', 'opencode 1.18.4\n', '1.18.4'],
    ['future semver', 'opencode 999.0.0\n', '999.0.0'],
    ['custom scheme', 'my-opencode enterprise-build\n', null],
  ] as const) {
    test(`${label} is available regardless of the reported version`, async () => {
      const probe = await probeOpencode(versionBinary(output), { quiet: true })
      expect(probe).toMatchObject({
        ran: true,
        compatible: true,
        version: expectedVersion,
      })
      expect(probe.incompatibleReason).toBeUndefined()
    })
  }

  test('spawn failure is still unavailable', async () => {
    const probe = await probeOpencode(join(tmpdir(), 'aw-rfc227-does-not-exist'), { quiet: true })
    expect(probe).toMatchObject({ ran: false, compatible: false, version: null })
  })
})
