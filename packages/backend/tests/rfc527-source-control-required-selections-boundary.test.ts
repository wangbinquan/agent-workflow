// RFC-527 — 源代码管理的适配器回落改为必填注入（RFC-294 S12 第八步）。
//
// 锁四件事（design §3 的清单即退出门；回落本身由 RFC-521 门的登记锁住，适配器回落为 0）：
// ① 选项的形状（语法树）：四个选择助手只收必填的选择（排除档案的选择随它唯一的、只服务用例的调用方删去）；员工案例、冲突合并、两个候选绑定、仓库准备、工作区维护、提交推送执行、驱动参与者、
//    任务路由与修复、上传与路由启动的入参逐个钉住；只为回落存在的选项不在；镜像的登记方式显式；部署选择的候选与冲突合并不可空。
// ② 删去的名字在生产代码里不再出现；bootstrap 不取 source-control 的 infrastructure，也不再把部署选择的 `null` 转回 `undefined`
//    （语料下限 3,000）。
// ③ 装配处的显式构造逐处钉住：单机部署的候选与冲突合并、HTTP 装配按远端选镜像、维护 worker 的三项本机效果、daemon 的维护命令与两项可空能力。
// ④ 行为：选择助手只核对、原样交出；镜像两支的登记方式与手动刷新按 `kind` 分支；本机候选推送打开夹具会话、步骤替身不带；没有作用域时预览
//    要求给出索引；单机排除档案按应用根目录绑定。
// 均带负对照。
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import {
  selectIsolationWorkspaceFactory,
  selectRepositoryGitWorkspaceFactory,
  selectWorkspaceUploadContentFactory,
} from '@/modules/source-control/public/participants'
import { selectRepositoryWorkspaceReadQueries } from '@/modules/source-control/public/queries'
import {
  bindCandidateDeliveryParticipant,
  bindChangeCandidateParticipant,
  bindConflictMergeParticipant,
  bindRepositoryCommitParticipant,
  composeCachedRepositoryOperations,
  composeLocalRepositoryMirrors,
  composeLocalWorkspaceExcludeProfiles,
  composeRemoteRepositoryMirrors,
  createLocalRepositoryCandidateEffects,
} from '@/modules/source-control/composition'

const BACKEND = resolve(import.meta.dir, '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')
const parse = (path: string, source: string) =>
  ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(path)
      return /\.tsx?$/.test(entry.name) ? [path] : []
    })
}
const PRODUCTION = walk(SRC)
const TEXTS = new Map<string, string>()
const text = (path: string) => {
  let content = TEXTS.get(path)
  if (content === undefined) TEXTS.set(path, (content = readFileSync(path, 'utf8')))
  return content
}
const srcPath = (path: string) => slash(relative(SRC, path)).replace(/\.tsx?$/, '')
/** The corpus tests read every production file; the first read is cold. */
const CORPUS_TIMEOUT = 30_000
const squash = (value: string) => value.replace(/\s+/g, '').replace(/,(?=[)\]}])/g, '')

