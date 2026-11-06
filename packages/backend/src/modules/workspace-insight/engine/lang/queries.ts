// RFC-083 PR-A — per-language tree-sitter extraction queries + config.
//
// Each pattern captures the definition node as `@def.<kind>` and its name node
// as `@name`. `extract.ts` walks matches, derives qualifiedName/parentId from
// syntactic nesting, reclassifies functions→methods inside class-like scopes,
// and computes signature/bodyHash. Kinds here are the raw SymbolKind values;
// imports may have no `@name` (Python), handled by extract.ts.
//
// These queries were validated against the tree-sitter-wasms 0.20-era grammars
// (node-type names differ slightly from current docs). Java/Rust/C++/Scala
// extraction lands in PR-B.

import type Parser from 'web-tree-sitter'
import type { LangId } from '@agent-workflow/shared'

type TsNode = Parser.SyntaxNode

export interface ExtractionConfig {
  query: string
  /** Language-specific receiver prefix for a definition's qualifiedName
   *  (Go methods: `func (t T) Foo` → `T.Foo`). */
  receiverPrefix?: (node: TsNode) => string | null
}

const PYTHON = `
(class_definition name: (identifier) @name) @def.class
(function_definition name: (identifier) @name) @def.function
(import_statement) @def.import
(import_from_statement) @def.import
(class_definition
  body: (block (expression_statement (assignment left: (identifier) @name)) @def.field))
`

const GO = `
(type_declaration (type_spec name: (type_identifier) @name type: (struct_type))) @def.struct
(type_declaration (type_spec name: (type_identifier) @name type: (interface_type))) @def.interface
(function_declaration name: (identifier) @name) @def.function
(method_declaration name: (field_identifier) @name) @def.method
(field_declaration name: (field_identifier) @name) @def.field
(import_spec path: (interpreted_string_literal) @name) @def.import
`

const TYPESCRIPT = `
(class_declaration name: (_) @name) @def.class
(class !name) @def.class
(interface_declaration name: (_) @name) @def.interface
(enum_declaration name: (_) @name) @def.enum
(method_definition name: (property_identifier) @name) @def.method
(method_definition name: (private_property_identifier) @name) @def.method
(function_declaration name: (identifier) @name) @def.function
(public_field_definition name: (property_identifier) @name) @def.field
(public_field_definition name: (private_property_identifier) @name) @def.field
(variable_declarator name: (identifier) @name value: (arrow_function)) @def.function
(import_statement source: (string) @name) @def.import
`

const JAVASCRIPT = `
(class_declaration name: (identifier) @name) @def.class
(class !name) @def.class
(method_definition name: (property_identifier) @name) @def.method
(method_definition name: (private_property_identifier) @name) @def.method
(function_declaration name: (identifier) @name) @def.function
(field_definition property: (property_identifier) @name) @def.field
(field_definition property: (private_property_identifier) @name) @def.field
(variable_declarator name: (identifier) @name value: (arrow_function)) @def.function
(import_statement source: (string) @name) @def.import
`

// RFC-083 PR-B — Java/Rust first-class (own queries); C++/Scala best-effort.

const JAVA = `
(class_declaration name: (identifier) @name) @def.class
(object_creation_expression type: (_) @name (class_body)) @def.class
(interface_declaration name: (identifier) @name) @def.interface
(enum_declaration name: (identifier) @name) @def.enum
(method_declaration name: (identifier) @name) @def.method
(constructor_declaration name: (identifier) @name) @def.constructor
(field_declaration declarator: (variable_declarator name: (identifier) @name)) @def.field
(import_declaration (scoped_identifier) @name) @def.import
`

const RUST = `
(struct_item name: (type_identifier) @name) @def.struct
(enum_item name: (type_identifier) @name) @def.enum
(trait_item name: (type_identifier) @name) @def.trait
(function_item name: (identifier) @name) @def.function
(function_signature_item name: (identifier) @name) @def.method
(field_declaration name: (field_identifier) @name) @def.field
(use_declaration) @def.import
`

// C++ is preprocessor-blind and out-of-line / templated members are lossy in
// any lightweight tool — captures classes/structs/enums/fields/free functions
// + #include, marked degraded. RFC-087 adds in-class member methods (inline
// defs + prototypes, via the `field_identifier` declarator that only appears for
// class members); constructors/destructors (identifier declarator) stay out of
// scope for this degraded grammar.
const CPP = `
(class_specifier name: (type_identifier) @name) @def.class
(struct_specifier name: (type_identifier) @name) @def.struct
(enum_specifier name: (type_identifier) @name) @def.enum
(field_declaration declarator: (field_identifier) @name) @def.field
(field_declaration declarator: (function_declarator declarator: (field_identifier) @name)) @def.method
(function_definition declarator: (function_declarator declarator: (field_identifier) @name)) @def.method
(function_definition declarator: (function_declarator declarator: (identifier) @name)) @def.function
(preproc_include) @def.import
`

// Scala best-effort: tree-sitter-scala (0.20-era) parses class/object/trait/def/
// val but Scala-3 given/enum/nested are unreliable — marked degraded.
const SCALA = `
(class_definition name: (identifier) @name) @def.class
(object_definition name: (identifier) @name) @def.object
(trait_definition name: (identifier) @name) @def.trait
(function_definition name: (identifier) @name) @def.method
(val_definition pattern: (identifier) @name) @def.field
(var_definition pattern: (identifier) @name) @def.field
(import_declaration) @def.import
`

function goReceiver(node: TsNode): string | null {
  const recv = node.childForFieldName('receiver')
  if (recv === null) return null
  const types = recv.descendantsOfType('type_identifier')
  const first = types[0]
  return first !== undefined ? first.text : null
}

/** Rust impl methods: walk to the enclosing `impl_item` and read its type so a
 *  `fn foo` inside `impl S` qualifies as `S.foo` (and reclassifies to method). */
function rustImplReceiver(node: TsNode): string | null {
  let p = node.parent
  while (p !== null) {
    if (p.type === 'impl_item') {
      const t = p.childForFieldName('type')
      return t !== null ? t.text : null
    }
    p = p.parent
  }
  return null
}

const EXTRACTION: Partial<Record<LangId, ExtractionConfig>> = {
  python: { query: PYTHON },
  go: { query: GO, receiverPrefix: goReceiver },
  typescript: { query: TYPESCRIPT },
  javascript: { query: JAVASCRIPT },
  java: { query: JAVA },
  rust: { query: RUST, receiverPrefix: rustImplReceiver },
  cpp: { query: CPP },
  scala: { query: SCALA },
}

export function getLangExtraction(lang: LangId): ExtractionConfig | undefined {
  return EXTRACTION[lang]
}

export function hasExtraction(lang: LangId): boolean {
  return EXTRACTION[lang] !== undefined
}

/** Languages whose baseline extraction is best-effort (UI marks "incomplete";
 *  symbols flagged `degraded` + confidence 'inferred'). C++ is preprocessor-
 *  blind + member-lossy; Scala-3 constructs are unreliable in the 0.20 grammar.
 *  Deep mode (PR-E, scip-clang / scip-java) is how these become first-class. */
export const DEGRADED_LANGS: ReadonlySet<LangId> = new Set<LangId>(['cpp', 'scala'])
