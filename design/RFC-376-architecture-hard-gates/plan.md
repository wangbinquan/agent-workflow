# RFC-376 实施计划

两阶段交付（design §9），各阶段都由 Codex 实施、本会话审核。阶段 A 与 RFC-375 / RFC-377 并行；阶段 B 在二者提交后、安静窗口内一次完成并提交。
每个阶段内先完成全部改动与用例，再集中验证一次（CLAUDE.md 文首硬规则）。

## 阶段 A（只新建文件 + 修改「安全」测试文件）

| 编号 | 内容 | 文件 |
| --- | --- | --- |
| RFC-376-T1 | 抽出目标常量（原 `rfc294Canonical.ts` L78-210，复制而非移动，阶段 B 删除原处） | `TA/rfc294Target.ts`（新） |
| RFC-376-T2 | 抽出 RFC-328 构造器（复制，见 design §2.2） | `TA/rfc328TaskExecutionLedger.ts`（新） |
| RFC-376-T3 | 门检测函数（G2、G3、G5～G9、C6、C8、C9、G14）与共用语料解析 | `TA/rfc294Gates.ts`（新） |
| RFC-376-T4 | 各门测试（每条门 design §3.1 的五项变异证明），初始例外清单按当时 HEAD 计算；`counts.json` 的检查逻辑写成纯函数并用内存样例覆盖其负例，读取真实 `architecture/counts.json` 的接线留到阶段 B（T12） | `TA/rfc376-*.test.ts`（新；文件命名遵守守卫惯例） |
| RFC-376-T5 | design 对拍测试（G11），import `rfc294Target.ts`；含对内存 design 文本的变异负例 | `TA/rfc294-design-parity.test.ts`（新） |
| RFC-376-T6 | 报告生成器（只读已提交对象、不抛未登记、id 不用行号、从 ref 文本解析 `KNOWN_VIOLATIONS`、不 import 工作树生产模块、§7 计数口径） | `TA/architectureReport.ts`（新） |
| RFC-376-T7 | 报告脚本（`--source-ref` / `--out` / `--status` / `--gates`），附测试：同一提交两次输出逐字相同、不读工作树 | `scripts/architecture-report.ts`（新）、对应测试（新） |
| RFC-376-T8 | 安全测试文件的改造：`T/rfc332-task-engine-contracts.test.ts` 删 L247-329；`T/rfc339-wrapper-runtime-cutover.test.ts` 删 L375-405；`T/helpers/rfc349FunctionalEvidence.ts` 与 `T/rfc349-functional-evidence.test.ts` 改指新门；`T/depcheck-gate.test.ts` 加 T20、route/transport-to-db 检查与路径正则负例；`TA/rfc317-architecture-ledgers.test.ts` 删 provenance 部分；`TA/rfc294-review-module-layer-rules.test.ts` 扩展为 G7；`TA/rfc317-module-boundary.test.ts` 去掉 commons-debt 投影依赖 | 上述文件 |
| RFC-376-T9 | 阶段 A 报告：新文件清单、各门在当时 HEAD 的违规集合与计数、guard-manifest 待登记条目（字段用 `census.ts` 函数算出）、阶段 B 待办核对表 | — |

阶段 A 禁止修改 design §9 的「危险集」。阶段 A 结束时 `rfc317-guard-*` 会因新门尚未登记而红、旧账本测试会因阶段 A 不重跑 census 而保持现状——属预期，报告中注明。

## 阶段 B（RFC-375 / RFC-377 已提交后；安静窗口内）

| 编号 | 内容 |
| --- | --- |
| RFC-376-T10 | 改造：`T/rfc294-architecture-preflight.test.ts`（G3 文件内清单、public 偏离清单、删 god-surface 预算）；`TA/rfc294-review-offered-edge-dag.test.ts` 改从 `rfc294Target.ts` import；`T/rfc328-architecture-guards.test.ts` 改直接断言；`T/rfc346-system-operations-contracts.test.ts`；`T/rfc321-repository-publication-ratchet.test.ts`；`T/rfc370-committed-architecture-source.test.ts`；把 `toPublicError` / `define*` 用例移到 platform 单测 |
| RFC-376-T11 | 删除旧测试：`TA/rfc294-canonical-manifests.test.ts`、`TA/rfc294-review-status-projection.test.ts`、`TA/rfc317-ledger-highwater.test.ts`、`TA/rfc294-review-public-consumer-ledger.test.ts`；更新各 `TA/` 测试中引用 T17 / ledger-baselines 的注释 |
| RFC-376-T12 | `architecture/`：删 9 个文件、三个保留文件去投影字段、新增 `counts.json`（从 HEAD 计算初值）、guard-manifest 登记全部新门并删去已删守卫；根 `.gitignore` 加入 9 个文件名与 `.architecture-report/` |
| RFC-376-T13 | 脚本与配置：删 `TA/rfc294Canonical.ts`、`TA/rfc294Status.ts`、`scripts/architecture-census.ts`、`scripts/architecture-status.ts`（先确认无 importer）；`scripts/lib/committed-architecture-source.ts` 更新 extras；`package.json` 的 `architecture:*` 与 repo-ui 文件清单；`scripts/depcheck.ts` L31-39 注释；`TA/census.ts` 陈旧注释 |
| RFC-376-T14 | CI：`ci.yml` `test-backend` 与 `backend-macos-nightly.yml` 去掉 `fetch-depth: 0` / `filter: blob:none`（保留 `scans`） |
| RFC-376-T15 | 用 `bun run architecture:report --gates --source-ref HEAD` 重算全部例外清单与 `counts.json` 初值并粘贴 |
| RFC-376-T16 | 文档：dev-gotchas 历史横幅；RFC-294 proposal / design / plan / status.md / test-hardening；`docs/audit-backlog.md` 的 T72 条目 |

## 验收清单

- [ ] `architecture/` 只剩 8 个允许文件（C9 门绿）
- [ ] 每条门的五项变异证明齐全并登记 guard-manifest
- [ ] `architecture:report` 只读已提交对象、输出可复现
- [ ] RFC-328 / code-host / required port 的直接断言就位
- [ ] `counts.json` 检查的负例齐全
- [ ] `TA/` 全目录与 design §4.2 全部测试通过；depcheck、三包 typecheck、改动文件 lint / prettier 通过
- [ ] 文档更新完成
- [ ] 推送后 exact SHA CI 全绿；随后一笔只改生产代码的提交（不动 `architecture/`）在 CI 上也全绿（AC-2）

## 提交编排（审核方）

- 阶段 A 的改动不单独提交，与阶段 B 一起作为一笔原子提交（代码 + 测试 + CI），文档可单独一笔。
- 提交前确认危险集无他人未提交改动、HEAD = `origin/main`；用逐文件路径清单提交；推送后按 exact SHA 跟踪 CI。
