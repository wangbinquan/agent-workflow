// RFC-544 — 演示种子与数字员工代理模板迁出 services/（RFC-294 §4.7 其余一族第二步）。
//
// 锁三件事（design §3 的清单即退出门）：
// ① `services/demoSeed.ts` 与 `services/digitalEmployeeAgentTemplates.ts` 不在；演示种子在 `bootstrap/demoSeed.ts`，代理模板在
//    development-automation 的 domain（V2 与旧版数据、工具展示、升级映射与配置）与 application（对齐与列出两个用例）。
// ② bootstrap 取这些名字只经 development-automation 的 `public/participants`；该文件不声明、只转出；三个模板文件不取本模块的 public
//    （否则 public → application → public 成环，顶层用到 V2 ID 的常量会落进暂时性死区）；digital-employee 不取这几个文件。语料下限 3,000。
// ③ 行为：合并的全部 ID 是旧版加 V2 各 8 个、升级映射逐个落到同位的 V2、工具配置只给分类器、public 转出的就是 domain / application 的那一份。
// 负对照只喂伪造的源码，不碰真实语料。
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import * as publicParticipants from '@/modules/development-automation/public/participants'
import {
  DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS_V2,
  DEVELOPMENT_PIPELINE_CLASSIFIER_DEFAULT_CATEGORIES_V2,
} from '@/modules/development-automation/domain/developmentAgentTemplatesV2'
import * as legacy from '@/modules/development-automation/domain/legacyDigitalEmployeeAgentTemplates'
import * as application from '@/modules/development-automation/application/digitalEmployeeAgentTemplates'
import { backendUnits, sourceUnit, type SourceUnit } from './architecture/census'

const REPO = resolve(import.meta.dir, '../../..')
const SRC = 'packages/backend/src/'
const DA = SRC + 'modules/development-automation/'
const PUBLIC_PARTICIPANTS = DA + 'public/participants.ts'
const PUBLIC_SPECIFIER = '@/modules/development-automation/public/participants'
const CORPUS_TIMEOUT = 30_000
const RETIRED = [SRC + 'services/demoSeed.ts', SRC + 'services/digitalEmployeeAgentTemplates.ts']
/** Each moved file and a name it must declare. */
const MOVED: readonly (readonly [string, string])[] = [
  [SRC + 'bootstrap/demoSeed.ts', 'seedDemoContent'],
  [DA + 'domain/developmentAgentTemplatesV2.ts', 'DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATES_V2'],
  [DA + 'domain/legacyDigitalEmployeeAgentTemplates.ts', 'DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS'],
  [DA + 'application/digitalEmployeeAgentTemplates.ts', 'ensureDigitalEmployeeAgentTemplates'],
]
const TEMPLATE_FILES = MOVED.slice(1).map(([path]) => path)
/** The names bootstrap takes; each must come from development-automation's public participants. */
const BOOTSTRAP_NAMES = new Set([
  'ensureDigitalEmployeeAgentTemplates',
  'listDigitalEmployeeAgentTemplates',
  'DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS',
  'digitalEmployeeAgentToolPresentation',
  'digitalEmployeeBuiltinAgentSuccessorId',
  'digitalEmployeeBuiltinToolConfiguration',
])

function specifier(statement: ts.Statement): string | null {
  if (
    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
    statement.moduleSpecifier !== undefined &&
    ts.isStringLiteral(statement.moduleSpecifier)
  )
    return statement.moduleSpecifier.text
  return null
}

function declares(unit: SourceUnit, name: string): boolean {
  return unit.source.statements.some((statement) => {
    if (ts.isVariableStatement(statement))
      return statement.declarationList.declarations.some(
        (declaration) => declaration.name.getText(unit.source) === name,
      )
    return (
      (ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement)) &&
      statement.name?.text === name
    )
  })
}

