// RFC-305 architecture lock: additions must flow through the shared catalog,
// the identity-access public surface, and the sole transactional writer.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import { PERMISSIONS, SYSTEM_DOMAIN_POINTS } from '@agent-workflow/shared'
import ts from 'typescript'

import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createInMemoryDb } from '../src/db/client'
import { ALL_TOOLS } from '../src/mcp/tools'
import { allRouteMeta, resetRouteMetaRegistry } from '../src/routes/registry'
import { createApp } from '../src/server'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const BACKEND_SRC = resolve(REPO_ROOT, 'packages', 'backend', 'src')
const IDENTITY_ROOT = resolve(BACKEND_SRC, 'modules', 'identity-access')
const FRONTEND_SRC = resolve(REPO_ROOT, 'packages', 'frontend', 'src')
const MIGRATIONS = resolve(REPO_ROOT, 'packages', 'backend', 'db', 'migrations')

function sourceFiles(root: string, extensions = ['.ts']): string[] {
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && extensions.some((extension) => path.endsWith(extension))) {
        files.push(path)
      }
    }
  }
  visit(root)
  return files.sort()
}

function relativeToRepo(file: string): string {
  return relative(REPO_ROOT, file).replaceAll('\\', '/')
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

function stringLiterals(file: string): ReadonlyArray<string> {
  const values: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) values.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(parse(file))
  return values
}

function exportedNames(file: string): string[] {
  const names = new Set<string>()
  const source = parse(file)
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined) {
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) names.add(element.name.text)
      }
      continue
    }
    const exported =
      (ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined)?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      ) ?? false
    if (!exported) continue
    if (
      ts.isClassDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      if (statement.name !== undefined) names.add(statement.name.text)
      continue
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text)
      }
    }
  }
  return [...names].sort()
}

function identityAccessImportsOutsideOwner(): string[] {
  const imports: string[] = []
  for (const file of sourceFiles(BACKEND_SRC)) {
    if (file.startsWith(`${IDENTITY_ROOT}/`)) continue
    for (const value of stringLiterals(file)) {
      if (!value.includes('modules/identity-access/')) continue
      imports.push(`${relativeToRepo(file)} -> ${value}`)
    }
  }
  return imports.sort()
}

