import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

import { missionInputUploads } from '@/db/schema'
import type { MissionInputBlobPersistence } from '@/modules/development-automation/composition/missionInputUploads'
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

test('mission upload capture is selected lazily and forwarded through every real startup and HTTP root', () => {
  const composition = load('modules/development-automation/composition/missionInputUploads.ts')
  const defaults = calls(composition, 'lazyEvidenceBlobs')
  expect(defaults).toHaveLength(1)
  const selection = defaults[0]!.parent
  expect(ts.isBinaryExpression(selection)).toBe(true)
  if (!ts.isBinaryExpression(selection)) throw new Error('selected capture is missing')
  expect(selection.left.getText(composition)).toBe('input.blobs')
  expect(selection.operatorToken.kind).toBe(ts.SyntaxKind.QuestionQuestionToken)
  for (const [path, receiver] of [
    ['cli/postgresqlDaemonApplication.ts', 'input'],
    ['server.ts', 'deps'],
  ] as const) {
    const source = load(path)
    const roots = calls(source, 'composeMissionInputUploadOperations')
    expect(roots).toHaveLength(1)
    const argument = roots[0]!.arguments[0]!
    expect(ts.isObjectLiteralExpression(argument)).toBe(true)
    if (!ts.isObjectLiteralExpression(argument)) throw new Error('capture root is missing')
    const selected = argument.properties.filter(
      (p): p is ts.PropertyAssignment =>
        ts.isPropertyAssignment(p) && p.name.getText(source) === 'blobs',
    )
    expect(selected).toHaveLength(1)
    expect(selected[0]!.initializer.getText(source)).toBe(`${receiver}.missionInputBlobs`)
  }
  const start = load('cli/start.ts')
  expect(start.text).toContain('missionInputBlobs: opts.missionInputBlobs,')
  for (const expression of ['composePostgresqlDaemonApplication', 'composeSqliteAppDeps']) {
    const roots = calls(start, expression)
    expect(roots).toHaveLength(1)
    const argument = roots[0]!.arguments[0]!
    expect(ts.isObjectLiteralExpression(argument)).toBe(true)
    if (!ts.isObjectLiteralExpression(argument)) throw new Error('provider root is missing')
    const bindings = argument.properties.filter(
      (property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) && property.name.getText(start) === 'missionInputBlobs',
    )
    expect(bindings).toHaveLength(1)
    expect(bindings[0]!.initializer.getText(start)).toBe('input.missionInputBlobs')
  }
  expect(start.text).toContain('readonly missionInputBlobs?: MissionInputBlobPersistence')
  expect(start.text).toContain('...sessionInput,')
})

const payload = new Uint8Array([0, 255, 65, 10, 11])
const digest = sha256Hex(payload)
class SelectedCapture implements MissionInputBlobPersistence {
  #captures = 0
  readonly entered = Promise.withResolvers<void>()
  readonly ready = Promise.withResolvers<void>()
  capturedPath?: string
  constructor(readonly outcome: 'saved' | 'failure') {}
  get captures() {
    return this.#captures
  }
  async putFile(absolutePath: string) {
    this.#captures += 1
    this.capturedPath = absolutePath
    expect([...readFileSync(absolutePath)]).toEqual([...payload])
    this.entered.resolve()
    await this.ready.promise
    if (this.outcome === 'failure') throw new Error('selected-mission-capture-unavailable')
    return { sha256: digest, bytes: payload.byteLength }
  }
}

describeEachProviderHttpApplication(
  'RFC-370 selected mission upload capture at actual HTTP roots',
  {
    token: 'e'.repeat(64),
    dbVersion: 17,
    opencodeVersion: null,
    tempPrefix: 'aw-rfc370-mission-capture-',
  },
  (scope) => {
    for (const outcome of ['saved', 'failure'] as const) {
      test(`upload waits for selected prototype capture ACK and preserves ${outcome} persistence`, async () => {
        const selected = new SelectedCapture(outcome)
        expect(Object.hasOwn(selected, 'putFile')).toBe(false)
        const { app, appHome } = await scope.open({ missionInputBlobs: selected })
        const before = await scope.harness.db.select().from(missionInputUploads)
        let settled = false
        const pending = Promise.resolve(
          app.request('/api/code/mission-input-uploads', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${'e'.repeat(64)}`,
              'content-type': 'application/octet-stream',
              'x-upload-name': 'capture.bin',
              'x-upload-idempotency-key': `selected-mission-${outcome}`,
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
          expect(existsSync(selected.capturedPath!)).toBe(true)
          expect(await scope.harness.db.select().from(missionInputUploads)).toEqual(before)
          selected.ready.resolve()
          const response = await pending
          if (outcome === 'saved') {
            expect(response.status).toBe(201)
            expect(await response.json()).toMatchObject({
              originalName: 'capture.bin',
              sha256: digest,
              bytes: payload.byteLength,
            })
            const rows = await scope.harness.db.select().from(missionInputUploads)
            const created = rows.filter((row) => !before.some((old) => old.id === row.id))
            expect(created).toHaveLength(1)
            expect(created[0]).toMatchObject({
              originalName: 'capture.bin',
              sha256: digest,
              blobRef: digest,
              bytes: payload.byteLength,
              state: 'pending',
              claimedByMissionId: null,
            })
          } else {
            expect(response.status).toBe(500)
            expect(await scope.harness.db.select().from(missionInputUploads)).toEqual(before)
          }
          expect(existsSync(selected.capturedPath!)).toBe(false)
          expect(existsSync(join(appHome, 'evidence', 'blobs', digest.slice(0, 2), digest))).toBe(
            false,
          )
        } finally {
          selected.ready.resolve()
          await pending
        }
      }, 20_000)
    }
  },
)