export function templateOwnerViolations(units: readonly SourceUnit[]): string[] {
  const byPath = new Map(units.map((unit) => [unit.path, unit]))
  const errors = new Set<string>()
  for (const path of RETIRED) if (byPath.has(path)) errors.add(`still in services: ${path}`)
  for (const [path, name] of MOVED) {
    const unit = byPath.get(path)
    if (unit === undefined) errors.add(`missing: ${path}`)
    else if (!declares(unit, name)) errors.add(`not declared: ${name} in ${path}`)
  }
  const publicUnit = byPath.get(PUBLIC_PARTICIPANTS)
  if (publicUnit === undefined) errors.add(`missing: ${PUBLIC_PARTICIPANTS}`)
  else
    for (const statement of publicUnit.source.statements)
      if (
        !ts.isImportDeclaration(statement) &&
        !(ts.isExportDeclaration(statement) && specifier(statement) !== null)
      )
        errors.add(`public declares: ${statement.getText(publicUnit.source).split('\n')[0]}`)
  for (const unit of units) {
    const isTemplateFile = TEMPLATE_FILES.includes(unit.path)
    for (const statement of unit.source.statements) {
      const spec = specifier(statement)
      if (spec === null) continue
      if (
        isTemplateFile &&
        (/^(\.\.\/)+public\//u.test(spec) ||
          spec.startsWith('@/modules/development-automation/public'))
      )
        errors.add(`template file takes own public: ${unit.path} -> ${spec}`)
      if (
        unit.path.startsWith(SRC + 'modules/digital-employee/') &&
        TEMPLATE_FILES.some((file) => spec.endsWith(file.slice(DA.length).replace(/\.ts$/u, '')))
      )
        errors.add(`digital-employee takes templates: ${unit.path} -> ${spec}`)
      if (
        unit.path.startsWith(SRC + 'bootstrap/') &&
        ts.isImportDeclaration(statement) &&
        spec !== PUBLIC_SPECIFIER
      ) {
        const bindings = statement.importClause?.namedBindings
        if (bindings !== undefined && ts.isNamedImports(bindings))
          for (const element of bindings.elements)
            if (BOOTSTRAP_NAMES.has((element.propertyName ?? element.name).text))
              errors.add(
                `bootstrap takes ${(element.propertyName ?? element.name).text} from ${spec}`,
              )
      }
    }
  }
  return [...errors].sort()
}

describe('RFC-544 ①② 迁入位置、分层与取用方向', () => {
  test(
    '真实语料：两个文件不在 services/；四个文件在位；bootstrap 只经 public 取；public 只转出；模板文件不取本模块 public',
    () => {
      const units = backendUnits(REPO)
      expect(units.length).toBeGreaterThanOrEqual(3000)
      expect(templateOwnerViolations(units)).toEqual([])
    },
    CORPUS_TIMEOUT,
  )
})

describe('RFC-544 ③ 模板的结局不变', () => {
  test('合并的全部 ID、升级映射与工具配置', () => {
    const legacyIds = legacy.LEGACY_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS
    expect(legacyIds).toHaveLength(8)
    expect(DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS_V2).toHaveLength(8)
    expect(legacy.DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS).toEqual([
      ...legacyIds,
      ...DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS_V2,
    ])
    expect(new Set(legacy.DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS).size).toBe(16)
    legacyIds.forEach((id, index) =>
      expect(legacy.digitalEmployeeBuiltinAgentSuccessorId(id)).toBe(
        DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS_V2[index]!,
      ),
    )
    expect(legacy.digitalEmployeeBuiltinAgentSuccessorId('not-a-template')).toBeNull()
    const configured = DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS_V2.filter(
      (id) => legacy.digitalEmployeeBuiltinToolConfiguration(id) !== null,
    )
    expect(configured).toEqual([DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS_V2[1]])
    expect(
      legacy.digitalEmployeeBuiltinToolConfiguration(
        DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS_V2[1],
      ),
    ).toEqual({ dispatchRouteDefinitions: DEVELOPMENT_PIPELINE_CLASSIFIER_DEFAULT_CATEGORIES_V2 })
    expect(legacy.DIGITAL_EMPLOYEE_AGENT_TEMPLATES.map((template) => template.id)).toEqual([
      ...legacyIds,
    ])
  })

  test('public 转出的就是 domain / application 的那一份', () => {
    expect(publicParticipants.ensureDigitalEmployeeAgentTemplates).toBe(
      application.ensureDigitalEmployeeAgentTemplates,
    )
    expect(publicParticipants.listDigitalEmployeeAgentTemplates).toBe(
      application.listDigitalEmployeeAgentTemplates,
    )
    expect(publicParticipants.DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS).toBe(
      legacy.DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS,
    )
    expect(publicParticipants.digitalEmployeeAgentToolPresentation).toBe(
      legacy.digitalEmployeeAgentToolPresentation,
    )
    expect(publicParticipants.digitalEmployeeBuiltinAgentSuccessorId).toBe(
      legacy.digitalEmployeeBuiltinAgentSuccessorId,
    )
    expect(publicParticipants.digitalEmployeeBuiltinToolConfiguration).toBe(
      legacy.digitalEmployeeBuiltinToolConfiguration,
    )
    expect(Object.keys(publicParticipants)).not.toContain(
      'DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATES_V2',
    )
  })
})

