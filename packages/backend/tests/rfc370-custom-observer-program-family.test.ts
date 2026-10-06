// RFC-370: preserve the legacy factory getter timing and publish's second validation.
import { describe, expect, test } from 'bun:test'
import { canonicalJson } from '@agent-workflow/shared'
import { composeEventCenter } from '@/modules/event-center/composition'
import { composeCustomEventObserverProgram } from '@/modules/event-center/composition/customObserverProgram'
import { selectLocalCustomObserverProgramFactory } from '@/modules/event-center/composition/localCustomObserverProgram'
import { executeCustomObserverProgram } from '@/modules/event-center/application/customObserverProgram'
import type {
  CustomObserverProgramEffects,
  CustomObserverProgramFactory,
  CustomObserverProgramInput,
  CustomObserverProgramResult,
} from '@/modules/event-center/application/ports/customObserverProgram'
import type { CustomEventSourceStorePort } from '@/modules/event-center/application/ports/customEventSourceStore'
import { createLocalCustomObserverProgramFactory } from '@/modules/event-center/infrastructure/local/customObserverProgram'
import { createCustomEventObserverProgram as createCompatibleCustomEventObserverProgram } from '@/modules/event-center/infrastructure/customEventObserverProgram'
import {
  CUSTOM_EVENT_OBSERVER_PROTOCOL,
  customEventSourceDraftSchema,
  type CustomEventSourceDraft,
} from '@/modules/event-center/domain/customEventSource'
import { dedupeKey, normalizedCursor } from '@/modules/event-center/domain/customObserverProgram'
import { sha256Hex } from '@/util/hash'
import { describeEachProvider } from './helpers/eachProvider'

