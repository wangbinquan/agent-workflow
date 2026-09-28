import { sha256Hex } from '@/util/hash'
import { createNativeUsageCapture } from '../application/nativeUsageCapture'
import type { NativeUsageCaptureIdentity } from '../application/ports/nativeUsageCapture'
import { readOpencodeUsageSnapshot } from '../infrastructure/opencodeUsageSnapshot'

export function createOpencodeNativeUsageCapture(
  input: NativeUsageCaptureIdentity & { readonly path: string | null },
) {
  return createNativeUsageCapture({
    ...input,
    nativeSource: sha256Hex(JSON.stringify(['opencode-native-db', input.path])),
    read: (root) => readOpencodeUsageSnapshot(input.path, root),
  })
}
