// RFC-019: backend decodeZip safety + happy-path coverage.
// Builds real zips with fflate.zipSync so the limits / zip-slip checks see
// realistic byte streams (no hand-crafted entries that skip the decoder).

import { describe, expect, test } from 'bun:test'
import { zipSync, type Zippable } from 'fflate'
import { SKILL_ZIP_LIMITS } from '@agent-workflow/shared'
import { decodeZip, ZIP_LIMITS } from '../src/services/skill-zip'
import { ValidationError } from '../src/util/errors'

function makeZip(files: Record<string, Uint8Array | string>): Uint8Array {
  const z: Zippable = {}
  for (const [k, v] of Object.entries(files)) {
    z[k] = typeof v === 'string' ? new TextEncoder().encode(v) : v
  }
  return zipSync(z)
}

describe('decodeZip', () => {
  test('uses the shared RFC-196 limits object without a backend copy', () => {
    expect(ZIP_LIMITS).toBe(SKILL_ZIP_LIMITS)
  })

  test('happy path: two files yields two entries', () => {
    const buf = makeZip({
      'skill-a/SKILL.md': '---\nname: skill-a\n---\nbody\n',
      'skill-a/reference/notes.md': '# notes\n',
    })
    const entries = decodeZip(buf)
    expect(entries.map((e) => e.path).sort()).toEqual([
      'skill-a/SKILL.md',
      'skill-a/reference/notes.md',
    ])
    expect(entries.every((e) => !e.isDir)).toBe(true)
    const skill = entries.find((e) => e.path === 'skill-a/SKILL.md')!
    expect(new TextDecoder().decode(skill.bytes())).toContain('name: skill-a')
  })

  test('directory entries are reported as isDir=true with trailing slash stripped', () => {
    // fflate represents pure dir entries when the key ends with `/`.
    const buf = zipSync({
      'pack/': new Uint8Array(),
      'pack/SKILL.md': new TextEncoder().encode('hi'),
    })
    const entries = decodeZip(buf)
    const pack = entries.find((e) => e.path === 'pack')
    expect(pack).toBeDefined()
    expect(pack!.isDir).toBe(true)
  })

  test('zip with absolute path is rejected', () => {
    const buf = zipSync({ '/etc/evil': new TextEncoder().encode('x') })
    expect(() => decodeZip(buf)).toThrow(ValidationError)
    try {
      decodeZip(buf)
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError)
      expect((err as ValidationError).code).toBe('zip-traversal')
    }
  })

  test('zip with `..` segment is rejected', () => {
    const buf = zipSync({ '../escape.txt': new TextEncoder().encode('x') })
    expect(() => decodeZip(buf)).toThrow(ValidationError)
    try {
      decodeZip(buf)
    } catch (err) {
      expect((err as ValidationError).code).toBe('zip-traversal')
    }
  })

  test('single oversized file is rejected with zip-limit-exceeded', () => {
    const big = new Uint8Array(ZIP_LIMITS.perFileBytes + 1)
    big.fill(0x61)
    const buf = zipSync({ 'skill/big.bin': big })
    expect(() => decodeZip(buf)).toThrow(ValidationError)
    try {
      decodeZip(buf)
    } catch (err) {
      expect((err as ValidationError).code).toBe('zip-limit-exceeded')
    }
  })

  test('too many entries is rejected', () => {
    const z: Zippable = {}
    for (let i = 0; i <= ZIP_LIMITS.entries; i++) {
      z[`skill-x/file-${i}.txt`] = new TextEncoder().encode('x')
    }
    const buf = zipSync(z)
    expect(() => decodeZip(buf)).toThrow(ValidationError)
    try {
      decodeZip(buf)
    } catch (err) {
      expect((err as ValidationError).code).toBe('zip-limit-exceeded')
    }
  })

  test('too-deep path is rejected', () => {
    const deep = 'a/'.repeat(ZIP_LIMITS.depth + 1) + 'SKILL.md'
    const buf = zipSync({ [deep]: new TextEncoder().encode('hi') })
    expect(() => decodeZip(buf)).toThrow(ValidationError)
    try {
      decodeZip(buf)
    } catch (err) {
      expect((err as ValidationError).code).toBe('zip-limit-exceeded')
    }
  })

  test('garbage bytes → zip-decode-failed', () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(() => decodeZip(garbage)).toThrow(ValidationError)
    try {
      decodeZip(garbage)
    } catch (err) {
      expect((err as ValidationError).code).toBe('zip-decode-failed')
    }
  })

  test('backslash paths are normalised to forward slashes', () => {
    // Manually construct an entry whose key uses backslashes; fflate accepts
    // any string as a key so this exercises our normalisation step.
    const buf = zipSync({ 'skill-w\\inner\\SKILL.md': new TextEncoder().encode('hi') })
    const entries = decodeZip(buf)
    expect(entries[0]!.path).toBe('skill-w/inner/SKILL.md')
  })

  test('whole-zip too large (header check) rejected without decoding', () => {
    const sentinel = new Uint8Array(ZIP_LIMITS.totalBytes + 1)
    // Don't bother making it a real zip — the length pre-check fires first.
    expect(() => decodeZip(sentinel)).toThrow(ValidationError)
    try {
      decodeZip(sentinel)
    } catch (err) {
      expect((err as ValidationError).code).toBe('zip-limit-exceeded')
    }
  })

  test('binary payload bytes survive decode unchanged', () => {
    const bin = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    const buf = zipSync({ 'skill-bin/logo.jpg': bin })
    const entries = decodeZip(buf)
    expect(Array.from(entries[0]!.bytes())).toEqual(Array.from(bin))
  })
})
