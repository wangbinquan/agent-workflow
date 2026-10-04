# H4／H5 本机 Agent 材料与取证原体归位

这是已批准实施设计 §5 的有限源码单元，仍处阶段 A。它归位 native 实现；完整中立材料、执行和取证接口、三个实际入口及真根装配继续，不能记 A-T5／A-G 通过。

`opencodeAgentMaterial.ts`、`claudeAgentMaterial.ts` 位于 runtime-management 的 infrastructure/local。旧 driver 的 7 个完整 helper 与 12 个 physical 成员移入这里：双 persona/business 的物化及同一 declared 计算、usage/span、startup inventory/final events、native session sweep和live capture。完整函数／成员 AST 与已提交基准 `1f0a2dc17206108395995e5be6e9951224ebf291` 相同。

旧 RuntimeDriver 两对象、registry singleton／unknown-kind／display-degrade、所有纯协议和purpose成员保留；已迁移方法准确绑定native函数，旧helper名称显式re-export原实现。`Required<Pick<RuntimeDriver, ...>>` 仅是native兼容内部类型，未冒称neutral input，也没有把RuntimeDriver整对象作为新适配合同传给业务。

全部477个原ordered expect AST保持。原source oracle的引用位置跟随真实归位；旧转换／单一定义、实际Git mount/toolchain、config-dir和版本判据保持。5个新增断言证明两个actual native文件保留私有协议装配访问，其它应用／邻接文件仍遵循原boundary，原backend package约束也保留。既有双协议business/persona golden与两个boundary suite加入实际Windows平台通道；push和PR同时增加12真实路径，所有原step、budget、runner、Bun版本与SQLite设置保留。

独立SOURCE11有限PASS：`95a8580c1f73a9baec8fac675503d2f6dafc8099d1a4ab823bdb9baca316b8e3`。原scoped规则生成一次，sourceDigest为`sha256:0395d9f636a678230c6e3835f9fce854ec7c943e9b9ee522be196272374d3d05`，排除并保留所有并行WIP。原counter记录以下真实投影：

| 原账本                         |  原值 | 候选值 | 对应实际内容                                             |
| ------------------------------ | ----: | -----: | -------------------------------------------------------- |
| mutation-entrypoints           |  1873 |   1874 | 原OpenCode native对象成为独立实际实现入口                |
| module-symbol-owners           | 26651 |  26655 | 7原helper归位；两文件＋两native对象，11 added／7 removed |
| cross-context-observed-imports |  6138 |   6222 | 79既有依赖新可见＋8显式兼容引用－3旧capture入站          |
| architecture-exceptions        |  5439 |   5523 | 原classifier如实记录同一批仍未闭合的legacy links         |

每个native import的名字、type/value与resolved target均为原driver import的精确子集。26个facade只跟随真实边ID／inline definition归位；实际re-export API由AST独立验证。3个原public capture合同只改变consumer投影，字段／签名／预算不变；public1150、40required SPI及其它原集合保持。4原规则、全部129条原账本和why不变，仅4个真实增长行附一次性匹配理由并按正常后继退役。未使用新classifier、概括豁免或假端口隐藏旧链接。

原私有import-proof R1将inline export计数误当成forwarded API名称，失败记录保留；R2分别核对原inline投影与实际AST转出口，通过且没有生产／规则改动。

本机只做目标format/lint、纯AST/字节/JSON和一次原静态生成。正式行为由本批新exact-SHA CI证明。本单元未完成AgentMaterialIntent／PreparedAgentMaterial、中立submit/inspect/events/message/cancel、业务／系统／smoke selected binding或其真实roots，剩余legacy helper链接也未宣告消失。A6 scripts/purpose、A7 authority/recovery、A8组成及完整A-G继续；之后各owner独立CS adapter，M0先实际部署，再M1～M4逐项收编。当前没有AW-in-CS部署。
