// RFC-326 —— `review-doc` stub 模式：把提示词里声明的每个端口都填成同一份设计文档。
//
// 端口名从协议块的示例行（`  <port name="design">…</port>`）里读出——这样工作流叫什么
// 端口是夹具的事，stub 不用为每个 e2e 硬编码；`NAME` 占位与 `active="false"` 的说明行
// 不能被误认成端口。文档正文与 e2e/rfc326-mcp-review-tools.spec.ts 的 DOC 常量逐字一致。

import { expect, test } from 'bun:test'
import { declaredPorts, REVIEW_DOC_BODY } from '../src/runtime/mode-review-doc'

test('declaredPorts reads the protocol block examples and ignores the NAME placeholder', () => {
  const prompt = [
    'Emit `<port name="NAME" active="false">short reason</port>` for a skipped port.',
    '<workflow-output nonce="abc">',
    '  <port name="design">markdown placeholder</port>',
    '  <port name="notes">markdown placeholder</port>',
    '  <port name="design">repeated once more</port>',
    '</workflow-output>',
    'never `<port name="...">` unclosed',
  ].join('\n')
  expect(declaredPorts(prompt)).toEqual(['design', 'notes'])
  expect(declaredPorts('no ports here')).toEqual([])
})

// RFC-326 实现门 P2#12：端口解析必须**只**看带 nonce 的协议块。
test('declaredPorts ignores control ports outside the nonce block and keeps hyphenated names', () => {
  const prompt = [
    // 工作组 / 反问提示词里散落的控制端口——它们不是本轮要回答的输出端口。
    '<workflow-clarify nonce="abc"><port name="questions">…</port></workflow-clarify>',
    'A bare example: <workflow-output><port name="forged">x</port></workflow-output>',
    '<workflow-output nonce="abc">',
    '  <port name="design-doc">markdown placeholder</port>',
    '</workflow-output>',
  ].join('\n')
  expect(declaredPorts(prompt)).toEqual(['design-doc'])
})

test('the fixture document carries every shape the anchor resolver / highlighter must handle', () => {
  expect(REVIEW_DOC_BODY.startsWith('# Order status design\n')).toBe(true)
  expect(REVIEW_DOC_BODY).toContain('`order_status`')
  expect(REVIEW_DOC_BODY.split('partially_refunded').length - 1).toBe(2) // paragraph + code block
  expect(REVIEW_DOC_BODY).toContain('```ts\n')
  expect(REVIEW_DOC_BODY).toContain('<!-- reviewer note: not rendered -->')
})
