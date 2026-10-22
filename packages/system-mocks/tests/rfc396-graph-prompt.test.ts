// RFC-396: Windows review prompts now use stdin below Linux's 120 KiB limit.
// Exercise the real dispatcher so the E2E fixture cannot silently lose the
// frozen basis or nonce when the production transport switches away from argv.
import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

const dispatcher = fileURLToPath(new URL('../src/runtime/dispatch.ts', import.meta.url))
async function invoke(args: string[], input?: string) {
  const child = Bun.spawn([process.execPath, dispatcher, ...args], {
    env: { ...process.env, AW_STUB_MODE: 'graph-development' },
    stdin: input === undefined ? 'ignore' : new Blob([input]),
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
function reviewPrompt(padding = '') {
  return (
    '\nINPUT_JSON\n' +
    JSON.stringify({
      materials: { reviewDocumentPath: 'frozen/完整 basis.md', basis: { padding } },
    }) +
    '\n<workflow-output nonce="exact-review-nonce">'
  )
}
const flags = ['run', '--agent', 'graph-development-review-material-v1', '--format', 'json']

test('a piped medium review reaches the original path and exact envelope nonce', async () => {
  const prompt = reviewPrompt('"frozen\\basis"\n'.repeat(3000))
  expect(prompt.length).toBeGreaterThan(32_767)
  expect(Buffer.byteLength(prompt)).toBeLessThan(120 * 1024)
  const result = await invoke(flags, prompt)
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  expect(JSON.parse(result.stdout).part.text).toBe(
    '<workflow-output nonce="exact-review-nonce">\n' +
      '  <port name="basis-document">frozen/完整 basis.md</port>\n</workflow-output>',
  )
})

test('an explicit positional prompt preserves the same review output', async () => {
  const result = await invoke([...flags, '--', reviewPrompt()])
  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout).part.text).toContain('frozen/完整 basis.md')
  expect(JSON.parse(result.stdout).part.text).toContain('nonce="exact-review-nonce"')
})

test('missing prompt still fails and cannot mistake a flag for a nonce', async () => {
  const result = await invoke([...flags, '--session', 'nonce="wrong"'], '')
  expect(result.code).toBe(3)
  expect(result.stderr).toContain('prompt is missing the RFC-200 envelope nonce')
  const explicitEmpty = await invoke([...flags, '--', ''], reviewPrompt())
  expect(explicitEmpty.code).toBe(3)
})

test('version probing never waits for prompt input', async () => {
  const result = await invoke(['--version'])
  expect(result).toEqual({ code: 0, stdout: '1.0.0\n', stderr: '' })
})
