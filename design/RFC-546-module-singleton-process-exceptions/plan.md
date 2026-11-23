# RFC-546 实施计划（待用户确认后开工）

依赖：RFC-545。**本 RFC 在用户确认 proposal §5 的 Q1～Q3 之前不实施**；确认后按 CLAUDE.md 文首硬规则先完成全部实现与用例编写，再集中验证。

## 任务（确认后）

- **RFC-546-T1 清单**：按用户确认的结果写 `architecture/module-singleton-exceptions.json`（design D1）。
- **RFC-546-T2 守卫**：新增 RFC-546 守卫并登记 guard-manifest，连同“待迁移 / 待定”两份过渡清单（design D2）。
- **RFC-546-T3 design §14**：改 RFC-294 design §14 该行的口径（design D3）。
- **RFC-546-T4 集中验证与实现门**：守卫在真实语料上为绿、负对照为红；架构报告计数不变。

## 验收清单

- [ ] 用户确认 Q1～Q3
- [ ] 清单与守卫落地，守卫在真实语料上为绿、负对照为红
- [ ] design §14 口径修订
- [ ] exact SHA CI 全绿

## PR / 提交

落档提交（本次）只含三件套、RFC 索引与 `STATE.md` 条目；确认后再提交实现。
