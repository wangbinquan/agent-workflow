import { sha256Hex } from '@/util/hash'
import { createNativeUsageCapture } from '../application/nativeUsageCapture'
import type { NativeUsageCaptureIdentity } from '../application/ports/nativeUsageCapture'
import { readOpencodeUsageSnapshot } from '../infrastructure/opencodeUsageSnapshot'
import { createNativePageCapture } from '../application/nativePageCapture'
import { opencodeNativeStoreGeneration } from '../infrastructure/opencodeNativeStoreGeneration'
import { openNativeUsagePassWorker } from '@/platform/background/nativeUsagePassWorkerHost'
import { ulid } from 'ulid'

export function createOpencodeNativeUsageCapture(
  input: NativeUsageCaptureIdentity & { readonly path: string | null },
) {
  const nativeSource = sha256Hex(JSON.stringify(['opencode-native-db', input.path]))
  if (input.durableOwner && input.path !== null) {
    const path = input.path
    return createNativePageCapture({
      ...input,
      durableOwner: input.durableOwner,
      nativeSource,
      generation: () => opencodeNativeStoreGeneration(path),
      open: (identity) =>
        openNativeUsagePassWorker({ path, identity }, new AbortController().signal),
      passId: () => 'native-pass:' + ulid(),
      now: Date.now,
    })
  }
  return createNativeUsageCapture({
    ...input,
    nativeSource,
    read: (root) => readOpencodeUsageSnapshot(input.path, root),
  })
}
