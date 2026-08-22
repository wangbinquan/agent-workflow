import type { RepoSource } from '@/lib/launch-repo-source'
import { RepoSourceList } from '@/components/launch/RepoSourceList'

export interface TaskCreationRepositorySpaceProps {
  readonly value: string
  readonly onChange: (repositoryId: string) => void
  readonly repositories: ReadonlyArray<{ id: string; label: string }>
  readonly label: string
  readonly description: string
  readonly placeholder: string
  readonly disabled?: boolean
}

/**
 * The repository form used by every catalog-backed task contract.
 *
 * It deliberately reuses the orchestration launcher's RepoSourceList instead
 * of offering task sources a second Select implementation. Contract code may
 * narrow or lock the inventory, but cannot replace the visual/control model.
 */
export function TaskCreationRepositorySpace(props: TaskCreationRepositorySpaceProps) {
  const selected = props.repositories.find((repository) => repository.id === props.value)
  const source: RepoSource = {
    kind: 'url',
    repoUrl: selected?.label ?? '',
    ...(props.value === '' ? {} : { cachedRepoId: props.value }),
    ref: '',
  }

  return (
    <RepoSourceList
      repos={[source]}
      onChange={(next) => props.onChange(next[0]?.cachedRepoId ?? '')}
      catalogItems={props.repositories}
      catalogOnly
      disabled={props.disabled}
      fieldLabel={props.label}
      fieldHint={props.description}
      fieldPlaceholder={props.placeholder}
      maxCount={1}
    />
  )
}
