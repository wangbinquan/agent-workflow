// RFC-203 PR-2（T3a/T3b）—— L1 词条完整性锁。为什么存在：错误词条表是
// zh/en 两份手维护的 Record，没有 interface 同构约束（刻意用 Record 免动
// interface），一旦漂移（只加一边 / 键名打错 / 孤儿 hint）用户就会看到
// 英文键名或缺失文案。本文件把 proposal §5-A3 的验收固化成可跑断言：
//   1. zh/en 键集完全同构；L1 基础键 ≥150；hint 必须配对基础键；
//   2. errorDomains 恒为 19 域（与 resolver 的 ErrorDomain 并集一致）；
//   3. skill-source-* 孤儿键清零且不得回潮；
//   4. 文案风格铁律：值非空、不含未插值的 ${、不含内部术语、标题不等于
//      code 本身（防「机器码泄漏为标题」）；
//   5. Tier-2 wire 码必须全部 L1（route-not-found / oidc-* / ws 四码 /
//      opencode-models-failed / resume-failed）。
import { describe, expect, test } from 'vitest'
import { zhCN } from '../src/i18n/zh-CN'
import { enUS } from '../src/i18n/en-US'

const zh = zhCN.errors
const en = enUS.errors
const zhKeys = new Set(Object.keys(zh))
const enKeys = new Set(Object.keys(en))
const baseKeys = [...zhKeys].filter((k) => !k.endsWith('__hint'))

describe('RFC-203 L1 词条完整性', () => {
  test('zh/en 键集完全同构', () => {
    expect([...zhKeys].filter((k) => !enKeys.has(k))).toEqual([])
    expect([...enKeys].filter((k) => !zhKeys.has(k))).toEqual([])
  })

  test('L1 基础键 ≥150（proposal §5-A3）', () => {
    expect(baseKeys.length).toBeGreaterThanOrEqual(150)
  })

  test('每个 __hint 都有对应基础键', () => {
    const orphans = [...zhKeys]
      .filter((k) => k.endsWith('__hint'))
      .filter((k) => !zhKeys.has(k.slice(0, -'__hint'.length)))
    expect(orphans).toEqual([])
  })

  test('errorDomains 19 域齐全且与 resolver 域集一致', () => {
    const expected = [
      'agent',
      'auth',
      'clarify',
      'fusion',
      'lifecycle',
      'mcp',
      'memory',
      'misc',
      'plugin',
      'repo',
      'review',
      'runtime',
      'schedule',
      'skill',
      'task',
      'taskQuestion',
      'upload',
      'workflow',
      'workgroup',
    ]
    expect(Object.keys(zhCN.errorDomains).sort()).toEqual(expected)
    expect(Object.keys(enUS.errorDomains).sort()).toEqual(expected)
  })

  test('skill-source-* 孤儿键已清零、不得回潮', () => {
    expect([...zhKeys].filter((k) => k.startsWith('skill-source-'))).toEqual([])
  })

  test('文案风格：非空、无 ${ 残留、无内部术语、标题不等于 code', () => {
    const banned = ['node_run', 'envelope', 'multipart body', 'frontmatter']
    for (const [k, v] of [...Object.entries(zh), ...Object.entries(en)]) {
      expect(v.trim(), `empty value for ${k}`).not.toBe('')
      expect(v.includes('${'), `raw template literal leaked into ${k}`).toBe(false)
      expect(v, `title of ${k} must not be the bare code`).not.toBe(k)
      for (const b of banned) {
        expect(v.includes(b), `internal term '${b}' leaked into ${k}`).toBe(false)
      }
    }
  })

  test('Tier-2 wire 码全部有 L1 词条', () => {
    const wire = [
      'route-not-found',
      'ws-unknown-channel',
      'auth-required',
      'admin-required',
      'task-not-visible',
      'opencode-models-failed',
      'resume-failed',
      'oidc-not-configured',
      'oidc-provider-not-found',
      'oidc-discovery-incomplete',
      'network-unreachable',
      'internal-error',
      'unauthorized',
      'forbidden',
    ]
    expect(wire.filter((c) => !zhKeys.has(c))).toEqual([])
  })

  test('抽查：高频词条的中文形态（用户语言、句子、无术语）', () => {
    expect(zh['task-not-found']).toBe('任务不存在。')
    expect(zh['workflow-version-conflict']).toBe('工作流已被他人更新，请刷新后重试。')
    expect(zh['repo-clone-failed']).toBe('git clone 失败。')
    expect(zh['skill-quarantined__hint']).toContain('重启 daemon')
    expect(en['agent-name-in-use']).toBe('An agent with this name already exists.')
  })
})
