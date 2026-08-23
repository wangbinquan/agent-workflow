// RFC-294 W0-R architecture preflight.
//
// Why this file exists: dependency-cruiser currently proves that first-party
// edges resolve and catches a small legacy rule set, but a refactor can still
// hide a cross-context deep import behind `import type`, `import()`, a dynamic
// import, or a re-export. It also cannot see a public type leaking an adapter,
// a structurally forged authority/capability, or a mega-port hidden below one
// `payload` field. These AST ratchets lock the target contracts before files
// start moving. Exact current debts are listed separately and must only shrink.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { posix, relative, resolve } from 'node:path'

import ts from 'typescript'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const MODULES_ROOT = resolve(REPO_ROOT, 'packages', 'backend', 'src', 'modules')

const PUBLIC_ENTRYPOINTS = new Set(['commands', 'queries', 'participants', 'events', 'types'])
const TYPE_ONLY_ENTRYPOINTS = new Set(['participants', 'events', 'types'])
const SENSITIVE_TYPE = /(?:Actor|Authority|Capability|Claim|Token|WorkerIdentity|Tx)(?:V\d+)?$/
const FORBIDDEN_TYPE_NAME = new Set([
  'AbortController',
  'AppDeps',
  'BigInt',
  'Buffer',
  'Date',
  'DbClient',
  'Error',
  'Function',
  'Hono',
  'Map',
  'Process',
  'SecretBox',
  'Set',
  'WeakMap',
  'WeakSet',
])
const FORBIDDEN_TYPE_IMPORT =
  /^(?:@\/(?:auth|cli|config|db|mcp|routes|server|services|util|ws)(?:\/|$)|drizzle-orm(?:\/|$)|hono(?:\/|$)|node:(?:child_process|fs|path|process)(?:\/|$)|(?:fs|path|process)$)/

interface SourceUnit {
  path: string
  text: string
  source: ts.SourceFile
}

interface ModuleLocation {
  context: string
  rest: string
}

type EdgeKind = 'type' | 'value'

interface ImportEdge {
  from: SourceUnit
  specifier: string
  kind: EdgeKind
  syntax: 'dynamic-import' | 'export' | 'import-type' | 'require' | 'static-import'
}

interface ImportBinding {
  importedName: string
  specifier: string
}

interface SurfaceRoot {
  unit: SourceUnit
  declaration: ts.Declaration
  symbol: string
}

interface ShapeBudget {
  maxMethods: number
  maxTopLevelFields: number
  maxTransitiveLeaves: number
  maxUnionVariants: number
}

interface ShapeStats {
  methods: number
  topLevelFields: number
  transitiveLeaves: number
  unionVariants: number
}

const DEFAULT_SHAPE_BUDGET: ShapeBudget = {
  maxMethods: 5,
  maxTopLevelFields: 12,
  maxTransitiveLeaves: 24,
  maxUnionVariants: 12,
}

function portable(path: string): string {
  return path.replaceAll('\\', '/')
}

function sourceUnit(path: string, text: string): SourceUnit {
  const portablePath = portable(path)
  return {
    path: portablePath,
    text,
    source: ts.createSourceFile(
      portablePath,
      text,
      ts.ScriptTarget.Latest,
      true,
      portablePath.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    ),
  }
}

function sourceUnits(files: Record<string, string>): SourceUnit[] {
  return Object.entries(files)
    .map(([path, text]) => sourceUnit(path, text))
    .sort((left, right) => left.path.localeCompare(right.path))
}

function productionModuleUnits(): SourceUnit[] {
  const files: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && /\.[cm]?tsx?$/.test(entry.name)) files.push(path)
    }
  }
  visit(MODULES_ROOT)
  return files
    .sort()
    .map((path) => sourceUnit(portable(relative(REPO_ROOT, path)), readFileSync(path, 'utf8')))
}

function withoutTsExtension(path: string): string {
  return path.replace(/\.[cm]?[jt]sx?$/, '')
}

function moduleLocation(path: string): ModuleLocation | null {
  const normalized = withoutTsExtension(portable(path))
  const marker = '/modules/'
  const markerIndex = normalized.lastIndexOf(marker)
  const tail = markerIndex >= 0 ? normalized.slice(markerIndex + marker.length) : normalized
  const parts = tail.split('/')
  if (parts.length < 2 || tail === normalized) return null
  return { context: parts[0]!, rest: parts.slice(1).join('/') }
}

function canonicalModulePath(path: string): string {
  const location = moduleLocation(path)
  return location === null ? portable(path) : `modules/${location.context}/${location.rest}.ts`
}

function literalSpecifier(node: ts.Expression | ts.TypeNode): string | null {
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteralLike(node.literal)) return node.literal.text
  return null
}

