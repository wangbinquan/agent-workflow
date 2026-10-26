import { decodePrompt } from '@/platform/content/locations/prompt'
import { encodeContentRefColumns } from '@/platform/content/contentRefCodec'
import { artifactReceipt } from '@/platform/persistence/migration/conversion/content'
import type { RuleContext } from '@/platform/persistence/migration/conversion/rule'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import type { RunDecision } from './checkpoints'
import { nullableText, text } from './source'

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
  const stat = ref.kind === 'inline' ? undefined : await ctx.content.stat(ref.location)
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
