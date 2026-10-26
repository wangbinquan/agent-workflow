// RFC-395 activation: this context declares the live epoch-2 schema directly.
import {
  column as c,
  defineContribution,
  retention,
  raw,
  foreignKey,
  index,
} from '@/platform/persistence/schema/dsl'
import { materializeDrizzle } from '@/platform/persistence/schema/drizzle'

const owner = defineContribution('resource-catalog')

const mcpProbesDefinition = owner.table({
  id: 'mcp_probes',
  schemaSymbol: 'mcpProbes',
  columns: {
    id: c.id('id', { primary: true }),
    mcpId: c.id('mcp_id', { unique: 'mcp_probes_mcp_id_unique' }),
    status: c.enum('status', ['ok', 'error']),
    latencyMs: c.int('latency_ms'),
    handshakeMs: c.int('handshake_ms', { nullable: true }),
    serverInfoJson: c.jsonText('server_info_json', { nullable: true }),
    protocolVersion: c.text('protocol_version', { nullable: true }),
    capabilitiesJson: c.jsonText('capabilities_json', { nullable: true }),
    toolsJson: c.jsonText('tools_json', { nullable: true }),
    resourcesJson: c.jsonText('resources_json', { nullable: true }),
    resourceTemplatesJson: c.jsonText('resource_templates_json', { nullable: true }),
    promptsJson: c.jsonText('prompts_json', { nullable: true }),
    errorCode: c.text('error_code', { nullable: true }),
    errorMessage: c.text('error_message', { nullable: true }),
    errorDetailJson: c.jsonText('error_detail_json', { nullable: true }),
    schemaVersion: c.int('schema_version', { default: 1 }),
    startedAt: c.epochMs('started_at'),
    finishedAt: c.epochMs('finished_at'),
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
  foreignKeys: [
    foreignKey('mcp_probes_mcp_id_mcps_id_fk', ['mcp_id'], 'mcps', ['id'], { onDelete: 'cascade' }),
  ],
  retention: retention.business,
})

export const mcpProbes = materializeDrizzle(mcpProbesDefinition).table

const mcpRuntimeTestCreateReceiptsDefinition = owner.table({
  id: 'mcp_runtime_test_create_receipts',
  schemaSymbol: 'mcpRuntimeTestCreateReceipts',
  columns: {
    mcpId: c.id('mcp_id'),
    ownerUserId: c.id('owner_user_id'),
    clientCreateId: c.id('client_create_id'),
    requestDigest: c.id('request_digest'),
    sessionId: c.id('session_id'),
    acceptedTurnId: c.id('accepted_turn_id'),
    createdAt: c.epochMs('created_at'),
    expiresAt: c.epochMs('expires_at'),
  },
  primaryKey: ['mcp_id', 'owner_user_id', 'client_create_id'],
  foreignKeys: [
    foreignKey('mcp_runtime_test_create_receipts_mcp_id_mcps_id_fk', ['mcp_id'], 'mcps', ['id'], {
      onDelete: 'restrict',
    }),
    foreignKey(
      'mcp_runtime_test_create_receipts_owner_user_id_users_id_fk',
      ['owner_user_id'],
      'users',
      ['id'],
      { onDelete: 'restrict' },
    ),
  ],
  checks: [
    {
      name: 'mcp_runtime_test_create_receipts_shape',
      expression: raw(
        'length("mcp_runtime_test_create_receipts"."request_digest") = 64\n        AND "mcp_runtime_test_create_receipts"."request_digest" NOT GLOB \'*[^0-9a-f]*\'\n        AND "mcp_runtime_test_create_receipts"."created_at" >= 0\n        AND "mcp_runtime_test_create_receipts"."expires_at" > "mcp_runtime_test_create_receipts"."created_at"',
        'length("request_digest") = 64 AND "request_digest" !~ \'[^0-9a-f]\' AND "created_at" >= 0 AND "expires_at" > "created_at"',
      ),
    },
  ],
  indexes: [index('idx_mcp_runtime_test_create_receipts_expiry', ['expires_at'])],
  retention: retention.business,
})

export const mcpRuntimeTestCreateReceipts = materializeDrizzle(
  mcpRuntimeTestCreateReceiptsDefinition,
).table

const mcpRuntimeTestEventsDefinition = owner.table({
  id: 'mcp_runtime_test_events',
  schemaSymbol: 'mcpRuntimeTestEvents',
  columns: {
    id: c.identity('id', { primary: true }),
    testSessionId: c.id('test_session_id'),
    firstSeenTurnId: c.id('first_seen_turn_id'),
    eventSeq: c.int('event_seq'),
    ts: c.int('ts'),
    kind: c.text('kind'),
    payload: c.text('payload'),
    sessionId: c.id('session_id', { nullable: true }),
    parentSessionId: c.id('parent_session_id', { nullable: true }),
    source: c.enum('source', ['stream', 'live-child', 'post-run-child']),
    externalEventKey: c.id('external_event_key', { nullable: true }),
  },
  foreignKeys: [
    foreignKey(
      'mcp_runtime_test_events_test_session_id_mcp_runtime_test_sessions_id_fk',
      ['test_session_id'],
      'mcp_runtime_test_sessions',
      ['id'],
      { onDelete: 'cascade' },
    ),
  ],
  checks: [
    {
      name: 'mcp_runtime_test_events_shape',
      expression: raw(
        '"mcp_runtime_test_events"."event_seq" > 0\n        AND "mcp_runtime_test_events"."ts" >= 0\n        AND "mcp_runtime_test_events"."source" IN (\'stream\', \'live-child\', \'post-run-child\')\n        AND (\n          "mcp_runtime_test_events"."external_event_key" IS NULL\n          OR (\n            length("mcp_runtime_test_events"."external_event_key") = 64\n            AND "mcp_runtime_test_events"."external_event_key" NOT GLOB \'*[^0-9a-f]*\'\n          )\n        )',
        '"event_seq" > 0 AND "ts" >= 0 AND "source" IN (\'stream\', \'live-child\', \'post-run-child\') AND ( "external_event_key" IS NULL OR ( length("external_event_key") = 64 AND "external_event_key" !~ \'[^0-9a-f]\' ) )',
      ),
    },
  ],
  indexes: [
    index('uniq_mcp_runtime_test_events_session_seq', ['test_session_id', 'event_seq'], {
      unique: true,
    }),
    index('uniq_mcp_runtime_test_events_external', ['test_session_id', 'external_event_key'], {
      unique: true,
      where: raw(
        '"mcp_runtime_test_events"."external_event_key" IS NOT NULL',
        '"external_event_key" IS NOT NULL',
      ),
    }),
    index('idx_mcp_runtime_test_events_session', ['test_session_id', 'event_seq']),
  ],
  retention: retention.operational,
})

export const mcpRuntimeTestEvents = materializeDrizzle(mcpRuntimeTestEventsDefinition).table

const mcpRuntimeTestSessionLeasesDefinition = owner.table({
  id: 'mcp_runtime_test_session_leases',
  schemaSymbol: 'mcpRuntimeTestSessionLeases',
  columns: {
    protocol: c.enum('protocol', ['opencode', 'claude-code']),
    runtimeSessionId: c.id('runtime_session_id'),
    testSessionId: c.id('test_session_id'),
    createdTurnId: c.id('created_turn_id'),
    currentTurnId: c.id('current_turn_id'),
    leaseTurnId: c.id('lease_turn_id', { nullable: true }),
    leaseAcquiredAt: c.epochMs('lease_acquired_at', { nullable: true }),
    leaseNonceDigest: c.id('lease_nonce_digest', { nullable: true }),
  },
  primaryKey: ['protocol', 'runtime_session_id'],
  foreignKeys: [
    foreignKey(
      'mcp_runtime_test_session_leases_test_session_id_mcp_runtime_test_sessions_id_fk',
      ['test_session_id'],
      'mcp_runtime_test_sessions',
      ['id'],
      { onDelete: 'cascade' },
    ),
    foreignKey(
      'mcp_runtime_test_session_leases_created_turn_id_mcp_runtime_test_turns_id_fk',
      ['created_turn_id'],
      'mcp_runtime_test_turns',
      ['id'],
      { onDelete: 'restrict' },
    ),
    foreignKey(
      'mcp_runtime_test_session_leases_current_turn_id_mcp_runtime_test_turns_id_fk',
      ['current_turn_id'],
      'mcp_runtime_test_turns',
      ['id'],
      { onDelete: 'restrict' },
    ),
    foreignKey(
      'mcp_runtime_test_session_leases_lease_turn_id_mcp_runtime_test_turns_id_fk',
      ['lease_turn_id'],
      'mcp_runtime_test_turns',
      ['id'],
      { onDelete: 'restrict' },
    ),
  ],
  checks: [
    {
      name: 'mcp_runtime_test_session_leases_all_or_none',
      expression: raw(
        '(\n        (\n          "mcp_runtime_test_session_leases"."lease_turn_id" IS NULL\n          AND "mcp_runtime_test_session_leases"."lease_acquired_at" IS NULL\n          AND "mcp_runtime_test_session_leases"."lease_nonce_digest" IS NULL\n        )\n        OR\n        (\n          "mcp_runtime_test_session_leases"."lease_turn_id" IS NOT NULL\n          AND "mcp_runtime_test_session_leases"."lease_acquired_at" IS NOT NULL\n          AND "mcp_runtime_test_session_leases"."lease_nonce_digest" IS NOT NULL\n        )\n      )',
        '( ( "lease_turn_id" IS NULL AND "lease_acquired_at" IS NULL AND "lease_nonce_digest" IS NULL ) OR ( "lease_turn_id" IS NOT NULL AND "lease_acquired_at" IS NOT NULL AND "lease_nonce_digest" IS NOT NULL ) )',
      ),
    },
    {
      name: 'mcp_runtime_test_session_leases_shape',
      expression: raw(
        '"mcp_runtime_test_session_leases"."protocol" IN (\'opencode\', \'claude-code\')\n        AND (\n          "mcp_runtime_test_session_leases"."lease_nonce_digest" IS NULL\n          OR (\n            length("mcp_runtime_test_session_leases"."lease_nonce_digest") = 64\n            AND "mcp_runtime_test_session_leases"."lease_nonce_digest" NOT GLOB \'*[^0-9a-f]*\'\n          )\n        )',
        '"protocol" IN (\'opencode\', \'claude-code\') AND ( "lease_nonce_digest" IS NULL OR ( length("lease_nonce_digest") = 64 AND "lease_nonce_digest" !~ \'[^0-9a-f]\' ) )',
      ),
    },
  ],
  indexes: [
    index('uniq_mcp_runtime_test_session_leases_test_session', ['test_session_id'], {
      unique: true,
    }),
  ],
  retention: retention.operational,
})

export const mcpRuntimeTestSessionLeases = materializeDrizzle(
  mcpRuntimeTestSessionLeasesDefinition,
).table

const mcpRuntimeTestSessionsDefinition = owner.table({
  id: 'mcp_runtime_test_sessions',
  schemaSymbol: 'mcpRuntimeTestSessions',
  columns: {
    id: c.id('id', { primary: true }),
    mcpId: c.id('mcp_id'),
    ownerUserId: c.id('owner_user_id'),
    clientCreateId: c.id('client_create_id'),
    clientCreateDigest: c.id('client_create_digest'),
    status: c.enum('status', ['active', 'ending', 'ended']),
    endReason: c.enum(
      'end_reason',
      [
        'user',
        'idle-timeout',
        'mcp-deleted',
        'mcp-disabled',
        'mcp-config-changed',
        'access-revoked',
        'runtime-disabled',
        'runtime-deleted',
        'runtime-profile-changed',
        'runtime-session-reset',
        'capture-truncated',
        'capture-incomplete',
        'session-unusable',
      ],
      { nullable: true },
    ),
    mcpConfigHash: c.text('mcp_config_hash'),
    runtimeRowId: c.id('runtime_row_id'),
    runtimeName: c.text('runtime_name'),
    runtimeProtocol: c.enum('runtime_protocol', ['opencode', 'claude-code']),
    runtimeSnapshotJson: c.jsonText('runtime_snapshot_json'),
    runtimeBinaryPath: c.text('runtime_binary_path'),
    runtimeSessionId: c.id('runtime_session_id', { nullable: true }),
    nativeSessionState: c.enum('native_session_state', ['pending', 'ready', 'unusable'], {
      default: 'pending',
    }),
    inFlightTurnId: c.id('in_flight_turn_id', { nullable: true }),
    turnSeq: c.int('turn_seq', { default: 0 }),
    sessionVersion: c.int('session_version', { default: 0 }),
    idleDeadlineAt: c.epochMs('idle_deadline_at', { nullable: true }),
    continuationBlockedReason: c.enum(
      'continuation_blocked_reason',
      ['mcp-config-changed', 'runtime-profile-changed', 'capture-truncated', 'capture-incomplete'],
      { nullable: true },
    ),
    scratchRoot: c.text('scratch_root'),
    cleanupState: c.enum('cleanup_state', ['not-started', 'pending', 'complete', 'quarantined'], {
      default: 'not-started',
    }),
    cleanupErrorCode: c.text('cleanup_error_code', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
    endedAt: c.epochMs('ended_at', { nullable: true }),
  },
  foreignKeys: [
    foreignKey('mcp_runtime_test_sessions_mcp_id_mcps_id_fk', ['mcp_id'], 'mcps', ['id'], {
      onDelete: 'restrict',
    }),
    foreignKey(
      'mcp_runtime_test_sessions_owner_user_id_users_id_fk',
      ['owner_user_id'],
      'users',
      ['id'],
      { onDelete: 'restrict' },
    ),
  ],
  checks: [
    {
      name: 'mcp_runtime_test_sessions_status_shape',
      expression: raw(
        '(\n        (\n          "mcp_runtime_test_sessions"."status" = \'active\'\n          AND "mcp_runtime_test_sessions"."end_reason" IS NULL\n          AND "mcp_runtime_test_sessions"."ended_at" IS NULL\n          AND (\n            ("mcp_runtime_test_sessions"."in_flight_turn_id" IS NOT NULL AND "mcp_runtime_test_sessions"."idle_deadline_at" IS NULL)\n            OR\n            (\n              "mcp_runtime_test_sessions"."in_flight_turn_id" IS NULL\n              AND "mcp_runtime_test_sessions"."idle_deadline_at" IS NOT NULL\n              AND "mcp_runtime_test_sessions"."native_session_state" = \'ready\'\n              AND "mcp_runtime_test_sessions"."continuation_blocked_reason" IS NULL\n            )\n          )\n        )\n        OR\n        (\n          "mcp_runtime_test_sessions"."status" = \'ending\'\n          AND "mcp_runtime_test_sessions"."end_reason" IS NOT NULL\n          AND "mcp_runtime_test_sessions"."ended_at" IS NULL\n          AND "mcp_runtime_test_sessions"."idle_deadline_at" IS NULL\n        )\n        OR\n        (\n          "mcp_runtime_test_sessions"."status" = \'ended\'\n          AND "mcp_runtime_test_sessions"."end_reason" IS NOT NULL\n          AND "mcp_runtime_test_sessions"."ended_at" IS NOT NULL\n          AND "mcp_runtime_test_sessions"."in_flight_turn_id" IS NULL\n          AND "mcp_runtime_test_sessions"."idle_deadline_at" IS NULL\n        )\n      )',
        '( ( "status" = \'active\' AND "end_reason" IS NULL AND "ended_at" IS NULL AND ( ("in_flight_turn_id" IS NOT NULL AND "idle_deadline_at" IS NULL) OR ( "in_flight_turn_id" IS NULL AND "idle_deadline_at" IS NOT NULL AND "native_session_state" = \'ready\' AND "continuation_blocked_reason" IS NULL ) ) ) OR ( "status" = \'ending\' AND "end_reason" IS NOT NULL AND "ended_at" IS NULL AND "idle_deadline_at" IS NULL ) OR ( "status" = \'ended\' AND "end_reason" IS NOT NULL AND "ended_at" IS NOT NULL AND "in_flight_turn_id" IS NULL AND "idle_deadline_at" IS NULL ) )',
      ),
    },
    {
      name: 'mcp_runtime_test_sessions_hash_shape',
      expression: raw(
        'length("mcp_runtime_test_sessions"."client_create_digest") = 64\n        AND "mcp_runtime_test_sessions"."client_create_digest" NOT GLOB \'*[^0-9a-f]*\'\n        AND length("mcp_runtime_test_sessions"."mcp_config_hash") = 64\n        AND "mcp_runtime_test_sessions"."mcp_config_hash" NOT GLOB \'*[^0-9a-f]*\'',
        'length("client_create_digest") = 64 AND "client_create_digest" !~ \'[^0-9a-f]\' AND length("mcp_config_hash") = 64 AND "mcp_config_hash" !~ \'[^0-9a-f]\'',
      ),
    },
    {
      name: 'mcp_runtime_test_sessions_enum_shape',
      expression: raw(
        "\"mcp_runtime_test_sessions\".\"status\" IN ('active', 'ending', 'ended')\n        AND \"mcp_runtime_test_sessions\".\"runtime_protocol\" IN ('opencode', 'claude-code')\n        AND \"mcp_runtime_test_sessions\".\"native_session_state\" IN ('pending', 'ready', 'unusable')\n        AND \"mcp_runtime_test_sessions\".\"cleanup_state\" IN ('not-started', 'pending', 'complete', 'quarantined')\n        AND (\n          \"mcp_runtime_test_sessions\".\"end_reason\" IS NULL\n          OR \"mcp_runtime_test_sessions\".\"end_reason\" IN (\n            'user', 'idle-timeout', 'mcp-deleted', 'mcp-disabled',\n            'mcp-config-changed', 'access-revoked', 'runtime-disabled',\n            'runtime-deleted', 'runtime-profile-changed',\n            'runtime-session-reset', 'capture-truncated',\n            'capture-incomplete', 'session-unusable'\n          )\n        )\n        AND (\n          \"mcp_runtime_test_sessions\".\"continuation_blocked_reason\" IS NULL\n          OR \"mcp_runtime_test_sessions\".\"continuation_blocked_reason\" IN (\n            'mcp-config-changed', 'runtime-profile-changed',\n            'capture-truncated', 'capture-incomplete'\n          )\n        )\n        AND \"mcp_runtime_test_sessions\".\"turn_seq\" >= 0\n        AND \"mcp_runtime_test_sessions\".\"session_version\" >= 0",
        "\"status\" IN ('active', 'ending', 'ended') AND \"runtime_protocol\" IN ('opencode', 'claude-code') AND \"native_session_state\" IN ('pending', 'ready', 'unusable') AND \"cleanup_state\" IN ('not-started', 'pending', 'complete', 'quarantined') AND ( \"end_reason\" IS NULL OR \"end_reason\" IN ( 'user', 'idle-timeout', 'mcp-deleted', 'mcp-disabled', 'mcp-config-changed', 'access-revoked', 'runtime-disabled', 'runtime-deleted', 'runtime-profile-changed', 'runtime-session-reset', 'capture-truncated', 'capture-incomplete', 'session-unusable' ) ) AND ( \"continuation_blocked_reason\" IS NULL OR \"continuation_blocked_reason\" IN ( 'mcp-config-changed', 'runtime-profile-changed', 'capture-truncated', 'capture-incomplete' ) ) AND \"turn_seq\" >= 0 AND \"session_version\" >= 0",
      ),
    },
  ],
  indexes: [
    index('uniq_mcp_runtime_test_sessions_owner_mcp_live', ['mcp_id', 'owner_user_id'], {
      unique: true,
      where: raw(
        '"mcp_runtime_test_sessions"."status" IN (\'active\', \'ending\')',
        "\"status\" IN ('active', 'ending')",
      ),
    }),
    index(
      'uniq_mcp_runtime_test_sessions_create',
      ['mcp_id', 'owner_user_id', 'client_create_id'],
      { unique: true },
    ),
    index('idx_mcp_runtime_test_sessions_owner_mcp_updated', [
      'owner_user_id',
      'mcp_id',
      'updated_at',
    ]),
    index('idx_mcp_runtime_test_sessions_idle', ['status', 'idle_deadline_at']),
  ],
  retention: retention.business,
})

export const mcpRuntimeTestSessions = materializeDrizzle(mcpRuntimeTestSessionsDefinition).table

const mcpRuntimeTestTurnsDefinition = owner.table({
  id: 'mcp_runtime_test_turns',
  schemaSymbol: 'mcpRuntimeTestTurns',
  columns: {
    id: c.id('id', { primary: true }),
    sessionId: c.id('session_id'),
    seq: c.int('seq'),
    clientMessageId: c.id('client_message_id'),
    promptText: c.text('prompt_text'),
    status: c.enum('status', [
      'queued',
      'running',
      'succeeded',
      'failed',
      'canceled',
      'timed_out',
      'interrupted',
    ]),
    hardDeadlineAt: c.epochMs('hard_deadline_at'),
    captureState: c.enum('capture_state', ['live', 'complete', 'truncated', 'incomplete'], {
      default: 'live',
    }),
    captureIncompleteReason: c.text('capture_incomplete_reason', { nullable: true }),
    captureFirstEventSeq: c.int('capture_first_event_seq', { nullable: true }),
    captureLastEventSeq: c.int('capture_last_event_seq', { default: 0 }),
    captureEventBytes: c.int('capture_event_bytes', { default: 0 }),
    cancelRequestedAt: c.epochMs('cancel_requested_at', { nullable: true }),
    pid: c.int('pid', { nullable: true }),
    spawnedAt: c.epochMs('spawned_at', { nullable: true }),
    spawnBinaryPath: c.text('spawn_binary_path', { nullable: true }),
    exitCode: c.int('exit_code', { nullable: true }),
    failureCode: c.text('failure_code', { nullable: true }),
    stderrTail: c.text('stderr_tail', { nullable: true }),
    durationMs: c.int('duration_ms', { nullable: true }),
    startedAt: c.epochMs('started_at', { nullable: true }),
    finishedAt: c.epochMs('finished_at', { nullable: true }),
    createdAt: c.epochMs('created_at'),
  },
  foreignKeys: [
    foreignKey(
      'mcp_runtime_test_turns_session_id_mcp_runtime_test_sessions_id_fk',
      ['session_id'],
      'mcp_runtime_test_sessions',
      ['id'],
      { onDelete: 'cascade' },
    ),
  ],
  checks: [
    {
      name: 'mcp_runtime_test_turns_enum_shape',
      expression: raw(
        "\"mcp_runtime_test_turns\".\"status\" IN (\n          'queued', 'running', 'succeeded', 'failed',\n          'canceled', 'timed_out', 'interrupted'\n        )\n        AND \"mcp_runtime_test_turns\".\"capture_state\" IN ('live', 'complete', 'truncated', 'incomplete')\n        AND (\n          \"mcp_runtime_test_turns\".\"capture_incomplete_reason\" IS NULL\n          OR \"mcp_runtime_test_turns\".\"capture_incomplete_reason\" IN (\n            'stream-persist-failed', 'stream-frame-limit-exceeded',\n            'child-capture-failed', 'post-exit-flush-timeout'\n          )\n        )",
        "\"status\" IN ( 'queued', 'running', 'succeeded', 'failed', 'canceled', 'timed_out', 'interrupted' ) AND \"capture_state\" IN ('live', 'complete', 'truncated', 'incomplete') AND ( \"capture_incomplete_reason\" IS NULL OR \"capture_incomplete_reason\" IN ( 'stream-persist-failed', 'stream-frame-limit-exceeded', 'child-capture-failed', 'post-exit-flush-timeout' ) )",
      ),
    },
    {
      name: 'mcp_runtime_test_turns_counter_shape',
      expression: raw(
        '"mcp_runtime_test_turns"."seq" > 0\n        AND "mcp_runtime_test_turns"."hard_deadline_at" >= "mcp_runtime_test_turns"."created_at"\n        AND "mcp_runtime_test_turns"."capture_last_event_seq" >= 0\n        AND "mcp_runtime_test_turns"."capture_event_bytes" >= 0\n        AND ("mcp_runtime_test_turns"."capture_first_event_seq" IS NULL OR "mcp_runtime_test_turns"."capture_first_event_seq" > 0)\n        AND ("mcp_runtime_test_turns"."duration_ms" IS NULL OR "mcp_runtime_test_turns"."duration_ms" >= 0)',
        '"seq" > 0 AND "hard_deadline_at" >= "created_at" AND "capture_last_event_seq" >= 0 AND "capture_event_bytes" >= 0 AND ("capture_first_event_seq" IS NULL OR "capture_first_event_seq" > 0) AND ("duration_ms" IS NULL OR "duration_ms" >= 0)',
      ),
    },
    {
      name: 'mcp_runtime_test_turns_lifecycle_shape',
      expression: raw(
        '(\n          "mcp_runtime_test_turns"."status" = \'queued\'\n          AND "mcp_runtime_test_turns"."started_at" IS NULL\n          AND "mcp_runtime_test_turns"."finished_at" IS NULL\n        )\n        OR (\n          "mcp_runtime_test_turns"."status" = \'running\'\n          AND "mcp_runtime_test_turns"."started_at" IS NOT NULL\n          AND "mcp_runtime_test_turns"."finished_at" IS NULL\n        )\n        OR (\n          "mcp_runtime_test_turns"."status" IN (\n            \'succeeded\', \'failed\', \'canceled\', \'timed_out\', \'interrupted\'\n          )\n          AND "mcp_runtime_test_turns"."finished_at" IS NOT NULL\n        )',
        '( "status" = \'queued\' AND "started_at" IS NULL AND "finished_at" IS NULL ) OR ( "status" = \'running\' AND "started_at" IS NOT NULL AND "finished_at" IS NULL ) OR ( "status" IN ( \'succeeded\', \'failed\', \'canceled\', \'timed_out\', \'interrupted\' ) AND "finished_at" IS NOT NULL )',
      ),
    },
  ],
  indexes: [
    index('uniq_mcp_runtime_test_turns_session_seq', ['session_id', 'seq'], { unique: true }),
    index('uniq_mcp_runtime_test_turns_message', ['session_id', 'client_message_id'], {
      unique: true,
    }),
    index('idx_mcp_runtime_test_turns_session', ['session_id', 'seq']),
    index('idx_mcp_runtime_test_turns_status', ['status', 'hard_deadline_at']),
  ],
  retention: retention.business,
})

export const mcpRuntimeTestTurns = materializeDrizzle(mcpRuntimeTestTurnsDefinition).table

const mcpsDefinition = owner.table({
  id: 'mcps',
  schemaSymbol: 'mcps',
  columns: {
    id: c.id('id', { primary: true }),
    name: c.text('name'),
    description: c.text('description', { default: '' }),
    type: c.enum('type', ['local', 'remote']),
    config: c.text('config', { default: '{}' }),
    enabled: c.bool('enabled', { default: true }),
    ownerUserId: c.id('owner_user_id', { nullable: true }),
    visibility: c.enum('visibility', ['private', 'public'], { default: 'public' }),
    aclRevision: c.int('acl_revision', { default: 0 }),
    schemaVersion: c.int('schema_version', { default: 1 }),
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
  indexes: [
    index(
      'mcps_owner_name_unique',
      [raw('COALESCE("mcps"."owner_user_id", \'\')', 'COALESCE("owner_user_id", \'\')'), 'name'],
      { unique: true },
    ),
  ],
  retention: retention.business,
})

export const mcps = materializeDrizzle(mcpsDefinition).table

const pluginArtifactGenerationsDefinition = owner.table({
  id: 'plugin_artifact_generations',
  schemaSymbol: 'pluginArtifactGenerations',
  columns: {
    reference: c.id('reference', { primary: true }),
    pluginId: c.id('plugin_id'),
    generationId: c.id('generation_id'),
    spec: c.text('spec'),
    state: c.enum('state', ['installing', 'ready', 'releasing', 'retired']),
    epoch: c.int('epoch'),
    installedJson: c.jsonText('installed_json', { nullable: true }),
    objectId: c.id('object_id', { nullable: true }),
    digest: c.text('digest', { nullable: true }),
    size: c.int('size', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  checks: [
    {
      name: 'plugin_artifact_generations_state_known',
      expression: raw(
        "\"plugin_artifact_generations\".\"state\" IN ('installing', 'ready', 'releasing', 'retired')",
        "\"state\" IN ('installing', 'ready', 'releasing', 'retired')",
      ),
    },
    {
      name: 'plugin_artifact_generations_ready_shape',
      expression: raw(
        '"plugin_artifact_generations"."state" != \'ready\' OR ("plugin_artifact_generations"."object_id" IS NOT NULL AND "plugin_artifact_generations"."digest" IS NOT NULL AND "plugin_artifact_generations"."size" IS NOT NULL)',
        '"state" != \'ready\' OR ("object_id" IS NOT NULL AND "digest" IS NOT NULL AND "size" IS NOT NULL)',
      ),
    },
  ],
  retention: retention.business,
})

export const pluginArtifactGenerations = materializeDrizzle(
  pluginArtifactGenerationsDefinition,
).table

const pluginsDefinition = owner.table({
  id: 'plugins',
  schemaSymbol: 'plugins',
  columns: {
    id: c.id('id', { primary: true }),
    name: c.text('name'),
    spec: c.text('spec'),
    optionsJson: c.jsonText('options_json', { default: '{}' }),
    description: c.text('description', { default: '' }),
    enabled: c.bool('enabled', { default: true }),
    sourceKind: c.enum('source_kind', ['npm', 'file', 'git']),
    cachedPath: c.text('cached_path'),
    resolvedVersion: c.text('resolved_version', { nullable: true }),
    installedAt: c.epochMs('installed_at'),
    ownerUserId: c.id('owner_user_id', { nullable: true }),
    visibility: c.enum('visibility', ['private', 'public'], { default: 'public' }),
    aclRevision: c.int('acl_revision', { default: 0 }),
    schemaVersion: c.int('schema_version', { default: 1 }),
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
  indexes: [
    index(
      'plugins_owner_name_unique',
      [raw('COALESCE("plugins"."owner_user_id", \'\')', 'COALESCE("owner_user_id", \'\')'), 'name'],
      { unique: true },
    ),
  ],
  retention: retention.business,
})

export const plugins = materializeDrizzle(pluginsDefinition).table

const skillOperationLocksDefinition = owner.table({
  id: 'skill_operation_locks',
  schemaSymbol: 'skillOperationLocks',
  columns: {
    lockedSkillId: c.id('locked_skill_id', { primary: true }),
    opId: c.id('op_id'),
    createdAt: c.epochMs('created_at', {
      default: raw(
        '(unixepoch() * 1000)',
        '(extract(epoch from clock_timestamp()) * 1000)::bigint',
      ),
    }),
  },
  retention: retention.operational,
})

export const skillOperationLocks = materializeDrizzle(skillOperationLocksDefinition).table

const skillOperationsDefinition = owner.table({
  id: 'skill_operations',
  schemaSymbol: 'skillOperations',
  columns: {
    opId: c.id('op_id', { primary: true }),
    skillId: c.id('skill_id'),
    kind: c.enum('kind', ['reserve', 'migrate', 'delete', 'version-write']),
    phase: c.text('phase'),
    active: c.int('active', { default: 1 }),
    stagingPath: c.text('staging_path', { nullable: true }),
    backupPath: c.text('backup_path', { nullable: true }),
    candidatePath: c.text('candidate_path', { nullable: true }),
    candidateFingerprint: c.text('candidate_fingerprint', { nullable: true }),
    backupFingerprint: c.text('backup_fingerprint', { nullable: true }),
    targetVersion: c.int('target_version', { nullable: true }),
    generation: c.int('generation', { nullable: true }),
    ownerUserId: c.id('owner_user_id', { nullable: true }),
    preconditionJson: c.jsonText('precondition_json', { nullable: true }),
    createdAt: c.epochMs('created_at', {
      default: raw(
        '(unixepoch() * 1000)',
        '(extract(epoch from clock_timestamp()) * 1000)::bigint',
      ),
    }),
  },
  checks: [
    {
      name: 'skill_operations_kind_enum',
      expression: raw(
        "\"skill_operations\".\"kind\" IN ('reserve', 'migrate', 'delete', 'version-write')",
        "\"kind\" IN ('reserve', 'migrate', 'delete', 'version-write')",
      ),
    },
    {
      name: 'skill_operations_active_boolean',
      expression: raw('"skill_operations"."active" IN (0, 1)', '"active" IN (0, 1)'),
    },
  ],
  indexes: [
    index('uq_skill_operations_active', ['skill_id'], {
      unique: true,
      where: raw('"skill_operations"."active" = 1', '"active" = 1'),
    }),
  ],
  retention: retention.operational,
})

export const skillOperations = materializeDrizzle(skillOperationsDefinition).table

const workgroupMembersDefinition = owner.table({
  id: 'workgroup_members',
  schemaSymbol: 'workgroupMembers',
  columns: {
    id: c.id('id', { primary: true }),
    workgroupId: c.id('workgroup_id'),
    memberType: c.enum('member_type', ['agent', 'human']),
    agentName: c.text('agent_name', { nullable: true }),
    agentId: c.id('agent_id', { nullable: true }),
    userId: c.id('user_id', { nullable: true }),
    displayName: c.text('display_name'),
    roleDesc: c.text('role_desc', { default: '' }),
    sortOrder: c.int('sort_order', { default: 0 }),
    createdAt: c.epochMs('created_at', {
      default: raw(
        '(unixepoch() * 1000)',
        '(extract(epoch from clock_timestamp()) * 1000)::bigint',
      ),
    }),
  },
  foreignKeys: [
    foreignKey(
      'workgroup_members_workgroup_id_workgroups_id_fk',
      ['workgroup_id'],
      'workgroups',
      ['id'],
      { onDelete: 'cascade' },
    ),
  ],
  indexes: [
    index('uq_workgroup_members_display', ['workgroup_id', 'display_name'], { unique: true }),
    index('idx_workgroup_members_group', ['workgroup_id']),
  ],
  retention: retention.business,
})

export const workgroupMembers = materializeDrizzle(workgroupMembersDefinition).table

const workgroupsDefinition = owner.table({
  id: 'workgroups',
  schemaSymbol: 'workgroups',
  columns: {
    id: c.id('id', { primary: true }),
    name: c.text('name'),
    description: c.text('description', { default: '' }),
    instructions: c.text('instructions', { default: '' }),
    mode: c.enum('mode', ['leader_worker', 'free_collab', 'dynamic_workflow'], {
      default: 'leader_worker',
    }),
    outputContract: c.enum('output_contract', ['files', 'discussion'], { default: 'files' }),
    leaderMemberId: c.id('leader_member_id', { nullable: true }),
    shareOutputs: c.bool('share_outputs', { default: true }),
    directMessages: c.bool('direct_messages', { default: false }),
    blackboard: c.bool('blackboard', { default: false }),
    maxRounds: c.int('max_rounds', { default: 20 }),
    completionGate: c.bool('completion_gate', { default: false }),
    clarifyBudget: c.int('clarify_budget', { default: 3 }),
    fanOut: c.bool('fan_out', { default: false }),
    version: c.int('version', { default: 1 }),
    ownerUserId: c.id('owner_user_id', { nullable: true }),
    visibility: c.enum('visibility', ['private', 'public'], { default: 'public' }),
    aclRevision: c.int('acl_revision', { default: 0 }),
    schemaVersion: c.int('schema_version', { default: 1 }),
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
  checks: [
    {
      name: 'workgroups_output_contract_enum',
      expression: raw(
        '"workgroups"."output_contract" IN (\'files\', \'discussion\')',
        "\"output_contract\" IN ('files', 'discussion')",
      ),
    },
  ],
  indexes: [
    index(
      'workgroups_owner_name_unique',
      [
        raw('COALESCE("workgroups"."owner_user_id", \'\')', 'COALESCE("owner_user_id", \'\')'),
        'name',
      ],
      { unique: true },
    ),
  ],
  retention: retention.business,
})

export const workgroups = materializeDrizzle(workgroupsDefinition).table

const resourceBundleAppliesDefinition = owner.table({
  version: 2,
  unique: [],
  foreignKeys: [],
  checks: [],
  indexes: [
    {
      name: 'uniq_resource_bundle_applies_key',
      unique: true,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'scope' },
        { kind: 'column', name: 'key' },
      ],
      where: null,
    },
    {
      name: 'idx_resource_bundle_applies_state',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'state' }],
      where: null,
    },
    {
      name: 'idx_resource_bundle_applies_actor',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'actor_user_id' }],
      where: null,
    },
  ],
  migrationPolicy: 'KEEP',
  id: 'resource_bundle_applies',
  schemaSymbol: 'resourceBundleApplies',
  columns: {
    id: c.id('id', { primary: true }),
    scope: c.text('scope'),
    key: c.text('key'),
    actorUserId: c.id('actor_user_id'),
    state: c.enum('state', ['prepared', 'applying', 'committed', 'failed'], {
      default: 'prepared',
    }),
    preparedArtifactsJson: c.jsonText('prepared_artifacts_json', {
      default: '{"scene":"resource-package","version":2,"artifacts":[]}',
    }),
    receiptJson: c.jsonText('receipt_json', { nullable: true }),
    error: c.text('error', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  primaryKey: ['id'],
  migrationKey: ['id'],
})

export const resourceBundleApplies = materializeDrizzle(resourceBundleAppliesDefinition).table

const agentsDefinition = owner.table({
  version: 2,
  unique: [],
  foreignKeys: [],
  checks: [],
  indexes: [
    {
      name: 'agents_owner_name_unique',
      unique: true,
      nulls: 'distinct',
      columns: [
        {
          kind: 'raw',
          reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
          sqlite: 'COALESCE("agents"."owner_user_id", \'\')',
          postgresql: 'COALESCE("owner_user_id", \'\')',
        },
        { kind: 'column', name: 'name' },
      ],
      where: null,
    },
  ],
  migrationPolicy: 'KEEP',
  id: 'agents',
  schemaSymbol: 'agents',
  columns: {
    id: c.id('id', { primary: true }),
    name: c.text('name'),
    description: c.text('description', { default: '' }),
    outputs: c.jsonText('outputs', { default: '[]' }),
    inputs: c.jsonText('inputs', { default: '[]' }),
    syncOutputsOnIterate: c.bool('sync_outputs_on_iterate', { default: true }),
    runtime: c.text('runtime', { nullable: true }),
    permission: c.jsonText('permission', { default: '{}' }),
    frontmatterExtra: c.jsonText('frontmatter_extra', { default: '{}' }),
    bodyMd: c.text('body_md', { default: '' }),
    ownerUserId: c.id('owner_user_id', { nullable: true }),
    visibility: c.enum('visibility', ['private', 'public'], { default: 'public' }),
    aclRevision: c.int('acl_revision', { default: 0 }),
    builtin: c.bool('builtin', { default: false }),
    schemaVersion: c.int('schema_version', { default: 1 }),
    createdAt: c.epochMs('created_at', {
      default: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite: '(unixepoch() * 1000)',
        postgresql: '(extract(epoch from clock_timestamp()) * 1000)::bigint',
      },
    }),
    updatedAt: c.epochMs('updated_at', {
      default: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite: '(unixepoch() * 1000)',
        postgresql: '(extract(epoch from clock_timestamp()) * 1000)::bigint',
      },
    }),
  },
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  primaryKey: ['id'],
  migrationKey: ['id'],
})

export const agents = materializeDrizzle(agentsDefinition).table

const agentSkillRefsDefinition = owner.table({
  version: 1,
  unique: [
    { name: 'agent_skill_refs_ordinal', columns: ['agent_id', 'ordinal'], nulls: 'distinct' },
  ],
  foreignKeys: [
    {
      name: 'agent_skill_refs_agent_fk',
      columns: ['agent_id'],
      foreignTable: 'agents',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle: 'The parent owns its ordered references; mutable targets may remain dangling.',
    },
  ],
  checks: [
    {
      name: 'agent_skill_refs_kind_shape',
      expression: {
        kind: 'binary',
        op: 'OR',
        left: {
          kind: 'binary',
          op: 'AND',
          left: {
            kind: 'binary',
            op: '=',
            left: { kind: 'column', name: 'kind' },
            right: { kind: 'literal', value: 'managed' },
          },
          right: {
            kind: 'binary',
            op: 'AND',
            left: { kind: 'unary', op: 'IS NOT NULL', value: { kind: 'column', name: 'skill_id' } },
            right: {
              kind: 'unary',
              op: 'IS NULL',
              value: { kind: 'column', name: 'project_name' },
            },
          },
        },
        right: {
          kind: 'binary',
          op: 'AND',
          left: {
            kind: 'binary',
            op: '=',
            left: { kind: 'column', name: 'kind' },
            right: { kind: 'literal', value: 'project' },
          },
          right: {
            kind: 'binary',
            op: 'AND',
            left: {
              kind: 'unary',
              op: 'IS NOT NULL',
              value: { kind: 'column', name: 'project_name' },
            },
            right: { kind: 'unary', op: 'IS NULL', value: { kind: 'column', name: 'skill_id' } },
          },
        },
      },
    },
  ],
  indexes: [
    {
      name: 'agent_skill_refs_target',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'skill_id' }],
      where: null,
    },
  ],
  migrationPolicy: 'KEEP',
  id: 'agent_skill_refs',
  schemaSymbol: 'agentSkillRefs',
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  columns: {
    agentId: c.id('agent_id'),
    referenceKey: c.slotKey('reference_key'),
    occurrence: c.int('occurrence'),
    ordinal: c.int('ordinal'),
    kind: c.enum('kind', ['managed', 'project']),
    skillId: c.id('skill_id', { nullable: true }),
    projectName: c.text('project_name', { nullable: true }),
  },
  primaryKey: ['agent_id', 'reference_key', 'occurrence'],
  migrationKey: ['agent_id', 'reference_key', 'occurrence'],
})