function importEdges(unit: SourceUnit): ImportEdge[] {
  const edges: ImportEdge[] = []
  const add = (specifier: string, kind: EdgeKind, syntax: ImportEdge['syntax']): void => {
    edges.push({ from: unit, specifier, kind, syntax })
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.importClause
      if (clause === undefined) {
        add(node.moduleSpecifier.text, 'value', 'static-import')
      } else {
        if (clause.name !== undefined) {
          add(node.moduleSpecifier.text, clause.isTypeOnly ? 'type' : 'value', 'static-import')
        }
        const bindings = clause.namedBindings
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
          add(node.moduleSpecifier.text, clause.isTypeOnly ? 'type' : 'value', 'static-import')
        } else if (bindings !== undefined) {
          for (const element of bindings.elements) {
            add(
              node.moduleSpecifier.text,
              clause.isTypeOnly || element.isTypeOnly ? 'type' : 'value',
              'static-import',
            )
          }
        }
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      const specifier = literalSpecifier(node.moduleSpecifier)
      if (specifier !== null) {
        if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
          for (const element of node.exportClause.elements) {
            add(specifier, node.isTypeOnly || element.isTypeOnly ? 'type' : 'value', 'export')
          }
        } else {
          add(specifier, node.isTypeOnly ? 'type' : 'value', 'export')
        }
      }
    } else if (ts.isImportTypeNode(node)) {
      const specifier = literalSpecifier(node.argument)
      if (specifier !== null) add(specifier, 'type', 'import-type')
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const specifier = literalSpecifier(node.arguments[0]!)
      if (specifier !== null) {
        add(
          specifier,
          'value',
          node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic-import' : 'require',
        )
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(unit.source)

  const seen = new Set<string>()
  return edges.filter((edge) => {
    const key = `${edge.specifier}|${edge.kind}|${edge.syntax}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function targetLocation(edge: ImportEdge): ModuleLocation | null {
  if (edge.specifier.startsWith('@/modules/')) {
    return moduleLocation(`/modules/${edge.specifier.slice('@/modules/'.length)}`)
  }
  if (!edge.specifier.startsWith('.')) return null
  return moduleLocation(posix.normalize(posix.join(posix.dirname(edge.from.path), edge.specifier)))
}

function crossContextViolations(units: readonly SourceUnit[]): string[] {
  const violations = new Set<string>()
  for (const unit of units) {
    const from = moduleLocation(unit.path)
    if (from === null) continue
    for (const edge of importEdges(unit)) {
      const target = targetLocation(edge)
      if (target === null || target.context === from.context) continue

      const publicMatch = /^public\/([^/]+)$/.exec(target.rest)
      const exactPublic = publicMatch?.[1]
      const allowedPublic = exactPublic !== undefined && PUBLIC_ENTRYPOINTS.has(exactPublic)
      const allowedTypeEntrypoint =
        edge.kind === 'value' ||
        (exactPublic !== undefined && TYPE_ONLY_ENTRYPOINTS.has(exactPublic))
      const requiredPortAdapter =
        target.rest === 'composition/required-ports' &&
        edge.kind === 'type' &&
        /^application\/adapters\/[^/]+-adapter$/.test(from.rest)

      if ((allowedPublic && allowedTypeEntrypoint) || requiredPortAdapter) continue
      const reason = allowedPublic
        ? 'type-only edge targets commands/queries'
        : 'cross-context internal import'
      violations.add(
        `${canonicalModulePath(unit.path)} -> modules/${target.context}/${target.rest}.ts ` +
          `[${edge.kind}:${edge.syntax}] ${reason}`,
      )
    }
  }
  return [...violations].sort()
}

function resolveUnit(
  units: readonly SourceUnit[],
  fromPath: string,
  specifier: string,
): SourceUnit | undefined {
  let candidate: string | null = null
  if (specifier.startsWith('@/')) {
    candidate = `packages/backend/src/${specifier.slice(2)}`
  } else if (specifier.startsWith('.')) {
    candidate = posix.normalize(posix.join(posix.dirname(fromPath), specifier))
  }
  if (candidate === null) return undefined
  const attempts = [candidate, `${candidate}.ts`, `${candidate}.tsx`, `${candidate}/index.ts`].map(
    portable,
  )
  return units.find(
    (unit) =>
      attempts.includes(unit.path) || attempts.some((attempt) => unit.path.endsWith(`/${attempt}`)),
  )
}

function importBindings(unit: SourceUnit): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>()
  for (const statement of unit.source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
      continue
    }
    const clause = statement.importClause
    if (clause?.name !== undefined) {
      bindings.set(clause.name.text, {
        importedName: 'default',
        specifier: statement.moduleSpecifier.text,
      })
    }
    if (clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        bindings.set(element.name.text, {
          importedName: element.propertyName?.text ?? element.name.text,
          specifier: statement.moduleSpecifier.text,
        })
      }
    } else if (clause?.namedBindings !== undefined) {
      bindings.set(clause.namedBindings.name.text, {
        importedName: '*',
        specifier: statement.moduleSpecifier.text,
      })
    }
  }
  return bindings
}

function namedDeclarations(unit: SourceUnit): Map<string, ts.Declaration> {
  const declarations = new Map<string, ts.Declaration>()
  for (const statement of unit.source.statements) {
    if (
      (ts.isTypeAliasDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name !== undefined
    ) {
      declarations.set(statement.name.text, statement)
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, declaration)
      }
    }
  }
  return declarations
}

function resolveNamedDeclaration(
  units: readonly SourceUnit[],
  unit: SourceUnit,
  name: string,
  seen = new Set<string>(),
): { unit: SourceUnit; declaration: ts.Declaration } | undefined {
  const key = `${unit.path}#${name}`
  if (seen.has(key)) return undefined
  seen.add(key)

  const local = namedDeclarations(unit).get(name)
  if (local !== undefined) return { unit, declaration: local }

  const binding = importBindings(unit).get(name)
  if (binding !== undefined && binding.importedName !== '*') {
    const target = resolveUnit(units, unit.path, binding.specifier)
    if (target !== undefined) {
      const resolved = resolveNamedDeclaration(units, target, binding.importedName, seen)
      if (resolved !== undefined) return resolved
    }
  }

  for (const statement of unit.source.statements) {
    if (!ts.isExportDeclaration(statement)) continue
    if (statement.exportClause === undefined && statement.moduleSpecifier !== undefined) {
      const target = resolveUnit(
        units,
        unit.path,
        literalSpecifier(statement.moduleSpecifier) ?? '',
      )
      if (target !== undefined) {
        const resolved = resolveNamedDeclaration(units, target, name, seen)
        if (resolved !== undefined) return resolved
      }
      continue
    }
    if (statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause)) continue
    for (const element of statement.exportClause.elements) {
      if (element.name.text !== name) continue
      const target =
        statement.moduleSpecifier === undefined
          ? unit
          : resolveUnit(units, unit.path, literalSpecifier(statement.moduleSpecifier) ?? '')
      if (target === undefined) continue
      const resolved = resolveNamedDeclaration(
        units,
        target,
        element.propertyName?.text ?? element.name.text,
        seen,
      )
      if (resolved !== undefined) return resolved
    }
  }
  return undefined
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
      false)
  )
}

