// RFC-395 II-a A7 / T11：覆盖全部 registry 表，防止 II-b 换 adapter 时外域静默失效。
// 旧 T41 账本保留；模块与横向目录的账本各自精确匹配且只减不增。
// RFC-317 T41 · R5（findings DE-01 / DE-02）—— **表归属**。
//
// RFC-294 明令：bounded context 之间「不得以共享表、内部 import 或
// `bootstrap if type === development` 重新耦合」。前两种此前只有一种被守住——
// `rfc294-architecture-preflight` 的 `crossContextViolations` 逐条钉死了
// `@/modules/<ctx>/...` 形态的内部 import 边。**共享表完全没有防线**：
// 表是从全局 `@/db/schema` 命名空间取的，它不是一条 module import 边，
// 于是所有基于 import 的守卫都对它失明。
//
// 实测代价（两条互为镜像）：
//   · DE-01 —— 通用 OS 的 `writerCutover.ts` 直接查 development-automation 的四张
//     Mission 表，还抄了一份「已了结审批状态」词表。通用 OS 因此离开 development 的
//     schema 就装配不起来；development 改一列会静默改坏它。
//   · DE-02 —— 反过来，development-automation 直接查 OS 的私表 `employeeReactionRounds`，
//     读它冻结的 planJson，并按 `state === 'completed'` 过滤——把 OS 的内部状态机枚举
//     变成了一条没有声明、没有 schema、没有主人的事实合同。
// 两条都已在 T41 收口成 public 端口；本文件是让它们不会再长回来的机制。
//
// ---------------------------------------------------------------------------
// 判据为什么按**registry 声明**归属，而不是按引用推断
// ---------------------------------------------------------------------------
//
// 按引用推断（「只有一个 context 引用它 ⇒ 它归那个 context」）在真实语料上会把最严重
// 的一类越界判成合法：`employeeRoundWorkspaceStates` 明明是 Digital Employee OS 的表
// （与其余 13 张 employee* 表同批建、同一个 store 写），却**只**被
// development-automation 引用过。按引用推断会得出「它归 development-automation」，
// 于是「另一个 context 独占了你的表」这种最坏情况反而一条都不报。
// 所以归属必须是**声明**出来的，编译后的 registry 就是那份声明。

import { createHash } from 'node:crypto'
import moduleDebt from '../fixtures/rfc395-module-table-ownership-debt.json'
import horizontalDebt from '../fixtures/rfc395-horizontal-table-ownership-debt.json'
import { OFFERED_CONTEXT_PAIRS } from './rfc294Target'
import {
  referencedPersistenceTables,
  tableOwnerContext,
  horizontalTableReferences,
  ownershipReferenceDelta,
} from './tableOwnership'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { packageSrcUnits, sourceUnit, tableOwnershipCrossings } from './census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

// 所有表的 owner 与物理表名均来自编译 registry，不按前缀或引用数量推断。
const TABLE_OWNERS: Readonly<Record<string, string>> = Object.fromEntries(
  persistenceSchema.tables.map((table) => [table.schemaSymbol, table.owner]),
)

interface OwnershipDebt {
  readonly table: string
  readonly owner: string
  readonly file: string
  /** 为什么现在还能接受。 */
  readonly why: string
  /** 什么时候消失——必须指向具体任务 / RFC，不允许写「以后再说」。 */
  readonly removeWhen: string
}

/**
 * T41 开账当天的真实存量：8 条。
 *
 * 同批**已清掉**的是 finding 逐条点名的三处：
 *   · `writerCutover.ts` 对四张 development Mission 表的查询 → `LegacyMissionDrainPort`；
 *   · `digitalEmployeeWorkspace.ts` 读 `employeeReactionRounds.planJson`
 *     → `EmployeeReactionRoundQueryPort.frozenPlan`；
 *   · `digitalEmployeePlatformWorkItems.ts` 按 `state === 'completed'` 找修复轮次
 *     → `EmployeeReactionRoundQueryPort.lastSettledRound`。
 * 剩下这 8 条是同一片耦合里**更深的一层**（含写侧），不是同一个动作能收口的，
 * 逐条记在这里并写清出路——棘轮只减不增。
 */
const LEGACY_OWNERSHIP_DEBT: readonly OwnershipDebt[] = [
  ...[
    'integration/infrastructure/developmentAdapterStore.ts',
    'integration/infrastructure/developmentToolConnectionStore.ts',
  ].map((file) => ({
    table: 'developmentAdapterDefinitionRevisions',
    owner: 'development-automation',
    file,
    why: 'Integration 的 provider adapter 仍直接持久化 Development Automation 拥有的适配器修订表；这只是精确存量，不是业务层可复制的访问方式。',
    removeWhen:
      'RFC-294 W4-E8 将定义修订持久化收回 Development Automation，并让 Integration 只消费 owner-owned public port。',
  })),
  ...[
    'integration/infrastructure/developmentAdapterStore.ts',
    'integration/infrastructure/developmentToolConnectionStore.ts',
  ].map((file) => ({
    table: 'developmentAdapterDefinitions',
    owner: 'development-automation',
    file,
    why: 'Integration 的 provider adapter 仍直接持久化 Development Automation 拥有的适配器定义表；它与 revisions 必须作为同一 owner contract 收口。',
    removeWhen:
      'RFC-294 W4-E8 将定义存储收回 Development Automation，并让 Integration 只消费 owner-owned public port。',
  })),
  ...[
    'developmentApprovalSagas',
    'developmentMissionLinks',
    'developmentMissions',
    'developmentMrClaims',
  ].map((table) => ({
    table,
    owner: 'development-automation',
    file: 'digital-employee/infrastructure/writerCutoverPersistence.ts',
    why: 'Digital Employee 的 writer cutover infrastructure 仍跨 context 操作 Development Automation 的 mission lifecycle 表；调用点已被精确钉住。',
    removeWhen:
      'RFC-294 W4-E9 把 writer cutover 收敛为 Development Automation owner-owned command，Digital Employee 只传 closed request。',
  })),
  {
    table: 'employeeApprovalSagas',
    owner: 'digital-employee',
    file: 'development-automation/infrastructure/employeePlatformWorkItemPersistence.ts',
    why: 'Development Automation 的工作项 persistence 仍读取 Digital Employee 拥有的审批 saga；这是 provider adapter 的精确跨表存量。',
    removeWhen:
      'RFC-294 W4-E9 由 Digital Employee 暴露 closed approval query，Development Automation 不再引用 foreign table。',
  },
  ...[
    'development-automation/infrastructure/employeePlatformWorkItemPersistence.ts',
    'development-automation/infrastructure/employeeWorkspacePersistence.ts',
  ].map((file) => ({
    table: 'employeeCaseWorkspaces',
    owner: 'digital-employee',
    file,
    why: 'Development Automation 的 workspace persistence（RFC-359 已合一为单文件）仍共享 Digital Employee workspace 表；所有站点均为精确 infrastructure 存量。',
    removeWhen:
      'RFC-294 W4-E9 落地 Digital Employee owner-owned EmployeeWorkspaceStorePort，外域只消费 closed operations。',
  })),
  {
    table: 'employeeChangeCandidates',
    owner: 'digital-employee',
    file: 'development-automation/infrastructure/employeePlatformWorkItemPersistence.ts',
    why: 'Development Automation 的平台工作项 persistence 仍读取 Digital Employee 变更候选表以生成发布工作项。',
    removeWhen:
      'RFC-294 W4-E9 由 Digital Employee 提供 closed change-candidate projection，删除 foreign table import。',
  },
  ...[
    'development-automation/infrastructure/employeePlatformWorkItemPersistence.ts',
    'development-automation/infrastructure/employeeWorkspacePersistence.ts',
  ].map((file) => ({
    table: 'employeeRoundWorkspaceStates',
    owner: 'digital-employee',
    file,
    why: 'Development Automation 的 workspace persistence（RFC-359 已合一为单文件）仍共享 Digital Employee round workspace 状态表；所有站点均被逐文件钉住。',
    removeWhen:
      'RFC-294 W4-E9 将 round workspace persistence 收回 Digital Employee owner port，删除跨 context 表访问。',
  })),
]

