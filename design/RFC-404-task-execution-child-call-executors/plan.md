# RFC-404 实施计划

**前置**：RFC-403 实现提交 `2874dd182`。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做
功能验证。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-404-T1 | 窄合同与共享实现：`application/ports/childCallNodeExecution.ts`；`domain/isoSubmodules.ts`（`W`、`executionMergeRecovery.ts` 改指）；`resourceLimitUsage.ts` 补 `encodeCallHumanWait`；`application/childCallErrors.ts` | design §1.2、§2 |
| RFC-404-T2 | 共享主体迁入 `engine/node/shared/child-call/`：`runChildCallNode.ts`（含 `failCallRow`）、`launchChildCall.ts`、`childCallWatch.ts`；门、领养、发起、等待、终态、输出与合并的顺序、错误码与消息文本不变 | design §1.1、§3 |
| RFC-404-T3 | 绑定 `composition/childCallNodeExecution.ts`：`buildChildRuntime`、`delegatedCallActor` 与 NULL owner 投影迁入；闭包改从 `infrastructure/legacyCallClosure.ts` 取；领养后 iso 重建顺序原样封装 | design §1.2 |
| RFC-404-T4 | 两个执行器 `engine/node/{call-workflow,call-workgroup}/`；`E` 以显式端口直接构造；删除 `engine/node/childCallNodeExecutors.ts` 与 `N` 中 calls 主体和 helper | design §1.1 |
| RFC-404-T5 | 守卫与用例：新结构锁 `rfc404-child-call-executors`（含负例）、端口绑定用例、共享实现用例；design §4 所列守卫改指；RFC-317 偏离账本与新站点用例、RFC-376 setInterval 账本；Windows 两份 `paths:` 与 suite；账本只准备改法，按 T6 实测填值 | design §4、§5 |
| RFC-404-T6 | 集中验证：静态检查、后端全量（含根目录守卫）、相关两 provider 用例、P0 变异 lane；按实测更新账本；实现门（本会话自审，只审功能）；推送后跟 CI | design §3 |

## 冲突面

- `TE/composition/{nodeMechanics,nodeExecution,wrapperMechanics,executionMergeRecovery}.ts`、`TE/engine/node/*`、`TE/domain/resourceLimitUsage.ts`；
- 守卫与账本：见 design §4。

并发会话 RFC-398 当前的改动面（epoch migration / auto-upgrade、`platform/persistence/**`、`modules/system-operations/**`、
`application/buildNodeRunMintRecord.ts`、`collaboration/infrastructure/review.ts` 等）与本 RFC 没有必需的同文件交集；实施前与提交前按路径
核对工作树。

## 实施记录（2026-11-01）

- **实施**：本会话一次完成 T1～T5（新增 12、修改 34、删除 1 个路径，另有三件套与 `guard-manifest.json`）。`nodeMechanics.ts` 3656 → 2496 行。
- **与设计的出入**：
  - 两条发起臂里重复的 limits 解析与子任务名拼接合并为 `callLimits` / `childTaskName` 两个纯函数；两个 `const space = inheritedCallSpace({`
    站点保持各写一处（RFC-395 checkpoint 边界锁按站点计数）。
  - 发起臂原有的 `workflowName` / `workgroupName` 参数没有任何读取（原文以 `void workflowName` 占位），随搬迁删除。
  - 测试语料聚合 `SMALL_LEAF_SOURCES` 改名 `LEAF_NODE_SOURCES` 并加入新主体与发起臂，7 个使用方同步；calls 主体由此继续留在 RFC-287 T1
    广播时序、RFC-188 装配原语计数、RFC-208 许可释放等语料内（RFC-188 的 7 / 8 / 7 计数不变）。
  - 新增守卫除 design §4 所列外，还补了 `node-run-mint` 铸点清单、RFC-328 worker 分类与 RFC-334 边界清单中的新文件。
- **实现门**（本会话自审，只审功能，按路径限定在本 RFC 的候选）：把新主体、发起臂、目标渲染、继承工作区与绑定里的 `buildChildRuntime` /
  `delegatedCallActor` 逐段与 `HEAD` 的 `nodeMechanics.ts` 原文规范化后做 diff，差异只有端口化的机械替换与上面两处出入；逐项核对门的
  顺序、领养与续跑、关停判别、错误码与消息文本、台账写出字节、输出投影、done 先于合并、领养后重建顺序与惰性读取，没有功能差异。唯一的
  发现是搬迁时丢了 RFC-271 的一行历史注释，已补回。结论 PASS。

## 集中验证（T6）

