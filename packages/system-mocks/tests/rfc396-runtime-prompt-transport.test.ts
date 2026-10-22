// RFC-396 / c70dfe096: Windows switched medium OpenCode prompts to stdin.
// The recorded mindmap's second round then lost its nonce because only the
// graph fixture understood that transport. Exercise the common dispatcher and
// real child I/O, retaining the explicit-argv and Claude protocol boundaries.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import recording from '../src/runtime/fixtures/rfc372-real-mindmap.json'

const dispatcher = fileURLToPath(new URL('../src/runtime/dispatch.ts', import.meta.url))
const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})
function workspace() {
  const path = mkdtempSync(join(tmpdir(), 'aw-rfc396-transport-'))
  directories.push(path)
  return path
}
async function invoke(
  directory: string,
  mode: string,
  argv: string[],
  input: string,
  env: Record<string, string> = {},
) {
  const child = Bun.spawn([process.execPath, dispatcher, ...argv], {
    cwd: directory,
    env: {
      ...process.env,
      ...env,
      AW_STUB_MODE: mode,
      AW_STUB_PROMPT_OUT: join(directory, 'prompt'),
    },
    stdin: new Blob([input]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, code }
}
const flags = ['run', '--agent', 'transport-agent', '--format', 'json']
const nonce = '<workflow-output nonce="transport-exact-nonce">'

test('the shared OpenCode transport preserves a medium CJK prompt and its final nonce', async () => {
  const directory = workspace()
  const prompt = '中文 "quoted" \\path\n'.repeat(2000) + nonce
  expect(prompt.length).toBeGreaterThan(32_767)
  expect(Buffer.byteLength(prompt)).toBeLessThan(120 * 1024)
  const result = await invoke(directory, 'basic', flags, prompt)
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  expect(readFileSync(join(directory, 'prompt'), 'utf8')).toBe(prompt)
  expect(JSON.parse(result.stdout).part.text).toContain(nonce)
})

test('a recorded cross-review receives its complete upstream design over stdin', async () => {
  const directory = workspace()
  const prompt = `审阅下列已澄清的设计\n业务范围 数据一致性 体验与验收\n${recording.draftDocument}\n${nonce}`
  expect(prompt.length * 2).toBeGreaterThan(30_000)
  const result = await invoke(directory, 'clarify', flags, prompt, {
    CLARIFY_STUB_STATE: directory,
    CLARIFY_STUB_MINDMAP_SCENARIO: 'recorded-live-design',
  })
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  expect(readFileSync(join(directory, 'prompt'), 'utf8')).toBe(prompt)
  const text = JSON.parse(result.stdout).part.text as string
  expect(text).toContain('<workflow-clarify nonce="transport-exact-nonce">')
  for (const question of recording.cross.questions.slice(0, 3))
    expect(text).toContain(question.title)
  expect(JSON.parse(readFileSync(join(directory, 'recorded-mindmap.ndjson'), 'utf8'))).toEqual({
    kind: 'cross-questions',
  })
})

for (const protocol of ['opencode', 'claude-code'] as const) {
  test(`plan-driven ${protocol} still receives exact user and system prompts`, async () => {
    const directory = workspace()
    const prompt = 'AW_SCENARIO_TASK=transport AW_SCENARIO_NODE=review\n完整正文\n' + nonce
    const systemPrompt = '[AW_SCENARIO_AGENT:transport-agent]\n原始系统材料'
    const planFile = join(directory, 'plan.json')
    const systemFile = join(directory, 'system.md')
    writeFileSync(systemFile, systemPrompt)
    writeFileSync(
      planFile,
      JSON.stringify({
        version: 1,
        agents: {
          'transport-agent': [
            {
              requirePrompt: [prompt],
              requireSystemPrompt: [systemPrompt],
              output: { report: 'transport-verified' },
            },
          ],
        },
      }),
    )
    const result = await invoke(
      directory,
      'runtime-scenario',
      protocol === 'opencode' ? flags : ['-p', '--append-system-prompt-file', systemFile],
      prompt,
      {
        SCENARIO_PLAN_FILE: planFile,
        SCENARIO_STATE_DIR: directory,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          agent: { 'transport-agent': { prompt: systemPrompt } },
        }),
      },
    )
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(readFileSync(join(directory, 'prompt'), 'utf8')).toBe(prompt)
    expect(result.stdout).toContain('transport-verified')
  })
}

test('explicit empty positional and a flag nonce cannot fall back to a piped prompt', async () => {
  const directory = workspace()
  const result = await invoke(
    directory,
    'basic',
    [...flags, '--session', 'nonce="flag"', '--', ''],
    nonce,
  )
  expect(result.code).toBe(3)
  expect(result.stderr).toContain('prompt is missing the RFC-200 envelope nonce')
  expect(readFileSync(join(directory, 'prompt'), 'utf8')).toBe('')
})

test('version and explicit positional calls finish even while stdin remains open', async () => {
  for (const argv of [['--version'], [...flags, '--', nonce]]) {
    const child = Bun.spawn([process.execPath, dispatcher, ...argv], {
      env: { ...process.env, AW_STUB_MODE: 'basic' },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      const code = await Promise.race([
        child.exited,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error('unexpected stdin read')), 3000)
        }),
      ])
      expect(code).toBe(0)
      expect(await new Response(child.stderr).text()).toBe('')
    } finally {
      clearTimeout(deadline)
      child.stdin.end()
      child.kill()
      await child.exited
    }
  }
})
