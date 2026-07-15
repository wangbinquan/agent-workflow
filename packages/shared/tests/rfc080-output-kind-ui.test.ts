// RFC-080 PR-B — OUTPUT_KIND_UI catalog + drift guard (layer 2 + the
// dataBearing↔carriesData agreement). The frontend derives the KindSelect base
// dropdown, i18n labels, download affordance, and canvas signal styling from
// this single table; these tests lock that it stays in sync with the registry.

import { describe, expect, test } from 'bun:test'
import {
  OUTPUT_KIND_UI,
  listSelectableKinds,
  outputKindUiById,
  getHandlerForParsedKind,
  parseKind,
  REGISTERED_BASE_KINDS,
  PATH_EXT_UI,
  listSelectablePathExts,
  isSelectablePathExt,
  type OutputKindUiDescriptor,
} from '@agent-workflow/shared'

describe('RFC-080 OUTPUT_KIND_UI catalog', () => {
  test('listSelectableKinds covers string/markdown/signal + the path shape', () => {
    expect(
      listSelectableKinds()
        .map((d) => d.id)
        .sort(),
    ).toEqual(['markdown', 'path', 'signal', 'string'])
  })

  test('every base descriptor id is a registered base kind; path is the only param shape', () => {
    for (const d of OUTPUT_KIND_UI) {
      expect(d.descriptionKey).toBe(`kindSelect.description_${d.id}`)
      if (d.editorShape === 'base') {
        expect(REGISTERED_BASE_KINDS.has(d.id)).toBe(true)
      } else {
        expect(d.editorShape).toBe('param-path')
        expect(d.id).toBe('path')
      }
    }
  })

  test('outputKindUiById round-trips', () => {
    expect(outputKindUiById('signal')?.dataBearing).toBe(false)
    expect(outputKindUiById('nope')).toBeUndefined()
  })

  test('dataBearing agrees with handler.carriesData (drift guard)', () => {
    for (const d of OUTPUT_KIND_UI) {
      const kindStr = d.id === 'path' ? 'path<*>' : d.id
      const parsed = parseKind(kindStr)
      expect(d.dataBearing).toBe(getHandlerForParsedKind(parsed).carriesData(parsed))
    }
  })

  test('only the path entry is downloadable', () => {
    expect(OUTPUT_KIND_UI.filter((d) => d.downloadable).map((d) => d.id)).toEqual(['path'])
  })

  test('PATH_EXT_UI ships the built-in path extensions (* + md), each valid path<ext>', () => {
    expect(listSelectablePathExts().map((e) => e.ext)).toEqual(['*', 'md'])
    // Every listed ext composes a parseable path<ext> kind.
    for (const e of PATH_EXT_UI) {
      expect(parseKind(`path<${e.ext}>`)).toEqual({ kind: 'path', ext: e.ext })
    }
  })

  test('isSelectablePathExt matches the catalog (md builtin, json/xml not yet)', () => {
    expect(isSelectablePathExt('*')).toBe(true)
    expect(isSelectablePathExt('md')).toBe(true)
    expect(isSelectablePathExt('json')).toBe(false)
    expect(isSelectablePathExt('xml')).toBe(false)
  })

  test('drift guard layer 2: a descriptor missing a dimension fails to typecheck', () => {
    // If any OutputKindUiDescriptor field is made optional (regressing the
    // satisfies-table drift guard), this becomes valid → @ts-expect-error unused
    // → `bun run typecheck` errors.
    // @ts-expect-error — omitting descriptionKey/downloadable/dataBearing must be a type error.
    const bad: OutputKindUiDescriptor = { id: 'x', editorShape: 'base', labelKey: 'k' }
    expect(bad.id).toBe('x')
  })
})
