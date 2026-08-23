// RFC-317 T31（DE-03）—— 「失败属于哪一类」是端口上的闭合字段，不是 errorCode 的拼法。
//
// 改造前，OS 的重试策略由这一行决定：
//   `const boundaryFailure = errorCode.startsWith('workspace-boundary-')`
// 而那个前缀由 development-automation 用模板拼出来（`workspace-${verdict.kind}-${...}`）。
// 两端之间没有任何类型联系：把 `kind: 'boundary'` 改名、或调一下模板顺序，每一次边界
// 违规都会**静默降级**成同场景重试——OS 会在一个已被证明污染的工作区里反复重跑 agent，
// 而且外部完全看不出异常（重试照常发生，只是场景错了）。
//
// 这个文件锁三件事：升级判据本身、判据的穷尽性、以及「不许退回前缀嗅探」。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import ts from 'typescript'

import { boundaryEscalates } from '@/modules/digital-employee/application/runtimeService'
import { WORKSPACE_FAILURE_CLASSES } from '@/modules/digital-employee/public/types'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const OS_SERVICE = 'packages/backend/src/modules/digital-employee/application/runtimeService.ts'

/**
 * 该文件里有没有「拿字符串前缀当契约」的调用：`x.startsWith('<literal>')` /
 * `x.includes('<literal>')`，且字面量以给定前缀打头。
 *
 * 走 AST 而不是 grep：本文件顶部的说明注释里就完整写着那行旧代码。
 */
function prefixHandshakes(text: string, path: string, literalPrefix: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true)
  const hits: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === 'startsWith' || node.expression.name.text === 'includes')
    ) {
      const argument = node.arguments[0]
      if (
        argument !== undefined &&
        ts.isStringLiteral(argument) &&
        argument.text.startsWith(literalPrefix)
      ) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
        hits.push(`${path}:${line} ${node.expression.name.text}('${argument.text}')`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return hits
}

describe('RFC-317 T31（DE-03）—— 工作区失败类别决定重试场景', () => {
  test('语料非空：类别联合读得到（读不到则下面的穷尽断言零预言力）', () => {
    expect(WORKSPACE_FAILURE_CLASSES.length).toBeGreaterThanOrEqual(3)
  })

  test('只有 boundary 升级到新场景；其余同场景重试', () => {
    expect(boundaryEscalates('boundary')).toBe(true)
    expect(boundaryEscalates('semantic')).toBe(false)
    expect(boundaryEscalates('infrastructure')).toBe(false)
  })

  test('每一类都在升级表里有明确取值（新增一类而不表态 ⇒ 这里先红）', () => {
    const undecided = WORKSPACE_FAILURE_CLASSES.filter(
      (errorClass) => typeof boundaryEscalates(errorClass) !== 'boolean',
    )
    expect(
      undecided,
      '新增了一类失败却没在 ESCALATES_TO_FRESH_SCENE 里表态——默认落进「不换场景」正是' +
        '本条 finding 里那族 errorCode 被长期静默吞掉的形状',
    ).toEqual([])
  })

  test('OS 不得退回「嗅 errorCode 前缀」的握手', () => {
    const text = readFileSync(resolve(REPO_ROOT, OS_SERVICE), 'utf8')
    expect(
      prefixHandshakes(text, OS_SERVICE, 'workspace-'),
      '平台级的重试策略又一次由某个业务模块拼字符串的拼法决定了。类别是端口上的闭合' +
        '字段，读它；前缀握手两端没有任何类型联系，任一侧改名都会静默切断',
    ).toEqual([])
  })
})

describe('RFC-317 T31 自变异 —— 前缀判据的两条边界', () => {
  test('真的嗅前缀会被抓到', () => {
    expect(
      prefixHandshakes(
        `const boundaryFailure = errorCode.startsWith('workspace-boundary-')\n`,
        'probe.ts',
        'workspace-',
      ).length,
    ).toBe(1)
  })

  test('注释里写着那行旧代码**不算**违规（AST 判据，不被散文满足）', () => {
    expect(
      prefixHandshakes(
        `// 改造前是 errorCode.startsWith('workspace-boundary-')，见 RFC-317 DE-03\nconst x = 1\n`,
        'probe.ts',
        'workspace-',
      ),
      '本测试文件自己的说明注释里就完整写着那行旧代码——文本判据会把这份说明算成违规',
    ).toEqual([])
  })
})

// RFC-317 T31（DE-05）—— 「走平台工作项」的保留 slotRef 必须是一个**共享符号**。
//
// 这个值让一个工作项绕过 OS 的两条不变量（选中的 slot 必须存在、该 slot 必须有精确
// 发布的工具修订）。改造前它在两个模块里各是一枚裸字面量 `'platform'`，两侧没有任何
// 共享符号——任一侧改名都不报错，只是**换一条代码路径**：OS 要么开始索要一个并不存在
// 的工具绑定，要么不再索要一个本该存在的绑定。两种都不是异常，都不会红。
const SLOT_REF_SITES = [
  {
    file: 'packages/backend/src/modules/digital-employee/application/runtimeService.ts',
    why: 'OS 侧：判定这一轮是否走平台工作项、从而跳过两条工具绑定不变量。',
  },
  {
    file: 'packages/backend/src/modules/development-automation/composition/employeeTypePackage.ts',
    why: '类型包侧：intake 不是 external-id 时，把工作项路由到平台工作项。',
  },
] as const

describe('RFC-317 T31（DE-05）—— 平台工作项 slotRef 的共享符号', () => {
  test('两侧都 import 了共享常量（谁在用这条逃生门是可枚举的）', () => {
    const missing = SLOT_REF_SITES.filter(
      (site) =>
        !readFileSync(resolve(REPO_ROOT, site.file), 'utf8').includes(
          'PLATFORM_WORK_ITEM_SLOT_REF',
        ),
    ).map((site) => `${site.file}（${site.why}）`)
    expect(
      missing,
      '这一侧又回到了裸字面量。两侧不共享符号时，改名不是编译错误而是换一条代码路径——' +
        '而两条路径都不会报错，只会让工具绑定不变量在错误的一侧生效',
    ).toEqual([])
  })

  test('OS 不再把 slot 与裸字符串字面量比较', () => {
    const path = SLOT_REF_SITES[0].file
    const text = readFileSync(resolve(REPO_ROOT, path), 'utf8')
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true)
    const offenders: string[] = []
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
      ) {
        for (const [value, other] of [
          [node.right, node.left],
          [node.left, node.right],
        ] as Array<[ts.Node, ts.Node]>) {
          if (ts.isStringLiteral(value) && /slot(Ref)?$/i.test(other.getText(source))) {
            const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
            offenders.push(`${path}:${line} ${node.getText(source).slice(0, 80)}`)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(offenders, 'slot 判据里又出现了裸字面量——用共享常量').toEqual([])
  })
})