const OWNERSHIP_DEBT: readonly OwnershipDebt[] = [...LEGACY_OWNERSHIP_DEBT, ...moduleDebt.entries]
const TABLE_IDS = Object.fromEntries(
  persistenceSchema.tables.map((table) => [table.schemaSymbol, table.id]),
)
// 开账快照只用于限制移除，不能用新的债替换旧债或重新加入已关闭站点。
const INITIAL_DEBT = new Set([
  // RFC-395 II-a 集中验证：有 offered 边、但闭合会成环或越出 RFC-376 已提交 DAG 基线的 4 处（见 OFFERED_BUT_BLOCKED）。
  'd283f0d9e54978ced78b0c681693cf4941779f0f17ac3f4434d02b2ccb666e17',
  'be241d1562e71925bff81127544fd2886ab84db75d1c5c152d22043fb335121b',
  'f1da303c6c7205e5d35376ade7bc4de0d25ddbdd8eaad0c8145fd79980bd5f31',
  '3c64d8b2d01697a2d0bae47f04860ca29bd53850b41f96c95666f1b0da8809c9',
  '4116f6c58a92e923da4720889e784b5ab114f55c9ea4731cc19e7f75e7911209',
  '974728379a1c0e3315c385601826d8fae6b39dbad48011ee1f3c357e9e4e4eab',
  '21bc8c9ee65556e580cdad394c5911b4a849548dde4db4e2e0cacfa14165d6b0',
  '605d7b7c763f42c21cadee0e1468abc3206261cd16a6cabd115b6cec54b8e7f8',
  'cc72753cabe43067816e4ab66a45f544942483b8ef770dd64c6fe4018ca0ed43',
  'e16187a1d3d7bf082135fdf139b2602359df70b1102eea21d2c0b1f2cb28402d',
  '7d094bc52de5ba336be31e6eba6e534ba195b426a32418bc326bf59e6d415120',
  '55fb2ee04838411ad8d260b1c76a9f57575b364b0e7472593ee20a12739d11cb',
  '9423b3d99a51b641c19947c0b5e7d26438182150958989f473aeb8965c3dfd79',
  '975d036cdb55d1c16ca1f8b6ccd765ba92677a5337caceaf257a791cb87de85b',
  '5816e76414ae8a058353dacf879a623b768297d7e87386211205f3d82ae460e3',
  '9b6c2421b6a1409e97b020d4ad9887d784b11a26211c53008d8c0b288614ba5c',
  'ec13c17ea88dd2202b02b5d42383daac22a87d9c6fccc1b7b61a173bfd87ed38',
  '75e3e3d0c749122f9977f7e9a81796c98193b9c5902a935064834093459cc757',
  '39fc057761b9f518e6b0170335af1579213a8988b95c72cab4745e522e6a29b1',
  '999f15e8f33f460e623552a69238b6d6a04d988b77e92eebfb6d290f2c696b9d',
  'b1ffa739df1c0800ee81fa10af6d4f9285ef89153e3d1d66ab31535a9ac312f9',
  'c9b60bd6c697d5317536399f6d32b78f47d12e53d7ba60fb9f671c3bca7c8575',
  'f5efdda542f565e1db64145ac4f055dd6b09749beec34249f592a14d47124ae2',
  'fd428d1a2ad1a0a8bff48a9e83fed3371859832fa011761c671e67c2f59e3a5d',
  '5cb402885d6ce977e13369b8f7119a83dbdd637cd5a95615916ea153cc96a778',
  'c0185160b3c925cbf3e1840fe0fac9cc0b87293162c4976d75c6f2212f3aee83',
  'b7375c34fd239250f0fa939e14db7be42650eadf8366ec72366df76ebd07912f',
  'a5f9dca3d15afb43681effda3ec2ba3dcfea4b47169d6d3467be416966781df7',
  '2727fbfa1e4503a5844a6870b6bf117275aca16f3a03366cb0c913920c76ee8e',
  'b584d9120a1187040f6160c6b5761251131a509b515af3d54aef151afa5cef76',
  'bf41f7a9a776e686c7703ac6eeb97fb24acce5519b4d5ce9afba4639ff5bda6e',
  'deef841c20d25117d738049538631476b1cb6b8409c79570a3055286c0650908',
  '62713e0d7e312d6c55e8a16e785684882bff1d1755ac3ca915f3b27a48269b7b',
  '85d8f78d6499f0a0fd6e0160d49fc84cf15bd7a055fd27bfd218f1318f6fcf6a',
  'bd19c79bce68b9e17a7e8dffc87a7739d33305e0e3120142da94898fad33d66e',
  '3071cd1ace430683b5dde6227fbc58070079579264687fc8656b60cb995c0781',
  '2224cd98a32132b9aa52c5e8769933e2eee2ffc84b9c2133ecee06038828663d',
  'c59a162894f1aeadb836b7205173801b5d5e7e00f496a5eae9cde5fdcdf4c044',
  '92ab77bde5fee0cd27850afc9977ada5421376289bf755298b4ec436101d2c9b',
  'f193af64c56f5e4de5c08f0d5ab4346c9e63cdad8a20001d5c2c2549e7726fd2',
  '10c1adc11bf849d3100b581203c7829e027966d30b21ff9677db3a1e3165c86b',
  '34de7a3d43a3e40ef26713abb5fa0ed68d6b807a16cbbd19859d327f743dd138',
  '2b5a174848e479c71e99136728d5c04b14e3abb8ddaede78a45b4cc91077c3ca',
  'e3f7740fb19a736594820e12a8adaa4e2c7af34e7ee9ad711327237b04f86794',
  '03193297914fe72afa5d866d3f1693cc480b2551799ff22741b154738af09826',
  'c7b9a305245d8dc2b5f5fc661f6735ae08837c36830b17596b25ea4fd18650fd',
  'a55233045753a4f11d26d940666377098111985d2f9211fae66c529a2fcf0db0',
  '16ceb61b37f8528635fc8e232fe19556da6b7bb585accb18dce65b9df9de65a6',
  '81409cc15632e05da977c0e3c5db09cffb79c00e922fcc00ab8c17c800a915cc',
  '40d356ae44d5310115edf9b8aadd2ee8815bf274418e642801d1e8bd13180b05',
  'c774e11f2c8fc1129c951492bf48645e3cd9211428168a675737b973a71fe6ff',
  '4082ef08681ebae285abcdb0a8279ade629f84f97792f3721c6b20b8fc5614a9',
  '5b64430e45b9dd3add6b81d76a6b322dab205baa8ca210b3d60f53b00429d935',
  'ce252f4a2fff385f3bd46766284b1501c5c90894bcba1e4404d8e392db0e75a0',
  '92a4e4692bb987d390ab90e7f14ac1f48c40faa482227dfa44a6b89210b51926',
  'df1d3023ccfdf85396213ea4c3d718c5cf06a9699de80c35426bcd78a453fc97',
  'c00b555aab6456f7a33561c04722ad101a97a610097bbff7e47fa5e678249bf5',
  'fbd25ebdaf1d2fc4a41885e36e6a877701cf4eb78df962db1aede6ea6db18c63',
  '7b6cd9a5fe37284336e3b44c8243161782c5c69e94d53f0ac75a1da2f4189ea2',
  'f2b5f51ac7aed9f94923c1a46d77d24b8d8773f23b04693abadd8d20c0b66ded',
  'a54f21d7843d59fb184ae87355cf32bf979f259c56aa9c4181279a9b0a492eb0',
  '7f5140f92ff3327dc19cd4196bd7b0efc1affdb857adbea61fc4d34547101093',
  '7a6ab45b5d1f60a71137fae8528aa6c36929ffce4e9f3e3ff92a5ab5dad371ec',
  '9335da4a3edba5c9b58db751f934000b9b9e31ea6d518a75fe851d997c49c337',
  '395510e6741be17ad69e838279597fd17bbc2543ea77b10a336f71974804e73c',
  'a50cb41a3c301fadfe2aa65cc092f58b9ec37560fcf35e0ccb4fdd308ac58633',
  '299af1fa97b80a53e657196e4c0416bdbb5c847adf95baf0d55b27769da2fcf5',
  'cc19bda9bc4970b1fe9c8c37ac81805b708854845f30ca927fc98060cfe16fcc',
  '0315f699a7890efd945b7c6de132a8c95da409a20a801d3cb1ceb0218e65447e',
  '07d01bfe2200cb95de004f0ffb4e20c6a21fde0ad455b1b8a1a73683de817893',
  '825702df5a370b7a17f8c7057faf10a486f841e0419b491a6d9886e935d1bae3',
  '4ff2035cfc714a5fd1611c1cc7b1e6e53065acc97e61da71ed5ed34eac07d3cb',
  'a8b394c4d2d0948fef147ebc4f46625dcad7cf1d8a6b6413ad2a17bc3f1180c6',
  '8938e7a7cd0756ed4b57ec3c357f8bec610019f24a703041a2218694c54da023',
  'cbb9ff9d9a1ffcb09d1cee2568477da52171257310190a966704ef02ec8449b9',
  'da4091e3f04db511921b3ca4275ea2f90b91dd4bb02e2d0130a26efea6445485',
  '4af84d802c793adac1773c8755166d9f8634e6db3ca6aaeb6e4548e13c91fba4',
  '8b85d4839f15068da6227e13930d7c309b2e715b23fcb772108757894988b236',
  '7485c9938924b962429ee45114f3096a83866b4b075276bdb7f3a2ceb8bc951f',
  '5b7d792bec736e437320e64364cfd1ada6c395997223f18275cfb0f1eda3a455',
  '470a3ff3a9c27682be9f406dfaa0d2a607df55f5c48d0434fbabbcad93c543b7',
  'c7d8b353df00b65440e79d18f3d759f51838c9c56d8a68323c0826a747065fd1',
  '96bb1fbf2d91a1538151d074aa65f28e77139d8c4c7c3dd5aaeda45af0f1c7e6',
  '861bad86898fa54255040ce5248aa4faec3d1f369adef77962dbc2ce5c32ef0f',
  'a19753b0a798a4ad716ba4658cee38e424fcf14f959aee4b662176fbced5ea0d',
  '3f6c67302b82f2c4fb54d824a2a2d7b8c8269600b11222f7bd58250a7b8fd6bd',
  'eca4d856c59db2f3f8cdc6403a2f2e300a587c26162327f37e5b9826f37cd2b5',
  'b8e22cd412c5df063b1a09cf622432c34fd7a4391a324da690cc8017f10d8b3a',
  'e086ac38f8f1d67e40508054c10fa1d6cc54de1682a110f3ec69132f19ad2ad3',
  '0e754e34ffca43f2b3664fef5a6499a2400165504866b3cd288c52f6d5abc82f',
  'b49b656cda85966ff749b222ef77f3d730f1fe0da9db1a401e24ea806d457201',
  '788299d3730f191dfe02ad1846bdec14279b5225d6459c7091969a64985e28ca',
  '8d2a6c1478ebe11dfa3140f480c3a3fc9913f415990b03afa94515367c05365e',
  '047d94c2f67653e23d8887e0239624ab64561858217563455c05109e23822610',
  '1687ab1d338708970da475de34c48bd521243398185406eb2ef7b1acc3e10b43',
  'adb78aa4b85d629a880c0c7f0f874718dff1a474e1b834c24e92fb1976841062',
  'abe1cbb46f12d3a269fc128fb83f5b287105308269db6f590b43c7d205cdd7c3',
  '71886ca680c8b76a450d1059551c38a2af4fc675f9ee9a4e7350a65382a2cf74',
  '861211bee43c741b765bacd37c6b59a5314a3b0947f4648a9e37c670fdae1509',
  '38cfdbdc14e07316e287dff3edc60e619d11daf738c65db82b8aa05d0a249fa0',
  '4d6febf7debd5999c73c524022673a940a38bd29bb0b48a93f6073ac337a4a03',
  '45f4ec042542f61176391e38269168100081c0f8ed5359d6ec6477ca3fc99959',
  '2eb4744fd057f03b9d4494108996f38893b733de08905930abc096ae9b8ce9a9',
  'fe36191c7b1782d7a1cf48618eb1eefde90d26d0a43fa25b69c631832e9eb86e',
  'd634327ceb1f319998d4d63d01855eecb177ad37368649b7dd9e81840c16b059',
  'cd9d78722a4700231e0f58efd594403df5b9a727b906bd6c141860912c342861',
  '8943ea4750d1f30f1530f19e8187629c26998bc7816444d80ecaba4bb9efb1d8',
  '9dc2493c41da02db52cf7ef1888cfc79a86e3249a1f1091dd26116a0c1b0fb9b',
  '5fe4f47a1e26adc84a092ca0cee9c13fe959df1a76fef9291f5103d5c6d9aecf',
  '01c249196542da24e4924634a66646bff1676b716e9f3e83b4c49c2114c4543a',
  '0feb314c2faa083c182aee7b3c32e1a92b838f6448504518616801f9a9ad3d8e',
  'c1bbe93bb25f30e922360282d860998cd3b8e0c76d07fc309b0e501169018d76',
  'af6b9d07f31b57597e025a2043e916e957e8566dd84009195dd66d0554e95117',
  'b71d7404802f6acfb20f1afb9fef86cfd9c2826a23dbc8dd57a1a527180d9aa4',
  '5335cd7c105ed47bee032c60510c27432fa84414ab2eaf58f12b1b80e5b7a9ed',
  '474c13763714b0381dc229c5cb7687a51e20741c4e68f0a7f4dfa70b8cf25ac2',
  '47a8aebe69ccb28d9b72bc6081df3a54e0b2693f127f216f4588ef27de72bd8e',
  '1b026e1909a7ff6dbaade2cdafb1b4939bfbb23b6f40ad9dfaceda3096eb2fc8',
  'ed1f573d0fd382da920de21740493d50ccb4976b4d78d75d3078371ec34cf8e5',
  'a2d2ef35ccd9516f4309dedd8d86d1253585f780aa66aabaf3c488dcca5322e3',
  'debf3624a0830c9bc8c3ad3dcd4684520c0534c5754ed53122c094daebc5df81',
  '1e559430882501d057b27c70e83a467ab5552e433462fbd9771333e4130ae895',
  'f703a80d60485532e03890aa3ea1043d71a15ae313b76508bc9aceb3a4ac2c91',
  '29d5e30d7de785de32ce8b53cfef589807972fd4ce10fc73a0737733ed22ae0c',
  'cffade17dffb1e1f016ff415e829c2ca742218292739971838e40092676ff22d',
  '69230aa4d2de8e32c831c45eeb14a15e2376bbbe3ae9f52d8f429d8f7d7543b5',
  'a611a6a09190e0f832121019abfde6b02505af146798a508b4bc8255e56b8230',
  '31a35b95a853dd993e893bc6714c1a1b4310d6a27f349b7d3986bf69f03358df',
  'b25dee9cfc6e53a266981e8b005aae239fdaed7dfc9c0e398fb3ec9c21e8aaf8',
  '8593b3fcc3fec2ea5cf403ef9a48662e79450e5953429b962881c3b95efbfee6',
  '4bf828ccfe132a9247695f63fe54c387e81450eec0b3ec39c4e8787b69846a80',
  '9069dcec9e0b84677549a3ef815ce516697fec395fa8d86cb3a03cae18096d75',
  '5fa8be3fa090a52ead0aed5f6c8fadfd701bd25edee485a825c59044c0dbb8ea',
  'e1f89619dceaa39c09e036f7f73845251c33e6901500f8692f3304b90bd7389b',
  '283926e99f953825f6beb958a6a2638b568aee3cdbc9e658b1ec24878c856d48',
  'a5db7029151e97d7b8d400ef8a6160bc72b25fa1e23e323095e5077b572c8a0a',
  '46f14623e14faae6730508294beac0fa5e0a486b1292760b7f598a3095ccce20',
  'ab3e0314c1fea8cd54b17ed49c53fd224637bc6b4cb25069e66559ec28e6706d',
  'c7cbc3860edc9e748643970c0e096dd5a1a8f6d475745517ad19da52654b99df',
  '011ca2d52377fec52817c25118f4c9fe996a92a3f91c6efe84e5fc282039846c',
  'f09eac3ee32fe95d7b514594f1bde7607c18dda0981d92be132fcf1a0f7f6fc3',
  '8f0f641cbed1b949d6e4bb4fdbb824b2c36d11d622b71f1f10205b63c217f2e4',
  'e5f7608f07c00d5dbb2e026bdf38bd1396406af90e07bbb067f0562fc229dd34',
  'acb7d484f70c11029b3168619b6cafffebe3820136a9f3f9cfb91d4d037df242',
  'd67a18c35997a9e11d46b945b89d711b45e39fa161ebf9259c6a416ff1c2eeeb',
  'c463a3cd565319e7ed85ac35fb03ce6f67a9c492949f78dbd574d3f02a96fade',
  '3da17ef9f88369e5bfa8212884f0b2a5f8d7f77bda82ff2d3fd1f34ed965a98e',
  '2991b7bc1eaf971ce36bd539abe3dbd6c7207628689bf4e385df3529e190d78b',
  'a7b19e11fe648dd231f5be5f6afeaef32587995e5aaa7d5d2b05de06a3e4723a',
  '7b341618f5b7e86847f3754b41fdd759dc7f9b9f19e956036e6a3e461c06b5d5',
  '313b02d8dd3b040fefce75d8f30b0387048ab1cacb1bb939e9c26749a11f3580',
  'aa26796d6bb67b651647c53ed0204e3a3b5a4ab5a268c0a72fb78739dae3cbad',
  '9525e4704ac62ef94950804d47eaf25b6dfe7fdf2b2f31354c270e5fffbad713',
  '13444234875abab5021185aa85f66d8a92ffcba5f41d082317dcca9afd4c9699',
  '4f005cebe69d63cad3744bfa75fe9664aec74f23f389bd85eb8dd0d1c583cce0',
  '942c06d13cb6b48373c4023184ab24167848cab21eddf1249fd0664d0d1febd6',
  'e27578cc499948822b935c68aeffa545c6789da29cfed04678752dc4b3fc9ad6',
  'bc09fbb67bebedbdaf03fbd2040a12f5474ab3ac81d180a0e24d3f27da23c4f4',
  '797d5c55e3056e46030b51396fbe07b66c7578764cd288170b6019fbd89e6263',
  '677e05add4870b7a1fba63a6d9338fb65b86f206cf066770fb7abd6a5a89611f',
  '6d369eacd91d4cfafdff74a35e141aebb543fde2850f59f2b87a6746233ae6ab',
  'd2689d666c3888279401adaa9a4344a005686fbbe2dfd86d4da0ac1e435dbd85',
  '1664f35d4e27df85b614e911674b63105ceabc080d654ac0b2de9443cc766b69',
  'de3abf4748e19fc29d9fd3ab96ac64b92726a0d7508df91931c408fdc6d8b466',
  '918ce054b152a7c498de65a849974251872443e9d1a0d01b642194ebfd5cedc9',
  '9b71ed56d7cbdea4ea170d951f23c867ea63c6fe9e173c803a20f0ceef25045a',
  '4e550b36bd2824a4e384e518e8e3da56359afde82f84c4100294f1b32ac3fcab',
  '390c62f3552f3655b63d1826bd393da7ec3304b542179c205c97c0652c81d1a6',
  '81135e07549bac4a87801b78f60b811fe3b68da3be8a9411df7ab7cbdcfc0d3f',
  '4879bd3b2289f3454e2e30af6658f90b6cbbe9ff3cacda62afef3a62dadc04c9',
  '9c1d8d8f871777171d2db8ae21f82407e520c1dd310946a203a5ee13f9e5cfc4',
  '4513e8f47ec9b055b91e9a5a1c21b19c22aa1c8c30164e011a5d0fe443f444ac',
  '01087d4699cc181e9ba288a2241f8b457dced385d0886e36c883b74b4231a106',
  '8f05b3af3a4b8fa92f66d8accd95181f843a8ff32331e62a9c03ae9fe7c71d54',
  '830271ff52454a484d2f0f219aeacb5cbb0c292e9bf307c32ab6c0007d462330',
  '9f4f50e95fe00ec1504dfcf21b2d179ee3cb233f89adbaa2bc63adf7cec578c3',
  'd474cb1f7e6b4dea986f9c12104b3659186e13c1fbd0191ae957646cd8ae6b99',
  '9361ea7a2c5f17b2d139a7afc65b50d4d6fb20d1826c54054996c2b4798baa21',
  'e746177f5ab45550b4b004a0ea5205bc57ad35ced3fd422d1f508e0aa7a14332',
  'e106a97ffb3c8e0586ce6f05f84da9a2ae97079208711a2425bb800c9a4fa723',
  '195f8a41dbf3375db9a71406fb9db3ef18b3f746b45c4ed416047dd980da0433',
  '7579af412b3191ab2b5ec9c70837f9c870e6e0cd820d5ca9c8c47e5284730536',
  '36e86b3c39a89ab6ef81b9d76511918b50947fbc06d4e7a8efb744a606afc385',
  'e8d27090ec23c033b29dda003b0a52fc82c297a0266e88fb4b1258e924426886',
  'e636ce570cf83a7fac5adc362c5bf2f45782d4ab0f2bb387a8f0c27a0953cc4f',
  '6de8353f413f5da3fe93b766acf74dd13b7e7614b34877e3817e98703ffc71d6',
  '5c51a5e6464fddbc3b62e7af363d15982f7402ad1eca84fbd0f1ace31fe34149',
  'acc2c6f92779a53c8f4da9dc9577b7aba7c70517a2a3102084191c56ca3adf8a',
  'c856ad77eb3a73ec13ef6c3b3b87b4e73a98e9606c37fd338a4b27d4af1d5ac6',
  'c40ae2bccaad58e55aee067459b14c7f63b630234f5b44f7a6f77f318e4f0d34',
  '8206f0bf258498b0fd7df77814195dd95f3617c70ef01c5a8b550de40e7b0dff',
  'ed44a9667d14f1b45c021615b949a3d251e46304f91d19af28d7f4e81352bf95',
  '39a556fe068e242a4beee573bf4f9293cffaf4dd141c519fca9646644ac68bda',
  '7eeb3b0a353ea14e9b8cc26a0319ee774b03972e4315151c9f4f92a0e37e5d31',
  '17a3b1727e6ee95bc5f29d76320734ae90e479d0d8adb850d5ef4a98efe2fc69',
  'fd20a34c324bfdc9dbc8b2b157ea70e8bdbe730ca14215402d92b949177c3f45',
  '76bb4356a35582826d6bd4a645e0e4d0c9fa2cde5e5b931f2ce0738cd3b2f4de',
  '20f86fd7306be6323937fd123e9c8cd4c5f14e9ee713cd0c5f155d4b10c58b09',
  '068ea8bd970e61a9fa8941bbdba146eb14d0b6c9f5b1fe9a81a051da770187f8',
])

