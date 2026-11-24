# RFC-562 托管对象发布日志归内容 owner（platform/content），恢复归一参与者改为 system-operations 的 required 端口（RFC-294 S9 第十七步）

- **状态**：In Progress（2026-11-24）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17、2026-11-24 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §4，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §3（platform 是领域中性机制，不取任何 `modules/`；模块的
  infrastructure 可以取 platform 机制）、§3.3“required SPI 由 consumer 拥有”、§15“跨 context 内部文件对与 type-only 越 DAG 边 → 各 owner 的合同”与
  design §14“DAG 外的 offered 边 → 0”；恢复归一一半的做法同 [RFC-556](../RFC-556-provider-ports-through-designated-adapters/proposal.md)。

## 1. 背景

`off-dag-offered-file-context-pairs`（26 条）里有 15 条指向 system-operations，全部是按类型取它的 `public/participants`：

| 取的合同                                                               | 取它的文件                                                                                                                          |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 托管对象发布日志（`HostedObjectPublications`、回执、请求、owner 清扫） | collaboration 2、development-automation 2、digital-employee 1、resource-catalog 1、task-execution 8 个 `crewstation` 适配与装配文件 |
| 恢复归一参与者（`HostedRestoreNormalizationParticipant`）              | task-execution `infrastructure/hostedRestoreNormalization.ts`                                                                       |

发布日志自称“the one platform-neutral hosted object publication journal”：实现只依赖 platform（内容库、持久化、CrewStation 对象存储与执行栅栏），读写的
`content_objects` / `content_publications` 两张表归 platform/content。它停在 system-operations 里，两份账本各记着一笔债，并且写明了去处：

- DAG 外边账本：“随对象发布下沉为平台内容端口时收敛”；
- 表归属账本（3 条）：“需要把…对象发布操作封装为平台服务…为 platform/content 的 objectPublications 提供闭合读写操作并移除此站点”。

恢复归一参与者则是 system-operations 向各 owner 要的实现面（“System Operations never writes another context's tables; bootstrap wires the
participants”），与 `DoctorTaskLifecyclePort` 同类，却从 public 交出。

## 2. 目标

- **G1**：发布日志的合同与实现原样迁入 `platform/content/hostedObjectPublications.ts` 与 `platform/content/infrastructure/hostedObjectPublications.ts`；
  14 个 owner 文件改取平台合同；system-operations 照旧装配日志并注入自己的备份释放水位。
- **G2**：system-operations 自己的恢复归一不再直接改 `content_publications`：那条 UPDATE 原样收成日志的闭合操作
  `releaseHostedPublicationsInTx`，并补上它此前没有的用例。
- **G3**：恢复归一参与者声明在 system-operations 的 `application/ports`、经 `composition/required-ports.ts` 交出；task-execution 经已有的
  system-operations adapter 按类型取，实现由 task-execution 的装配根交给 bootstrap（不再经它的 public）；目标 DAG 与 RFC-294 design 的 Mermaid 同批登记
  虚线边。
- **G4**：DAG 外的 offered 边 26 → 11；表归属债 120 → 117；public 类型偏差 59 → 56；system-operations 与 task-execution 的 public 随之收窄；其余计数不升。
- **G5 结局不变**：发布、查找、释放、维护、备份水位与恢复归一的每一步行为不变；数据库里的行与对象存储上的 pin 不变。

## 3. 非目标

- 把托管对象发布并入 platform/content 已有的 `ContentStore` 发布账本（RFC-395 留下的后继机制，尚未启用）：那是换实现，另立。
- 其余 11 条 DAG 外 offered 边。
- 日志的行为、表结构与维护作业的登记方式。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：业务模块取 system-operations 的只剩 task-execution 的指定 adapter 按类型取 required-ports；发布日志的合同与实现在 platform/content，旧位置
  不存在。
- **AC-2**：行为不变；恢复归一释放遗留发布的闭合操作有用例覆盖（两种数据库）。
- **AC-3**：DAG 外 offered 边 26 → 11、表归属债 120 → 117、public 类型偏差 59 → 56，各精确清单、减速带与目标 DAG / Mermaid 随之更新；新增 RFC-562
  用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
