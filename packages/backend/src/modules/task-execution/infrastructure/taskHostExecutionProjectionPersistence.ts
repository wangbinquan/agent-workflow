import type { ProviderNeutralDatabase } from '@/db/query'
import type { TaskEngineApplicationPersistence } from '../application/ports/taskEngineApplicationPersistence'
import type { WrapperRunPersistence } from '../application/ports/wrapperRunPersistence'
import type { RuntimeSessionCapturePersistence } from '../application/ports/runtimeSessionCapturePersistence'
import { runWithTaskExecutionContext } from '../application/taskExecutionContext'
import { withTaskHostIssuedAck, type TaskHostWriteBinding } from './hostExecutionWriteTransaction'
import {
  captureTaskHostExecutionWrite,
  type TaskHostExecutionWriteSelection,
} from './taskHostExecutionWriteSelection'

/** Only these received execution projections are ACKs; all native reads remain independent. */
export function createSelectedTaskExecutionProjectionPersistence(input: {
  readonly db: ProviderNeutralDatabase
  readonly hostWrites: TaskHostWriteBinding
  readonly drive: TaskEngineApplicationPersistence
  readonly wrapperRuns: WrapperRunPersistence
  readonly runtimeSessionCapture: RuntimeSessionCapturePersistence
}): {
  readonly drive: TaskEngineApplicationPersistence
  readonly wrapperRuns: WrapperRunPersistence
  readonly runtimeSessionCapture: RuntimeSessionCapturePersistence
} {
  const { db, hostWrites: binding, drive, wrapperRuns, runtimeSessionCapture } = input
  if (binding === undefined) throw new Error('task-host-write-selection-incomplete')
  const load = drive.load
  const findStatus = drive.findStatus
  const updateWorkspaceProfile = drive.updateWorkspaceProfile
  const findResumable = wrapperRuns.findResumable
  const resolveConsumed = wrapperRuns.resolveConsumed
  const readStatus = wrapperRuns.readStatus
  const clearReuseDisabled = wrapperRuns.clearReuseDisabled
  const resolveTaskId = runtimeSessionCapture.resolveTaskId
  const listSiblingCapturedSessionIds = runtimeSessionCapture.listSiblingCapturedSessionIds
  const appendEvents = runtimeSessionCapture.appendEvents

  function issuedAck<T>(work: TaskHostExecutionWriteSelection, body: () => Promise<T>): Promise<T> {
    return withTaskHostIssuedAck({
      db,
      selection: work.selection,
      body: () => runWithTaskExecutionContext(work.context, body),
    })
  }

  return Object.freeze({
    drive: Object.freeze({
      async load(taskId) {
        return await load.call(drive, taskId)
      },
      async findStatus(taskId) {
        return await findStatus.call(drive, taskId)
      },
      async updateWorkspaceProfile(profile) {
        const work = captureTaskHostExecutionWrite(binding, profile)
        return await issuedAck(work, () => updateWorkspaceProfile.call(drive, profile))
      },
    } satisfies TaskEngineApplicationPersistence),
    wrapperRuns: Object.freeze({
      async findResumable(query) {
        return await findResumable.call(wrapperRuns, query)
      },
      async resolveConsumed(query) {
        return await resolveConsumed.call(wrapperRuns, query)
      },
      async readStatus(nodeRunId) {
        return await readStatus.call(wrapperRuns, nodeRunId)
      },
      async clearReuseDisabled(wrapper) {
        const work = captureTaskHostExecutionWrite(binding, wrapper)
        return await issuedAck(work, () => clearReuseDisabled.call(wrapperRuns, wrapper))
      },
    } satisfies WrapperRunPersistence),
    runtimeSessionCapture: Object.freeze({
      async resolveTaskId(nodeRunId) {
        return await resolveTaskId.call(runtimeSessionCapture, nodeRunId)
      },
      async listSiblingCapturedSessionIds(query) {
        return await listSiblingCapturedSessionIds.call(runtimeSessionCapture, query)
      },
      async appendEvents(transcript) {
        if (transcript.events.length === 0)
          return await appendEvents.call(runtimeSessionCapture, transcript)
        const work = captureTaskHostExecutionWrite(binding, transcript)
        return await issuedAck(work, () => appendEvents.call(runtimeSessionCapture, transcript))
      },
    } satisfies RuntimeSessionCapturePersistence),
  })
}
