import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AttemptContextStorePort } from '../src/modules/development-automation/application/ports/attemptContextStore'
import { loadPipelineManifest } from '../src/modules/development-automation/application/pipelineEvidenceChain'
import { collectAgentAttempt } from '../src/modules/development-automation/application/agentActionOrchestrator'
import { runMissionReconcile } from '../src/modules/development-automation/application/missionReconciler'
import type { PipelineEvidenceManifestV1 } from '../src/modules/development-automation/domain/pipelineManifest'
import type { RepositoryFactsCollectorPort } from '../src/modules/development-automation/application/ports/reconcilerPorts'
import { createAttemptContextStore } from '../src/modules/development-automation/infrastructure/local/fileAttemptContextStore'
import { EvidenceStore } from '../src/modules/development-automation/infrastructure/evidenceStore'
import { describeEachProvider } from './helpers/eachProvider'
import { buildPr3Fixture, PR3_JAVA_CELLS } from './helpers/rfc310Pr3Fixture'
import { fakeAgentActionPorts } from './helpers/rfc310AgentPorts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((ack) => {
    resolve = ack
  })
  return { promise, resolve }
}

/** Methods live on the prototype; the selected receiver must reach every consumer intact. */
class SelectedContextStore implements AttemptContextStorePort {
  #contents = new Map<string, string>()
  readonly events: string[] = []
  readonly saveEntered = deferred()
  readonly readEntered = deferred()
  saveGate?: ReturnType<typeof deferred>
  readGate?: ReturnType<typeof deferred>
  readError?: Error

  async save(json: string) {
    this.events.push('save:start')
    this.saveEntered.resolve()
    await this.saveGate?.promise
    const ref = `host-context:${this.#contents.size + 1}`
    this.#contents.set(ref, json)
    this.events.push('save:ack')
    return ref
  }

  async load(ref: string) {
    this.events.push(`read:start:${ref}`)
    this.readEntered.resolve()
    await this.readGate?.promise
    if (this.readError !== undefined) throw this.readError
    this.events.push(`read:ack:${ref}`)
    return this.#contents.get(ref) ?? null
  }
}

const manifest: PipelineEvidenceManifestV1 = {
  schemaVersion: 1,
  bundleId: 'pipeline-bundle',
  providerKey: 'host-pipeline',
  headSha: 'a'.repeat(40),
  targetSha: 'b'.repeat(40),
  completeness: 'complete',
  gates: [],
  files: [],
  totals: { files: 0, bytes: 0 },
  redaction: 'complete',
  manifestDigest: 'c'.repeat(64),
}

const cellsFor = (ref: string) => ({
  '__pipeline.manifestRef': { state: 'known' as const, value: ref, sourceRevision: 'pinned' },
})

test('pipeline parsing waits for the selected opaque context reference and its read ACK', async () => {
  const selected = new SelectedContextStore()
  const ref = await selected.save(JSON.stringify(manifest))
  selected.readGate = deferred()
  let finished = false
  const pending = loadPipelineManifest({ ports: { attemptContext: selected } }, cellsFor(ref)).then(
    (value) => {
      finished = true
      return value
    },
  )
  await selected.readEntered.promise
  expect(finished).toBe(false)
  expect(selected.events).toEqual(['save:start', 'save:ack', `read:start:${ref}`])
  selected.readGate.resolve()
  expect(await pending).toEqual(manifest)
  expect(selected.events.at(-1)).toBe(`read:ack:${ref}`)
})

test('selected context failures propagate while missing or malformed manifests retain null semantics', async () => {
  const selected = new SelectedContextStore()
  const deps = { ports: { attemptContext: selected } }
  expect(await loadPipelineManifest(deps, cellsFor('missing'))).toBeNull()
  for (const text of ['not-json', JSON.stringify({ schemaVersion: 2 })]) {
    expect(await loadPipelineManifest(deps, cellsFor(await selected.save(text)))).toBeNull()
  }
  expect(await loadPipelineManifest({ ports: {} }, cellsFor('missing'))).toBeNull()
  expect(await loadPipelineManifest(deps, {})).toBeNull()
  const failure = new Error('selected-context-unavailable')
  selected.readError = failure
  await expect(loadPipelineManifest(deps, cellsFor('host-context:1'))).rejects.toBe(failure)
})

