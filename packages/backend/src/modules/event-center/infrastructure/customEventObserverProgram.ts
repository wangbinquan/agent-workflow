import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJson } from '@agent-workflow/shared'

import { INTERPRETER_SPEC, resolveScriptInterpreter } from '@/services/scriptRun'
import { runManagedProcess } from '@/services/execution/managedProcess'
import { sha256Hex } from '@/util/hash'
import type { CustomEventSourceStorePort } from '../application/ports/customEventSourceStore'
import type { CustomEventObserverProgramPort } from '../composition/required-ports'
import {
  CUSTOM_EVENT_OBSERVER_PROTOCOL,
  customEventTypeId,
  customObserverInputEnvelopeSchema,
  customObserverOutputEnvelopeSchema,
  type CustomEventSourceDraft,
} from '../domain/customEventSource'
import { observerBatchSchema, type EventSubject, type ObserverBatch } from '../domain/model'

function cleanProcessEnv(inputFile: string): Record<string, string> {
  const result: Record<string, string> = {
    AW_EVENT_INPUT_FILE: inputFile,
    AW_EVENT_OBSERVER_PROTOCOL: CUSTOM_EVENT_OBSERVER_PROTOCOL,
  }
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR']) {
    const value = process.env[name]
    if (value !== undefined) result[name] = value
  }
  return result
}

function cursorValue(cursorJson: string | null): unknown | null {
  return cursorJson === null ? null : (JSON.parse(cursorJson) as unknown)
}

function normalizedCursor(value: unknown | null): string | null {
  if (value === null) return null
  const json = canonicalJson(value)
  if (json.length > 64 * 1024) throw new Error('observer cursor exceeds 64KB')
  return json
}

function dedupeKey(input: {
  readonly ingestionMode: CustomEventSourceDraft['ingestionMode']
  readonly eventKey: string
  readonly subjectRef: string
  readonly sourceEventKey: string
  readonly sourceEventRevision: string
}): string {
  return sha256Hex(canonicalJson(input))
}

async function execute(input: {
  readonly sourceRef: { readonly id: string; readonly revision: number }
  readonly draft: CustomEventSourceDraft
  readonly subjects: readonly EventSubject[]
  readonly cursorJson: string | null
  readonly now: number
}): Promise<{ readonly batch: ObserverBatch; readonly stdoutDigest: string }> {
  const interpreter = await resolveScriptInterpreter(input.draft.program.language, {})
  if (interpreter === null) {
    throw new Error(`script interpreter unavailable: ${input.draft.program.language}`)
  }
  const directory = mkdtempSync(join(tmpdir(), 'aw-event-observer-'))
  try {
    const inputFile = join(directory, 'input.json')
    const runDir = join(directory, 'run')
    mkdirSync(runDir, { recursive: true })
    const envelope = customObserverInputEnvelopeSchema.parse({
      protocol: CUSTOM_EVENT_OBSERVER_PROTOCOL,
      sourceRef: input.sourceRef,
      subjects: input.subjects,
      cursor: cursorValue(input.cursorJson),
      deadlineAt: new Date(input.now + input.draft.program.timeoutMs).toISOString(),
    })
    writeFileSync(inputFile, canonicalJson(envelope), 'utf8')
    const spec = INTERPRETER_SPEC[input.draft.program.language]
    const scriptPath = join(runDir, `observer.${spec.ext}`)
    writeFileSync(scriptPath, input.draft.program.source, 'utf8')
    const result = await runManagedProcess({
      argv: spec.argv(interpreter.path, scriptPath),
      cwd: runDir,
      env: cleanProcessEnv(inputFile),
      timeoutMs: input.draft.program.timeoutMs,
      captureRawStdout: true,
    })
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
    rmSync(directory, { recursive: true, force: true })
  }
}

export function createCustomEventObserverProgram(input: {
  readonly store: CustomEventSourceStorePort
  readonly now?: () => number
}): CustomEventObserverProgramPort {
  const now = input.now ?? Date.now
  return {
    async run(request) {
      const published = input.store.getPublished(request.source.sourceRef)
      if (published === null) {
        throw new Error(
          `custom observer source not found: ${request.source.sourceRef.id}@${request.source.sourceRef.revision}`,
        )
      }
      return (
        await execute({
          sourceRef: request.source.sourceRef,
          draft: published.content,
          subjects: request.subjects,
          cursorJson: request.cursorJson,
          now: now(),
        })
      ).batch
    },

    async validate(request) {
      const result = await execute({
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
