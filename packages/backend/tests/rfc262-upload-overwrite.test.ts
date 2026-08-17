// RFC-262 — upload 输入的同名冲突策略（`onConflict: 'rename' | 'overwrite'`）。
//
// 这个文件锁三件事：
//
//   1. **覆盖语义**：开了 overwrite 后 packed 路径保持**原名**（不是 `report (1).pdf`）
//      ——这正是该模式的全部价值：仓内既有引用必须解析到用户刚上传的那份。
//   2. **RFC-107 安全性质不被覆盖分支破坏**：覆盖遇到符号链接时删的是**链接本体**
//      （`unlinkSync` 不跟随），链接指向的 worktree 外文件内容一个字节都不能变；
//      写入仍带 `wx`（`O_CREAT|O_EXCL`）。这条一旦变红就是安全回归，不是风格问题。
//   3. **同批同名在启动校验期就拒**（RFC-262 D4，用户拍板）：`validateUploadPlan`
//      抛 `upload-duplicate-filename`，且**一个文件都没落盘**——它在 routes/tasks.ts
//      里跑在 clone / worktree 物化之前，所以这条断言同时是"不会先 clone 再失败"的
//      代理判据。
//
// 缺省（不写 onConflict）的行为由 upload-apply-to-worktree.test.ts 的存量断言
// 「renames on collision with " (1)" suffix」继续锁住，本文件不重复。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_INPUTS_DIR } from '@agent-workflow/shared'
import {
  applyUploadsToWorktree,
  DEFAULT_UPLOAD_LIMITS,
  validateUploadPlan,
  type UploadFile,
  type UploadInputDef,
  type UploadPlan,
} from '../src/services/upload'
import { collectUploadInputDefs } from '../src/services/launchMultipart'
import { ValidationError } from '../src/util/errors'

let root = ''
let outside = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rfc262-worktree-'))
  outside = mkdtempSync(join(tmpdir(), 'rfc262-outside-'))
})
afterEach(() => {
  for (const d of [root, outside]) if (d !== '') rmSync(d, { recursive: true, force: true })
})

function makeDefs(...defs: UploadInputDef[]): Map<string, UploadInputDef> {
  const m = new Map<string, UploadInputDef>()
  for (const d of defs) m.set(d.key, d)
  return m
}

function fileOf(inputKey: string, filename: string, body: string): UploadFile {
  return {
    inputKey,
    filename,
    declaredMime: 'application/octet-stream',
    bytes: new TextEncoder().encode(body),
  }
}

function plan(
  defs: UploadInputDef[],
  files: UploadFile[],
  extra: Partial<UploadPlan> = {},
): UploadPlan {
  return {
    worktreePath: root,
    defs: makeDefs(...defs),
    files,
    limits: DEFAULT_UPLOAD_LIMITS,
    ...extra,
  }
}

describe('RFC-262 overwrite — 普通文件', () => {
  // AC-3
  test('覆盖已存在的同名文件：内容被替换，packed 路径保持原名', async () => {
    mkdirSync(join(root, 'spec'), { recursive: true })
    writeFileSync(join(root, 'spec/api.yaml'), 'committed: old\n')

    const out = await applyUploadsToWorktree(
      plan(
        [{ key: 'spec', targetDir: 'spec', onConflict: 'overwrite' }],
        [fileOf('spec', 'api.yaml', 'uploaded: new\n')],
      ),
    )

    expect(out.packedByKey.get('spec')).toEqual(['spec/api.yaml'])
    expect(readFileSync(join(root, 'spec/api.yaml'), 'utf8')).toBe('uploaded: new\n')
    // 没有留下改名副本——覆盖就是覆盖。
    expect(existsSync(join(root, 'spec/api (1).yaml'))).toBe(false)
  })

  test('覆盖模式下目标不存在时与新建无异', async () => {
    const out = await applyUploadsToWorktree(
      plan(
        [{ key: 'spec', targetDir: 'spec', onConflict: 'overwrite' }],
        [fileOf('spec', 'api.yaml', 'fresh\n')],
      ),
    )
    expect(out.packedByKey.get('spec')).toEqual(['spec/api.yaml'])
    expect(readFileSync(join(root, 'spec/api.yaml'), 'utf8')).toBe('fresh\n')
  })

  // 显式 rename 与缺省同义（缺省行为本身由存量测试锁）。
  test('显式 onConflict:"rename" 仍改名且原文件不动', async () => {
    mkdirSync(join(root, 'inputs'), { recursive: true })
    writeFileSync(join(root, 'inputs/report.pdf'), 'preexisting')
    const out = await applyUploadsToWorktree(
      plan(
        [{ key: 'refs', targetDir: 'inputs', onConflict: 'rename' }],
        [fileOf('refs', 'report.pdf', 'uploaded')],
      ),
    )
    expect(out.packedByKey.get('refs')).toEqual(['inputs/report (1).pdf'])
    expect(readFileSync(join(root, 'inputs/report.pdf'), 'utf8')).toBe('preexisting')
  })
})

