// RFC-359 W40: share document serialization without moving either artifact writer.
// RFC-401 T5（design §2.3）：技能 Markdown 固定一份字节合同，普通编辑、Intent、资源包共用；本文件改为锁定统一合同，旧的资源包
// 渲染式留作「存量字节」的来源——与新内容解析等价的旧文档原样保留，不产生新版本。
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { BundleSkillPayload } from '@agent-workflow/shared'
import { stringify as stringifyYaml } from 'yaml'
import ts from 'typescript'

import { renderResourcePackageSkillMarkdown } from '../src/modules/resource-catalog/infrastructure/resourcePackageSkillDocument'

type Payload = Pick<BundleSkillPayload, 'name' | 'description' | 'frontmatterExtra' | 'bodyMd'>

// The pre-RFC-401 resource-package expression, copied verbatim: stored skills still carry these bytes.
function originalResourcePackageSkillMarkdown(payload: Payload): string {
  return `---\n${stringifyYaml(
    { name: payload.name, description: payload.description, ...payload.frontmatterExtra },
    { lineWidth: 0 },
  )}---\n\n${payload.bodyMd}\n`
}

// The single byte contract, written independently of the implementation under test.
function contractSkillMarkdown(payload: Payload): string {
  const yaml = stringifyYaml(
    { name: payload.name, description: payload.description, ...payload.frontmatterExtra },
    { lineWidth: 0 },
  )
  const body = payload.bodyMd
  return `---\n${yaml.slice(0, -1)}\n---\n${body}`
}

const ordinaryPayloads: readonly Payload[] = [
  { name: '', description: '', frontmatterExtra: {}, bodyMd: '' },
  {
    name: '多语言 🪶',
    description: 'first line\nsecond: line',
    frontmatterExtra: { labels: ['alpha', 'β'], settings: { count: 2, enabled: true }, note: null },
    bodyMd: '# Title\r\n\nBody 😀\n',
  },
  {
    name: 'long-document',
    description: 'ordinary text '.repeat(20),
    frontmatterExtra: { zeta: 'last value', alpha: 'first value' },
    bodyMd: 'Trailing spaces  \n\n',
  },
  {
    name: 'initial-name',
    description: 'initial-description',
    frontmatterExtra: { label: 'one', name: 'final-name', description: 'final-description' },
    bodyMd: 'literal --- and : stay in the body',
  },
]

function observedPayload(trace: string[], fault?: string, sentinel?: Error): Payload {
  const read = (field: string) => {
    trace.push(field)
    if (field === fault) throw sentinel
  }
  const extra = {
    get label() {
      read('extra.label')
      return 'observed'
    },
  }
  return {
    get name() {
      read('name')
      return 'getter-name'
    },
    get description() {
      read('description')
      return 'getter-description'
    },
    get frontmatterExtra() {
      read('frontmatterExtra')
      return extra
    },
    get bodyMd() {
      read('bodyMd')
      return 'getter-body'
    },
  }
}

function thrownBy(operation: () => unknown): unknown {
  try {
    operation()
  } catch (error) {
    return error
  }
  throw new Error('Expected the original property-read error')
}

describe('RFC359 W40 resource-package skill document', () => {
  test('returns exact document delimiters, field values and UTF-8 bytes', () => {
    const payload: Payload = {
      name: 'example',
      description: 'basic',
      frontmatterExtra: {},
      bodyMd: 'Body',
    }
    const expected = '---\nname: example\ndescription: basic\n---\nBody'
    const actual = renderResourcePackageSkillMarkdown(payload)
    expect(actual).toBe(expected)
    expect(Buffer.from(actual, 'utf8')).toEqual(Buffer.from(expected, 'utf8'))
    expect(contractSkillMarkdown(payload)).toBe(expected)
  })

  test('renders the single contract for ordinary multiline and extra values', () => {
    for (const payload of ordinaryPayloads) {
      const before = JSON.stringify(payload)
      const expected = contractSkillMarkdown(payload)
      const actual = renderResourcePackageSkillMarkdown(payload)
      expect(actual).toBe(expected)
      expect(Buffer.from(actual, 'utf8')).toEqual(Buffer.from(expected, 'utf8'))
      expect(JSON.stringify(payload)).toBe(before)
    }
  })

  test('a stored document written by the old serializer keeps its bytes when parse-equivalent', () => {
    for (const payload of ordinaryPayloads) {
      const stored = originalResourcePackageSkillMarkdown(payload)
      expect(renderResourcePackageSkillMarkdown(payload, stored)).toBe(stored)
      // 真变化写新字节。
      const changed = { ...payload, bodyMd: `${payload.bodyMd} changed` }
      expect(renderResourcePackageSkillMarkdown(changed, stored)).toBe(
        contractSkillMarkdown(changed),
      )
    }
  })

  test('preserves field-read order, read counts and thrown error identity', () => {
    const oldTrace: string[] = []
    const newTrace: string[] = []
    const expected = contractSkillMarkdown(observedPayload(oldTrace))
    const actual = renderResourcePackageSkillMarkdown(observedPayload(newTrace))
    expect(actual).toBe(expected)
    expect(newTrace).toEqual(oldTrace)
    expect(newTrace).toEqual(['name', 'description', 'frontmatterExtra', 'extra.label', 'bodyMd'])
    for (const fault of newTrace) {
      const sentinel = new Error(`original ${fault}`)
      const before: string[] = []
      const after: string[] = []
      const original = thrownBy(() =>
        contractSkillMarkdown(observedPayload(before, fault, sentinel)),
      )
      const current = thrownBy(() =>
        renderResourcePackageSkillMarkdown(observedPayload(after, fault, sentinel)),
      )
      expect(original).toBe(sentinel)
      expect(current).toBe(sentinel)
      expect(after).toEqual(before)
    }
  })

  test('唯一那个工件写出点消费共享序列化器（不得复辟一份私有实现）', () => {
    // RFC-359（apply 引擎合一，plan §5dy）：**写出点从两个变成一个**——legacy 那份
    // （`legacyResourcePackageMutationParticipants.ts` 的 `writeSkillTree`）随通用 bundle 引擎退役。
    // 判据因此从「两侧都消费同一份序列化器」收成「唯一那一侧消费它，且本文件没有私有副本」。
    const pgSource = readFileSync(
      new URL(
        '../src/modules/resource-catalog/infrastructure/local/fileResourcePackageArtifacts.ts',
        import.meta.url,
      ),
      'utf8',
    )
    const pg = ts.createSourceFile('owner.ts', pgSource, ts.ScriptTarget.Latest, true)
    const bindings = (source: ts.SourceFile) =>
      source.statements.flatMap((node) => {
        if (
          !ts.isImportDeclaration(node) ||
          !node.importClause?.namedBindings ||
          !ts.isNamedImports(node.importClause.namedBindings)
        )
          return []
        return node.importClause.namedBindings.elements
          .filter(
            (item) =>
              (item.propertyName?.text ?? item.name.text) === 'renderResourcePackageSkillMarkdown',
          )
          .map((item) => ({ local: item.name.text, module: node.moduleSpecifier.getText(source) }))
      })
    expect(bindings(pg)).toEqual([
      { local: 'skillMarkdown', module: "'../resourcePackageSkillDocument'" },
    ])
    // 「复辟一份私有实现」的反向锁：本文件里不得再出现同名的本地函数声明。
    expect(
      pg.statements.some(
        (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'skillMarkdown',
      ),
    ).toBe(false)
  })
})
