import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type {
  VerificationCommandEffectsFactory,
  VerificationProgramRef,
} from '../application/ports/verificationCommandEffects'
import type { HostedVerificationReceipt } from './taskImageVerification'

export function createCrewStationVerificationCommandEffectsFactory(input: {
  readonly helper: WorkspaceHelper
  readonly locate: (reference: string) => { readonly taskId: string; readonly path: string }
  readonly reference: (taskId: string, path: string) => string
  readonly retainWorkspace: (reference: string, retained: boolean) => void
}): VerificationCommandEffectsFactory {
  return {
    async environment(workspaceRef) {
      const source = input.locate(workspaceRef)
      return await input.helper.call(source.taskId, 'verification-command', {
        method: 'environment',
        path: source.path,
      })
    },
    create({ evidence }) {
      const programs = new WeakMap<
        VerificationProgramRef,
        { programRef: string; argsRef: string | null; workspaceRef: string; id: string }
      >()
      return {
        async invokeBehavior(request) {
          const source = input.locate(request.workspaceRef)
          input.retainWorkspace(request.workspaceRef, true)
          const result = await input.helper.call<{
            exitCode: number
            timedOut: boolean
            outputJson: string
            error: string
          }>(
            source.taskId,
            'verification-command',
            {
              method: 'behavior',
              path: source.path,
              id: randomUUID(),
              programRef: request.programRef,
              inputJson: request.inputJson,
              timeoutMs: request.timeoutMs,
            },
            { timeoutMs: request.timeoutMs + 30_000 },
          )
          input.retainWorkspace(request.workspaceRef, false)
          return result
        },
        async resolveProgram(request) {
          const source = input.locate(request.workspaceRef)
          if (
            !(await input.helper.call<boolean>(source.taskId, 'verification-command', {
              method: 'resolve',
              path: source.path,
              programRef: request.programRef,
              argsRef: request.argsRef,
            }))
          )
            return null
          const ref = {}
          programs.set(ref, { ...request, id: randomUUID() })
          return ref
        },
        async execute({ program, workspaceRef, step }) {
          const spec = programs.get(program)
          if (
            spec === undefined ||
            spec.workspaceRef !== workspaceRef ||
            spec.programRef !== step.programRef ||
            spec.argsRef !== step.argsRef
          )
            throw new Error('hosted-verification-program-owner-mismatch')
          const source = input.locate(workspaceRef)
          input.retainWorkspace(workspaceRef, true)
          // An uncertain call leaves the workspace retained. A retry uses the same
          // CS request and the task-image receipt; it cannot launch another writer.
          const receipt = await input.helper.call<HostedVerificationReceipt>(
            source.taskId,
            'verification-command',
            {
              method: 'run',
              path: source.path,
              id: spec.id,
              step,
            },
            { operationId: `verification:${spec.id}`, timeoutMs: step.timeoutMs + 30_000 },
          )
          input.retainWorkspace(workspaceRef, false)
          const outputTailRef =
            receipt.outputFile === null
              ? null
              : (await evidence.putBlobFromFile(input.reference(source.taskId, receipt.outputFile)))
                  .sha256
          await input.helper.call(
            source.taskId,
            'verification-command',
            { method: 'dispose', id: spec.id },
            { operationId: `verification-dispose:${spec.id}` },
          )
          return { exitCode: receipt.exitCode, timedOut: receipt.timedOut, outputTailRef }
        },
        async collectFiles({ workspaceRef, pattern }) {
          const source = input.locate(workspaceRef)
          const paths = await input.helper.call<string[]>(source.taskId, 'verification-command', {
            method: 'collect',
            path: source.path,
            pattern,
          })
          const result = []
          for (const path of paths)
            result.push({
              selector: `file-glob:${pattern}`,
              path,
              ...(await evidence.putBlobFromFile(
                input.reference(source.taskId, posix.join(source.path, path)),
              )),
            })
          return result
        },
      }
    },
  }
}
