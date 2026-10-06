import { canonicalJson } from '@agent-workflow/shared'
import { sha256Hex } from '@/util/hash'
import type { CustomEventSourceStorePort } from './ports/customEventSourceStore'
import type {
  CustomObserverProgramFactory,
  CustomObserverProgramInput,
} from './ports/customObserverProgram'
import type { CustomEventObserverProgramPort } from '../composition/required-ports'
import { cursorValue, normalizedCursor, dedupeKey } from '../domain/customObserverProgram'
import {
  CUSTOM_EVENT_OBSERVER_PROTOCOL,
  customEventTypeId,
  customObserverInputEnvelopeSchema,
  customObserverOutputEnvelopeSchema,
} from '../domain/customEventSource'
import { observerBatchSchema, type ObserverBatch } from '../domain/model'

export async function executeCustomObserverProgram(
  programs: CustomObserverProgramFactory,
  input: CustomObserverProgramInput,
): Promise<{ readonly batch: ObserverBatch; readonly stdoutDigest: string }> {
  const effects = programs.create(input)
  const interpreter = await effects.resolveProgram()
  if (interpreter === null) {
    throw new Error(`script interpreter unavailable: ${input.draft.program.language}`)
  }
  const directory = await effects.allocateWorkspace()
  try {
    await effects.prepareWorkspace(directory)
    const envelope = customObserverInputEnvelopeSchema.parse({
      protocol: CUSTOM_EVENT_OBSERVER_PROTOCOL,
      sourceRef: input.sourceRef,
      subjects: input.subjects,
      cursor: cursorValue(input.cursorJson),
      deadlineAt: new Date(input.now + input.draft.program.timeoutMs).toISOString(),
    })
    await effects.writeInput(directory, canonicalJson(envelope))
    await effects.writeProgram(directory)
    const result = await effects.run(directory, interpreter)
    if (result.outcome !== 'exited' || result.exitCode !== 0) {
      const detail = result.stderrTail.trim().slice(-2_000)
      throw new Error(
        `observer script failed: ${result.outcome}/${result.exitCode ?? 'no-exit'}${detail === '' ? '' : `: ${detail}`}`,
      )
    }
    if (result.truncated.stdout) throw new Error('observer stdout exceeded platform budget')
    const stdout = result.rawStdout.trim()
    if (stdout === '') throw new Error('observer stdout is empty')
    let raw: unknown
    try {
      raw = JSON.parse(stdout)
    } catch {
      throw new Error('observer stdout must contain exactly one JSON envelope')
    }
    const output = customObserverOutputEnvelopeSchema.parse(raw)
    const eventByKey = new Map(input.draft.eventTypes.map((event) => [event.eventKey, event]))
    const subjectKeys = new Set(
      input.subjects.map((subject) => `${subject.typeId}\u0000${subject.subjectRef}`),
    )
    const observations = output.observations.map((observation) => {
      const event = eventByKey.get(observation.eventKey)
      if (event === undefined)
        throw new Error(`observer returned unknown event key: ${observation.eventKey}`)
      if (!subjectKeys.has(`${event.subjectTypeId}\u0000${observation.subjectRef}`)) {
        throw new Error(
          `observer returned a subject outside its input batch: ${event.subjectTypeId}/${observation.subjectRef}`,
        )
      }
      return {
        sourceRef: input.sourceRef,
        eventTypeRef: {
          id: customEventTypeId(input.sourceRef.id, observation.eventKey),
          revision: input.sourceRef.revision,
        },
        subject: { typeId: event.subjectTypeId, subjectRef: observation.subjectRef },
        occurredAt: Date.parse(observation.occurredAt),
        dedupeKey: dedupeKey({
          ingestionMode: input.draft.ingestionMode,
          eventKey: observation.eventKey,
          subjectRef: observation.subjectRef,
          sourceEventKey: observation.sourceEventKey,
          sourceEventRevision: observation.sourceEventRevision,
        }),
        summary: observation.summary,
        payloadArtifactRef: observation.payloadArtifactRef ?? null,
        triggerParameters: observation.triggerParameters ?? null,
      }
    })
    return {
      batch: observerBatchSchema.parse({
        schemaVersion: 1,
        cursorJson: normalizedCursor(output.cursor),
        observations,
      }),
      stdoutDigest: sha256Hex(stdout),
    }
  } finally {
    await effects.disposeWorkspace(directory)
  }
}

export function createCustomEventObserverProgram(input: {
  readonly store: CustomEventSourceStorePort
  readonly programs: CustomObserverProgramFactory
  readonly now?: () => number
}): CustomEventObserverProgramPort {
  const now = input.now ?? Date.now
  return {
    async run(request) {
      const published = await input.store.getPublished(request.source.sourceRef)
      if (published === null) {
        throw new Error(
          `custom observer source not found: ${request.source.sourceRef.id}@${request.source.sourceRef.revision}`,
        )
      }
      return (
        await executeCustomObserverProgram(input.programs, {
          sourceRef: request.source.sourceRef,
          draft: published.content,
          subjects: request.subjects,
          cursorJson: request.cursorJson,
          now: now(),
        })
      ).batch
    },

    async validate(request) {
      const fixtureTypes = new Set(request.draft.fixture.subjects.map((subject) => subject.typeId))
      if (request.draft.fixture.subjects.length === 0) {
        throw new Error('validation needs at least one real test object')
      }
      for (const event of request.draft.eventTypes) {
        if (!fixtureTypes.has(event.subjectTypeId)) {
          throw new Error(`validation needs a test object for subject type: ${event.subjectTypeId}`)
        }
      }
      const result = await executeCustomObserverProgram(input.programs, {
        sourceRef: request.sourceRef,
        draft: request.draft,
        subjects: request.draft.fixture.subjects,
        cursorJson: request.draft.fixture.cursorJson,
        now: request.now,
      })
      if (result.batch.observations.length === 0) {
        throw new Error('fixture must emit at least one observation')
      }
      const emitted = new Set(
        result.batch.observations.map((observation) => observation.eventTypeRef.id),
      )
      for (const event of request.draft.eventTypes) {
        if (!emitted.has(customEventTypeId(request.sourceRef.id, event.eventKey))) {
          throw new Error(`fixture did not prove event output: ${event.eventKey}`)
        }
      }
      return {
        schemaVersion: 1,
        draftDigest: sha256Hex(canonicalJson(request.draft)),
        validatedAt: request.now,
        observationCount: result.batch.observations.length,
        stdoutDigest: result.stdoutDigest,
      }
    },
  }
}