const units = packageSrcUnits(REPO_ROOT, 'backend')
const TABLES = persistenceSchema.tables.map((table) => table.schemaSymbol)

const key = (entry: { readonly table: string; readonly file: string }): string =>
  `${entry.table}|${entry.file}`

/**
 * 有 offered 边仍须记账的被重塑表站点（RFC-395 II-a 集中验证发现）：
 *   · 人工门 journal 被 task-execution 生命周期持久化反向 import，改走 owner public participant
 *     会形成文件级值依赖环（RFC-376 backend-value-scc，模块初始化 TDZ）；
 *   · code-capability 在 RFC-376 结构门里按物理目录计为独立 context，经 resource-catalog 闭合越出已提交 DAG；
 *   · runtime-management → resource-catalog 的值边会把 runtime-management 拉进存量上下文环。
 */
const OFFERED_BUT_BLOCKED = new Set([
  'tasks|collaboration/infrastructure/humanGateOperationJournal.ts',
  'agents|code-capability/infrastructure/capabilityMatrixRead.ts',
  'workflows|runtime-management/infrastructure/realtimeStore.ts',
])

describe('RFC-395 II-a A7 / RFC-317 T41 · R5 —— 一张表只属于一个 bounded context', () => {
  test('语料下限：真的扫到了 backend 的生产源码与 schema', () => {
    // 没有这条，下面「跨界集合等于账本」在语料为空时会以「两边都是空」的形式假绿。
    expect(units.length).toBeGreaterThan(700)
    expect(TABLES.length).toBeGreaterThan(120)
  })

  test('跨 context 的表引用与账本**逐条相等**（新增一条 ⇒ 红；修掉一条也 ⇒ 红）', () => {
    const actual = tableOwnershipCrossings({
      units,
      tables: TABLES,
      owners: TABLE_OWNERS,
      tableIds: TABLE_IDS,
    })
      .map(key)
      .sort()
    // RFC-395 II-a A7: compare the same exact key set with one sorting rule.
    expect(
      actual,
      '要么这次新长出了跨 context 的表引用（去补 public 端口），要么某条债已还清（把账本里对应那条删掉）——两种都不该静默通过',
    ).toEqual([...OWNERSHIP_DEBT].map(key).sort())
  })

  test('全 registry 覆盖与只减不增；旧账本的精确表归属保留', () => {
    // registry 是归属的唯一声明：每张表都声明了真实存在的 owner（模块 context 或 platform 机制目录），
    // 而扫描的正是整张 registry（含 II-b 要重塑的 7 张），不是手写子集。
    const moduleContexts = new Set(
      readdirSync(resolve(REPO_ROOT, 'packages/backend/src/modules')).map(tableOwnerContext),
    )
    expect(TABLES.length).toBeGreaterThan(200)
    for (const table of persistenceSchema.tables) {
      const owner = tableOwnerContext(table.owner)
      expect(
        owner.startsWith('platform/')
          ? existsSync(resolve(REPO_ROOT, 'packages/backend/src', owner))
          : moduleContexts.has(owner),
        `${table.schemaSymbol} → ${table.owner}`,
      ).toBe(true)
    }
    for (const reshaped of [
      'tasks',
      'taskRepos',
      'nodeRuns',
      'nodeRunOutputs',
      'agents',
      'workflows',
      'clarifyRounds',
    ] as const) {
      expect(TABLES, reshaped).toContain(reshaped)
    }
    expect(OWNERSHIP_DEBT.length).toBeLessThanOrEqual(INITIAL_DEBT.size)
    for (const debt of OWNERSHIP_DEBT) {
      expect(
        INITIAL_DEBT.has(createHash('sha256').update(key(debt)).digest('hex')),
        key(debt),
      ).toBe(true)
      expect(TABLE_OWNERS[debt.table], key(debt)).toBe(debt.owner)
    }
    for (const debt of moduleDebt.entries.filter((entry) => entry.kind === 'reshaped')) {
      expect(
        OFFERED_CONTEXT_PAIRS.has(`${debt.module}->${tableOwnerContext(debt.owner)}`) &&
          !OFFERED_BUT_BLOCKED.has(key(debt)),
        key(debt),
      ).toBe(false)
    }
    // 例外逐条精确：每条都必须仍在账本里（闭合后连同例外一起删除）。
    for (const blocked of OFFERED_BUT_BLOCKED) {
      expect(OWNERSHIP_DEBT.map(key), blocked).toContain(blocked)
    }
  })

  test('每条债都写了 why 与 removeWhen（写不出出路的债不该记）', () => {
    for (const debt of OWNERSHIP_DEBT) {
      expect(debt.why.length, `${key(debt)}.why`).toBeGreaterThan(20)
      expect(debt.removeWhen.length, `${key(debt)}.removeWhen`).toBeGreaterThan(10)
    }
  })

  test('账本里没有重复条目（同一 (表,文件) 记两次会让「只减不增」失效）', () => {
    const keys = OWNERSHIP_DEBT.map(key)
    expect([...new Set(keys)].sort()).toEqual([...keys].sort())
  })
})

