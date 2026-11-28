// RFC-626 §4.1: a database's content identity is computed once; after that, cheap evidence
// says whether it still holds. A reader keeps the two together in a `SourceWatch` baseline:
// the identity, and the evidence it was confirmed at. Equal evidence adopts the identity
// without reading the data again; any other evidence measures it once more and remembers the
// result, so the check only ever changes how long it takes, never what it concludes.
import type { SourceBaseline, SourceWatch } from './freeze/sourceWatch'

/** The content identity a baseline vouches for at `evidence`, or null. */
export function baselineContent(
  baseline: SourceBaseline | undefined,
  evidence: string,
): string | null {
  const identity = baseline?.identity
  return baseline?.evidence === evidence &&
    typeof identity === 'object' &&
    identity !== null &&
    !Array.isArray(identity) &&
    typeof (identity as { readonly content?: unknown }).content === 'string'
    ? (identity as { readonly content: string }).content
    : null
}

/**
 * The content identity of the source as `evidence` describes it: the remembered one when the
 * evidence has not moved since it was confirmed, otherwise `measure()` (remembered for the next
 * reader of the same key).
 */
export async function settleContentIdentity(input: {
  readonly watch: Pick<SourceWatch, 'baseline' | 'remember'>
  readonly key: string
  readonly evidence: string
  readonly measure: () => Promise<string>
}): Promise<{ readonly content: string; readonly measured: boolean }> {
  const known = baselineContent(input.watch.baseline(input.key), input.evidence)
  if (known !== null) return { content: known, measured: false }
  const content = await input.measure()
  input.watch.remember(input.key, { identity: { content }, evidence: input.evidence })
  return { content, measured: true }
}
