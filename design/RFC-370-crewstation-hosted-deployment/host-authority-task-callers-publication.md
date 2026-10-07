# RFC-370 Task 原受理、心跳与收尾的配套发布

C2-W1 将选定宿主的原 Task 受理工作传递到原 claim、heartbeat、driver 和最终清理。原工作保持其 generation、方法、receiver、收据与完成确认；没有把业务资源编辑和 Task 执行待机合并。选定路径停止新动作后，已发结果继续沿原工作落账。失败 claim、driver release、workspace 回执及重试分别保留实际完成进度，清理未完成时原 drain 继续等待。native 的完整原分支与业务错误顺序保持。

当前只完成 C2-W1 的有限实现候选。C2-W2 业务写入与 effect 分类、19 个运行句柄、三个装配入口、状态 UI、A-T7／A-G 和 CS M0～M4 仍未完成，AW 尚未部署到 CS。

## 功能门与原回归保留

D3、D5、D6 的真实设计 PASS 在对应生产改动前由 root 实际消费。原 SOURCE23-R1 有效 FAIL 保留：停止计时器不等于等待已经发出的 heartbeat 写入，旧 revision 可能在 PostgreSQL writer 提交后使收尾持续失败。D6 在缓存原 owner revision 前，先等待原 heartbeat Promise，再等待原 owner 行上的真实 writer 事务确认；同步失败保留原清理工作，重试继续消费同一原对象与方法。

SOURCE23-R2 是稳定有限 PASS：23 owned／33 control／26 evidence，共82项、2,571,863 bytes；FP 为 `abaf575670b059adc85e9ec96aac1c0522886dafba713f3f7f4573e4fcfc0fe7`。实际回执 SHA-256 为 `0a93230d92063ce1cf416a51ba0fdd820b70f65ffe1f0bd49bb6dd59edb90324`，root 消费后才启动本批原架构生成。

五个测试文件保留原32个 provider case 的完整 AST、名称、断言和预算，追加四个真实双 provider 回归，共36个 case／provider。新用例覆盖原15秒 heartbeat 在途等待、原方法和 receiver 保留、真实 writer 同步失败后重试，以及实际 server COMMIT／ROLLBACK 晚于原 Promise 拒绝的两种结果。等待期间另一个原数据库连接可继续业务资源编辑。native 的90项纯 AST／字节证明保留；这不是运行测试的结果。Windows 的三套件注册保留原工作流全文与配对触发条件。

本机没有运行 AW tests、typecheck、build、services 或 E2E。正式回归以新精确提交的 hosted CI 为准，有限源码 PASS 不代表全仓 CI 已绿或已经部署。

## 一次原架构生成

本批只执行一次 original scoped census，固定原基线 `0b9358fc5878bc7cbf52f46def98b45daa746cd1`。输入叠加已复核的16个 production 文件（9个既有、7个新增）和5个测试文件；其余6714个非本批 TypeScript 源路径读取该基线的完整 Git blob。排除了当时四个并行生产文件的工作树改动。原四条生成规则全文保持，13份原始输出在投影前完整保留；不新增 checkout，不再次 census。

原 sourceDigest 为 `sha256:e595314a791643f1942e7cd4c5018a9bc87b6541cb3b960ef32ed2e82da591d6`。原 classic before／after 完整数组均为 inbound 0／outbound 0，逐项相等。原 authored debt 和所有129项有序 ledger 的 why、预算及其他字段保持；新增边按原 classifier 字段登记，没有把新增内容称为旧债。

实测新增92个 owner、6个 mutation 条目、净增5个 background 条目、1个 ambient 条目、8条 observed import、7条原 classifier exception，以及净增1个 transaction callback。原规则也记录了一个既有 mutation 的派生投影变化。两个 background 和三个 transaction 的物理行锚点移动；39个既有 Task 写入清单行只移动实际行号与包含行号的 ID，其余完整字段保持。两个原 quiescence transaction callback 由具名 issued-ACK helper 表示，原 native 事务体和结果保持；另增一个真实 owner finalization fact 事务。

既有 `HostExecutionAdmission` 增加唯一实际 Task composition 消费者。 原 `OFF_DAG_OFFERED_EDGE_DEBT` 的47条完整记录保持，本批新增该 Task→SO 的具名实际 offered 边成为48条；清偿波次和完整集合断言保持，ledger 如实同步47→48。C2-W1 原业务 public type、方法签名与字段类型保持，offered-edge 规则不改。并行提交将原 NativeUsageInvocationPersistence 从 types 移到 participants，并公开两项实际已消费的 factory／query 入口，本配套按其已发布输出登记。其他原清单内容和顺序保持。

| 原 ledger                      | 原 baseline | 实测 baseline |
| ------------------------------ | ----------: | ------------: |
| mutation-entrypoints           |        1958 |          1964 |
| transaction-callbacks          |         273 |           274 |
| background-jobs                |         369 |           374 |
| ambient-wiring                 |         504 |           505 |
| cross-context-observed-imports |        6815 |          6823 |
| architecture-exceptions        |        5982 |          5989 |
| module-symbol-owners           |       27465 |         27557 |

