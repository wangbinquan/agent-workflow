// RFC-203 PR-2 T3c —— 校验 issue 词条三级降级 + 双语完整性 + 接线锁。
//
// LOCKS：
//   1. describeValidationIssue：精确 `validation.issue.<code>` → 最长前缀族
//      `validation.family.<prefix>`（wrapper-loop 先于 wrapper、upload-input
//      先于 input、cross-clarify 先于 clarify）→ `validation.fallback`；
//      raw 恒等于原始英文 message（定位信息在 raw 里，不许丢）。
//   2. zh/en validation 表键集同构、issue 覆盖 workflow.validator 全部 65 码
//      量级（≥60 锁量级即可，新码走族兜底不红）。
//   3. 接线：ValidationPanel（workflows.edit.tsx）与 ErrorDetails 的 issues
//      分支都必须走 describeValidationIssue —— 巨型路由/组件按仓规源级兜底。
import { beforeAll, describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import i18n, { setLanguage } from '../src/i18n'
import { describeValidationIssue } from '../src/i18n/errors'
import { zhCN } from '../src/i18n/zh-CN'
import { enUS } from '../src/i18n/en-US'

beforeAll(async () => {
  await new Promise<void>((resolvePromise) => {
    if (i18n.isInitialized) resolvePromise()
    else i18n.on('initialized', () => resolvePromise())
  })
  setLanguage('zh-CN')
})

describe('describeValidationIssue', () => {
  test('精确命中：代表性码返回中文标题，raw 保留原文', () => {
    const cases: Array<[string, string]> = [
      ['topology-cycle', '工作流在循环包装器之外存在环。'],
      ['wrapper-loop-max-iterations', '循环包装器缺少最大迭代次数。'],
      ['clarify-no-iteration-cap', '反问节点不在循环包装器内，代理可能无限追问。'],
      ['agent-not-found', '节点引用的代理不存在。'],
      ['prompt-template-unresolved', '提示词引用的模板变量没有对应的入边端口。'],
    ]
    for (const [code, title] of cases) {
      const r = describeValidationIssue({ code, message: `raw for ${code}` })
      expect(r.matched).toBe('exact')
      expect(r.title).toBe(title)
      expect(r.raw).toBe(`raw for ${code}`)
    }
  })

  test('族兜底：未收录的新码落到最长前缀族', () => {
    const cases: Array<[string, string]> = [
      ['wrapper-loop-brand-new', '循环包装器配置有误。'],
      ['wrapper-fanout-brand-new', '扇出包装器配置有误。'],
      ['wrapper-brand-new', '包装器配置有误。'],
      ['cross-clarify-brand-new', '跨节点反问接线有误。'],
      ['clarify-brand-new', '反问节点接线有误。'],
      ['upload-input-brand-new', '上传输入配置有误。'],
      ['input-brand-new', '工作流输入配置有误。'],
    ]
    for (const [code, title] of cases) {
      const r = describeValidationIssue({ code, message: 'm' })
      expect(r.matched, code).toBe('family')
      expect(r.title, code).toBe(title)
    }
  })

  test('全局兜底：无前缀匹配的码', () => {
    const r = describeValidationIssue({ code: 'zz-never-registered', message: 'm' })
    expect(r.matched).toBe('fallback')
    expect(r.title).toBe('工作流校验未通过。')
    expect(r.raw).toBe('m')
  })
})

describe('validation 词条完整性', () => {
  test('zh/en issue/family 键集同构，fallback 双语齐', () => {
    expect(Object.keys(zhCN.validation.issue).sort()).toEqual(
      Object.keys(enUS.validation.issue).sort(),
    )
    expect(Object.keys(zhCN.validation.family).sort()).toEqual(
      Object.keys(enUS.validation.family).sort(),
    )
    expect(zhCN.validation.fallback.trim()).not.toBe('')
    expect(enUS.validation.fallback.trim()).not.toBe('')
  })

  test('issue 精确词条覆盖 validator 全量（≥60）；风格铁律', () => {
    const issueKeys = Object.keys(zhCN.validation.issue)
    expect(issueKeys.length).toBeGreaterThanOrEqual(60)
    for (const [k, v] of [
      ...Object.entries(zhCN.validation.issue),
      ...Object.entries(enUS.validation.issue),
      ...Object.entries(zhCN.validation.family),
      ...Object.entries(enUS.validation.family),
    ]) {
      expect(v.trim(), `empty value for ${k}`).not.toBe('')
      expect(v.includes('${'), `raw template literal leaked into ${k}`).toBe(false)
    }
  })

  test('backend workflow.validator 的每个 code 都有精确词条（防新码漏词）', () => {
    const validator = readFileSync(
      resolve(__dirname, '../../backend/src/services/workflow.validator.ts'),
      'utf8',
    )
    const codes = [
      ...new Set(
        [...validator.matchAll(/code: '([a-z0-9-]+)'/g)].flatMap((m) =>
          m[1] === undefined ? [] : [m[1]],
        ),
      ),
    ]
    expect(codes.length).toBeGreaterThanOrEqual(60)
    const missing = codes.filter((c) => !(c in zhCN.validation.issue))
    expect(missing, 'validator codes without an exact entry (add to validation.issue)').toEqual([])
  })
})

describe('接线源级锁', () => {
  test('ValidationPanel 与 ErrorDetails issues 分支都走 describeValidationIssue', () => {
    const editor = readFileSync(resolve(__dirname, '../src/routes/workflows.edit.tsx'), 'utf8')
    expect(editor).toContain('<ValidationPanel')
    const validationPanel = readFileSync(
      resolve(__dirname, '../src/components/workflow-editor/ValidationPanel.tsx'),
      'utf8',
    )
    expect(validationPanel).toContain('describeValidationIssue(')
    // 标题行本地化 + 原文同行折叠（error-details__raw 复用）
    expect(validationPanel).toContain('{described.title}')
    expect(validationPanel.includes('<pre>{described.raw}</pre>')).toBe(true)
    const details = readFileSync(resolve(__dirname, '../src/components/ErrorDetails.tsx'), 'utf8')
    expect(details).toContain('describeValidationIssue(')
  })
})
