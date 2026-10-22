import { expectDeploymentSelection } from './helpers/deploymentSelectionSource'
import { readDaemonGraphSource } from './helpers/daemonGraphSource'
// RFC-370: every real DA and DE root selects the same complete candidate receiver.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import {
  CandidatePublicationStore,
  MappedCandidateFactory,
} from './helpers/repositoryCandidatePublication'
import type { RepositoryCandidateEffectsFactory } from '@/modules/source-control/composition'
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

test('RFC-383 roots forward the selected candidate factory to both shared derive/delivery groups', () => {
  const load = (path: string) =>
    ts.createSourceFile(
      path,
      /(?:^|\/)bootstrap\/daemonStart\.ts$/.test(path)
        ? readDaemonGraphSource()
        : readFileSync(new URL('../src/' + path, import.meta.url), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    )
  for (const [path, receiver] of [['bootstrap/daemonApplication.ts', 'input']] as const) {
    const source = load(path)
    for (const name of [
      'composeDaemonDigitalEmployeeModules',
      'composeDaemonDevelopmentAutomationModules',
    ]) {
      const bindings = calls(source, name)
      expect(bindings).toHaveLength(1)
      expect(property(source, bindings[0]!, 'repositoryCandidateEffects')).toBe(
        `${receiver}.repositoryCandidateEffects`,
      )
    }
    for (const name of ['bindChangeCandidateParticipant', 'bindCandidateDeliveryParticipant'])
      expect(calls(source, name)).toHaveLength(0)
    expectDeploymentSelection('repositoryCandidateEffects', 'RepositoryCandidateEffectsFactory')
  }
  for (const path of [
    'bootstrap/daemonModules/digitalEmployee.ts',
    'bootstrap/daemonModules/developmentAutomation.ts',
  ]) {
    const source = load(path)
    for (const name of ['bindChangeCandidateParticipant', 'bindCandidateDeliveryParticipant']) {
      const bindings = calls(source, name)
      expect(bindings).toHaveLength(1)
      expect(property(source, bindings[0]!, 'candidateEffects')).toBe(
        'input.repositoryCandidateEffects',
      )
      if (name === 'bindCandidateDeliveryParticipant')
        expect(property(source, bindings[0]!, 'publicationTransport')).toBe(
          'repository.repositoryPublicationTransport',
        )
    }
  }
  const start = load('bootstrap/daemonStart.ts').text
  expectDeploymentSelection('repositoryCandidateEffects')
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
