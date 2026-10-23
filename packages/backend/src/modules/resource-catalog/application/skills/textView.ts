import { sha256Hex } from '@/util/hash'

/** II-a preserves the adapters' historical text views, including their BOM difference. */
export interface SkillTextViewPolicy {
  readonly textBom?: 'preserve' | 'strip'
}
export function skillTextView(bytes: Uint8Array, policy: SkillTextViewPolicy): string {
  return policy.textBom === 'strip'
    ? new TextDecoder().decode(bytes)
    : Buffer.from(bytes).toString('utf8')
}
export function skillTextBytes(text: string): Uint8Array {
  return Buffer.from(text, 'utf8')
}
export type SkillVersionTextEntry =
  | { readonly kind: 'text'; readonly content: string }
  | { readonly kind: 'binary'; readonly hash: string }
export function skillTreeTextView(
  tree: ReadonlyMap<string, Uint8Array>,
  policy: SkillTextViewPolicy,
): ReadonlyMap<string, SkillVersionTextEntry> {
  return new Map(
    [...tree].map(([path, bytes]) => [
      path,
      bytes.includes(0)
        ? { kind: 'binary' as const, hash: sha256Hex(bytes) }
        : { kind: 'text' as const, content: skillTextView(bytes, policy) },
    ]),
  )
}
