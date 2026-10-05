import { stat } from 'node:fs/promises'
import { sha256Hex } from '@/util/hash'

/** Identity of the original SQLite file, stable across ordinary WAL writes. */
export async function opencodeNativeStoreGeneration(path: string): Promise<string | null> {
  try {
    const original = await stat(path, { bigint: true })
    if (!original.isFile()) return null
    return sha256Hex(
      JSON.stringify([
        'opencode-native-store-generation-v2',
        original.dev.toString(),
        original.ino.toString(),
        original.birthtimeNs.toString(),
      ]),
    )
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return null
    throw error
  }
}
