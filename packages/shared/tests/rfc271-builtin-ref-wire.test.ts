// RFC-271 —— `builtin:<type>/<name>` wire 形态的**词法层**接受/拒绝矩阵。
//
// 覆盖验收条款：AC-9（builtin 不入 resources，只入 builtins 声明）
//   （编号锚点由 rfc271-ac-coverage.test.ts 机械核查，别删）
//
// 这个形态是本 RFC 收尾时新加的第四种身份引用（前三种：`local:` / `external:` /
// 仅 agent skills 槽的 `project:`）。语义是用户拍板的：框架 built-in **照常导出、
// 标记出来、导入时自动忽略**——引用按**名字**绑到对端自己 seed 的那一个，因为源库
// 的 id 在对端没有任何意义，而复制一份只会得到 owner 错、`builtin=false` 的同名副本。
//
// 新增一种 wire 形态就是新增一片攻击面，所以这里把矩阵写全：**正例与反例同等重要**。

import { describe, expect, test } from 'bun:test'
import {
  BundleAgentSkillRefWireSchema,
  BundleCallRefWireSchema,
  BundleIdentityRefWireSchema,
} from '../src/bundle/payload'

const accepts = (s: string): boolean => BundleIdentityRefWireSchema.safeParse(s).success

describe('builtin: 词法层 —— 正例', () => {
  test('两种 built-in 类型都接受', () => {
    expect(accepts('builtin:agent/__skill_merger__')).toBe(true)
    expect(accepts('builtin:workflow/__agent_host__')).toBe(true)
  })

  test('普通资源名（非 `__` 开头）同样接受 —— builtin 与命名习惯无关', () => {
    // `builtin` 是 DB 上的一列，不是名字前缀约定。把判据绑到 `__` 前缀是错的。
    expect(accepts('builtin:agent/lint')).toBe(true)
  })

  test('既有三种形态不受影响（新增不得挤掉旧的）', () => {
    expect(accepts('local:agent-auditor')).toBe(true)
    expect(accepts('external:01ABCDEF')).toBe(true)
    // `project:` 只在 agent 的 skills 槽合法，身份槽不认——**域是收窄不是放宽**。
    expect(accepts('project:repo-helper')).toBe(false)
    expect(BundleAgentSkillRefWireSchema.safeParse('project:repo-helper').success).toBe(true)
  })
})

describe('builtin: 词法层 —— 反例', () => {
  test('只有 agent / workflow 两张表有 builtin 列，其余四类必须拒', () => {
    // 拿一个不存在 `builtin` 列的类型来指 built-in 是无意义的，词法层就该挡住。
    for (const t of ['skill', 'mcp', 'plugin', 'workgroup']) {
      expect({ t, ok: accepts(`builtin:${t}/foo`) }).toEqual({ t, ok: false })
    }
  })

  test('缺名字段 / 缺分隔符一律拒', () => {
    expect(accepts('builtin:agent/')).toBe(false)
    expect(accepts('builtin:agent')).toBe(false)
    expect(accepts('builtin:')).toBe(false)
    expect(accepts('builtin:/foo')).toBe(false)
  })

  test('类型段大小写敏感（`AGENT` 不是类型）', () => {
    expect(accepts('builtin:AGENT/foo')).toBe(false)
    expect(accepts('builtin:Workflow/foo')).toBe(false)
  })

  test('名字段有长度上限', () => {
    expect(accepts(`builtin:agent/${'x'.repeat(256)}`)).toBe(true)
    expect(accepts(`builtin:agent/${'x'.repeat(257)}`)).toBe(false)
  })

  test('前后有多余内容不接受（必须整串匹配），空白不得混进名字', () => {
    expect(accepts(' builtin:agent/foo')).toBe(false)
    expect(accepts('xbuiltin:agent/foo')).toBe(false)
    // ⚠️ 这条曾经**是绿的反面**：名字段原本写 `.{1,256}`，`.` 把尾随空格吃进名字，
    // 于是它通过词法层、只能靠「查不到」在语义层 fail closed。资源名字永远不含
    // 空白，所以改成 `\S{1,256}` 在词法层就挡住。
    expect(accepts('builtin:agent/foo ')).toBe(false)
    expect(accepts('builtin:agent/fo o')).toBe(false)
    expect(accepts('builtin:agent/\tfoo')).toBe(false)
  })
})

describe('builtin: 词法层 —— **刻意宽松**的两处，连同它们为什么安全', () => {
  // 这两条不是遗漏，是显式记录的判断。改窄它们要连这段注释一起改。
  test('名字段允许 `/` 与 `..` —— 词法层放行，语义层 fail closed', () => {
    expect(accepts('builtin:agent/a/b')).toBe(true)
    expect(accepts('builtin:agent/../../etc/passwd')).toBe(true)
  })

  test('为什么安全：这些名字**不可能命中任何真实资源**', () => {
    // `AGENT_NAME_RE` 只允许 `[a-z0-9_-]` 且必须以 `[a-z0-9]` 开头（agent.ts:98），
    // 所以 `a/b` / `../../etc/passwd` 这种名字在库里根本不存在 ⇒ `resolveBuiltin`
    // 查不到 ⇒ 抛 `bundle-builtin-missing`（fail closed，见
    // `rfc271-builtin-resolve.test.ts` 的解析层用例）。
    //
    // 而且它是**参数化 SQL 的一个值**（`eq(table.name, name)`），不是路径拼接，
    // `..` 在这里没有任何路径语义。
    //
    // 之所以不在词法层收紧到 `[a-z0-9_-]`：那要求 wire schema 知道每个资源类型
    // 各自的名字规则（agent 与 workflow 的规则并不相同），把 schema 与领域规则耦上。
    // 现在的分工是「词法层挡住形态错误、语义层挡住不存在」——两层各自可测。
    expect(/^[a-z0-9][a-z0-9_-]*$/.test('a/b')).toBe(false)
    expect(/^[a-z0-9][a-z0-9_-]*$/.test('../../etc/passwd')).toBe(false)
  })
})

describe('域是收窄不是放宽 —— builtin 不得渗进别的槽', () => {
  test('call 域接受 builtin 词法；具体槽的声明 type 由 definition walker 收窄', () => {
    expect(BundleCallRefWireSchema.safeParse('builtin:workflow/__agent_host__').success).toBe(true)
    expect(BundleCallRefWireSchema.safeParse('builtin:agent/__skill_merger__').success).toBe(true)
    expect(BundleCallRefWireSchema.safeParse('name:workflow/__agent_host__').success).toBe(true)
  })

  test('agent skills 槽不接受 builtin:（技能表没有 builtin 列）', () => {
    expect(BundleAgentSkillRefWireSchema.safeParse('builtin:agent/foo').success).toBe(false)
  })
})
