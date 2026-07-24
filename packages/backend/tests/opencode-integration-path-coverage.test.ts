// 6adf3ea1 (Codex impl-gate misc) — the live-integration path filter must cover
// the opencode compat surface, and BOTH the push and pull_request lists must carry
// the SAME complete set.
//
// WHY THIS EXISTS
// ---------------
// integration-opencode.yml gates the (expensive, real-LLM) live sweep behind a
// hand-maintained path filter that formerly listed runner/envelope/protocol but
// NOT the driver, spawn argv builder, or version-registry. A commit that renamed
// an opencode CLI flag (1964a0d0's shape) touched only services/runtime/opencode/
// spawn.ts + util/opencode-version-registry.ts and never triggered the sweep.
//
// A naive guard that just counts `- '<path>'` substrings across the whole YAML is
// itself a false-green (Codex round-2): two copies in push with none in PR, or one
// buried in a comment, still totals 2. So this guard PARSES the push.paths and
// pull_request.paths lists SEPARATELY and asserts each equals the exact canonical
// set — no omission, no duplicate, no drift between the two triggers.
//
// SCOPE NOTE (deferred): completeness of the canonical set itself against the
// driver's full transitive opencode-only dependency closure (capture / inventory /
// session-walk modules) and giving the live suite a case that goes through the
// production buildBusinessSpawn→registry→spawn chain are a separate hardening pass
// — see memory project_spawn_size_guard_deferred sibling note. This guard locks
// what IS listed; it does not yet prove the list is closure-complete.
//
// MUTATION CHECK (manually verified): drop any entry from push.paths → push test
// reds; move an entry so only push has it → pull_request test reds.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const YML = resolve(REPO_ROOT, '.github', 'workflows', 'integration-opencode.yml')

/** The exact path list every `on:` trigger must carry, sorted for comparison. */
const CANONICAL = [
  'packages/backend/src/main.ts',
  'packages/backend/src/services/runner.ts',
  'packages/backend/src/services/envelope.ts',
  'packages/backend/src/services/protocol.ts',
  'packages/backend/src/services/runtime/opencode/**',
  'packages/backend/src/util/opencode*.ts',
  'packages/backend/src/opencode-plugin/**',
  'packages/backend/tests/integration-opencode/**',
  'e2e/fixtures/stub-opencode*.sh',
  '.github/workflows/integration-opencode.yml',
].sort()

/**
 * Parse the `paths:` list under a specific `on:` trigger — line-based, so a stray
 * copy under the wrong trigger or inside a comment does NOT count toward it.
 */
function pathsUnder(yml: string, trigger: 'push' | 'pull_request'): string[] {
  const out: string[] = []
  let state: 'seek' | 'trigger' | 'paths' = 'seek'
  for (const line of yml.split('\n')) {
    if (/^ {2}[A-Za-z_]+:/.test(line)) {
      // a top-level `on:` child at 2-space indent (push / pull_request / schedule…)
      state = line.trimEnd() === `  ${trigger}:` ? 'trigger' : 'seek'
      continue
    }
    if (state === 'seek') continue
    if (/^ {4}paths:\s*$/.test(line)) {
      state = 'paths'
      continue
    }
    if (state === 'paths') {
      const m = line.match(/^ {6}- '([^']+)'\s*$/)
      if (m) {
        out.push(m[1]!)
        continue
      }
      if (/^\s*#/.test(line) || line.trim() === '') continue // comment / blank inside list
      state = 'trigger' // any other line ends the paths block
    }
  }
  return out
}

describe('integration-opencode path filter covers the opencode compat surface (6adf3ea1)', () => {
  const yml = readFileSync(YML, 'utf-8')

  test('push.paths is exactly the canonical set (no omission, no duplicate)', () => {
    expect([...pathsUnder(yml, 'push')].sort()).toEqual(CANONICAL)
  })

  test('pull_request.paths is exactly the canonical set (identical to push)', () => {
    expect([...pathsUnder(yml, 'pull_request')].sort()).toEqual(CANONICAL)
  })
})