const at = (...parts: string[]) => join(SRC, ...parts)
const SC = (...parts: string[]) => at('modules', 'source-control', ...parts)
const TE = (...parts: string[]) => at('modules', 'task-execution', ...parts)
const SC_ROOT = SC('composition.ts')
const SC_C = (name: string) => SC('composition', name)
const CONFLICT = SC_C('conflictMerge.ts')
const CANDIDATE = SC_C('repositoryCandidate.ts')
const PREPARATION = SC_C('repositoryPreparation.ts')
const MAINTENANCE = SC_C('workspaceMaintenance.ts')
const PUBLICATION_C = SC_C('workspaceChangePublication.ts')
const PUBLICATION_APP = SC('application', 'workspaceChangePublication.ts')
const CHANGE_APP = SC('application', 'changeCandidate.ts')
const DELIVER_APP = SC('application', 'deliverCandidate.ts')
const CANDIDATE_PORT = SC('application', 'ports', 'repositoryCandidateEffects.ts')
const MIRRORS_PORT = SC('application', 'ports', 'repositoryMirrors.ts')
const COMMIT_PUSH = TE('infrastructure', 'commitPushAttempt.ts')
const PARTICIPANTS = TE('infrastructure', 'taskExecutionRuntimeParticipants.ts')
const ROUTES = TE('infrastructure', 'taskRouteOperations.ts')
const REPAIR = TE('infrastructure', 'taskRouteRepairOperations.ts')
const TASK_UPLOADS = TE('infrastructure', 'taskWorkspaceUploads.ts')
const UPLOAD_APP = TE('application', 'workspaceUploads.ts')
const UPLOAD_C = TE('composition', 'workspaceUploads.ts')
const ROUTE_LAUNCH = TE('composition', 'taskRouteLaunch.ts')
const PROVIDER = TE('composition', 'providerRuntime.ts')
const PROFILE = at('bootstrap', 'deploymentProfile.ts')
const STANDALONE = at('bootstrap', 'standalone.ts')
const DAEMON_APP = at('bootstrap', 'daemonApplication.ts')
const DAEMON_DE = at('bootstrap', 'daemonModules', 'digitalEmployee.ts')
const DAEMON_DA = at('bootstrap', 'daemonModules', 'developmentAutomation.ts')
const HTTP = at('bootstrap', 'daemonHttpComposition.ts')
const WORKER = at('bootstrap', 'maintenanceWorkerGraph.ts')
const INGRESS = at('modules', 'integration', 'composition', 'webhookIngress.ts')

/** Property signatures of an interface, or of the first parameter's type literals of a function: name → [optional, type]. */
function signaturesOf(path: string, source: string, name: string): Map<string, [boolean, string]> {
  const file = parse(path, source)
  const result = new Map<string, [boolean, string]>()
  const take = (list: ts.NodeArray<ts.TypeElement>) => {
    for (const member of list)
      if (ts.isPropertySignature(member))
        result.set(member.name.getText(file), [
          member.questionToken !== undefined,
          squash(member.type?.getText(file) ?? ''),
        ])
  }
  const visit = (node: ts.Node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === name) take(node.members)
    if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body !== undefined) {
      const type = node.parameters[0]?.type
      const literals: ts.TypeLiteralNode[] = []
      const collect = (part: ts.Node) => {
        if (ts.isTypeLiteralNode(part)) literals.push(part)
        else if (ts.isIntersectionTypeNode(part)) part.types.forEach(collect)
        else if (ts.isTypeReferenceNode(part) && part.typeName.getText(file) === 'Readonly')
          part.typeArguments?.forEach(collect)
      }
      if (type !== undefined) collect(type)
      for (const literal of literals) take(literal.members)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return result
}
/** The property signatures of each type literal in the union alias `name`, as `[name, optional, type]`. */
function unionMembers(path: string, source: string, name: string): [string, boolean, string][][] {
  const file = parse(path, source)
  const result: [string, boolean, string][][] = []
  const visit = (node: ts.Node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === name && ts.isUnionTypeNode(node.type))
      for (const part of node.type.types)
        if (ts.isTypeLiteralNode(part))
          result.push(
            part.members
              .filter(ts.isPropertySignature)
              .map((member) => [
                member.name.getText(file),
                member.questionToken !== undefined,
                squash(member.type?.getText(file) ?? ''),
              ]),
          )
    ts.forEachChild(node, visit)
  }
  visit(file)
  return result
}
/** name → optional, for {@link signaturesOf}. */
function members(path: string, source: string, name: string): Map<string, boolean> {
  return new Map([...signaturesOf(path, source, name)].map(([key, [optional]]) => [key, optional]))
}

/** Every declaration of a function `name`: its parameters as `name?=default`. */
function parameters(path: string, source: string, name: string): string[][] {
  const file = parse(path, source)
  const result: string[][] = []
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name)
      result.push(
        node.parameters.map(
          (parameter) =>
            parameter.name.getText(file) +
            (parameter.questionToken === undefined ? '' : '?') +
            (parameter.initializer === undefined ? '' : '=default'),
        ),
      )
    ts.forEachChild(node, visit)
  }
  visit(file)
  return result
}

