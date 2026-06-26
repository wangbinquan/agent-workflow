// RFC-020: applyUploadsToWorktree and its helpers — pure-ish I/O with no DB.
// We point it at a temp directory standing in for a task worktree and assert
// (a) happy multi-file write, (b) filename sanitization, (c) the various
// limit/accept rejection paths, (d) mid-flight rollback on write failure.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  acceptMatches,
  applyUploadsToWorktree,
  assertInsideWorktree,
  DEFAULT_UPLOAD_LIMITS,
  resolveUniqueName,
  sanitizeFilename,
  sniffMime,
  type UploadFile,
  type UploadInputDef,
  type UploadPlan,
} from '../src/services/upload'
import { ValidationError } from '../src/util/errors'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'upload-test-'))
})
afterEach(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

function makeDefs(...defs: UploadInputDef[]): Map<string, UploadInputDef> {
  const m = new Map<string, UploadInputDef>()
  for (const d of defs) m.set(d.key, d)
  return m
}

function fileOf(inputKey: string, filename: string, body: string | Uint8Array): UploadFile {
  return {
    inputKey,
    filename,
    declaredMime: 'application/octet-stream',
    bytes: typeof body === 'string' ? new TextEncoder().encode(body) : body,
  }
}

const TXT_BYTES = new TextEncoder().encode('hello world')
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a])
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])

describe('sanitizeFilename', () => {
  test('strips path separators and leading dots', () => {
    expect(sanitizeFilename('../etc/passwd')).toBe('etcpasswd')
    expect(sanitizeFilename('..')).toBe('upload-0.bin')
    expect(sanitizeFilename('foo\\bar.txt')).toBe('foobar.txt')
  })
  test('empty / control-only → fallback name with index', () => {
    expect(sanitizeFilename('', 7)).toBe('upload-7.bin')
    expect(sanitizeFilename('\x00\x01\x1f\x7f', 3)).toBe('upload-3.bin')
  })
  // Regression: bun parses a multipart part whose Content-Disposition carries
  // `filename=""` as a File whose `.name` is `undefined` (not ''), so the route
  // can hand us a non-string raw. Before the fix this hit `raw.replace(...)` and
  // crashed with "undefined is not an object (evaluating 'e.replace')", surfacing
  // as "failed to land uploads into worktree". Defense-in-depth: coerce to fallback.
  test('non-string / undefined raw → fallback name (no .replace crash)', () => {
    expect(sanitizeFilename(undefined as unknown as string, 4)).toBe('upload-4.bin')
    expect(sanitizeFilename(null as unknown as string, 2)).toBe('upload-2.bin')
  })
  test('preserves CJK and spaces', () => {
    expect(sanitizeFilename('  报告 v1.pdf  ')).toBe('报告 v1.pdf')
  })
})

describe('resolveUniqueName', () => {
  test('returns same name when no collision', () => {
    const d = mkdtempSync(join(tmpdir(), 'uniq-'))
    expect(resolveUniqueName(d, 'report.pdf')).toBe('report.pdf')
    rmSync(d, { recursive: true, force: true })
  })
  test('inserts " (1)" then " (2)" suffix', () => {
    const d = mkdtempSync(join(tmpdir(), 'uniq-'))
    writeFileSync(join(d, 'report.pdf'), 'x')
    expect(resolveUniqueName(d, 'report.pdf')).toBe('report (1).pdf')
    writeFileSync(join(d, 'report (1).pdf'), 'x')
    expect(resolveUniqueName(d, 'report.pdf')).toBe('report (2).pdf')
    rmSync(d, { recursive: true, force: true })
  })
})

describe('assertInsideWorktree', () => {
  test('relative path under root is OK', () => {
    expect(assertInsideWorktree('/work', 'inputs/refs')).toBe(resolve('/work/inputs/refs'))
  })
  test('absolute child path is rejected', () => {
    expect(() => assertInsideWorktree('/work', '/etc')).toThrow(ValidationError)
  })
  test('".." traversal is rejected', () => {
    expect(() => assertInsideWorktree('/work', '../outside')).toThrow(ValidationError)
  })
})