// ---------------------------------------------------------------------------
// 负向 fixture —— 证明判据真的会咬，且咬的是**声明的**归属而不是推断的归属。
// ---------------------------------------------------------------------------

const OWNER_UNIT = sourceUnit(
  'packages/backend/src/modules/alpha-context/infrastructure/store.ts',
  `import { alphaThings } from '@/db/schema'
   export const read = () => alphaThings`,
)
const FOREIGN_UNIT = sourceUnit(
  'packages/backend/src/modules/beta-context/composition/uses.ts',
  `import { alphaThings, betaThings } from '@/db/schema'
   export const peek = () => [alphaThings, betaThings]`,
)
const ORPHAN_FOREIGN_UNIT = sourceUnit(
  'packages/backend/src/modules/beta-context/composition/orphan.ts',
  `import { alphaOrphan } from '@/db/schema'
   export const only = () => alphaOrphan`,
)

describe('RFC-317 T41 · R5 负向 fixture', () => {
  const owners = {
    alphaThings: 'alpha-context',
    alphaOrphan: 'alpha-context',
    betaThings: 'beta-context',
  }

  test('外来 context 引用别人的表 ⇒ 报出来', () => {
    expect(
      tableOwnershipCrossings({
        units: [OWNER_UNIT, FOREIGN_UNIT],
        tables: ['alphaThings', 'betaThings'],
        owners,
      }).map(key),
    ).toEqual(['alphaThings|beta-context/composition/uses.ts'])
  })

  test('**只被外来 context 引用**的表照样报出来（这正是按引用推断会漏掉的那类）', () => {
    // alphaOrphan 归 alpha-context（registry 声明），但 alpha 自己一次都没引用它。
    // 按引用推断会说「它归 beta-context，合法」；按声明归属，它是越界。
    expect(
      tableOwnershipCrossings({
        units: [OWNER_UNIT, ORPHAN_FOREIGN_UNIT],
        tables: ['alphaThings', 'alphaOrphan'],
        owners,
      }).map(key),
    ).toEqual(['alphaOrphan|beta-context/composition/orphan.ts'])
  })

  test('自己 context 引用自己的表不算越界', () => {
    expect(
      tableOwnershipCrossings({
        units: [OWNER_UNIT],
        tables: ['alphaThings'],
        owners,
      }),
    ).toEqual([])
  })

  test('helper 只处理显式 registry 输入；生产调用必须传入整个 registry', () => {
    expect(
      tableOwnershipCrossings({
        units: [FOREIGN_UNIT],
        tables: ['tasks', 'workflows'],
        owners,
      }),
    ).toEqual([])
  })
})

