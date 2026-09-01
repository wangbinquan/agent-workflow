// RFC-310 PR-3 T33/T38 —— 外部需求取件链路（真 adapter 子进程 + 真 HTTP mock）。
//
// 全链真实件：发布的 integration adapter（executableRef = system-mocks 的
// requirement-adapter-cli）→ developmentAdapterRunner 子进程（空环境 +
// sink cwd）→ EvidenceStore safe import → 平台 manifest → mission source
// generation 台账。负向面按 2026-08-18 执行边界裁决取形：无 OS 沙箱，逃逸写
// **拦不住**、但**永远进不了 bundle**；sink 内 symlink 整包拒收；404/超时/
// 坏 envelope/未声明操作各自映射 closed failure。T38 refresh 用 mock 换
// revision 实测 preview/apply 两段。

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  startRequirementProviderMock,
  type StartedRequirementProviderMock,
} from '@agent-workflow/system-mocks/development/requirement-provider'

import { runMissionReconcile } from '../src/modules/development-automation/application/missionReconciler'
import { buildPr3Fixture, PR3_JAVA_CELLS, type Pr3Fixture } from './helpers/rfc310Pr3Fixture'
import { fakeAgentActionPorts } from './helpers/rfc310AgentPorts'

setDefaultTimeout(120_000)

let mock: StartedRequirementProviderMock

function seedReq1(revision: string): void {
  mock.mock.seed({
    externalId: 'REQ-1',
    revision,
    title: 'External demand',
    files: [
      {
        fileId: 'f1',
        name: 'body.md',
        role: 'body',
        mediaType: 'text/markdown',
        content: '# demand\n',
      },
      {
        fileId: 'f2',
        name: 'design.md',
        role: 'design',
        mediaType: 'text/markdown',
        content: 'design\n',
      },
      {
        fileId: 'f3',
        name: 'notes.txt',
        role: 'attachment',
        mediaType: 'text/plain',
        content: 'note\n',
      },
    ],
  })
}

beforeAll(async () => {
  mock = await startRequirementProviderMock()
  seedReq1('r1')
})

afterAll(async () => {
  await mock.close()
})

async function externalFixture(extra?: {
  operations?: readonly ('acquire' | 'questions.writeback' | 'answers.collect')[]
  timeoutMs?: number
  extraEnv?: Record<string, string>
}): Promise<Pr3Fixture> {
  return await buildPr3Fixture({
    external: {
      mockUrl: mock.url,
      operations: extra?.operations,
      timeoutMs: extra?.timeoutMs,
      extraEnv: extra?.extraEnv,
    },
  })
}

