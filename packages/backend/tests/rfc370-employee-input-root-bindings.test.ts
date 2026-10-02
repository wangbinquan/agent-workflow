import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

import type { EmployeeInputArtifactPort } from '@/modules/digital-employee/composition'
import { employeeInputUploads } from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'

const load = (path: string) =>
  ts.createSourceFile(
    path,
    readFileSync(new URL('../src/' + path, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )

function calls(source: ts.SourceFile, expression: string) {
  const result: ts.CallExpression[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === expression)
      result.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

test('real boot and HTTP roots choose one complete input receiver for both intake and materialization', () => {
  for (const [path, receiver, variable] of [
    ['cli/start.ts', 'input', 'employeeInputArtifacts'],
    ['cli/postgresqlDaemonApplication.ts', 'input', 'employeeInputArtifacts'],
    ['server.ts', 'deps', 'inputArtifacts'],
  ]) {
    const source = load(path!)
    const defaults = calls(source, 'createEmployeeInputArtifactStore')
    expect(defaults).toHaveLength(1)
    const selection = defaults[0]!.parent
    expect(ts.isBinaryExpression(selection)).toBe(true)
    if (!ts.isBinaryExpression(selection)) throw new Error('selected input store is missing')
    expect(selection.left.getText(source)).toBe(`${receiver}.employeeInputArtifacts`)
    expect(selection.operatorToken.kind).toBe(ts.SyntaxKind.QuestionQuestionToken)
    for (const expression of ['composeDigitalEmployee', 'composeDevelopmentEmployeeWorkspace']) {
      const consumers = calls(source, expression)
      expect(consumers).toHaveLength(1)
      const input = consumers[0]!.arguments[0]!
      expect(ts.isObjectLiteralExpression(input)).toBe(true)
      if (!ts.isObjectLiteralExpression(input)) throw new Error('consumer binding is missing')
      const bindings = input.properties.filter(
        (property): property is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
          (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
          property.name.getText(source) === 'inputArtifacts',
      )
      expect(bindings).toHaveLength(1)
      const binding = bindings[0]!
      const value = ts.isShorthandPropertyAssignment(binding) ? binding.name : binding.initializer
      expect(value.getText(source)).toBe(variable!)
    }
  }
  const start = load('cli/start.ts')
  expect(start.text).toContain('employeeInputArtifacts: opts.employeeInputArtifacts,')
  expect(start.text.split('employeeInputArtifacts: input.employeeInputArtifacts,')).toHaveLength(3)
  expect(start.text).toContain('readonly employeeInputArtifacts?: EmployeeInputArtifactPort')
  expect(start.text).toContain('...sessionInput,')
})

const payload = new Uint8Array([0, 255, 65, 10])
const digest = sha256Hex(payload)

class SelectedInputStorage implements EmployeeInputArtifactPort {
  #captures = 0
  readonly entered = Promise.withResolvers<void>()
  readonly ready = Promise.withResolvers<void>()
  readonly failure = new Error('selected-input-capture-unavailable')

  constructor(readonly outcome: 'saved' | 'failure') {}

  get captures() {
    return this.#captures
  }

  async putFile(absolutePath: string) {
    this.#captures += 1
    expect([...readFileSync(absolutePath)]).toEqual([...payload])
    this.entered.resolve()
    await this.ready.promise
    if (this.outcome === 'failure') throw this.failure
    return { blobRef: 'object:employee-input/1', sha256: digest, bytes: payload.byteLength }
  }

  async hasBlob() {
    return true
  }

  copyBlobTo() {
    throw new Error('HTTP intake does not materialize a workspace')
  }
}

describeEachProviderHttpApplication(
  'RFC-370 selected employee input store at the actual HTTP root',
  {
    token: 'd'.repeat(64),
    dbVersion: 17,
    opencodeVersion: null,
    tempPrefix: 'aw-rfc370-input-root-',
  },
  (scope) => {
    for (const outcome of ['saved', 'failure'] as const) {
      test(`upload waits for prototype capture ACK and preserves ${outcome} ledger semantics`, async () => {
        const selected = new SelectedInputStorage(outcome)
        expect(Object.hasOwn(selected, 'putFile')).toBe(false)
        const { app, appHome } = await scope.open({ employeeInputArtifacts: selected })
        const before = await scope.harness.db.select().from(employeeInputUploads)
        let settled = false
        const pending = Promise.resolve(
          app.request('/api/digital-employee-input-uploads', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${'d'.repeat(64)}`,
              'content-type': 'application/octet-stream',
              'x-upload-name': 'selected.bin',
              'x-upload-idempotency-key': 'selected-input-capture',
            },
            body: new Blob([payload]),
          }),
        ).finally(() => {
          settled = true
        })
        try {
          await Promise.race([
            selected.entered.promise,
            pending.then(async (response) => {
              throw new Error(
                `selected capture ACK missed: ${response.status} ${await response.clone().text()}`,
              )
            }),
          ])
          expect(settled).toBe(false)
          expect(selected.captures).toBe(1)
          expect(await scope.harness.db.select().from(employeeInputUploads)).toEqual(before)
          selected.ready.resolve()
          const response = await pending
          if (outcome === 'saved') {
            expect(response.status).toBe(201)
            expect(await response.json()).toMatchObject({
              originalName: 'selected.bin',
              bytes: payload.byteLength,
              sha256: digest,
            })
            const rows = await scope.harness.db.select().from(employeeInputUploads)
            expect(rows).toHaveLength(before.length + 1)
            const created = rows.filter((row) => !before.some((old) => old.id === row.id))
            expect(created).toHaveLength(1)
            expect(created[0]).toMatchObject({
              originalName: 'selected.bin',
              blobRef: 'object:employee-input/1',
              bytes: payload.byteLength,
              sha256: digest,
              state: 'pending',
              claimedByCaseId: null,
            })
          } else {
            expect(response.status).toBe(500)
            expect(await scope.harness.db.select().from(employeeInputUploads)).toEqual(before)
          }
          expect(existsSync(join(appHome, 'artifacts', 'employee-inputs'))).toBe(false)
        } finally {
          selected.ready.resolve()
          await pending
        }
      }, 20_000)
    }
  },
)
