import type { NativeUsageCaptureIdentity } from '@/modules/runtime-management/public/participants'

/** Resolve the actual original Task context at the invocation call point. */
export interface NativeUsageInvocationPersistence {
  forInvocation(input: {
    readonly invocationId: string
    readonly taskId: string
    readonly nodeRunId: string
  }): NonNullable<NativeUsageCaptureIdentity['durableOwner']> | undefined
}