export const agentSkillRefs = materializeDrizzle(agentSkillRefsDefinition).table

const agentMcpRefsDefinition = owner.table({
  version: 1,
  unique: [{ name: 'agent_mcp_refs_ordinal', columns: ['agent_id', 'ordinal'], nulls: 'distinct' }],
  foreignKeys: [
    {
      name: 'agent_mcp_refs_agent_fk',
      columns: ['agent_id'],
      foreignTable: 'agents',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle: 'The parent owns its ordered references; mutable targets may remain dangling.',
    },
  ],
  checks: [],
  indexes: [
    {
      name: 'agent_mcp_refs_target',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'mcp_id' }],
      where: null,
    },
  ],
  migrationPolicy: 'KEEP',
  id: 'agent_mcp_refs',
  schemaSymbol: 'agentMcpRefs',
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  columns: {
    agentId: c.id('agent_id'),
    mcpId: c.id('mcp_id'),
    occurrence: c.int('occurrence'),
    ordinal: c.int('ordinal'),
  },
  primaryKey: ['agent_id', 'mcp_id', 'occurrence'],
  migrationKey: ['agent_id', 'mcp_id', 'occurrence'],
})

export const agentMcpRefs = materializeDrizzle(agentMcpRefsDefinition).table

const agentPluginRefsDefinition = owner.table({
  version: 1,
  unique: [
    { name: 'agent_plugin_refs_ordinal', columns: ['agent_id', 'ordinal'], nulls: 'distinct' },
  ],
  foreignKeys: [
    {
      name: 'agent_plugin_refs_agent_fk',
      columns: ['agent_id'],
      foreignTable: 'agents',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle: 'The parent owns its ordered references; mutable targets may remain dangling.',
    },
  ],
  checks: [],
  indexes: [
    {
      name: 'agent_plugin_refs_target',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'plugin_id' }],
      where: null,
    },
  ],
  migrationPolicy: 'KEEP',
  id: 'agent_plugin_refs',
  schemaSymbol: 'agentPluginRefs',
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  columns: {
    agentId: c.id('agent_id'),
    pluginId: c.id('plugin_id'),
    occurrence: c.int('occurrence'),
    ordinal: c.int('ordinal'),
  },
  primaryKey: ['agent_id', 'plugin_id', 'occurrence'],
  migrationKey: ['agent_id', 'plugin_id', 'occurrence'],
})

