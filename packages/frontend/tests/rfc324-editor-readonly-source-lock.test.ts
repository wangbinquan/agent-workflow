// RFC-324 —— 工作流编辑器只读态的源码层锁。
//
// 被锁的缺陷（`docs/audit-backlog.md:489-499`，2026-08-08 用户实报）：
//
//   非 owner 打开别人的工作流，编辑器完全可交互——画布随便拖、Inspector 随便改，
//   直到 `healLoadedDefinition` 打出的第一发自动保存吃到 403，然后被判成
//   `inaccessible`，弹出「此工作流可能已删除或权限已变化」。**那句话两条都不成立**：
//   工作流既没删，权限也没变，他从来就没有写权。
//
// 修复有三个必须同时成立的部分，本文件逐条锁住它们的**结构**（运行时语义由
// `rfc324-acl-panel-levels.test.tsx` 的 useResourceAccess 用例证明）：
//
//   1. `canUpdate` 必须同时看方法级权限点与**行级授权档**。只看权限点等于
//      「看得见就编辑得动」——`workflows:update` 在 user 预设里人人都有。
//   2. heal 那发自动保存必须等 `isResolved`，不能骑在 `canEdit` 的乐观值上：
//      判定还没回来就 heal，等于把那发必然 403 的 PUT 又发了一次。
//   3. 403 不能再一律当作「访问丢失」——只读拒绝有自己的码，工作流仍然可读。
//
// 为什么是源码断言：这三处都在一个渲染路径的接缝上（一个 hook 的返回值、一条
// effect 的早返回、一个谓词的分支），把整条编辑器路由拉起来只为观察"没有发出
// 请求"，代价远大于收益，且更脆——任何无关的 canvas/WS mock 变动都会把它染红。

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// vitest 下没有 `import.meta.dir`（那是 Bun 的扩展）；用 URL 推路径两边都成立。
const EDITOR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'routes',
  'workflows.edit.tsx',
)
const SOURCE = readFileSync(EDITOR, 'utf8')

describe('RFC-324 —— 编辑器只读态的三处接缝', () => {
  test('语料自证：读到的确实是编辑器路由（读空文件的话下面全是空转）', () => {
    expect(SOURCE.length).toBeGreaterThan(10_000)
    expect(SOURCE).toContain('healLoadedDefinition')
  })

  test('①canUpdate = 方法级权限点 ∧ 行级授权档', () => {
    expect(
      SOURCE,
      'canUpdate 只看权限点就是「看得见 = 编辑得动」——workflows:update 在 user 预设里人人都有',
    ).toMatch(/const canUpdate = canManageAcl && workflowAccess\.canEdit/)
    expect(SOURCE).toContain('useResourceAccess(`/api/workflows/${workflowId}`)')
    // 权限面板入口**不能**跟着收紧：它对只读者是只读视图，藏起来等于让被授权者
    // 看不到自己是被谁、以什么档位授权的（rfc099 的 e2e 当场抓到过这一点）。
    expect(SOURCE).toMatch(/const canManageAcl = usePermission\('workflows:update'\)/)
    const guardAt = SOURCE.indexOf('{canManageAcl &&')
    const aclButtonAt = SOURCE.indexOf('data-testid="workflow-acl-button"')
    expect(guardAt, '权限入口的守卫必须是 canManageAcl').toBeGreaterThan(0)
    expect(aclButtonAt).toBeGreaterThan(guardAt)
    expect(
      SOURCE.slice(guardAt, aclButtonAt),
      '两者之间不该夹着另一个按钮——那说明这个守卫守的是别的东西',
    ).not.toContain('data-testid="workflow-')
  })

  test('②heal 的自动保存等的是已解析的判定，不是乐观值', () => {
    expect(
      SOURCE,
      'heal 直接调 controller.commit，绕过 commitDefinition 的 canUpdate 早返回，所以它需要自己的闸门',
    ).toMatch(/if \(!workflowAccess\.isResolved \|\| !canUpdate\) return/)
    // 守卫必须在置位 ref 之前——否则第一次渲染就把 ref 烧掉，判定到达后再不会 heal。
    const guardAt = SOURCE.indexOf('!workflowAccess.isResolved || !canUpdate')
    const refAt = SOURCE.indexOf('healedInitialRef.current = true', guardAt - 400)
    expect(guardAt).toBeGreaterThan(0)
    expect(refAt, '守卫必须早于 healedInitialRef 置位').toBeGreaterThan(guardAt)
  })

  test('③403 不再一律算访问丢失：只读拒绝码被显式排除', () => {
    expect(SOURCE).toMatch(/const READ_ONLY_REFUSAL_CODES/)
    for (const code of [
      'resource-read-only',
      'resource-govern-owner-only',
      'resource-rename-owner-only',
    ]) {
      expect(SOURCE, `${code} 必须被排除在「可能已删除」之外`).toContain(`'${code}'`)
    }
    expect(SOURCE).toMatch(/return !READ_ONLY_REFUSAL_CODES\.has\(error\.code\)/)
  })

  test('④只读徽标只在判定到达且确为只读时出现（未解析时不许闪）', () => {
    expect(SOURCE).toMatch(
      /workflowAccess\.isResolved && !workflowAccess\.canEdit && \(\s*<span[^>]*data-testid="workflow-readonly-badge"/s,
    )
  })
})