/** The argument texts (whitespace and trailing commas removed) of every call of `name` in the file. */
function callArguments(path: string, source: string, name: string): string[][] {
  const file = parse(path, source)
  const calls: string[][] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === name)
      calls.push(node.arguments.map((argument) => squash(argument.getText(file))))
    ts.forEachChild(node, visit)
  }
  visit(file)
  return calls
}

/** Module specifiers a file imports or re-exports. */
function specifiers(path: string, source: string): string[] {
  return parse(path, source).statements.flatMap((statement) =>
    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
    statement.moduleSpecifier !== undefined &&
    ts.isStringLiteral(statement.moduleSpecifier)
      ? [statement.moduleSpecifier.text]
      : [],
  )
}

/** design §3: names and options deleted with the fallbacks (identifiers only; comments may keep history). */
const REMOVED = [
  'NativeGitFixture',
  'applyUploadsToWorktree',
  'bindPoliciesToWorkspace',
  'composeRepositoryMirrors',
  'composeTaskWorkspaceExcludeProfilesFor',
  'legacyRunGit',
  'readLocalAppHome',
  'remoteRegistration',
  'requireWorkspaceExcludeProfileFactory',
  'selectWorkspaceExcludeProfileFactory',
] as const
const REMOVED_TEXT = new RegExp(`\\b(?:${REMOVED.join('|')})\\b`)
function removedIn(path: string, source: string): string[] {
  const file = parse(path, source)
  const found = new Set<string>()
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && (REMOVED as readonly string[]).includes(node.text))
      found.add(node.text)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return [...found].sort()
}
/** S12 item 1: an assembly turning a nullable deployment selection back into `undefined`. */
// RFC-294 S12 item 1: an assembly site turning a nullable selection back into undefined. RFC-527 deletes the last ones
// (the candidate and conflict-merge selections in two daemon modules, the two hosted capabilities, the CrewStation event
// ingress in the HTTP composition).
const NULL_TO_UNDEFINED = /==?=null\?undefined:/

