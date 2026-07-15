// RFC-080 PR-B — OUTPUT_KIND_UI: the single co-located source of truth the
// FRONTEND enumerates to render the output-port kind selector, its i18n
// labels, the Outputs-tab download affordance, and the canvas signal styling.
//
// drift guard layer 2: declared `as const satisfies readonly
// OutputKindUiDescriptor[]` (the same exhaustiveness pattern as
// node-kind-behavior.ts's `NODE_KIND_BEHAVIORS satisfies Record<…>`). Adding a
// selectable kind without filling EVERY dimension (labelKey / descriptionKey /
// downloadable / dataBearing / editorShape) is a compile error.
//
// CYCLE RED LINE (RFC-079): this module imports ONLY from kindParser — never
// from ./registry or the handlers — so enumerating it from the frontend can't
// recreate the index→list→registry→list init cycle that crashed build:binary.
// `dataBearing` here MUST agree with each handler's `carriesData()`; the
// agreement is asserted at module load below + by a frontend test.

import { REGISTERED_BASE_KINDS } from '../kindParser'

/**
 * How the KindSelect control edits this entry:
 *  - 'base'       → a leaf base kind (string / markdown / signal); no params.
 *  - 'param-path' → the `path<ext>` shape; the control shows an extension input.
 * The `list<…>` container is NOT a selectable entry — it's a wrap toggle the
 * control applies on top of whichever leaf entry is chosen.
 */
export type OutputKindEditorShape = 'base' | 'param-path'

export interface OutputKindUiDescriptor {
  /**
   * Stable id. For 'base' entries this is the base kind name (must be a member
   * of REGISTERED_BASE_KINDS). For the 'param-path' entry it is 'path'.
   */
  readonly id: string
  readonly editorShape: OutputKindEditorShape
  /** i18n key; the frontend provides cn/en (asserted present by a frontend test). */
  readonly labelKey: string
  /** i18n key for the short explanatory copy shown in the kind dropdown. */
  readonly descriptionKey: string
  /** A port of this kind (as a worktree file) offers a download in the Outputs tab. */
  readonly downloadable: boolean
  /** Carries data referenceable as a `{{port}}` token. MUST match handler.carriesData. */
  readonly dataBearing: boolean
}

export const OUTPUT_KIND_UI = [
  {
    id: 'string',
    editorShape: 'base',
    labelKey: 'kindSelect.base_string',
    descriptionKey: 'kindSelect.description_string',
    downloadable: false,
    dataBearing: true,
  },
  {
    id: 'markdown',
    editorShape: 'base',
    labelKey: 'kindSelect.base_markdown',
    descriptionKey: 'kindSelect.description_markdown',
    downloadable: false,
    dataBearing: true,
  },
  {
    id: 'signal',
    editorShape: 'base',
    labelKey: 'kindSelect.base_signal',
    descriptionKey: 'kindSelect.description_signal',
    downloadable: false,
    dataBearing: false,
  },
  {
    id: 'path',
    editorShape: 'param-path',
    labelKey: 'kindSelect.base_path',
    descriptionKey: 'kindSelect.description_path',
    downloadable: true,
    dataBearing: true,
  },
] as const satisfies readonly OutputKindUiDescriptor[]

/** The selectable leaf kinds the KindSelect base dropdown enumerates. */
export function listSelectableKinds(): readonly OutputKindUiDescriptor[] {
  return OUTPUT_KIND_UI
}

/** Look up a UI descriptor by its base-kind name / shape id. */
export function outputKindUiById(id: string): OutputKindUiDescriptor | undefined {
  return OUTPUT_KIND_UI.find((d) => d.id === id)
}

// -----------------------------------------------------------------------------
// PATH_EXT_UI — the built-in `path<ext>` extensions the KindSelect renders as a
// SECOND dropdown (the ext sub-control) once the user picks the `path` leaf,
// instead of a free-text box. Single source of truth for the file formats a
// path port can declare from the guided control; adding one (e.g. `json`) is a
// one-line edit here + its two i18n labels.
//
// `*` (any extension) and `md` (the markdown file — the legacy markdown_file ≡
// path<md> that review nodes accept) ship today. An ext NOT in this list stays
// expressible via the KindSelect advanced raw-text field, so no grammar power
// is lost — it just isn't a one-click choice until promoted into this table.
// -----------------------------------------------------------------------------

export interface PathExtUiDescriptor {
  /** The token stored inside `path<ext>`; '*' means any extension. */
  readonly ext: string
  /** i18n key; the frontend provides cn/en (asserted present by a frontend test). */
  readonly labelKey: string
}

export const PATH_EXT_UI = [
  { ext: '*', labelKey: 'kindSelect.ext_any' },
  { ext: 'md', labelKey: 'kindSelect.ext_md' },
] as const satisfies readonly PathExtUiDescriptor[]

/** The selectable `path<ext>` extensions the KindSelect ext dropdown enumerates. */
export function listSelectablePathExts(): readonly PathExtUiDescriptor[] {
  return PATH_EXT_UI
}

/** True iff `ext` is one of the built-in, one-click-selectable path extensions. */
export function isSelectablePathExt(ext: string): boolean {
  return PATH_EXT_UI.some((d) => d.ext === ext)
}

// -----------------------------------------------------------------------------
// drift guard layer 3a (UI side): every base kind in REGISTERED_BASE_KINDS must
// have exactly one 'base' descriptor, and every 'base' descriptor id must be a
// registered base kind. (The 'param-path' entry is the only non-base shape.)
// Adding a base kind to the grammar without a UI descriptor → boot/CI throw.
// -----------------------------------------------------------------------------
{
  const baseIds = OUTPUT_KIND_UI.filter((d) => d.editorShape === 'base').map((d) => d.id)
  const seen = new Set<string>()
  for (const id of baseIds) {
    if (seen.has(id)) throw new Error(`RFC-080 OUTPUT_KIND_UI: duplicate base descriptor '${id}'`)
    seen.add(id)
    if (!REGISTERED_BASE_KINDS.has(id)) {
      throw new Error(
        `RFC-080 OUTPUT_KIND_UI: base descriptor '${id}' is not a registered base kind`,
      )
    }
  }
  for (const name of REGISTERED_BASE_KINDS) {
    if (!seen.has(name)) {
      throw new Error(`RFC-080 OUTPUT_KIND_UI: registered base kind '${name}' has no UI descriptor`)
    }
  }
}

// PATH_EXT_UI invariant: no duplicate ext token (a dup would make the ext
// dropdown render two rows that round-trip to the same `path<ext>`).
{
  const seen = new Set<string>()
  for (const d of PATH_EXT_UI) {
    if (seen.has(d.ext)) throw new Error(`PATH_EXT_UI: duplicate ext token '${d.ext}'`)
    seen.add(d.ext)
  }
}
