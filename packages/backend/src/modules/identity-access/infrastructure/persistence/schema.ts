// RFC-395 I-a: explicit epoch-1 schema contributions; no physical or runtime change.
import {
  column as c,
  defineContribution,
  retention,
  raw,
  foreignKey,
  index,
} from '@/platform/persistence/schema/dsl'
import { materializeDrizzle } from '@/platform/persistence/schema/drizzle'

const owner = defineContribution('identity-access')

const authLoginPolicyDefinition = owner.table({
  id: 'auth_login_policy',
  schemaSymbol: 'authLoginPolicy',
  columns: {
    id: c.id('id', { primary: true }),
    passwordLoginEnabled: c.bool('password_login_enabled', { default: true }),
    oidcDefaultRole: c.enum('oidc_default_role', ['guest', 'user'], { default: 'guest' }),
    bootstrapCompletedAt: c.epochMs('bootstrap_completed_at', { nullable: true }),
    updatedAt: c.epochMs('updated_at'),
  },
  checks: [
    {
      name: 'auth_login_policy_oidc_default_role_enum',
      expression: raw(
        '"auth_login_policy"."oidc_default_role" IN (\'guest\', \'user\')',
        "\"oidc_default_role\" IN ('guest', 'user')",
      ),
    },
    {
      name: 'auth_login_policy_id_fixed',
      expression: raw('"auth_login_policy"."id" = \'global\'', '"id" = \'global\''),
    },
  ],
  retention: retention.business,
})

export const authLoginPolicy = materializeDrizzle(authLoginPolicyDefinition).table

const externalIdentitiesDefinition = owner.table({
  id: 'external_identities',
  schemaSymbol: 'externalIdentities',
  columns: {
    id: c.id('id', { primary: true }),
    issuer: c.text('issuer'),
    subject: c.text('subject'),
    userId: c.id('user_id'),
    linkedAt: c.epochMs('linked_at'),
  },
  foreignKeys: [
    foreignKey('external_identities_user_id_users_id_fk', ['user_id'], 'users', ['id'], {
      onDelete: 'cascade',
    }),
  ],
  indexes: [
    index('idx_external_identities_user', ['user_id']),
    index('external_identities_issuer_subject_unique', ['issuer', 'subject'], { unique: true }),
  ],
  retention: retention.business,
})

export const externalIdentities = materializeDrizzle(externalIdentitiesDefinition).table

