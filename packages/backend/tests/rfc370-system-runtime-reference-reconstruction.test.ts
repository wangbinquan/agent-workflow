// RFC-370: an original protocol continuation uses its captured binary binding
// after owner reconstruction, without consulting a changed runtime profile.
import { expect, test } from 'bun:test'
import type { AgentMaterialContentReference } from '../src/modules/runtime-management/application/ports/agentMaterial'
import { createLocalSystemAgentRuntimeBindings } from '../src/modules/runtime-management/infrastructure/local/systemAgentRuntimeBindings'

test('a serialized native runtime binding preserves the exact original binary after reconstruction', () => {
  let reads = 0,
    binaryPath = 'original path with spaces/opencode'
  const profile = {
    protocol: 'opencode',
    get binaryPath() {
      reads += 1
      return binaryPath
    },
  }
  const first = createLocalSystemAgentRuntimeBindings()
  const selected = first.bindRuntime(profile)
  expect(reads).toBe(0)
  const original = JSON.parse(
    JSON.stringify(selected.runtimeBinding),
  ) as AgentMaterialContentReference
  expect(reads).toBe(1)
  binaryPath = 'replacement runtime'
  const rebuilt = createLocalSystemAgentRuntimeBindings()
  expect(rebuilt.contents.runtimeBinary(original)).toBe('original path with spaces/opencode')
  expect(reads).toBe(1)
})

test('an unavailable runtime reference cannot silently choose a replacement or default', () => {
  const owner = createLocalSystemAgentRuntimeBindings()
  const original = owner.bindRuntime({ binaryPath: 'original' }).runtimeBinding!
  for (const reference of [
    { ...original, reference: 'legacy unavailable reference' },
    { ...original, version: 99 },
    { ...original, reference: 'aw-system-runtime-v1:broken' },
  ])
    expect(() => createLocalSystemAgentRuntimeBindings().contents.runtimeBinary(reference)).toThrow(
      'system-runtime-binding-unavailable',
    )
})