describe('RFC-395 II-a A7 全表负向控制', () => {
  const table = {
    schemaSymbol: 'futureTaskSubjects',
    id: 'future_task_subjects',
    owner: 'task-execution',
  }
  const unit = (text: string, context = 'collaboration') =>
    sourceUnit(`packages/backend/src/modules/${context}/infrastructure/example.ts`, text)
  test('新增 successor 无需前缀或手写表清单即可被捕获', () => {
    for (const text of [
      "import { futureTaskSubjects as subject } from '@/db/schema'; use(subject)",
      "import * as persistence from '@/platform/persistence/sessionTables'; const t = persistence.tablesOf(db); use(t.futureTaskSubjects)",
      "import * as persistence from '@/platform/persistence/sessionTables'; type Row = persistence.PersistenceTables['futureTaskSubjects']",
      'db.query.futureTaskSubjects.findMany()',
      "import * as schema from '@/db/schema'; use(schema['futureTaskSubjects'])",
      "import { tablesOf as tables } from '@/platform/persistence/sessionTables'; const { futureTaskSubjects: subject } = tables(db)",
      "import { tablesOf } from '@/platform/persistence/sessionTables'; const first = tablesOf(tx); const second = first; use(second.futureTaskSubjects)",
      "import { tablesOf } from '@/platform/persistence/sessionTables'; use(tablesOf(db)['futureTaskSubjects'])",
      "import type { PersistenceTables as Tables } from '@/platform/persistence/sessionTables'; type Row = Tables['futureTaskSubjects']['$inferSelect']",
      `db.execute('SELECT id FROM "future_task_subjects" WHERE id = ?')`,
      'db.execute(sql`UPDATE future_task_subjects SET value = ${value}`)',
      'db.execute("DELETE FROM future_task_subjects")',
      'db.execute("INSERT INTO future_task_subjects VALUES (?)")',
      'db.execute("SELECT t.id FROM other t JOIN public.future_task_subjects f ON t.id = f.id")',
      'db.execute("SELECT o.id FROM other o, future_task_subjects f WHERE o.id = f.id")',
      'db.execute(sql`DELETE FROM other o USING future_task_subjects f WHERE o.id = f.id`)',
    ]) {
      expect(referencedPersistenceTables(unit(text), [table]), text).toEqual([table.schemaSymbol])
      expect(
        tableOwnershipCrossings({
          units: [unit(text)],
          tables: [table.schemaSymbol],
          owners: { [table.schemaSymbol]: table.owner },
          tableIds: { [table.schemaSymbol]: table.id },
        }),
        text,
      ).toHaveLength(1)
    }
  })
  test('注释、普通字段和纯 DTO 类型不是存储访问；code-capability 按 development-automation 归域', () => {
    expect(
      referencedPersistenceTables(
        unit(`// SELECT * FROM future_task_subjects
      const dto = { futureTaskSubjects: [] }; use(dto.futureTaskSubjects);
      type Row = { futureTaskSubjects: string }; const name = 'future_task_subjects'`),
        [table],
      ),
    ).toEqual([])
    expect(tableOwnerContext('code-capability')).toBe('development-automation')
    expect(tableOwnerContext('code-capability/history')).toBe('development-automation')
    expect(
      tableOwnershipCrossings({
        units: [unit("import { things } from '@/db/schema'", 'code-capability')],
        tables: ['things'],
        owners: { things: 'code-capability/history' },
      }),
    ).toEqual([])
  })
  test('相同扫描器可用于横向目录，但模块账本不吞并后续目录的债', () => {
    const horizontal = sourceUnit(
      'packages/backend/src/services/example.ts',
      'db.execute("SELECT * FROM future_task_subjects")',
    )
    expect(referencedPersistenceTables(horizontal, [table])).toEqual([table.schemaSymbol])
    expect(
      tableOwnershipCrossings({
        units: [horizontal],
        tables: [table.schemaSymbol],
        owners: { [table.schemaSymbol]: table.owner },
      }),
    ).toEqual([])
  })
})

