// RFC-019: parseSkillZipEntries — locks in wrapper detection, per-skill
// collection, dirname-as-name policy, and duplicate / invalid-name errors.

import { describe, expect, test } from 'bun:test'
import { parseSkillZipEntries, SKILL_ZIP_LIMITS, type ZipEntryRef } from '../src/skill-zip'

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function fileEntry(path: string, content: string | Uint8Array): ZipEntryRef {
  const bytes = typeof content === 'string' ? utf8(content) : content
  return { path, isDir: false, size: bytes.byteLength, bytes: () => bytes }
}

function dirEntry(path: string): ZipEntryRef {
  return { path, isDir: true, size: 0, bytes: () => new Uint8Array() }
}

const skillMd = (name: string, desc = 'desc') =>
  `---\nname: ${name}\ndescription: ${desc}\n---\nBody.\n`

describe('SKILL_ZIP_LIMITS (RFC-196)', () => {
  test('keeps the public safety limits stable', () => {
    expect(SKILL_ZIP_LIMITS).toEqual({
      totalBytes: 64 * 1024 * 1024,
      perFileBytes: 10 * 1024 * 1024,
      entries: 2000,
      depth: 12,
    })
  })
})

describe('parseSkillZipEntries', () => {
  test('shape A: top-level is skill dirs, two skills', () => {
    const entries: ZipEntryRef[] = [
      fileEntry('skill-foo/SKILL.md', skillMd('skill-foo', 'foo desc')),
      fileEntry('skill-foo/reference/notes.md', '# notes'),
      fileEntry('skill-bar/SKILL.md', skillMd('skill-bar', 'bar desc')),
    ]
    const r = parseSkillZipEntries(entries)
    expect(r.errors).toEqual([])
    expect(r.skills).toHaveLength(2)
    const foo = r.skills.find((s) => s.name === 'skill-foo')!
    expect(foo.description).toBe('foo desc')
    expect(foo.files.map((f) => f.relPath).sort()).toEqual(['SKILL.md', 'reference/notes.md'])
    const bar = r.skills.find((s) => s.name === 'skill-bar')!
    expect(bar.files.map((f) => f.relPath)).toEqual(['SKILL.md'])
  })

  test('shape B: wrapper dir gets peeled, three skills found', () => {
    const entries: ZipEntryRef[] = [
      dirEntry('pack/'),
      fileEntry('pack/skill-a/SKILL.md', skillMd('skill-a')),
      fileEntry('pack/skill-b/SKILL.md', skillMd('skill-b')),
      fileEntry('pack/skill-b/data.txt', 'x'),
      fileEntry('pack/skill-c/SKILL.md', skillMd('skill-c')),
    ]
    const r = parseSkillZipEntries(entries)
    expect(r.errors).toEqual([])
    expect(r.skills.map((s) => s.name).sort()).toEqual(['skill-a', 'skill-b', 'skill-c'])
  })

  test('shape B with single inner skill', () => {
    const entries: ZipEntryRef[] = [fileEntry('my-pack/only/SKILL.md', skillMd('only'))]
    const r = parseSkillZipEntries(entries)
    expect(r.errors).toEqual([])
    expect(r.skills.map((s) => s.name)).toEqual(['only'])
  })

  test('shape A with a single skill dir', () => {
    const entries: ZipEntryRef[] = [
      fileEntry('lone/SKILL.md', skillMd('lone')),
      fileEntry('lone/extra.md', '# extra'),
    ]
    const r = parseSkillZipEntries(entries)
    expect(r.errors).toEqual([])
    expect(r.skills.map((s) => s.name)).toEqual(['lone'])
  })

  test('top has one dir but SKILL.md is directly inside → treat as single skill (no wrapper peel)', () => {
    // Top level is `my-skill/`. `my-skill/SKILL.md` exists directly, so we
    // must treat `my-skill` as the skill itself, not a wrapper to peel away.
    const entries: ZipEntryRef[] = [
      fileEntry('my-skill/SKILL.md', skillMd('my-skill')),
      fileEntry('my-skill/reference/x.md', '# x'),
    ]
    const r = parseSkillZipEntries(entries)
    expect(r.errors).toEqual([])
    expect(r.skills).toHaveLength(1)
    expect(r.skills[0]!.name).toBe('my-skill')
  })

  test('SKILL.md missing in candidate → per-row error', () => {
    const entries: ZipEntryRef[] = [
      fileEntry('skill-ok/SKILL.md', skillMd('skill-ok')),
      fileEntry('skill-bad/notes.md', '# notes'),
    ]
    const r = parseSkillZipEntries(entries)
    expect(r.skills.map((s) => s.name)).toEqual(['skill-ok'])
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]!.code).toBe('skill-md-missing')
    expect(r.errors[0]!.path).toBe('skill-bad')
  })

  test('invalid kebab-case dir name → per-row error', () => {
    const entries: ZipEntryRef[] = [fileEntry('Skill_With_Caps/SKILL.md', skillMd('whatever'))]
    const r = parseSkillZipEntries(entries)
    // Capital letter triggers SKILL_NAME_RE failure; wrapper peel applies
    // because there's only one top-level segment and SKILL.md is nested
    // beneath it, but the actual single-skill case detection sees SKILL.md
    // directly inside the only dir so it stays unpeeled.
    expect(r.skills).toEqual([])
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]!.code).toBe('skill-name-invalid')
  })

  test('duplicate dir names (case-insensitive) inside zip → both errored', () => {
    const entries: ZipEntryRef[] = [
      fileEntry('Foo/SKILL.md', skillMd('foo')),
      fileEntry('foo/SKILL.md', skillMd('foo')),
    ]
    const r = parseSkillZipEntries(entries)
    expect(r.skills).toEqual([])
    expect(r.errors.every((e) => e.code === 'skill-name-duplicated-in-zip')).toBe(true)
    expect(r.errors).toHaveLength(2)
  })

  test('YAML failure inside SKILL.md → candidate kept with warning', () => {
    const entries: ZipEntryRef[] = [fileEntry('skill-y/SKILL.md', '---\n: : :\n---\nbody\n')]
    const r = parseSkillZipEntries(entries)
    expect(r.skills).toHaveLength(1)
    expect(r.skills[0]!.warnings.some((w) => w.includes('yaml-parse-failed'))).toBe(true)
  })

  test('frontmatter `name` differs from dirname → dirname wins, warning emitted', () => {
    const entries: ZipEntryRef[] = [
      fileEntry('actual-dir/SKILL.md', skillMd('different-name', 'd')),
    ]
    const r = parseSkillZipEntries(entries)
    expect(r.skills[0]!.name).toBe('actual-dir')
    expect(r.skills[0]!.warnings.some((w) => w.includes('different-name'))).toBe(true)
  })

  test('empty entries → no-skill-found', () => {
    const r = parseSkillZipEntries([])
    expect(r.skills).toEqual([])
    expect(r.errors).toEqual([
      { path: '', code: 'no-skill-found', message: 'zip contains no skill directory' },
    ])
  })

  test('only loose top-level files (no dirs) → no-skill-found via invalid name on file segment', () => {
    // A file `SKILL.md` directly at the root has top-segment 'SKILL.md',
    // which is not a valid kebab-case skill name → reported as invalid name.
    const entries: ZipEntryRef[] = [fileEntry('SKILL.md', '---\n---\n')]
    const r = parseSkillZipEntries(entries)
    expect(r.skills).toEqual([])
    expect(r.errors.some((e) => e.code === 'skill-name-invalid')).toBe(true)
  })

  test('nested subdirectories preserved in file slices', () => {
    const entries: ZipEntryRef[] = [
      fileEntry('skill-n/SKILL.md', skillMd('skill-n')),
      fileEntry('skill-n/ref/inner/a.md', '# a'),
      fileEntry('skill-n/ref/inner/deep/b.txt', 'b'),
    ]
    const r = parseSkillZipEntries(entries)
    expect(r.skills).toHaveLength(1)
    expect(r.skills[0]!.files.map((f) => f.relPath).sort()).toEqual([
      'SKILL.md',
      'ref/inner/a.md',
      'ref/inner/deep/b.txt',
    ])
  })

  test('binary file bytes preserved verbatim', () => {
    const bin = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    const entries: ZipEntryRef[] = [
      fileEntry('skill-bin/SKILL.md', skillMd('skill-bin')),
      fileEntry('skill-bin/logo.jpg', bin),
    ]
    const r = parseSkillZipEntries(entries)
    expect(r.skills).toHaveLength(1)
    const jpg = r.skills[0]!.files.find((f) => f.relPath === 'logo.jpg')!
    expect(Array.from(jpg.bytes)).toEqual(Array.from(bin))
  })

  test('totalBytes sums all file slices', () => {
    const md = '---\nname: skill-sz\n---\nhi'
    const mdBytes = new TextEncoder().encode(md).byteLength
    const entries: ZipEntryRef[] = [
      fileEntry('skill-sz/SKILL.md', md),
      fileEntry('skill-sz/extra.bin', new Uint8Array([1, 2, 3, 4, 5])),
    ]
    const r = parseSkillZipEntries(entries)
    expect(r.skills[0]!.totalBytes).toBe(mdBytes + 5)
  })
})
