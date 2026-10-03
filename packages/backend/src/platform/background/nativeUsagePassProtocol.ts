import type {
  NativeUsagePassIdentity,
  NativeUsagePassPage,
} from '@/modules/runtime-management/public/participants'

export interface NativeUsagePassWorkerStart {
  readonly path: string
  readonly identity: NativeUsagePassIdentity
  readonly pageRows?: number
  readonly pageBytes?: number
}
export type NativeUsagePassRequest =
  | { readonly kind: 'open'; readonly input: NativeUsagePassWorkerStart }
  | { readonly kind: 'next'; readonly cursor: string }
  | { readonly kind: 'ack'; readonly ordinal: string; readonly digest: string }
  | { readonly kind: 'close' }
export interface NativeUsagePassWorkerInput {
  readonly id: string
  readonly request: NativeUsagePassRequest
}
export type NativeUsagePassWorkerResult =
  | {
      readonly kind: 'opened'
      readonly initialCursor: string
      readonly identity: NativeUsagePassIdentity
    }
  | { readonly kind: 'page'; readonly page: NativeUsagePassPage }
  | { readonly kind: 'acknowledged' }
  | { readonly kind: 'closed' }
export type NativeUsagePassWorkerEvent =
  | { readonly id: string; readonly ok: true; readonly result: NativeUsagePassWorkerResult }
  | { readonly id: string; readonly ok: false; readonly error: string }
