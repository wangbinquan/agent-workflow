// RFC-395 activation: this context declares the live epoch-2 schema directly.
import { column as c, defineContribution, retention, raw } from '@/platform/persistence/schema/dsl'
import { materializeDrizzle } from '@/platform/persistence/schema/drizzle'

const owner = defineContribution('runtime-management')

const runtimesDefinition = owner.table({
  id: 'runtimes',
  schemaSymbol: 'runtimes',
  columns: {
    id: c.id('id', { primary: true }),
    name: c.text('name', { unique: 'runtimes_name_unique' }),
    protocol: c.enum('protocol', ['opencode', 'claude-code']),
    binaryPath: c.text('binary_path', { nullable: true }),
    enabled: c.bool('enabled', { default: true }),
    model: c.text('model', { nullable: true }),
    variant: c.text('variant', { nullable: true }),
    temperature: c.real('temperature', { nullable: true }),
    steps: c.int('steps', { nullable: true }),
    maxSteps: c.int('max_steps', { nullable: true }),
    isSandbox: c.bool('is_sandbox', { default: false }),
    configDirEnv: c.text('config_dir_env', { nullable: true }),
    configDirName: c.text('config_dir_name', { nullable: true }),
    extraArgsJson: c.jsonText('extra_args_json', { nullable: true }),
    lastProbeJson: c.jsonText('last_probe_json', { nullable: true }),
    probeFence: c.int('probe_fence', { default: 0 }),
    createdBy: c.text('created_by', { nullable: true }),
    createdAt: c.epochMs('created_at', {
      default: raw(
        '(unixepoch() * 1000)',
        '(extract(epoch from clock_timestamp()) * 1000)::bigint',
      ),
    }),
    updatedAt: c.epochMs('updated_at', {
      default: raw(
        '(unixepoch() * 1000)',
        '(extract(epoch from clock_timestamp()) * 1000)::bigint',
      ),
    }),
  },
  retention: retention.business,
})

export const runtimes = materializeDrizzle(runtimesDefinition).table

export const schemaContribution = {
  owner: 'runtime-management',
  version: 1,
  tables: [runtimesDefinition],
} as const