const oidcProvidersDefinition = owner.table({
  id: 'oidc_providers',
  schemaSymbol: 'oidcProviders',
  columns: {
    id: c.id('id', { primary: true }),
    slug: c.text('slug', { unique: 'oidc_providers_slug_unique' }),
    displayName: c.text('display_name'),
    issuerUrl: c.text('issuer_url'),
    clientId: c.id('client_id'),
    clientSecretEnc: c.text('client_secret_enc'),
    scopes: c.text('scopes', { default: 'openid profile email' }),
    provisioning: c.enum('provisioning', ['auto', 'allowlist', 'invite'], { default: 'invite' }),
    allowedEmailDomainsJson: c.jsonText('allowed_email_domains_json', { default: '[]' }),
    iconUrl: c.text('icon_url', { nullable: true }),
    enabled: c.bool('enabled', { default: true }),
    authorizationEndpoint: c.text('authorization_endpoint', { nullable: true }),
    tokenEndpoint: c.text('token_endpoint', { nullable: true }),
    userinfoEndpoint: c.text('userinfo_endpoint', { nullable: true }),
    userinfoRequestStyle: c.enum('userinfo_request_style', ['get_bearer', 'post_json'], {
      default: 'get_bearer',
    }),
    jwksUri: c.text('jwks_uri', { nullable: true }),
    trustEmailVerified: c.bool('trust_email_verified', { default: false }),
    usernameClaim: c.text('username_claim', { nullable: true }),
    gitNameClaim: c.text('git_name_claim', { nullable: true }),
    emailClaim: c.text('email_claim', { nullable: true }),
    subjectClaim: c.text('subject_claim', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
    schemaVersion: c.int('schema_version', { default: 1 }),
  },
  indexes: [index('idx_oidc_providers_enabled', ['enabled'])],
  retention: retention.business,
})

export const oidcProviders = materializeDrizzle(oidcProvidersDefinition).table

const resourceGrantsDefinition = owner.table({
  id: 'resource_grants',
  schemaSymbol: 'resourceGrants',
  columns: {
    resourceType: c.enum('resource_type', [
      'agent',
      'skill',
      'mcp',
      'plugin',
      'workflow',
      'workgroup',
      'capability_template',
      'action_template',
      'verification_profile',
      'digital_employee',
      'automation_policy',
      'development_adapter',
      'employee_definition',
      'employee_tool',
      'employee_job_template',
      'scheduled_task',
    ]),
    resourceId: c.id('resource_id'),
    userId: c.id('user_id'),
    addedBy: c.text('added_by'),
    addedAt: c.epochMs('added_at'),
    level: c.enum('level', ['read', 'write'], { default: 'read' }),
  },
  primaryKey: ['resource_type', 'resource_id', 'user_id'],
  foreignKeys: [
    foreignKey('resource_grants_user_id_users_id_fk', ['user_id'], 'users', ['id'], {
      onDelete: 'cascade',
    }),
  ],
  checks: [
    {
      name: 'resource_grants_level_enum',
      expression: raw(
        '"resource_grants"."level" IN (\'read\', \'write\')',
        "\"level\" IN ('read', 'write')",
      ),
    },
  ],
  indexes: [index('idx_resource_grants_user', ['user_id'])],
  retention: retention.business,
})

export const resourceGrants = materializeDrizzle(resourceGrantsDefinition).table

const tokenAuditDefinition = owner.table({
  id: 'token_audit',
  schemaSymbol: 'tokenAudit',
  columns: {
    id: c.id('id', { primary: true }),
    patId: c.id('pat_id'),
    userId: c.id('user_id'),
    channel: c.text('channel'),
    toolName: c.text('tool_name', { nullable: true }),
    method: c.text('method', { nullable: true }),
    path: c.text('path', { nullable: true }),
    resourceKind: c.text('resource_kind', { nullable: true }),
    resourceId: c.id('resource_id', { nullable: true }),
    statusCode: c.int('status_code'),
    snapshotFailed: c.bool('snapshot_failed', { default: false }),
    createdAt: c.epochMs('created_at'),
  },
  indexes: [
    index('idx_token_audit_user_created', ['user_id', 'created_at']),
    index('idx_token_audit_pat_created', ['pat_id', 'created_at']),
    index('idx_token_audit_created', ['created_at']),
  ],
  retention: retention.operational,
})

export const tokenAudit = materializeDrizzle(tokenAuditDefinition).table

const tokenDeleteSnapshotDefinition = owner.table({
  id: 'token_delete_snapshot',
  schemaSymbol: 'tokenDeleteSnapshot',
  columns: {
    id: c.id('id', { primary: true }),
    auditId: c.id('audit_id'),
    resourceKind: c.text('resource_kind'),
    resourceId: c.id('resource_id'),
    snapshotJson: c.jsonText('snapshot_json'),
    createdAt: c.epochMs('created_at'),
  },
  indexes: [
    index('idx_token_delete_snapshot_audit', ['audit_id']),
    index('idx_token_delete_snapshot_created', ['created_at']),
  ],
  retention: retention.business,
})

export const tokenDeleteSnapshot = materializeDrizzle(tokenDeleteSnapshotDefinition).table

const userAccessAuditDefinition = owner.table({
  id: 'user_access_audit',
  schemaSymbol: 'userAccessAudit',
  columns: {
    id: c.id('id', { primary: true }),
    targetUserId: c.id('target_user_id'),
    actorUserId: c.id('actor_user_id', { nullable: true }),
    actorKind: c.enum('actor_kind', ['session', 'cli', 'system']),
    operationId: c.id('operation_id'),
    correlationId: c.id('correlation_id', { nullable: true }),
    beforeRole: c.enum('before_role', ['admin', 'user', 'manager', 'guest']),
    afterRole: c.enum('after_role', ['admin', 'user', 'manager', 'guest']),
    addedPermissionsJson: c.jsonText('added_permissions_json'),
    removedPermissionsJson: c.jsonText('removed_permissions_json'),
    accessRevision: c.int('access_revision'),
    createdAt: c.epochMs('created_at'),
  },
  indexes: [
    index('idx_user_access_audit_target_revision', ['target_user_id', 'access_revision']),
    index('idx_user_access_audit_created', ['created_at']),
    index('idx_user_access_audit_operation', ['operation_id']),
  ],
  retention: retention.operational,
})

export const userAccessAudit = materializeDrizzle(userAccessAuditDefinition).table

const userIdentitiesDefinition = owner.table({
  id: 'user_identities',
  schemaSymbol: 'userIdentities',
  columns: {
    id: c.id('id', { primary: true }),
    userId: c.id('user_id'),
    providerId: c.id('provider_id'),
    subject: c.text('subject'),
    email: c.text('email', { nullable: true }),
    emailVerified: c.int('email_verified', { default: 0 }),
    preferredSnapshot: c.text('preferred_snapshot', { nullable: true }),
    linkedAt: c.epochMs('linked_at'),
  },
  foreignKeys: [
    foreignKey('user_identities_user_id_users_id_fk', ['user_id'], 'users', ['id'], {
      onDelete: 'cascade',
    }),
    foreignKey(
      'user_identities_provider_id_oidc_providers_id_fk',
      ['provider_id'],
      'oidc_providers',
      ['id'],
      { onDelete: 'restrict' },
    ),
  ],
  indexes: [
    index('idx_user_identities_user', ['user_id']),
    index('idx_user_identities_provider', ['provider_id']),
    index('user_identities_provider_subject_unique', ['provider_id', 'subject'], { unique: true }),
  ],
  retention: retention.business,
})

export const userIdentities = materializeDrizzle(userIdentitiesDefinition).table

const userPatsDefinition = owner.table({
  id: 'user_pats',
  schemaSymbol: 'userPats',
  columns: {
    id: c.id('id', { primary: true }),
    userId: c.id('user_id'),
    name: c.text('name'),
    tokenHash: c.text('token_hash', { unique: 'user_pats_token_hash_unique' }),
    scopesJson: c.jsonText('scopes_json', { default: '[]' }),
    createdAt: c.epochMs('created_at'),
    lastUsedAt: c.epochMs('last_used_at', { nullable: true }),
    expiresAt: c.epochMs('expires_at', { nullable: true }),
    revokedAt: c.epochMs('revoked_at', { nullable: true }),
    purpose: c.text('purpose', { default: 'general' }),
  },
  foreignKeys: [
    foreignKey('user_pats_user_id_users_id_fk', ['user_id'], 'users', ['id'], {
      onDelete: 'cascade',
    }),
  ],
  indexes: [index('idx_user_pats_user', ['user_id'])],
  retention: retention.business,
})

export const userPats = materializeDrizzle(userPatsDefinition).table

const userPermissionGrantsDefinition = owner.table({
  id: 'user_permission_grants',
  schemaSymbol: 'userPermissionGrants',
  columns: {
    userId: c.id('user_id'),
    permission: c.id('permission'),
    grantedByUserId: c.id('granted_by_user_id', { nullable: true }),
    grantedAt: c.epochMs('granted_at'),
  },
  primaryKey: ['user_id', 'permission'],
  foreignKeys: [
    foreignKey('user_permission_grants_user_id_users_id_fk', ['user_id'], 'users', ['id'], {
      onDelete: 'cascade',
    }),
  ],
  indexes: [index('idx_user_permission_grants_permission', ['permission'])],
  retention: retention.business,
})

export const userPermissionGrants = materializeDrizzle(userPermissionGrantsDefinition).table

const userRepositoryTransportCredentialsDefinition = owner.table({
  id: 'user_repository_transport_credentials',
  schemaSymbol: 'userRepositoryTransportCredentials',
  columns: {
    userId: c.id('user_id'),
    provider: c.enum('provider', ['gitlab', 'github']),
    connectionGeneration: c.text('connection_generation'),
    endpointBindingDigest: c.id('endpoint_binding_digest'),
    tokenEnc: c.text('token_enc'),
    tokenHint: c.text('token_hint'),
    credentialRevision: c.int('credential_revision'),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  primaryKey: ['user_id', 'provider'],
  foreignKeys: [
    foreignKey(
      'user_repository_transport_credentials_user_id_users_id_fk',
      ['user_id'],
      'users',
      ['id'],
      { onDelete: 'cascade' },
    ),
    foreignKey(
      'user_repository_transport_credentials_connection_fk',
      ['provider', 'connection_generation'],
      'repository_transport_connections',
      ['provider', 'connection_generation'],
      { onDelete: 'cascade', onUpdate: 'cascade' },
    ),
  ],
  checks: [
    {
      name: 'user_repository_transport_credentials_provider_enum',
      expression: raw(
        '"user_repository_transport_credentials"."provider" IN (\'gitlab\', \'github\')',
        "\"provider\" IN ('gitlab', 'github')",
      ),
    },
    {
      name: 'user_repository_transport_credentials_connection_generation_length',
      expression: raw(
        'length("user_repository_transport_credentials"."connection_generation") BETWEEN 1 AND 128',
        'length("connection_generation") BETWEEN 1 AND 128',
      ),
    },
    {
      name: 'user_repository_transport_credentials_endpoint_binding_digest_length',
      expression: raw(
        'length("user_repository_transport_credentials"."endpoint_binding_digest") = 64 AND "user_repository_transport_credentials"."endpoint_binding_digest" NOT GLOB \'*[^0-9a-f]*\'',
        'length("endpoint_binding_digest") = 64 AND "endpoint_binding_digest" !~ \'[^0-9a-f]\'',
      ),
    },
    {
      name: 'user_repository_transport_credentials_token_hint_length',
      expression: raw(
        'length("user_repository_transport_credentials"."token_hint") = 4',
        'length("token_hint") = 4',
      ),
    },
    {
      name: 'user_repository_transport_credentials_credential_revision_positive',
      expression: raw(
        '"user_repository_transport_credentials"."credential_revision" > 0',
        '"credential_revision" > 0',
      ),
    },
  ],
  indexes: [
    index('idx_user_repository_transport_credentials_provider_generation', [
      'provider',
      'connection_generation',
    ]),
  ],
  retention: retention.business,
})

export const userRepositoryTransportCredentials = materializeDrizzle(
  userRepositoryTransportCredentialsDefinition,
).table

const userSessionsDefinition = owner.table({
  id: 'user_sessions',
  schemaSymbol: 'userSessions',
  columns: {
    id: c.id('id', { primary: true }),
    userId: c.id('user_id'),
    tokenHash: c.text('token_hash', { unique: 'user_sessions_token_hash_unique' }),
    userAgent: c.text('user_agent', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    lastUsedAt: c.epochMs('last_used_at'),
    expiresAt: c.epochMs('expires_at'),
    revokedAt: c.epochMs('revoked_at', { nullable: true }),
  },
  foreignKeys: [
    foreignKey('user_sessions_user_id_users_id_fk', ['user_id'], 'users', ['id'], {
      onDelete: 'cascade',
    }),
  ],
  indexes: [index('idx_user_sessions_user', ['user_id', 'expires_at'])],
  retention: retention.business,
})

export const userSessions = materializeDrizzle(userSessionsDefinition).table

const usersDefinition = owner.table({
  id: 'users',
  schemaSymbol: 'users',
  columns: {
    id: c.id('id', { primary: true }),
    username: c.text('username', { unique: 'users_username_unique' }),
    email: c.text('email', { nullable: true, unique: 'users_email_unique' }),
    displayName: c.text('display_name'),
    gitName: c.text('git_name', { default: '' }),
    passwordHash: c.text('password_hash', { nullable: true }),
    role: c.enum('role', ['admin', 'user', 'manager', 'guest'], { default: 'user' }),
    status: c.enum('status', ['active', 'disabled', 'invited'], { default: 'active' }),
    forcePasswordChange: c.bool('force_password_change', { default: false }),
    createdBy: c.text('created_by', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
    lastLoginAt: c.epochMs('last_login_at', { nullable: true }),
    schemaVersion: c.int('schema_version', { default: 1 }),
    accessRevision: c.int('access_revision', { default: 0 }),
  },
  indexes: [index('idx_users_status', ['status'])],
  retention: retention.business,
})

export const users = materializeDrizzle(usersDefinition).table

export const schemaContribution = owner.contribution([
  authLoginPolicyDefinition,
  externalIdentitiesDefinition,
  oidcProvidersDefinition,
  resourceGrantsDefinition,
  tokenAuditDefinition,
  tokenDeleteSnapshotDefinition,
  userAccessAuditDefinition,
  userIdentitiesDefinition,
  userPatsDefinition,
  userPermissionGrantsDefinition,
  userRepositoryTransportCredentialsDefinition,
  userSessionsDefinition,
  usersDefinition,
])
