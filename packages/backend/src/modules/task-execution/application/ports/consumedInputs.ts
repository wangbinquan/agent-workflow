import type { ConsumedEdge } from './runSelection'

/** legacyJson 只透传现有写合同；不能解析再编码持久化的历史字节。 */
export type ConsumedInputsWrite =
  | { readonly edges: readonly ConsumedEdge[] }
  | { readonly record: Readonly<Record<string, string>> }
  | { readonly legacyJson: string | null }

export interface ConsumedInputsParticipantInTx<Tx> {
  record(tx: Tx, nodeRunId: string, input: ConsumedInputsWrite): Promise<void>
}
