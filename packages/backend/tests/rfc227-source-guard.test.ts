// RFC-227 source ratchet: OpenCode admission is behavior/digest/capability
// based. Historical RFCs and migration input columns may still mention the old
// contract; this guard deliberately covers only the current production graph.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')

function source(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8')
}

const CURRENT_OPENCODE_GRAPH = [
  'packages/backend/src/util/opencode.ts',
  'packages/backend/src/routes/runtime.ts',
  'packages/backend/src/routes/runtimes.ts',
  'packages/backend/src/services/opencodeSessionOwner.ts',
  'packages/backend/src/services/opencodeStoreRecovery.ts',
  'packages/backend/src/services/sessionModeFallback.ts',
  'packages/backend/src/services/runtime/opencode/controlProtocol.ts',
  'packages/backend/src/services/runtime/opencode/directApiSchemas.ts',
  'packages/backend/src/services/runtime/opencode/runtimeBinary.ts',
  'packages/backend/src/services/runtime/opencode/verifiedLauncher.ts',
  'packages/backend/src/services/runtime/opencode/verifiedManifest.ts',
  'packages/backend/src/services/runtime/opencode/verifiedPlan.ts',
  'packages/backend/src/services/runtime/opencode/verifiedPlanCore.ts',
  'packages/backend/src/services/runtime/opencode/verifiedSystemPlan.ts',
] as const

describe('RFC-227 production source guard', () => {
  test('contains no version floor, ceiling, exact-build allowlist, or official-build API', () => {
    const forbidden = [
      'MIN_OPENCODE_VERSION',
      'PINNED_OPENCODE_VERSION',
      'OFFICIAL_OPENCODE_BUILDS',
      'requireOfficialOpencodeBuild',
      'officialBuildDigest',
      'opencodeVersion ===',
      'opencodeVersion !==',
      'opencodeSupportsResume',
      'unsupported-opencode-version',
    ]
    for (const path of CURRENT_OPENCODE_GRAPH) {
      const text = source(path)
      for (const token of forbidden) expect(text, `${path}: ${token}`).not.toContain(token)
    }
  })

  test('core admission consumes an open provider plan without an OS-name gate', () => {
    const core = source('packages/backend/src/services/runtime/opencode/verifiedPlanCore.ts')
    const containment = source('packages/backend/src/services/runtime/opencode/containment.ts')
    const manifest = source('packages/backend/src/services/runtime/opencode/verifiedManifest.ts')
    const shared = source('packages/shared/src/schemas/runtime.ts')

    for (const [name, text] of [
      ['verifiedPlanCore.ts', core],
      ['containment.ts', containment],
      ['verifiedManifest.ts', manifest],
    ] as const) {
      expect(text, name).not.toMatch(/process\.platform|platform\s*[!=]==?\s*['"]linux['"]/)
    }
    expect(containment).toContain('providerId: z.string()')
    expect(manifest).toContain('childProvider: RuntimeChildProviderPlanSchema')
    expect(shared).toContain('mechanism: z.string().min(1).nullable()')
    expect(shared).not.toMatch(/mechanism:\s*z\.enum/)
  })

  test('platform-specific child rendering is extensible without editing the core', () => {
    const subprocess = source('packages/backend/src/services/runtime/opencode/sealedSubprocess.ts')
    expect(subprocess).toContain('customNetlessRenderers.get(provider.providerId)')
    expect(subprocess).toContain('registerNetlessSubprocessProvider')
    expect(subprocess).toContain("provider.providerId === 'linux-bwrap'")
    expect(subprocess).toContain("provider.providerId === 'macos-seatbelt'")
  })
})