describe('RFC-527 ① 选项的形状', () => {
  test('四个选择助手只收必填的选择；只为回落存在的 legacyRunGit 与 readLocalAppHome 不在', () => {
    for (const [file, name] of [
      [SC_C('isolationWorkspaces.ts'), 'selectIsolationWorkspaceFactory'],
      [SC_C('repositoryGitWorkspaces.ts'), 'selectRepositoryGitWorkspaceFactory'],
      [SC_C('repositoryWorkspaceReadQueries.ts'), 'selectRepositoryWorkspaceReadQueries'],
      [SC_C('workspaceUploads.ts'), 'selectWorkspaceUploadContentFactory'],
    ] as const)
      expect([name, parameters(file, text(file), name)]).toEqual([name, [['selected']]])
  })

  test('员工案例、冲突合并与两个候选绑定的 effect 必填、没有缺省参数；请求上不再带只为回落存在的 runGit', () => {
    expect(parameters(SC_ROOT, text(SC_ROOT), 'bindEmployeeCaseWorkspaceParticipant')).toEqual([
      ['input'],
    ])
    expect([...members(SC_ROOT, text(SC_ROOT), 'bindEmployeeCaseWorkspaceParticipant')]).toEqual([
      ['publicationTransport', true],
      ['effects', false],
    ])
    expect(parameters(CONFLICT, text(CONFLICT), 'bindConflictMergeParticipant')).toEqual([
      ['input'],
    ])
    expect([...members(CONFLICT, text(CONFLICT), 'bindConflictMergeParticipant')]).toEqual([
      ['effects', false],
    ])
    expect([...members(CANDIDATE, text(CANDIDATE), 'bindChangeCandidateParticipant')]).toEqual([
      ['candidateEffects', false],
    ])
    expect([...members(CANDIDATE, text(CANDIDATE), 'bindCandidateDeliveryParticipant')]).toEqual([
      ['candidateEffects', false],
      ['publicationTransport', true],
    ])
    for (const [file, name] of [
      [CHANGE_APP, 'DeriveChangeCandidateInput'],
      [CHANGE_APP, 'StageCandidateTreeInput'],
      [DELIVER_APP, 'CommitCandidateInput'],
      [DELIVER_APP, 'PushCandidateInput'],
    ] as const) {
      const shape = members(file, text(file), name)
      expect([name, shape.size > 0, shape.has('runGit')]).toEqual([name, true, false])
    }
    expect(text(CANDIDATE)).not.toMatch(/\bselectFactory\b/)
    expect(
      members(CANDIDATE_PORT, text(CANDIDATE_PORT), 'RepositoryCandidateStepEffectsFactory').get(
        'localFixtureSession',
      ),
    ).toBe(true)
  })

  test('仓库准备、工作区维护、提交推送执行与驱动参与者的选择必填；只为回落存在的三项与 runGit 不在', () => {
    const preparation = members(PREPARATION, text(PREPARATION), 'composeRepositoryPreparation')
    expect([preparation.get('preparationEffects'), preparation.get('scratchEffects')]).toEqual([
      false,
      false,
    ])
    expect([
      ...members(MAINTENANCE, text(MAINTENANCE), 'WorkspaceMaintenanceCompositionInput'),
    ]).toEqual([
      ['workspaceGc', false],
      ['workspacePrune', false],
      ['terminalMaintenance', false],
      ['filesystem', false],
    ])
    const commitPush = members(COMMIT_PUSH, text(COMMIT_PUSH), 'CommitPushDeps')
    expect([commitPush.get('repositoryGitWorkspaces'), commitPush.has('runGit')]).toEqual([
      false,
      false,
    ])
    const participants = members(
      PARTICIPANTS,
      text(PARTICIPANTS),
      'TaskExecutionRuntimeParticipantsInput',
    )
    expect([
      participants.get('isolationWorkspaces'),
      participants.get('repositoryGitWorkspaces'),
    ]).toEqual([false, false])
    // The publication bound its policies by path only when no factory was selected; the factory is now always given.
    for (const file of [PUBLICATION_APP, PUBLICATION_C, COMMIT_PUSH])
      expect(text(file)).not.toContain('bindPoliciesToWorkspace')
  })

  test('任务路由、修复、上传与路由启动的选择必填；托管的输入文件与任务恢复可空而必给', () => {
    expect(
      members(ROUTES, text(ROUTES), 'TaskRouteOperationsDependencies').get('workspaceReads'),
    ).toBe(false)
    expect(members(ROUTES, text(ROUTES), 'taskDiffProjection').get('workspaceReads')).toBe(false)
    expect(
      members(REPAIR, text(REPAIR), 'TaskRouteRepairOperationsDependencies').get('workspaceReads'),
    ).toBe(false)
    expect(parameters(UPLOAD_APP, text(UPLOAD_APP), 'workspaceUploadPolicy')).toEqual([
      ['plan', 'selected'],
    ])
    expect(parameters(UPLOAD_C, text(UPLOAD_C), 'applyWorkspaceUploads')).toEqual([
      ['plan', 'selected'],
    ])
    // The upload writer is one explicit choice: the deployment's content, or the interruption oracle's whole writer.
    const uploads = parse(TASK_UPLOADS, text(TASK_UPLOADS))
    const applyInput = uploads.statements
      .filter(ts.isFunctionDeclaration)
      .find((declaration) => declaration.name?.text === 'applyTaskWorkspaceUploads')
      ?.parameters[0]?.type?.getText(uploads)
    expect(squash(applyInput ?? '').endsWith('}&TaskWorkspaceUploadWriter')).toBe(true)
    const apply = signaturesOf(TASK_UPLOADS, text(TASK_UPLOADS), 'applyTaskWorkspaceUploads')
    expect([apply.get('inputFiles'), apply.has('workspaceUploads'), apply.has('write')]).toEqual([
      [false, 'TaskInputFiles|null'],
      false,
      false,
    ])
    expect(unionMembers(TASK_UPLOADS, text(TASK_UPLOADS), 'TaskWorkspaceUploadWriter')).toEqual([
      [
        ['workspaceUploads', false, 'WorkspaceUploadContentFactory'],
        ['write', true, 'undefined'],
      ],
      [
        ['write', false, '(plan:UploadPlan)=>Promise<UploadResult>'],
        ['workspaceUploads', true, 'undefined'],
      ],
    ])
    for (const [file, name] of [
      [TASK_UPLOADS, 'createTaskLaunchUploads'],
      [ROUTE_LAUNCH, 'createRootTaskLaunchKernelPorts'],
      [ROUTE_LAUNCH, 'createRootTaskLaunchPorts'],
    ] as const) {
      const shape = signaturesOf(file, text(file), name)
      expect([name, shape.get('workspaceUploads'), shape.get('inputFiles')]).toEqual([
        name,
        [false, 'WorkspaceUploadContentFactory'],
        [false, 'TaskInputFiles|null'],
      ])
    }
    expect(
      signaturesOf(PROVIDER, text(PROVIDER), 'TaskExecutionProviderRuntimeDependencies').get(
        'recoverySelection',
      ),
    ).toEqual([false, 'TaskRecoveryProviderSelection|null'])
    // The CrewStation event ingress: the HTTP composition hands the deployment's selection over unchanged.
    expect(
      signaturesOf(INGRESS, text(INGRESS), 'composeWebhookIngressTransport').get(
        'crewStationEvents',
      ),
    ).toEqual([false, 'CrewStationEventIngress|null'])
    expect(squash(text(INGRESS))).toContain('input.crewStationEvents===null&&')
    expect(squash(text(HTTP))).toContain(
      'composeWebhookIngressTransport({crewStationEvents:integrationModules.crewStationEvents,',
    )
  })

  test('镜像的登记方式显式；部署选择的候选与冲突合并必填、不可空', () => {
    const mirrors = members(MIRRORS_PORT, text(MIRRORS_PORT), 'RepositoryMirrors')
    expect([mirrors.get('registration'), mirrors.has('remoteRegistration')]).toEqual([false, false])
    const selections = signaturesOf(PROFILE, text(PROFILE), 'DeploymentSelections')
    expect([
      selections.get('repositoryCandidateEffects'),
      selections.get('conflictMergeWorkspaceEffects'),
    ]).toEqual([
      [false, 'RepositoryCandidateEffectsFactory'],
      [false, 'ConflictMergeWorkspaceEffects'],
    ])
  })
})