// RFC-395 II-a A7 part 2：横向目录无 owner，全表扫描不按目录豁免。
// 仅下列具体文件/表属于 design §2.1 的全局机制；业务访问另记只减账本。
const GLOBAL_INFRASTRUCTURE: Readonly<
  Record<
    string,
    {
      readonly tables: readonly string[]
      readonly why: string
    }
  >
> = {
  'cli/rfc295-downgrade-audit.ts': {
    tables: ['tasks', 'workflows'],
    why: '只读降级诊断，核对当前库的 Task/workflow 兼容性，不参与业务查询。',
  },
  'db/client.ts': {
    tables: ['authLoginPolicy'],
    why: '迁移后的内存数据库夹具初始化；只设置既有 bootstrap 标记，不提供领域业务操作。',
  },
  'platform/events/committed/appendProgram.ts': {
    tables: [
      'committedEventAggregateHeads',
      'committedEventDeliveries',
      'committedEventFamilyCutovers',
      'committedEvents',
    ],
    why: '平台 committed-events 机制：原子追加、聚合序号和消费投递。',
  },
  'platform/events/committed/appendShared.ts': {
    tables: ['committedEventFamilyCutovers', 'committedEvents'],
    why: '平台 committed-events 机制：家族路由与持久事件身份。',
  },
  'platform/events/committed/deliveryPersistence.ts': {
    tables: ['committedEventDeliveries', 'committedEventFamilyCutovers', 'committedEvents'],
    why: '平台 committed-events 机制：消费投递、游标和重试状态。',
  },
  'platform/persistence/hostedInstallationSeed.ts': {
    tables: ['authLoginPolicy'],
    why: '全库迁移播种，从刚迁移的源库复制 registry 各表初始行并标记一次性完成。',
  },
  'platform/persistence/portableApplicationAssets.ts': {
    tables: ['tasks', 'workflows'],
    why: '全库便携备份/恢复的应用资产附件，按原有选择规则导出工作流和工作区。',
  },
  'platform/persistence/sqlite/systemProviderRestore.ts': {
    tables: ['recoveryEvents', 'skills', 'tasks'],
    why: '全库恢复入口，重建工作区、核对技能引用并记录恢复回执。',
  },
}
const INITIAL_HORIZONTAL_DEBT = new Set([
  '32de5c2fab6461974b24057f2f511d590153532595f8d0a5a2b31dccbb441362',
  '0721bd86f193a04a75f5bbb12962be99e11204aedc37652581ed018dc6f2b8ec',
  'a351ec5b85a700108e8d70f62e25f6ebdb449ef16f9ce76b390f2a8becd4046e',
  '9c82c7b5707010e122f1377126c3cc41d8d40ef5c4f69221e4b8d82be42ba617',
  '85fc421cfc82ba35301257e37226938bce9cac42beadf4e5e33dc695fa9c114f',
  'ca825243ba4a6919ce5e75d0eb1c1280abd29221f0c2b9e7471dcbb92bb18980',
  '3a8c11b03a6c144bec14c452f8edf1ca1062a5b54c08eedaa536edf14989eb5d',
  '8f8ea47a4e1eb1d11aea84fec7eb49de0ece82efe3240ddd704658c08fe59fdd',
  'ba36fed887b7d43d615136e6d75e5a48b2180541f3b7253ed9f3cd875760ef67',
  'ab57bb8831e36d642eb29a1aa25713641cc4cbfc70433f0703eb490c9c6118a0',
  '1a649fd8e797c50f50850e590b549d9481bb61543fa710516953e31aad296156',
  'a4287a5bdd5231bea8f76dbce5bd2d826c21509d325b966ce0bffd7782baaaa1',
  'b1d81be14a416759a3f3d3b24a2fb9ed08676be4e59a7fd13dc75ada45430f79',
  '4dbb88675a8e54812114a1b33167498f0888852d27753540219424647a3432d1',
  '0215cc2a25d2d6fd535090cd204f9984c4f28acb108ede1d9fdab8dfd1fde9cf',
  '9fb61fc7216d9547b2f76224d9e3b4c53dec08f65a86f185ea7637435a0fb35a',
  'b9e62cdb4cb1651d320e01b56fc21c815d21f857dce6cd02b1106f2ed2f3179d',
  '324543e575869669ca7b2988f4a6b80d3704636fe0546e118dc0a9c5c80faeb6',
  'b898e665ce589e898572cedb4dec717985bdf8051e342d30b65bd0cb0569e49e',
  '1bfb79895f98a978c9cfc0f6c0eac593c0fab02bd536f7b8f490b9fff4e27f02',
  '064fad8601b1ef26b9e2b6bdedf7e6f0d8cd6f630daec86e1c56d083bff71c26',
  'bcebfa6fd8ecbf43608d6e44d48598d2604b797b82b892e67002ac29339cde55',
  '78c2a041c26a77bd8b2a7c696eea8d5982e77aac12932622d8a704bcf3b078c7',
  'f3b9d7d07a1d6d30e7e2090e60c163f2f4aa97506eb092f9da412bbff52b1e91',
  '94b104c00972767851fd46036796eccdd5a81b8b4b17ae07134d49fa7649efec',
  '8b1501f85e8a411632f5a4c28a4292fa99be50ae403943f49191adfac3a58a47',
  '8f52ce4d0fec5afc81c7deab99a26f65f30b79c9da483474bed2f14a970717f9',
  '87197e8b39194c2dcc7a45afa15118b1fc94aab7157df71fe96d2835fac9be19',
  'f9bb8dd6844f3822a4710393cc5d40a35d5f6ad9a0fd52403788509a56bcc7de',
  'e114e585b2b0fab881e37a1a0d2b2e2d19273f428982e40465c4a6854e213024',
])
const horizontalDebtKeys = horizontalDebt.entries.map(key)
const globalInfrastructureKeys = Object.entries(GLOBAL_INFRASTRUCTURE).flatMap(([file, entry]) =>
  entry.tables.map((table) => key({ table, file })),
)

