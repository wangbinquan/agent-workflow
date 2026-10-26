import { join } from 'node:path'
import { sha256Hex } from '@/util/hash'
import { legacyContentRef, type ContentRef } from '../contentRef'

export interface PromptStorage {
  readonly promptText: string | null
  readonly promptPath: string | null
}

export function decodePrompt(value: PromptStorage): ContentRef<PromptStorage> | null {
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

export function encodePrompt(ref: ContentRef<PromptStorage> | null): PromptStorage {
  return ref?.location.value ?? { promptText: null, promptPath: null }
}

export function promptNeedsFile(prompt: string): boolean {
  return Buffer.byteLength(prompt, 'utf-8') >= 4_096
}

export function promptPath(taskId: string, nodeRunId: string): string {
  return join(taskId, 'prompts', `${nodeRunId}.md`)
}

/** Hosted execution has always kept even large prompts inline. */
export function hostedPrompt(prompt: string): PromptStorage {
  return encodePrompt(decodePrompt({ promptText: prompt, promptPath: null }))
}
export function readHostedPrompt(row: PromptStorage | null | undefined): string | null {
  return row?.promptText ?? null
}
