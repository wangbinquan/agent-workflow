export interface ContractLocalizedText {
  'zh-CN': string
  'en-US': string
}

export interface ExecutionContractField {
  path: string
  label: ContractLocalizedText
  description: ContractLocalizedText
  valueType: 'string' | 'number' | 'boolean' | 'enum' | 'object' | 'array' | 'json'
  required: boolean
  source: 'platform' | 'work-input' | 'event' | 'context' | 'artifact'
  condition: ContractLocalizedText | null
  example: string | null
}

export interface ExecutionContractGuide {
  schemaVersion: 1
  inputMode?: 'host-envelope' | 'direct-json'
  outputMode: 'envelope' | 'direct-json' | 'artifact-path'
  contractRef: { contractId: string; version: number }
  displayName: ContractLocalizedText
  description: ContractLocalizedText
  input: {
    schemaId: string
    displayName: ContractLocalizedText
    description: ContractLocalizedText
    topLevelFields: string[]
    primaryFieldPaths: string[]
    fields: ExecutionContractField[]
    exampleJson: string
  }
  output: {
    schemaId: string
    displayName: ContractLocalizedText
    description: ContractLocalizedText
    topLevelFields: string[]
    primaryFieldPaths: string[]
    fields: ExecutionContractField[]
    exampleJson: string
  }
  allowedExecutorKinds: Array<'agent' | 'workflow' | 'program'>
  transports: Record<
    'agent' | 'workflow' | 'program',
    {
      inputLocation: string
      outputLocation: string
      outputPort?: string
      outputKind?: string
      inputInstruction: ContractLocalizedText
      outputInstruction: ContractLocalizedText
    } | null
  >
}

export interface ExecutionContractSummary {
  schemaVersion: 1
  inputMode?: 'host-envelope' | 'direct-json'
  outputMode: 'envelope' | 'direct-json' | 'artifact-path'
  contractRef: { contractId: string; version: number }
  displayName: ContractLocalizedText
  description: ContractLocalizedText
  inputSchemaId: string
  outputSchemaId: string
  outputTopLevelFields: string[]
  allowedExecutorKinds: Array<'agent' | 'workflow' | 'program'>
  agentOutputPort: string | null
  agentOutputKind: string | null
}

export interface ExecutionContractValidationReceipt {
  schemaVersion: 1
  contractRef: { contractId: string; version: number }
  status: 'valid' | 'invalid'
  checks: Array<{ code: string; ok: boolean; detail: string }>
}

export interface ExecutionContractAgentCandidateReceipt {
  agentRef: { id: string; revision: number }
  validationReceipt: ExecutionContractValidationReceipt
}

export function contractRefKey(ref: { contractId: string; version: number }): string {
  return `${ref.contractId}@${ref.version}`
}

export function contractText(value: ContractLocalizedText, language: string): string {
  return language.startsWith('zh') ? value['zh-CN'] : value['en-US']
}
