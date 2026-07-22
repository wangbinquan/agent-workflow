// 6adf3ea1 (Codex impl-gate misc) — the live-integration path filter must cover
// the ENTIRE opencode compat surface, not just runner/envelope/protocol.
//
// WHY THIS EXISTS
// ---------------
// integration-opencode.yml gates the (expensive, real-LLM) live sweep behind a
// hand-maintained path filter. Before this, that filter listed runner.ts /
// envelope.ts / protocol.ts / opencode-plugin but NOT the driver, the spawn argv
// builder, or the version-registry. So a commit that renamed an opencode CLI flag
// (exactly 1964a0d0's shape) touched only services/runtime/opencode/spawn.ts +
// util/opencode-version-registry.ts and NEVER triggered the integration sweep —
// a launch-breaking drift could land fully green.
//
// The prior structural check only compared the yml's push list to its PR list
// (they are identical, hand-copied), so both could omit the same directory and
// nothing noticed. This guard instead pins the filter to the real opencode source
// surface: each required path must appear under BOTH the push and pull_request
// lists (→ exactly 2 occurrences of `- '<path>'`).
//
// MUTATION CHECK (manually verified): delete any REQUIRED entry from the yml (or
// from just one of the two lists) and this reds.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const YML = resolve(REPO_ROOT, '.github', 'workflows', 'integration-opencode.yml')

describe('integration-opencode path filter covers the opencode compat surface (6adf3ea1)', () => {
  const yml = readFileSync(YML, 'utf-8')
  // Each MUST appear under both the push and pull_request path lists.
  const REQUIRED = [
    'packages/backend/src/services/runtime/opencode/**', // driver / spawn / events / inlineConfig
    'packages/backend/src/util/opencode*.ts', // opencode.ts / version-registry / models
    'packages/backend/src/services/runner.ts', // NDJSON pump + spawn orchestration
    'e2e/fixtures/stub-opencode*.sh', // the six shell stubs the e2e drives
  ]
  for (const path of REQUIRED) {
    test(`gated on both push and PR: ${path}`, () => {
      expect(yml.split(`- '${path}'`).length - 1).toBe(2)
    })
  }
})
