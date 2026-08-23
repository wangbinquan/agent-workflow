// RFC-317 T38（CC-08）—— 「上传目标是安全的仓库相对路径」这条契约只能有一个 schema。
//
// 改造前仓里有三份独立声明，严格度递减：
//   ① `repoRelativePathSchema`（产出侧）——拒绝前导 `/`、反斜杠、盘符、空段、`.`、`..`；
//   ② `uploadSeedSchema` 内联重写同一套逻辑，另加平台根检查；
//   ③ **写侧的边界重解析**是裸 `z.string().min(1)`。
// 也就是说最靠近 `join()` + `copyBlobTo()` 的那一份最松：产出侧拒掉的每一种逃逸形态，
// 到了边界重解析时全部放行。今天没有真实逃逸，只是因为产出侧先拦住了——那是被拿掉的
// 纵深防御，不是不需要的防御。上游 schema 放松一次、或换一个 context state 供给
// targetPath，它就变成真的路径逃逸。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import ts from 'typescript'

import { repoRelativePathSchema } from '@/modules/development-automation/domain/requirementManifest'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')

/** 写侧边界：这两处的 `targetPath` 最终会拼进 workspace 根并落盘。 */
const BOUNDARY_FILES = [
  'packages/backend/src/modules/development-automation/composition/digitalEmployeeWorkspace.ts',
  'packages/backend/src/modules/development-automation/composition/digitalEmployeePlatformWorkItems.ts',
] as const

/** 产出侧拒绝、写侧也必须拒绝的逃逸形态。 */
const MUST_REJECT = [
  '/etc/passwd',
  '../outside.txt',
  'a/../../outside.txt',
  'a//b.txt',
  'a/./b.txt',
  'C:\\Windows\\win.ini',
  'dir\\..\\outside.txt',
  'has\0nul.txt',
  '',
] as const

const MUST_ACCEPT = ['docs/requirements/REQ-42.md', 'a.txt', 'a/b/c/d.txt'] as const

/**
 * 该文件里 `targetPath` 是不是被声明成了一个**裸 zod 字符串**。
 *
 * 走 AST 而不是 grep：本文件顶部的说明注释里就写着 `z.string().min(1)`。
 */
function bareTargetPathDeclarations(rel: string): string[] {
  const text = readFileSync(resolve(REPO_ROOT, rel), 'utf8')
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true)
  const offenders: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'targetPath'
    ) {
      const initializer = node.initializer.getText(source)
      if (/^z\s*\./.test(initializer)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
        offenders.push(`${rel}:${line} targetPath: ${initializer.slice(0, 60)}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return offenders
}

describe('RFC-317 T38（CC-08）—— 上传目标路径的单一 schema', () => {
  test('语料非空：两处写侧文件都读得到', () => {
    for (const rel of BOUNDARY_FILES) {
      expect(readFileSync(resolve(REPO_ROOT, rel), 'utf8').length).toBeGreaterThan(1_000)
    }
  })

  test('写侧不得就地再声明一个 targetPath zod（必须 import 共享 schema）', () => {
    const offenders = BOUNDARY_FILES.flatMap((rel) => bareTargetPathDeclarations(rel))
    expect(
      offenders,
      '写侧又就地声明了一个 targetPath schema。同一条契约有两份声明时，靠近落盘的那份' +
        '迟早会比产出侧松——这正是本条 finding 的形态（写侧是裸 z.string().min(1)，' +
        '把产出侧拒掉的 ../、反斜杠、盘符、空段全部放行）',
    ).toEqual([])
  })

  test('共享 schema 拒绝全部已知逃逸形态', () => {
    const accepted = MUST_REJECT.filter((path) => repoRelativePathSchema.safeParse(path).success)
    expect(accepted, '这些形态必须被拒——它们会在 join() 时逃出 workspace 根').toEqual([])
  })

  test('共享 schema 接受正常的仓库相对路径（否则上面那条可能只是「全拒」）', () => {
    const rejected = MUST_ACCEPT.filter((path) => !repoRelativePathSchema.safeParse(path).success)
    expect(rejected, '正向控制：全拒的 schema 同样能让上一条绿，但会把功能拒死').toEqual([])
  })
})

describe('RFC-317 T38 自变异 —— 判据的两条边界', () => {
  test('真的落一个裸 zod targetPath 会被抓到', () => {
    const source = ts.createSourceFile(
      'probe.ts',
      `const s = z.object({ targetPath: z.string().min(1) })\n`,
      ts.ScriptTarget.ES2022,
      true,
    )
    let hits = 0
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'targetPath' &&
        /^z\s*\./.test(node.initializer.getText(source))
      ) {
        hits += 1
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(hits).toBe(1)
  })

  test('import 来的共享 schema 不算违规（这正是要求的写法）', () => {
    const source = ts.createSourceFile(
      'probe.ts',
      `const s = z.object({ targetPath: repoRelativePathSchema })\n`,
      ts.ScriptTarget.ES2022,
      true,
    )
    let hits = 0
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'targetPath' &&
        /^z\s*\./.test(node.initializer.getText(source))
      ) {
        hits += 1
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(hits).toBe(0)
  })
})