export const agentPluginRefs = materializeDrizzle(agentPluginRefsDefinition).table

const agentDependenciesDefinition = owner.table({
  version: 1,
  unique: [
    { name: 'agent_dependencies_ordinal', columns: ['agent_id', 'ordinal'], nulls: 'distinct' },
  ],
  foreignKeys: [
    {
      name: 'agent_dependencies_agent_fk',
      columns: ['agent_id'],
      foreignTable: 'agents',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle: 'The parent owns its ordered references; mutable targets may remain dangling.',
    },
  ],
  checks: [],
  indexes: [
    {
      name: 'agent_dependencies_target',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'dependency_agent_id' }],
      where: null,
    },
  ],
  migrationPolicy: 'KEEP',
  id: 'agent_dependencies',
  schemaSymbol: 'agentDependencies',
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  columns: {
    agentId: c.id('agent_id'),
    dependencyAgentId: c.id('dependency_agent_id'),
    occurrence: c.int('occurrence'),
    ordinal: c.int('ordinal'),
  },
  primaryKey: ['agent_id', 'dependency_agent_id', 'occurrence'],
  migrationKey: ['agent_id', 'dependency_agent_id', 'occurrence'],
})

export const agentDependencies = materializeDrizzle(agentDependenciesDefinition).table

const workflowsDefinition = owner.table({
  version: 2,
  unique: [],
  foreignKeys: [],
  checks: [],
  indexes: [
    {
      name: 'idx_workflows_builtin_name',
      unique: true,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'name' }],
      where: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite: '"workflows"."builtin" = 1',
        postgresql: '"builtin" = TRUE',
      },
    },
  ],
  migrationPolicy: 'KEEP',
  id: 'workflows',
  schemaSymbol: 'workflows',
  columns: {
    id: c.id('id', { primary: true }),
    name: c.text('name'),
    description: c.text('description', { default: '' }),
    definition: c.jsonText('definition'),
    version: c.int('version', { default: 1 }),
    ownerUserId: c.id('owner_user_id', { nullable: true }),
    visibility: c.enum('visibility', ['private', 'public'], { default: 'public' }),
    aclRevision: c.int('acl_revision', { default: 0 }),
    builtin: c.bool('builtin', { default: false }),
    schemaVersion: c.int('schema_version', { default: 1 }),
    createdAt: c.epochMs('created_at', {
      default: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite: '(unixepoch() * 1000)',
        postgresql: '(extract(epoch from clock_timestamp()) * 1000)::bigint',
      },
    }),
    updatedAt: c.epochMs('updated_at', {
      default: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite: '(unixepoch() * 1000)',
        postgresql: '(extract(epoch from clock_timestamp()) * 1000)::bigint',
      },
    }),
  },
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  primaryKey: ['id'],
  migrationKey: ['id'],
})

