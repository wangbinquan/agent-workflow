// RFC-284 T6（2026-08-12 审计 N20 / 设计门双路 P2）——containment「lexical+realpath
// 双查」三副本的**四象限行为快照锁**。
//
// 三副本（envelope.NODE_VALIDATE_IO.resolveWorktreePath / portArtifacts.readInsideRoot
// / portArtifacts.existsInsideRoot）是真·四象限不同判：envelope 对不存在目标回退
// 词法放行（存在性由 handler 另报、喂 followup），并在 RFC-193 绝对路径同位证明
// 分支重写 targetAbs/relativePath；portArtifacts 两份对 resolve 失败一律拒、且
// 接受绝对路径存量行。**迁移到共享骨架（util/safePath.checkLexicalThenRealpath）
// 前先用本文件把每个象限的现行为拍死；迁移后逐条同判，任何一条变红 = 迁移改了
// 安全语义，打回。** 这是设计门明令「不能统一语义、只共享骨架」的执行锁。

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  realpathSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NODE_VALIDATE_IO } from '../src/services/envelope'
import { existsInsideRoot, readInsideRoot } from '../src/services/portArtifacts'

let base: string
let root: string // 词法根（可能带 /var → /private/var 之类的未解析前缀）
let rootLink: string // 指向 root 的 symlink（RFC-193 前缀差异模拟）
let outside: string
let realRoot: string

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'aw-rfc284-quad-'))
  root = join(base, 'root')
  outside = join(base, 'outside')
  rootLink = join(base, 'rootlink')
  mkdirSync(join(root, 'sub'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(root, 'file.txt'), 'hello')
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  symlinkSync(join(outside, 'secret.txt'), join(root, 'link-out'))
  symlinkSync(join(root, 'file.txt'), join(root, 'link-in'))
  symlinkSync(root, rootLink)
  realRoot = realpathSync(root)
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('RFC-284 T6 — envelope.resolveWorktreePath quadrants', () => {
  const r = (worktree: string, raw: string) => NODE_VALIDATE_IO.resolveWorktreePath(worktree, raw)

  test('e1 相对·存在 → inside，portable 相对路径', () => {
    const v = r(root, 'file.txt')
    expect(v.insideWorktree).toBe(true)
    expect(v.relativePath).toBe('file.txt')
  })

  test('e2 相对·不存在 → **词法回退放行**（与 portArtifacts 的关键分歧）', () => {
    const v = r(root, 'missing.txt')
    expect(v.insideWorktree).toBe(true)
    expect(v.relativePath).toBe('missing.txt')
  })

  test('e3 相对·根内 symlink 指向根外 → realpath 收紧拒绝', () => {
    expect(r(root, 'link-out').insideWorktree).toBe(false)
  })

  test('e4 相对·根内 symlink 指向根内 → 放行，且 targetAbs 保持词法形不重写', () => {
    const v = r(root, 'link-in')
    expect(v.insideWorktree).toBe(true)
    // 词法内分支只收紧判定、不重写 targetAbs（重写只发生在 e7 的 RFC-193 分支）。
    expect(v.targetAbs).toBe(join(root, 'link-in'))
  })

  test('e5 相对·../ 逃逸 → 拒绝', () => {
    expect(r(root, '../outside/secret.txt').insideWorktree).toBe(false)
  })

  test('e6 绝对·真根外 → 拒绝', () => {
    expect(r(root, join(outside, 'secret.txt')).insideWorktree).toBe(false)
  })

  test('e7 绝对·RFC-193 前缀差异同位证明 → 翻转放行 + targetAbs/relativePath 重写为 real 形', () => {
    const v = r(rootLink, join(realRoot, 'file.txt'))
    expect(v.insideWorktree).toBe(true)
    expect(v.relativePath).toBe('file.txt')
    expect(v.targetAbs).toBe(join(realRoot, 'file.txt'))
  })

  test('e8 绝对·词法根外且不可解析 → 保持词法拒绝', () => {
    expect(r(rootLink, join(realRoot, 'missing.txt')).insideWorktree).toBe(false)
  })

  test('e9 绝对·词法根内存在 → 放行', () => {
    const v = r(root, join(root, 'file.txt'))
    expect(v.insideWorktree).toBe(true)
    expect(v.relativePath).toBe('file.txt')
  })
})

describe('RFC-284 T6 — portArtifacts.readInsideRoot quadrants', () => {
  test('r1 相对·存在 → 读到字节', () => {
    expect(readInsideRoot(root, 'file.txt')?.toString()).toBe('hello')
  })

  test('r2 相对·不存在 → **null 拒绝**（与 envelope e2 的关键分歧）', () => {
    expect(readInsideRoot(root, 'missing.txt')).toBeNull()
  })

  test('r3 相对·symlink 指向根外 → null', () => {
    expect(readInsideRoot(root, 'link-out')).toBeNull()
  })

  test('r4 相对·../ 逃逸 → null', () => {
    expect(readInsideRoot(root, '../outside/secret.txt')).toBeNull()
  })

  test('r5 绝对·根内存量行形态 → 读到（绝对输入不直接拒）', () => {
    expect(readInsideRoot(root, join(root, 'file.txt'))?.toString()).toBe('hello')
  })

  test('r6 绝对·根外 → null', () => {
    expect(readInsideRoot(root, join(outside, 'secret.txt'))).toBeNull()
  })

  test('r7 绝对·前缀差异同位证明 → 读到（与 envelope RFC-193 同构）', () => {
    expect(readInsideRoot(rootLink, join(realRoot, 'file.txt'))?.toString()).toBe('hello')
  })

  test('r8 相对·symlink 指向根内 → 读到', () => {
    expect(readInsideRoot(root, 'link-in')?.toString()).toBe('hello')
  })
})

describe('RFC-284 T6 — portArtifacts.existsInsideRoot quadrants', () => {
  test('x1-x8 与 readInsideRoot 同判 + 目录目标为 false（isFile 面）', () => {
    expect(existsInsideRoot(root, 'file.txt')).toBe(true)
    expect(existsInsideRoot(root, 'missing.txt')).toBe(false)
    expect(existsInsideRoot(root, 'link-out')).toBe(false)
    expect(existsInsideRoot(root, '../outside/secret.txt')).toBe(false)
    expect(existsInsideRoot(root, join(root, 'file.txt'))).toBe(true)
    expect(existsInsideRoot(root, join(outside, 'secret.txt'))).toBe(false)
    expect(existsInsideRoot(rootLink, join(realRoot, 'file.txt'))).toBe(true)
    expect(existsInsideRoot(root, 'link-in')).toBe(true)
    expect(existsInsideRoot(root, 'sub')).toBe(false)
  })
})

describe('RFC-284 T6 — 双查骨架唯一性文本锁', () => {
  const src = (p: string) => readFileSync(join(import.meta.dir, '../src', p), 'utf8')

  test('checkLexicalThenRealpath 在 src 恰好一处定义、三个迁移点全部消费', () => {
    const safePath = src('util/safePath.ts')
    expect(safePath.match(/export function checkLexicalThenRealpath\(/g)?.length).toBe(1)
    expect(src('services/envelope.ts').includes('checkLexicalThenRealpath(')).toBe(true)
    const pa = src('services/portArtifacts.ts')
    expect((pa.match(/checkLexicalThenRealpath\(/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  test('envelope.ts 双查手写副本清零（realpathSync 零命中）', () => {
    expect(src('services/envelope.ts').includes('realpathSync')).toBe(false)
  })

  test('portArtifacts.ts 仅存归档 symlink warn 段的单查（非双查族，warn 不拒）', () => {
    // import 行 1 处 + :228-229 的 warn 段 2 处 = 恰 3 行；双查副本若回潮此数必涨。
    const lines = src('services/portArtifacts.ts')
      .split('\n')
      .filter((l: string) => l.includes('realpathSync'))
    expect(lines.length).toBe(3)
  })
})
