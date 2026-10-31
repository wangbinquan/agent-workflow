// Locks the claude-code session id of the workgroup-matrix stub against pid reuse.
// CI runs 35512158270 (2026-09-20) and 41153577424 (2026-10-31) failed the
// claude-code leader-worker e2e on Windows with six leader runs instead of five:
// the stub named its session `stub-workgroup-<agent>-<pid>`, Windows recycles pids
// within seconds, and a released runtime-session lease stays until its task ends,
// so a later round of the same agent hit the lease key (runtime-session-conflict)
// and needed a protocol retry. The id now carries a per-process random part.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dispatcher = fileURLToPath(new URL('../src/runtime/dispatch.ts', import.meta.url))
const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

async function researcherSession(): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'aw-wg-matrix-session-'))
  directories.push(directory)
  const systemPrompt = join(directory, 'system-prompt.md')
  writeFileSync(systemPrompt, '[AW_SCENARIO_AGENT:showcase-wg-researcher]\n')
  const child = Bun.spawn(
    [process.execPath, dispatcher, '-p', '--append-system-prompt-file', systemPrompt],
    {
      cwd: directory,
      env: {
        ...process.env,
        AW_STUB_MODE: 'workgroup-matrix',
        WORKGROUP_MATRIX_STATE_DIR: join(directory, 'state'),
      },
      stdin: new Blob(['nonce="session-nonce"\nWG_MATRIX_CHARTER\nTitle: research-release\n']),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(stderr).toBe('')
  expect(code).toBe(0)
  const frames = stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { type: string; session_id?: string })
  const ids = new Set(frames.map((frame) => frame.session_id))
  expect(frames.map((frame) => frame.type)).toEqual(['system', 'assistant', 'result'])
  expect(ids.size).toBe(1)
  return [...ids][0]!
}

test('every claude-code invocation names a session that a recycled pid cannot repeat', async () => {
  const first = await researcherSession()
  const second = await researcherSession()
  const shape =
    /^stub-workgroup-showcase-wg-researcher-(\d+)-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/
  const [, firstPid, firstNonce] = shape.exec(first) ?? []
  const [, secondPid, secondNonce] = shape.exec(second) ?? []
  expect(firstPid).toBeDefined()
  expect(secondPid).toBeDefined()
  // Two processes that received the same pid must still get distinct sessions.
  expect(firstNonce).not.toBe(secondNonce)
  expect(first).not.toBe(second)
})
