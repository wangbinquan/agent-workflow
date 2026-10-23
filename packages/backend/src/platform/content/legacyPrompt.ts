import { join } from 'node:path'
import { sha256Hex } from '@/util/hash'
import { legacyContentRef, type ContentRef } from './contentRef'

export interface LegacyPromptStorage {
  readonly promptText: string | null
  readonly promptPath: string | null
}

export function decodeLegacyPrompt(
  value: LegacyPromptStorage,
): ContentRef<LegacyPromptStorage> | null {
  if (value.promptText !== null) {
    const text = value.promptText
    let bytes: Buffer | undefined
    let digest: string | undefined
    const materialize = () => (bytes ??= Buffer.from(text, 'utf8'))
    return {
      ...legacyContentRef('prompt', 'local-file', value),
      kind: 'inline',
      get bytes() {
        return materialize()
      },
      get sha256() {
        return (digest ??= sha256Hex(materialize()))
      },
      get size() {
        return materialize().byteLength
      },
      mediaType: 'text/markdown',
    }
  }
  return value.promptPath === null
    ? null
    : legacyContentRef('prompt', 'local-file', value, { mediaType: 'text/markdown' })
}

export function encodeLegacyPrompt(
  ref: ContentRef<LegacyPromptStorage> | null,
): LegacyPromptStorage {
  return ref?.location.value ?? { promptText: null, promptPath: null }
}

export function legacyPromptNeedsFile(prompt: string): boolean {
  return Buffer.byteLength(prompt, 'utf-8') >= 4_096
}

export function legacyPromptPath(taskId: string, nodeRunId: string): string {
  return join(taskId, 'prompts', `${nodeRunId}.md`)
}

/** Hosted execution has always kept even large prompts inline. */
export function legacyHostedPrompt(prompt: string): LegacyPromptStorage {
  return encodeLegacyPrompt(decodeLegacyPrompt({ promptText: prompt, promptPath: null }))
}
export function readLegacyHostedPrompt(row: LegacyPromptStorage | null | undefined): string | null {
  return row?.promptText ?? null
}
