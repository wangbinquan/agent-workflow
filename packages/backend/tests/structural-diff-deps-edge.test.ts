// RFC-083 PR-B — supplementary edge coverage for dependency manifest parsing +
// set-diff. Locks two verified gaps the existing structural-diff-deps.test.ts
// skips entirely:
//
//   GAP 1 [depdiff-null-version-transitions] — deps present on BOTH sides where
//   the version is absent (null) on one or both sides. The line-45 guard in
//   deps/diff.ts `oldVer !== newVer && (oldVer !== null || newVer !== null)` is a
//   deliberate no-op suppressor: null↔string must emit 'updated', but null→null
//   (a version-less dep that didn't change, e.g. a gradle BOM platform or a cmake
//   find_package without a version) must emit NOTHING. Every prior dep-diff test
//   used string→string version changes, so this boundary was untested.
//
//   GAP 2 [manifest-cmake-conan-npm-peer-optional] — cmake + conan parsers and
//   npm peer/optional dependency blocks had zero parser tests; ecosystemForManifest
//   had no cmake/conan basename test. Regresses easily: parseConan's [requires]
//   section gating is a stateful parse, and npm peer/optional are silently dropped
//   if the block list shrinks.

import { describe, expect, test } from 'bun:test'
import {
  parseManifest,
  ecosystemForManifest,
} from '../src/modules/workspace-insight/domain/structuralDiff/deps/manifests'
import { dependencyChangesForManifest } from '../src/modules/workspace-insight/domain/structuralDiff/deps/diff'

// ── GAP 1: null↔string version transitions and null→null no-op ──────────────
describe('dependencyChangesForManifest — null version transitions (line-45 guard)', () => {
  test("null → string version gains a version → 'updated' (versionBefore undefined)", () => {
    const changes = dependencyChangesForManifest({
      filePath: 'build.gradle',
      oldContent: "implementation 'g:a'",
      newContent: "implementation 'g:a:1.0'",
    })
    expect(changes).toHaveLength(1)
    const c = changes[0]
    expect(c?.packageName).toBe('g:a')
    expect(c?.changeType).toBe('updated')
    // null → key omitted via `?? undefined` (lines 50-51), so assert undefined.
    expect(c?.versionBefore).toBeUndefined()
    expect(c?.versionAfter).toBe('1.0')
    expect(c?.viaManifest).toBe(true)
  })

  test("string → null version removed → 'updated' (versionAfter undefined)", () => {
    const changes = dependencyChangesForManifest({
      filePath: 'build.gradle',
      oldContent: "implementation 'g:a:1.0'",
      newContent: "implementation 'g:a'",
    })
    expect(changes).toHaveLength(1)
    const c = changes[0]
    expect(c?.packageName).toBe('g:a')
    expect(c?.changeType).toBe('updated')
    expect(c?.versionBefore).toBe('1.0')
    expect(c?.versionAfter).toBeUndefined()
  })

  test('null → null (version-less dep present on both sides, unchanged) → no change', () => {
    // cmake find_package(Foo) yields Foo→null on both sides; the
    // (oldVer !== null || newVer !== null) clause short-circuits the 'updated'
    // branch so nothing is emitted.
    const changes = dependencyChangesForManifest({
      filePath: 'CMakeLists.txt',
      oldContent: 'find_package(Foo)',
      newContent: 'find_package(Foo)',
    })
    expect(changes).toEqual([])
  })
})

// ── GAP 2: cmake + conan parsers, npm peer/optional, ecosystem mapping ──────
describe('parseManifest — cmake / conan / npm peer+optional (uncovered ecosystems)', () => {
  test('cmake: find_package with and without version', () => {
    const m = parseManifest('cmake', 'find_package(Boost 1.80 REQUIRED)\nfind_package(Threads)')
    expect(m.get('Boost')).toBe('1.80')
    // REQUIRED is not captured as a version (version group requires leading digit).
    expect(m.has('Threads')).toBe(true)
    expect(m.get('Threads')).toBeNull()
    expect(m.size).toBe(2)
  })

  test('conan: only [requires] section deps; later [section] lines excluded', () => {
    const m = parseManifest(
      'conan',
      '[requires]\nzlib/1.2.13\nfmt/9.1.0\n\n[generators]\nCMakeDeps',
    )
    expect(m.get('zlib')).toBe('1.2.13')
    expect(m.get('fmt')).toBe('9.1.0')
    // CMakeDeps lives under [generators] → inReq reset → excluded.
    expect(m.has('CMakeDeps')).toBe(false)
    expect(m.size).toBe(2)
  })

  test('npm: peerDependencies and optionalDependencies included', () => {
    const m = parseManifest(
      'npm',
      '{"peerDependencies":{"react":"^18"},"optionalDependencies":{"fsevents":"2"}}',
    )
    expect(m.get('react')).toBe('^18')
    expect(m.get('fsevents')).toBe('2')
  })
})

describe('ecosystemForManifest — cmake / conan basenames', () => {
  test('CMakeLists.txt → cmake, conanfile.txt → conan', () => {
    expect(ecosystemForManifest('a/CMakeLists.txt')).toBe('cmake')
    expect(ecosystemForManifest('conanfile.txt')).toBe('conan')
  })
})
