import { rimrafDir } from './helpers/cleanup'
// Locks RFC-017 §2.1 #1 — discoverSkillsInDir only walks direct child dirs,
// requires SKILL.md, name must match SKILL_NAME_RE; deeper directories,
// non-skill folders, name-violating dirs and frontmatter-parse failures
// surface in `skipped` with the right reason. Red here = scan rules drifted.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverSkillsInDir } from '../src/services/skill-source'

let parent: string

const skillMd = (name: string, description = '') =>
  `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'aw-source-discover-'))
})
afterEach(() => {
  rimrafDir(parent)
})

describe('discoverSkillsInDir', () => {
  test('direct child with SKILL.md becomes a candidate', () => {
    mkdirSync(join(parent, 'code-reviewer'), { recursive: true })
    writeFileSync(
      join(parent, 'code-reviewer', 'SKILL.md'),
      skillMd('code-reviewer', 'reviews code'),
    )

    const { candidates, skipped } = discoverSkillsInDir(parent)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      name: 'code-reviewer',
      description: 'reviews code',
    })
    expect(candidates[0]!.absPath).toBe(join(parent, 'code-reviewer'))
    expect(skipped).toEqual([])
  })

  test('subdirectory without SKILL.md is skipped (no-skill-md)', () => {
    mkdirSync(join(parent, 'orphan-folder'), { recursive: true })
    writeFileSync(join(parent, 'orphan-folder', 'README.md'), '# nothing here')

    const { candidates, skipped } = discoverSkillsInDir(parent)
    expect(candidates).toEqual([])
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toMatchObject({ proposedName: 'orphan-folder', reason: 'no-skill-md' })
  })

  test('uppercase / space subdir name is skipped (invalid-name)', () => {
    mkdirSync(join(parent, 'BadName'), { recursive: true })
    writeFileSync(join(parent, 'BadName', 'SKILL.md'), skillMd('BadName'))
    mkdirSync(join(parent, 'has space'), { recursive: true })
    writeFileSync(join(parent, 'has space', 'SKILL.md'), skillMd('has space'))

    const { candidates, skipped } = discoverSkillsInDir(parent)
    expect(candidates).toEqual([])
    const names = skipped.map((s) => s.proposedName).sort()
    expect(names).toEqual(['BadName', 'has space'])
    for (const s of skipped) expect(s.reason).toBe('invalid-name')
  })

  test('top-level files are ignored (not directories)', () => {
    writeFileSync(join(parent, 'NOTES.md'), '# random file')
    writeFileSync(join(parent, '.DS_Store'), '')

    const { candidates, skipped } = discoverSkillsInDir(parent)
    expect(candidates).toEqual([])
    expect(skipped).toEqual([])
  })

  test('nested grandchild SKILL.md is NOT picked up', () => {
    // parent/group-a/inner-skill/SKILL.md  → group-a has no SKILL.md → skipped
    mkdirSync(join(parent, 'group-a', 'inner-skill'), { recursive: true })
    writeFileSync(join(parent, 'group-a', 'inner-skill', 'SKILL.md'), skillMd('inner-skill'))

    const { candidates, skipped } = discoverSkillsInDir(parent)
    expect(candidates).toEqual([])
    expect(skipped).toEqual([
      { childPath: join(parent, 'group-a'), proposedName: 'group-a', reason: 'no-skill-md' },
    ])
  })

  test('SKILL.md unreadable is reported (frontmatter-parse-failed)', () => {
    // Defensive: when SKILL.md happens to exist but readFileSync throws
    // (here: it's a directory, so EISDIR), the candidate is bumped into the
    // skipped report instead of crashing the scan.
    mkdirSync(join(parent, 'broken', 'SKILL.md'), { recursive: true })

    const { candidates, skipped } = discoverSkillsInDir(parent)
    expect(candidates).toEqual([])
    expect(skipped).toHaveLength(1)
    expect(skipped[0]!.reason).toBe('frontmatter-parse-failed')
    expect(skipped[0]!.proposedName).toBe('broken')
  })
})