export const workflows = materializeDrizzle(workflowsDefinition).table

const workflowDependencyIndexDefinition = owner.table({
  version: 1,
  unique: [],
  foreignKeys: [
    {
      name: 'workflow_dependency_index_workflow_fk',
      columns: ['workflow_id'],
      foreignTable: 'workflows',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle:
        'Parser-owned index is rebuilt with the canonical definition; selectors do not own mutable resources.',
    },
  ],
  checks: [],
  indexes: [
    {
      name: 'workflow_dependency_index_selector',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'resource_kind' },
        { kind: 'column', name: 'selector_kind' },
        { kind: 'column', name: 'selector_value' },
      ],
      where: null,
    },
  ],
  migrationPolicy: 'KEEP',
  id: 'workflow_dependency_index',
  schemaSymbol: 'workflowDependencyIndex',
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  columns: {
    workflowId: c.id('workflow_id'),
    revision: c.int('revision'),
    referencePath: c.text('reference_path'),
    resourceKind: c.enum('resource_kind', ['agent', 'workflow', 'workgroup']),
    selectorKind: c.enum('selector_kind', ['id', 'name']),
    selectorValue: c.text('selector_value'),
    namespaceJson: c.jsonText('namespace_json'),
  },
  primaryKey: ['workflow_id', 'revision', 'reference_path'],
  migrationKey: ['workflow_id', 'revision', 'reference_path'],
})