function publicSurfaceRoots(units: readonly SourceUnit[]): SurfaceRoot[] {
  const roots: SurfaceRoot[] = []
  for (const unit of units) {
    const location = moduleLocation(unit.path)
    if (location === null || !location.rest.startsWith('public/')) continue
    for (const statement of unit.source.statements) {
      if (hasExportModifier(statement)) {
        if (
          ts.isTypeAliasDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) ||
          ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isEnumDeclaration(statement)
        ) {
          if (statement.name !== undefined) {
            roots.push({ unit, declaration: statement, symbol: statement.name.text })
          }
        } else if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name)) {
              roots.push({ unit, declaration, symbol: declaration.name.text })
            }
          }
        }
      }
      if (
        ts.isExportDeclaration(statement) &&
        statement.exportClause !== undefined &&
        ts.isNamedExports(statement.exportClause)
      ) {
        const target =
          statement.moduleSpecifier === undefined
            ? unit
            : resolveUnit(units, unit.path, literalSpecifier(statement.moduleSpecifier) ?? '')
        if (target === undefined) continue
        for (const element of statement.exportClause.elements) {
          const importedName = element.propertyName?.text ?? element.name.text
          const resolved = resolveNamedDeclaration(units, target, importedName)
          if (resolved !== undefined) {
            roots.push({
              unit: resolved.unit,
              declaration: resolved.declaration,
              symbol: element.name.text,
            })
          }
        }
      }
    }
  }
  return roots
}

function declarationTypeNodes(declaration: ts.Declaration): ts.TypeNode[] {
  if (ts.isTypeAliasDeclaration(declaration)) return [declaration.type]
  if (ts.isInterfaceDeclaration(declaration)) {
    return [
      ...(declaration.heritageClauses ?? []).flatMap((clause) => clause.types),
      ...declaration.members.flatMap((member) => {
        if (ts.isCallSignatureDeclaration(member) || ts.isMethodSignature(member)) {
          return [
            ...member.parameters.flatMap((parameter) => (parameter.type ? [parameter.type] : [])),
            ...(member.type ? [member.type] : []),
          ]
        }
        if (ts.isPropertySignature(member) || ts.isIndexSignatureDeclaration(member)) {
          return member.type ? [member.type] : []
        }
        if (ts.isConstructSignatureDeclaration(member)) {
          return [
            ...member.parameters.flatMap((parameter) => (parameter.type ? [parameter.type] : [])),
            ...(member.type ? [member.type] : []),
          ]
        }
        return []
      }),
    ]
  }
  if (ts.isFunctionDeclaration(declaration)) {
    return [
      ...declaration.parameters.flatMap((parameter) => (parameter.type ? [parameter.type] : [])),
      ...(declaration.type ? [declaration.type] : []),
    ]
  }
  if (ts.isVariableDeclaration(declaration)) return declaration.type ? [declaration.type] : []
  if (ts.isClassDeclaration(declaration)) {
    return declaration.members.flatMap((member) => {
      if (ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member)) {
        return [
          ...('parameters' in member
            ? member.parameters.flatMap((parameter) => (parameter.type ? [parameter.type] : []))
            : []),
          ...(member.type ? [member.type] : []),
        ]
      }
      return []
    })
  }
  return []
}

function publicSurfaceViolations(units: readonly SourceUnit[]): string[] {
  const violations = new Set<string>()
  const declarationIndexes = new Map(units.map((unit) => [unit.path, namedDeclarations(unit)]))
  const bindingIndexes = new Map(units.map((unit) => [unit.path, importBindings(unit)]))
  const visitedDeclarations = new Set<string>()

  for (const unit of units) {
    const location = moduleLocation(unit.path)
    if (location === null || !location.rest.startsWith('public/')) continue
    if (!/^public\/(commands|queries|participants|events|types)$/.test(location.rest)) {
      violations.add(`${canonicalModulePath(unit.path)}: non-exact public entrypoint`)
    }
    for (const statement of unit.source.statements) {
      if (
        ts.isExportDeclaration(statement) &&
        (statement.exportClause === undefined || ts.isNamespaceExport(statement.exportClause))
      ) {
        violations.add(`${canonicalModulePath(unit.path)}: export * is forbidden`)
      }
      if (
        ts.isExportAssignment(statement) ||
        (hasExportModifier(statement) &&
          ts.canHaveModifiers(statement) &&
          (ts
            .getModifiers(statement)
            ?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ??
            false))
      ) {
        violations.add(`${canonicalModulePath(unit.path)}: default export is forbidden`)
      }
    }
  }

  const visitDeclaration = (unit: SourceUnit, declaration: ts.Declaration, chain: string): void => {
    const key = `${unit.path}:${declaration.pos}:${declaration.end}`
    if (visitedDeclarations.has(key)) return
    visitedDeclarations.add(key)

    const bindings = bindingIndexes.get(unit.path) ?? new Map()
    const localDeclarations = declarationIndexes.get(unit.path) ?? new Map()
    const visitType = (node: ts.Node): void => {
      if (
        node.kind === ts.SyntaxKind.AnyKeyword ||
        node.kind === ts.SyntaxKind.UnknownKeyword ||
        node.kind === ts.SyntaxKind.ObjectKeyword ||
        ts.isFunctionTypeNode(node) ||
        ts.isConstructorTypeNode(node) ||
        ts.isTypeQueryNode(node) ||
        ts.isMappedTypeNode(node) ||
        ts.isIndexSignatureDeclaration(node)
      ) {
        violations.add(`${chain}: unsafe/open type ${ts.SyntaxKind[node.kind]}`)
      }
      if (ts.isImportTypeNode(node)) {
        const specifier = literalSpecifier(node.argument)
        if (specifier !== null && FORBIDDEN_TYPE_IMPORT.test(specifier)) {
          violations.add(`${chain}: forbidden type import ${specifier}`)
        } else if (specifier !== null && node.qualifier !== undefined) {
          const target = resolveUnit(units, unit.path, specifier)
          const importedName = ts.isIdentifier(node.qualifier)
            ? node.qualifier.text
            : node.qualifier.right.text
          const resolved = target ? resolveNamedDeclaration(units, target, importedName) : undefined
          if (resolved !== undefined) {
            visitDeclaration(resolved.unit, resolved.declaration, chain)
          }
        }
      }
      if (ts.isTypeReferenceNode(node)) {
        let rootName = node.typeName
        while (ts.isQualifiedName(rootName)) rootName = rootName.left
        const localName = rootName.text
        const name = ts.isIdentifier(node.typeName) ? node.typeName.text : node.typeName.right.text
        if (FORBIDDEN_TYPE_NAME.has(name) || name === 'Partial') {
          violations.add(`${chain}: forbidden type ${name}`)
        }
        const binding = bindings.get(localName)
        if (binding !== undefined) {
          if (FORBIDDEN_TYPE_IMPORT.test(binding.specifier)) {
            violations.add(
              `${chain}: forbidden type import ${binding.specifier}#${binding.importedName === '*' ? name : binding.importedName}`,
            )
          } else {
            const target = resolveUnit(units, unit.path, binding.specifier)
            const resolved = target
              ? resolveNamedDeclaration(
                  units,
                  target,
                  binding.importedName === '*' ? name : binding.importedName,
                )
              : undefined
            if (resolved !== undefined) {
              visitDeclaration(resolved.unit, resolved.declaration, chain)
            }
          }
        } else {
          const local = localDeclarations.get(name)
          if (local !== undefined && local !== declaration) visitDeclaration(unit, local, chain)
        }
      }
      ts.forEachChild(node, visitType)
    }
    for (const typeNode of declarationTypeNodes(declaration)) visitType(typeNode)
  }

  for (const root of publicSurfaceRoots(units)) {
    visitDeclaration(
      root.unit,
      root.declaration,
      `${canonicalModulePath(root.unit.path)}#${root.symbol}`,
    )
  }
  return [...violations].sort()
}

