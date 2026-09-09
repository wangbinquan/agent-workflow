// RFC-359 W47: intent and package artifacts share their existing SKILL.md serializer.
// Only document generation moves; both filesystem writers retain their original bodies.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { stringify as stringifyYaml } from 'yaml'
import ts from 'typescript'

import { renderResourcePackageSkillMarkdown } from '../src/modules/resource-catalog/infrastructure/resourcePackageSkillDocument'

type Payload = Parameters<typeof renderResourcePackageSkillMarkdown>[0]

// Original production renderers, including the optional-extra fallback on the async owner.
function originalPostgresqlMarkdown(payload: Payload): string {
  return `---\n${stringifyYaml(
    {
      name: payload.name,
      description: payload.description,
      ...(payload.frontmatterExtra ?? {}),
    },
    { lineWidth: 0 },
  )}---\n\n${payload.bodyMd}\n`
}

function originalLegacyMarkdown(payload: Payload): string {
  return `---\n${stringifyYaml(
    {
      name: payload.name,
      description: payload.description,
      ...payload.frontmatterExtra,
    },
    { lineWidth: 0 },
  )}---\n\n${payload.bodyMd}\n`
}

const originals = [originalPostgresqlMarkdown, originalLegacyMarkdown]
const payloads: readonly Payload[] = [
  { name: 'simple', description: '', bodyMd: 'Body' },
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
    frontmatterExtra: { name: 'final-name', description: 'final-description' },
    bodyMd: 'literal --- and : stay in the body',
  },
]

test('intent document bytes equal both original renderers for the complete payload matrix', () => {
  expect(renderResourcePackageSkillMarkdown(payloads[0]!)).toBe(
    '---\nname: simple\ndescription: ""\n---\n\nBody\n',
  )
  for (const payload of payloads) {
    const before = JSON.stringify(payload)
    for (const original of originals) {
      expect(Buffer.from(renderResourcePackageSkillMarkdown(payload))).toEqual(
        Buffer.from(original(payload)),
      )
    }
    expect(JSON.stringify(payload)).toBe(before)
  }
})

function observedPayload(trace: string[], fault?: string, sentinel?: Error): Payload {
  const read = (field: string) => {
    trace.push(field)
    if (field === fault) throw sentinel
  }
  return {
    get name() {
      read('name')
      return 'observed-name'
    },
    get description() {
      read('description')
      return 'observed-description'
    },
    get frontmatterExtra() {
      read('frontmatterExtra')
      return {
        get label() {
          read('extra.label')
          return 'label'
        },
      }
    },
    get bodyMd() {
      read('bodyMd')
      return 'observed-body'
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

test('shared intent rendering preserves field-read order and immediate error identity', () => {
  const fields = ['name', 'description', 'frontmatterExtra', 'extra.label', 'bodyMd']
  for (const original of originals) {
    const before: string[] = []
    const after: string[] = []
    expect(renderResourcePackageSkillMarkdown(observedPayload(after))).toBe(
      original(observedPayload(before)),
    )
    expect(after).toEqual(before)
    expect(after).toEqual(fields)
    for (const field of fields) {
      const sentinel = new Error(field)
      const oldTrace: string[] = []
      const newTrace: string[] = []
      expect(thrownBy(() => original(observedPayload(oldTrace, field, sentinel)))).toBe(sentinel)
      expect(
        thrownBy(() =>
          renderResourcePackageSkillMarkdown(observedPayload(newTrace, field, sentinel)),
        ),
      ).toBe(sentinel)
      expect(newTrace).toEqual(oldTrace)
    }
  }
})

test('both actual intent artifact writers call the existing shared serializer', () => {
  const owners = [
    ['postgresqlIntentApplyArtifactOwners', 'skillMarkdown'],
    ['legacyIntentApplyResourceParticipants', 'renderResourcePackageSkillMarkdown'],
  ] as const
  for (const [owner, local] of owners) {
    const source = ts.createSourceFile(
      `${owner}.ts`,
      readFileSync(
        new URL(
          `../src/modules/resource-catalog/infrastructure/aggregateAdapters/${owner}.ts`,
          import.meta.url,
        ),
        'utf8',
      ),
      ts.ScriptTarget.Latest,
      true,
    )
    const imports = source.statements.flatMap((node) => {
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
        .map((item) => [node.moduleSpecifier.getText(source), item.name.text])
    })
    expect(imports).toEqual([["'../resourcePackageSkillDocument'", local]])
    expect(
      source.statements.some(
        (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'skillMarkdown',
      ),
    ).toBe(false)
    const writer = source.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === 'writeSkillTree',
    )
    if (writer?.body === undefined) throw new Error('Actual intent artifact writer missing')
    const calls: string[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === local)
        calls.push(node.getText(source))
      ts.forEachChild(node, visit)
    }
    visit(writer.body)
    expect(calls).toEqual([`${local}(payload)`])
  }
})
