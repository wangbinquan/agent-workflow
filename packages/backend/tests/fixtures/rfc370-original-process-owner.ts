import { bindLocalAgentExecutionEffect } from '../../src/modules/task-execution/infrastructure/local/agentExecutionEffect'

// Separate original daemon process. The real managed launcher owns the target
// tree and exposes its receipt before activation; the harness later crashes us.
const marker = process.argv[2]
if (!marker) throw new Error('original process marker missing')
const selected = bindLocalAgentExecutionEffect({
  materialRef: 'durable-fixture:material',
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
await selected.effect.submit({
  executionRef: selected.executionRef,
  materialRef: selected.materialRef,
  workspaceRef: selected.workspaceRef,
  onStarted: async (receipt) => {
    process.stdout.write(JSON.stringify(receipt) + '\n')
  },
})