function typeNames(node: ts.TypeNode | undefined): string[] {
  if (node === undefined) return []
  const names = new Set<string>()
  const visit = (child: ts.Node): void => {
    if (ts.isTypeReferenceNode(child)) {
      names.add(ts.isIdentifier(child.typeName) ? child.typeName.text : child.typeName.right.text)
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
  return [...names]
}

function containsSensitiveTypeName(
  units: readonly SourceUnit[],
  unit: SourceUnit,
  node: ts.TypeNode | undefined,
  seen = new Set<string>(),
): string | undefined {
  if (node === undefined) return undefined
  const direct = typeNames(node).find((name) => SENSITIVE_TYPE.test(name))
  if (direct !== undefined) return direct

  let found: string | undefined
  const visit = (child: ts.Node): void => {
    if (found !== undefined) return
    if (ts.isTypeReferenceNode(child)) {
      const target = declarationForTypeReference(units, unit, child)
      if (target !== undefined) {
        const key = `${target.unit.path}:${target.declaration.pos}`
        if (!seen.has(key)) {
          seen.add(key)
          const declarationNameNode = ts.getNameOfDeclaration(target.declaration)
          const declarationName =
            declarationNameNode !== undefined && ts.isIdentifier(declarationNameNode)
              ? declarationNameNode.text
              : undefined
          if (declarationName !== undefined && SENSITIVE_TYPE.test(declarationName)) {
            found = declarationName
            return
          }
          for (const typeNode of declarationTypeNodes(target.declaration)) {
            found = containsSensitiveTypeName(units, target.unit, typeNode, seen)
            if (found !== undefined) return
          }
        }
      }
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

function sensitiveIdentityName(
  units: readonly SourceUnit[],
  unit: SourceUnit,
  node: ts.TypeNode | undefined,
  seen = new Set<string>(),
): string | undefined {
  if (node === undefined) return undefined
  if (ts.isTypeReferenceNode(node)) {
    const name = ts.isIdentifier(node.typeName) ? node.typeName.text : node.typeName.right.text
    const target = declarationForTypeReference(units, unit, node)
    if (target !== undefined) {
      const key = `${target.unit.path}:${target.declaration.pos}`
      if (seen.has(key)) return undefined
      seen.add(key)
      const declarationNameNode = ts.getNameOfDeclaration(target.declaration)
      if (
        declarationNameNode !== undefined &&
        ts.isIdentifier(declarationNameNode) &&
        SENSITIVE_TYPE.test(declarationNameNode.text)
      ) {
        if (ts.isTypeAliasDeclaration(target.declaration)) {
          const underlying = sensitiveIdentityName(
            units,
            target.unit,
            target.declaration.type,
            seen,
          )
          if (underlying !== undefined) return underlying
        }
        return declarationNameNode.text
      }
      if (ts.isTypeAliasDeclaration(target.declaration)) {
        return sensitiveIdentityName(units, target.unit, target.declaration.type, seen)
      }
    }
    if (SENSITIVE_TYPE.test(name)) return name
    for (const argument of node.typeArguments ?? []) {
      const sensitive = sensitiveIdentityName(units, unit, argument, seen)
      if (sensitive !== undefined) return sensitive
    }
    return undefined
  }
  if (ts.isParenthesizedTypeNode(node) || ts.isTypeOperatorNode(node)) {
    return sensitiveIdentityName(units, unit, node.type, seen)
  }
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    for (const member of node.types) {
      const sensitive = sensitiveIdentityName(units, unit, member, seen)
      if (sensitive !== undefined) return sensitive
    }
  }
  return undefined
}

function isRuntimeFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  )
}

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  let current: ts.Node | undefined = node.parent
  while (current !== undefined) {
    if (isRuntimeFunctionLike(current)) return current
    current = current.parent
  }
  return undefined
}

function functionName(node: ts.FunctionLikeDeclaration): string | undefined {
  if ('name' in node && node.name !== undefined && ts.isIdentifier(node.name)) return node.name.text
  return undefined
}

function functionReturnType(node: ts.FunctionLikeDeclaration): ts.TypeNode | undefined {
  return 'type' in node ? node.type : undefined
}

function capabilityForgeViolations(units: readonly SourceUnit[]): string[] {
  const violations = new Set<string>()
  const sensitiveOwners = new Map<string, string>()
  const authorizedFactories = new Map<string, Set<ts.FunctionLikeDeclaration>>()

  for (const unit of units) {
    const location = moduleLocation(unit.path)
    if (location === null) continue
    const uniqueSymbols = new Set<string>()
    for (const statement of unit.source.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.type !== undefined &&
            declaration.type.getText(unit.source) === 'unique symbol'
          ) {
            uniqueSymbols.add(declaration.name.text)
          }
        }
      }
    }
    for (const statement of unit.source.statements) {
      const entrypoint = /^public\/([^/]+)$/.exec(location.rest)?.[1]
      if (
        (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) &&
        SENSITIVE_TYPE.test(statement.name.text) &&
        entrypoint === 'participants'
      ) {
        const key = `${location.context}:${statement.name.text}`
        sensitiveOwners.set(key, unit.path)
        const text = statement.getText(unit.source)
        const branded = [...uniqueSymbols].some((brand) => text.includes(`[${brand}]`))
        if (!branded)
          violations.add(
            `${canonicalModulePath(unit.path)}#${statement.name.text}: missing private brand`,
          )
        if (!/\bReadonly\s*</.test(text) && !/\breadonly\b/.test(text)) {
          violations.add(`${canonicalModulePath(unit.path)}#${statement.name.text}: not readonly`)
        }
      }
    }
  }

  for (const unit of units) {
    const location = moduleLocation(unit.path)
    const entrypoint = location === null ? undefined : /^public\/([^/]+)$/.exec(location.rest)?.[1]
    if (entrypoint !== 'events' && entrypoint !== 'types') continue
    const declarations: ts.Declaration[] = []
    for (const statement of unit.source.statements) {
      if (
        hasExportModifier(statement) &&
        (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement))
      ) {
        declarations.push(statement)
      } else if (
        ts.isExportDeclaration(statement) &&
        statement.exportClause !== undefined &&
        ts.isNamedExports(statement.exportClause)
      ) {
        const target =
          statement.moduleSpecifier === undefined
            ? unit
            : resolveUnit(units, unit.path, literalSpecifier(statement.moduleSpecifier) ?? '')
        if (target === undefined) continue
        for (const element of statement.exportClause.elements) {
          const resolved = resolveNamedDeclaration(
            units,
            target,
            element.propertyName?.text ?? element.name.text,
          )
          if (resolved !== undefined) declarations.push(resolved.declaration)
        }
      }
    }
    for (const declaration of declarations) {
      const sensitive = declarationTypeNodes(declaration)
        .map((node) => containsSensitiveTypeName(units, unit, node))
        .find((name) => name !== undefined)
      if (sensitive !== undefined) {
        violations.add(
          `${canonicalModulePath(unit.path)}: ${sensitive} leaks through public/${entrypoint}`,
        )
      }
    }
  }

  for (const unit of units) {
    const location = moduleLocation(unit.path)
    if (location === null) continue
    const visitFactories = (node: ts.Node): void => {
      if (isRuntimeFunctionLike(node)) {
        const sensitive = sensitiveIdentityName(units, unit, functionReturnType(node))
        const name = functionName(node)
        if (sensitive !== undefined && name !== undefined && /^(?:create|mint)/.test(name)) {
          const ownerKey = `${location.context}:${sensitive}`
          if (!sensitiveOwners.has(ownerKey)) {
            violations.add(
              `${canonicalModulePath(unit.path)}#${name}: factory is outside capability owner`,
            )
          } else {
            const factories = authorizedFactories.get(ownerKey) ?? new Set()
            factories.add(node)
            authorizedFactories.set(ownerKey, factories)
            const body = node.body?.getText(unit.source) ?? ''
            if (!body.includes('Object.freeze')) {
              violations.add(
                `${canonicalModulePath(unit.path)}#${name}: factory does not freeze capability`,
              )
            }
            if (!/\bnew\s+Weak(?:Map|Set)\b/.test(unit.text)) {
              violations.add(
                `${canonicalModulePath(unit.path)}#${name}: no private runtime registry`,
              )
            }
          }
        }
      }
      ts.forEachChild(node, visitFactories)
    }
    visitFactories(unit.source)
  }

  for (const [ownerKey, path] of sensitiveOwners) {
    const factories = authorizedFactories.get(ownerKey)
    if (factories === undefined || factories.size === 0) {
      violations.add(
        `${canonicalModulePath(path)}#${ownerKey.split(':')[1]}: missing owner factory`,
      )
    } else if (factories.size > 1) {
      violations.add(
        `${canonicalModulePath(path)}#${ownerKey.split(':')[1]}: multiple owner factories`,
      )
    }
  }

  for (const unit of units) {
    const location = moduleLocation(unit.path)
    if (location === null) continue
    const sensitiveVariables = new Set<string>()
    const isAuthorized = (node: ts.Node, sensitive: string): boolean => {
      const fn = enclosingFunction(node)
      return (
        fn !== undefined &&
        (authorizedFactories.get(`${location.context}:${sensitive}`)?.has(fn) ?? false)
      )
    }
    const rootIdentifier = (expression: ts.Expression): ts.Identifier | undefined => {
      let current = expression
      while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
        current = current.expression
      }
      return ts.isIdentifier(current) ? current : undefined
    }
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
        const initializerType =
          ts.isVariableDeclaration(node) &&
          node.initializer !== undefined &&
          (ts.isAsExpression(node.initializer) ||
            ts.isTypeAssertionExpression(node.initializer) ||
            ts.isSatisfiesExpression(node.initializer))
            ? node.initializer.type
            : undefined
        const sensitive =
          sensitiveIdentityName(units, unit, node.type) ??
          sensitiveIdentityName(units, unit, initializerType)
        if (sensitive !== undefined && ts.isIdentifier(node.name)) {
          sensitiveVariables.add(node.name.text)
          if (
            ts.isVariableDeclaration(node) &&
            node.initializer !== undefined &&
            (ts.isObjectLiteralExpression(node.initializer) ||
              (ts.isCallExpression(node.initializer) &&
                ts.isPropertyAccessExpression(node.initializer.expression) &&
                node.initializer.expression.expression.getText(unit.source) === 'JSON' &&
                node.initializer.expression.name.text === 'parse')) &&
            !isAuthorized(node, sensitive)
          ) {
            violations.add(
              `${canonicalModulePath(unit.path)}: constructs ${sensitive} outside owner factory`,
            )
          }
        }
      }
      if (
        ts.isAsExpression(node) ||
        ts.isTypeAssertionExpression(node) ||
        ts.isSatisfiesExpression(node)
      ) {
        const sensitive = sensitiveIdentityName(units, unit, node.type)
        if (sensitive !== undefined && !isAuthorized(node, sensitive)) {
          violations.add(
            `${canonicalModulePath(unit.path)}: casts/rewraps ${sensitive} outside owner factory`,
          )
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const root = rootIdentifier(node.left)
        if (root !== undefined && sensitiveVariables.has(root.text) && node.left !== root) {
          violations.add(`${canonicalModulePath(unit.path)}: mutates sensitive ${root.text}`)
        }
      }
      if (ts.isDeleteExpression(node)) {
        const root = rootIdentifier(node.expression)
        if (root !== undefined && sensitiveVariables.has(root.text)) {
          violations.add(`${canonicalModulePath(unit.path)}: deletes from sensitive ${root.text}`)
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(unit.source) === 'JSON' &&
        node.expression.name.text === 'stringify' &&
        node.arguments.some(
          (argument) => ts.isIdentifier(argument) && sensitiveVariables.has(argument.text),
        )
      ) {
        violations.add(
          `${canonicalModulePath(unit.path)}: serializes sensitive capability/authority`,
        )
      }
      ts.forEachChild(node, visit)
    }
    visit(unit.source)
  }
  return [...violations].sort()
}

