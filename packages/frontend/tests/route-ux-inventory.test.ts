// RFC-198 — executable inventory for every route registered by router.tsx.
//
// This is deliberately a two-way ratchet: a newly registered route must gain an
// explicit UX classification + test owner, while a removed route must be pruned
// from this manifest. The parser uses the TypeScript AST and import identities so
// formatting, comments, and local import aliases cannot create false positives.

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, test } from 'vitest'

type RouteClassification = 'standard' | 'specialized' | 'redirect' | 'resolver'
type TestOwnerKind = 'rendered' | 'source'

interface TestOwner {
  file: string
  kind: TestOwnerKind
}

type HeaderPrimitive = 'PageHeader' | 'ResourceGalleryPage' | 'ResourceSplitPage'

type HeaderOwnership =
  | {
      mode: 'direct'
      sourceFile: string
      primitive: 'PageHeader'
    }
  | {
      mode: 'shared-layout'
      sourceFile: string
      primitive: 'ResourceGalleryPage' | 'ResourceSplitPage'
    }

interface RouteInventoryBase {
  surface: string
  owners: readonly TestOwner[]
}

type RouteInventoryEntry =
  | (RouteInventoryBase & {
      classification: 'standard'
      header: HeaderOwnership
    })
  | (RouteInventoryBase & {
      classification: Exclude<RouteClassification, 'standard'>
      header?: never
    })

export interface RegisteredRoute {
  key: string
  localName: string
  parentKey: string | null
}

const TANSTACK_ROUTER = '@tanstack/react-router'
const LOCAL_ROUTE_PREFIX = 'router.tsx#path:'

function importedKey(moduleName: string, importedName: string): string {
  return `${moduleName}#${importedName}`
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  return null
}

function findObjectProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.ObjectLiteralElementLike | undefined {
  return object.properties.find((property) =>
    ts.isShorthandPropertyAssignment(property)
      ? property.name.text === name
      : 'name' in property &&
        property.name !== undefined &&
        propertyNameText(property.name) === name,
  )
}

function isImportedFunction(
  expression: ts.Expression,
  imports: ReadonlyMap<string, string>,
  importedName: string,
): boolean {
  return (
    ts.isIdentifier(expression) &&
    imports.get(expression.text) === importedKey(TANSTACK_ROUTER, importedName)
  )
}

