# H4／H5 中立材料编译接口与本机绑定

这是已批准 execution-material-implementation.md 的阶段 A 实施增量。SOURCE10-R4 已获独立有限功能 PASS，首末 40 项字节稳定；没有 CS adapter 或 AW-in-CS 部署，不关闭完整 A-T5／A-G。

## 职责与实际接线

runtime-management/application/ports/agentMaterial.ts 定义完整 AW 材料输入：root／BFS dependents、MCP、skill／plugin 声明与内容版本引用、已解析有序 profile、最终 prompt／memory、workspace／run-content／完整 mounts、独立 fresh／native／resume 会话事实。省略、显式 undefined 和 null 保持原区别。中立输入没有本机路径、argv／env／stdin、binary override 或版本读取函数。

infrastructure/local/agentMaterialCompiler.ts 只读取已选 NativeAgentMaterialContents，恢复原 native context 后调用已选 builder。PreparedAgentMaterial 返回 opaque materialRef、同一次实际编译的 declared 与该绑定提供的 evidence capabilities；物理计划保存在本机私有绑定内，未知 ref 或协议组合直接拒绝，没有 registry／Paths／global native 回退。

两个实际 native material 的 buildSpawn 兼容入口接入本机绑定。原 declaration catch、persona／business 分流、所有装配与取证函数的完整 AST 保持。正常资料先投影中立 intent 再编译；raw native context 有声明 accessor 时，由同一个已选原 native builder 在原读取时点和错误边界消费，不能先读 getter 再 catch 后重读。这是旧 native API 的兼容边界；正常中立 compiler 不使用该分支。

legacyAgentMaterialBinding.ts 保存 native locator 与 lazy reader，AW intent 只保存逻辑内容引用。它复制声明数据并冻结快照，不冻结调用者的 live resources。已知 skill／plugin 字段显式单次读取，支持原型 locator；版本 reader 只在原消费者请求时调用，并保留原 receiver。物理 resolver 的 name／id／options 等不能覆盖 AW 声明。

本批只形成材料编译合同及原 native 兼容接线。完整执行／取证 participant、Task／system／smoke 的中立接口切换和所有 composition roots 仍需后续实现。

## 回归与检视历史

原双 runtime business／persona golden、全部原 native 定义及两份 CI 源码 oracle 中的 130 个旧 ordered expect 保持。新增回归覆盖完整声明快照、有序 profiles／mounts、可选状态、独立会话事实、receiver／版本读取时机、fixture 只在 native 侧、未知引用与原错误 identity。

实际双 runtime 回归还检查技能目录的 SKILL.md 与附件完整复制、OpenCode plugin spec、Claude 原 unsupported 声明、persona 声明 getter 失败后原 warning／empty manifest 降级，以及 business 仍为原致命失败。

SOURCE10-R1 的 3 项 P2／FAIL 保留：prototype locator 丢失、声明 getter 提前读、Bun class this matcher 类型。SOURCE10-R2 的 2 项 P2／FAIL 保留：prototype data container 内的 nested getter 漏检、locator 显式读后 spread 再读。R3 补齐继承容器检测和单次字段投影；其 symbol descriptor 漏检 P2／FAIL 也保留。R4 覆盖全部 string／symbol descriptors 并补双 runtime 空 MCP iterator getter 的原降级回归。独立有限功能 PASS 的指纹为 `77adb25e531e2dcc4e34db8971d1ab461d3ca06b8b39c5fa05304be8fc255fe3`（10 owned／18 controls／12 evidence）；正式 CI 另行记录，不用纯 AST 证明代替行为验证。

## 本批 CI 修复边界

已发布 `3e16c4369f363353ea156846e2761e4f98375da8` 的主 CI `37242978544` 为 failure，Windows `37242978543` 为 cancelled，原结果及日志保留。属于本次归位的旧源码扫描位置、inventory oracle 和两项已无跨模块消费者的 OpenCode capture factory public export 在本批修正；实际 capture 实现及 RuntimeDriver 能力保留。

四个实际 native compatibility import／export 边在 commons-debt 逐条登记，不修改分类器。Windows push／PR 同时追加六个真实路径，原平台命令追加材料编译、runtime capability 和 inventory 三个 suite；所有原步骤、预算、版本和配置保持。

本机只做目标 format／lint、纯 AST／byte／JSON 和必要原静态投影；没有 AW 本机 tests／typecheck／build／service。匹配架构清单、增长回执、发布 SHA 与新 hosted CI 另记。完整 A1～A8／AC00／A-G 保持开放；随后按 owner 独立 CS adapters，M0 首次实际部署先行，再 M1～M4 逐项接入。

## 匹配清单与发布验收

原静态 generator 对 c83bf750524fdfc1a1b8ca0da5448c12a095d2aa 加冻结 SOURCE10 只运行一次；6441 非自有源码读取该提交的完整 blobs，排除并保留并行 WIP。原完整 canonical validator 与四个原规则保持，sourceDigest `sha256:76d7d0051a4f025db4c8149c7bc6370d26231d1aac7c74035bd8659b8a88a908`。新定义与实际 legacy 类型边对应四项增长；两个没有消费者的 public re-export 移除导致公开面缩小。

| 原库存                         |  原值 | 本候选 |
| ------------------------------ | ----: | -----: |
| mutation entrypoints           |  1874 |   1875 |
| observed cross-context imports |  6255 |   6265 |
| architecture exceptions        |  5551 |   5561 |
| public surfaces                |  1150 |   1148 |
| module symbol owners           | 26690 |  26710 |

129 条原库存的顺序、全部原 why 与原计数器保持。四个实际既有 native compatibility 边分别具名登记，原300债务全文不变，合计304；原SPI40、target edges69与空implementation SCC保持。仅四项实际正增长有匹配许可，在正常后继提交退役，不重跑同一候选 census。

当前基线 c83 的正式主 CI `37244977913` 已失败（39 success／9 failure／2 cancelled），Windows `37244977844` cancelled，回执保持。同期 full、WebKit、visual 均成功，仅支持对应流程。属于本批的扫描／inventory／commons／无消费者 public 问题已修；其他会话的类型及归档候选独立发布，本批不带入它们。新发布确切 SHA 的全仓行为仍须 hosted CI。