function declarationForTypeReference(
  units: readonly SourceUnit[],
  unit: SourceUnit,
  node: ts.TypeReferenceNode,
): { unit: SourceUnit; declaration: ts.Declaration } | undefined {
  let rootName = node.typeName
  while (ts.isQualifiedName(rootName)) rootName = rootName.left
  const localName = rootName.text
  const referencedName = ts.isIdentifier(node.typeName)
    ? node.typeName.text
    : node.typeName.right.text
  const binding = importBindings(unit).get(localName)
  if (binding !== undefined) {
    const target = resolveUnit(units, unit.path, binding.specifier)
    return target === undefined
      ? undefined
      : resolveNamedDeclaration(
          units,
          target,
          binding.importedName === '*' ? referencedName : binding.importedName,
        )
  }
  return resolveNamedDeclaration(units, unit, referencedName)
}

function shapeStats(
  units: readonly SourceUnit[],
  unit: SourceUnit,
  node: ts.Node,
  seen = new Set<string>(),
): ShapeStats {
  if (ts.isTypeAliasDeclaration(node)) return shapeStats(units, unit, node.type, seen)
  if (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node)) {
    const members = node.members
    let leaves = 0
    let variants = 1
    for (const member of members) {
      if (!ts.isPropertySignature(member)) continue
      if (member.type === undefined) {
        leaves++
        continue
      }
      const nested = shapeStats(units, unit, member.type, new Set(seen))
      leaves += Math.max(1, nested.transitiveLeaves)
      variants = Math.max(variants, nested.unionVariants)
    }
    return {
      methods: members.filter(
        (member) => ts.isMethodSignature(member) || ts.isCallSignatureDeclaration(member),
      ).length,
      topLevelFields: members.filter(ts.isPropertySignature).length,
      transitiveLeaves: leaves,
      unionVariants: variants,
    }
  }
  if (ts.isUnionTypeNode(node)) {
    const variants = node.types.map((type) => shapeStats(units, unit, type, new Set(seen)))
    return {
      methods: Math.max(0, ...variants.map((shape) => shape.methods)),
      topLevelFields: Math.max(0, ...variants.map((shape) => shape.topLevelFields)),
      transitiveLeaves: Math.max(0, ...variants.map((shape) => shape.transitiveLeaves)),
      unionVariants:
        node.types.length + Math.max(0, ...variants.map((shape) => shape.unionVariants - 1)),
    }
  }
  if (ts.isIntersectionTypeNode(node)) {
    const parts = node.types.map((type) => shapeStats(units, unit, type, new Set(seen)))
    return {
      methods: parts.reduce((total, shape) => total + shape.methods, 0),
      topLevelFields: parts.reduce((total, shape) => total + shape.topLevelFields, 0),
      transitiveLeaves: parts.reduce((total, shape) => total + shape.transitiveLeaves, 0),
      unionVariants: Math.max(1, ...parts.map((shape) => shape.unionVariants)),
    }
  }
  if (ts.isTypeReferenceNode(node)) {
    const name = ts.isIdentifier(node.typeName) ? node.typeName.text : node.typeName.right.text
    if (
      ['Array', 'Promise', 'Readonly', 'ReadonlyArray'].includes(name) &&
      node.typeArguments?.[0]
    ) {
      return shapeStats(units, unit, node.typeArguments[0], seen)
    }
    const target = declarationForTypeReference(units, unit, node)
    if (target !== undefined) {
      const key = `${target.unit.path}:${target.declaration.pos}`
      if (!seen.has(key)) {
        seen.add(key)
        return shapeStats(units, target.unit, target.declaration, seen)
      }
    }
  }
  return { methods: 0, topLevelFields: 0, transitiveLeaves: 1, unionVariants: 1 }
}

