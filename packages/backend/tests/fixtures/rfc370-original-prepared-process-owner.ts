// Crash fixture: the native helper exists, but the consumer's started ACK
// never completes. No activation frame or target side effect is permitted.
import { bindLocalAgentExecutionEffect } from '../../src/modules/task-execution/infrastructure/local/agentExecutionEffect'

const marker = process.argv[2]
if (!marker) throw new Error('original prepared process marker missing')
const selected = bindLocalAgentExecutionEffect({
  materialRef: 'original-prepared:material',
  command: () => [
    process.execPath,
    '-e',
    `await Bun.write(${JSON.stringify(marker)}, 'issued'); setInterval(() => {}, 1000)`,
  ],
  workingDirectory: () => process.cwd(),
  environment: () =>
    Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
  stdin: () => undefined,
  requireSpawnReceipt: true,
})
process.stdout.write(
  JSON.stringify({
    executionRef: selected.executionRef,
    recoveryRef: selected.preparedRecoveryRef,
  }) + '\n',
)
await selected.effect.submit({
  executionRef: selected.executionRef,
  materialRef: selected.materialRef,
  workspaceRef: selected.workspaceRef,
  async onStarted(receipt) {
    process.stdout.write(JSON.stringify(receipt) + '\n')
    await new Promise<void>(() => {})
  },
})