test('the native adapter preserves synchronous reads and byte-exact immutable JSON round trips', async () => {
  const staging = mkdtempSync(join(tmpdir(), 'aw-rfc370-context-'))
  try {
    const native = createAttemptContextStore(new EvidenceStore(join(staging, 'evidence')))
    const json = '{"schemaVersion":1,"nested":{"text":"上下文\\n"}}\n'
    const ref = await native.save(json)
    expect(ref).toMatch(/^[0-9a-f]{64}$/)
    const loaded: string | null = native.load(ref)
    expect(loaded).toBe(json)
    expect(native.load('f'.repeat(64))).toBeNull()
    expect(native.load('missing')).toBeNull()
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
})

const repositoryFacts: RepositoryFactsCollectorPort = {
  async collect() {
    return { cells: structuredClone(PR3_JAVA_CELLS) as never, factsRef: 'probe-context' }
  },
}

describeEachProvider('RFC-370 selected attempt contexts in the actual action chain', (harness) => {
  test('launch waits for save ACK; collection waits for read ACK before choosing the real launcher', async () => {
    const fixture = await buildPr3Fixture({ db: harness.db })
    const selected = new SelectedContextStore()
    selected.saveGate = deferred()
    const launches: string[] = []
    const fetches: string[] = []
    const deps = fixture.deps({
      repositoryFacts,
      ...fakeAgentActionPorts({
        db: fixture.db,
        launches,
        overrides: {
          attemptContext: selected,
          agentLauncher: {
            async launch(input) {
              launches.push(input.capabilityId)
              return { ok: true, executionRef: 'host-execution:1' }
            },
            async fetchOutcome(executionRef) {
              fetches.push(executionRef)
              return { kind: 'pending', executionRef, taskStatus: 'running' }
            },
            async cancel() {
              return { settled: 'already-terminal' }
            },
          },
        },
      }),
    })
    const missionId = await fixture.launchDirect('rfc370-context-ack')
    const materialized = await fixture.materializer.stashDirectSubmission({
      missionId,
      submission: { title: 'Add feature', body: 'do the thing', uploads: [] },
    })
    expect(materialized.ok).toBe(true)
    await runMissionReconcile(deps, missionId)
    await runMissionReconcile(deps, missionId)
    const launching = runMissionReconcile(deps, missionId)
    await selected.saveEntered.promise
    expect(launches).toEqual([])
    selected.saveGate.resolve()
    const launched = await launching
    expect(launched.kind === 'decided' && launched.handled).toBe('action-launched')
    expect(launches).toEqual(['change.implement'])
    const mission = (await fixture.store.getMission(missionId))!
    const attempts = await fixture.store.listAttempts(mission.currentActionRunId!)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.preSnapshotRef).toBe('host-context:1')
    expect(attempts[0]!.executionRef).toBe('host-execution:1')

    selected.readGate = deferred()
    const collecting = collectAgentAttempt(deps, mission)
    await selected.readEntered.promise
    expect(fetches).toEqual([])
    selected.readGate.resolve()
    expect(await collecting).toEqual({ kind: 'still-running' })
    expect(fetches).toEqual(['host-execution:1'])

    const failure = new Error('selected-pre-state-unavailable')
    selected.readError = failure
    await expect(collectAgentAttempt(deps, mission)).rejects.toBe(failure)
    expect(fetches).toEqual(['host-execution:1'])
    expect(await fixture.store.listAttempts(mission.currentActionRunId!)).toEqual(attempts)
  }, 120_000)
})