function filesContainingCodePattern(root: string, pattern: RegExp): string[] {
  const matches: string[] = []
  for (const file of sourceFiles(root, ['.ts', '.tsx'])) {
    const source = parse(file)
    let matched = false
    const visit = (node: ts.Node): void => {
      if (matched) return
      if (
        ts.isStringLiteralLike(node) ||
        ts.isTemplateExpression(node) ||
        ts.isTaggedTemplateExpression(node)
      ) {
        if (pattern.test(node.getText(source))) matched = true
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    if (matched) matches.push(relativeToRepo(file))
  }
  return matches.sort()
}

function filesContainingIdentifier(root: string, identifier: string): string[] {
  const matches: string[] = []
  for (const file of sourceFiles(root, ['.ts', '.tsx'])) {
    const source = parse(file)
    let matched = false
    const visit = (node: ts.Node): void => {
      if (matched) return
      if (ts.isIdentifier(node) && node.text === identifier) matched = true
      ts.forEachChild(node, visit)
    }
    visit(source)
    if (matched) matches.push(relativeToRepo(file))
  }
  return matches.sort()
}

function filesReadingAccountRole(root: string): string[] {
  const matches: string[] = []
  for (const file of sourceFiles(root, ['.ts', '.tsx'])) {
    const source = parse(file)
    let matched = false
    const visit = (node: ts.Node): void => {
      if (matched) return
      if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === 'role' &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'user'
      ) {
        matched = true
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    if (matched) matches.push(relativeToRepo(file))
  }
  return matches.sort()
}

describe('RFC-305 identity-access architecture', () => {
  test('public entrypoints expose only the reviewed exact contracts', () => {
    const publicRoot = resolve(IDENTITY_ROOT, 'public')
    expect(
      sourceFiles(publicRoot).map((file) => relative(publicRoot, file).replaceAll('\\', '/')),
    ).toEqual(['commands.ts', 'events.ts', 'participants.ts', 'queries.ts', 'types.ts'])
    expect(exportedNames(resolve(publicRoot, 'commands.ts'))).toEqual([
      'CreateManagedUser',
      'CreateManagedUserCommand',
      'ExactAccessSnapshot',
      'UpdateUserAccess',
      'UpdateUserAccessCommand',
      'UpdateUserAccessResult',
    ])
    expect(exportedNames(resolve(publicRoot, 'events.ts'))).toEqual([
      'AuthorityRevisionChanged',
      'IdentityAccessEventSink',
    ])
    expect(exportedNames(resolve(publicRoot, 'queries.ts'))).toEqual([
      'GetUserAccess',
      'GetUserAccessQuery',
      'requireUserAccess',
    ])
    expect(exportedNames(resolve(publicRoot, 'types.ts'))).toEqual([
      'AdminUserAccessView',
      'ManagedUserStatus',
      'ResolvedAuthoritySubject',
      'UserAccessError',
      'UserAccessErrorKind',
    ])
    expect(exportedNames(resolve(publicRoot, 'participants.ts'))).toEqual([
      'AuthenticatedPrincipal',
      'AuthorizationSubjectRef',
      'CommandContext',
      'CurrentSubjectAccessResolver',
      'DelegatedAuthorityRef',
      'DelegatedAuthorityResolver',
      'DelegatedOperationContextFactory',
      'DelegatedSource',
      'DirectOperationContextFactory',
      'DirectTransport',
      'DurableSourceAttemptRef',
      'IdempotentCommandContext',
      'PrincipalSource',
      'QueryContext',
      'RequestAuthority',
      'ValidatedIdempotencyKey',
    ])
  })

  test('module composition and public contracts have only the reviewed consumers', () => {
    expect(identityAccessImportsOutsideOwner()).toEqual([
      'packages/backend/src/auth/actor.ts -> @/modules/identity-access/composition',
      'packages/backend/src/auth/actor.ts -> @/modules/identity-access/public/participants',
      'packages/backend/src/auth/actor.ts -> @/modules/identity-access/public/types',
      'packages/backend/src/routes/users.ts -> @/modules/identity-access/public/commands',
      'packages/backend/src/routes/users.ts -> @/modules/identity-access/public/participants',
      'packages/backend/src/routes/users.ts -> @/modules/identity-access/public/queries',
      'packages/backend/src/routes/users.ts -> @/modules/identity-access/public/types',
      'packages/backend/src/server.ts -> @/modules/identity-access/composition',
      'packages/backend/src/services/users.ts -> @/modules/identity-access/composition',
      'packages/backend/src/services/users.ts -> @/modules/identity-access/public/types',
    ])
  })

  test('role/grants/revision/audit retain a single production writer', () => {
    expect(
      filesContainingCodePattern(
        BACKEND_SRC,
        /(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+user_permission_grants/i,
      ),
    ).toEqual([
      'packages/backend/src/modules/identity-access/infrastructure/sqliteUserAccessRepository.ts',
    ])
    expect(filesContainingCodePattern(BACKEND_SRC, /INSERT\s+INTO\s+user_access_audit/i)).toEqual([
      'packages/backend/src/modules/identity-access/infrastructure/sqliteUserAccessAuditRepository.ts',
    ])
    expect(
      filesContainingCodePattern(BACKEND_SRC, /(?:UPDATE|DELETE\s+FROM)\s+user_access_audit/i),
    ).toEqual([])

    const roleRevisionWriters = sourceFiles(BACKEND_SRC)
      .filter((file) => {
        const text = readFileSync(file, 'utf8')
        return /\bvalues\.(?:role|accessRevision)\s*=/.test(text)
      })
      .map(relativeToRepo)
    expect(roleRevisionWriters).toEqual([
      'packages/backend/src/modules/identity-access/infrastructure/sqliteUserAccessRepository.ts',
    ])

    const facade = readFileSync(resolve(BACKEND_SRC, 'services', 'users.ts'), 'utf8')
    expect(facade).not.toMatch(/ROLE_PERMISSIONS|user_permission_grants|\.update\(users\)/)
    expect(filesContainingIdentifier(BACKEND_SRC, 'ROLE_PERMISSIONS')).toEqual([])
  })
})

describe('RFC-305 permission catalog architecture', () => {
  beforeEach(() => resetRouteMetaRegistry())
  afterEach(() => resetRouteMetaRegistry())

  test('route and MCP authorization expose a single permission axis', () => {
    createApp({
      token: 'd'.repeat(64),
      configPath: '',
      opencodeVersion: 'test',
      dbVersion: 162,
      db: createInMemoryDb(MIGRATIONS),
      secretBox: createSecretBoxFromKey(Buffer.alloc(32, 30)),
    })

    for (const route of allRouteMeta()) expect(route).not.toHaveProperty('identity')
    for (const tool of ALL_TOOLS) expect(tool).not.toHaveProperty('identity')
    expect(readFileSync(resolve(BACKEND_SRC, 'routes', 'registry.ts'), 'utf8')).not.toContain(
      'actor.user.role',
    )
    expect(readFileSync(resolve(BACKEND_SRC, 'mcp', 'tools.ts'), 'utf8')).not.toContain(
      'actor.user.role ===',
    )
  })

  test('roles remain presentation/preset data and never become authorization predicates', () => {
    const presentationRoleComparisonAllowlist = new Set([
      // Account-role counts shown in the user directory; this does not gate an action.
      'packages/frontend/src/lib/user-directory.ts',
      // These two `role` fields belong to task/intent attribution, not AccountRole.
      'packages/frontend/src/components/AttributionChip.tsx',
      'packages/frontend/src/routes/intent.detail.tsx',
    ])
    const retiredAuthorizationHelpers = new Set([
      'adminShortCircuit',
      'isAdminActor',
      'isAdminAtRequest',
      'isResourceAdminRole',
      'useIsAdmin',
      'useIsResourceAdmin',
    ])
    const offenders: string[] = []
    for (const root of [BACKEND_SRC, FRONTEND_SRC]) {
      for (const file of sourceFiles(root, ['.ts', '.tsx'])) {
        const source = parse(file)
        const relativeFile = relativeToRepo(file)
        const visit = (node: ts.Node): void => {
          if (ts.isIdentifier(node) && retiredAuthorizationHelpers.has(node.text)) {
            const position = source.getLineAndCharacterOfPosition(node.getStart(source))
            offenders.push(`${relativeFile}:${position.line + 1} retired ${node.text}`)
          }
          if (ts.isBinaryExpression(node)) {
            const operator = node.operatorToken.kind
            const isComparison = [
              ts.SyntaxKind.EqualsEqualsToken,
              ts.SyntaxKind.EqualsEqualsEqualsToken,
              ts.SyntaxKind.ExclamationEqualsToken,
              ts.SyntaxKind.ExclamationEqualsEqualsToken,
            ].includes(operator)
            const roleNames = new Set(['admin', 'manager', 'user'])
            const propertyRole = (candidate: ts.Expression): boolean =>
              ts.isPropertyAccessExpression(candidate) && candidate.name.text === 'role'
            const roleLiteral = (candidate: ts.Expression): boolean =>
              ts.isStringLiteralLike(candidate) && roleNames.has(candidate.text)
            const comparesRoleLiteral =
              isComparison &&
              ((propertyRole(node.left) && roleLiteral(node.right)) ||
                (roleLiteral(node.left) && propertyRole(node.right)))
            if (comparesRoleLiteral && !presentationRoleComparisonAllowlist.has(relativeFile)) {
              const position = source.getLineAndCharacterOfPosition(node.getStart(source))
              offenders.push(`${relativeFile}:${position.line + 1} ${node.getText(source)}`)
            }
          }
          ts.forEachChild(node, visit)
        }
        visit(source)
      }
    }
    expect(offenders).toEqual([])

    // The backend may resolve a preset only through identity-access/shared helpers;
    // it must never read the preset table directly. The frontend reads it only in
    // the user-access editor model, never in route/component authorization gates.
    expect(filesContainingIdentifier(BACKEND_SRC, 'ROLE_PERMISSIONS')).toEqual([])
    expect(filesContainingIdentifier(FRONTEND_SRC, 'ROLE_PERMISSIONS')).toEqual([
      'packages/frontend/src/lib/user-permissions.ts',
    ])

    // Account-role reads are restricted to preset resolution, wire/display metadata,
    // and the access editor. Adding another read requires an explicit architecture
    // review; authorization consumers should read Actor.permissions instead.
    expect(filesReadingAccountRole(BACKEND_SRC)).toEqual([
      'packages/backend/src/auth/actor.ts',
      'packages/backend/src/mcp/tools.ts',
      'packages/backend/src/routes/docs.ts',
      'packages/backend/src/server.ts',
    ])
    expect(filesReadingAccountRole(FRONTEND_SRC)).toEqual([
      'packages/frontend/src/components/UserMenu.tsx',
      'packages/frontend/src/components/account/AccountOverviewPanel.tsx',
      'packages/frontend/src/components/users/EditUserDialog.tsx',
    ])
  })

  test('every system-domain point has an AST string-literal production consumer', () => {
    const consumed = new Set(
      sourceFiles(BACKEND_SRC).flatMap((file) =>
        stringLiterals(file).filter((value) =>
          (SYSTEM_DOMAIN_POINTS as readonly string[]).includes(value),
        ),
      ),
    )
    expect([...SYSTEM_DOMAIN_POINTS].filter((permission) => !consumed.has(permission))).toEqual([])
  })

  test('both user dialogs render the shared catalog and contain no permission id table', () => {
    const createDialog = resolve(FRONTEND_SRC, 'components', 'users', 'CreateUserDialog.tsx')
    const editDialog = resolve(FRONTEND_SRC, 'components', 'users', 'EditUserDialog.tsx')
    const permissionIds = new Set<string>(PERMISSIONS)
    for (const file of [createDialog, editDialog]) {
      const text = readFileSync(file, 'utf8')
      expect(text).toContain("from '@/components/users/UserPermissionCatalog'")
      expect(text).toContain('<UserPermissionCatalog')
      expect(stringLiterals(file).filter((value) => permissionIds.has(value))).toEqual([])
    }

    const model = readFileSync(resolve(FRONTEND_SRC, 'lib', 'user-permissions.ts'), 'utf8')
    expect(model).toContain('PERMISSION_CATALOG')
    expect(model).toContain('PERMISSIONS.map')
    const component = readFileSync(
      resolve(FRONTEND_SRC, 'components', 'users', 'UserPermissionCatalog.tsx'),
      'utf8',
    )
    expect(component).not.toMatch(/selectAll|select-all|select all/i)
  })
})

describe('RFC-305 reusable-authority fences', () => {
  test('delegated authority has concrete opaque factories and reviewed launch consumers', () => {
    const composition = readFileSync(resolve(IDENTITY_ROOT, 'composition.ts'), 'utf8')
    const contexts = readFileSync(
      resolve(IDENTITY_ROOT, 'application', 'operationContext.ts'),
      'utf8',
    )
    const actor = readFileSync(resolve(BACKEND_SRC, 'auth', 'actor.ts'), 'utf8')
    const scheduler = readFileSync(resolve(BACKEND_SRC, 'services', 'scheduler.ts'), 'utf8')
    const scheduled = readFileSync(resolve(BACKEND_SRC, 'services', 'scheduledTasks.ts'), 'utf8')
    const webhook = readFileSync(
      resolve(BACKEND_SRC, 'services', 'webhook', 'webhookDispatch.ts'),
      'utf8',
    )

    expect(composition).toContain('new ResolveDelegatedAuthority(resolveAuthority)')
    expect(composition).toContain('new DelegatedOperationContextFactory(factoryDeps)')
    expect(contexts).toContain('new WeakMap<')
    expect(contexts).toContain("throw new Error('untrusted-delegated-authority')")
    expect(actor).toContain('.delegatedAuthority.resolve(')
    expect(scheduler).toContain("'call-workflow'")
    expect(scheduler).toContain("'call-workgroup'")
    expect(scheduled).toContain("'schedule'")
    expect(webhook).toContain("'webhook'")
  })

  test('WS delivery is DB-revision fenced and refreshes the frontend actor cache', () => {
    const registry = readFileSync(resolve(BACKEND_SRC, 'ws', 'registry.ts'), 'utf8')
    const connections = readFileSync(resolve(BACKEND_SRC, 'ws', 'connections.ts'), 'utf8')
    const hook = readFileSync(resolve(FRONTEND_SRC, 'hooks', 'useWebSocket.ts'), 'utf8')
    expect(registry).toContain('SELECT status, access_revision FROM users WHERE id = ? LIMIT 1')
    expect(registry).toContain('if (!authorityRevisionCurrent(ws, db)) return')
    expect(registry).not.toMatch(/\?\.\$client|\$client\?\?/)
    expect(connections).toContain("type: 'authority.changed'")
    expect(hook).toContain("type === 'authority.changed'")
    expect(hook).toContain('invalidateQueries({ queryKey: ACTOR_QUERY_KEY })')
  })
})
