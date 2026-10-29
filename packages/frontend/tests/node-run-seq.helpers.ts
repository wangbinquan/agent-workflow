// RFC-395 D4: NodeRun mint order is `seq` alone — equal seq no longer falls back to comparing IDs.
// Fixtures written while IDs broke ties keep their intent by deriving the default seq from the ID:
// a base-65 reading of its first 8 characters (an end-of-string pads below every character), so
// lexical ID order and seq order agree for the short handwritten IDs these tests use.
const ALPHABET = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz'

export function seqFromId(id: string): number {
  let seq = 0
  for (let index = 0; index < 8; index++) {
    const digit = index < id.length ? ALPHABET.indexOf(id[index]!) + 1 : 0
    if (digit === 0 && index < id.length)
      throw new Error(`seqFromId: unsupported character in ${id}`)
    seq = seq * 65 + digit
  }
  return seq
}