function godSurfaceViolations(
  units: readonly SourceUnit[],
  budget: ShapeBudget = DEFAULT_SHAPE_BUDGET,
): string[] {
  const violations = new Set<string>()
  for (const root of publicSurfaceRoots(units)) {
    const stats = shapeStats(units, root.unit, root.declaration)
    const label = `${canonicalModulePath(root.unit.path)}#${root.symbol}`
    if (stats.methods > budget.maxMethods) violations.add(`${label}: ${stats.methods} methods`)
    if (stats.topLevelFields > budget.maxTopLevelFields) {
      violations.add(`${label}: ${stats.topLevelFields} top-level fields`)
    }
    if (stats.transitiveLeaves > budget.maxTransitiveLeaves) {
      violations.add(`${label}: ${stats.transitiveLeaves} transitive leaf fields`)
    }
    if (stats.unionVariants > budget.maxUnionVariants) {
      violations.add(`${label}: ${stats.unionVariants} union variants`)
    }
  }
  return [...violations].sort()
}

const VALID_TARGET_FIXTURE = sourceUnits({
  'packages/backend/src/modules/task-execution/public/participants.ts': `
    declare const taskEffectCapabilityBrand: unique symbol
    export type TaskEffectCapability = Readonly<{ [taskEffectCapabilityBrand]: true }>
    export interface TaskEffectParticipant { apply(input: Readonly<{ taskId: string }>): Promise<void> }
  `,
  'packages/backend/src/modules/task-execution/public/types.ts': `
    export type TaskRef = Readonly<{ taskId: string }>
  `,
  'packages/backend/src/modules/task-execution/application/taskEffectCapability.ts': `
    import type { TaskEffectCapability } from '../public/participants'
    const claims = new WeakMap<TaskEffectCapability, Readonly<{ taskId: string }>>()
    export function mintTaskEffectCapability(taskId: string): TaskEffectCapability {
      const capability = Object.freeze({})
      claims.set(capability, Object.freeze({ taskId }))
      return capability as TaskEffectCapability
    }
  `,
  'packages/backend/src/modules/integration/public/types.ts': `
    export type DeliveryRef = Readonly<{ deliveryId: string }>
  `,
  'packages/backend/src/modules/integration/application/consume.ts': `
    import type { TaskEffectParticipant } from '@/modules/task-execution/public/participants'
    import type { TaskRef } from '../../task-execution/public/types'
    export type Consumer = Readonly<{ participant: TaskEffectParticipant; task: TaskRef }>
  `,
  'packages/backend/src/modules/integration/application/adapters/task-adapter.ts': `
    import type { GatePort } from '@/modules/collaboration/composition/required-ports'
    export type Adapter = Readonly<{ gate: GatePort }>
  `,
  'packages/backend/src/modules/collaboration/composition/required-ports.ts': `
    export interface GatePort { open(): Promise<void> }
  `,
})

