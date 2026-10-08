import type { NativeUsageCaptureIdentity } from '@/modules/runtime-management/public/participants'
import type {
  RuntimeObservationIdentity,
  RuntimeKind,
} from '@/modules/runtime-management/public/types'
import type { SystemNativeUsageOwnerBinding } from './nativeUsagePersistence'

export type { NativeUsageAdmission } from './nativeUsageAdmission'

/** Resolve the actual original Task context at the invocation call point. */
export interface NativeUsageInvocationPersistence {
  forInvocation(input: {
    readonly invocationId: string
    readonly taskId: string
    readonly nodeRunId: string
    readonly runtime?: RuntimeObservationIdentity & { readonly protocol: RuntimeKind }
  }): NonNullable<NativeUsageCaptureIdentity['durableOwner']> | undefined
  /** Independent original System operation, not a Task execution context. */
  forSystemInvocation?(input: {
    readonly binding: SystemNativeUsageOwnerBinding
    readonly runtime?: RuntimeObservationIdentity & { readonly protocol: RuntimeKind }
  }): NonNullable<NativeUsageCaptureIdentity['durableOwner']> | undefined
}
