import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { requireWorkPath } from '@/platform/crewstation/workVolumePath'
import { assertTargetDirInsideWorktree } from '@/platform/content/local/uploadPaths'
import { resolveScriptInterpreter } from '@/services/scriptRun'
import type { CustomObserverProgramInput } from '../application/ports/customObserverProgram'
import { createLocalCustomObserverProgram } from '../infrastructure/local/customObserverProgram'

export const TASK_IMAGE_OBSERVER_OPERATIONS = [
  'observer-resolve',
  'observer-run',
  'observer-dispose',
] as const

export async function executeTaskImageObserver(
  operation: string,
  value: unknown,
  signal?: AbortSignal,
  root = '/work',
) {
  if (operation === 'observer-resolve') {
    const { language } = value as {
      language: CustomObserverProgramInput['draft']['program']['language']
    }
    return (await resolveScriptInterpreter(language, {})) !== null
  }
  const input = value as { id: string; input: CustomObserverProgramInput; envelopeJson: string }
  if (!/^[a-f0-9]{64}$/.test(input.id)) throw new Error('hosted-observer-workspace-invalid')
  const directory = requireWorkPath(join(root, 'observers', input.id), root)
  assertTargetDirInsideWorktree(root, directory)
  if (operation === 'observer-dispose') {
    rmSync(directory, { recursive: true, force: true })
    return null
  }
  if (operation !== 'observer-run') throw new Error('hosted-observer-operation-unknown')
  const effects = createLocalCustomObserverProgram(input.input, { directory, signal })
  const program = await effects.resolveProgram()
  if (program === null) throw new Error('hosted-observer-interpreter-unavailable')
  const workspace = await effects.allocateWorkspace()
  await effects.prepareWorkspace(workspace)
  await effects.writeInput(workspace, input.envelopeJson)
  await effects.writeProgram(workspace)
  // Disposal is a separate confirmed-terminal action; failed/unknown commands
  // retain their directory so the control plane never races a surviving writer.
  return effects.run(workspace, program)
}
