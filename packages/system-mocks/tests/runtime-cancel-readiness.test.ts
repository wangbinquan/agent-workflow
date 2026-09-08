// RFC-359 W20: cancellation must observe the target runtime, not only the
// daemon's earlier launcher PID receipt. Exercise the real dispatcher process;
// the opt-in marker is emitted before its unchanged sleeping cancel branch.

import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const DISPATCHER = resolve(import.meta.dir, '../src/runtime/dispatch.ts')

async function observeFile(filePath: string): Promise<boolean> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return true
    await Bun.sleep(20)
  }
  return existsSync(filePath)
}

function startRuntime(mode: 'cancel' | 'fail', readyEnabled: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'aw-runtime-cancel-ready-'))
  const taskId = 'runtime-cancel-task'
  const prompt = [
    'MATRIX_RUNTIME',
    '<aw-input name="mode">',
    mode,
    '</aw-input>',
    `task=${taskId}`,
    '<workflow-output nonce="runtime-cancel-test">',
  ].join('\n')
  const promptPath = join(dir, 'actual-prompt.txt')
  const readyPath = join(dir, `cancel-started-${taskId}.json`)
  const env: Record<string, string | undefined> = {
    ...process.env,
    AW_STUB_MODE: 'workflow-matrix',
    AW_STUB_PROMPT_OUT: promptPath,
    MATRIX_STATE_DIR: dir,
  }
  delete env.MATRIX_CANCEL_READY_DIR
  if (readyEnabled) env.MATRIX_CANCEL_READY_DIR = dir
  const child = Bun.spawn({
    cmd: [process.execPath, DISPATCHER, 'run', '--format', 'json', '--', prompt],
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  let exited = false
  const completion = child.exited.then((code) => {
    exited = true
    return code
  })
  return {
    dir,
    taskId,
    prompt,
    promptPath,
    readyPath,
    child,
    stdout,
    stderr,
    completion,
    hasExited: () => exited,
    async dispose() {
      try {
        if (!exited) child.kill('SIGKILL')
      } finally {
        try {
          await Promise.allSettled([completion, stdout, stderr])
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      }
    },
  }
}

test('opt-in cancel readiness identifies the actual live target before any output', async () => {
  const runtime = startRuntime('cancel', true)
  try {
    const observed = await observeFile(runtime.readyPath)
    // If the marker is missing, distinguish it from a dispatcher/import failure:
    // this exact runtime must already have parsed the real cancel prompt.
    expect(readFileSync(runtime.promptPath, 'utf8')).toBe(runtime.prompt)
    expect(runtime.hasExited()).toBe(false)
    expect(observed).toBe(true)
    const ready: unknown = JSON.parse(readFileSync(runtime.readyPath, 'utf8'))
    expect(ready).toEqual({ taskId: runtime.taskId, pid: runtime.child.pid })
    runtime.child.kill('SIGTERM')
    await runtime.completion
    expect(await runtime.stdout).toBe('')
    expect(await runtime.stderr).toBe('')
  } finally {
    await runtime.dispose()
  }
})

test('cancel readiness is absent unless explicitly enabled', async () => {
  const runtime = startRuntime('cancel', false)
  try {
    expect(await observeFile(runtime.promptPath)).toBe(true)
    expect(readFileSync(runtime.promptPath, 'utf8')).toBe(runtime.prompt)
    expect(runtime.hasExited()).toBe(false)
    expect(existsSync(runtime.readyPath)).toBe(false)
    runtime.child.kill('SIGTERM')
    await runtime.completion
    expect(await runtime.stdout).toBe('')
    expect(await runtime.stderr).toBe('')
    expect(readdirSync(runtime.dir)).toEqual(['actual-prompt.txt'])
  } finally {
    await runtime.dispose()
  }
})

test('opt-in readiness leaves non-cancel failure output and state unchanged', async () => {
  const runtime = startRuntime('fail', true)
  try {
    expect(await runtime.completion).toBe(13)
    expect(await runtime.stdout).toBe('')
    expect(await runtime.stderr).toBe('intentional permanent runtime failure\n')
    expect(existsSync(runtime.readyPath)).toBe(false)
    expect(readdirSync(runtime.dir)).toEqual(['actual-prompt.txt'])
  } finally {
    await runtime.dispose()
  }
})
