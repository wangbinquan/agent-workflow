// RFC-370: every real DA and DE root selects the same complete candidate receiver.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import {
  CandidatePublicationStore,
  MappedCandidateFactory,
} from './helpers/repositoryCandidatePublication'
import type { RepositoryCandidateEffectsFactory } from '@/modules/source-control/public/types'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'

function calls(source: ts.SourceFile, name: string) {
  const found: ts.CallExpression[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === name) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function property(source: ts.SourceFile, call: ts.CallExpression, key: string) {
  const input = call.arguments[0]
  if (input === undefined || !ts.isObjectLiteralExpression(input))
    throw new Error('candidate root needs explicit complete input')
  const named = input.properties.filter(
    (node): node is ts.PropertyAssignment =>
      ts.isPropertyAssignment(node) && node.name.getText(source) === key,
  )
  expect(named).toHaveLength(1)
  const names = input.properties
    .filter((node) => ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node))
    .map((node) => node.name.getText(source))
  expect(new Set(names).size).toBe(names.length)
  return named[0]!.initializer.getText(source)
}

test('all six actual derive and delivery groups forward the same candidate factory and original transport', () => {
  for (const [path, receiver] of [
    ['cli/start.ts', 'input'],
    ['cli/postgresqlDaemonApplication.ts', 'input'],
    ['server.ts', 'deps'],
  ] as const) {
    const source = ts.createSourceFile(
      path,
      readFileSync(new URL('../src/' + path, import.meta.url), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    )
    for (const name of ['bindChangeCandidateParticipant', 'bindCandidateDeliveryParticipant']) {
      const bindings = calls(source, name)
      expect(bindings).toHaveLength(2)
      for (const binding of bindings) {
        expect(property(source, binding, 'candidateEffects')).toBe(
          `${receiver}.repositoryCandidateEffects`,
        )
        if (name === 'bindCandidateDeliveryParticipant') {
          expect([
            'repositoryPublicationTransport',
            'deps.repositoryPublicationTransport',
          ]).toContain(property(source, binding, 'publicationTransport'))
        }
      }
    }
    expect(source.text).toContain('repositoryCandidateEffects?: RepositoryCandidateEffectsFactory')
  }
  const start = readFileSync(new URL('../src/cli/start.ts', import.meta.url), 'utf8')
  expect(start).toContain('repositoryCandidateEffects: opts.repositoryCandidateEffects,')
  expect(start.split('repositoryCandidateEffects: input.repositoryCandidateEffects,')).toHaveLength(
    3,
  )
})

describeEachProviderHttpApplication(
  'RFC-370 complete candidate factory at actual HTTP/provider roots',
  { token: 'd'.repeat(64), dbVersion: 17, opencodeVersion: null, tempPrefix: 'aw-candidate-root-' },
  (scope) => {
    test('incomplete receiver rejects and a frozen complete prototype receiver assembles without candidate allocation', async () => {
      const error: unknown = await scope
        .open({
          repositoryCandidateEffects: {} as RepositoryCandidateEffectsFactory,
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        )
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe('repository-candidate-effects-incomplete')
      const store = new CandidatePublicationStore()
      const factory = Object.freeze(new MappedCandidateFactory(store))
      const opened = await scope.open({ repositoryCandidateEffects: factory })
      expect(opened.app).toBeDefined()
      expect(store.acquisitions).toEqual([])
      expect(store.workspacesCreated).toBe(0)
      expect(store.publicationOpens).toBe(0)
    }, 120_000)
  },
)
