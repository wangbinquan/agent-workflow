// RFC-148 T1 — 零生产者防回潮守卫（删除前先钉）。
//
// 为什么这条测试存在：RFC-132 挂账的死注入路径（轮次分组臂 / External
// Feedback 渲染族）在生产侧早已零生产者，但代码还在树上——RFC-148 T2 将删除
// 它们。本守卫在删除**之前**锁死「零生产者」这一事实，防止删除窗口期（或
// 之后）有人重新接线；T2 落地后本文件收紧为全量禁绝（含 runner 死管道）。
//
// T1 范围（当下即绿）：
//   1. 四个死渲染函数在生产代码零调用（定义处除外）；
//   2. ClarifyPromptContext 的 questionsBlock/answersBlock 在生产代码零赋值
//      （scheduler 组装 clarifyContext 恒只含 flatBlock/iteration/remaining/
//       mode/currentRoundOnly）。
// T2 收紧项（见 rfc148 plan）：crossClarifyContext 全族（字段+透传管道）删除后
// 加入零再现清单。

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { describe, expect, test } from 'bun:test'

const ROOTS = [
  { name: 'backend', dir: resolve(import.meta.dir, '..', 'src') },
  { name: 'shared', dir: resolve(import.meta.dir, '..', '..', 'shared', 'src') },
] as const

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(p))
    else if (/\.tsx?$/.test(entry.name)) out.push(p)
  }
  return out
}

function stripComments(content: string): string {
  return content
    .split('\n')
    .map((line) => {
      const t = line.trim()
      return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') ? '' : line
    })
    .join('\n')
}

describe('RFC-148 ratchet — 死渲染函数生产零调用', () => {
  // 定义所在文件（clarify.ts）整体豁免——四死函数的定义与它们互相之间的
  // 死链内部调用（renderCrossClarifySource → buildExternalFeedbackBlock）都
  // 住在那里，T2 一并删除；其余任何生产文件出现 `<name>(` 即违规。
  const DEAD_FNS = [
    'buildClarifyPromptBlock',
    'buildExternalFeedbackBlock',
    'renderCrossClarifySource',
    'renderManualFeedbackSection',
  ] as const

  test('backend + shared src：四死函数零调用（定义文件除外）', () => {
    const violations: string[] = []
    for (const root of ROOTS) {
      for (const file of walk(root.dir)) {
        if (file.endsWith(`shared${sep}src${sep}clarify.ts`)) continue
        const lines = stripComments(readFileSync(file, 'utf8')).split('\n')
        lines.forEach((line, i) => {
          for (const fn of DEAD_FNS) {
            if (!line.includes(`${fn}(`)) continue
            violations.push(
              `${root.name}/${relative(root.dir, file).split(sep).join('/')}:${i + 1}  [${fn}]  ${line.trim()}`,
            )
          }
        })
      }
    }
    expect(violations).toEqual([])
  })
})

describe('RFC-148 ratchet — legacy 轮次分组字段生产零赋值', () => {
  test('backend src：questionsBlock/answersBlock 零对象键赋值', () => {
    // scheduler 组装 clarifyContext 恒不含这两键（RFC-132 后唯一注入面是
    // flatBlock）。对象键赋值形态 `questionsBlock:` 在 backend 生产代码出现
    // 即意味着有人在给死渲染臂重新供血。shared 侧的接口字段声明
    // （prompt.ts ClarifyPromptContext）在 T2 删除前豁免。
    const violations: string[] = []
    const dir = ROOTS[0].dir
    for (const file of walk(dir)) {
      const lines = stripComments(readFileSync(file, 'utf8')).split('\n')
      lines.forEach((line, i) => {
        if (/\b(questionsBlock|answersBlock)\s*:/.test(line)) {
          violations.push(
            `backend/${relative(dir, file).split(sep).join('/')}:${i + 1}  ${line.trim()}`,
          )
        }
      })
    }
    expect(violations).toEqual([])
  })
})
