// RFC-130 D7 — git >= 2.38 boot gate wiring. Why this file exists:
//
// 2026-07-05 a real deployment (daemon host running git < 2.38) failed every
// task at merge-back with the cryptic
//   `merge-back-failed: git merge-tree: usage: git merge-tree <base-tree> <branch1> <branch2>`
// — pre-2.38 `git merge-tree` has no option parsing at all (v2.34.1
// builtin/merge-tree.c: `if (argc != 4) usage(merge_tree_usage)`), so
// RFC-130's `--write-tree` merge-back dies AFTER the agent already ran and
// burned its tokens. RFC-130 design.md §5.2/D7 decreed "git < 2.38 → daemon
// refuses to START", and gitVersion.ts carried `supportsMergeTreeWriteTree`
// since T1 (459f3ae) — but the flag had ZERO production consumers and
// `detectGitCapabilities()` was never called at boot (which also left the
// RFC-034 submodule-caps cache permanently null). This file locks the wiring:
// the pure gate, the doctor floor (2.5.0 → 2.38.0), and the start.ts order.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { evaluateGitCheck } from '../src/cli/doctor'
import {
  __setCachedGitCapabilitiesForTesting,
  capabilitiesFromVersion,
  detectGitCapabilities,
  getCachedGitCapabilities,
  MIN_GIT_VERSION,
  mergeTreeGateError,
  parseGitVersion,
} from '../src/services/gitVersion'

describe('mergeTreeGateError — RFC-130 D7 boot gate (pure)', () => {
  test('git 2.34.1 (Ubuntu 22.04, the incident shape) → refusal names found version + floor', () => {
    const err = mergeTreeGateError(capabilitiesFromVersion(parseGitVersion('git version 2.34.1')))
    expect(err).not.toBeNull()
    expect(err).toContain(MIN_GIT_VERSION)
    expect(err).toContain('git version 2.34.1')
    expect(err).toContain('merge-tree --write-tree')
  })

  test('git 2.37.9 (last pre-flag minor) → refused', () => {
    expect(
      mergeTreeGateError(capabilitiesFromVersion(parseGitVersion('git version 2.37.9'))),
    ).not.toBeNull()
  })

  test('git 2.38.0 (exact floor) and modern Apple git → pass', () => {
    expect(
      mergeTreeGateError(capabilitiesFromVersion(parseGitVersion('git version 2.38.0'))),
    ).toBeNull()
    expect(
      mergeTreeGateError(
        capabilitiesFromVersion(parseGitVersion('git version 2.50.1 (Apple Git-155)')),
      ),
    ).toBeNull()
  })

  test('git missing / unparseable (null version) → refused with floor named', () => {
    const err = mergeTreeGateError(capabilitiesFromVersion(null))
    expect(err).not.toBeNull()
    expect(err).toContain(MIN_GIT_VERSION)
  })
})

describe('doctor evaluateGitCheck — floor raised 2.5.0 → 2.38.0', () => {
  test('git 2.34.1 → ok:false naming the 2.38.0 floor (old doctor called this healthy)', () => {
    const r = evaluateGitCheck('git version 2.34.1\n')
    expect(r.ok).toBe(false)
    expect(r.message).toContain(MIN_GIT_VERSION)
  })

  test('modern git → ok:true', () => {
    const r = evaluateGitCheck('git version 2.50.1 (Apple Git-155)\n')
    expect(r.ok).toBe(true)
    expect(r.message).toContain(MIN_GIT_VERSION)
  })

  test('unparseable output → ok:false', () => {
    expect(evaluateGitCheck('hg version 5.0').ok).toBe(false)
  })
})

describe('boot wiring (source locks + real probe)', () => {
  test('start.ts wires detectGitCapabilities + gate BEFORE the DB opens', () => {
    const src = readFileSync(resolve(import.meta.dir, '../src/cli/start.ts'), 'utf8')
    const probeIdx = src.indexOf('detectGitCapabilities()')
    const gateIdx = src.indexOf('mergeTreeGateError(')
    const dbIdx = src.indexOf('openDb(')
    expect(probeIdx).toBeGreaterThan(-1)
    expect(gateIdx).toBeGreaterThan(-1)
    expect(dbIdx).toBeGreaterThan(-1)
    expect(probeIdx).toBeLessThan(dbIdx)
    expect(gateIdx).toBeLessThan(dbIdx)
  })

  test('doctor checkGit routes through evaluateGitCheck (no private 2.5.0 floor left)', () => {
    const src = readFileSync(
      resolve(
        import.meta.dir,
        '../src/modules/system-operations/infrastructure/local/doctorDiagnostics.ts',
      ),
      'utf8',
    )
    expect(src).toContain('evaluateGitCheck(out)')
    // The old private floor (`compareSemver(v, '2.5.0') < 0`) must not return;
    // docstrings may still MENTION 2.5.0 as history, so lock the code shape.
    expect(src).not.toContain('compareSemver(')
  })

  test('detectGitCapabilities probes the real PATH git and populates the cache', async () => {
    const prev = getCachedGitCapabilities()
    try {
      const caps = await detectGitCapabilities()
      // Dev/CI floors are >= 2.38 by policy now; a failure here means the
      // environment running the suite is itself below the platform floor.
      expect(caps.version).not.toBeNull()
      expect(caps.supportsMergeTreeWriteTree).toBe(true)
      expect(getCachedGitCapabilities()).toEqual(caps)
    } finally {
      __setCachedGitCapabilitiesForTesting(prev)
    }
  })
})
