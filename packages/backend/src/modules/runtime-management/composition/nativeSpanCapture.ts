import { sha256Hex } from '@/util/hash'
import { createNativeSpanCapture } from '../application/nativeSpanCapture'
import type { NativeSpanCaptureIdentity } from '../application/ports/nativeSpanCapture'
import { readOpencodeSpanSnapshot } from '../infrastructure/opencodeSpanSnapshot'

export function createOpencodeNativeSpanCapture(
  input: NativeSpanCaptureIdentity & { readonly path: string | null },
) {
  return createNativeSpanCapture({
    ...input,
    sourceNamespace: sha256Hex(JSON.stringify(['opencode-native-db', input.path])),
    requireNativeCreationTime: true,
    read: (root) => readOpencodeSpanSnapshot(input.path, root),
  })
}
export function createRuntimeStreamSpanCapture(
  input: NativeSpanCaptureIdentity & { readonly sourceNamespace: string },
) {
  return createNativeSpanCapture({ ...input, streamOnly: true })
}
