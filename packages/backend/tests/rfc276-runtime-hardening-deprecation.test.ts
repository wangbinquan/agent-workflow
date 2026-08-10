// RFC-276 reverse architecture lock.
//
// The runtime-hardening removal is intentionally one-way: active product code
// may keep a tiny config-migration reader for retired keys, but it must not grow
// a second launcher/sandbox/store path again. Claude's optional IS_SANDBOX=1
// assignment is an explicit runtime-profile compatibility toggle, not an
// operating-system isolation claim.

import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const ACTIVE_ROOTS = [
  resolve(REPO_ROOT, 'packages/backend/src'),
  resolve(REPO_ROOT, 'packages/shared/src'),
  resolve(REPO_ROOT, 'packages/frontend/src'),
  resolve(REPO_ROOT, 'e2e'),
]

interface ActiveFile {
  path: string
  text: string
}

function activeFiles(): ActiveFile[] {
  const files: ActiveFile[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = resolve(directory, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.[cm]?[jt]sx?$/.test(entry)) {
        files.push({
          path: relative(REPO_ROOT, path).split(sep).join('/'),
          text: readFileSync(path, 'utf8'),
        })
      }
    }
  }
  for (const root of ACTIVE_ROOTS) walk(root)
  return files
}

const RETIRED_CONFIG_READER = 'packages/backend/src/config/index.ts'

describe('RFC-276 runtime hardening deprecation', () => {
  test('active product code has no retired launcher, identity, store, or sandbox surface', () => {
    const rules: Array<{ name: string; pattern: RegExp; allowed?: ReadonlySet<string> }> = [
      {
        name: 'sandboxMode',
        pattern: /\bsandboxMode\b/g,
        allowed: new Set([RETIRED_CONFIG_READER]),
      },
      {
        name: 'businessToolchainPaths',
        pattern: /\bbusinessToolchainPaths\b/g,
        allowed: new Set([RETIRED_CONFIG_READER]),
      },
      {
        name: 'inheritMachineOpencodeConfig',
        pattern: /\binheritMachineOpencodeConfig\b/g,
        allowed: new Set([RETIRED_CONFIG_READER]),
      },
      { name: 'SandboxCard', pattern: /\bSandboxCard\b/g },
      { name: 'ContainmentCoordinator', pattern: /\bContainmentCoordinator\b/g },
      { name: 'containment runtime input', pattern: /\bcontainment(?:Coordinator|Profile)\b/g },
      {
        name: 'verified launcher module',
        pattern: /\bverified(?:Launcher|Plan|Manifest|Inventory)\b/g,
      },
      { name: 'binary snapshot module', pattern: /\bbinarySnapshot\b/g },
      { name: 'netless projection module', pattern: /\bnetlessProjection\b/g },
      { name: 'contained spawn module', pattern: /\bcontainedSpawn\b/g },
      { name: 'execution identity error', pattern: /execution-identity-/g },
      { name: 'Intent permission profile', pattern: /\bintent-read-v1\b/g },
      {
        name: 'system permission profile capability',
        pattern: /\b(?:systemPermissionProfile|narrowedSystemPermissionProfiles)\b/g,
      },
      { name: 'runtime fingerprint', pattern: /\bruntimeFingerprint\b/g },
      { name: 'private runtime store path', pattern: /\bsessionStore(?:Root|DbPath)\b/g },
      {
        name: 'runtime provenance digest',
        pattern:
          /\b(?:runtimeBinaryDigest|mcpExecutionDigest|sessionContractDigest|rawCommandDigest|spawnCommandDigest)\b/g,
      },
    ]
    const offenders: string[] = []
    for (const file of activeFiles()) {
      for (const rule of rules) {
        const count = [...file.text.matchAll(rule.pattern)].length
        if (count > 0 && !rule.allowed?.has(file.path)) {
          offenders.push(`${file.path}: ${rule.name} (${count})`)
        }
      }
    }
    expect(offenders.sort()).toEqual([])
  })

  test('retired implementation entrypoints stay deleted', () => {
    const deleted = [
      'packages/backend/src/cli/sandbox.ts',
      'packages/backend/src/services/containmentComposition.ts',
      'packages/backend/src/services/execution/containedSpawn.ts',
      'packages/backend/src/services/executionPolicy.ts',
      'packages/backend/src/services/runtime/binarySnapshot.ts',
      'packages/backend/src/services/runtime/netlessProjection.ts',
      'packages/backend/src/services/runtime/opencode/containment.ts',
      'packages/backend/src/services/runtime/opencode/hermetic.ts',
      'packages/backend/src/services/runtime/opencode/verifiedLauncher.ts',
      'packages/backend/src/services/runtime/opencode/verifiedManifest.ts',
      'packages/backend/src/services/runtime/opencode/verifiedPlan.ts',
      'packages/backend/src/services/sandbox/index.ts',
      'packages/frontend/src/components/settings/SandboxCard.tsx',
      'packages/shared/src/executionIdentity.ts',
    ]
    expect(deleted.filter((path) => existsSync(resolve(REPO_ROOT, path)))).toEqual([])
  })

  test('automation and current docs cannot reactivate the retired path', () => {
    const currentFiles = [
      '.github/workflows/ci.yml',
      '.github/workflows/integration-opencode.yml',
      '.github/workflows/windows-platform.yml',
      'README.md',
      'README.zh-CN.md',
      'CLAUDE.md',
      'docs/OPENCODE_CONFIG.md',
      'docs/skill.md',
      'docs/troubleshooting.md',
    ]
    const forbidden = /RUN_SANDBOX_ITEST|ContainmentCoordinator|\b(?:Seatbelt|bubblewrap)\b/g
    const offenders = currentFiles.flatMap((path) => {
      const matches = [...readFileSync(resolve(REPO_ROOT, path), 'utf8').matchAll(forbidden)]
      return matches.map((match) => `${path}: ${match[0]}`)
    })
    expect(offenders).toEqual([])
  })

  test('Claude keeps IS_SANDBOX as an opt-in compatibility toggle without spreading it to OpenCode', () => {
    const claude = readFileSync(
      resolve(REPO_ROOT, 'packages/backend/src/services/runtime/claudeCode/spawn.ts'),
      'utf8',
    )
    const opencode = readFileSync(
      resolve(REPO_ROOT, 'packages/backend/src/services/runtime/opencode/spawn.ts'),
      'utf8',
    )
    const reserved = readFileSync(
      resolve(REPO_ROOT, 'packages/shared/src/runtimeConfigDir.ts'),
      'utf8',
    )
    expect(claude.match(/env\.IS_SANDBOX = '1'/g)).toHaveLength(1)
    expect(claude).toContain('assembly.isSandbox === true')
    expect(claude).toContain("key.toUpperCase() === 'IS_SANDBOX'")
    expect(claude).toContain('not evidence of a platform OS sandbox')
    expect(opencode).not.toContain('IS_SANDBOX')
    expect(reserved).toContain(
      "'IS_SANDBOX', // runtime-profile controlled Claude CLI compatibility marker",
    )
  })
})