describe('sniffMime', () => {
  test('detects PDF / PNG / text', () => {
    expect(sniffMime(PDF_BYTES)).toBe('application/pdf')
    expect(sniffMime(PNG_BYTES)).toBe('image/png')
    expect(sniffMime(TXT_BYTES)).toBe('text/plain')
  })
  test('binary blob → empty', () => {
    expect(sniffMime(new Uint8Array([0xde, 0xad, 0x00, 0xbe, 0xef]))).toBe('')
  })
  test('empty bytes → empty', () => {
    expect(sniffMime(new Uint8Array())).toBe('')
  })
})

describe('acceptMatches', () => {
  test('undefined / empty accept → always matches', () => {
    expect(acceptMatches(undefined, 'foo.bin', '')).toBe(true)
    expect(acceptMatches([], 'foo.bin', '')).toBe(true)
  })
  test('extension token matches case-insensitively', () => {
    expect(acceptMatches(['.PDF'], 'Report.pdf', '')).toBe(true)
    expect(acceptMatches(['.pdf'], 'Report.txt', '')).toBe(false)
  })
  test('image/* matches any image mime', () => {
    expect(acceptMatches(['image/*'], 'a.png', 'image/png')).toBe(true)
    expect(acceptMatches(['image/*'], 'a.png', 'application/pdf')).toBe(false)
  })
  test('exact mime', () => {
    expect(acceptMatches(['text/plain'], 'a.txt', 'text/plain')).toBe(true)
  })
})

