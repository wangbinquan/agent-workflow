// RFC-305 architecture lock: additions must flow through the shared catalog,
// the identity-access public surface, and the sole transactional writer.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import { PERMISSIONS, SYSTEM_DOMAIN_POINTS } from '@agent-workflow/shared'
import { eq, sql } from 'drizzle-orm'
import ts from 'typescript'

import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createInMemoryDb } from '../src/db/client'
import { users } from '../src/db/schema'
import { dbTxSync, type DbTxSync } from '../src/db/txSync'
import { ALL_TOOLS } from '../src/mcp/tools'
import {
  withExistingSQLiteTransactionScope,
  withSQLiteTransaction,
} from '../src/platform/persistence/sqlite/existingTransactionScope'
import type { TransactionScope } from '../src/platform/persistence/transactionScope'
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

/**
 * 某份已解析源码里，是否存在命中 pattern 的**字符串 / 模板字面量**。**纯函数**
 * ——扫描与 RFC-317 T14 的「matcher 自证」共用它，避免判据长出第二份实现。
 */
function sourceHasCodePattern(source: ts.SourceFile, pattern: RegExp): boolean {
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
  return matched
}

function filesContainingCodePattern(root: string, pattern: RegExp): string[] {
  const matches: string[] = []
  for (const file of sourceFiles(root, ['.ts', '.tsx'])) {
    if (sourceHasCodePattern(parse(file), pattern)) matches.push(relativeToRepo(file))
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

function filesCallingTableMethod(root: string, method: string, table: string): string[] {
  const matches: string[] = []
  for (const file of sourceFiles(root)) {
    const source = parse(file)
    let matched = false
    const visit = (node: ts.Node): void => {
      if (matched) return
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === method &&
        node.arguments.some((argument) => ts.isIdentifier(argument) && argument.text === table)
      ) {
        matched = true
        return
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    if (matched) matches.push(relativeToRepo(file))
  }
  return matches.sort()
}

describe('RFC-305 identity-access architecture', () => {
  test('existing SQLite transactions expose only a callback-scoped RFC-294 capability', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    let escaped: TransactionScope | null = null
    let escapedTransaction: DbTxSync | null = null
    let escapedQuery: { run(): unknown } | null = null
    let escapedRow: { value: number } | null = null
    let reflectedSession: { run(query: unknown): unknown } | null = null
    dbTxSync(db, (transaction) => {
      withExistingSQLiteTransactionScope(transaction, (scope) => {
        escaped = scope
        withSQLiteTransaction(scope, (liveTransaction) => {
          escapedTransaction = liveTransaction
          expect(liveTransaction).not.toBe(transaction)
          liveTransaction.run(sql`SELECT 1`)
          escapedQuery = liveTransaction.update(users).set({ displayName: 'must-not-run' })
          const rows = liveTransaction.all(sql`SELECT 1 AS value`) as Array<{ value: number }>
          expect(Array.isArray(rows)).toBe(true)
          expect(Object.keys(rows)).toEqual(['0'])
          expect({ ...rows[0] }).toEqual({ value: 1 })
          expect(JSON.stringify(rows)).toBe('[{"value":1}]')
          rows.map((row) => {
            escapedRow = row
            return row.value
          })
          const sessionDescriptor = Object.getOwnPropertyDescriptor(liveTransaction, 'session')
          expect(sessionDescriptor).toBeDefined()
          expect(sessionDescriptor!.value).not.toBe(
            (transaction as unknown as { session: unknown }).session,
          )
          reflectedSession = sessionDescriptor!.value as { run(query: unknown): unknown }
          expect(Reflect.ownKeys(liveTransaction)).toContain('session')
          expect(
            liveTransaction
              .select({ id: users.id })
              .from(users)
              .where((fields) => eq(fields.id, 'missing'))
              .all(),
          ).toEqual([])
          expect(() =>
            (liveTransaction as unknown as DbTxSync).transaction(() => {
              throw new Error('nested callback must never run')
            }),
          ).toThrow('nested SQLite transactions are not available')
          expect(() =>
            Object.getOwnPropertyDescriptor(
              Object.getPrototypeOf(liveTransaction) as object,
              'transaction',
            ),
          ).toThrow('nested SQLite transactions are not available')
          expect(() =>
            (liveTransaction.select().from(users) as unknown as { execute(): unknown }).execute(),
          ).toThrow('asynchronous SQLite query execution is not available')
          return undefined
        })
        return undefined
      })
    })

    expect(() => withSQLiteTransaction(escaped!, () => undefined)).toThrow(
      'transaction scope is not live',
    )
    expect(() => escapedTransaction!.run(sql`SELECT 1`)).toThrow('transaction scope is not live')
    expect(() => escapedQuery!.run()).toThrow('transaction scope is not live')
    expect(() => escapedRow!.value).toThrow('transaction scope is not live')
    expect(() => reflectedSession!.run(sql`SELECT 1`)).toThrow('transaction scope is not live')

    let continuation: Promise<void> | null = null
    expect(() =>
      dbTxSync(db, (transaction) => {
        const smuggledAsyncBody = ((scope: TransactionScope) => {
          continuation = (async () => {
            let liveTransaction: DbTxSync | null = null
            withSQLiteTransaction(scope, (currentTransaction) => {
              liveTransaction = currentTransaction
              return undefined
            })
            await Promise.resolve()
            liveTransaction!.run(sql`SELECT 1`)
          })()
          return continuation
        }) as unknown as (scope: TransactionScope) => undefined
        withExistingSQLiteTransactionScope(transaction, smuggledAsyncBody)
      }),
    ).toThrow('transaction scope callback must not return a value')
    await expect(continuation!).rejects.toThrow('transaction scope is not live')
  })

  test('existing SQLite transaction callbacks reject async bodies at compile time', () => {
    void ((transaction: DbTxSync, scope: TransactionScope): void => {
      // @ts-expect-error -- RFC-294 transaction scopes must remain synchronous.
      withExistingSQLiteTransactionScope(transaction, async () => undefined)
      // @ts-expect-error -- RFC-294 transaction participants must remain synchronous.
      withSQLiteTransaction(scope, async () => undefined)
      withSQLiteTransaction(scope, (liveTransaction) => {
        // @ts-expect-error -- nested transactions can expose an unguarded Drizzle handle.
        liveTransaction.transaction(() => undefined)
        return undefined
      })
    })
  })

  test('public entrypoints expose only the reviewed exact contracts', () => {
    const publicRoot = resolve(IDENTITY_ROOT, 'public')
    expect(
      sourceFiles(publicRoot).map((file) => relative(publicRoot, file).replaceAll('\\', '/')),
    ).toEqual(['commands.ts', 'events.ts', 'participants.ts', 'queries.ts', 'types.ts'])
    expect(exportedNames(resolve(publicRoot, 'commands.ts'))).toEqual([
      'CreateManagedUser',
      'CreateManagedUserCommand',
      'ExactAccessSnapshot',
      'InitialUserAccessProvision',
      'UpdateUserAccess',
      'UpdateUserAccessCommand',
      'UpdateUserAccessResult',
      'insertInitialUserAccessInTransaction',
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
      'packages/backend/src/auth/loginPolicy.ts -> @/modules/identity-access/public/commands',
      'packages/backend/src/routes/users.ts -> @/modules/identity-access/public/commands',
      'packages/backend/src/routes/users.ts -> @/modules/identity-access/public/participants',
      'packages/backend/src/routes/users.ts -> @/modules/identity-access/public/queries',
      'packages/backend/src/routes/users.ts -> @/modules/identity-access/public/types',
      'packages/backend/src/server.ts -> @/modules/identity-access/composition',
      'packages/backend/src/services/userIdentities.ts -> @/modules/identity-access/public/commands',
      'packages/backend/src/services/users.ts -> @/modules/identity-access/composition',
      'packages/backend/src/services/users.ts -> @/modules/identity-access/public/types',
      // RFC-312 —— presence 通道的 onOpenExtra 需要 presence 的 command/query。
      // 与既有三处（auth/actor.ts、server.ts、services/users.ts）同型：composeIdentityAccess
      // 按 db 实例缓存，取到的是 public 用例而非模块内部。
      // 更干净的做法是把实例经 adapter deps 注入，但 `onOpenExtra(ws, params, db)` 的签名是
      // 注册表全局的，为一个通道改它会波及所有通道——留作后续 seam，不在本 RFC 承担。
      'packages/backend/src/ws/registry.ts -> @/modules/identity-access/composition',
    ])
  })

  test('role/grants/revision/audit retain a single production writer', () => {
    expect(filesCallingTableMethod(BACKEND_SRC, 'insert', 'users')).toEqual([
      'packages/backend/src/modules/identity-access/infrastructure/sqliteUserAccessRepository.ts',
    ])
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
  }, 20_000)

  test('authority and directory views consume one-statement access snapshots', () => {
    const authority = readFileSync(
      resolve(IDENTITY_ROOT, 'application', 'queries', 'resolveAuthority.ts'),
      'utf8',
    )
    const directory = readFileSync(
      resolve(IDENTITY_ROOT, 'application', 'queries', 'getUserAccess.ts'),
      'utf8',
    )
    const repository = readFileSync(
      resolve(IDENTITY_ROOT, 'infrastructure', 'sqliteUserAccessRepository.ts'),
      'utf8',
    )
    expect(authority).toContain('findAccessSnapshot')
    expect(authority).not.toContain('.findUser(')
    expect(authority).not.toContain('.listGrants(')
    expect(directory).toContain('findAccessSnapshot')
    expect(directory).toContain('listAccessSnapshots')
    expect(directory).not.toContain('.findUser(')
    expect(directory).not.toContain('.listGrants(')
    expect(repository).toContain('LEFT JOIN user_permission_grants AS g ON g.user_id = u.id')
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
            const roleNames = new Set(['admin', 'manager', 'user', 'guest'])
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
      // The identity-access writer copies the initial preset into its audit
      // record; it never branches authorization behavior on the role.
      'packages/backend/src/modules/identity-access/infrastructure/sqliteUserAccessRepository.ts',
      'packages/backend/src/routes/docs.ts',
      'packages/backend/src/server.ts',
    ])
    expect(filesReadingAccountRole(FRONTEND_SRC)).toEqual([
      'packages/frontend/src/components/UserMenu.tsx',
      'packages/frontend/src/components/account/AccountOverviewPanel.tsx',
      'packages/frontend/src/components/users/EditUserDialog.tsx',
    ])
  }, 20_000)

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

  test('guest presentation keeps navigation stable and gates nested data by exact capability', () => {
    const navigation = readFileSync(resolve(FRONTEND_SRC, 'lib', 'nav.ts'), 'utf8')
    const shellNavigation = readFileSync(
      resolve(FRONTEND_SRC, 'components', 'shell', 'ShellNavigation.tsx'),
      'utf8',
    )
    const appShell = readFileSync(
      resolve(FRONTEND_SRC, 'components', 'shell', 'AppShell.tsx'),
      'utf8',
    )
    const appPortal = readFileSync(resolve(FRONTEND_SRC, 'components', 'AppPortal.tsx'), 'utf8')
    const memoryBadge = readFileSync(
      resolve(FRONTEND_SRC, 'components', 'shell', 'MemoryPendingBadge.tsx'),
      'utf8',
    )
    const taskWizard = readFileSync(resolve(FRONTEND_SRC, 'routes', 'tasks.new.tsx'), 'utf8')
    const repoSourceRow = readFileSync(
      resolve(FRONTEND_SRC, 'components', 'launch', 'RepoSourceRow.tsx'),
      'utf8',
    )
    const agentForm = readFileSync(resolve(FRONTEND_SRC, 'components', 'AgentForm.tsx'), 'utf8')
    const workflowEditor = readFileSync(
      resolve(FRONTEND_SRC, 'routes', 'workflows.edit.tsx'),
      'utf8',
    )
    const agentFormCallers = sourceFiles(FRONTEND_SRC, ['.ts', '.tsx']).filter((file) =>
      readFileSync(file, 'utf8').includes('<AgentForm'),
    )

    expect(shellNavigation).toContain('NAV_GROUPS.map')
    expect(shellNavigation).not.toMatch(/useCurrentPermissions|navGroupsForPermissions/)
    expect(navigation).toContain('navPermissionsForPath')
    expect(navigation).toContain('TASK_SOURCE_REGISTRATIONS.map')
    expect(navigation).toContain('source.creation.requiredPermission')
    expect(appShell).toContain('navPermissionsForPath(pathname)')
    expect(appShell).toContain('destinationPermissions.some')
    expect(appShell).toContain('lastAuthorizedDestinationRef')
    expect(appShell).toContain('mountDestination &&')
    expect(appShell).toContain('<Activity')
    expect(appShell).toContain('<RoutePortalScope active={destinationGranted}>')
    expect(appShell).toContain('authorityNavigationBlockedRef.current = preserveDestination')
    expect(appShell).toContain('shouldBlockFn: blockWhileAuthorityIsUnsettled')
    expect(appPortal).toContain('RoutePortalActiveContext')
    expect(appPortal).toContain('return createPortal(children, target ?? document.body)')
    expect(
      sourceFiles(FRONTEND_SRC, ['.ts', '.tsx'])
        .filter((file) => readFileSync(file, 'utf8').includes("from 'react-dom'"))
        .map(relativeToRepo),
    ).toEqual(['packages/frontend/src/components/AppPortal.tsx'])
    expect(appShell).toContain("permissions.has('memory:read')")
    expect(memoryBadge).toContain("usePermission('memory:read')")
    expect(memoryBadge).toContain('enabled: canReadMemory')
    expect(agentForm).toContain('enabled: runtimeRegistryReadable')
    expect(agentForm).toContain(
      'runtimeRegistryReadable ? (runtimesQuery.data?.runtimes ?? []) : []',
    )
    expect(agentFormCallers.map(relativeToRepo)).toEqual([
      'packages/frontend/src/routes/agents.detail.tsx',
      'packages/frontend/src/routes/agents.new.tsx',
    ])
    for (const caller of agentFormCallers) {
      expect(readFileSync(caller, 'utf8')).toContain('runtimeRegistryReadable={canReadRuntime}')
    }
    expect(workflowEditor).toContain(
      'editorLayoutClass(selection?.id ?? null, workspaceMode, canUpdate)',
    )
    expect(taskWizard).toContain("usePermission('repos:read')")
    expect(taskWizard).toContain("usePermission('scheduled-tasks:create')")
    expect(taskWizard).toContain("usePermission('users:search')")
    expect(taskWizard).toContain('enabled: canReadRepos')
    expect(taskWizard).toContain('enabled: isRelaunch && canReadTasks')
    expect(taskWizard).toContain(
      'enabled: isEdit && canReadScheduledTasks && canUpdateScheduledTasks',
    )
    expect(repoSourceRow).toContain('enabled: catalogEnabled')
    expect(repoSourceRow).toContain('enabled: catalogEnabled && onSelectGroup !== undefined')
    expect(repoSourceRow).toContain('const cachedItems = catalogEnabled')
    expect(repoSourceRow).toContain('catalogItems ??')
    expect(repoSourceRow).toContain('cached.data?.items.map')
    const userLookup = readFileSync(resolve(FRONTEND_SRC, 'hooks', 'useUserLookup.ts'), 'utf8')
    expect(userLookup).toContain('canSearchUsers ? (query.data ?? []) : []')
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
    const authorityHook = readFileSync(
      resolve(FRONTEND_SRC, 'hooks', 'useAuthoritySync.ts'),
      'utf8',
    )
    const appShell = readFileSync(
      resolve(FRONTEND_SRC, 'components', 'shell', 'AppShell.tsx'),
      'utf8',
    )
    expect(registry).toContain('SELECT status, access_revision FROM users WHERE id = ? LIMIT 1')
    expect(registry).toContain('if (!authorityRevisionCurrent(ws, db)) return')
    expect(registry).not.toMatch(/\?\.\$client|\$client\?\?/)
    expect(connections).toContain("type: 'authority.changed'")
    expect(hook).toContain("type === 'authority.changed'")
    expect(hook).toContain('invalidateQueries({ queryKey: ACTOR_QUERY_KEY })')
    expect(authorityHook).toContain('WS_PATHS.authority')
    expect(appShell).toContain('useAuthoritySync()')
  })
})

