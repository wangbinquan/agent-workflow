// RFC-248 D1 回归锁 —— 嵌套挂载点的 `.gitignore` 预置区块。
//
// 为什么这些断言存在（design/RFC-248-repo-groups/design.md §3.1）：
//   - **幂等**不是优化而是正确性：RFC-075 的 `workingBranch` 允许复用一条真实
//     开发分支，同一条分支上连跑两个任务时不能累积多个相同 commit。`added`
//     为空是调用方「跳过 commit」的唯一判据——它一旦回退成「总是非空」，
//     就会在用户的远端分支上刷出一串空 chore commit。
//   - **逐行精确比对**：用 `includes` 做子串判断会让 `/vendor/sdk-old/` 把
//     `/vendor/sdk/` 误判成已存在，于是该排的没排，`git add -A` 就把嵌套仓当
//     gitlink 提交上去了（实测 proposal E2）。

import { describe, expect, test } from 'bun:test'
import {
  buildGitignoreBlock,
  hasAgentWorkflowBlock,
  ruleForMount,
} from '@/services/repoGroupGitignore'

describe('ruleForMount', () => {
  test('锚定到仓根并显式标成目录', () => {
    // 不锚定的话 `vendor/sdk` 会匹配任意深度的同名目录；不标目录的话会连同名
    // 文件一起排掉。
    expect(ruleForMount('vendor/sdk')).toBe('/vendor/sdk/')
    expect(ruleForMount('ext')).toBe('/ext/')
  })

  test('转义 gitignore 元字符 * ? [ ] —— 不转义是双重 bug（实测）', () => {
    // 真实 git 2.50.1 实测（scratchpad/meta.sh）：目录 `a[b]/` 与 `ab/` 并存时
    //   /a[b]/    → `?? a[b]/` 仍在（**没排掉**，add -A 会把嵌套仓当 gitlink
    //               提交上去），且 `ab/` 反被**误排**（用户在 ab/ 里的真实改动
    //               静默消失在审计 diff 与自动提交之外——这一重更糟）
    //   /a\[b\]/  → `a[b]/` 正确排除，`ab/` 正确保留
    expect(ruleForMount('a[b]')).toBe('/a\\[b\\]/')
    expect(ruleForMount('v*ndor')).toBe('/v\\*ndor/')
    expect(ruleForMount('a?b')).toBe('/a\\?b/')
    expect(ruleForMount('x[a-z]*y')).toBe('/x\\[a-z\\]\\*y/')
  })

  test('普通路径不被转义污染', () => {
    expect(ruleForMount('vendor/sdk-2')).toBe('/vendor/sdk-2/')
    expect(ruleForMount('a.b_c')).toBe('/a.b_c/')
  })
})

describe('buildGitignoreBlock', () => {
  test('空文件 ⇒ 直接写区块，不留前导空行', () => {
    const { nextContent, added } = buildGitignoreBlock('', ['vendor/sdk'], 'T1')
    expect(added).toEqual(['/vendor/sdk/'])
    expect(nextContent).toBe(
      '# >>> agent-workflow: nested repo mounts (task T1) >>>\n' +
        '/vendor/sdk/\n' +
        '# <<< agent-workflow: nested repo mounts <<<\n',
    )
  })

  test('已有内容 ⇒ 追加在后面，原内容逐字符保留', () => {
    const existing = 'node_modules/\ndist/\n'
    const { nextContent, added } = buildGitignoreBlock(existing, ['vendor/sdk', 'site/docs'], 'T1')
    expect(added).toEqual(['/vendor/sdk/', '/site/docs/'])
    expect(nextContent.startsWith(existing)).toBe(true)
    expect(nextContent).toContain('/vendor/sdk/')
    expect(nextContent).toContain('/site/docs/')
  })

  test('幂等：规则已存在 ⇒ added 为空且内容原样返回（调用方据此跳过 commit）', () => {
    const first = buildGitignoreBlock('node_modules/\n', ['vendor/sdk'], 'T1')
    const second = buildGitignoreBlock(first.nextContent, ['vendor/sdk'], 'T2')
    expect(second.added).toEqual([])
    expect(second.nextContent).toBe(first.nextContent)
  })

  test('部分已存在 ⇒ 只追加缺的那几条', () => {
    const first = buildGitignoreBlock('', ['vendor/sdk'], 'T1')
    const second = buildGitignoreBlock(first.nextContent, ['vendor/sdk', 'site/docs'], 'T2')
    expect(second.added).toEqual(['/site/docs/'])
    expect(second.nextContent).toContain('/site/docs/')
  })

  test('逐行精确比对——`/vendor/sdk-old/` 不得让 `/vendor/sdk/` 误判为已存在', () => {
    // 子串判断（includes）会在这里出错：漏排 ⇒ add -A 把嵌套仓当 gitlink 提交。
    const existing = '/vendor/sdk-old/\n'
    const { added } = buildGitignoreBlock(existing, ['vendor/sdk'], 'T1')
    expect(added).toEqual(['/vendor/sdk/'])
  })

  test('用户手写的等价规则（含前后空白）也算已存在', () => {
    const { added } = buildGitignoreBlock('  /vendor/sdk/  \n', ['vendor/sdk'], 'T1')
    expect(added).toEqual([])
  })

  test('原文件不以换行结尾 ⇒ 补一个，规则不会粘到最后一行上', () => {
    const { nextContent } = buildGitignoreBlock('dist', ['a'], 'T1')
    expect(nextContent).toContain('dist\n')
    expect(nextContent).not.toContain('dist#')
  })

  test('区块标记可被识别（诊断 / 排错用）', () => {
    const { nextContent } = buildGitignoreBlock('', ['a'], 'T1')
    expect(hasAgentWorkflowBlock(nextContent)).toBe(true)
    expect(hasAgentWorkflowBlock('node_modules/\n')).toBe(false)
  })

  test('空规则列表 ⇒ 无操作（没有直接子挂载点的叶子仓不该产生 commit）', () => {
    const { nextContent, added } = buildGitignoreBlock('dist\n', [], 'T1')
    expect(added).toEqual([])
    expect(nextContent).toBe('dist\n')
  })
})