- **静态**：后端 typecheck（含 tests，6 GiB heap）rc=0；候选 45 个 TS 文件 eslint `--max-warnings 0` 0 error / 0 warning；prettier 通过。
- **实现门**：见「实施记录」，PASS。
- **定向运行**（本 RFC 新增或改动的 24 个测试文件）：首轮 2 个失败，都是本 RFC 用例的写法问题，修后全部通过——`rfc284-t20` 的新断言
  把主体注释里的 `buildChildRuntime` 字样与节点 run 投影的 `runtime:` 字段组当成了子任务 runtime（锁收窄为「engine 文件不含 `runConfig` /
  `schedulerDriver`、两次发起请求不带 `runtime:`」，注释改措辞）；`rfc404-port-bindings` 在循环里按当前 trigger context 算期望（改为每次
  发起后立即记下）。
- **后端全量**：6 分片开跑约 40 分钟只完成 443 个文件（约 11 个 / 分钟）——本机 10 核，Docker 虚拟机（常驻 kind 集群与测试 PostgreSQL）
  占约 6.3 核，9000 s 内跑不完，于是停下改跑针对性验证集。已完成部分 4813 pass / 305 fail，56 个文件有失败，只有 2 个含非超时失败且
  都是超时连带（`rfc099-acl-endpoints-matrix` 超时后的断言；`rfc395-v3-hosted-job` 前一用例超时把托管目标库留成非空），没有确定性守卫失败。
- **针对性验证集**（4 worker，21 分钟）：仓内守卫文件名判据命中的 224 个文件、读 `nodeMechanics.ts` 或相关 owner 的 134 个测试、calls /
  调度 / RFC-402～404 的 138 个行为测试，去重后扣掉部分全量里已完整通过的 69 个，共 355 个文件；13 个失败。
- **本 RFC 引入、已修**（5 处，都是按 `nodeMechanics.ts` 路径或 owner 钉住的账本 / 锁）：
  - `rfc287-t1-discard-failure-paths` 的防空扫：语料（scheduler、`N`、wrapper、script）里唯一的 `finally` 原在 calls 主体，搬走后为零。
    语料并入 `LEAF_NODE_SOURCES`，搬走的主体继续受「finally 里不得清 iso」的扫描；
  - `rfc317-allow-terminal-ledger`：call 领养站点随主体迁移（`N` 2 → 1，新主体 1，总数不变）；
  - `rfc305-architecture-lock`、`rfc347-identity-access-runtime`：委托授权 `.forCall(` 的消费方改为 calls 绑定；
  - `rfc243-execution-outcome`：call-workgroup 的 result 折叠源码锁改读新主体。
- **负载超时**：其余 8 个文件（`rfc120-deferred-dispatch`、`rfc167-dynamic-workflow-engine`、`rfc359-w5-composition-root-route-surface` 与
  5 个 `scheduler-*`）只以超时失败。这 8 个、上面修过的 5 个，以及部分全量里有失败但不在验证集里的 47 个文件，共 60 个，以 2 worker 在负载
  约 10 时复跑全部通过。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段全部有效，127 个源文件指纹前后一致。
- **基线前进**：验证期间并发 RFC-398 提交 `cc81d09c4`（609 个文件，与本 RFC 的 48 个路径无交集，也不引用本 RFC 搬走的符号或旧路径）。验证时
  它的改动已在工作树中；本 RFC 候选未变，按规则沿用上述结果，最终以 exact SHA 的 CI 为准。`guard-manifest.json` 只提交本 RFC 涉及的 9 个条目（8 个
  `lines` 参考值，其中 `rfc403-small-leaf-executors` 是 `d18850d35` 留下的；新增 `rfc404-child-call-executors`），工作树中 RFC-398 未提交的
  `note` 补充不纳入。

## CI（AC-6）

- **`88d4c088f`**：windows-platform `41288921976` success。主 CI `41288921900` 52 success / 6 failure / 3 cancelled，失败全部属并发 RFC-398：
  Static scans 的 gitleaks 命中 RFC-398 种子 JSON 的 `token` / `token_hash` 列；backend 分片 2、26 是 RFC-398 的 WAL 打开语义用例；分片 11、15、
  17 是 RFC-398 发布版升级矩阵（v0.18.18 / v0.19.0 / v0.19.1 → PostgreSQL in-process）；分片 1、20、25 跑满 15 分钟被取消。均由 RFC-398 的后续
  提交处理，本 RFC 没有失败用例。
- **后继证据**：`57103c231`（该提交本身只改 CI 分片配置；本 RFC 提交是它的祖先，其后对本 RFC 代码文件的改动只来自本会话的后继 RFC）的主 CI `41312990481` 69 个 job 全部 success（windows-platform 已在本 RFC 的 exact SHA 上 success）。AC-6 关闭。

## 验收清单

- [x] proposal AC-1～AC-5（本地集中验证，见上）
- [x] 推送后 CI 全绿（AC-6，以后继证据关闭，见「CI（AC-6）」）
