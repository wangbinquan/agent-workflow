// RFC-359 W40: share document serialization without moving either artifact writer.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { BundleSkillPayload } from '@agent-workflow/shared'
import { stringify as stringifyYaml } from 'yaml'
import ts from 'typescript'

import { renderResourcePackageSkillMarkdown } from '../src/modules/resource-catalog/infrastructure/resourcePackageSkillDocument'

type Payload = Pick<BundleSkillPayload, 'name' | 'description' | 'frontmatterExtra' | 'bodyMd'>

// Copied verbatim from both original production expressions. It remains an old-code oracle.
function originalResourcePackageSkillMarkdown(payload: Payload): string {
  return `---\n${stringifyYaml(
    { name: payload.name, description: payload.description, ...payload.frontmatterExtra },
    { lineWidth: 0 },
  )}---\n\n${payload.bodyMd}\n`
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
    const expected = '---\nname: example\ndescription: basic\n---\n\nBody\n'
    const actual = renderResourcePackageSkillMarkdown(payload)
    expect(actual).toBe(expected)
    expect(Buffer.from(actual, 'utf8')).toEqual(Buffer.from(expected, 'utf8'))
    expect(originalResourcePackageSkillMarkdown(payload)).toBe(expected)
  })

  test('keeps complete old rendering for ordinary multiline and extra values', () => {
    for (const payload of ordinaryPayloads) {
      const before = JSON.stringify(payload)
      const expected = originalResourcePackageSkillMarkdown(payload)
      const actual = renderResourcePackageSkillMarkdown(payload)
      expect(actual).toBe(expected)
      expect(Buffer.from(actual, 'utf8')).toEqual(Buffer.from(expected, 'utf8'))
      expect(JSON.stringify(payload)).toBe(before)
    }
  })

  test('preserves field-read order, read counts and thrown error identity', () => {
    const oldTrace: string[] = []
    const newTrace: string[] = []
    const expected = originalResourcePackageSkillMarkdown(observedPayload(oldTrace))
    const actual = renderResourcePackageSkillMarkdown(observedPayload(newTrace))
    expect(actual).toBe(expected)
    expect(newTrace).toEqual(oldTrace)
    expect(newTrace).toEqual(['name', 'description', 'frontmatterExtra', 'extra.label', 'bodyMd'])
    for (const fault of newTrace) {
      const sentinel = new Error(`original ${fault}`)
      const before: string[] = []
      const after: string[] = []
      const original = thrownBy(() =>
        originalResourcePackageSkillMarkdown(observedPayload(before, fault, sentinel)),
      )
      const current = thrownBy(() =>
        renderResourcePackageSkillMarkdown(observedPayload(after, fault, sentinel)),
      )
      expect(original).toBe(sentinel)
      expect(current).toBe(sentinel)
      expect(after).toEqual(before)
    }
  })

  test('both actual artifact writers consume the shared serializer at the original sites', () => {
    const pgSource = readFileSync(
      new URL(
        '../src/modules/resource-catalog/infrastructure/resourcePackageArtifacts.ts',
        import.meta.url,
      ),
      'utf8',
    )
    const sqliteSource = readFileSync(
      new URL(
        '../src/modules/resource-catalog/infrastructure/aggregateAdapters/legacyResourcePackageMutationParticipants.ts',
        import.meta.url,
      ),
      'utf8',
    )
    const parse = (source: string) =>
      ts.createSourceFile('owner.ts', source, ts.ScriptTarget.Latest, true)
    const pg = parse(pgSource)
    const sqlite = parse(sqliteSource)
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
      { local: 'skillMarkdown', module: "'./resourcePackageSkillDocument'" },
    ])
    expect(bindings(sqlite)).toEqual([
      { local: 'renderResourcePackageSkillMarkdown', module: "'../resourcePackageSkillDocument'" },
    ])
    expect(
      pg.statements.some(
        (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'skillMarkdown',
      ),
    ).toBe(false)
    const writer = sqlite.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === 'writeSkillTree',
    )
    if (writer?.body === undefined) throw new Error('Actual legacy writer missing')
    const initializers = writer.body.statements
      .flatMap((node) =>
        ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [],
      )
      .filter((node) => ts.isIdentifier(node.name) && node.name.text === 'skillMd')
    expect(initializers.length).toBe(1)
    expect(initializers[0]?.initializer?.getText(sqlite)).toBe(
      'renderResourcePackageSkillMarkdown(payload)',
    )
  })
})
