import { join } from 'node:path'
import type { AgentMaterialSeedFile } from '../application/ports/agentMaterialWorkspace'
import {
  bindNativeAgentMaterialWorkspace,
  releaseSystemAgentScratch,
} from '../infrastructure/local/agentMaterialWorkspace'
import { requireWorkPathWithoutSymlinks } from '@/platform/crewstation/workVolumePath'
import { assertWorkVolumeWritersSettled } from '@/platform/crewstation/workVolumeWriters'

export async function executeTaskImageSystemWorkspace(
  value: unknown,
  root: string,
): Promise<unknown> {
  const input = value as {
    method: string
    namespace: 'intent' | 'shared'
    key: string
    seeds?: readonly AgentMaterialSeedFile[]
  }
  if (!['intent', 'shared'].includes(input.namespace) || !/^[0-9a-f]{64}$/.test(input.key))
    throw new Error('hosted-system-workspace-owner-mismatch')
  const parent = requireWorkPathWithoutSymlinks(join(root, 'system', input.namespace), root)
  if (input.method === 'release') {
    assertWorkVolumeWritersSettled(root, join(parent, input.key))
    return releaseSystemAgentScratch({
      scratchDir: join(parent, input.key),
      expectedParent: parent,
      expectedName: input.key,
    })
  }
  if (input.method !== 'prepare') throw new Error('hosted-system-workspace-operation-unknown')
  const selected = bindNativeAgentMaterialWorkspace({
    kind: 'system',
    parent: () => parent,
    feature: () => 'system',
    scratchName: () => input.key,
  })
  await selected.workspace.prepare(input.seeds)
  return null
}
