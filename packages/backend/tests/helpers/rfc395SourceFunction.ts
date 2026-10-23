// RFC-395 II-a A3: exercise a private migrated call site with only its external effects bound.
// The function body is copied from the live source, not reimplemented; expected results are independent.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

export function rfc395SourceFunction<F>(
  path: string,
  name: string,
  bindings: Record<string, unknown>,
): F {
  const text = readFileSync(resolve(import.meta.dir, '../../src', path), 'utf8')
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  let body: string | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name)
      body = node.getText(source).replace(/^export\s+/, '')
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    )
      body = `const ${node.getText(source)};`
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (body === undefined) throw new Error(`missing production function ${path}#${name}`)
  const javascript = ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None },
  }).outputText
  return new Function(...Object.keys(bindings), `${javascript}; return ${name};`)(
    ...Object.values(bindings),
  ) as F
}