export const workflowDependencyIndex = materializeDrizzle(workflowDependencyIndexDefinition).table

const skillsDefinition = owner.table({
  version: 2,
  unique: [],
  foreignKeys: [],
  checks: [],
  indexes: [
    {
      name: 'skills_owner_name_unique',
      unique: true,
      nulls: 'distinct',
      columns: [
        {
          kind: 'raw',
          reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
          sqlite: 'COALESCE("skills"."owner_user_id", \'\')',
          postgresql: 'COALESCE("owner_user_id", \'\')',
        },
        { kind: 'column', name: 'name' },
      ],
      where: null,
    },
  ],
  migrationPolicy: 'KEEP',
  id: 'skills',
  schemaSymbol: 'skills',
  columns: {
    id: c.id('id', { primary: true }),
    name: c.text('name'),
    description: c.text('description', { default: '' }),
    ownerUserId: c.id('owner_user_id', { nullable: true }),
    visibility: c.enum('visibility', ['private', 'public'], { default: 'public' }),
    schemaVersion: c.int('schema_version', { default: 1 }),
    contentVersion: c.int('content_version', { default: 1 }),
    aclRevision: c.int('acl_revision', { default: 0 }),
    metaRevision: c.int('meta_revision', { default: 0 }),
    reservationState: c.enum('reservation_state', ['reserving', 'ready'], { default: 'ready' }),
    versionState: c.enum(
      'version_state',
      ['legacy-unbackfilled', 'snapshot-unverified', 'snapshot-authoritative', 'quarantined'],
      { default: 'legacy-unbackfilled' },
    ),
    createdAt: c.epochMs('created_at', {
      default: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite: '(unixepoch() * 1000)',
        postgresql: '(extract(epoch from clock_timestamp()) * 1000)::bigint',
      },
    }),
    updatedAt: c.epochMs('updated_at', {
      default: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite: '(unixepoch() * 1000)',
        postgresql: '(extract(epoch from clock_timestamp()) * 1000)::bigint',
      },
    }),
    contentRefJson: c.jsonText('content_ref_json', {
      document: { kind: 'content-ref', version: 1, inlineBytesColumn: 'content_inline_bytes' },
      nullable: true,
    }),
    contentInlineBytes: c.bytes('content_inline_bytes', { nullable: true }),
  },
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  primaryKey: ['id'],
  migrationKey: ['id'],
})