const horizontalDelta = (sourceUnits: typeof units) =>
  ownershipReferenceDelta(
    horizontalTableReferences(sourceUnits, persistenceSchema.tables).map(key),
    [...globalInfrastructureKeys, ...horizontalDebtKeys],
  )

describe('RFC-395 II-a A7 part 2 横向全表引用闭合', () => {
  test('扫描全部非模块源文件，基础设施与债务恰好覆盖每一个引用', () => {
    expect(
      units.filter((unit) => !unit.path.startsWith('packages/backend/src/modules/')).length,
    ).toBeGreaterThan(600)
    expect(horizontalDelta(units)).toEqual({ unexpected: [], stale: [], duplicates: [] })
    for (const entry of Object.values(GLOBAL_INFRASTRUCTURE)) {
      expect(entry.why.length).toBeGreaterThan(20)
      for (const table of entry.tables) expect(TABLES.some((symbol) => symbol === table)).toBe(true)
    }
  })
  test('横向账本只减不增，归属与 registry 一致，每条债都有明确退出任务', () => {
    expect(horizontalDebt.entries.length).toBeLessThanOrEqual(INITIAL_HORIZONTAL_DEBT.size)
    for (const entry of horizontalDebt.entries) {
      expect(
        INITIAL_HORIZONTAL_DEBT.has(createHash('sha256').update(key(entry)).digest('hex')),
        key(entry),
      ).toBe(true)
      expect(TABLE_OWNERS[entry.table]).toBe(entry.owner)
      expect(String(TABLE_IDS[entry.table])).toBe(entry.tableId)
      expect(entry.why.length).toBeGreaterThan(20)
      expect(entry.removeWhen).toMatch(/^RFC-395 /)
      expect(globalInfrastructureKeys).not.toContain(key(entry))
    }
  })
  test('任一横向目录的新文件同样报红，包括 platform/persistence/sqlite', () => {
    for (const directory of [
      'auth',
      'cli',
      'db',
      'platform',
      'platform/persistence',
      'platform/persistence/sqlite',
      'services',
      'routes',
      'mcp',
      'ws',
      'server',
      'util',
      'bootstrap',
      'future',
    ]) {
      const file = `${directory}/new-store.ts`
      const unit = sourceUnit(`packages/backend/src/${file}`, 'db.execute("SELECT id FROM tasks")')
      expect(horizontalDelta([...units, unit]).unexpected).toContain(`tasks|${file}`)
    }
  })
  test('允许的机制文件不能借文件级豁免增加业务表，克隆机制文件也报红', () => {
    const file = 'platform/events/committed/appendShared.ts'
    const current = units.find((unit) => unit.path === `packages/backend/src/${file}`)!
    const replacement = sourceUnit(
      current.path,
      current.text + '\ndb.execute("SELECT * FROM tasks")',
    )
    expect(
      horizontalDelta(units.map((unit) => (unit === current ? replacement : unit))).unexpected,
    ).toEqual([`tasks|${file}`])
    const clone = sourceUnit(
      'packages/backend/src/platform/events/committed/clone.ts',
      current.text,
    )
    expect(horizontalDelta([...units, clone]).unexpected.length).toBeGreaterThan(0)
  })
  test('陈旧或重复例外均报红，移走债务不能用新路径顶替', () => {
    const debt = horizontalDebt.entries[0]!
    const actual = horizontalTableReferences(units, persistenceSchema.tables).map(key)
    const allowed = [...globalInfrastructureKeys, ...horizontalDebtKeys]
    expect(
      ownershipReferenceDelta(
        actual.filter((item) => item !== key(debt)),
        allowed,
      ).stale,
    ).toEqual([key(debt)])
    expect(ownershipReferenceDelta(actual, [...allowed, key(debt)]).duplicates).toEqual([key(debt)])
    expect(
      INITIAL_HORIZONTAL_DEBT.has(
        createHash('sha256')
          .update(key({ ...debt, file: 'services/replacement.ts' }))
          .digest('hex'),
      ),
    ).toBe(false)
  })
  test('未来 registry 表无需编辑扫描器；模块引用不计入横向账本', () => {
    const table = { schemaSymbol: 'futureTasks', id: 'future_tasks', owner: 'task-execution' }
    const text =
      "import { tablesOf as read } from '@/platform/persistence/sessionTables'; const { futureTasks: task } = read(db)"
    const horizontal = sourceUnit('packages/backend/src/bootstrap/future.ts', text)
    const module = sourceUnit(
      'packages/backend/src/modules/task-execution/infrastructure/future.ts',
      text,
    )
    expect(horizontalTableReferences([horizontal, module], [table])).toEqual([
      { table: 'futureTasks', owner: 'task-execution', file: 'bootstrap/future.ts' },
    ])
  })
})