describe('RFC-294 W0-R target architecture scanner contract', () => {
  test('accepts exact public edges, same-context internals, and the narrow required-SPI adapter lane', () => {
    expect(crossContextViolations(VALID_TARGET_FIXTURE)).toEqual([])
    expect(publicSurfaceViolations(VALID_TARGET_FIXTURE)).toEqual([])
    expect(capabilityForgeViolations(VALID_TARGET_FIXTURE)).toEqual([])
    expect(godSurfaceViolations(VALID_TARGET_FIXTURE)).toEqual([])
  })

  test('cross-context static/type/dynamic/re-export/import-type mutations all turn red', () => {
    const mutated = sourceUnits({
      'packages/backend/src/modules/alpha/application/use.ts': `
        import type { Hidden } from '@/modules/beta/application/hidden'
        export { secret } from '@/modules/beta/infrastructure/secret'
        export type CommandShape = import('@/modules/beta/public/commands').CommandShape
        import type { Indexed } from '@/modules/beta/public/types/index'
        export type IndexedAlias = Indexed
        export async function lazy() { return import('@/modules/beta/domain/model') }
      `,
      'packages/backend/src/modules/beta/application/hidden.ts': 'export type Hidden = string',
      'packages/backend/src/modules/beta/infrastructure/secret.ts': 'export const secret = 1',
      'packages/backend/src/modules/beta/domain/model.ts': 'export const model = 1',
      'packages/backend/src/modules/beta/public/commands.ts': 'export type CommandShape = string',
    })
    const violations = crossContextViolations(mutated).join('\n')
    expect(violations).toContain('[type:static-import] cross-context internal import')
    expect(violations).toContain('[value:export] cross-context internal import')
    expect(violations).toContain('[value:dynamic-import] cross-context internal import')
    expect(violations).toContain('[type:import-type] type-only edge targets commands/queries')
    expect(violations).toContain('modules/beta/public/types/index.ts')
  })

  test('public export-star and multi-hop namespace alias/generic adapter taint turn red', () => {
    const mutated = sourceUnits({
      'packages/backend/src/modules/catalog/public/types.ts': `
        export * from '../domain/leak'
        export type { LeakedView } from '../domain/bridge'
      `,
      'packages/backend/src/modules/catalog/domain/bridge.ts': `
        export type { LeakedView } from './leak'
      `,
      'packages/backend/src/modules/catalog/domain/leak.ts': `
        import type * as Database from '@/db/client'
        type Envelope<T> = Readonly<{ value: T }>
        export type LeakedView = Envelope<Database.DbClient> | Readonly<{ fallback: unknown }>
      `,
    })
    const violations = publicSurfaceViolations(mutated).join('\n')
    expect(violations).toContain('export * is forbidden')
    expect(violations).toContain('forbidden type import @/db/client#DbClient')
    expect(violations).toContain('unsafe/open type UnknownKeyword')
  })

  test('capability cast, spread-rewrap, deserialize, mutation, and serialization turn red', () => {
    const mutated = sourceUnits({
      'packages/backend/src/modules/identity-access/public/participants.ts': `
        declare const requestAuthorityBrand: unique symbol
        export type RequestAuthority = Readonly<{ [requestAuthorityBrand]: true }>
      `,
      'packages/backend/src/modules/identity-access/application/requestAuthority.ts': `
        import type { RequestAuthority } from '../public/participants'
        const claims = new WeakMap<RequestAuthority, Readonly<{ subjectRef: string }>>()
        export function mintRequestAuthority(subjectRef: string): RequestAuthority {
          const authority = Object.freeze({})
          claims.set(authority, Object.freeze({ subjectRef }))
          return authority as RequestAuthority
        }
      `,
      'packages/backend/src/modules/identity-access/public/events.ts': `
        import type { RequestAuthority } from './participants'
        export type BadAuthorityEvent = Readonly<{ authority: RequestAuthority }>
      `,
      'packages/backend/src/modules/tasks/application/forge.ts': `
        import type { RequestAuthority as Trusted } from '@/modules/identity-access/public/participants'
        type LocalAuthority = Trusted
        export function forge(real: LocalAuthority, raw: string): LocalAuthority {
          const parsed = JSON.parse(raw) as LocalAuthority
          const changed = { ...real, subjectRef: 'other' } as LocalAuthority
          changed.subjectRef = 'again'
          JSON.stringify(parsed)
          return changed
        }
      `,
    })
    const violations = capabilityForgeViolations(mutated).join('\n')
    expect(violations).toContain('casts/rewraps RequestAuthority outside owner factory')
    expect(violations).toContain('mutates sensitive changed')
    expect(violations).toContain('serializes sensitive capability/authority')
    expect(violations).toContain('RequestAuthority leaks through public/events')
  })

  test('god-port and nested-payload mutations are measured recursively', () => {
    const mutated = sourceUnits({
      'packages/backend/src/modules/catalog/public/participants.ts': `
        export interface CatalogPort {
          one(): void; two(): void; three(): void; four(): void; five(): void; six(): void
        }
        export type HiddenMegaDto = Readonly<{ payload: Readonly<{
          a: string; b: string; c: string; d: string; e: string
        }> }>
      `,
    })
    const violations = godSurfaceViolations(mutated, {
      ...DEFAULT_SHAPE_BUDGET,
      maxTransitiveLeaves: 4,
    }).join('\n')
    expect(violations).toContain('CatalogPort: 6 methods')
    expect(violations).toContain('HiddenMegaDto: 5 transitive leaf fields')
  })
})