describe('RFC-527 ② 删去的名字与 bootstrap 的取用', () => {
  test(
    '删去的名字与选项在生产代码里不再出现',
    () => {
      expect(PRODUCTION.length).toBeGreaterThanOrEqual(3000)
      const hits = PRODUCTION.filter((path) => REMOVED_TEXT.test(text(path))).flatMap((path) =>
        removedIn(path, text(path)).map((name) => `${srcPath(path)}: ${name}`),
      )
      expect(hits).toEqual([])
    },
    CORPUS_TIMEOUT,
  )

  test(
    'bootstrap 不取 source-control 的 infrastructure，也不再把部署选择的 null 转回 undefined',
    () => {
      const bootstrap = PRODUCTION.filter((path) => slash(path).includes('/src/bootstrap/'))
      expect(bootstrap.length).toBeGreaterThan(50)
      expect(
        bootstrap.flatMap((path) =>
          specifiers(path, text(path))
            .filter((specifier) => specifier.startsWith('@/modules/source-control/infrastructure'))
            .map((specifier) => `${srcPath(path)}: ${specifier}`),
        ),
      ).toEqual([])
      expect(
        bootstrap.filter((path) => NULL_TO_UNDEFINED.test(squash(text(path)))).map(srcPath),
      ).toEqual([])
    },
    CORPUS_TIMEOUT,
  )
})