describe('RFC-544 负对照', () => {
  const clean = [
    ...MOVED.map(([path, name]) => sourceUnit(path, `export const ${name} = 1\n`)),
    sourceUnit(
      PUBLIC_PARTICIPANTS,
      "export { ensureDigitalEmployeeAgentTemplates } from '../application/digitalEmployeeAgentTemplates'\n",
    ),
    sourceUnit(
      SRC + 'bootstrap/daemonApplication.ts',
      `import { ensureDigitalEmployeeAgentTemplates } from '${PUBLIC_SPECIFIER}'\n`,
    ),
  ]
  const replace = (path: string, text: string) => [
    ...clean.filter((unit) => unit.path !== path),
    sourceUnit(path, text),
  ]

  test('伪造的干净语料没有违例', () => {
    expect(templateOwnerViolations(clean)).toEqual([])
  })

  test('留在 services/、public 声明、内层取本模块 public、bootstrap 绕过 public 都会被认出', () => {
    expect(
      templateOwnerViolations([...clean, sourceUnit(RETIRED[0]!, 'export const x = 1\n')]),
    ).toEqual([`still in services: ${RETIRED[0]}`])
    expect(
      templateOwnerViolations(
        replace(
          PUBLIC_PARTICIPANTS,
          'export const DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATES_V2 = []\n',
        ),
      ),
    ).toEqual([
      'public declares: export const DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATES_V2 = []',
    ])
    expect(
      templateOwnerViolations(
        replace(
          DA + 'domain/legacyDigitalEmployeeAgentTemplates.ts',
          "import { x } from '../public/participants'\nexport const DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS = 1\n",
        ),
      ),
    ).toEqual([
      `template file takes own public: ${DA}domain/legacyDigitalEmployeeAgentTemplates.ts -> ../public/participants`,
    ])
    expect(
      templateOwnerViolations(
        replace(
          SRC + 'bootstrap/daemonApplication.ts',
          "import { ensureDigitalEmployeeAgentTemplates } from '@/modules/development-automation/application/digitalEmployeeAgentTemplates'\n",
        ),
      ),
    ).toEqual([
      'bootstrap takes ensureDigitalEmployeeAgentTemplates from @/modules/development-automation/application/digitalEmployeeAgentTemplates',
    ])
    expect(
      templateOwnerViolations([
        ...clean,
        sourceUnit(
          SRC + 'modules/digital-employee/application/probe.ts',
          "import { x } from '@/modules/development-automation/domain/legacyDigitalEmployeeAgentTemplates'\n",
        ),
      ]),
    ).toEqual([
      `digital-employee takes templates: ${SRC}modules/digital-employee/application/probe.ts -> @/modules/development-automation/domain/legacyDigitalEmployeeAgentTemplates`,
    ])
  })
})
