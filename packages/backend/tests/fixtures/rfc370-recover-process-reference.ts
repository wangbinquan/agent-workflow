import { createLocalAgentExecutionRecoveryReferences } from '../../src/modules/task-execution/infrastructure/local/agentExecutionRecoveryReference'

const value: unknown = JSON.parse(process.argv[2] ?? 'null')
if (
  value === null ||
  typeof value !== 'object' ||
  !('executionRef' in value) ||
  !('recoveryRef' in value) ||
  typeof value.executionRef !== 'string' ||
  typeof value.recoveryRef !== 'string'
)
  throw new Error('original recovery fixture receipt missing')
const result = await createLocalAgentExecutionRecoveryReferences().recoverReference({
  executionRef: value.executionRef,
  recoveryRef: value.recoveryRef,
})
process.stdout.write(JSON.stringify(result) + '\n')