describe('RFC-527 ③ 装配处的显式构造', () => {
  test('单机部署给本机候选与冲突合并；daemon 的两个模块装配直接交入部署选择', () => {
    const standalone = squash(text(STANDALONE))
    expect(standalone).toContain(
      'repositoryCandidateEffects:createLocalRepositoryCandidateEffects(),',
    )
    expect(standalone).toContain(
      'conflictMergeWorkspaceEffects:createFileConflictMergeWorkspaceEffects(),',
    )
    expect(callArguments(DAEMON_DE, text(DAEMON_DE), 'bindConflictMergeParticipant')).toEqual([
      ['{effects:input.conflictMergeWorkspaceEffects}'],
    ])
    expect(squash(text(DAEMON_DE))).toContain(
      'constcandidateEffects=input.repositoryCandidateEffects',
    )
    const automation = squash(text(DAEMON_DA))
    expect(automation).toContain('constcandidateEffects=input.repositoryCandidateEffects')
    expect(automation).toContain('constconflictMergeEffects=input.conflictMergeWorkspaceEffects')
  })

  test('HTTP 装配按部署选择的远端显式选镜像的一支', () => {
    expect(squash(text(HTTP))).toContain(
      'repositoryRemote===null?composeLocalRepositoryMirrors({store:core.repositoryWorkspaceStore}):composeRemoteRepositoryMirrors({store:core.repositoryWorkspaceStore,remote:repositoryRemote,secretBox:input.secretBox,appHome:input.appHome})',
    )
  })

  test('维护 worker 在没有托管效果时显式给本机的草稿区、准备与维护文件系统（此前回落的同一组参数）', () => {
    const worker = squash(text(WORKER))
    for (const expected of [
      'scratchEffects:hostedWorkspaceEffects?.scratch??composeLocalScratchWorkspaceEffects(preparationInput)',
      'preparationEffects:hostedWorkspaceEffects?.preparation??composeLocalRepositoryPreparationEffects(preparationInput)',
      'filesystem:hostedWorkspaceEffects?.filesystem(isMaterializingTask)??createNodeWorkspaceMaintenanceFilesystem({appHome,isMaterializingTask,invalidateWorkspacePath:invalidateCallGraphIndex})',
    ])
      expect(worker).toContain(expected)
  })

  test('daemon 的维护命令只交部署选择的文件系统；两项托管能力原样交入', () => {
    expect(
      callArguments(DAEMON_APP, text(DAEMON_APP), 'composeWorkspaceMaintenanceCommand'),
    ).toEqual([
      [
        '{...composeSourceControlTaskPorts(input.db),filesystem:input.workspaceMaintenanceFilesystem,terminalMaintenance:taskExecutionPersistence.terminalMaintenance}',
      ],
    ])
    const application = squash(text(DAEMON_APP))
    expect(application).toContain('inputFiles:input.taskInputFiles,')
    expect(application).toContain(
      'recoverySelection:input.taskRecovery===null?null:input.taskRecovery(identityAccess),',
    )
  })
})

