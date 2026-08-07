// RFC-262 — upload 文件名净化 + 落点判重的纯函数面。
//
// 这套函数是**前后端唯一事实源**：启动表单在提交前用它拦同名文件，daemon 收到
// multipart 后用同一套算落点。两边一旦分叉，UI 会放行一个服务端必然 422 的启动
// （或更糟：覆盖模式下静默丢文件）。因此本文件同时锁住：
//   1. `sanitizeUploadFilename` 自 backend/services/upload.ts 迁入后逐条等价
//      （原 4 条断言原样搬来，任何改动都必须先让这里变红）；
//   2. 判重规则的四条判据——跨 input key 全局判重（RFC-262 D4）、大小写折叠
//      （D6 / 能力影响清单 C2 方案 A，用户拍板）、targetDir 规范化后再比、
//      空文件名的 fallback 编号不得互撞。

import { describe, expect, test } from 'bun:test'
import {
  findDuplicateUploadTarget,
  normalizeUploadDir,
  sanitizeUploadFilename,
  uploadLandingKey,
  UploadInputSchema,
  UPLOAD_ON_CONFLICT,
} from '../src/index'

describe('sanitizeUploadFilename（自 backend 迁入，逐条等价）', () => {
  test('strips path separators and leading dots', () => {
    expect(sanitizeUploadFilename('../etc/passwd')).toBe('etcpasswd')
    expect(sanitizeUploadFilename('..')).toBe('upload-0.bin')
    expect(sanitizeUploadFilename('foo\\bar.txt')).toBe('foobar.txt')
  })
  test('empty / control-only → fallback name with index', () => {
    expect(sanitizeUploadFilename('', 7)).toBe('upload-7.bin')
    expect(sanitizeUploadFilename('\x00\x01\x1f\x7f', 3)).toBe('upload-3.bin')
  })
  test('non-string / undefined raw → fallback name (no .replace crash)', () => {
    expect(sanitizeUploadFilename(undefined as unknown as string, 4)).toBe('upload-4.bin')
    expect(sanitizeUploadFilename(null as unknown as string, 2)).toBe('upload-2.bin')
  })
  test('preserves CJK and spaces', () => {
    expect(sanitizeUploadFilename('  报告 v1.pdf  ')).toBe('报告 v1.pdf')
  })
})

describe('normalizeUploadDir', () => {
  test('"." 与空串都归一为仓库根', () => {
    expect(normalizeUploadDir('.')).toBe('')
    expect(normalizeUploadDir('')).toBe('')
    expect(normalizeUploadDir('./')).toBe('')
  })
  test('折叠重复分隔符、去尾斜杠、反斜杠归一', () => {
    expect(normalizeUploadDir('a//b')).toBe('a/b')
    expect(normalizeUploadDir('a/b/')).toBe('a/b')
    expect(normalizeUploadDir('a\\b')).toBe('a/b')
    expect(normalizeUploadDir('./a/./b')).toBe('a/b')
  })
  test('非字符串输入不炸', () => {
    expect(normalizeUploadDir(undefined as unknown as string)).toBe('')
  })
})

describe('uploadLandingKey', () => {
  test('目录 + 折叠大小写的净化名', () => {
    expect(uploadLandingKey('inputs/refs', 'Report.PDF')).toBe('inputs/refs/report.pdf')
    expect(uploadLandingKey('.', 'a.txt')).toBe('a.txt')
  })
  test('净化规则参与 key（分隔符被剥掉后才比较）', () => {
    expect(uploadLandingKey('inputs', '../x.txt')).toBe('inputs/x.txt')
  })
})

