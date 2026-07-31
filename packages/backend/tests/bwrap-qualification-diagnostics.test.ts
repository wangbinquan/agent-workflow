// 2026-07-31 — root-owned bwrap qualification must name the EXACT failing
// path level and invariant, not just a reason code.
//
// Why this exists: a GitHub runner image bump (ubuntu-22.04 20260726) flipped
// an ancestor directory of `bwrap` and `requireRootOwnedBwrap` started
// rejecting with a bare `provider-parent-unsafe`. That was indistinguishable
// from a code regression, and the double-image A/B took hours. The check is
// NOT loosened here — only its failure is made self-describing.

import { describe, expect, test } from 'bun:test'
import {
  describeBwrapFinding,
  requireRootOwnedBwrap,
  type RootOwnedBwrapPathDependencies,
  type RootOwnedBwrapQualificationError,
} from '../src/services/runtime/opencode/sealedSubprocess'

/** Minimal stat shape the qualifier consumes. */
function entry(input: {
  uid: number
  mode: number
  dir?: boolean
  file?: boolean
  symlink?: boolean
}) {
  return {
    uid: input.uid,
    mode: input.mode,
    isDirectory: () => input.dir === true,
    isFile: () => input.file === true,
    isSymbolicLink: () => input.symlink === true,
  }
}

/**
 * A synthetic filesystem: `/usr/bin/bwrap` root-owned 0755 with a chain that
 * is clean except where a test perturbs it.
 */
function pathDeps(overrides: Record<string, ReturnType<typeof entry>>) {
  const base: Record<string, ReturnType<typeof entry>> = {
    '/usr/bin/bwrap': entry({ uid: 0, mode: 0o755, file: true }),
    '/usr/bin': entry({ uid: 0, mode: 0o755, dir: true }),
    '/usr': entry({ uid: 0, mode: 0o755, dir: true }),
    '/': entry({ uid: 0, mode: 0o755, dir: true }),
  }
  const table = { ...base, ...overrides }
  const lookup = (path: string) => {
    const found = table[path]
    if (found === undefined) throw new Error(`unexpected stat: ${path}`)
    return found
  }
  return {
    realpath: async (path: string) => path,
    stat: async (path: string) => lookup(path) as never,
    lstat: async (path: string) => lookup(path) as never,
  } as unknown as RootOwnedBwrapPathDependencies
}

async function qualify(overrides: Record<string, ReturnType<typeof entry>>) {
  try {
    await requireRootOwnedBwrap('/usr/bin/bwrap', {
      pathMetadata: pathDeps(overrides),
      // Never reached in these tests: every case rejects during path proof.
      spawn: () => {
        throw new Error('spawn must not be attempted after a path rejection')
      },
    })
    return null
  } catch (error) {
    return error as RootOwnedBwrapQualificationError
  }
}

describe('requireRootOwnedBwrap path diagnostics', () => {
  test('a non-root ANCESTOR names that exact directory (the runner-image case)', async () => {
    const error = await qualify({ '/usr/bin': entry({ uid: 1000, mode: 0o755, dir: true }) })
    expect(error?.reason).toBe('provider-parent-unsafe')
    expect(error?.finding).toEqual({
      path: '/usr/bin',
      level: 'ancestor',
      uid: 1000,
      mode: '0755',
      symlink: false,
      violation: 'not-root-owned',
    })
    // The message an operator actually sees carries the level + numbers.
    expect(error?.message).toContain('/usr/bin')
    expect(error?.message).toContain('uid=1000')
    expect(error?.message).toContain('not-root-owned')
  })

  test('a group-writable ancestor is distinguished from a non-root one', async () => {
    const error = await qualify({ '/usr': entry({ uid: 0, mode: 0o775, dir: true }) })
    expect(error?.finding?.path).toBe('/usr')
    expect(error?.finding?.violation).toBe('group-or-other-writable')
    expect(error?.finding?.mode).toBe('0775')
  })

  test('binary-level violations report level=binary with their own invariant', async () => {
    const notRoot = await qualify({
      '/usr/bin/bwrap': entry({ uid: 1000, mode: 0o755, file: true }),
    })
    expect(notRoot?.reason).toBe('provider-owner-unsafe')
    expect(notRoot?.finding).toMatchObject({ level: 'binary', violation: 'not-root-owned' })

    const worldWritable = await qualify({
      '/usr/bin/bwrap': entry({ uid: 0, mode: 0o757, file: true }),
    })
    expect(worldWritable?.reason).toBe('provider-mode-unsafe')
    expect(worldWritable?.finding).toMatchObject({
      level: 'binary',
      violation: 'group-or-other-writable',
      mode: '0757',
    })
  })

  test('the qualification itself is NOT loosened: a clean chain reaches the spawn stage', async () => {
    // Reaching the spawn seam proves the whole path proof passed. A spawn-stage
    // failure is still a qualification error (by design — the capability trial
    // is part of the proof), so the discriminator is the seam being CALLED and
    // the error carrying NO path finding.
    let spawned = false
    const error = await requireRootOwnedBwrap('/usr/bin/bwrap', {
      pathMetadata: pathDeps({}),
      spawn: () => {
        spawned = true
        throw new Error('sentinel: reached spawn')
      },
    }).then(
      () => null,
      (thrown: unknown) => thrown as RootOwnedBwrapQualificationError,
    )
    expect(spawned).toBe(true)
    expect(error?.finding).toBeUndefined()
    expect(error?.reason).not.toBe('provider-parent-unsafe')
    expect(error?.reason).not.toBe('provider-owner-unsafe')
    expect(error?.reason).not.toBe('provider-mode-unsafe')
  })

  test('describeBwrapFinding renders one non-secret line', () => {
    expect(
      describeBwrapFinding({
        path: '/opt',
        level: 'ancestor',
        uid: 1000,
        mode: '0777',
        symlink: false,
        violation: 'group-or-other-writable',
      }),
    ).toBe('ancestor /opt: group-or-other-writable; uid=1000 mode=0777')
  })
})
