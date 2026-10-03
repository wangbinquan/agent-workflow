import { readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { checkLexicalThenRealpath } from '@/util/safePath'

export function readInsideRoot(rootAbs: string, rel: string): Buffer | null {
  const v = checkLexicalThenRealpath(rootAbs, rel)
  if (!v.realpath.resolved || !v.realpath.realInside) return null
  if (!v.lexicalInside && !isAbsolute(rel)) return null // 相对输入不许 lexical 逃逸
  try {
    return readFileSync(v.realpath.realTarget)
  } catch {
    return null
  }
}

export function existsInsideRoot(rootAbs: string, rel: string): boolean {
  const v = checkLexicalThenRealpath(rootAbs, rel)
  if (!v.realpath.resolved || !v.realpath.realInside) return false
  if (!v.lexicalInside && !isAbsolute(rel)) return false
  try {
    return statSync(v.realpath.realTarget).isFile()
  } catch {
    return false
  }
}