describe('rfc310 pr3 — external requirement acquisition via real adapter subprocess', () => {
  test('full external chain: collect-external-requirement → bundle + manifest + source generation → action', async () => {
    const fx = await externalFixture()
    const missionId = await fx.launchExternal('rfc310-pr3-ext-1', 'REQ-1')
    const mission = fx.store.getMission(missionId)!
    expect(mission.status).toBe('working')
    expect(mission.resolvedAdapterId).toBe(fx.adapterId!)

    const deps = fx.deps({
      repositoryFacts: {
        async collect() {
          return { cells: { ...PR3_JAVA_CELLS }, factsRef: 'probe-1' }
        },
      },
      ...fakeAgentActionPorts({ db: fx.db }),
    })

    const round1 = await runMissionReconcile(deps, missionId)
    expect(round1.kind === 'decided' && round1.selected.kind).toBe('collect-external-requirement')
    expect(round1.kind === 'decided' && round1.handled).toBe('collected')

    const sources = fx.store.listMissionSources(missionId)
    expect(sources).toHaveLength(2)
    const materialized = sources.find((s) => s.state === 'materialized')!
    expect(materialized.sourceRevision).toBe('r1')
    expect(materialized.fileCount).toBe(3)
    expect(materialized.adapterId).toBe(fx.adapterId!)

    // 平台 manifest：role 来自 envelope、byte 事实来自我们自己的 safe import。
    const manifest = (await fx.materializer.getRequirementManifest(missionId))!
    expect(manifest.source).toEqual({
      kind: 'external',
      sourceKey: 'sys-a',
      externalId: 'REQ-1',
      sourceRevision: 'r1',
    })
    const byPath = new Map(manifest.files.map((f) => [f.relativePath, f]))
    expect(byPath.get('files/body.md')!.role).toBe('body')
    expect(byPath.get('files/design.md')!.role).toBe('design')
    expect(byPath.get('files/notes.txt')!.role).toBe('attachment')
    const bundle = fx.evidence.getBundle(materialized.bundleRef!)!
    const bodyEntry = bundle.entries.find((e) => e.relativePath === 'files/body.md')!
    expect(readFileSync(fx.evidence.blobPath(bodyEntry.sha256), 'utf8')).toBe('# demand\n')

    const round2 = await runMissionReconcile(deps, missionId)
    expect(round2.kind === 'decided' && round2.selected.kind).toBe('collect-repository-facts')
    const round3 = await runMissionReconcile(deps, missionId)
    expect(round3.kind === 'decided' && round3.handled).toBe('action-launched')
  })

  test('unknown external id ⇒ business-failure (adapter exit 4), typed block via reconciler', async () => {
    const fx = await externalFixture()
    const missionId = await fx.launchExternal('rfc310-pr3-ext-404', 'REQ-MISSING')
    const outcome = await runMissionReconcile(fx.deps(), missionId)
    expect(outcome.kind === 'decided' && outcome.handled).toBe('blocked')
    const mission = fx.store.getMission(missionId)!
    expect(mission.blockCode).toBe('requirement-acquire-failed:adapter-exit-4')
  })

  test('escape write lands outside the sink: not preventable (no OS sandbox by ruling) but never imported', async () => {
    const fx = await externalFixture({ extraEnv: { AW_ADAPTER_EVIL: 'escape' } })
    const missionId = await fx.launchExternal('rfc310-pr3-ext-evil-escape', 'REQ-1')
    const out = await fx.materializer.acquireExternal({
      missionId,
      adapterBindingRef: `${fx.adapterId!}@${fx.adapterRevision!}`,
      externalId: 'REQ-1',
    })
    expect(out.ok).toBe(true)
    if (out.ok) {
      const bundle = fx.evidence.getBundle(out.bundleRef)!
      expect(bundle.entries.some((e) => e.relativePath.includes('escaped'))).toBe(false)
      expect(bundle.entries).toHaveLength(3)
    }
    // 逃逸文件确实落在 sink 外（stagingRoot 层）——裁决边界的如实呈现。
    expect(existsSync(join(fx.stagingRoot, 'escaped.txt'))).toBe(true)
  })

  test('symlink inside the sink ⇒ safe import rejects the whole bundle (contract-violation)', async () => {
    const fx = await externalFixture({ extraEnv: { AW_ADAPTER_EVIL: 'symlink' } })
    const missionId = await fx.launchExternal('rfc310-pr3-ext-evil-symlink', 'REQ-1')
    const out = await fx.materializer.acquireExternal({
      missionId,
      adapterBindingRef: `${fx.adapterId!}@${fx.adapterRevision!}`,
      externalId: 'REQ-1',
    })
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.failure.code).toBe('staged-tree-rejected')
      expect(out.failure.category).toBe('contract-violation')
      expect(out.failure.retryability).toBe('never')
    }
  })

  test('garbage stdout ⇒ contract-violation adapter-envelope-not-json', async () => {
    const fx = await externalFixture({ extraEnv: { AW_ADAPTER_EVIL: 'bad-envelope' } })
    const missionId = await fx.launchExternal('rfc310-pr3-ext-evil-envelope', 'REQ-1')
    const out = await fx.materializer.acquireExternal({
      missionId,
      adapterBindingRef: `${fx.adapterId!}@${fx.adapterRevision!}`,
      externalId: 'REQ-1',
    })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.failure.code).toBe('adapter-envelope-not-json')
  })

  test('timeout ⇒ SIGKILL ⇒ transient adapter-timeout (retryable same-input)', async () => {
    const fx = await externalFixture({
      timeoutMs: 1_000,
      extraEnv: { AW_ADAPTER_SLEEP_MS: '30000' },
    })
    const missionId = await fx.launchExternal('rfc310-pr3-ext-timeout', 'REQ-1')
    const out = await fx.materializer.acquireExternal({
      missionId,
      adapterBindingRef: `${fx.adapterId!}@${fx.adapterRevision!}`,
      externalId: 'REQ-1',
    })
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.failure.code).toBe('adapter-timeout')
      expect(out.failure.category).toBe('transient')
      expect(out.failure.retryability).toBe('same-input')
    }
  })

  test('undeclared operation is refused at the adapter seam (configuration failure)', async () => {
    const fx = await externalFixture({ operations: ['acquire'] })
    const missionId = await fx.launchExternal('rfc310-pr3-ext-undeclared', 'REQ-1')
    const out = await fx.materializer.collectAnswers({
      missionId,
      questionSetRef: 'irrelevant',
      adapterBindingRef: `${fx.adapterId!}@${fx.adapterRevision!}`,
      correlationRef: 'corr-x',
    })
    expect(out.ok).toBe(false)
    // question-set 缺失先于 adapter 调用被拒（stash 面）；直接对 adapter 面
    // 再验一次未声明操作。
    const fresh = await fx.materializer.stashQuestionSet({
      missionId,
      origin: 'platform',
      channel: 'requirement-source',
      questions: [{ questionId: 'q1', text: 'why?', answerKind: 'text', choices: null }],
    })
    expect(fresh.ok).toBe(true)
    if (!fresh.ok) return
    const denied = await fx.materializer.collectAnswers({
      missionId,
      questionSetRef: fresh.questionSetRef,
      adapterBindingRef: `${fx.adapterId!}@${fx.adapterRevision!}`,
      correlationRef: 'corr-x',
    })
    expect(denied.ok).toBe(false)
    if (!denied.ok) {
      expect(denied.failure.code).toBe('operation-not-declared')
      expect(denied.failure.category).toBe('configuration')
    }
  })

  test('T38 refresh: preview detects source revision change; apply lands a new generation and resets cells', async () => {
    const fx = await externalFixture()
    const missionId = await fx.launchExternal('rfc310-pr3-ext-refresh', 'REQ-1')
    const deps = fx.deps()
    await runMissionReconcile(deps, missionId) // 物化 r1

    const unchanged = await fx.materializer.previewExternalRefresh(missionId)
    expect(unchanged.ok && unchanged.changed).toBe(false)

    seedReq1('r2')
    try {
      const preview = await fx.materializer.previewExternalRefresh(missionId)
      expect(preview.ok).toBe(true)
      if (preview.ok) {
        expect(preview.changed).toBe(true)
        expect(preview.currentSourceRevision).toBe('r1')
        expect(preview.newSourceRevision).toBe('r2')
      }
      // preview 不落台账。
      expect(fx.store.listMissionSources(missionId)).toHaveLength(2)

      const applied = await fx.materializer.applyExternalRefresh(missionId)
      expect(applied.ok && applied.changed).toBe(true)
      const sources = fx.store.listMissionSources(missionId)
      expect(sources).toHaveLength(3)
      expect(sources.find((s) => s.generation === 3)!.sourceRevision).toBe('r2')
      const manifest = (await fx.materializer.getRequirementManifest(missionId))!
      expect(manifest.source.kind === 'external' && manifest.source.sourceRevision).toBe('r2')
    } finally {
      seedReq1('r1')
    }
  })
})