// RFC-317 T16 —— 两张试点债务表提到模块顶层并具名，让高水位棘轮
// （architecture/rfc317-ledger-highwater.test.ts）能按名字清点条数。原本是匿名内联
// 数组：`toEqual([...])` 的精确相等已经挡住「悄悄加一条」，但**账本自身在长**这件事
// 没有任何地方看得见——每次加一条都只是 diff 里多两行，没有一个数字会变。
const CROSS_CONTEXT_PILOT_DEBT: string[] = [
  'modules/integration/application/mrTerminalControlWorker.ts -> modules/task-execution/application/sourceTerminationCapability.ts [type:static-import] cross-context internal import',
  'modules/integration/composition/webhookTerminalControl.ts -> modules/task-execution/composition/sourceTermination.ts [value:static-import] cross-context internal import',
]

const PUBLIC_SURFACE_PILOT_DEBT: string[] = [
  'modules/integration/public/mrTerminalControl.ts: non-exact public entrypoint',
]

describe('RFC-294 W0-R current modules ratchet', () => {
  const modules = productionModuleUnits()

  test('cross-context internal imports equal the reviewed, expiring pilot debt', () => {
    // Exact equality is intentional: an unknown edge and a removed/stale debt
    // both fail. A migration that deletes one edge must delete its snapshot row
    // in the same change, so the old path can never silently reopen later.
    expect(crossContextViolations(modules)).toEqual(CROSS_CONTEXT_PILOT_DEBT)
  })

  test('public surface has only the reviewed non-exact pilot entrypoint debt and no type taint', () => {
    // Same stale discipline as the edge inventory above. The named pilot file
    // is debt, not an accepted alternative to exact public/{...} entrypoints.
    expect(publicSurfaceViolations(modules)).toEqual(PUBLIC_SURFACE_PILOT_DEBT)
  })

  test('module capability ownership cannot be structurally forged or serialized', () => {
    expect(capabilityForgeViolations(modules)).toEqual([])
  })

  test('current public contracts stay below the pre-ledger hard god-surface ceiling', () => {
    expect(godSurfaceViolations(modules)).toEqual([])
  })
})

// RFC-317 T13 —— 语料非空（守卫的守卫：architecture/rfc317-guard-corpus-floor.test.ts）。
//
// 上面每条断言的绿都可能来自两处：真的没有违规，或者**扫描根失效、语料被筛成空**。
// 两者在断言层面同形，后者是永久静默的假绿。这一条把「扫描器还活着」变成可断言事实；
// 下限同时两向钉进 architecture/guard-manifest.json，静默调低会红。
describe('RFC-317 T13 —— 语料非空', () => {
  test('扫描确实覆盖到源码语料（扫空即假绿）', () => {
    expect(productionModuleUnits().length).toBeGreaterThanOrEqual(120)
  })
})
