// RFC-034 T3 — git version probe + capability derivation.

import { describe, expect, test } from 'bun:test'
import * as pure from '../src/platform/contracts/gitVersion'
import * as compatibility from '../src/services/gitVersion'
import {
  capabilitiesFromVersion,
  gitVersionAtLeast,
  parseGitVersion,
} from '../src/services/gitVersion'

describe('parseGitVersion', () => {
  test('parses macOS Apple git', () => {
    const v = parseGitVersion('git version 2.39.3 (Apple Git-145)\n')
    expect(v).toEqual({ major: 2, minor: 39, patch: 3, raw: 'git version 2.39.3 (Apple Git-145)' })
  })

  test('parses upstream form', () => {
    expect(parseGitVersion('git version 2.42.0')).toMatchObject({
      major: 2,
      minor: 42,
      patch: 0,
    })
  })

  test('parses without patch', () => {
    expect(parseGitVersion('git version 2.4')).toMatchObject({ major: 2, minor: 4, patch: 0 })
  })

  test('rejects unrelated output', () => {
    expect(parseGitVersion('hg version 5.0')).toBeNull()
    expect(parseGitVersion('')).toBeNull()
  })
})

describe('gitVersionAtLeast / capabilities', () => {
  test('null version → all caps false', () => {
    const caps = capabilitiesFromVersion(null)
    expect(caps.supportsSubmoduleJobs).toBe(false)
    expect(caps.supportsRecurseInWorktree).toBe(false)
    expect(caps.supportsMergeTreeWriteTree).toBe(false) // RFC-130 D7
  })

  test('RFC-130 merge-tree --write-tree gate: 2.37 false, 2.38 true', () => {
    expect(
      capabilitiesFromVersion(parseGitVersion('git version 2.37.9')).supportsMergeTreeWriteTree,
    ).toBe(false)
    expect(
      capabilitiesFromVersion(parseGitVersion('git version 2.38.0')).supportsMergeTreeWriteTree,
    ).toBe(true)
  })

  test('2.4 → recurse false, jobs false', () => {
    const caps = capabilitiesFromVersion(parseGitVersion('git version 2.4.0'))
    expect(caps.supportsRecurseInWorktree).toBe(false)
    expect(caps.supportsSubmoduleJobs).toBe(false)
  })

  test('2.5 → recurse true, jobs false', () => {
    const caps = capabilitiesFromVersion(parseGitVersion('git version 2.5.0'))
    expect(caps.supportsRecurseInWorktree).toBe(true)
    expect(caps.supportsSubmoduleJobs).toBe(false)
  })

  test('2.13 → both true', () => {
    const caps = capabilitiesFromVersion(parseGitVersion('git version 2.13.0'))
    expect(caps.supportsSubmoduleJobs).toBe(true)
    expect(caps.supportsRecurseInWorktree).toBe(true)
  })

  test('2.39 (modern) → all true', () => {
    const caps = capabilitiesFromVersion(parseGitVersion('git version 2.39.3'))
    expect(caps.supportsSubmoduleJobs).toBe(true)
    expect(caps.supportsRecurseInWorktree).toBe(true)
    expect(caps.supportsMergeTreeWriteTree).toBe(true) // RFC-130 D7
  })

  test('gitVersionAtLeast comparison edge cases', () => {
    expect(gitVersionAtLeast({ major: 3, minor: 0, patch: 0, raw: '' }, 2, 13)).toBe(true)
    expect(gitVersionAtLeast({ major: 2, minor: 12, patch: 99, raw: '' }, 2, 13)).toBe(false)
    expect(gitVersionAtLeast({ major: 2, minor: 13, patch: 0, raw: '' }, 2, 13)).toBe(true)
    expect(gitVersionAtLeast(null, 2, 0)).toBe(false)
  })
})

// RFC-370: extracting pure version values must keep the old facade identities.
test('the native facade re-exports the one complete pure Git version contract', () => {
  expect(compatibility.parseGitVersion).toBe(pure.parseGitVersion)
  expect(compatibility.gitVersionAtLeast).toBe(pure.gitVersionAtLeast)
  expect(compatibility.capabilitiesFromVersion).toBe(pure.capabilitiesFromVersion)
  expect(compatibility.MIN_GIT_VERSION).toBe(pure.MIN_GIT_VERSION)
  expect(compatibility.mergeTreeGateError).toBe(pure.mergeTreeGateError)
  expect(Object.keys(pure).sort()).toEqual([
    'MIN_GIT_VERSION',
    'capabilitiesFromVersion',
    'gitVersionAtLeast',
    'mergeTreeGateError',
    'parseGitVersion',
  ])
})
