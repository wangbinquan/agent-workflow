// RFC-103 T6 (调研报告 05-PORT-02) — 信封端口边界容器化解析回归锁。
//
// 为什么这条测试存在：parseEnvelope 原用非贪婪 `<port ...>([\s\S]*?)</port>`，
// 端口内容若自身含字面 </port>（如讨论协议的代码块）会被截断、丢后续内容且无
// 告警。修复改为容器化：端口内容延伸到下一个 <port name=（或 envelope 末尾），
// 区间内最后一个 </port> 才是真闭合。本测试锁定：① 字面 </port> 完整保留；
// ② 重复 port 名「后者胜出」；③ extractLastEnvelope「最后一个 envelope 胜出」
// 不被破坏；④ 负向：内容含字面 <port name= 时按文档残留限制 mis-frame（协议禁止）。
import { describe, expect, test } from 'bun:test'
import { parseEnvelope, extractLastEnvelope } from '../src/services/envelope'

describe('RFC-103 T6 parseEnvelope — 容器化端口边界', () => {
  test('端口内容含字面 </port> 被完整保留（不再截断）', () => {
    const xml = `<workflow-output>
<port name="a">code: </port> still part of a</port>
<port name="b">B body</port>
</workflow-output>`
    const r = parseEnvelope(xml, ['a', 'b'])
    expect(r.ports.get('a')).toBe('code: </port> still part of a')
    expect(r.ports.get('b')).toBe('B body')
  })

  test('单端口、内容多次出现 </port>：只最后一个作闭合', () => {
    const xml = `<workflow-output><port name="x">a</port>b</port>c</port></workflow-output>`
    expect(parseEnvelope(xml, ['x']).ports.get('x')).toBe('a</port>b</port>c')
  })

  test('重复 port 名 → 后者胜出', () => {
    const xml = `<workflow-output><port name="a">first</port><port name="a">second</port></workflow-output>`
    expect(parseEnvelope(xml, ['a']).ports.get('a')).toBe('second')
  })

  test('正常多端口解析正确（等价锚）', () => {
    const xml = `<workflow-output>
<port name="audit">findings here</port>
<port name="summary">all good</port>
</workflow-output>`
    const r = parseEnvelope(xml, ['audit', 'summary'])
    expect(r.ports.get('audit')).toBe('findings here')
    expect(r.ports.get('summary')).toBe('all good')
    expect(r.missingDeclared).toEqual([])
  })

  test('未声明端口进 undeclared；缺失端口进 missingDeclared', () => {
    const xml = `<workflow-output><port name="known">x</port><port name="extra">y</port></workflow-output>`
    const r = parseEnvelope(xml, ['known', 'absent'])
    expect(r.ports.get('absent')).toBe('')
    expect(r.missingDeclared).toContain('absent')
    expect(r.undeclared.map((u) => u.name)).toContain('extra')
  })

  test('extractLastEnvelope：多个 envelope「最后一个胜出」不被破坏', () => {
    const text = `<workflow-output><port name="a">OLD</port></workflow-output>
some chatter
<workflow-output><port name="a">NEW</port></workflow-output>`
    const last = extractLastEnvelope(text)
    expect(last).not.toBeNull()
    expect(parseEnvelope(last!, ['a']).ports.get('a')).toBe('NEW')
  })

  test('内容含字面 <port name=（无 </port> 在前）被完整保留', () => {
    // structural-close 启发式：单独的字面 <port name= 不构成端口边界（它前面没有
    // structural </port>），后面的 </port> 才是 a 的真闭合 → 完整保留。
    const xml = `<workflow-output><port name="a">talking about <port name="x"> syntax</port></workflow-output>`
    expect(parseEnvelope(xml, ['a']).ports.get('a')).toBe('talking about <port name="x"> syntax')
  })

  test('fenced 代码块内含 fake <port> + </port> 仍归属外层端口（与既有 K2 用例同源）', () => {
    const xml = `<workflow-output>
<port name="design">
# Title
\`\`\`xml
<port name="fake">should be ignored as md content</port>
\`\`\`
</port>
</workflow-output>`
    const content = parseEnvelope(xml, ['design']).ports.get('design')!
    expect(content).toContain('```xml')
    expect(content).toContain('<port name="fake">')
    expect(content).toContain('</port>') // 内层 </port> 也保留
  })

  test('缺失闭合 </port> 的端口判为缺失 + malformedPorts（不静默标成功）—— Codex impl-gate P2 + 损坏端口急修', () => {
    // 端口无 structural close（漏了 </port>）→ 不采集 → missingDeclared，而非
    // 把 envelope 剩余内容误当作该端口的值标成功（旧非贪婪正则也要求 </port>）。
    //
    // 急修补强（2026-06-24）：原注释说这条「走 repair」，但 missingDeclared 从不驱动
    // 失败（runner 只 log.warn），所以无 outputKind 的端口空着也以 done 收场、不重试。
    // 现在 parseEnvelope 额外把它记入 malformedPorts，runner 据此 fail+retry。
    // 详见 envelope-malformed-port.test.ts / runner-malformed-port-followup.test.ts。
    const xml = `<workflow-output><port name="summary">ok</workflow-output>`
    const r = parseEnvelope(xml, ['summary'])
    expect(r.ports.get('summary')).toBe('')
    expect(r.missingDeclared).toContain('summary')
    expect(r.malformedPorts).toContain('summary')
  })

  test('负向（真·残留限制）：内容含 </port> 紧跟 <port name= 会 mis-frame —— 协议禁止', () => {
    // 仅当内容里出现「</port> 后面紧跟 <port name=」这个伪边界时才会错切；这是
    // 已声明的协议约束（端口内容不得含此序列），此处锁定为「有意」残留。
    const xml = `<workflow-output><port name="a">stuff</port>\n<port name="fake">x</port></workflow-output>`
    const r = parseEnvelope(xml, ['a'])
    expect(r.ports.get('a')).toBe('stuff')
    expect(r.undeclared.map((u) => u.name)).toContain('fake')
  })
})
