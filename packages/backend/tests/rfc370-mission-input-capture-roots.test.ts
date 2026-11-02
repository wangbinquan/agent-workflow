import { tablesOf } from '@/platform/persistence/sessionTables'
import { expectNoDeploymentSelection } from './helpers/deploymentSelectionSource'
import { readDaemonGraphSource } from './helpers/daemonGraphSource'
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import type { MissionInputBlobPersistence } from '@/modules/development-automation/composition/missionInputUploads'
import { sha256Hex } from '@/util/hash'
import { EvidenceStore } from '@/modules/development-automation/infrastructure/local/fileEvidenceStore'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'

const load = (path: string) =>
  ts.createSourceFile(
    path,
    /(?:^|\/)bootstrap\/daemonStart\.ts$/.test(path)
      ? readDaemonGraphSource()
      : readFileSync(new URL('../src/' + path, import.meta.url), 'utf8'),
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

// RFC-429: mission input capture is the deployment's evidenceArtifacts (it is a MissionInputBlobPersistence); no root
// forwards a separate missionInputBlobs and it is no deployment selection. The module keeps its lazy local default.
test('mission upload capture is the evidence artifacts at every real startup and HTTP root', () => {
  const composition = load('modules/development-automation/composition/missionInputUploads.ts')
  const defaults = calls(composition, 'lazyEvidenceBlobs')
  expect(defaults).toHaveLength(1)
  const selection = defaults[0]!.parent
  expect(ts.isBinaryExpression(selection)).toBe(true)
  if (!ts.isBinaryExpression(selection)) throw new Error('selected capture is missing')
  expect(selection.left.getText(composition)).toBe('input.blobs ?? input.artifacts')
  expect(selection.operatorToken.kind).toBe(ts.SyntaxKind.QuestionQuestionToken)
  for (const path of ['bootstrap/daemonApplication.ts', 'bootstrap/daemonStart.ts']) {
    const source = load(path)
    const roots = calls(source, 'composeDaemonDevelopmentAutomationModules')
    expect(roots).toHaveLength(1)
    const argument = roots[0]!.arguments[0]!
    if (!ts.isObjectLiteralExpression(argument)) throw new Error('capture root is missing')
    const fields = new Map(
      argument.properties
        .filter(ts.isPropertyAssignment)
        .map((p) => [p.name.getText(source), p.initializer.getText(source)]),
    )
    expect(fields.has('missionInputBlobs')).toBe(false)
    expect(fields.get('evidenceArtifacts')).toBe('input.evidenceArtifacts')
  }
  const bundle = load('bootstrap/daemonModules/developmentAutomation.ts')
  const uploads = calls(bundle, 'composeMissionInputUploadOperations')
  expect(uploads).toHaveLength(1)
  const upload = uploads[0]!.arguments[0]!.getText(bundle).replace(/\s/g, '')
  expect(upload).toContain('artifacts:input.evidenceArtifacts')
  expect(upload).not.toContain('blobs:')
  expectNoDeploymentSelection('missionInputBlobs')
  expect(load('bootstrap/daemonStart.ts').text).toContain('...sessionInput,')
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
        // RFC-429: the capture is the evidence artifacts' putFile; route it to the gated capture.
        const evidenceRoot = mkdtempSync(join(tmpdir(), 'rfc429-mission-evidence-'))
        class CaptureEvidence extends EvidenceStore {
          override async putFile(absolutePath: string) {
            return await selected.putFile(absolutePath)
          }
        }
        const { app, appHome } = await scope.open({
          evidenceArtifacts: new CaptureEvidence(evidenceRoot),
        })
        const { missionInputUploads } = tablesOf(scope.harness.db)
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
          rmSync(evidenceRoot, { recursive: true, force: true })
        }
      }, 20_000)
    }
  },
)