describe('applyUploadsToWorktree', () => {
  function plan(defs: UploadInputDef[], files: UploadFile[]): UploadPlan {
    return {
      worktreePath: root,
      defs: makeDefs(...defs),
      files,
      limits: DEFAULT_UPLOAD_LIMITS,
    }
  }

  test('happy path: 3 files into nested targetDir, packed paths returned', async () => {
    const out = await applyUploadsToWorktree(
      plan(
        [{ key: 'refs', targetDir: 'inputs/refs' }],
        [
          fileOf('refs', 'a.txt', TXT_BYTES),
          fileOf('refs', 'b.txt', TXT_BYTES),
          fileOf('refs', 'c.txt', TXT_BYTES),
        ],
      ),
    )
    expect(out.packedByKey.get('refs')).toEqual([
      'inputs/refs/a.txt',
      'inputs/refs/b.txt',
      'inputs/refs/c.txt',
    ])
    expect(existsSync(join(root, 'inputs/refs/a.txt'))).toBe(true)
    expect(readFileSync(join(root, 'inputs/refs/b.txt'), 'utf8')).toBe('hello world')
  })

  test('renames on collision with " (1)" suffix', async () => {
    mkdirSync(join(root, 'inputs'), { recursive: true })
    writeFileSync(join(root, 'inputs/report.pdf'), 'preexisting')
    const out = await applyUploadsToWorktree(
      plan([{ key: 'refs', targetDir: 'inputs' }], [fileOf('refs', 'report.pdf', PDF_BYTES)]),
    )
    expect(out.packedByKey.get('refs')).toEqual(['inputs/report (1).pdf'])
    // Original untouched.
    expect(readFileSync(join(root, 'inputs/report.pdf'), 'utf8')).toBe('preexisting')
  })

  test('strips ".." segments from filename so traversal is impossible', async () => {
    const out = await applyUploadsToWorktree(
      plan([{ key: 'refs', targetDir: 'inputs' }], [fileOf('refs', '../../passwd', TXT_BYTES)]),
    )
    expect(out.packedByKey.get('refs')).toEqual(['inputs/passwd'])
    expect(existsSync(join(root, 'inputs/passwd'))).toBe(true)
  })

  test('accept whitelist rejects mismatched MIME', async () => {
    await expect(
      applyUploadsToWorktree(
        plan(
          [{ key: 'refs', targetDir: 'inputs', accept: ['.pdf'] }],
          [fileOf('refs', 'note.txt', TXT_BYTES)],
        ),
      ),
    ).rejects.toThrow(ValidationError)
    expect(existsSync(join(root, 'inputs/note.txt'))).toBe(false)
  })

  test('per-file size cap is enforced', async () => {
    const big = new Uint8Array(11)
    await expect(
      applyUploadsToWorktree({
        worktreePath: root,
        defs: makeDefs({ key: 'refs', targetDir: 'inputs' }),
        files: [fileOf('refs', 'big.bin', big)],
        limits: { perFile: 5, perRequest: 100, perCount: 10 },
      }),
    ).rejects.toThrow(ValidationError)
    expect(existsSync(join(root, 'inputs/big.bin'))).toBe(false)
  })

  test('per-request total cap is enforced', async () => {
    await expect(
      applyUploadsToWorktree({
        worktreePath: root,
        defs: makeDefs({ key: 'refs', targetDir: 'inputs' }),
        files: [
          fileOf('refs', 'a.bin', new Uint8Array(60)),
          fileOf('refs', 'b.bin', new Uint8Array(60)),
        ],
        limits: { perFile: 1000, perRequest: 100, perCount: 10 },
      }),
    ).rejects.toThrow(ValidationError)
  })

  test('per-count cap is enforced', async () => {
    await expect(
      applyUploadsToWorktree({
        worktreePath: root,
        defs: makeDefs({ key: 'refs', targetDir: 'inputs' }),
        files: Array.from({ length: 3 }, (_, i) => fileOf('refs', `f${i}.txt`, TXT_BYTES)),
        limits: { perFile: 1000, perRequest: 10000, perCount: 2 },
      }),
    ).rejects.toThrow(ValidationError)
  })

  test('unknown inputKey rejected', async () => {
    await expect(
      applyUploadsToWorktree(
        plan([{ key: 'refs', targetDir: 'inputs' }], [fileOf('other', 'x.txt', TXT_BYTES)]),
      ),
    ).rejects.toThrow(ValidationError)
  })

  test('minCount under-supplied → reject', async () => {
    await expect(
      applyUploadsToWorktree(
        plan(
          [{ key: 'refs', targetDir: 'inputs', minCount: 2 }],
          [fileOf('refs', 'a.txt', TXT_BYTES)],
        ),
      ),
    ).rejects.toThrow(ValidationError)
  })

  test('maxCount over-supplied → reject', async () => {
    await expect(
      applyUploadsToWorktree(
        plan(
          [{ key: 'refs', targetDir: 'inputs', maxCount: 1 }],
          [fileOf('refs', 'a.txt', TXT_BYTES), fileOf('refs', 'b.txt', TXT_BYTES)],
        ),
      ),
    ).rejects.toThrow(ValidationError)
  })

  test('undefined filename (empty filename="" multipart part) lands as fallback name', async () => {
    const ghost: UploadFile = {
      inputKey: 'refs',
      filename: undefined as unknown as string,
      declaredMime: 'application/octet-stream',
      bytes: TXT_BYTES,
    }
    const out = await applyUploadsToWorktree(plan([{ key: 'refs', targetDir: 'inputs' }], [ghost]))
    expect(out.packedByKey.get('refs')).toEqual(['inputs/upload-1.bin'])
    expect(existsSync(join(root, 'inputs/upload-1.bin'))).toBe(true)
  })

  test('"." targetDir lands at worktree root and packed path has no prefix', async () => {
    const out = await applyUploadsToWorktree(
      plan([{ key: 'refs', targetDir: '.' }], [fileOf('refs', 'a.txt', TXT_BYTES)]),
    )
    expect(out.packedByKey.get('refs')).toEqual(['a.txt'])
    expect(existsSync(join(root, 'a.txt'))).toBe(true)
  })
})