describe('findDuplicateUploadTarget', () => {
  function e(inputKey: string, filename: string, targetDir: string, fallbackIndex = 1) {
    return { inputKey, filename, targetDir, fallbackIndex }
  }

  test('无重复 → null', () => {
    expect(
      findDuplicateUploadTarget([e('refs', 'a.txt', 'inputs'), e('refs', 'b.txt', 'inputs')]),
    ).toBeNull()
  })

  test('同一 input 内同名 → 命中，并回带两侧的 key/文件名', () => {
    const dup = findDuplicateUploadTarget([
      e('refs', 'report.pdf', 'inputs', 1),
      e('refs', 'report.pdf', 'inputs', 2),
    ])
    expect(dup).not.toBeNull()
    expect(dup?.key).toBe('inputs/report.pdf')
    expect(dup?.first.inputKey).toBe('refs')
    expect(dup?.second.filename).toBe('report.pdf')
  })

  // AC-7：两个不同的 upload 输入配了同一个 targetDir，各上传一个同名文件——
  // 落点完全一样，覆盖模式下同样静默丢一份，必须与同 input 同名等价处理。
  test('跨 input key 同落点同名 → 命中（全局判重，非按 key 分组）', () => {
    const dup = findDuplicateUploadTarget([
      e('spec', 'api.yaml', 'contracts', 1),
      e('extra', 'api.yaml', 'contracts', 2),
    ])
    expect(dup).not.toBeNull()
    expect(dup?.first.inputKey).toBe('spec')
    expect(dup?.second.inputKey).toBe('extra')
  })

  test('同名但 targetDir 不同 → 不命中', () => {
    expect(
      findDuplicateUploadTarget([
        e('a', 'report.pdf', 'inputs/one', 1),
        e('b', 'report.pdf', 'inputs/two', 2),
      ]),
    ).toBeNull()
  })

  test('targetDir 写法不同但落点相同 → 仍命中（先规范化再比）', () => {
    const dup = findDuplicateUploadTarget([
      e('a', 'report.pdf', 'inputs/refs', 1),
      e('b', 'report.pdf', 'inputs//refs/', 2),
    ])
    expect(dup?.key).toBe('inputs/refs/report.pdf')
  })

  // RFC-262 D6 / 能力影响清单 C2 方案 A（用户拍板）：macOS / Windows 文件系统
  // 大小写不敏感，这俩在那里就是同一个文件；折叠后判定跨平台一致。改判本条前
  // 必须先改 proposal §6 C2。
  test('仅大小写不同 → 命中（判重大小写折叠）', () => {
    const dup = findDuplicateUploadTarget([
      e('refs', 'Report.pdf', 'inputs', 1),
      e('refs', 'report.pdf', 'inputs', 2),
    ])
    expect(dup).not.toBeNull()
    expect(dup?.second.filename).toBe('report.pdf')
  })

  test('targetDir 仅大小写不同 → 命中（大小写不敏感 FS 上是同一个目录）', () => {
    const dup = findDuplicateUploadTarget([
      e('a', 'report.pdf', 'Docs', 1),
      e('b', 'report.pdf', 'docs', 2),
    ])
    expect(dup?.key).toBe('docs/report.pdf')
  })

  test('两个空文件名 + 不同 fallbackIndex → 不命中（各自 upload-N.bin）', () => {
    expect(
      findDuplicateUploadTarget([e('refs', '', 'inputs', 1), e('refs', '', 'inputs', 2)]),
    ).toBeNull()
  })

  test('净化后才撞名的两个原始名 → 命中', () => {
    const dup = findDuplicateUploadTarget([
      e('refs', 'x.txt', 'inputs', 1),
      e('refs', '../x.txt', 'inputs', 2),
    ])
    expect(dup?.key).toBe('inputs/x.txt')
  })
})

describe('UploadInputSchema.onConflict（RFC-262 写面）', () => {
  const base = { kind: 'upload' as const, key: 'refs', label: 'Refs', targetDir: 'inputs' }

  test('枚举只有 rename / overwrite 两值', () => {
    expect([...UPLOAD_ON_CONFLICT]).toEqual(['rename', 'overwrite'])
  })
  test('缺省（不写该字段）通过——存量定义原样往返', () => {
    expect(UploadInputSchema.safeParse(base).success).toBe(true)
  })
  test('两个合法值都通过', () => {
    expect(UploadInputSchema.safeParse({ ...base, onConflict: 'rename' }).success).toBe(true)
    expect(UploadInputSchema.safeParse({ ...base, onConflict: 'overwrite' }).success).toBe(true)
  })
  test('非法值被拒（写面 strict）', () => {
    expect(UploadInputSchema.safeParse({ ...base, onConflict: 'replace' }).success).toBe(false)
    expect(UploadInputSchema.safeParse({ ...base, onConflict: true }).success).toBe(false)
  })
})