export const skills = materializeDrizzle(skillsDefinition).table

const skillVersionsDefinition = owner.table({
  version: 2,
  unique: [],
  foreignKeys: [
    {
      name: 'skill_versions_skill_id_skills_id_fk',
      columns: ['skill_id'],
      foreignTable: 'skills',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle:
        'Preserve epoch-1 cascade delete and no action update semantics; target is a logical table reference.',
    },
  ],
  checks: [],
  indexes: [
    {
      name: 'uq_skill_versions_skill_v',
      unique: true,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'skill_id' },
        { kind: 'column', name: 'version_index' },
      ],
      where: null,
    },
    {
      name: 'idx_skill_versions_created',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'created_at' }],
      where: null,
    },
    {
      name: 'idx_skill_versions_fusion',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'fusion_id' }],
      where: null,
    },
  ],
  migrationPolicy: 'KEEP',
  id: 'skill_versions',
  schemaSymbol: 'skillVersions',
  columns: {
    id: c.id('id', { primary: true }),
    skillId: c.id('skill_id'),
    versionIndex: c.int('version_index'),
    source: c.enum('source', ['initial', 'editor', 'fusion', 'restore', 'import']),
    summary: c.text('summary', { nullable: true }),
    fusionId: c.id('fusion_id', { nullable: true }),
    restoredFromVersion: c.int('restored_from_version', { nullable: true }),
    authorUserId: c.id('author_user_id', { nullable: true }),
    contentHash: c.text('content_hash', { nullable: true }),
    createdAt: c.epochMs('created_at', {
      default: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite: '(unixepoch() * 1000)',
        postgresql: '(extract(epoch from clock_timestamp()) * 1000)::bigint',
      },
    }),
    contentRefJson: c.jsonText('content_ref_json', {
      document: { kind: 'content-ref', version: 1, inlineBytesColumn: 'content_inline_bytes' },
    }),
    contentInlineBytes: c.bytes('content_inline_bytes', { nullable: true }),
  },
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  primaryKey: ['id'],
  migrationKey: ['id'],
})

