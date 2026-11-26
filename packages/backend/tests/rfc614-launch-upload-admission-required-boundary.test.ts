// RFC-614 — 收上传的 launch 把 upload admission 当必填端口；子任务委派是不收上传的另一个用例（RFC-294 W4-E8 余项）。
//
// 为什么存在：`LaunchDeps.uploadAdmission?` 可选，带上传的 direct launch 在它缺席时落一个 `upload-admission-not-wired` 的 blocked Mission，预览直接
// 报错。生产里 Mission 操作的 launch 一直给它；子任务委派不给，但委派从不带上传——可选端口其实是两个用例。现在：
// - `launchMission` 收 `LaunchDeps`，`uploadAdmission` 必填；预览、选源、重试、取消只收 `MissionCommandDeps`（存储、准入查询、时钟）；
// - 子任务委派走 `launchMissionWithoutUploads`，带上传时在写入任何东西之前以 `mission-uploads-not-accepted` 拒绝；
// - application 里没有端口缺席的判断，也没有 `upload-admission-not-wired`。
// 锁四件事：① 合同（编译期 + AST）；② 用例文件没有缺席判断与旧阻断码；③ 子任务委派走不收上传的入口；④ 不收上传的入口遇到上传即拒绝、零写入。
// ②③ 的判据喂伪造源码做负对照，不碰真实语料。
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import {
  launchMissionWithoutUploads,
  type LaunchDeps,
  type MissionCommandDeps,
} from '@/modules/development-automation/application/commands/launchMission'
import { sourceUnit, type SourceUnit } from './architecture/census'

const REPO = resolve(import.meta.dir, '../../..')
const DA = 'packages/backend/src/modules/development-automation/'
const LAUNCH = DA + 'application/commands/launchMission.ts'
const CHILD = DA + 'infrastructure/childMissionParticipant.ts'
const read = (path: string) => sourceUnit(path, readFileSync(resolve(REPO, path), 'utf8'))

// ① The launch that accepts uploads requires the admission; the other commands take none.
type Assert<T extends true> = T
export type AdmissionRequired = Assert<
  object extends Pick<LaunchDeps, 'uploadAdmission'> ? false : true
>
export type CommandsTakeNoAdmission = Assert<
  'uploadAdmission' extends keyof MissionCommandDeps ? false : true
>

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}

function interfaceMember(unit: SourceUnit, owner: string, member: string) {
  for (const statement of unit.source.statements) {
    if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== owner) continue
    return statement.members.find((element) => element.name?.getText(unit.source) === member)
  }
  return undefined
}

const ABSENCE = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
])

/** `…uploadAdmission` compared with `undefined` or `null`: a port-absence check. */
function absenceChecks(unit: SourceUnit): string[] {
  const found: string[] = []
  walk(unit.source, (node) => {
    if (!ts.isBinaryExpression(node) || !ABSENCE.has(node.operatorToken.kind)) return
    const sides = [node.left, node.right]
    const empty = sides.some(
      (side) =>
        side.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isIdentifier(side) && side.text === 'undefined'),
    )
    const port = sides.some((side) => /\buploadAdmission$/.test(side.getText(unit.source)))
    if (empty && port) found.push(node.getText(unit.source))
  })
  return found
}

/** What a child-mission participant launches through, and with which dependency type. */
function childLaunch(unit: SourceUnit): { readonly calls: string[]; readonly launchType: string } {
  const calls: string[] = []
  let launchType = '<missing>'
  walk(unit.source, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression))
      if (/^launchMission/.test(node.expression.text)) calls.push(node.expression.text)
    if (ts.isPropertySignature(node) && node.name.getText(unit.source) === 'launch')
      launchType = node.type?.getText(unit.source) ?? '<none>'
  })
  return { calls: calls.sort(), launchType }
}

const notUsed = <T extends object>(name: string) =>
  new Proxy({} as T, {
    get(_target, member) {
      throw new Error(`${name}.${String(member)} is not used by this test`)
    },
  })

describe('RFC-614 —— 收上传的 launch 必填 upload admission，子任务委派不收上传', () => {
  test('合同：LaunchDeps 的 uploadAdmission 必填，其余命令的依赖里没有它', () => {
    const unit = read(LAUNCH)
    const member = interfaceMember(unit, 'LaunchDeps', 'uploadAdmission')
    expect(member !== undefined && ts.isPropertySignature(member)).toBe(true)
    expect(member?.questionToken).toBeUndefined()
    expect(interfaceMember(unit, 'MissionCommandDeps', 'uploadAdmission')).toBeUndefined()
  })

  test('用例文件没有端口缺席的判断，也没有旧的阻断码', () => {
    const unit = read(LAUNCH)
    expect(absenceChecks(unit)).toEqual([])
    expect(unit.source.text).not.toContain('upload-admission-not-wired')
  })

  test('子任务委派走不收上传的入口', () => {
    expect(childLaunch(read(CHILD))).toEqual({
      calls: ['launchMissionWithoutUploads'],
      launchType: 'MissionCommandDeps',
    })
  })

  test('不收上传的入口遇到上传即拒绝，只读过幂等键', async () => {
    const reads: string[] = []
    const store = new Proxy({} as MissionCommandDeps['store'], {
      get(_target, member) {
        if (member === 'findByIdempotencyKey')
          return async (key: string) => {
            reads.push(key)
            return null
          }
        throw new Error(`store.${String(member)} is not used by this test`)
      },
    })
    await expect(
      launchMissionWithoutUploads(
        { store, lookup: notUsed('lookup'), now: () => 1 },
        {
          idempotencyKey: 'idem-rfc614-1',
          repositoryId: 'repo-1',
          repositoryGroupId: null,
          submission: {
            kind: 'direct',
            title: 'Delegated work',
            body: null,
            uploads: [{ uploadRef: 'upload-1', repositoryTargetPath: 'docs/a.md' }],
          },
          delivery: { kind: 'create-merge-request' },
          requestedEmployee: null,
          requestedPolicy: null,
          actorUserId: null,
        },
      ),
    ).rejects.toMatchObject({ code: 'mission-uploads-not-accepted' })
    expect(reads).toEqual(['idem-rfc614-1'])
  })
})

describe('RFC-614 —— 负对照（伪造源码）', () => {
  test('判据认得出端口缺席的判断与经可选端口的 launch', () => {
    const launch = sourceUnit(
      LAUNCH,
      [
        'export async function launch(deps: { uploadAdmission?: object }) {',
        '  if (deps.uploadAdmission !== undefined) return 1',
        '  return deps.uploadAdmission == null ? 0 : 2',
        '}',
      ].join('\n'),
    )
    expect(absenceChecks(launch)).toEqual([
      'deps.uploadAdmission !== undefined',
      'deps.uploadAdmission == null',
    ])
    const child = sourceUnit(
      CHILD,
      [
        'export function createChildMissionParticipant(deps: { readonly launch: LaunchDeps }) {',
        '  return () => launchMission(deps.launch, {})',
        '}',
      ].join('\n'),
    )
    expect(childLaunch(child)).toEqual({ calls: ['launchMission'], launchType: 'LaunchDeps' })
  })
})