describe('RFC-527 ④ 行为', () => {
  test('选择助手只核对、原样交出；缺了或不全就报错', () => {
    const factory = { bind: () => ({}) }
    expect(selectIsolationWorkspaceFactory(factory as never)).toBe(factory as never)
    expect(selectRepositoryGitWorkspaceFactory(factory as never)).toBe(factory as never)
    expect(selectWorkspaceUploadContentFactory(factory as never)).toBe(factory as never)
    const reads = {
      exists: () => false,
      isGitWorkTree: () => false,
      gitDiffSnapshot: () => null,
      worktreeDiff: () => null,
      isolationRoot: () => '',
    }
    expect(selectRepositoryWorkspaceReadQueries(reads as never)).toBe(reads as never)
    const selects: ((selected: never) => unknown)[] = [
      selectIsolationWorkspaceFactory,
      selectRepositoryGitWorkspaceFactory,
      selectWorkspaceUploadContentFactory,
      selectRepositoryWorkspaceReadQueries,
    ]
    for (const select of selects) {
      expect(() => select(undefined as never)).toThrow(TypeError)
      expect(() => select({} as never)).toThrow(TypeError)
    }
    expect(() => bindConflictMergeParticipant({ effects: undefined as never })).toThrow(
      'conflict-merge-workspace-effects-incomplete',
    )
    expect(() => bindChangeCandidateParticipant({ candidateEffects: undefined as never })).toThrow(
      'repository-candidate-effects-incomplete',
    )
    expect(() => bindCandidateDeliveryParticipant({ candidateEffects: {} as never })).toThrow(
      'repository-candidate-effects-incomplete',
    )
  })

  test('镜像两支各自声明登记方式；手动刷新按 kind 分支', async () => {
    const store = {
      runtimeIdentity: {},
      invalidateCachedRepoFacets() {},
      listKnownRepositoryPaths: () => [],
      findCachedRepoById: async () => {
        throw new Error('mirror-cache-store')
      },
    }
    expect(composeLocalRepositoryMirrors({ store: store as never }).registration).toEqual({
      kind: 'mirror-cache',
    })
    const remote = composeRemoteRepositoryMirrors({ store: store as never, remote: {} as never })
    expect(remote.registration.kind).toBe('remote')
    let reads = 0
    const configuration = {
      read: () => {
        reads++
        return {}
      },
    }
    const refreshed = { fetchOk: true, fetchError: null }
    const registered = composeCachedRepositoryOperations({
      store: store as never,
      mirrors: {
        registration: {
          kind: 'remote',
          register: async () => ({ cachedRepoId: 'r1', created: true }),
          refresh: async (id: string) => ({ ...refreshed, id }),
        },
      } as never,
      configuration,
    })
    expect(await registered.refresh('r1')).toEqual({ ...refreshed, id: 'r1' } as never)
    expect(reads).toBe(0)
    const cached = composeCachedRepositoryOperations({
      store: store as never,
      mirrors: { registration: { kind: 'mirror-cache' } } as never,
      configuration,
    })
    // The mirror cache reads the clone time limit, then fetches its own clone.
    await expect(cached.refresh('r1')).rejects.toThrow('mirror-cache-store')
    expect(reads).toBe(1)
  })

  test('本机候选 effect 带夹具会话，推送打开它；步骤替身不带', async () => {
    const request = {
      baselineRepoPath: '/baseline',
      commitSha: 'c'.repeat(40),
      remoteUrl: '/srv/remote.git',
      branch: 'feature/x',
      expectedRemoteSha: null,
      expectedTreeOid: 't'.repeat(40),
      baselineSha: 'b'.repeat(40),
    }
    const unavailable = {
      ok: false,
      code: 'publication-transport-unavailable',
      detail: 'a managed publication transport and persisted subject are required',
    }
    const opened: string[] = []
    const withSession = {
      acquire: () => {
        throw new Error('not reached')
      },
      localFixtureSession: (remoteUrl: string) => {
        opened.push(remoteUrl)
        return null
      },
    }
    expect(
      await bindCandidateDeliveryParticipant({ candidateEffects: withSession }).push(request),
    ).toEqual(unavailable as never)
    expect(opened).toEqual(['/srv/remote.git'])
    const stand = {
      acquire: () => {
        throw new Error('not reached')
      },
    }
    expect(
      await bindCandidateDeliveryParticipant({ candidateEffects: stand }).push(request),
    ).toEqual(unavailable as never)
    expect(opened).toEqual(['/srv/remote.git'])

    const calls: string[][] = []
    const local = createLocalRepositoryCandidateEffects({
      runGit: async (repoPath, args) => {
        calls.push([repoPath, ...args])
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    })
    expect(typeof local.acquire).toBe('function')
    expect(local.localFixtureSession?.('https://example.invalid/r.git')).toBeNull()
    const session = local.localFixtureSession?.('/srv/remote.git')
    expect(session?.receipt.endpointSource).toBe('local-fixture')
    await session?.runNetwork('/baseline', ['ls-remote', '/srv/remote.git'])
    expect(calls).toEqual([['/baseline', 'ls-remote', '/srv/remote.git']])
  })

  test('没有作用域时提交预览要求给出索引；绑定本身不报错', async () => {
    const unscoped = bindRepositoryCommitParticipant({ repoPath: '/no/such/repository' })
    expect(() => unscoped.preview()).toThrow(
      'Repository commit preview requires a workspace scope or a preview index',
    )
    const given = bindRepositoryCommitParticipant({
      repoPath: '/no/such/repository',
      runGit: async () => ({ stdout: '', stderr: 'no repository', exitCode: 128 }),
      previewIndex: {
        withIndex: async () => {
          throw new Error('preview-index-used')
        },
      },
    })
    const outcome = await Promise.resolve()
      .then(() => given.preview())
      .then(
        () => 'resolved',
        (error: Error) => error.message,
      )
    expect(outcome).not.toContain('requires a workspace scope')
  })

  test('单机排除档案按应用根目录绑定', () => {
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc527-exclude-'))
    try {
      const participant = composeLocalWorkspaceExcludeProfiles({ appHome }).bind({
        workspaceRef: join(appHome, 'worktree'),
      })
      expect(typeof participant.ensure).toBe('function')
    } finally {
      rmSync(appHome, { recursive: true, force: true })
    }
  })
})

describe('RFC-527 ⑤ 负对照', () => {
  test('形状与扫描助手认得出旧形状', () => {
    expect(
      unionMembers(
        '/f.ts',
        'type W = { readonly a: A; readonly b?: undefined } | { readonly b: B } | C',
        'W',
      ),
    ).toEqual([
      [
        ['a', false, 'A'],
        ['b', true, 'undefined'],
      ],
      [['b', false, 'B']],
    ])
    expect(
      [
        ...signaturesOf(
          '/f.ts',
          'export async function f(input: { readonly u?: U; readonly write?: W }) { return input }',
          'f',
        ),
      ].map(([key, [isOptional]]) => [key, isOptional]),
    ).toEqual([
      ['u', true],
      ['write', true],
    ])
    const optional =
      'export function selectX(selected?: X, legacyRunGit?: G): X { return selected }'
    expect(parameters('/f.ts', optional, 'selectX')).toEqual([['selected?', 'legacyRunGit?']])
    const defaulted = 'export function bindX(input: { readonly effects?: E } = {}) { return input }'
    expect(parameters('/f.ts', defaulted, 'bindX')).toEqual([['input=default']])
    expect([...members('/f.ts', defaulted, 'bindX')]).toEqual([['effects', true]])
    expect(
      [...signaturesOf('/f.ts', 'interface S { readonly c: C | null }', 'S')].map(
        ([key, value]) => [key, ...value],
      ),
    ).toEqual([['c', false, 'C|null']])
    expect(
      NULL_TO_UNDEFINED.test(
        squash(
          'const e =\n  input.conflictMergeWorkspaceEffects === null ? undefined : input.conflictMergeWorkspaceEffects',
        ),
      ),
    ).toBe(true)
    expect(
      NULL_TO_UNDEFINED.test(
        squash(
          'crewStationEvents:\n  m.crewStationEvents == null\n    ? undefined\n    : m.crewStationEvents',
        ),
      ),
    ).toBe(true)
    expect(NULL_TO_UNDEFINED.test(squash('const e = input.x === null ? null : input.x(y)'))).toBe(
      false,
    )
    expect(
      specifiers('/f.ts', "import { y } from '@/modules/source-control/infrastructure/local/x'"),
    ).toEqual(['@/modules/source-control/infrastructure/local/x'])
    expect(removedIn('/f.ts', 'const legacyRunGit = 1 // composeRepositoryMirrors')).toEqual([
      'legacyRunGit',
    ])
    expect(
      callArguments(
        '/f.ts',
        'bindConflictMergeParticipant({ effects: undefined })',
        'bindConflictMergeParticipant',
      ),
    ).toEqual([['{effects:undefined}']])
  })
})
