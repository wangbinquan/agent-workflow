import ts from 'typescript'

/** Exact introduced purpose seams only; callers still compare their complete old body hashes. */
export function inversePurposeRootBindings(source: ts.SourceFile, body: ts.Block) {
  const print = (node: ts.Node) =>
    ts
      .createPrinter({ removeComments: true })
      .printNode(ts.EmitHint.Unspecified, node, source)
      .replace(/\s/g, '')
  const receiver = source.fileName.endsWith('server.ts') ? 'deps' : 'input'
  const rootName = source.fileName.endsWith('server.ts')
    ? 'appHome'
    : source.fileName.endsWith('start.ts')
      ? 'Paths.root'
      : 'input.appHome'
  const counts = {
    roots: 0,
    runners: 0,
    factories: 0,
    content: 0,
    staging: 0,
    forwards: 0,
    shared: 0,
    repository: 0,
    eventCenter: 0,
  }
  const exact = (actual: string, expected: string) => {
    if (actual !== expected) throw new Error(`purpose inverse mismatch: ${actual} != ${expected}`)
  }
  const expression = (text: string) => {
    const parts = text.split('.')
    if (parts.length !== 2) throw new Error('purpose inverse expression missing')
    return ts.factory.createPropertyAccessExpression(
      ts.factory.createIdentifier(parts[0]!),
      parts[1]!,
    )
  }
  const transformed = ts.transform(body, [
    (context) => {
      const visit: ts.Visitor = (node) => {
        if (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1) {
          const declaration = node.declarationList.declarations[0]!
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === 'developmentPurposeRoot'
          ) {
            const homeField = source.fileName.endsWith('server.ts')
              ? 'appHome'
              : `appHome:${rootName}`
            const call = `composeDevelopmentPurposeRoot({${homeField},selection:${receiver}.developmentPurposes,evidenceArtifacts:${receiver}.evidenceArtifacts,evidenceDocumentCommands:${receiver}.evidenceDocumentCommands,})`
            exact(
              print(declaration.initializer!),
              source.fileName.endsWith('server.ts') ? `deps.developmentPurposeRoot??${call}` : call,
            )
            counts.roots++
            return undefined
          }
        }
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          const name = node.expression.text
          const runners: Record<string, string> = {
            composeSelectedRequirementSourceRunnerFor: 'composeRequirementSourceRunnerFor',
            composeSelectedPipelineEvidenceRunnerFor: 'composePipelineEvidenceRunnerFor',
            composeSelectedApprovalGatewayRunnerFor: 'composeApprovalGatewayRunnerFor',
          }
          const original = runners[name]
          if (original !== undefined) {
            if (node.arguments.length !== 2)
              throw new Error('purpose runner must have two arguments')
            const purpose =
              original === 'composeRequirementSourceRunnerFor'
                ? 'requirement'
                : original === 'composePipelineEvidenceRunnerFor'
                  ? 'pipeline'
                  : 'approval'
            const selected = print(node.arguments[1]!)
            if (
              ![
                'developmentPurposeRoot',
                'deps.developmentPurposeRoot',
                'input.developmentPurposeRoot',
              ].some((root) => selected === `${root}.${purpose}`)
            )
              throw new Error('purpose runner selection mismatch')
            counts.runners++
            return ts.factory.updateCallExpression(
              node,
              ts.factory.createIdentifier(original),
              node.typeArguments,
              [node.arguments[0]!],
            )
          }
          if (['buildDevelopmentDeliveryDeps', 'buildDevelopmentPipelineDeps'].includes(name)) {
            if (node.arguments.length !== 2)
              throw new Error('purpose pipeline factory must have two arguments')
            const selected = print(node.arguments[1]!)
            if (
              ![
                'developmentPurposeRoot.pipeline.staging',
                'deps.developmentPurposeRoot.pipeline.staging',
              ].includes(selected)
            )
              throw new Error('purpose pipeline factory staging mismatch')
            counts.factories++
            return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, [
              node.arguments[0]!,
            ])
          }
          if (name === 'composeRepositoryBootstrap') {
            if (node.arguments.length !== 3)
              throw new Error('purpose repository forwarding mismatch')
            exact(print(node.arguments[2]!), 'developmentPurposeRoot')
            counts.repository++
            return ts.factory.updateCallExpression(
              node,
              node.expression,
              node.typeArguments,
              node.arguments.slice(0, -1),
            )
          }
          if (name === 'composeApplicationEventCenter') {
            const at = node.arguments.findIndex((argument) =>
              ['developmentPurposeRoot', 'deps.developmentPurposeRoot'].includes(print(argument)),
            )
            if (at < 0) throw new Error('purpose event center forwarding missing')
            counts.eventCenter++
            return ts.factory.updateCallExpression(
              node,
              node.expression,
              node.typeArguments,
              ts.factory.createNodeArray(
                node.arguments.filter((_, index) => index !== at),
                node.arguments.hasTrailingComma,
              ),
            )
          }
        }
        if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'developmentPurposeRoot') {
          counts.shared++
          return undefined
        }
        if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
          const name = node.name.text,
            value = print(node.initializer)
          if (name === 'developmentPurposes') {
            exact(value, 'input.developmentPurposes')
            counts.forwards++
            return undefined
          }
          if (name === 'requirementStaging') {
            if (
              ![
                'developmentPurposeRoot.requirement.staging',
                'deps.developmentPurposeRoot.requirement.staging',
              ].includes(value)
            )
              throw new Error('purpose requirement staging mismatch')
            counts.staging++
            return undefined
          }
          if (
            name === 'evidenceArtifacts' &&
            [
              'developmentPurposeRoot.evidenceArtifacts',
              'deps.developmentPurposeRoot.evidenceArtifacts',
            ].includes(value)
          ) {
            counts.content++
            return ts.factory.updatePropertyAssignment(
              node,
              node.name,
              expression(receiver + '.evidenceArtifacts'),
            )
          }
          if (
            name === 'evidenceDocumentCommands' &&
            [
              'developmentPurposeRoot.requirement.documentCommands',
              'deps.developmentPurposeRoot.requirement.documentCommands',
            ].includes(value)
          ) {
            counts.content++
            return ts.factory.updatePropertyAssignment(
              node,
              node.name,
              expression(receiver + '.evidenceDocumentCommands'),
            )
          }
        }
        return ts.visitEachChild(node, visit, context)
      }
      return (node) => ts.visitNode(node, visit, ts.isBlock)!
    },
  ])
  const original = transformed.transformed[0]!
  transformed.dispose()
  return { body: original, counts }
}