function routeTreeExpression(
  sourceFile: ts.SourceFile,
  imports: ReadonlyMap<string, string>,
  initializers: ReadonlyMap<string, ts.Expression>,
): ts.Expression {
  let configuredTree: ts.Expression | undefined

  const visit = (node: ts.Node): void => {
    if (
      configuredTree === undefined &&
      ts.isCallExpression(node) &&
      isImportedFunction(node.expression, imports, 'createRouter')
    ) {
      const options = node.arguments[0]
      if (options !== undefined && ts.isObjectLiteralExpression(options)) {
        const property = findObjectProperty(options, 'routeTree')
        if (property !== undefined) {
          if (ts.isShorthandPropertyAssignment(property)) {
            configuredTree = initializers.get(property.name.text) ?? property.name
          } else if (ts.isPropertyAssignment(property)) {
            configuredTree = ts.isIdentifier(property.initializer)
              ? (initializers.get(property.initializer.text) ?? property.initializer)
              : property.initializer
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  if (configuredTree === undefined) {
    throw new Error('createRouter({ routeTree }) was not found')
  }
  return configuredTree
}

function localRouteKeys(
  imports: ReadonlyMap<string, string>,
  initializers: ReadonlyMap<string, ts.Expression>,
): Map<string, string> {
  const routes = new Map<string, string>()

  for (const [localName, initializer] of initializers) {
    if (
      !ts.isCallExpression(initializer) ||
      !isImportedFunction(initializer.expression, imports, 'createRoute')
    ) {
      continue
    }
    const options = initializer.arguments[0]
    if (options === undefined || !ts.isObjectLiteralExpression(options)) continue
    const pathProperty = findObjectProperty(options, 'path')
    if (
      pathProperty === undefined ||
      !ts.isPropertyAssignment(pathProperty) ||
      !ts.isStringLiteral(pathProperty.initializer)
    ) {
      throw new Error(`Local route ${localName} must have a static string path`)
    }
    routes.set(localName, `${LOCAL_ROUTE_PREFIX}${pathProperty.initializer.text}`)
  }

  return routes
}

const HEADER_PRIMITIVE_MODULES: Record<HeaderPrimitive, string> = {
  PageHeader: '@/components/PageHeader',
  ResourceGalleryPage: '@/components/gallery/ResourceGalleryPage',
  ResourceSplitPage: '@/components/split/ResourceSplitPage',
}

function routeSourceFile(key: string): string | null {
  const match = key.match(/^@\/routes\/([^#]+)#/)
  return match?.[1] === undefined ? null : `routes/${match[1]}.tsx`
}

/** Resolve the declared import identity and require a real JSX render. */
function sourceRendersHeaderPrimitive(ownership: HeaderOwnership): boolean {
  const absolute = resolve(import.meta.dirname, '../src', ownership.sourceFile)
  if (!existsSync(absolute)) return false
  const sourceFile = ts.createSourceFile(
    ownership.sourceFile,
    readFileSync(absolute, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const localNames = new Set<string>()

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue
    }
    if (statement.moduleSpecifier.text !== HEADER_PRIMITIVE_MODULES[ownership.primitive]) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      if ((element.propertyName?.text ?? element.name.text) === ownership.primitive) {
        localNames.add(element.name.text)
      }
    }
  }

  let rendered = false
  const visit = (node: ts.Node): void => {
    if (
      !rendered &&
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      ts.isIdentifier(node.tagName) &&
      localNames.has(node.tagName.text)
    ) {
      rendered = true
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return rendered
}

/** Parse the registered route tree without importing application modules. */
export function parseRegisteredRoutes(source: string): RegisteredRoute[] {
  const sourceFile = ts.createSourceFile(
    'router.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const imports = new Map<string, string>()
  const initializers = new Map<string, ts.Expression>()

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const bindings = statement.importClause?.namedBindings
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          imports.set(
            element.name.text,
            importedKey(
              statement.moduleSpecifier.text,
              element.propertyName?.text ?? element.name.text,
            ),
          )
        }
      }
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
          initializers.set(declaration.name.text, declaration.initializer)
        }
      }
    }
  }

  const locals = localRouteKeys(imports, initializers)
  const tree = routeTreeExpression(sourceFile, imports, initializers)
  const registered: RegisteredRoute[] = []
  const seen = new Set<string>()

  const identityFor = (identifier: ts.Identifier): string => {
    const key = imports.get(identifier.text) ?? locals.get(identifier.text)
    if (key === undefined) {
      throw new Error(
        `Registered route ${identifier.text} has no import or local createRoute identity`,
      )
    }
    return key
  }

  const add = (identifier: ts.Identifier, parentKey: string | null): string => {
    const key = identityFor(identifier)
    if (seen.has(key)) throw new Error(`Route ${key} is registered more than once`)
    seen.add(key)
    registered.push({ key, localName: identifier.text, parentKey })
    return key
  }

  type AddChildrenCall = ts.CallExpression & { expression: ts.PropertyAccessExpression }
  const isAddChildrenCall = (expression: ts.Expression): expression is AddChildrenCall =>
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === 'addChildren'

  const visitTree = (expression: ts.Expression, parentKey: string | null): void => {
    if (!isAddChildrenCall(expression)) {
      if (!ts.isIdentifier(expression)) {
        throw new Error(`Unsupported route registration: ${expression.getText(sourceFile)}`)
      }
      add(expression, parentKey)
      return
    }

    const parentExpression = expression.expression.expression
    if (!ts.isIdentifier(parentExpression)) {
      throw new Error(`addChildren parent must be an identifier: ${expression.getText(sourceFile)}`)
    }
    const routeKey = add(parentExpression, parentKey)
    const children = expression.arguments[0]
    if (children === undefined || !ts.isArrayLiteralExpression(children)) {
      throw new Error(`addChildren for ${parentExpression.text} must receive an array literal`)
    }
    for (const child of children.elements) visitTree(child, routeKey)
  }

  visitTree(tree, null)
  return registered
}

const rendered = (file: string): TestOwner => ({ file, kind: 'rendered' })
const source = (file: string): TestOwner => ({ file, kind: 'source' })

export const ROUTE_UX_INVENTORY = {
  '@/routes/__root#Route': {
    surface: 'authenticated application shell',
    classification: 'specialized',
    owners: [rendered('app-shell-layout.test.tsx')],
  },
  '@/routes/index#Route': {
    surface: '/',
    classification: 'specialized',
    owners: [rendered('index-page-routing.test.tsx')],
  },
  // RFC-211 guided tour. 'standard' because it is an ordinary page built from
  // the shared primitives (PageHeader / ChoiceCards / Stepper), which is the
  // whole point — the tour is not an overlay.
  '@/routes/onboarding#Route': {
    surface: '/onboarding',
    classification: 'standard',
    header: {
      mode: 'direct',
      sourceFile: 'routes/onboarding.tsx',
      primitive: 'PageHeader',
    },
    owners: [rendered('onboarding-guide.test.tsx')],
  },
  '@/routes/auth#Route': {
    surface: '/auth',
    classification: 'specialized',
    owners: [rendered('auth-form-tabs.test.tsx')],
  },
  '@/routes/setup.admin#Route': {
    surface: '/setup/admin',
    classification: 'specialized',
    owners: [rendered('setup-admin.test.tsx')],
  },
  '@/routes/agents#Route': {
    surface: '/agents split layout',
    classification: 'specialized',
    owners: [rendered('agents-split-page.test.tsx')],
  },
  '@/routes/agents.new#Route': {
    surface: '/agents/new',
    classification: 'standard',
    owners: [rendered('agents-split-page.test.tsx')],
    header: {
      mode: 'direct',
      sourceFile: 'routes/agents.new.tsx',
      primitive: 'PageHeader',
    },
  },
  '@/routes/agents.detail#Route': {
    surface: '/agents/$id',
    classification: 'standard',
    owners: [rendered('agents-split-page.test.tsx')],
    header: {
      mode: 'shared-layout',
      sourceFile: 'routes/agents.tsx',
      primitive: 'ResourceSplitPage',
    },
  },
  '@/routes/agents#IndexRoute': {
    surface: '/agents index',
    classification: 'standard',
    owners: [rendered('agents-split-page.test.tsx')],
    header: {
      mode: 'shared-layout',
      sourceFile: 'routes/agents.tsx',
      primitive: 'ResourceSplitPage',
    },
  },
  '@/routes/skills#Route': {
    surface: '/skills split layout',
    classification: 'specialized',
    owners: [rendered('skills-split-page.test.tsx')],
  },
  '@/routes/skills.new#Route': {
    surface: '/skills/new',
    classification: 'standard',
    owners: [rendered('skills-split-page.test.tsx')],
    header: {
      mode: 'direct',
      sourceFile: 'routes/skills.new.tsx',
      primitive: 'PageHeader',
    },
  },
  '@/routes/skills.detail#Route': {
    surface: '/skills/$id',
    classification: 'standard',
    owners: [rendered('skills-split-page.test.tsx')],
    header: {
      mode: 'shared-layout',
      sourceFile: 'routes/skills.tsx',
      primitive: 'ResourceSplitPage',
    },
  },
  '@/routes/skills#IndexRoute': {
    surface: '/skills index',
    classification: 'standard',
    owners: [rendered('skills-split-page.test.tsx')],
    header: {
      mode: 'shared-layout',
      sourceFile: 'routes/skills.tsx',
      primitive: 'ResourceSplitPage',
    },
  },
  '@/routes/mcps#Route': {
    surface: '/mcps split layout',
    classification: 'specialized',
    owners: [rendered('mcps-split-page.test.tsx')],
  },
  '@/routes/mcps.new#Route': {
    surface: '/mcps/new',
    classification: 'standard',
    owners: [rendered('mcps-split-page.test.tsx')],
    header: {
      mode: 'direct',
      sourceFile: 'routes/mcps.new.tsx',
      primitive: 'PageHeader',
    },
  },
  '@/routes/mcps.detail#Route': {
    surface: '/mcps/$id',
    classification: 'standard',
    owners: [rendered('mcps-split-page.test.tsx')],
    header: {
      mode: 'shared-layout',
      sourceFile: 'routes/mcps.tsx',
      primitive: 'ResourceSplitPage',
    },
  },
  '@/routes/mcps#IndexRoute': {
    surface: '/mcps index',
    classification: 'standard',
    owners: [rendered('mcps-split-page.test.tsx')],
    header: {
      mode: 'shared-layout',
      sourceFile: 'routes/mcps.tsx',
      primitive: 'ResourceSplitPage',
    },
  },
  '@/routes/plugins#Route': {
    surface: '/plugins split layout',
    classification: 'specialized',
    owners: [rendered('plugins-split-page.test.tsx')],
  },
  '@/routes/plugins.new#Route': {
    surface: '/plugins/new',
    classification: 'standard',
    owners: [rendered('plugins-split-page.test.tsx')],
    header: {
      mode: 'direct',
      sourceFile: 'routes/plugins.new.tsx',
      primitive: 'PageHeader',
    },
  },
  '@/routes/plugins.detail#Route': {
    surface: '/plugins/$id',
    classification: 'standard',
    owners: [rendered('plugins-split-page.test.tsx')],
    header: {
      mode: 'shared-layout',
      sourceFile: 'routes/plugins.tsx',
      primitive: 'ResourceSplitPage',
    },
  },
  '@/routes/plugins#IndexRoute': {
    surface: '/plugins index',
    classification: 'standard',
    owners: [rendered('plugins-split-page.test.tsx')],
    header: {
      mode: 'shared-layout',
      sourceFile: 'routes/plugins.tsx',
      primitive: 'ResourceSplitPage',
    },
  },
  '@/routes/workflows#NewRedirectRoute': {
    surface: '/workflows/new',
    classification: 'redirect',
    owners: [rendered('workflows-pages.test.tsx')],
  },
  [`${LOCAL_ROUTE_PREFIX}/workflows/$id/launch`]: {
    surface: '/workflows/$id/launch',
    classification: 'redirect',
    owners: [source('rfc165-retired-launcher-locks.test.ts')],
  },
  '@/routes/workflows.edit#EditRoute': {
    surface: '/workflows/$id',
    classification: 'specialized',
    owners: [source('workflows-pages.test.tsx')],
  },
  '@/routes/workflows#Route': {
    surface: '/workflows',
    classification: 'standard',
    owners: [rendered('workflows-pages.test.tsx')],
    header: {
      mode: 'shared-layout',
      sourceFile: 'routes/workflows.tsx',
      primitive: 'ResourceGalleryPage',
    },
  },
  [`${LOCAL_ROUTE_PREFIX}/workgroups/launch`]: {
    surface: '/workgroups/launch',
    classification: 'redirect',
    owners: [source('rfc165-retired-launcher-locks.test.ts')],
  },
  '@/routes/workgroups.detail#Route': {
    surface: '/workgroups/$id',
    classification: 'specialized',
    owners: [rendered('workgroups-pages.test.tsx')],
  },
  '@/routes/workgroups#Route': {
    surface: '/workgroups',
    classification: 'standard',
    owners: [rendered('workgroups-pages.test.tsx')],
    header: {
      mode: 'shared-layout',
      sourceFile: 'routes/workgroups.tsx',
      primitive: 'ResourceGalleryPage',
    },
  },
  '@/routes/tasks.preview#Route': {
    surface: '/tasks/$id/preview',
    classification: 'specialized',
    owners: [rendered('task-markdown-preview-route.test.tsx')],
  },
  '@/routes/tasks.detail#Route': {
    surface: '/tasks/$id',
    classification: 'specialized',
    owners: [rendered('task-detail-route-history.test.tsx')],
  },
  '@/routes/tasks#Route': {
    surface: '/tasks',
    classification: 'standard',
    owners: [rendered('tasks-list-surgery.test.tsx')],
    header: { mode: 'direct', sourceFile: 'routes/tasks.tsx', primitive: 'PageHeader' },
  },
  '@/routes/tasks.new#TaskWizardRoute': {
    surface: '/tasks/new',
    classification: 'specialized',
    owners: [rendered('tasks-new-wizard.test.tsx')],
  },
  '@/routes/scheduled.$id#Route': {
    surface: '/scheduled/$id',
    classification: 'standard',
    owners: [rendered('scheduled-detail-style.test.tsx')],
    header: {
      mode: 'direct',
      sourceFile: 'routes/scheduled.$id.tsx',
      primitive: 'PageHeader',
    },
  },
  '@/routes/scheduled#Route': {
    surface: '/scheduled',
    classification: 'standard',
    owners: [rendered('scheduled-list-inline.test.tsx')],
    header: { mode: 'direct', sourceFile: 'routes/scheduled.tsx', primitive: 'PageHeader' },
  },
  '@/routes/reviews.detail#Route': {
    surface: '/reviews/$nodeRunId',
    classification: 'specialized',
    owners: [rendered('review-detail-query-continuity.test.tsx')],
  },
  '@/routes/reviews#Route': {
    surface: '/reviews',
    classification: 'standard',
    owners: [rendered('reviews-list-filter.test.tsx')],
    header: { mode: 'direct', sourceFile: 'routes/reviews.tsx', primitive: 'PageHeader' },
  },
  '@/routes/clarify.detail#Route': {
    surface: '/clarify/$nodeRunId',
    classification: 'specialized',
    owners: [rendered('clarify-detail-route.test.tsx')],
  },
  '@/routes/clarify#Route': {
    surface: '/clarify',
    classification: 'standard',
    owners: [rendered('clarify-list-route.test.tsx')],
    header: { mode: 'direct', sourceFile: 'routes/clarify.tsx', primitive: 'PageHeader' },
  },
  '@/routes/repos#ReposRoute': {
    surface: '/repos',
    classification: 'standard',
    owners: [source('repos-page.test.tsx')],
    header: { mode: 'direct', sourceFile: 'routes/repos.tsx', primitive: 'PageHeader' },
  },
  '@/routes/memory.distill-jobs.$jobId#Route': {
    surface: '/memory/distill-jobs/$jobId',
    classification: 'specialized',
    owners: [rendered('distill-job-detail-route.test.tsx')],
  },
  '@/routes/memory#Route': {
    surface: '/memory',
    classification: 'specialized',
    owners: [rendered('memory-page-new-button.test.tsx')],
  },
  '@/routes/fusions.detail#Route': {
    surface: '/fusions/$id',
    classification: 'specialized',
    owners: [source('fusion-detail-ux.test.ts')],
  },
  '@/routes/settings#Route': {
    surface: '/settings',
    classification: 'standard',
    owners: [rendered('settings-route-history.test.tsx')],
    header: { mode: 'direct', sourceFile: 'routes/settings.tsx', primitive: 'PageHeader' },
  },
  '@/routes/account#Route': {
    surface: '/account',
    classification: 'standard',
    owners: [rendered('account-query-continuity.test.tsx')],
    header: { mode: 'direct', sourceFile: 'routes/account.tsx', primitive: 'PageHeader' },
  },
  '@/routes/users#Route': {
    surface: '/users',
    classification: 'standard',
    owners: [rendered('users-page-actions.test.tsx')],
    header: { mode: 'direct', sourceFile: 'routes/users.tsx', primitive: 'PageHeader' },
  },
} as const satisfies Record<string, RouteInventoryEntry>

describe('route UX inventory parser', () => {
  test('resolves aliased imports, nested children, and local redirects by stable identity', () => {
    const sourceText = `
      import {
        createRoute as makeRoute,
        createRouter as makeRouter,
      } from '@tanstack/react-router'
      import { Route as shellAlias } from '@/routes/__root'
      import { Route as layoutAlias, IndexRoute as indexAlias } from '@/routes/example'

      const legacyAlias = makeRoute({
        getParentRoute: () => shellAlias,
        path: '/legacy',
      })
      const renamedTree = shellAlias.addChildren([
        layoutAlias.addChildren([indexAlias]),
        legacyAlias,
      ])
      export const app = makeRouter({ routeTree: renamedTree })
    `

    expect(parseRegisteredRoutes(sourceText)).toEqual([
      { key: '@/routes/__root#Route', localName: 'shellAlias', parentKey: null },
      {
        key: '@/routes/example#Route',
        localName: 'layoutAlias',
        parentKey: '@/routes/__root#Route',
      },
      {
        key: '@/routes/example#IndexRoute',
        localName: 'indexAlias',
        parentKey: '@/routes/example#Route',
      },
      {
        key: `${LOCAL_ROUTE_PREFIX}/legacy`,
        localName: 'legacyAlias',
        parentKey: '@/routes/__root#Route',
      },
    ])
  })

  test('rejects an opaque registration instead of silently dropping it from coverage', () => {
    const sourceText = `
      import { createRouter, Route as rootRoute } from '@tanstack/react-router'
      const routeTree = rootRoute.addChildren([buildRoutes()])
      createRouter({ routeTree })
    `
    expect(() => parseRegisteredRoutes(sourceText)).toThrow('Unsupported route registration')
  })
})

describe('RFC-198 all-interface route UX inventory', () => {
  const routerSource = readFileSync(resolve(import.meta.dirname, '../src/router.tsx'), 'utf8')
  const registered = parseRegisteredRoutes(routerSource)
  const actualKeys = new Set(registered.map((route) => route.key))
  const manifestKeys = new Set(Object.keys(ROUTE_UX_INVENTORY))

  test('is a two-way ratchet against every registered root and nested route', () => {
    const unmanifested = [...actualKeys].filter((key) => !manifestKeys.has(key)).sort()
    const staleManifestEntries = [...manifestKeys].filter((key) => !actualKeys.has(key)).sort()

    expect({ unmanifested, staleManifestEntries }).toEqual({
      unmanifested: [],
      staleManifestEntries: [],
    })
  })

  test('assigns every route exactly one supported classification and an existing test owner', () => {
    const supported = new Set<RouteClassification>([
      'standard',
      'specialized',
      'redirect',
      'resolver',
    ])

    for (const [key, entry] of Object.entries(ROUTE_UX_INVENTORY)) {
      expect(supported.has(entry.classification), `${key} classification`).toBe(true)
      expect(entry.owners.length, `${key} test owners`).toBeGreaterThan(0)
      for (const owner of entry.owners) {
        expect(['rendered', 'source'], `${key} owner kind`).toContain(owner.kind)
        expect(
          existsSync(resolve(import.meta.dirname, owner.file)),
          `${key} owner does not exist: ${owner.file}`,
        ).toBe(true)
      }
    }
  })

  test('all UI routes have a declared UX test owner', () => {
    const missingUiOwners = Object.entries(ROUTE_UX_INVENTORY)
      .filter(([, entry]) => ['standard', 'specialized'].includes(entry.classification))
      .filter(([, entry]) => (entry.owners as readonly TestOwner[]).length === 0)
      .map(([key]) => key)

    expect(missingUiOwners).toEqual([])
  })

  test('every standard route proves direct or shared-layout PageHeader ownership in production JSX', () => {
    const registeredByKey = new Map(registered.map((route) => [route.key, route]))

    for (const [key, rawEntry] of Object.entries(ROUTE_UX_INVENTORY)) {
      const entry = rawEntry as RouteInventoryEntry
      if (entry.classification !== 'standard') continue
      const route = registeredByKey.get(key)
      if (route === undefined) {
        throw new Error(`${key} (${entry.surface}) is not registered`)
      }
      const header = (entry as { header?: HeaderOwnership }).header
      if (header === undefined) {
        throw new Error(`${key} (${entry.surface}) is standard but has no header ownership`)
      }
      const ownSource = routeSourceFile(key)
      if (ownSource === null) {
        throw new Error(`${key} (${entry.surface}) has no auditable route source file`)
      }

      const allowedSources = new Set([ownSource])
      if (header.mode === 'shared-layout' && route.parentKey !== null) {
        const parentSource = routeSourceFile(route.parentKey)
        if (parentSource !== null) allowedSources.add(parentSource)
      }
      if (!allowedSources.has(header.sourceFile)) {
        throw new Error(
          `${key} (${entry.surface}) declares header owner ${header.sourceFile}; expected its route or registered parent: ${[...allowedSources].join(', ')}`,
        )
      }
      if (!sourceRendersHeaderPrimitive(header)) {
        throw new Error(
          `${key} (${entry.surface}) header owner ${header.sourceFile} does not render imported ${header.primitive}`,
        )
      }
    }
  })
})