describe('RFC-262 overwrite — RFC-107 安全性质', () => {
  // AC-4 / AC-10：不可信（URL-clone）仓可以把 targetDir 里的叶子提交成指向
  // worktree 外的符号链接。覆盖分支必须删链接本体、落真实文件，绝不写穿。
  test('目标是指向 worktree 外的符号链接：链接被替换，外部文件内容不变', async () => {
    const victim = join(outside, 'victim.txt')
    writeFileSync(victim, 'DO NOT TOUCH')
    mkdirSync(join(root, 'inputs'), { recursive: true })
    symlinkSync(victim, join(root, 'inputs/report.pdf'))

    const out = await applyUploadsToWorktree(
      plan(
        [{ key: 'refs', targetDir: 'inputs', onConflict: 'overwrite' }],
        [fileOf('refs', 'report.pdf', 'uploaded bytes')],
      ),
    )

    expect(out.packedByKey.get('refs')).toEqual(['inputs/report.pdf'])
    // worktree 内现在是一个**真实文件**（不再是链接），内容是上传物。
    expect(lstatSync(join(root, 'inputs/report.pdf')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(root, 'inputs/report.pdf'), 'utf8')).toBe('uploaded bytes')
    // 关键安全断言：链接原本指向的外部文件一个字节都没变。
    expect(readFileSync(victim, 'utf8')).toBe('DO NOT TOUCH')
  })

  test('目标是悬空符号链接：同样被替换为真实文件（lstat 而非 existsSync 判定）', async () => {
    mkdirSync(join(root, 'inputs'), { recursive: true })
    const ghostTarget = join(outside, 'never-created.txt')
    symlinkSync(ghostTarget, join(root, 'inputs/report.pdf'))

    await applyUploadsToWorktree(
      plan(
        [{ key: 'refs', targetDir: 'inputs', onConflict: 'overwrite' }],
        [fileOf('refs', 'report.pdf', 'uploaded')],
      ),
    )

    expect(lstatSync(join(root, 'inputs/report.pdf')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(root, 'inputs/report.pdf'), 'utf8')).toBe('uploaded')
    // 悬空链接的目标从未被创建——写入没有跟随链接。
    expect(existsSync(ghostTarget)).toBe(false)
  })

  test('rename 模式遇到指向外部的链接仍走改名（存量行为不因本 RFC 改变）', async () => {
    const victim = join(outside, 'victim.txt')
    writeFileSync(victim, 'DO NOT TOUCH')
    mkdirSync(join(root, 'inputs'), { recursive: true })
    symlinkSync(victim, join(root, 'inputs/report.pdf'))

    const out = await applyUploadsToWorktree(
      plan([{ key: 'refs', targetDir: 'inputs' }], [fileOf('refs', 'report.pdf', 'uploaded')]),
    )

    expect(out.packedByKey.get('refs')).toEqual(['inputs/report (1).pdf'])
    // 链接本体还在、指向不变、外部文件不变。
    expect(lstatSync(join(root, 'inputs/report.pdf')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(root, 'inputs/report.pdf'))).toBe(victim)
    expect(readFileSync(victim, 'utf8')).toBe('DO NOT TOUCH')
  })

  // AC-5
  test('目标是目录 → upload-target-is-dir，目录内容不受损、无残留写入', async () => {
    mkdirSync(join(root, 'inputs/report.pdf'), { recursive: true })
    writeFileSync(join(root, 'inputs/report.pdf/inner.txt'), 'keep me')

    await expect(
      applyUploadsToWorktree(
        plan(
          [{ key: 'refs', targetDir: 'inputs', onConflict: 'overwrite' }],
          [fileOf('refs', 'report.pdf', 'uploaded')],
        ),
      ),
    ).rejects.toThrow(ValidationError)

    expect(lstatSync(join(root, 'inputs/report.pdf')).isDirectory()).toBe(true)
    expect(readFileSync(join(root, 'inputs/report.pdf/inner.txt'), 'utf8')).toBe('keep me')
  })

  test('目录冲突时先写下的文件被回滚（不留 partial）', async () => {
    mkdirSync(join(root, 'inputs/b.txt'), { recursive: true })

    await expect(
      applyUploadsToWorktree(
        plan(
          [{ key: 'refs', targetDir: 'inputs', onConflict: 'overwrite' }],
          [fileOf('refs', 'a.txt', 'first'), fileOf('refs', 'b.txt', 'second')],
        ),
      ),
    ).rejects.toThrow(ValidationError)

    // 第一个文件已经落盘过，失败后必须被 unlink 掉。
    expect(existsSync(join(root, 'inputs/a.txt'))).toBe(false)
  })
})