// RFC-317 T13 —— 语料非空（守卫的守卫：architecture/rfc317-guard-corpus-floor.test.ts）。
//
// 上面每条断言的绿都可能来自两处：真的没有违规，或者**扫描根失效、语料被筛成空**。
// 两者在断言层面同形，后者是永久静默的假绿。这一条把「扫描器还活着」变成可断言事实；
// 下限同时两向钉进 architecture/guard-manifest.json，静默调低会红。
describe('RFC-317 T13 —— 语料非空', () => {
  test('扫描确实覆盖到源码语料（扫空即假绿）', () => {
    expect(
      sourceFiles(BACKEND_SRC).length + sourceFiles(FRONTEND_SRC, ['.ts', '.tsx']).length,
    ).toBeGreaterThanOrEqual(900)
  })
})

// RFC-317 T14 —— 负 fixture：把伪造的源码喂给**扫描用的同一份判据**。
//
// 本文件里若干条断言的形态是 `expect(filesContainingCodePattern(root, RE)).toEqual([…])`。
// 这类断言的静默失效面在 **AST 遍历**那一环：`sourceHasCodePattern` 只看字符串 /
// 模板字面量，一旦遍历漏掉一种字面量形态（模板串、tagged template），SQL 写在那种
// 形态里就永远扫不到，`toEqual([])` 于是永远成立——与「没人这么写」同形。
describe('RFC-317 T14 —— matcher 自证：字面量扫描必须覆盖三种字面量形态', () => {
  const probe = (text: string): ts.SourceFile =>
    ts.createSourceFile('probe.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  test('普通字符串 / 模板串 / tagged template 里的 SQL 都扫得到', () => {
    const pattern = /INSERT\s+INTO\s+user_access_audit/i
    for (const fabricated of [
      'db.run("INSERT INTO user_access_audit (id) VALUES (?)")\n',
      'db.run(`INSERT INTO user_access_audit (id) VALUES (${id})`)\n',
      'const q = sql`INSERT INTO user_access_audit (id) VALUES (${id})`\n',
    ]) {
      expect(sourceHasCodePattern(probe(fabricated), pattern), `没扫到：${fabricated}`).toBe(true)
    }
  })

  test('无关 SQL 不误报（规则不能宽到把别的表也算进来）', () => {
    expect(
      sourceHasCodePattern(
        probe('db.run("INSERT INTO resource_grants (id) VALUES (?)")\n'),
        /INSERT\s+INTO\s+user_access_audit/i,
      ),
    ).toBe(false)
  })

  test('注释里写 SQL 不算（注释不是字符串字面量）', () => {
    expect(
      sourceHasCodePattern(
        probe('// INSERT INTO user_access_audit (id) VALUES (?)\nconst x = 1\n'),
        /INSERT\s+INTO\s+user_access_audit/i,
      ),
    ).toBe(false)
  })
})