export const skillVersions = materializeDrizzle(skillVersionsDefinition).table

const skillContentEntriesDefinition = owner.table({
  version: 2,
  unique: [],
  foreignKeys: [],
  checks: [],
  indexes: [],
  migrationPolicy: 'KEEP',
  id: 'skill_content_entries',
  schemaSymbol: 'skillContentEntries',
  columns: {
    skillId: c.id('skill_id'),
    tree: c.text('tree'),
    path: c.text('path'),
    size: c.int('size'),
    updatedAt: c.epochMs('updated_at'),
    contentRefJson: c.jsonText('content_ref_json', {
      document: { kind: 'content-ref', version: 1, inlineBytesColumn: 'content_inline_bytes' },
    }),
    contentInlineBytes: c.bytes('content_inline_bytes', { nullable: true }),
  },
  primaryKey: ['skill_id', 'tree', 'path'],
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  migrationKey: ['skill_id', 'tree', 'path'],
})

export const skillContentEntries = materializeDrizzle(skillContentEntriesDefinition).table

export const schemaContribution = {
  owner: 'resource-catalog',
  version: 2,
  tables: [
    mcpProbesDefinition,
    mcpRuntimeTestCreateReceiptsDefinition,
    mcpRuntimeTestEventsDefinition,
    mcpRuntimeTestSessionLeasesDefinition,
    mcpRuntimeTestSessionsDefinition,
    mcpRuntimeTestTurnsDefinition,
    mcpsDefinition,
    pluginArtifactGenerationsDefinition,
    pluginsDefinition,
    skillOperationLocksDefinition,
    skillOperationsDefinition,
    workgroupMembersDefinition,
    workgroupsDefinition,
    resourceBundleAppliesDefinition,
    agentsDefinition,
    agentSkillRefsDefinition,
    agentMcpRefsDefinition,
    agentPluginRefsDefinition,
    agentDependenciesDefinition,
    workflowsDefinition,
    workflowDependencyIndexDefinition,
    skillsDefinition,
    skillVersionsDefinition,
    skillContentEntriesDefinition,
  ],
} as const