原七项变化仍完整保留；合入并行入口投影后，再加 public-surfaces 1238→1240、既有 public-consumer 135→141 及本批 offered-edge 47→48，共十项一次声明。普通后继将其退役，不再 census。另外核对现存 `UNCONSUMED_PUBLIC_SYMBOL_DEBT`：原 TypeScript 数组有141项，原清单和本批清单均为同一141项，ledger 的135只是滞后。本批修复 baseline 135→141，并记录一次声明，原债务数组和完整判据不改。共享 ledger 中另一会话的 `rfc359-w5-test-engine-hardcoding` 330→333、完整 why 追加及其他原字段全部保留。对方已发布 `33769f07e0594f0426fd2e5de1a2db0d02873e7e`；本批333不再增长，按原 highwater 规则在普通后继退役其已消费的一次声明。这一行不是本批新增能力。ledger payload 摘要使用原五个纯 JSON 函数重算；原13份输出继续保留；合入并行依赖后的13份投影另存，没有改写原输出。STATE／plan 只追加本批事实，保留完整旧前缀及并行输出。

配套投影第一次实际失败发生在把包含物理行号的旧 ID 当成稳定 ID 的核对上，尚未写入任何仓库文件。原失败脚本与回执保留；第二次投影只允许实际 owned 文件中的原行锚点移动，完整核对其余字段和有序清单，得到真实 PASS。该修正没有重跑原 census，也没有改动已通过源码门的82项输入。

并行提交的六个源文件只改 imports／exports 和注释，原全部运行语句经原 TypeScript AST 核对完整相等。本批使用原助手及原九个汇总对象表达式补齐依赖投影，先完整逆向复现唯一原生成的八个 canonical 对象，再投影这六个文件；没有再调用 architecture-census 或 buildCanonicalArtifacts。完整原 Task 写入／节点／effect 清单保持，保留全部129项有序 ledger 的 why 前缀及并行追加。综合 sourceDigest 为 `sha256:f1463af4ff160e4180faabea06b35698062cba2c4201d896408ec81186fcd8c5`，新增两项由已发布生产代码实际消费的公共 factory／query 入口；其余七项实测 baseline 数值保持。

两次依赖投影的私有包装失败均保留，分别补齐原汇总式需要的 repoRoot，以及通过原 registry 助手重建保有原属性顺序的 CodeHost 记录，第三次完整复现及投影实际 PASS；没有仓库源码写入或重复原 census。第一次应用检查在任何仓库写入前发现共享 ledger 变化，已无损停止；双方只做一次必要协调，先行提交现已发布。随后本配套要独立功能复核，再精确提交、远端同步和 exact-SHA hosted CI 各自验收。后续先完成 Task effect／业务写入，再处理剩余句柄、装配入口和阶段 A 总验收；通过后开始 CS M0 首次部署。

## 最终并行接口差额与配套 R2 候选

MATCHING16-R1 的真实回执是 INVALID：5 个 control 在并行接口修复期间漂移，两个原路径删除；冻结候选的 534 项功能核对通过、0 findings，但不形成当前候选 PASS。原回执和实际首末绑定完整保留，23 份 Task 源码及其 82 项 SOURCE23-R2 人口全文均未变，原源码门继续复用。

最终接口修复 `a443cba8776add749087e3524d50a34b6b776692` 已 exact18 上库，实际独立 SOURCE PASS、35 项原材料首末绑定与旧删除源全文已核对。没有提交本批共享 metadata。用同一原助手完成最终 15 份物理生产差额的有限依赖补投影，包含 4 新增和 2 删除；原 8 canonical 对象从唯一原 census 输出逐项全文逆向复现，原规则、九个聚合表达式及 Task authority／node／effect 账本完整保留，未再次调用 architecture-census 或 buildCanonicalArtifacts。生产输入从 3203 变为 3205，实际 sourceDigest 为 `sha256:3d9363a4dce2c5109b6f7dea3a60c65568c52e57146ea63c888b450a8f11bf3a`。

最终实测为 9 条一次性增长声明；原 129 项有序库存及 why 前缀、并行 333 行完整保留，只按普通后继退役其已消费声明。旧 public 基线 135→141 继续依据同一原 141 项数组和实际前后集合，offered 原 47 项逐字保留并只加实际 Task→SO 具名边至 48。旧六文件投影、旧 10 声明候选及 R1 INVALID 作为历史保留，不能用于发布当前候选。本 R2 仍待独立配套门实际回执消费，之后 exact39 发布及其精确 SHA CI；本机 AW tests／typecheck／build／service／E2E 为零，完整 H7／A-G、CS adapters 与 M0～M4 尚未完成。
