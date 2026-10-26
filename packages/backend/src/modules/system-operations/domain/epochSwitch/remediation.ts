import type { ConversionBlock } from '@/platform/persistence/migration/conversion/types'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import { executionClass } from '@/platform/persistence/migration/conversion/lookups/keys'
import { ExecutableTaskBlockDetailSchema, type MigrationPlanBlock } from './documents'

export function executableTaskForBlock(block: ConversionBlock): {
  taskId: string
  status: string
} | null {
  const parsed = ExecutableTaskBlockDetailSchema.safeParse(block.detail)
  if (!parsed.success || parsed.data.executableTask.taskId !== block.taskId) return null
  const task = parsed.data.executableTask
  try {
    return executionClass(task.status) === 'executable' ? task : null
  } catch {
    return null
  }
}

export function describeEpochBlock(block: ConversionBlock): MigrationPlanBlock {
  const id = valueDigest(block)
  const task = executableTaskForBlock(block)
  if (task)
    return {
      id,
      block,
      remediation: {
        action: 'repair-source',
        message: `Task ${task.taskId} is still ${task.status}; finish or cancel it in the current version, then re-plan. Its affected runs are then kept as history-only.`,
      },
    }
  if (block.code === 'v2-code-history-unfinished' && block.acknowledgeable)
    return {
      id,
      block,
      remediation: {
        action: 'acknowledge',
        message:
          'Review this retired code-work item and acknowledge its full archival with an operator and reason.',
      },
    }
  if (block.code.includes('operator-decision'))
    return {
      id,
      block,
      remediation: {
        action: 'new-run',
        message:
          'Review the remaining package blocks and current rows. Before running, use withdraw-acknowledgement --decision DIGEST or --all to remove obsolete decisions, then acknowledge the current items.',
      },
    }
  if (block.code.includes('content') || block.code.includes('scratch'))
    return {
      id,
      block,
      remediation: {
        action: 'supply-input',
        message:
          'Supply the required content root or empty scratch database, then create a new run.',
      },
    }
  if (block.code.includes('target') || block.code.includes('catalog'))
    return {
      id,
      block,
      remediation: {
        action: 'repair-target',
        message:
          'Provide a compatible empty target database and its catalog artifact, then re-plan.',
      },
    }
  if (block.code.includes('unsupported'))
    return {
      id,
      block,
      remediation: {
        action: 'unsupported',
        message:
          'This source or conversion path requires an explicitly supported converter version.',
      },
    }
  return {
    id,
    block,
    remediation: {
      action: 'repair-source',
      message:
        'Resolve the listed source facts using their owning application, then start a new run and approve the new plan.',
    },
  }
}
