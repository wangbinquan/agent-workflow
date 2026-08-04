// 2026-08-04 沙箱/containment 审计「根因 2：能力收缩没有影响清单」批的 claude 侧回归锁。
//
// 两条都属于同一个病：为收窄安全面而加的开关，把**目标用户自己的功能**关掉了，
// 而且全链零告警。CLAUDE.md 今天新增的「能力收缩型 RFC 附加门槛」防的正是这个。
//
//   1. `--disable-slash-commands` 被无条件下发。CLI 自己的 help 原文是
//      **"Disable all skills"**，而不是代码注释里写的「防 config-dir skills 的纵深
//      防御」。于是一个「声明了权限 + 选了技能」的节点：技能整棵树照常 stage 进私有
//      配置目录、`skill:'allow'` 照常翻成 `--tools …,Skill`、然后被这个 flag 全部关掉。
//      同一次 spawn 里三处互相矛盾。
//   2. 无 `'*'` 键时 baseline 是 deny，而 opencode 的内置 defaults 是
//      `{"*":"allow", …}` 后再 merge 用户声明。同一份 `{bash:'deny'}` 在 opencode 上是
//      「除 bash 外全开」、在 claude 上是 `--tools ""`（help 原文：Use "" to disable
//      all tools）——节点起得来、模型出话、一个工具都没有，且不产生任何 warning。

import { describe, expect, test } from 'bun:test'
import { claudeDeclaredControlArgv } from '../src/services/runtime/claudeCode/spawn'
import { mapAgentPermissionToClaudeTools } from '../src/services/runtime/claudeCode/permissionMap'

describe('--disable-slash-commands 只在没有授予 Skill 时下发', () => {
  test('未授予 Skill ⇒ 仍然下发（历史形状不变）', () => {
    const argv = claudeDeclaredControlArgv({ tools: 'Read,Grep' })
    expect(argv).toContain('--disable-slash-commands')
  })

  test('授予了 Skill ⇒ 不下发，否则等于把该节点的技能全部关掉', () => {
    const argv = claudeDeclaredControlArgv({ tools: 'Read,Skill', skillsGranted: true })
    expect(argv).not.toContain('--disable-slash-commands')
    // 其余受控 flag 一个都不能少——本修复只放开这一个。
    expect(argv).toContain('--strict-mcp-config')
    expect(argv).toContain('--setting-sources')
    expect(argv.slice(0, 2)).toEqual(['--permission-mode', 'dontAsk'])
  })
})

describe('权限映射：授予为空必须告警', () => {
  test('纯 deny 声明 ⇒ 零工具 + 明确告警（此前静默）', () => {
    const gate = mapAgentPermissionToClaudeTools({ bash: 'deny', edit: 'deny' })
    expect(gate.tools).toEqual([])
    expect(gate.warnings.some((w) => w.includes('grants no claude built-in tool'))).toBe(true)
  })

  test('通配 allow ⇒ 有工具、无该告警', () => {
    const gate = mapAgentPermissionToClaudeTools({ '*': 'allow', bash: 'deny' })
    expect(gate.tools.length).toBeGreaterThan(0)
    expect(gate.warnings.some((w) => w.includes('grants no claude built-in tool'))).toBe(false)
  })
})
