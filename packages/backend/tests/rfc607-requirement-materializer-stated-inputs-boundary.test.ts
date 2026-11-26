// RFC-607 — 需求物化器的需求源必填，本机兼容物化器迁入用例 helper（RFC-294 W4-E8 余项）。
//
// 为什么存在：需求物化器的 `source?` 没给时，取件、外部渠道发问与收答三处给出 `requirement-source-not-wired`；唯一的生产装配一直给它（RFC-597
// 起必填）。`documents?` 覆盖只有用例在用。那份把物理目录需求源包成选定形式的本机兼容物化器，生产代码从不调用。现在 `source` 必填、`documents`
// 覆盖删去，兼容物化器迁入 `tests/helpers/`。锁三件事：
// ① 编译期与源码：`RequirementMaterializerDeps` 的 `source` 必填、没有 `documents`（判据带负对照）。
// ② application 不再判断需求源是否缺席、不再读文档覆盖；问题集缺适配器绑定的失败照旧保留（那是绑定缺失）。
// ③ `src/` 里没有本机兼容物化器，也没有任何文件调用它；兼容的 `infrastructure/requirementMaterializer.ts` 已删去。
//
// 覆盖范围（C12）：读 development-automation 的源码与 `tests/helpers/`；行为由 RFC-310 / RFC-370 的物化用例覆盖（经 helper）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import type { RequirementMaterializerDeps } from '@/modules/development-automation/application/requirementMaterializer'

const DA = join(import.meta.dir, '..', 'src', 'modules', 'development-automation')
const MATERIALIZER = join(DA, 'application', 'requirementMaterializer.ts')

// ① Compile-time. An optional key makes the empty object fit its `Pick`.
type IsRequired<T, K extends keyof T> = Record<never, never> extends Pick<T, K> ? never : true
type Lacks<T, K extends string> = K extends keyof T ? never : true
const stated: [
  IsRequired<RequirementMaterializerDeps, 'source'>,
  Lacks<RequirementMaterializerDeps, 'documents'>,
] = [true, true]

/** `name` / `name?` members of the named interface. */
function members(text: string, name: string): string[] {
  const source = ts.createSourceFile('m.ts', text, ts.ScriptTarget.Latest, true)
  const node = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  )
  return (node?.members ?? [])
    .map((member) => (member.name?.getText(source) ?? '') + (member.questionToken ? '?' : ''))
    .sort()
}

const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isAsExpression(node) ||
  ts.isTypeAssertionExpression(node) ||
  ts.isSatisfiesExpression(node) ||
  ts.isParenthesizedExpression(node) ||
  ts.isNonNullExpression(node)
    ? unwrap(node.expression)
    : node

/** `deps.source` / `deps.documents` (through any cast). */
const isDepsMember = (node: ts.Expression, name: string): boolean => {
  const inner = unwrap(node)
  return (
    ts.isPropertyAccessExpression(inner) &&
    inner.name.text === name &&
    ts.isIdentifier(inner.expression) &&
    inner.expression.text === 'deps'
  )
}

/** Absence checks on the requirement source and reads of the removed documents override. */
function absenceFindings(text: string): string[] {
  const source = ts.createSourceFile('m.ts', text, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const line = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
      ].includes(node.operatorToken.kind)
    ) {
      const [left, right] = [unwrap(node.left), unwrap(node.right)]
      const isUndefined = (side: ts.Expression) =>
        ts.isIdentifier(side) && side.text === 'undefined'
      if (
        (isDepsMember(left, 'source') && isUndefined(right)) ||
        (isDepsMember(right, 'source') && isUndefined(left))
      )
        found.push(`${line(node)} source absence check`)
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.questionDotToken !== undefined &&
      isDepsMember(node.expression, 'source')
    )
      found.push(`${line(node)} optional chain on the source`)
    if (ts.isPropertyAccessExpression(node) && isDepsMember(node, 'documents'))
      found.push(`${line(node)} documents override`)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe('RFC-607 —— 需求物化器的需求源必填', () => {
  test('入参：source 必填，没有 documents 覆盖', () => {
    expect(stated).toEqual([true, true])
    const declared = members(readFileSync(MATERIALIZER, 'utf8'), 'RequirementMaterializerDeps')
    expect(declared).toContain('source')
    expect(declared.filter((member) => member.startsWith('documents'))).toEqual([])
    // Negative control: the judgement sees an optional source and a documents override.
    expect(
      members(
        'interface RequirementMaterializerDeps {\n  readonly source?: S\n  readonly documents?: D\n}\n',
        'RequirementMaterializerDeps',
      ),
    ).toEqual(['documents?', 'source?'])
  })

  test('application 不再判断需求源缺席，绑定缺失的失败照旧', () => {
    const text = readFileSync(MATERIALIZER, 'utf8')
    expect(absenceFindings(text)).toEqual([])
    expect(text).toContain('const documents = evidence.documents')
    // Negative control: casts and parentheses do not hide a check, and other members are not findings.
    expect(
      absenceFindings(
        [
          'if (deps.source === undefined) return',
          'if ((deps.source as unknown) === undefined) return',
          'if (undefined !== (deps.source)) return',
          'const out = deps.source?.acquire',
          'const documents = deps.documents ?? evidence.documents',
          'const fine = deps.store === undefined || input.adapterBindingRef === null',
        ].join('\n'),
      ),
    ).toEqual([
      '1 source absence check',
      '2 source absence check',
      '3 source absence check',
      '4 optional chain on the source',
      '5 documents override',
    ])
    expect(text).toMatch(/if \(input\.adapterBindingRef === null\) \{/)
  })

  test('本机兼容物化器只在 tests/helpers 里', () => {
    expect(
      existsSync(join(DA, 'infrastructure', 'local', 'legacyRequirementMaterializer.ts')),
    ).toBe(false)
    expect(existsSync(join(DA, 'infrastructure', 'requirementMaterializer.ts'))).toBe(false)
    expect(existsSync(join(import.meta.dir, 'helpers', 'legacyRequirementMaterializer.ts'))).toBe(
      true,
    )
    const files = readdirSync(join(import.meta.dir, '..', 'src'), {
      recursive: true,
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => join(entry.parentPath, entry.name))
    expect(files.length).toBeGreaterThanOrEqual(3000)
    expect(
      files.filter((file) => /\bcreateRequirementMaterializer\b/.test(readFileSync(file, 'utf8'))),
    ).toEqual([])
  })
})
