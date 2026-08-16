// Regression guard for CI run 31928125598: Playwright starts globalSetup under
// Node, where writing a smart-HTTP request body to a git child that has already
// closed stdin emits EPIPE asynchronously. Without an error listener on the
// writable socket, that event terminates the entire system mock gateway.

import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { runChecked } from '../src/core/process'

test('runProcess survives when a Node child closes stdin before a large body is written', async () => {
  const node = Bun.which('node')
  expect(node).not.toBeNull()

  const processModule = pathToFileURL(
    resolve(import.meta.dir, '..', 'src', 'core', 'process.ts'),
  ).href
  const probe = [
    `import { runProcess } from ${JSON.stringify(processModule)}`,
    'const result = await runProcess(process.execPath,',
    "  ['--input-type=module', '-e', 'process.exit(0)'],",
    '  { input: Buffer.alloc(32 * 1024 * 1024, 120) },',
    ')',
    'console.log(JSON.stringify({ exitCode: result.exitCode, stdout: result.stdout.length }))',
  ].join('\n')

  expect(await runChecked(node!, ['--input-type=module', '-e', probe], { timeoutMs: 10_000 })).toBe(
    '{"exitCode":0,"stdout":0}',
  )
})
