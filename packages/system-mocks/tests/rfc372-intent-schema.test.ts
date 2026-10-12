// RFC-372 schema v7 must not invalidate intent authoring browser fixtures or
// rewrite the frozen RFC-254 output. Exercise the actual runtime dispatcher.
import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

const dispatcher = resolve(import.meta.dir, '../src/runtime/dispatch.ts')

async function changeset(layout: string | undefined, version?: string) {
  const env = {
    ...process.env,
    AW_STUB_MODE: 'intent',
    STUB_INTENT_VARIANT: 'workflow',
    STUB_INTENT_LAYOUT_FIXTURE: layout,
    STUB_INTENT_WORKFLOW_SCHEMA_VERSION: version,
  }
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      dispatcher,
      'run',
      '--format',
      'json',
      '--',
      '<workflow-output nonce="schema-fixture">',
    ],
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(errors).toBe('')
  expect(code).toBe(0)
  const event = JSON.parse(output.trim())
  const envelope = event.part.text as string
  const content = envelope.match(/<port name="changeset">([\s\S]*?)<\/port>/)?.[1]
  expect(content).toBeDefined()
  return JSON.parse(content!)
}

for (const layout of [undefined, 'overlap', 'nested-cycle']) {
  test(`intent ${layout ?? 'recorded'} opts into current workflow format without changing its graph`, async () => {
    const recorded = await changeset(layout)
    const current = await changeset(layout, '7')
    const workflow = recorded.ops.find(
      (op: { resourceType: string }) => op.resourceType === 'workflow',
    )
    expect(workflow.payload.definition.$schema_version).toBe(6)
    workflow.payload.definition.$schema_version = 7
    expect(current).toEqual(recorded)
    expect(current.$schema_version).toBe(1)
  })
}
