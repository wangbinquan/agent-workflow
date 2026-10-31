# RFC-401 实施计划

**前置**：proposal §5、§7 的用户可见变化逐项确认后才开工。Part B 另需 RFC-398 Done（两边都改迁移面）。
全部实现与用例完成后集中验证一次。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-401-T1 | 按确认结果固定错误矩阵（code / status / message / details / 首错顺序）、技能字节合同与引用去重规则；写成合同测试的期望表 | design §2 |
| RFC-401-T2 | 六类资源的变更计划与 tx 参与者：统一引用、默认值、版本、唯一冲突归一（provider 中立）、成员重建规则；保留 agent 关系与 workflow 索引的原子写入 | design §3 |
| RFC-401-T3 | Intent、资源包、普通 CRUD、demo / fusion 种子、数字员工模板、内建 workflow、动态 workflow 保存全部接入；code-capability 保持 owner 参与者；删除两套 arms 与重复分派；资源包循环改为 `agent-dependency-cycle` | design §3 |
| RFC-401-T4（Part B） | AtomicApply 持久 claim / lease / fencing token、续租与接管、尾部完成标记；目标 schema 与迁移；两种 provider 同一合同；沿用 `intentRecovery` 作业 | design §4 |
| RFC-401-T5（Part B） | 技能 create / save / 文件写删 / ZIP 单项、fusion approve、skill restore 接入 AtomicApply；membership 与版本同事务；fusion 发布失败后的状态一致 | design §5 |
| RFC-401-T6（Part B） | 旧 journal 清零判据与证据；兼容读取器与执行器分开；清零后删除旧 skill operation 生命周期与零调用 legacy 写函数 | design §6 |
| RFC-401-T7 | 用例：三入口 × 两 provider 错误矩阵、变更计划、lease 竞争与崩溃、技能 / fusion / restore 故障点、字节与事件；守卫与账本精确更新 | design §7、§8 |
| RFC-401-T8 | 集中验证：后端全量（含根目录守卫）、P0 变异 lane（触及 owner fence 时）、实现门（只审功能）；推送后跟 CI | — |

**顺序**：Part A = T1 → T2 → T3 → T7（Part A 部分）→ T8；Part B = T4 → T5 → T6 → T7（Part B 部分）→ T8。两部分各自提交。

## 冲突面

- resource-catalog 全域、intent apply、knowledge-evolution fusion、`services/resourcePackage/**`、`services/bundle/**`、资源 routes 与 MCP 资源工具；
- `bootstrap/daemonHttpComposition.ts`、`bootstrap/maintenanceWorkerGraph.ts`、`bootstrap/daemonLifecycleProgram.ts`；
- Part B 的 schema 与迁移：`platform/persistence/**`、目标 schema 合同、迁移规则（与 RFC-398 重叠，故排在其后）。

## 验收清单

- [ ] proposal §5、§7 确认
- [ ] proposal AC-1～AC-5
- [ ] 推送后 exact SHA 的 CI 全绿（AC-6）
