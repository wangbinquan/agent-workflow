interface CanvasNodeReferenceBandProps {
  displayTitle: string
  referenceName: string
  unsetReferenceLabel?: string
}

/** Shared secondary identity for nodes that reference another resource. */
export function CanvasNodeReferenceBand({
  displayTitle,
  referenceName,
  unsetReferenceLabel,
}: CanvasNodeReferenceBandProps) {
  const hasReference = referenceName.length > 0
  // The default node title already is the resource name. Only render a second
  // line when it adds identity (custom title) or communicates an explicit
  // unset state for call nodes.
  if (hasReference && displayTitle === referenceName) return null
  if (!hasReference && unsetReferenceLabel === undefined) return null

  return (
    <div className="canvas-node__call-reference">
      <span className="canvas-node__call-reference-indicator" aria-hidden="true" />
      {hasReference ? (
        <code title={referenceName}>{referenceName}</code>
      ) : (
        <span>{unsetReferenceLabel}</span>
      )}
    </div>
  )
}
