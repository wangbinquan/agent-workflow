import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { ArtifactElementAnchor } from '@agent-workflow/shared'
import { api } from '@/api/client'

/** The source owner resolves opaque anchors; the question form does not interpret graph models. */
export function ArtifactElementLink({ anchor }: { anchor: ArtifactElementAnchor }) {
  const { i18n } = useTranslation(),
    zh = i18n.language.startsWith('zh')
  const query = useQuery<{ href: string; label: string }>({
    queryKey: ['content-link', anchor],
    queryFn: ({ signal }) =>
      api.get(
        `/api/content-links/${encodeURIComponent(anchor.artifactRef)}`,
        {
          selection: JSON.stringify([...anchor.elementIds, ...anchor.relationIds]),
          viewId: anchor.viewId,
        },
        signal,
      ),
    retry: false,
  })
  if (!query.data)
    return (
      <p className="muted">
        {zh ? '关联内容：' : 'Linked content: '}
        {[...anchor.elementIds, ...anchor.relationIds].join(', ')}
      </p>
    )
  return (
    <a className="btn btn--sm" href={query.data.href}>
      {zh ? '查看关联设计' : 'Open linked design'} · {query.data.label}
    </a>
  )
}
