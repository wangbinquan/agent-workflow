# RFC-455 实施计划

**前置**：RFC-454 落地（`ad9c97550`，CI 修复 `95aff68c5`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后
集中验证一次；不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                         | 依据          |
| ---------- | ------------------------------------------------------------------------------------------------------------ | ------------- |
| RFC-455-T1 | `decodeZip` 解码段从 `legacy/skill-zip.ts` 拆进 RC `domain/zipArchive.ts`；skill-zip 改取 domain             | design §1     |
| RFC-455-T2 | 依赖规划与回执、两个修订摘要迁入 RC `domain`；intent 经 RC `public/queries` 取修订摘要                       | design §1、§2 |
| RFC-455-T3 | 算法层 11 个文件迁入 RC `application/package`；读端口只留 `ports.ts` 一份；`isVisibleRow` 改取 domain 声明处 | design §1、§2 |
| RFC-455-T4 | 执行适配器与插件安装绑定迁入 RC `composition`；bootstrap 改取                                                | design §1、§2 |
| RFC-455-T5 | 用例 import 改指、随迁文本锁、守卫表与账本、guard-manifest；新增 RFC-455 用例；文档现状路径                  | design §3     |
| RFC-455-T6 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                                        | design §6     |
| RFC-455-T7 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（W9-D）、RFC-345 plan（T6 余项）                     | —             |

## 验收清单

- [x] AC-1 16 个文件迁出 `services/`、零引用；`decodeZip` 一份定义
- [x] AC-2 架构计数按实测（`services/` 123 → 107、`R1` / `R2` 下降），越界类计数不升
- [x] AC-3 受影响用例与新增用例全部通过
- [ ] AC-4 exact SHA CI 全绿

## 集中验证（2026-11-06，候选基于 `b9057dacc`）

本机全程高负载（负载 30～81）。验证都在候选导出仓库里跑（`b9057dacc` 的 `git archive` 加候选路径，提交后运行，删光的目录一并删掉）；
集中验证中的修复同步进导出仓库后，核对 114 个候选路径与 guard-manifest 与工作树逐字节相同。

- **静态**：`tsc`（backend）0 错；eslint `--max-warnings 0` 无告警；改动的 TS 与 JSON 已按 prettier 格式化；`guard-manifest.json` 刷新
  受影响的 5 个守卫的行数。
- **本 RFC 的问题，已修**（全量 SQLite 与 PostgreSQL lane 都查出，tsc / eslint 看不见）：
  - `rfc345-provider-neutral-classic-facades` 的 skill ZIP 路由锁读留下的 `legacy/skill-zip.ts`，断言其中有 `export function decodeZip`——
    解码段拆走后落空（文件还在，所以按路径搜不到）。改读 domain `zipArchive.ts`，并断言 skill-zip 改取 domain；
  - 新用例的 zip 穿越一例用 `util/zip` 的 `encodeZip` 造样本，而编码器自己就拒绝 `../`，抛错的是编码器、`decodeZip` 没跑到。改用 fflate
    `zipSync` 直接打包，断言 `ValidationError` 的 `zip-traversal` 码。
- **全量 SQLite**（导出仓库里 `bun run test:backend`，四分片，分片时限 2 小时）：4675～5593 s 全部跑完，合计 23422 pass / 127 skip /
  58 fail，另有 36 条测试间未处理错误。55 条是超时（23 个文件；52 条撞默认 5 秒，RFC-354 嵌套帧闭包、RFC-363 目录分页与 RFC-321 托管发布
  smart-HTTP 各一例撞自带的 30 秒），36 条未处理错误全出在其中 12 个超时文件里，是超时用例被拆除后仍在跑的异步尾巴；另 3 条是
  上面本 RFC 的两个问题与导出仓库只有候选提交所致的 `rfc321`。
  - 修复同步后，失败的 25 个文件（23 个超时文件加修过的 2 个）逐个复跑（30 秒时限）：23 个全过，合计 246 pass / 2 fail。余下两例都撞
    用例自带的墙钟等待：RFC-167 dw-confirm 的 `approve`（自带 5 秒 `settleTask`）与 RFC-363 目录分页（自带 30 秒）。对照：同一时刻在
    RFC-454 的导出仓库里跑同一文件，失败的是同一例（5.8 s 与 5.6 s；30.6 s 与 30.6 s），其余用例两边都过（RFC-167 这一例 RFC-452～454
    集中验证时也是如此）。
