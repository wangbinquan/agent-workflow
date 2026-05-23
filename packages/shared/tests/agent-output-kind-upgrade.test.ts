// RFC-060 PR-A — AgentOutputKindSchema 升级专项测试。
//
// 锁住的契约：
// 1. 历史三个字面值 'string' / 'markdown' / 'markdown_file' 仍是合法 AgentOutputKind。
// 2. 新增参数化字面值合法：'path<md>' / 'path<*>' / 'list<string>' / 'list<path<md>>'。
// 3. PR-A 未注册 'signal' 作为 base kind → AgentOutputKindSchema 拒绝（PR-B 解禁）。
// 4. 任意未注册 base name（'html' / 'foo'）拒绝。
// 5. Malformed 语法（'list<>' / 'path<.md>' / 'foo<bar>'）拒绝。

import { describe, expect, test } from 'bun:test'
import { kindsEqual, parseKind } from '../src/kindParser'
import { AGENT_OUTPUT_KIND, AgentOutputKindSchema } from '../src/schemas/review'

describe('AgentOutputKindSchema — legacy enum values stay valid', () => {
  test('every legacy AGENT_OUTPUT_KIND value passes', () => {
    for (const k of AGENT_OUTPUT_KIND) {
      expect(AgentOutputKindSchema.parse(k)).toBe(k)
    }
  })
})

describe('AgentOutputKindSchema — new parametric kinds', () => {
  test("'path<md>' valid (equivalent to 'markdown_file' alias)", () => {
    expect(AgentOutputKindSchema.parse('path<md>')).toBe('path<md>')
  })

  test("'path<*>' wildcard valid", () => {
    expect(AgentOutputKindSchema.parse('path<*>')).toBe('path<*>')
  })

  test("'path<markdown>' valid (different ext from 'md')", () => {
    expect(AgentOutputKindSchema.parse('path<markdown>')).toBe('path<markdown>')
  })

  test("'list<string>' valid", () => {
    expect(AgentOutputKindSchema.parse('list<string>')).toBe('list<string>')
  })

  test("'list<markdown>' valid", () => {
    expect(AgentOutputKindSchema.parse('list<markdown>')).toBe('list<markdown>')
  })

  test("'list<path<md>>' valid (nested parametric)", () => {
    expect(AgentOutputKindSchema.parse('list<path<md>>')).toBe('list<path<md>>')
  })

  test("'list<list<path<*>>>' valid (deep nesting)", () => {
    expect(AgentOutputKindSchema.parse('list<list<path<*>>>')).toBe('list<list<path<*>>>')
  })

  test("'list<markdown_file>' valid (alias inside list)", () => {
    expect(AgentOutputKindSchema.parse('list<markdown_file>')).toBe('list<markdown_file>')
  })
})

describe('AgentOutputKindSchema — base allowlist', () => {
  test("'signal' accepted (PR-B registered)", () => {
    expect(AgentOutputKindSchema.parse('signal')).toBe('signal')
  })

  test("'html' rejected (not in allowlist)", () => {
    expect(() => AgentOutputKindSchema.parse('html')).toThrow()
  })

  test("'foo' rejected", () => {
    expect(() => AgentOutputKindSchema.parse('foo')).toThrow()
  })

  test("'list<html>' rejected (item base not registered)", () => {
    expect(() => AgentOutputKindSchema.parse('list<html>')).toThrow()
  })

  test("'list<list<foo>>' rejected (deeply nested unknown base)", () => {
    expect(() => AgentOutputKindSchema.parse('list<list<foo>>')).toThrow()
  })

  test("'list<signal>' valid (signal nested in list)", () => {
    expect(AgentOutputKindSchema.parse('list<signal>')).toBe('list<signal>')
  })
})

describe('AgentOutputKindSchema — malformed syntax', () => {
  test('empty string rejected', () => {
    expect(() => AgentOutputKindSchema.parse('')).toThrow()
  })

  test("'list<>' rejected (empty body)", () => {
    expect(() => AgentOutputKindSchema.parse('list<>')).toThrow()
  })

  test("'path<.md>' rejected (leading dot in ext)", () => {
    expect(() => AgentOutputKindSchema.parse('path<.md>')).toThrow()
  })

  test("'foo<bar>' rejected (unknown parametric head)", () => {
    expect(() => AgentOutputKindSchema.parse('foo<bar>')).toThrow()
  })

  test("'list<int' rejected (unbalanced brackets)", () => {
    expect(() => AgentOutputKindSchema.parse('list<int')).toThrow()
  })

  test("'list<int>>' rejected (extra closing bracket)", () => {
    expect(() => AgentOutputKindSchema.parse('list<int>>')).toThrow()
  })
})

describe('AgentOutputKindSchema — round-trip with kindParser', () => {
  test("parsing 'markdown_file' stores original literal but parser folds to path<md>", () => {
    // schema preserves the raw input string (refine doesn't transform)
    expect(AgentOutputKindSchema.parse('markdown_file')).toBe('markdown_file')
    // but the parser folds for semantic comparison
    expect(kindsEqual(parseKind('markdown_file'), parseKind('path<md>'))).toBe(true)
  })
})
