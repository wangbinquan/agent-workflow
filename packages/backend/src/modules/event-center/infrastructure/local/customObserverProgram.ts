import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  INTERPRETER_SPEC,
  resolveScriptInterpreter,
  type ResolvedInterpreter,
} from '@/services/scriptRun'
import { runManagedProcess } from '@/platform/execution/local/managedProcess'
import { CUSTOM_EVENT_OBSERVER_PROTOCOL } from '../../domain/customEventSource'
import type {
  CustomObserverProgramFactory,
  CustomObserverProgramEffects,
  CustomObserverProgramInput,
  CustomObserverProgramRef,
  CustomObserverWorkspaceRef,
} from '../../application/ports/customObserverProgram'

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

type InterpreterSpec =
  (typeof INTERPRETER_SPEC)[CustomObserverProgramInput['draft']['program']['language']]
interface LocalWorkspace {
  readonly directory: string
  inputFile?: string
  runDir?: string
  scriptPath?: string
  spec?: InterpreterSpec
}

function createLocalCustomObserverProgram(
  input: CustomObserverProgramInput,
): CustomObserverProgramEffects {
  const programs = new WeakMap<CustomObserverProgramRef, ResolvedInterpreter>()
  const workspaces = new WeakMap<CustomObserverWorkspaceRef, LocalWorkspace>()
  const workspaceFor = (ref: CustomObserverWorkspaceRef): LocalWorkspace => {
    const workspace = workspaces.get(ref)
    if (workspace === undefined) throw new Error('custom-observer-workspace-reference-mismatch')
    return workspace
  }
  return {
    async resolveProgram() {
      const interpreter = await resolveScriptInterpreter(input.draft.program.language, {})
      if (interpreter === null) return null
      const ref = {}
      programs.set(ref, interpreter)
      return ref
    },
    allocateWorkspace() {
      const directory = mkdtempSync(join(tmpdir(), 'aw-event-observer-'))
      const ref = {}
      workspaces.set(ref, { directory })
      return ref
    },
    prepareWorkspace(ref) {
      const workspace = workspaceFor(ref)
      const directory = workspace.directory
      const inputFile = join(directory, 'input.json')
      const runDir = join(directory, 'run')
      workspace.inputFile = inputFile
      workspace.runDir = runDir
      mkdirSync(runDir, { recursive: true })
    },
    writeInput(ref, envelopeJson) {
      const workspace = workspaceFor(ref)
      writeFileSync(workspace.inputFile!, envelopeJson, 'utf8')
    },
    writeProgram(ref) {
      const workspace = workspaceFor(ref)
      const runDir = workspace.runDir!
      const spec = INTERPRETER_SPEC[input.draft.program.language]
      const scriptPath = join(runDir, `observer.${spec.ext}`)
      workspace.spec = spec
      workspace.scriptPath = scriptPath
      writeFileSync(scriptPath, input.draft.program.source, 'utf8')
    },
    async run(ref, programRef) {
      const workspace = workspaceFor(ref)
      const interpreter = programs.get(programRef)
      if (interpreter === undefined) throw new Error('custom-observer-program-reference-mismatch')
      const spec = workspace.spec!
      const scriptPath = workspace.scriptPath!
      const runDir = workspace.runDir!
      const inputFile = workspace.inputFile!
      return await runManagedProcess({
        argv: spec.argv(interpreter.path, scriptPath),
        cwd: runDir,
        env: cleanProcessEnv(inputFile),
        timeoutMs: input.draft.program.timeoutMs,
        captureRawStdout: true,
      })
    },
    disposeWorkspace(ref) {
      const directory = workspaceFor(ref).directory
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

export function createLocalCustomObserverProgramFactory(): CustomObserverProgramFactory {
  return { create: createLocalCustomObserverProgram }
}
