// parseEnvelope — 损坏/未闭合端口检测（malformedPorts）回归锁。
//
// 为什么这条测试存在：用户报「agent 返回了 <workflow-output> 信封，但某端口的
// 闭合标签被污染成 `</|DSML|port>`（模型漏出 special token），导致 indexOf('</port>')
// 字面匹配失败 → 该端口被静默吞成空串 → 节点以 done 收场 → 下游文档审核节点拿到
// 空输入、不产审核文档；且因为只有特定 errorMessage 前缀才触发重试，agent 也不重试」。
//
// 根因有二：① parseEnvelope 把「开了 <port> 但找不到合法 </port>」(closeIdx<0)
// 静默 continue 成空串；② runner 只对该情况 log.warn、不置 failed，故 decideEnvelopeFollowup
// 永不触发。本测试锁定修复①：parseEnvelope 现把这类端口记入 malformedPorts，让 runner
// 能据此 fail+retry（修复②见 runner-malformed-port-followup.test.ts）。
//
// 同时锁定「不回归 RFC-103 T6 容器化解析的合法用例」：内容里出现字面 </port> /
// 字面 <port name= 时端口仍正常闭合、NOT malformed。

import { describe, expect, test } from 'bun:test'
import { parseEnvelope } from '../src/services/envelope'

describe('parseEnvelope malformedPorts — 未闭合/损坏端口检测', () => {
  test('用户场景：单端口 </port> 被污染成 </|DSML|port> → malformedPorts 命中、内容空、同时进 missingDeclared', () => {
    const xml = `<workflow-output>
<port name="doc">report.md</|DSML|port>
</workflow-output>`
    const r = parseEnvelope(xml, ['doc'])
    expect(r.malformedPorts).toContain('doc')
    // 端口未被采集 → 回落空串 + 进 missingDeclared（既有契约不变）。
    expect(r.ports.get('doc')).toBe('')
    expect(r.missingDeclared).toContain('doc')
  })

  test('漏掉整个 </port>（截断）→ malformedPorts 命中', () => {
    const xml = `<workflow-output><port name="summary">ok</workflow-output>`
    const r = parseEnvelope(xml, ['summary'])
    expect(r.malformedPorts).toContain('summary')
    expect(r.ports.get('summary')).toBe('')
    expect(r.missingDeclared).toContain('summary')
  })

  test('未声明端口未闭合也记入 malformedPorts（它会破坏其后端口的取帧）', () => {
    const xml = `<workflow-output><port name="extra">junk</|DSML|port></workflow-output>`
    const r = parseEnvelope(xml, ['doc'])
    expect(r.malformedPorts).toContain('extra')
    // 'doc' 是声明但 agent 没发 → 缺失但不是 malformed。
    expect(r.missingDeclared).toEqual(['doc'])
  })

  test('良构信封 → malformedPorts 为空（等价锚）', () => {
    const xml = `<workflow-output>
<port name="audit">findings</port>
<port name="summary">ok</port>
</workflow-output>`
    const r = parseEnvelope(xml, ['audit', 'summary'])
    expect(r.malformedPorts).toEqual([])
    expect(r.missingDeclared).toEqual([])
    expect(r.ports.get('audit')).toBe('findings')
  })

  test('合法留空端口（agent 真没发某声明端口）→ missingDeclared 但 NOT malformed', () => {
    const xml = `<workflow-output><port name="audit">x</port></workflow-output>`
    const r = parseEnvelope(xml, ['audit', 'summary'])
    expect(r.missingDeclared).toEqual(['summary'])
    expect(r.malformedPorts).toEqual([])
  })

  // —— 不回归 RFC-103 T6 的合法容器化解析 ——
  test('内容含字面 </port>（端口正常闭合）→ NOT malformed', () => {
    const xml = `<workflow-output><port name="x">a</port>b</port>c</port></workflow-output>`
    const r = parseEnvelope(xml, ['x'])
    expect(r.ports.get('x')).toBe('a</port>b</port>c')
    expect(r.malformedPorts).toEqual([])
  })

  test('内容含字面 <port name=（无前置 structural </port>）→ NOT malformed', () => {
    const xml = `<workflow-output><port name="a">talking about <port name="x"> syntax</port></workflow-output>`
    const r = parseEnvelope(xml, ['a'])
    expect(r.ports.get('a')).toBe('talking about <port name="x"> syntax')
    expect(r.malformedPorts).toEqual([])
  })

  // —— 吸收场景（signal #2，Codex impl-gate P2）——
  test('损坏端口非最后一个、其后有干净端口：被吸收的声明端口 b 仍判 malformed', () => {
    // a 的 </port> 损坏，其后 b 有干净 </port>：indexOf 找到 b 的闭合当作 a 的闭合，
    // a「吸收」了 b 的开标签与正文，b 落 missingDeclared。a 的 closeIdx>=0 故 signal #1
    // 看不到——但 b 是「声明却缺失、其开标签 <port name="b"> 仍在信封里」=被吸收，
    // signal #2 据此判 b malformed → runner fail+retry。修复 Codex 指出的多端口漏检。
    const xml = `<workflow-output>
<port name="a">aaa</|DSML|port>
<port name="b">bbb</port>
</workflow-output>`
    const r = parseEnvelope(xml, ['a', 'b'])
    expect(r.malformedPorts).toContain('b')
    expect(r.missingDeclared).toContain('b')
    // a 仍被吸收（解析层固有的二义性），但关键是 b 被判 malformed → 整个节点会失败重试，
    // 不会以 a 的脏内容 + b 空白静默 done。
    expect(r.ports.get('a')).toContain('<port name="b">bbb')
  })

  test('用户多端口场景：doc 损坏被 summary 吸收 → summary 判 malformed', () => {
    // 文档产出节点常同时发 doc + summary。doc 的 </port> 被污染、summary 干净时，
    // doc 吸收 summary、summary 进 missingDeclared。signal #2 把 summary 判 malformed，
    // 即便两个端口都没有校验型 outputKind，节点也会失败重试而非静默不产审核文档。
    const xml = `<workflow-output>
<port name="doc">report.md</|DSML|port>
<port name="summary">all good</port>
</workflow-output>`
    const r = parseEnvelope(xml, ['doc', 'summary'])
    expect(r.malformedPorts).toContain('summary')
  })

  test('合法留空不误伤：声明端口缺失但开标签不在信封 → NOT malformed（与吸收区分）', () => {
    // signal #2 的无误伤判别：合法省略的端口在信封里没有 <port name="P"> 开标签，
    // 故不会被判 malformed；被吸收的端口开标签仍在 → 才判。这条锁定该区分。
    const xml = `<workflow-output><port name="audit">findings</port></workflow-output>`
    const r = parseEnvelope(xml, ['audit', 'summary'])
    expect(r.missingDeclared).toEqual(['summary'])
    expect(r.malformedPorts).toEqual([])
  })
})