const members = [
  'resolveProgram',
  'allocateWorkspace',
  'prepareWorkspace',
  'writeInput',
  'writeProgram',
  'run',
  'disposeWorkspace',
] as const
const now = Date.parse('2026-10-01T01:00:00.000Z')
function draft(): CustomEventSourceDraft {
  return customEventSourceDraftSchema.parse({
    schemaVersion: 1,
    displayName: { 'zh-CN': '选择观察器', 'en-US': 'Selected observer' },
    description: { 'zh-CN': '完整效果家族', 'en-US': 'Whole selected family' },
    pollIntervalMs: 1000,
    batchSize: 20,
    ingestionMode: 'state-change',
    program: {
      language: 'node',
      source: "throw new Error('unexpected native execution')",
      timeoutMs: 1000,
    },
    eventTypes: [
      {
        eventKey: 'issue.changed',
        subjectTypeId: 'issue',
        payloadSchemaId: 'event.summary',
        displayName: { 'zh-CN': '变更', 'en-US': 'Changed' },
        description: { 'zh-CN': '修订', 'en-US': 'Revision' },
        deliveryClass: 'issue.change',
      },
    ],
    fixture: { subjects: [{ typeId: 'issue', subjectRef: 'ISSUE-1' }], cursorJson: null },
  })
}
function input(): CustomObserverProgramInput {
  const content = draft()
  return {
    sourceRef: { id: 'selected-source', revision: 1 },
    draft: content,
    subjects: content.fixture.subjects,
    cursorJson: '{"previous":1}',
    now,
  }
}
function output(value: CustomObserverProgramInput) {
  return {
    protocol: CUSTOM_EVENT_OBSERVER_PROTOCOL,
    cursor: { next: 2 },
    observations: value.subjects.map((subject) => ({
      eventKey: 'issue.changed',
      subjectRef: subject.subjectRef,
      occurredAt: '2026-10-01T01:00:00.000Z',
      sourceEventKey: subject.subjectRef,
      sourceEventRevision: 'revision-2',
      summary: 'Changed',
    })),
  }
}
function result(value: CustomObserverProgramInput): CustomObserverProgramResult {
  return {
    outcome: 'exited',
    exitCode: 0,
    stderrTail: '',
    rawStdout: ` \n${JSON.stringify(output(value))}\n `,
    truncated: { stdout: false },
  }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function opaque() {
  return Object.create(
    null,
    Object.fromEntries(
      ['path', 'directory', 'argv', 'pid', 'scriptPath', 'toJSON'].map((name) => [
        name,
        {
          get() {
            throw new Error(`opaque field ${name} read`)
          },
        },
      ]),
    ),
  ) as object
}
function fixture(
  options: {
    hold?: (typeof members)[number]
    fail?: (typeof members)[number]
    error?: Error
    settled?: (value: CustomObserverProgramInput) => CustomObserverProgramResult
    unavailable?: boolean
  } = {},
) {
  const trace: string[] = [],
    inputs: CustomObserverProgramInput[] = [],
    envelopes: string[] = []
  const entered = deferred(),
    ack = deferred()
  const program = opaque(),
    workspace = opaque()
  const before = async (name: (typeof members)[number], receiver: Family, expected: Family) => {
    expect(receiver).toBe(expected)
    trace.push(name)
    if (options.hold === name) {
      entered.resolve()
      await ack.promise
    }
    if (options.fail === name) throw options.error
  }
  class Family implements CustomObserverProgramEffects {
    constructor(readonly value: CustomObserverProgramInput) {}
    async resolveProgram() {
      await before('resolveProgram', this, families.find((f) => f.value === this.value)!)
      return options.unavailable ? null : program
    }
    async allocateWorkspace() {
      await before('allocateWorkspace', this, families.find((f) => f.value === this.value)!)
      return workspace
    }
    async prepareWorkspace(ref: object) {
      expect(ref).toBe(workspace)
      await before('prepareWorkspace', this, families.find((f) => f.value === this.value)!)
    }
    async writeInput(ref: object, envelope: string) {
      expect(ref).toBe(workspace)
      await before('writeInput', this, families.find((f) => f.value === this.value)!)
      envelopes.push(envelope)
    }
    async writeProgram(ref: object) {
      expect(ref).toBe(workspace)
      await before('writeProgram', this, families.find((f) => f.value === this.value)!)
    }
    async run(ref: object, executable: object) {
      expect(ref).toBe(workspace)
      expect(executable).toBe(program)
      await before('run', this, families.find((f) => f.value === this.value)!)
      return (options.settled ?? result)(this.value)
    }
    async disposeWorkspace(ref: object) {
      expect(ref).toBe(workspace)
      await before('disposeWorkspace', this, families.find((f) => f.value === this.value)!)
    }
  }
  const families: Family[] = []
  const factory: CustomObserverProgramFactory = {
    create(value) {
      expect(this).toBe(factory)
      inputs.push(value)
      const family = new Family(value)
      families.push(family)
      return family
    },
  }
  return { factory, trace, inputs, envelopes, entered, ack, families }
}
const unused = async (): Promise<never> => {
  throw new Error('unexpected store operation')
}
function store(
  published: Awaited<ReturnType<CustomEventSourceStorePort['getPublished']>> = null,
): CustomEventSourceStorePort {
  return {
    create: unused,
    get: unused,
    list: unused,
    update: unused,
    publish: unused,
    retire: unused,
    acceptsNewSubscriptions: unused,
    getPublished: async () => published,
  }
}

describe('RFC-370 complete selected custom observer program', () => {
  test('legacy factory captures now once at construction and reads the live store only during run', async () => {
    const value = input(),
      selected = fixture()
    const published = {
      sourceRef: value.sourceRef,
      content: value.draft,
      contentDigest: sha256Hex(canonicalJson(value.draft)),
      validationReceipt: {
        schemaVersion: 1 as const,
        draftDigest: sha256Hex(canonicalJson(value.draft)),
        validatedAt: now,
        observationCount: 1,
        stdoutDigest: '0'.repeat(64),
      },
    }
    const timeline: string[] = []
    const sourceStore = store(published)
    sourceStore.getPublished = async function (sourceRef) {
      expect(this).toBe(sourceStore)
      expect(sourceRef).toBe(value.sourceRef)
      timeline.push('getPublished')
      return published
    }
    let clockReads = 0,
      failStore = false
    const storeError = new Error('late store getter failed')
    const options = {
      get now() {
        expect(this).toBe(options)
        timeline.push('now')
        clockReads++
        return clockReads === 1 ? () => now : () => now + 1000
      },
      get store() {
        expect(this).toBe(options)
        timeline.push('store')
        if (failStore) throw storeError
        return sourceStore
      },
      programs: selected.factory,
    }
    const program = createCompatibleCustomEventObserverProgram(options)
    expect(timeline).toEqual(['now'])
    expect(clockReads).toBe(1)
    const request = {
      source: { sourceRef: value.sourceRef },
      subjects: value.subjects,
      cursorJson: value.cursorJson,
    } as Parameters<typeof program.run>[0]
    expect((await program.run(request)).observations).toHaveLength(1)
    expect(timeline).toEqual(['now', 'store', 'getPublished'])
    expect(clockReads).toBe(1)
    expect(selected.inputs[0]?.now).toBe(now)
    failStore = true
    await expect(program.run(request)).rejects.toBe(storeError)
    expect(timeline).toEqual(['now', 'store', 'getPublished', 'store'])
    expect(selected.inputs).toHaveLength(1)
  })

  test('selected construction failure propagates without any local fallback', async () => {
    const error = new Error('selected construction failed')
    const factory: CustomObserverProgramFactory = {
      create() {
        throw error
      },
    }
    await expect(executeCustomObserverProgram(factory, input())).rejects.toBe(error)
  })
  test('selected output preserves artifact and trigger parameters with the original occurrence identity', async () => {
    const value = input()
    const selected = fixture({
      settled: (value) => ({
        ...result(value),
        rawStdout: JSON.stringify({
          ...output(value),
          cursor: null,
          observations: [
            {
              ...output(value).observations[0]!,
              payloadArtifactRef: 'artifact:selected-output',
              triggerParameters: { revision: 'revision-2' },
            },
          ],
        }),
      }),
    })
    const observed = await executeCustomObserverProgram(selected.factory, {
      ...value,
      draft: { ...value.draft, ingestionMode: 'occurrence' },
    })
    expect(observed.batch.cursorJson).toBe(null)
    expect(observed.batch.observations[0]).toMatchObject({
      payloadArtifactRef: 'artifact:selected-output',
      triggerParameters: { revision: 'revision-2' },
      dedupeKey: dedupeKey({
        ingestionMode: 'occurrence',
        eventKey: 'issue.changed',
        subjectRef: 'ISSUE-1',
        sourceEventKey: 'ISSUE-1',
        sourceEventRevision: 'revision-2',
      }),
    })
    expect<readonly string[]>(selected.trace).toEqual(members)
  })
  test('prototype methods retain receiver, opaque pairing, exact envelope and logical output', async () => {
    const selected = fixture(),
      value = input()
    const observed = await executeCustomObserverProgram(selected.factory, value)
    expect<readonly string[]>(selected.trace).toEqual(members)
    expect(selected.inputs).toEqual([value])
    expect(JSON.parse(selected.envelopes[0]!)).toEqual({
      protocol: CUSTOM_EVENT_OBSERVER_PROTOCOL,
      sourceRef: value.sourceRef,
      subjects: value.subjects,
      cursor: { previous: 1 },
      deadlineAt: new Date(now + 1000).toISOString(),
    })
    expect(selected.envelopes[0]).toBe(canonicalJson(JSON.parse(selected.envelopes[0]!)))
    expect(observed.batch.cursorJson).toBe('{"next":2}')
    expect(observed.batch.observations[0]).toMatchObject({
      occurredAt: now,
      subject: value.subjects[0],
      sourceRef: value.sourceRef,
      eventTypeRef: { id: 'custom.selected-source.issue.changed', revision: 1 },
      payloadArtifactRef: null,
      triggerParameters: null,
    })
    expect(observed.batch.observations[0]?.dedupeKey).toBe(
      dedupeKey({
        ingestionMode: 'state-change',
        eventKey: 'issue.changed',
        subjectRef: 'ISSUE-1',
        sourceEventKey: 'ISSUE-1',
        sourceEventRevision: 'revision-2',
      }),
    )
    expect(observed.stdoutDigest).toBe(sha256Hex(result(value).rawStdout.trim()))
  })
  for (const held of members)
    test(`awaits ${held} ACK before continuing or settling`, async () => {
      const selected = fixture({ hold: held })
      let settled = false
      const pending = executeCustomObserverProgram(selected.factory, input()).finally(() => {
        settled = true
      })
      await selected.entered.promise
      expect(selected.trace).toEqual(members.slice(0, members.indexOf(held) + 1))
      expect(settled).toBe(false)
      selected.ack.resolve()
      await pending
      expect<readonly string[]>(selected.trace).toEqual(members)
    })
  for (const failed of members)
    test(`preserves ${failed} rejection and original cleanup boundary`, async () => {
      const error = new Error(`failed:${failed}`),
        selected = fixture({ fail: failed, error })
      await expect(executeCustomObserverProgram(selected.factory, input())).rejects.toBe(error)
      const expected: string[] = [...members.slice(0, members.indexOf(failed) + 1)]
      if (members.indexOf(failed) >= 2 && failed !== 'disposeWorkspace')
        expected.push('disposeWorkspace')
      expect(selected.trace).toEqual(expected)
    })
  for (const missing of members)
    test(`does not replace an incomplete selected ${missing} member with local effects`, async () => {
      const selected = fixture(),
        create = selected.factory.create.bind(selected.factory)
      const factory: CustomObserverProgramFactory = {
        create(value) {
          const family = create(value)
          Object.defineProperty(family, missing, { value: undefined })
          return family
        },
      }
      await expect(executeCustomObserverProgram(factory, input())).rejects.toBeInstanceOf(TypeError)
      expect(selected.trace).not.toContain(missing)
    })
  test('creates a fresh whole family for every execution and supports synchronous members', async () => {
    const selected = fixture()
    await executeCustomObserverProgram(selected.factory, input())
    await executeCustomObserverProgram(selected.factory, input())
    expect(selected.families).toHaveLength(2)
    expect(selected.families[0]).not.toBe(selected.families[1])
    const program = opaque(),
      workspace = opaque(),
      value = input()
    const factory: CustomObserverProgramFactory = {
      create() {
        return {
          resolveProgram: () => program,
          allocateWorkspace: () => workspace,
          prepareWorkspace() {},
          writeInput() {},
          writeProgram() {},
          run: () => result(value),
          disposeWorkspace() {},
        }
      },
    }
    expect((await executeCustomObserverProgram(factory, value)).batch.observations).toHaveLength(1)
    expect(selectLocalCustomObserverProgramFactory(factory)).toBe(factory)
  })
  test('unavailable interpreter does not enter cleanup', async () => {
    const selected = fixture({ unavailable: true })
    await expect(executeCustomObserverProgram(selected.factory, input())).rejects.toThrow(
      'script interpreter unavailable: node',
    )
    expect(selected.trace).toEqual(['resolveProgram'])
  })
  test('cleanup rejection overrides the original policy error and is awaited', async () => {
    const error = new Error('dispose overrides'),
      selected = fixture({
        fail: 'disposeWorkspace',
        error,
        settled: (value) => ({ ...result(value), rawStdout: '' }),
      })
    await expect(executeCustomObserverProgram(selected.factory, input())).rejects.toBe(error)
    expect<readonly string[]>(selected.trace).toEqual(members)
  })
  for (const outcome of [
    'exited',
    'timeout',
    'aborted',
    'spawn-failed',
    'child-unkillable',
  ] as const)
    test(`preserves ${outcome} failure and exact stderr suffix`, async () => {
      const selected = fixture({
        settled: (value) => ({
          ...result(value),
          outcome,
          exitCode: outcome === 'exited' ? 9 : null,
          stderrTail: `  ${'a'.repeat(2100)}tail  `,
        }),
      })
      await expect(executeCustomObserverProgram(selected.factory, input())).rejects.toThrow(
        `observer script failed: ${outcome}/${outcome === 'exited' ? '9' : 'no-exit'}: ${('a'.repeat(2100) + 'tail').slice(-2000)}`,
      )
      expect(selected.trace.at(-1)).toBe('disposeWorkspace')
    })
  for (const [stdout, truncated, message] of [
    ['', false, 'observer stdout is empty'],
    ['{}\n{}', false, 'observer stdout must contain exactly one JSON envelope'],
    ['{}', true, 'observer stdout exceeded platform budget'],
  ] as const)
    test(`keeps original stdout policy: ${message}`, async () => {
      const selected = fixture({
        settled: (value) => ({
          ...result(value),
          rawStdout: stdout,
          truncated: { stdout: truncated },
        }),
      })
      await expect(executeCustomObserverProgram(selected.factory, input())).rejects.toThrow(message)
      expect(selected.trace.at(-1)).toBe('disposeWorkspace')
    })
  test('envelope schema, unknown event and outside subject errors remain common policy', async () => {
    const invalids = [
      () => ({ ...output(input()), protocol: 'invalid' }),
      () => ({
        ...output(input()),
        observations: [{ ...output(input()).observations[0]!, eventKey: 'unknown' }],
      }),
      () => ({
        ...output(input()),
        observations: [{ ...output(input()).observations[0]!, subjectRef: 'outside' }],
      }),
    ]
    for (const invalid of invalids) {
      const selected = fixture({
        settled: (value) => ({ ...result(value), rawStdout: JSON.stringify(invalid()) }),
      })
      await expect(executeCustomObserverProgram(selected.factory, input())).rejects.toThrow()
      expect(selected.trace.at(-1)).toBe('disposeWorkspace')
    }
  })
  test('input cursor parse and output 64KB limit keep cleanup and exact threshold', async () => {
    const selected = fixture(),
      value = input()
    await expect(
      executeCustomObserverProgram(selected.factory, { ...value, cursorJson: '{' }),
    ).rejects.toThrow()
    expect(selected.trace).toEqual([
      'resolveProgram',
      'allocateWorkspace',
      'prepareWorkspace',
      'disposeWorkspace',
    ])
    expect(normalizedCursor('x'.repeat(65534))).toHaveLength(65536)
    expect(() => normalizedCursor('x'.repeat(65535))).toThrow('observer cursor exceeds 64KB')
    const huge = fixture({
      settled: (value) => ({
        ...result(value),
        rawStdout: JSON.stringify({ ...output(value), cursor: 'x'.repeat(65535) }),
      }),
    })
    await expect(executeCustomObserverProgram(huge.factory, value)).rejects.toThrow(
      'observer cursor exceeds 64KB',
    )
    expect(huge.trace.at(-1)).toBe('disposeWorkspace')
  })
  test('validation keeps fixture predicates before effects and original receipt', async () => {
    const selected = fixture(),
      value = input(),
      program = composeCustomEventObserverProgram({ store: store(), programs: selected.factory })
    await expect(
      program.validate({
        sourceRef: value.sourceRef,
        draft: { ...value.draft, fixture: { subjects: [], cursorJson: null } },
        now,
      }),
    ).rejects.toThrow('validation needs at least one real test object')
    await expect(
      program.validate({
        sourceRef: value.sourceRef,
        draft: {
          ...value.draft,
          fixture: { subjects: [{ typeId: 'other', subjectRef: 'one' }], cursorJson: null },
        },
        now,
      }),
    ).rejects.toThrow('validation needs a test object for subject type: issue')
    expect(selected.inputs).toEqual([])
    const receipt = await program.validate({ sourceRef: value.sourceRef, draft: value.draft, now })
    expect(receipt).toEqual({
      schemaVersion: 1,
      draftDigest: sha256Hex(canonicalJson(value.draft)),
      validatedAt: now,
      observationCount: 1,
      stdoutDigest: sha256Hex(
        result({ ...value, subjects: value.draft.fixture.subjects }).rawStdout.trim(),
      ),
    })
  })
  test('validation retains empty output and every-event proof requirements', async () => {
    const value = input()
    const empty = fixture({
      settled: (value) => ({
        ...result(value),
        rawStdout: JSON.stringify({ ...output(value), observations: [] }),
      }),
    })
    const program = composeCustomEventObserverProgram({ store: store(), programs: empty.factory })
    await expect(
      program.validate({ sourceRef: value.sourceRef, draft: value.draft, now }),
    ).rejects.toThrow('fixture must emit at least one observation')
    const selected = fixture(),
      twoEvents = {
        ...value.draft,
        eventTypes: [
          ...value.draft.eventTypes,
          { ...value.draft.eventTypes[0]!, eventKey: 'another.changed' },
        ],
      }
    await expect(
      composeCustomEventObserverProgram({ store: store(), programs: selected.factory }).validate({
        sourceRef: value.sourceRef,
        draft: twoEvents,
        now,
      }),
    ).rejects.toThrow('fixture did not prove event output: another.changed')
  })
  test('run requires the original published revision before creating effects and reads now once', async () => {
    const selected = fixture(),
      value = input()
    const request = {
      source: { sourceRef: value.sourceRef } as Parameters<
        ReturnType<typeof composeCustomEventObserverProgram>['run']
      >[0]['source'],
      subjects: value.subjects,
      cursorJson: value.cursorJson,
    }
    await expect(
      composeCustomEventObserverProgram({ store: store(), programs: selected.factory }).run(
        request,
      ),
    ).rejects.toThrow('custom observer source not found: selected-source@1')
    expect(selected.inputs).toEqual([])
    let reads = 0
    const published = {
      sourceRef: value.sourceRef,
      content: value.draft,
      contentDigest: sha256Hex(canonicalJson(value.draft)),
      validationReceipt: {
        schemaVersion: 1 as const,
        draftDigest: sha256Hex(canonicalJson(value.draft)),
        validatedAt: now,
        observationCount: 1,
        stdoutDigest: '0'.repeat(64),
      },
    }
    const program = composeCustomEventObserverProgram({
      store: store(published),
      programs: selected.factory,
      now: () => {
        reads++
        return now
      },
    })
    expect((await program.run(request)).observations).toHaveLength(1)
    expect(reads).toBe(1)
    expect(selected.inputs[0]).toMatchObject({
      sourceRef: value.sourceRef,
      draft: value.draft,
      cursorJson: value.cursorJson,
      now,
    })
  })
  test('local construction reads no input and foreign refs fail before later fields', async () => {
    let reads = 0
    const value = input()
    const program = {
      ...value.draft.program,
      get language(): never {
        reads++
        throw new Error('early language read')
      },
    }
    const effects = createLocalCustomObserverProgramFactory().create({
      ...value,
      draft: { ...value.draft, program },
    })
    expect(reads).toBe(0)
    const workspace = await effects.allocateWorkspace()
    try {
      await expect(Promise.resolve().then(() => effects.run(workspace, {}))).rejects.toThrow(
        'custom-observer-program-reference-mismatch',
      )
      expect(reads).toBe(0)
    } finally {
      await effects.disposeWorkspace(workspace)
    }
  })
})

describeEachProvider('RFC-370 selected custom observer actual Event Center path', (harness) => {
  test('validate, publish, observer cursor, dedupe and recomposition use the same selected family', async () => {
    let clock = now,
      ordinal = 0
    const selected = fixture(),
      options = {
        db: harness.db,
        typePackageDescriptorJsons: [],
        automation: { kind: 'observation-only' as const },
        customObserverPrograms: selected.factory,
        now: () => clock,
        id: () => `selected-${++ordinal}`,
        workerId: 'selected-observer-worker',
      }
    const module = await composeEventCenter(options),
      content = draft()
    const created = (await module.customSources.commands.create(content, null)) as { id: string }
    expect(await module.customSources.commands.validate(created.id)).toMatchObject({
      observationCount: 1,
    })
    const published = (await module.customSources.commands.publish(created.id, null)) as {
      sourceRef: { id: string; revision: number }
    }
    const subscriber = { kind: 'system' as const, subscriberRef: 'selected-consumer' }
    await module.participant.subscribe({
      eventTypeRef: { id: `custom.${created.id}.issue.changed`, revision: 1 },
      subject: content.fixture.subjects[0]!,
      subscriber,
    })
    expect(await module.worker.runOneDueObserver()).toBe('completed')
    const first = await module.participant.pendingDeliveries(subscriber, 10)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ sourceRef: published.sourceRef, summary: 'Changed' })
    clock += 1000
    const recomposed = await composeEventCenter(options)
    expect(await recomposed.worker.runOneDueObserver()).toBe('completed')
    expect(await recomposed.participant.pendingDeliveries(subscriber, 10)).toEqual(first)
    expect(selected.inputs).toHaveLength(4)
    expect(selected.inputs[0]?.cursorJson).toBe(null)
    expect(selected.inputs[1]?.cursorJson).toBe(null)
    expect(selected.inputs[2]?.cursorJson).toBe(null)
    expect(selected.inputs[3]?.cursorJson).toBe('{"next":2}')
    expect(selected.trace).toEqual([...members, ...members, ...members, ...members])
    await recomposed.participant.acceptDelivery(first[0]!.deliveryId)
    expect(await recomposed.participant.pendingDeliveries(subscriber, 10)).toEqual([])
  })
})
