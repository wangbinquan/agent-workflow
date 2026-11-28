import { decodePrompt } from '@/platform/content/locations/prompt'
import { encodeContentRefColumns } from '@/platform/content/contentRefCodec'
import {
  artifactReceipt,
  type ContentStat,
} from '@/platform/persistence/migration/conversion/content'
import { ConversionContractError } from '@/platform/persistence/migration/conversion/blockCodes'
import type { RuleContext } from '@/platform/persistence/migration/conversion/rule'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import type { RunDecision } from './checkpoints'
import { nullableText, text } from './source'

/**
 * RFC-626: the frozen inventory refuses to vouch for a prompt file that is on disk but not in
 * the freeze listing (`content-unlisted-present`), and reading a file can fail with a system
 * error. Either aborts the whole conversion with operator resolution, as it always did. Neither
 * is a fact about the run, so with automatic resolution the prompt is recorded as missing,
 * exactly like a prompt file that is not there. A listed file is the only kind that reaches a
 * system error, hence `missing-at-freeze` for those.
 */
export function unreadablePromptStat(error: unknown): ContentStat {
  const message = error instanceof Error ? error.message : String(error)
  return message === 'content-unlisted-present'
    ? {
        state: 'absent',
        cause: 'originally-absent',
        evidence: 'content-unlisted-present: prompt file is absent from the freeze listing',
      }
    : {
        state: 'absent',
        cause: 'missing-at-freeze',
        evidence: `prompt file unreadable: ${message}`,
      }
}

export async function convertPrompt(
  row: SourceRow,
  ctx: RuleContext,
): Promise<{
  readonly json: string | null
  readonly inlineBytes: Uint8Array | null
  readonly decisions: readonly RunDecision[]
}> {
  const storage = {
    promptText: nullableText(row, 'prompt_text'),
    promptPath: nullableText(row, 'prompt_path'),
  }
  const ref = decodePrompt(storage)
  if (ref === null) return { json: null, inlineBytes: null, decisions: [] }
  let stat: ContentStat | undefined
  if (ref.kind !== 'inline')
    try {
      stat = await ctx.content.stat(ref.location)
    } catch (error) {
      // An engine contract error is a fault of the conversion, never a property of the file.
      // Operator resolution keeps the behavior it had before RFC-626: the conversion stops.
      if (error instanceof ConversionContractError || ctx.resolution !== 'automatic') throw error
      stat = unreadablePromptStat(error)
    }
  ctx.out.artifact(
    artifactReceipt({
      source: row,
      column: storage.promptText !== null ? 'prompt_text' : 'prompt_path',
      originalReference: storage.promptPath,
      target: {
        table: 'node_run_configs',
        key: encodeMigrationKey('node_run_configs', [canonicalValue(text(row, 'id'))]),
      },
      ref,
      ...(stat ? { stat } : {}),
    }),
  )
  return {
    ...encodeContentRefColumns(ref),
    decisions:
      stat?.state === 'absent'
        ? [
            {
              code: 'v2-run-prompt-missing',
              missingFields: ['prompt_path'],
              detail: { ...stat, path: storage.promptPath },
              unprovable: false,
            },
          ]
        : [],
  }
}
