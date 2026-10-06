# RFC-370 Doctor 与启动恢复的分层 CI 修复

2026-10-06，承接已批准的阶段 A。本文先冻结有限设计；实现、独立功能门、发布与新 exact-SHA CI 另留证。当前仍未完成完整 H7／A-T7／A-G，没有 CS adapter 或 AW-in-CS 部署。

## 正式失败与修复范围

`21bc9a630e928282f825a82da240444d76c07a1c` 的主 CI `37480454971` 已出现以下实际功能失败；保留原日志及终态，不将 Windows `37480455083` 的 success 代替主 CI。

1. `rfc346-system-operations-contracts` 与 `rfc317-module-boundary`：Doctor domain 引用混有本地探针的 `services/gitVersion`。该纯规则必须有独立、无 IO 的叶层，不能用新增 domain 债务或放宽断言解决。
2. `rfc331-task-execution-topology`：start 直引 `application/ports/bootExecutionRecovery`。PG 的同一引用一起收口到现有 exact `public/types`，不追加深引用允许项。
3. `rfc359-w5-same-file-provider-pairs`：Doctor 的完整旧条款迁址后没有保持字典序。仅移动该完整条目，原十三条、裁决、理由、计数和两个精确断言保持。
4. `rfc349-provider-cutover`：provider 选择站点已实际迁入 Doctor local adapter，五条清单仍指旧 CLI。只替换这一地址并保持排序，原 scanner、业务依赖清单和断言保持。
5. `rfc317-ledger-highwater`：Doctor 测试的 `members` 是完整十步协议的有序输入预言，不是仓库扫描结果或债务豁免表；它命中已有集合形状分类。按原具名 `NOT_A_LEDGER` 协议登记理由，同时补原 exact key 断言，不改 classifier、扫描范围、任何旧条目或预算，也不将协议常量改写成扫描无法识别的形状。
6. `rfc294-canonical-manifests`：前批 ledger 的 provenance digest 未随旧增长许可退役更新。事件中心后继 `ecf503d0641b5750546b022efde5dcea5539514b` 已按原 provenance 函数重新投影；本片复核该实际摘要，后续元数据仍使用原生成和 provenance 协议。

## 纯版本合同与原本地机制

新增 `platform/contracts/gitVersion.ts`，只承载 `GitSemver`、`GitCapabilities`、五个原纯 value 出口（`parseGitVersion`、`gitVersionAtLeast`、`capabilitiesFromVersion`、`MIN_GIT_VERSION`、`mergeTreeGateError`）。这是无平台实例、无进程、无 filesystem、无数据库的共享版本值合同；不承载 Doctor 顺序或新的诊断决策。既有 `platform/contracts` 是 RFC-294 的叶层位置。

完整原接口、纯函数体、常量、阈值、错误文案和 `raw` 处理逐字迁移，只有一个实现。`services/gitVersion` 直接 re-export 原 value/type 名称，并 import 原探针需要的类型及两个纯函数。它继续唯一拥有原 `cached`、`GIT_PROBE_TIMEOUT_MS`、`detectGitCapabilities`、`getCachedGitCapabilities`、测试 setter；`runGit`、cwd、argv、20s、catch、cache identity 和 native 回归保持。

Doctor domain 直接消费纯叶层三个原出口，不再加载本地探针。原 Doctor application、完整十成员 factory、所有 selected/native 实现、格式及兼容 helper identity 不变。新增回归验证旧 facade 与纯叶层是同一函数／常量，并保留已有解析、三个版本阈值、Doctor、真实 native probe 和 cache 恢复用例。

## 完整启动恢复合同与读者

现有 Task-owned `BootExecutionRecoveryFactory` 经 `modules/task-execution/public/types.ts` type-only re-export；start 和 PG 仅替换 type import 路径。原接口、可选输入、所选四成员 factory、opaque 引用、原四阶段／getter／receiver／ACK／错误、SQLite／PG 根和 provider 重装配完全不变。类型擦除后的两个根及 public 文件运行 JavaScript 必须与前像逐字一致；W29、MCP 与全部原真实恢复用例继续锁原行为，不重新造 recovery facade。

## 实施、验证与发布

实施 allowlist 为纯合同、原 facade、Doctor domain、现有 public/types、两个 CLI 根、三份既有架构断言文件、Git capability 测试、本文件及必要 Windows／matching metadata／STATE。没有修改其它模块、观测在制品、任何扫描规则或预算。

Windows 按 push／PR 对称补新纯合同、原 facade、扩充的 Git capability 测试路径，并在原 native suite 命令中追加该 capability suite；原 workflow 全文可由移除本片新增内容恢复，原时间／单进程／所有旧 suite 保持。

本机仅 owned format／lint、纯 AST／字节／JSON 证明与当前候选原 scoped 静态生成；不运行 AW tests／typecheck／build／service。有限独立实现门验证实际差额；正式功能由新精确 SHA 的双 OS／双 provider hosted CI 给出。matching canonical 保留四条原规则、存量条款、129 有序 ledger 的 why 与全部原字段、214 guard 的判据、40 SPI／69 targets／Task effects 与原 SCC；仅按实际源码 retire 地址、更新真实计数和新增真实增长声明，正常退役前继已消费许可，按原 provenance 重新盖摘要。

发布仅精确 task 路径，保留并行内容和整个旧 STATE。原失败日志、候选和门回执完整保存。此片关闭上述有限 CI 原因后，继续实际根的 selected family、其它 purpose callers、完整执行权生命周期与 A-G，再实施独立 CS adapter 和 M0 首次部署、M1～M4；不据此宣告 RFC 完成。

## 2026-10-07 Boot 入口设计补正

上述首轮 `public/types` 方案的源码有限门已 PASS，但随后原 scoped census 在 canonical validation 正式失败：`public surface opaque type allowlist mismatch`。该失败及完整首轮候选保留，不算生成成功，不移除启动标记或重复同一 production 候选的生成。

Boot factory 是 bootstrap 所选恢复效果家族的装配输入，包含恢复 persistence、runtime leases、独占证明与内部效果配对；它不属于跨业务模块的 offered public API。改为在已存在的 `composition/bootRecovery.ts` 的原 type-only export 中加入原 `BootExecutionRecoveryFactory`，两个 CLI 将它并入各自原 boot composition import，保持 type-only。只移除本片自己在 `public/types` 新增的那一行；该文件须与原 committed 内容逐字相同，保留所有既有 public 合同。

原 factory 接口、恢复 input、四步 sequence、所选 native 实现、getter 时点、receiver、错误、结果 identity 与三个原 reader 都保持。四个涉及 source 文件的完整前后像、逐字逆向及类型擦除后的整个运行 JavaScript 作为补正证明；其余 SOURCE18-R1 候选和功能结论按实际完整字节复用。既有 Windows push／PR 已对称覆盖 boot composition，不改预算或扫描范围。

独立补正设计门先验入口职责与差额，补正实现门只验这个差额及原结论的复用证据。改变后的 production 候选才获得一次新的原 scoped census；四条生成规则、public opaque allowlist、所有原合同、debt 分类与 guard 均保持，不通过扩充 allowlist 或隐藏递归成员处理本次失败。新的 matching 元数据、共享 STATE、上库与 exact-SHA hosted CI 分别验收。