describe('RFC-262 同批同名判重（D4：对所有 upload 输入生效）', () => {
  // AC-6
  test('同一 input 内两个同名文件 → upload-duplicate-filename，且零落盘', async () => {
    await expect(
      applyUploadsToWorktree(
        plan(
          [{ key: 'refs', targetDir: 'inputs' }],
          [fileOf('refs', 'report.pdf', 'one'), fileOf('refs', 'report.pdf', 'two')],
        ),
      ),
    ).rejects.toThrow(ValidationError)
    expect(existsSync(join(root, 'inputs/report.pdf'))).toBe(false)
    expect(existsSync(join(root, 'inputs'))).toBe(false)
  })

  test('错误码 / detail 指出两侧的 input key 与文件名', () => {
    try {
      validateUploadPlan({
        defs: makeDefs({ key: 'refs', targetDir: 'inputs' }),
        files: [fileOf('refs', 'report.pdf', 'one'), fileOf('refs', 'report.pdf', 'two')],
        limits: DEFAULT_UPLOAD_LIMITS,
      })
      throw new Error('expected validateUploadPlan to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError)
      const ve = err as ValidationError
      expect(ve.code).toBe('upload-duplicate-filename')
      const details = ve.details as { landingKey: string; first: { inputKey: string } }
      expect(details.landingKey).toBe('inputs/report.pdf')
      expect(details.first.inputKey).toBe('refs')
    }
  })

  // AC-7：这条是"覆盖模式静默丢文件"的另一条入口，判重必须是全局的。
  test('两个 input 配同一 targetDir、各上传一个同名文件 → 同样被拒', () => {
    expect(() =>
      validateUploadPlan({
        defs: makeDefs(
          { key: 'spec', targetDir: 'contracts', onConflict: 'overwrite' },
          { key: 'extra', targetDir: 'contracts' },
        ),
        files: [fileOf('spec', 'api.yaml', 'one'), fileOf('extra', 'api.yaml', 'two')],
        limits: DEFAULT_UPLOAD_LIMITS,
      }),
    ).toThrow(ValidationError)
  })

  test('同名但 targetDir 不同 → 放行（两份都落地）', async () => {
    const out = await applyUploadsToWorktree(
      plan(
        [
          { key: 'a', targetDir: 'inputs/one' },
          { key: 'b', targetDir: 'inputs/two' },
        ],
        [fileOf('a', 'report.pdf', 'one'), fileOf('b', 'report.pdf', 'two')],
      ),
    )
    expect(out.packedByKey.get('a')).toEqual(['inputs/one/report.pdf'])
    expect(out.packedByKey.get('b')).toEqual(['inputs/two/report.pdf'])
  })

  // 能力影响清单 C2 方案 A（用户拍板）：大小写折叠判重，跨平台一致。
  test('仅大小写不同的同名文件 → 也被拒（macOS/Windows 上它们是同一个文件）', () => {
    expect(() =>
      validateUploadPlan({
        defs: makeDefs({ key: 'refs', targetDir: 'inputs' }),
        files: [fileOf('refs', 'Report.pdf', 'one'), fileOf('refs', 'report.pdf', 'two')],
        limits: DEFAULT_UPLOAD_LIMITS,
      }),
    ).toThrow(ValidationError)
  })

  test('两个空文件名的 part 不互撞（各自 upload-N.bin）', async () => {
    const nameless = (body: string): UploadFile => ({
      inputKey: 'refs',
      filename: undefined as unknown as string,
      declaredMime: 'application/octet-stream',
      bytes: new TextEncoder().encode(body),
    })
    const out = await applyUploadsToWorktree(
      plan([{ key: 'refs', targetDir: 'inputs' }], [nameless('one'), nameless('two')]),
    )
    expect(out.packedByKey.get('refs')).toEqual(['inputs/upload-1.bin', 'inputs/upload-2.bin'])
  })
})

describe('RFC-262 多仓（RFC-248 inputsSubdir）与覆盖策略共存', () => {
  test('组空间下覆盖发生在 .agent-workflow/inputs/ 保留目录内', async () => {
    mkdirSync(join(root, PLATFORM_INPUTS_DIR, 'spec'), { recursive: true })
    writeFileSync(join(root, PLATFORM_INPUTS_DIR, 'spec/api.yaml'), 'old')

    const out = await applyUploadsToWorktree(
      plan(
        [{ key: 'spec', targetDir: 'spec', onConflict: 'overwrite' }],
        [fileOf('spec', 'api.yaml', 'new')],
      ),
      // 注：packed 路径保持相对 targetDir（与 RFC-248 baseline 一致）。
    )
    expect(out.packedByKey.get('spec')).toEqual(['spec/api.yaml'])

    const grouped = await applyUploadsToWorktree(
      plan(
        [{ key: 'spec2', targetDir: 'spec', onConflict: 'overwrite' }],
        [fileOf('spec2', 'api.yaml', 'grouped')],
        { inputsSubdir: PLATFORM_INPUTS_DIR },
      ),
    )
    expect(grouped.packedByKey.get('spec2')).toEqual(['.agent-workflow/inputs/spec/api.yaml'])
    expect(readFileSync(join(root, PLATFORM_INPUTS_DIR, 'spec/api.yaml'), 'utf8')).toBe('grouped')
  })
})

describe('RFC-262 定义透传', () => {
  test('collectUploadInputDefs 把 onConflict 带到执行侧', () => {
    const defs = collectUploadInputDefs([
      { kind: 'upload', key: 'spec', label: 'Spec', targetDir: 'spec', onConflict: 'overwrite' },
      { kind: 'upload', key: 'refs', label: 'Refs', targetDir: 'inputs' },
    ])
    expect(defs.get('spec')?.onConflict).toBe('overwrite')
    // 缺省不被填成字面量——默认值只有写盘处 `?? 'rename'` 一个来源。
    expect(defs.get('refs')?.onConflict).toBeUndefined()
  })

  test('非法 onConflict 在 collectUploadInputDefs 就被拒（strict-on-read 同 schema）', () => {
    expect(() =>
      collectUploadInputDefs([
        { kind: 'upload', key: 'spec', label: 'Spec', targetDir: 'spec', onConflict: 'replace' },
      ]),
    ).toThrow(ValidationError)
  })
})
