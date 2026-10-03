// RFC-370 A2: complete selected evidence receiver at every real root and dual-provider HTTP.
// Exact 694 CI repair: preserve the selected EvidenceStore default after reference-factory migration.
import { afterEach, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import ts from 'typescript'
import { missionInputUploads } from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import type { EvidenceDocumentQueries } from '@/modules/development-automation/application/evidenceDocuments'
import { DIRECT_SUBMISSION_BUDGET } from '@/modules/development-automation/infrastructure/requirementMaterializer'
import { createRequirementBundleRefPersistence } from '@/modules/development-automation/infrastructure/requirementBundleRefPersistence'
import { GatedEvidenceArtifacts } from './helpers/rfc370EvidenceArtifacts'
import { buildPr3Fixture } from './helpers/rfc310Pr3Fixture'
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
function bind(source: ts.SourceFile, expression: string, key: string, receiver: string) {
  const roots = calls(source, expression)
  expect(roots).toHaveLength(1)
  const argument = roots[0]!.arguments[0]!
  expect(ts.isObjectLiteralExpression(argument)).toBe(true)
  if (!ts.isObjectLiteralExpression(argument)) throw new Error('root argument must be explicit')
  const named = argument.properties.filter(
    (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(source) === key,
  )
  expect(named).toHaveLength(1)
  expect(named[0]!.initializer.getText(source)).toBe(`${receiver}.evidenceArtifacts`)
  const names = argument.properties
    .filter((p) => ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p))
    .map((p) => p.name!.getText(source))
  expect(new Set(names).size).toBe(names.length)
}

test('actual DA, pipeline, Mission capture and daemon HTTP roots forward the same complete object', () => {
  const start = load('cli/start.ts'),
    pg = load('cli/postgresqlDaemonApplication.ts'),
    server = load('server.ts')
  for (const [source, receiver] of [
    [start, 'input'],
    [pg, 'input'],
    [server, 'deps'],
  ] as const) {
    bind(source, 'composeDevelopmentAutomation', 'evidenceArtifacts', receiver)
    bind(source, 'composeDevelopmentEmployeePlatformWorkItems', 'evidenceArtifacts', receiver)
    expect(source.text).toContain('evidenceArtifacts?: EvidenceArtifactPort')
  }
  bind(start, 'composePostgresqlDaemonApplication', 'evidenceArtifacts', 'input')
  bind(start, 'composeSqliteAppDeps', 'evidenceArtifacts', 'input')
  bind(pg, 'composeMissionInputUploadOperations', 'artifacts', 'input')
  bind(server, 'composeMissionInputUploadOperations', 'artifacts', 'deps')
  expect(start.text).toContain('evidenceArtifacts: opts.evidenceArtifacts,')
  expect(start.text).toContain('...sessionInput,')
  const composition = load('modules/development-automation/composition.ts')
  expect(composition.text).toContain(
    "deps.evidenceArtifacts ?? new EvidenceStore(factory.resolve(deps.appHome, 'evidence'))",
  )
  expect(composition.text).toContain(
    'const factory = selectedAutomationWorkspaceEffects(deps.automationWorkspaceEffects)',
  )
  for (const [path, expression, count] of [
    ['infrastructure/actionWorkspace.ts', 'deps.evidence.materializeBundle', 2],
    ['infrastructure/uploadPlacement.ts', 'deps.evidence.materializeBlob', 1],
    ['application/agentActionOrchestrator.ts', 'ports.actionWorkspace!.adopt', 1],
    ['composition/digitalEmployeePlatformWorkItems.ts', 'store.materializeBundle', 1],
  ] as const) {
    const source = load('modules/development-automation/' + path),
      selected = calls(source, expression)
    expect(selected).toHaveLength(count)
    for (const call of selected) expect(ts.isAwaitExpression(call.parent)).toBe(true)
  }
})

const payload = new Uint8Array([0, 255, 42, 10, 65])
const digest = sha256Hex(payload)
describeEachProviderHttpApplication(
  'RFC-370 complete evidence effects at actual HTTP roots',
  {
    token: 'a'.repeat(64),
    dbVersion: 17,
    opencodeVersion: null,
    tempPrefix: 'aw-evidence-artifacts-http-',
  },
  (scope) => {
    const roots: string[] = []
    afterEach(() => {
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
    })
    const ownRoot = () => {
      const root = mkdtempSync(join(tmpdir(), 'aw-evidence-selected-'))
      roots.push(root)
      return root
    }
    for (const outcome of ['saved', 'failure'] as const) {
      test(`Mission capture uses complete prototype receiver and waits for ${outcome} content ACK`, async () => {
        const entered = Promise.withResolvers<void>(),
          ready = Promise.withResolvers<void>()
        let capturedPath = ''
        const selected = Object.freeze(
          new GatedEvidenceArtifacts(ownRoot(), async (effect, path) => {
            expect(effect).toBe('put-file')
            capturedPath = path
            expect([...readFileSync(path)]).toEqual([...payload])
            entered.resolve()
            await ready.promise
            if (outcome === 'failure') throw new Error('selected-complete-capture-unavailable')
          }),
        )
        expect(Object.hasOwn(selected, 'putFile')).toBe(false)
        const opened = await scope.open({ evidenceArtifacts: selected })
        const before = await scope.harness.db.select().from(missionInputUploads)
        let settled = false
        const pending = Promise.resolve(
          opened.app.request('/api/code/mission-input-uploads', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${'a'.repeat(64)}`,
              'content-type': 'application/octet-stream',
              'x-upload-name': 'input.bin',
              'x-upload-idempotency-key': `complete-capture-${outcome}`,
            },
            body: new Blob([payload]),
          }),
        ).finally(() => {
          settled = true
        })
        try {
          await Promise.race([
            entered.promise,
            pending.then(async (response) => {
              throw new Error(
                `selected capture missed: ${response.status} ${await response.clone().text()}`,
              )
            }),
          ])
          expect(settled).toBe(false)
          expect(existsSync(capturedPath)).toBe(true)
          expect(selected.calls).toBe(1)
          expect(await scope.harness.db.select().from(missionInputUploads)).toEqual(before)
          expect(selected.hasBlob(digest)).toBe(false)
          expect(existsSync(join(opened.appHome, 'evidence', 'blobs'))).toBe(false)
          ready.resolve()
          const response = await pending
          expect(response.status).toBe(outcome === 'saved' ? 201 : 500)
          if (outcome === 'saved') {
            expect(await response.json()).toMatchObject({
              originalName: 'input.bin',
              sha256: digest,
              bytes: payload.length,
            })
            const after = await scope.harness.db.select().from(missionInputUploads),
              added = after.filter((row) => !before.some((old) => old.id === row.id))
            expect(added).toHaveLength(1)
            expect(added[0]).toMatchObject({
              blobRef: digest,
              sha256: digest,
              bytes: payload.length,
              state: 'pending',
            })
            expect(selected.hasBlob(digest)).toBe(true)
          } else expect(await scope.harness.db.select().from(missionInputUploads)).toEqual(before)
          expect(existsSync(capturedPath)).toBe(false)
          expect(existsSync(join(opened.appHome, 'evidence', 'blobs'))).toBe(false)
        } finally {
          ready.resolve()
          await pending
        }
      }, 20_000)

      test(`answer JSON publication waits for complete artifact ${outcome} ACK and preserves references`, async () => {
        const entered = Promise.withResolvers<void>(),
          ready = Promise.withResolvers<void>()
        let stagedRoot = ''
        const fallback: EvidenceDocumentQueries = {
          readText: (input) => fx.evidence.documents.readText(input),
        }
        const selected = Object.freeze(
          new GatedEvidenceArtifacts(
            ownRoot(),
            async (effect, path, budget) => {
              expect(effect).toBe('import-tree')
              expect(budget).toBe(DIRECT_SUBMISSION_BUDGET)
              expect(readdirSync(path)).toEqual(['answer-set.json'])
              stagedRoot = path
              expect(JSON.parse(readFileSync(join(path, 'answer-set.json'), 'utf8'))).toMatchObject(
                { answers: [{ questionId: 'q', answer: '中文' }] },
              )
              entered.resolve()
              await ready.promise
              if (outcome === 'failure') throw new Error('selected-complete-document-unavailable')
            },
            fallback,
          ),
        )
        const opened = await scope.open({ evidenceArtifacts: selected })
        const fx = await buildPr3Fixture({ db: scope.harness.db })
        roots.push(fx.stagingRoot, dirname(dirname(dirname(fx.evidence.blobPath('a'.repeat(64))))))
        const missionId = await fx.launchDirect(`complete-answer-${outcome}`)
        const questions = await fx.materializer.stashQuestionSet({
          missionId,
          origin: 'platform',
          channel: 'platform',
          questions: [{ questionId: 'q', text: 'Which?', answerKind: 'text', choices: null }],
        })
        if (!questions.ok) throw new Error('question fixture did not persist')
        const current = (await fx.store.getMission(missionId))!
        expect(
          (
            await fx.store.occUpdate(missionId, current.revision, current.epoch, {
              status: 'awaiting-information',
            })
          ).ok,
        ).toBe(true)
        const refs = createRequirementBundleRefPersistence(scope.harness.db),
          beforeRef = await refs.latest(missionId, 'answer-set'),
          beforeMission = await fx.store.getMission(missionId)
        let settled = false
        const pending = Promise.resolve(
          opened.app.request(`/api/code/missions/${missionId}/answers`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${'a'.repeat(64)}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              questionSetRef: questions.questionSetRef,
              answers: [{ questionId: 'q', answer: '中文' }],
            }),
          }),
        ).finally(() => {
          settled = true
        })
        try {
          await Promise.race([
            entered.promise,
            pending.then(async (response) => {
              throw new Error(
                `selected artifact import missed: ${response.status} ${await response.clone().text()}`,
              )
            }),
          ])
          expect(settled).toBe(false)
          expect(existsSync(stagedRoot)).toBe(true)
          expect(await refs.latest(missionId, 'answer-set')).toEqual(beforeRef)
          expect(await fx.store.getMission(missionId)).toEqual(beforeMission)
          expect(existsSync(join(opened.appHome, 'evidence', 'blobs'))).toBe(false)
          ready.resolve()
          const response = await pending
          expect(response.status, await response.clone().text()).toBe(
            outcome === 'saved' ? 200 : 500,
          )
          if (outcome === 'saved') {
            const result = (await response.json()) as { status: string; answerSetRef: string }
            expect(result.status).toBe('working')
            const saved = await refs.get(result.answerSetRef)
            expect(saved).not.toBeNull()
            expect(await selected.getBundle(saved!.evidenceRef)).not.toBeNull()
            expect(
              JSON.parse(
                (await selected.documents.readText({
                  bundleRef: saved!.evidenceRef,
                  relativePath: 'answer-set.json',
                }))!,
              ),
            ).toMatchObject({ answers: [{ questionId: 'q', answer: '中文' }] })
          } else {
            expect(await refs.latest(missionId, 'answer-set')).toEqual(beforeRef)
            expect(await fx.store.getMission(missionId)).toEqual(beforeMission)
          }
          expect(existsSync(stagedRoot)).toBe(false)
          expect(existsSync(join(opened.appHome, 'evidence', 'blobs'))).toBe(false)
          expect(selected.calls).toBe(1)
        } finally {
          ready.resolve()
          await pending
        }
      }, 20_000)
    }
  },
)