- **导出仓库接 PostgreSQL 真库**：第一条 lane 340 个文件（全部 139 个架构测试；RFC-270 / 271 与 RFC-45x 的用例；提及资源包、依赖规划、
  修订摘要、skill zip、原子应用、intent 清单、MCP 诊断与运行时测试、三个装配根的用例；改动的 57 个用例文件全在其内）：320 个文件全过，
  合计 4065 pass / 44 fail / 4 skip。20 个文件失败：上面本 RFC 的 2 个；`rfc321`（同上）；14 个只有超时；`rfc238` MCP 运行时测试服务
  （5 秒超时后的连带）、`rfc370` MCP 诊断一族（自带 2 秒的 settle 等待）、`rfc401` 资源包租约续期（负载下租约先到期，`cas-lost:lease`）
  三个是负载下的墙钟等待，三者的 SQLite 一侧都过。
  - 修复后复跑失败的 19 个文件（`rfc321` 除外；30 秒时限）：18 个全过，合计 264 pass / 4 fail，4 例都在 `rfc238`（用例自带的 2 秒
    `waitFor`）。对照：同一时刻在 RFC-454 的导出仓库里跑同一文件，两边都是 49 pass / 3 fail，其中两例相同、各有一例不同；失败的用例
    随运行变化（第一条 lane 6 例、复跑 4 例、对照 3 例）。`rfc370` MCP 诊断一族与 `rfc401` 资源包租约续期复跑通过。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，另一份同内容的导出仓库，两引擎分开跑）：SQLite 17 个阶段、PostgreSQL 17 个阶段
  全部符合预期（0 failures；PostgreSQL 一侧等负载降到 30 左右再单独跑）；两次运行前后 127 个受保护源文件的哈希一致。
- **RFC-321 发布账本**：工作树里 10 / 10（导出仓库只有候选提交，该用例在导出里恒红）。
- **文档用例**（RFC 索引状态、设计与实现对齐、RFC-294 设计对齐与两条评审规则、测试套件策略、`rfc376-report` 等 11 个文件，
  加 RFC-455 用例）：在最终文档上 99 pass / 0 fail。
- **计数复核**（`scripts/architecture-report.ts` 在两份导出仓库的提交上采数，c454 → c455）：`services/` 123 → 107 个 TS 文件；
  `legacy-horizontal-files` 244 → 228、`legacy-service-implementations` 118 → 102；`R1-inbound-module-internals` 121 → 119、
  `R2-outbound-module-to-legacy` 29 → 27（账本与实测相等）；public surface 新增 2 个导出（`mcpOperationConfigHashOf`、
  `pluginOperationConfigHashOf`，闭合的 shared 类型，偏差数不变）；其余 counts 都不变：off-DAG 值边 0、值环 0、平台 → 模块 0、
  跨 context 内部文件对 48、off-DAG offered 文件对 55、`module-layer-violations` 1、不可达生产文件 27。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 迁移的声明逐个比对（TypeScript AST 取顶层声明，`b9057dacc` 的原位置对工作树的新位置）：16 个文件与 skill-zip 解码段的 162 个顶层
  声明逐字相同；留在原处、只改了 import 的 `legacy/skill-zip.ts`、`resourcePackageAtomicApply.ts`、intent `application/manifest.ts` 的
  67 个顶层声明逐字未变；
- 读端口合一：`providerReadPort.ts` 的 `ResourcePackageReadPort` / `ResourcePackageResourceSnapshot` 与 `application/package/ports.ts`
  的同名合同逐字段相同，删掉前者后所有实现与消费方的类型检查不变（tsc 0 错）；
- 消费方改指只换 import 路径、导入名不变：生产 8 个文件（bootstrap 三个装配根、原子应用场景适配器、MCP 诊断两处〔含一处动态
  import〕、skill-zip、intent 清单），用例侧 46 个文件同样只换路径，按路径读源码的锁改指新位置；`packageSkillTree.ts` 只改注释里的
  路径；intent 取的两个修订摘要经 RC `public/queries` 导出，就是 domain 那一份（新用例恒等断言），且与 shared 的 Web Crypto 版本逐例相等；
- 两个装配绑定只被 bootstrap 用，迁入 RC `composition` 后 bootstrap 的装配顺序与参数不变；
- 集中验证查出的问题（见上）已修并复验。

## PR / 提交

单个提交：`refactor(backend): RFC-455 资源包一族归 resource-catalog（RFC-294 W9-D、RFC-345 T6 余项）`。走私有 index、按路径清单提交，
在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
