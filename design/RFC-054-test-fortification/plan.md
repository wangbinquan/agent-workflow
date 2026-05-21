# RFC-054 — 测试防护加固（任务分解）

> 配套 [proposal.md](./proposal.md) + [design.md](./design.md)。
> 当前状态：**Draft**，等用户批准后进入实现。

## PR 与依赖图

```
                      ┌─ W1-1 opencode-recording ─┐
                      ├─ W1-2 api-contract        │
                      ├─ W1-3 crash-recovery e2e  ├─ Wave 1 全合并
Wave 1（~11 人日） ──┼─ W1-4 task-states e2e     ├──► 解锁 Wave 2
                      ├─ W1-5 auth-isolation e2e  │
                      ├─ W1-6 upgrade-rolling     │
                      ├─ W1-7 dep-cruiser         │
                      └─ W1-8 e2e shard + webkit ─┘
                                  │
                                  ▼
                      ┌─ W2-1 real-opencode integ ─┐
                      ├─ W2-2 ws-golden + sql-fuzz │
Wave 2（~6 周）   ──┼─ W2-3 xyflow-editor e2e   ├─ Wave 2 全合并
                      ├─ W2-4 collab-multi-user    ├──► 解锁 Wave 3
                      ├─ W2-5 visual regression    │
                      ├─ W2-6 axe-core             │
                      └─ W2-7 import/export e2e   ─┘
                                  │
                                  ▼
                      ┌─ W3-1 chaos injection      ─┐
                      ├─ W3-2 perf baseline         │
Wave 3（~6-12 周） ─┼─ W3-3 compat matrices       ├─ Done
                      ├─ W3-4 gitea git e2e         │
                      └─ W3-5 security fuzz        ─┘
```

**波间硬序**：前一波全合并 + STATE.md 标 Done 才解锁下一波第一个 PR。
**波内可并行评审**，但建议按字典序串行合避免冲突。

---

## Wave 1 子任务（W1-1 … W1-8）

### RFC-054-T1（W1-1）— 真实 opencode 录制 fixture 守门

- 新 `scripts/record-opencode.ts`：spawn 真 opencode + tee stdout → ndjson
- 录制 2 个版本 → `tests/fixtures/opencode-recordings/{1.14.51,1.15.5}.ndjson`
- 新 `packages/backend/tests/opencode-recording-parser.test.ts`：载入
  recording → 喂 `services/protocol.ts` 的解析器 → 断言 sessionId /
  events / outputs / status 全对
- 新 `packages/backend/tests/opencode-recording-coverage.test.ts`：grep
  守卫 — 必须至少 2 个 recording 文件
- `package.json` 加 script `record:opencode`
- commit hook（`scripts/git-hooks/pre-commit-recording.sh`）拒绝 recording
  diff > 0 行，除非 commit message 含 `[recording-refresh]`

**完工标准**：

- 2 个 recording 文件入仓
- 新单测全绿
- 跑 `bun run record:opencode` 在本地能拉新 recording（不入 CI）
- typecheck / lint / format:check / 全 backend 套件 pass count 不下降

### RFC-054-T2（W1-2）— API 契约总册

- 新 `packages/backend/tests/api-contract.test.ts`：表驱动覆盖全
  `src/routes/*.ts` 端点（约 50 个）× {happy, 4xx, 5xx} 三连
- 新 `packages/backend/tests/api-contract-coverage.test.ts`：扫
  `src/routes/*.ts` `app.get/.post/...` 并断言每个 path 在表中出现
- shared 补齐缺失的 response schema（约 5-10 个）
- 文档：`tests/contracts/README.md` 说明如何加新 endpoint

**完工标准**：

- 全 endpoint 在表中
- 漏写 → CI 红
- shared schema 0 个 `z.any()`（grep 守卫）
- 既有 routes/\*.test.ts 不动；契约总册作为新增层
- typecheck / lint / format:check / 全 backend 套件 pass count 涨 ≥ 100

### RFC-054-T3（W1-3）— 崩溃恢复 e2e

- `e2e/harness.ts` 加 `killChild(sig)` + `startDaemon({ home? })`
- 新 `e2e/crash-recovery.spec.ts` 2-3 case：
  - SIGKILL 中途 → 重启 → interrupted → resume → done
  - SIGTERM graceful → 重启 → running 继续
  - 多次 kill-restart 循环 → 最终 done

**完工标准**：

- 3 个 case 在 chromium + webkit 上各跑 5 次连续过（无 flake）
- 既有 5 个 spec 全绿
- e2e total wall-clock 不超过 W1-8 后的预算

### RFC-054-T4（W1-4）— task 全状态 e2e

- 新 `e2e/task-lifecycle-states.spec.ts` 7 case，每条达一个 status
- 每条带 `// LOCKS: task-state-<status>` 注释
- 复用 W1-3 引入的 harness 改动

**完工标准**：

- 7 个 status 各 ≥ 1 条到达路径
- 每条 WS event + DB row + UI chip 三层断言
- 在 webkit 上也跑通

### RFC-054-T5（W1-5）— 跨用户权限 e2e

- 新 `e2e/auth-isolation.spec.ts`：
  - A 拿 B 的 task → 403
  - A 拿 B 的 worktree-files → 403
  - PAT revoke 后再请求 → 401
  - admin / developer / viewer 三种 role 各跑 1 次
- 复用 `services/users.ts` 创建 users（绕过 CLI）

**完工标准**：

- 3 个 role × 3 个 endpoint 矩阵全跑
- 复用现有 `routes-session.test.ts` / `auth-routes.test.ts` 不动

### RFC-054-T6（W1-6）— 滚动升级测试

- 创建 3 个旧 home fixtures（m0001 / m0014 / m0020），放
  `tests/fixtures/old-homes/`
- 新 `packages/backend/tests/upgrade-rolling.test.ts`：每个 fixture
  startDaemon → migration 自动跑到 0028 → 跑 toy task → done
- 文档：`tests/fixtures/old-homes/README.md` 说明如何添新 fixture

**完工标准**：

- 3 个 fixture 入仓（gzip 压缩 ≤ 500KB 总和）
- 新单测全绿
- 既有 migration-\* 单测不动

### RFC-054-T7（W1-7）— dep-cruiser + 路由禁 `as T`

- 新 `.dependency-cruiser.cjs`：3 条 forbidden rule
- `package.json` 根加 `depcheck` script + devDep dependency-cruiser
- CI 加 `bun run depcheck` 步骤（先 warning，1 周后升 error）
- 新 `packages/backend/tests/routes-no-cast.test.ts`：grep `\bas\s+[A-Z]`
- 既有违规清单：先记录到 `.dependency-cruiser-allowlist.json`（如有），
  逐步消解

**完工标准**：

- depcheck 在 CI 跑（warning 状态）
- routes/\*.ts 0 个 `as T` 违规
- 1 周内升 error 不破 main

### RFC-054-T8（W1-8）— e2e shard + webkit

- `playwright.config.ts` 加 webkit project + `fullyParallel: true` +
  `workers: 4`
- `.github/workflows/ci.yml` e2e job 改成 matrix `shard × project`
- 既有 spec 在 webkit 上跑一遍，修 selector 漂移（如有）
- README 文档：本地如何只跑某 shard

**完工标准**：

- chromium + webkit 双矩阵在 CI 全绿
- 总 wall-clock < 15 min（4 shard 并行）

---

## Wave 2 子任务（W2-1 … W2-7）

### RFC-054-T9（W2-1）— 真实 opencode 完整集成

- 新 `.github/workflows/integration-opencode.yml`（daily cron + path-
  filter PR）
- 新 `packages/backend/tests/integration-opencode/*.test.ts`：≥ 5 case
- 仅 ubuntu；matrix opencode `{pin, latest}`
- 标 `@slow @opencode` 跳过常规 `bun test`

### RFC-054-T10（W2-2）— WS broadcast 黄金 + SQLite fuzz

- 新 `packages/backend/tests/ws-broadcast-golden.test.ts`
- 新 `packages/backend/tests/sqlite-concurrency-fuzz.test.ts`（fast-check）
- 复用 RFC-053 PR-D `runLifecycleInvariants` 入口

### RFC-054-T11（W2-3）— xyflow 编辑器交互 e2e

- 新 `e2e/workflow-editor.spec.ts`：拖创建 / 连边 / 删除 / Ctrl+C/V /
  多选 / wrapper-nest / undo（≥ 10 case）
- `playwright.config.ts` 适配 mouse-based drag

### RFC-054-T12（W2-4）— 多用户协作 e2e

- 新 `e2e/collab-multi-user.spec.ts`：双 browser context
- 复用 W1-5 创建 users 路径

### RFC-054-T13（W2-5）— visual regression

- 新 `e2e/visual-regression.spec.ts`：10 个关键页面
- 首次跑生成 baseline → 入仓（gzip 压缩）
- ubuntu-only；阈值 0.2%

### RFC-054-T14（W2-6）— axe-core

- `@axe-core/playwright` 加 devDep
- 主线 spec `test.afterEach` 注入 axe
- 新 `e2e/keyboard-flows.spec.ts`：Dialog focus trap / Select Tab 顺序

### RFC-054-T15（W2-7）— import/export 真文件

- 新 `e2e/import-export.spec.ts`：YAML / agent.md / skill.zip 真文件
- 用 `tests/fixtures/import-files/` 准备样本

---

## Wave 3 子任务（W3-1 … W3-5）

### RFC-054-T16（W3-1）— 混沌注入

- 3 个 chaos-\*.test.ts（disk-full / external-rm-worktree / wal-truncate）
- CI runner 需要 user namespace 支持；如不支持，标 `@chaos` 跳过

### RFC-054-T17（W3-2）— perf baseline

- `tests/perf/run.ts` + `tests/perf/diff.ts`
- `tests/perf/baseline.json` 入仓
- CI 加 perf job：main 上更新 baseline；PR 上 diff 报告

### RFC-054-T18（W3-3）— 兼容矩阵

- `packages/backend/tests/compat-config-versions.test.ts`
- `packages/shared/tests/compat-workflow-schema.test.ts`
- fixtures 入仓 `tests/fixtures/config-versions/` + `tests/fixtures/
workflow-schema-versions/`

### RFC-054-T19（W3-4）— gitea container e2e

- 新 `docker-compose.test.yml`
- 新 `e2e/git-protocols.spec.ts`：https + ssh + 私钥
- 独立 CI workflow，不阻塞主 PR

### RFC-054-T20（W3-5）— 安全 fuzz

- 新 `packages/backend/tests/security-fuzz.test.ts`
- 用 fast-check 跑 URL / 路径 / SSRF 各 100+ 随机 payload

---

## 验收清单（每波末做一遍）

### Wave 1 完工时

- [ ] 8 个 PR 合并到 main
- [ ] CI 全绿（含新加 shard / webkit / depcheck job）
- [ ] STATE.md 顶部"进行中 RFC" 行 Wave 1 改为 Wave 2
- [ ] design/plan.md RFC-054 状态 Draft → In Progress (Wave 1 done)
- [ ] backend / frontend / shared / e2e 测试 pass count 涨 ≥ 200
- [ ] CLAUDE.md（如需要）补"测试加固"原则的"已具备能力"段
- [ ] 团队同步：哪些重构现在解锁了

### Wave 2 完工时

- [ ] 7 个 PR 合并
- [ ] integration-opencode.yml workflow 至少跑过 7 天日测全绿
- [ ] visual-regression baseline 入仓
- [ ] axe-core 0 critical / serious 违规
- [ ] STATE.md 推到 Wave 3
- [ ] 测试 pass count 累计涨 ≥ 350

### Wave 3 完工时

- [ ] 5 个 PR 合并
- [ ] perf baseline.json 已被 PR diff 引用 ≥ 5 次
- [ ] STATE.md / design/plan.md RFC-054 标 Done
- [ ] CLAUDE.md 补"M5 后测试加固结果"的"已具备能力"段
- [ ] 复盘文档 `design/RFC-054-test-fortification/postmortem.md`：哪些
      盲点被该波抓到、哪些没被抓到、Wave 4 应该是什么

---

## 风险 + 兜底

- **风险 1**：W1-1 录制 fixture 与真 opencode 行为漂移。
  - 兜底：W2-1 真集成补；`[recording-refresh]` commit 必须附 opencode
    版本说明。
- **风险 2**：W1-2 契约总册写起来枯燥，作者跳着写漏端点。
  - 兜底：W1-2 含 coverage 守门测试，漏一个 endpoint 立刻 CI 红。
- **风险 3**：W1-3 SIGKILL 在 macOS / ubuntu CI 行为差。
  - 兜底：双 OS 矩阵跑；spec 内显式等 daemon `exitCode`。
- **风险 4**：W1-6 旧 home fixture 太大（SQLite + worktree）。
  - 兜底：gzip 压缩；首批仅 3 个 fixture；不上 git LFS（避免复杂度）。
- **风险 5**：W1-7 dep-cruiser 加上后历史违规多，CI 立即红。
  - 兜底：先 warning，1 周后升 error；过渡期违规清单。
- **风险 6**：W1-8 webkit 在 Linux CI 慢。
  - 兜底：PR 仅 chromium 阻塞；webkit 每日 nightly。
- **风险 7**：W2-1 真 opencode CI 抖动（网络 / 模型 API）。
  - 兜底：标 `@flaky-allowed`，独立 workflow 不阻塞主 PR；连续 7 天失败
    自动开 GitHub issue。
- **风险 8**：W2-3 Playwright drag-and-drop 在 xyflow 上漂移。
  - 兜底：用 `page.mouse.down() / move() / up()` 显式三步而非 `dragTo`；
    retry=2。
- **风险 9**：W2-5 字体差异造成视觉回归噪声。
  - 兜底：ubuntu-only baseline；`--update-snapshots` 必须人工触发，
    不自动。
- **风险 10**：W3-1 混沌注入需要 root / cgroup，CI runner 不一定支持。
  - 兜底：本地 macOS 跳过；CI 用 ubuntu-latest 加 user namespace；
    标 `@chaos`。
- **风险 11**：W3-2 perf baseline 在 CI runner 间差异大。
  - 兜底：用 ratio 而非绝对值；main 跑 5 次取 median；只在跨次 PR
    比较有意义时报告。

---

## 时间线（粗估）

| PR              | 工作量        | 关键内容                                     |
| --------------- | ------------- | -------------------------------------------- |
| W1-1            | 1.5 天        | recording 录制 + 解析器测试 + 守卫           |
| W1-2            | 3 天          | ~50 endpoint × 3 case 写完，约 150 case 新增 |
| W1-3            | 2 天          | harness 改动 + 3 spec case                   |
| W1-4            | 2 天          | 7 个 status × 完整断言                       |
| W1-5            | 1 天          | 3 role × 3 endpoint 矩阵                     |
| W1-6            | 1 天          | 3 fixture 准备 + 1 spec                      |
| W1-7            | 0.5 天        | depcheck 配置 + grep 测试                    |
| W1-8            | 0.5 天        | shard 配置 + webkit 验证                     |
| **Wave 1 合计** | **~11.5 天**  |                                              |
| W2-1            | 3 天          | workflow + 5 集成 case + 矩阵                |
| W2-2            | 2 天          | WS 黄金 + fuzz                               |
| W2-3            | 3 天          | xyflow 真实拖拽 10 case                      |
| W2-4            | 2 天          | 双 user e2e                                  |
| W2-5            | 2 天          | 10 visual baseline                           |
| W2-6            | 1 天          | axe 注入 + 键盘 spec                         |
| W2-7            | 1 天          | import/export e2e                            |
| **Wave 2 合计** | **~14 天**    |                                              |
| W3-1            | 3 天          | 3 个 chaos case + runner 配置                |
| W3-2            | 3 天          | baseline + diff 报告                         |
| W3-3            | 2 天          | 2 个兼容矩阵 + fixtures                      |
| W3-4            | 3 天          | gitea compose + 真协议 e2e                   |
| W3-5            | 2 天          | fuzz fast-check                              |
| **Wave 3 合计** | **~13 天**    |                                              |
| **总计**        | **~38-39 天** | 跨 ~3-4 个月（不全职、并行）                 |

---

## 与 CLAUDE.md 的关系

本 RFC **不改 CLAUDE.md**。但完成后建议补一节"Test fortification
status"，列出已建立的能力：

- 真实 opencode 协议守门 → 升级 opencode 不再靠人感知
- API 契约总册 → 路由改动断契约立即 CI 红
- 崩溃恢复 / 全状态 e2e → 用户骨牌 e2e 锁
- 多用户协作 e2e → RFC-036 边界端到端验证
- visual regression / a11y → UI 改动有自动门禁
- perf baseline → 慢退化 PR 阶段就能看到

让未来 session 看 CLAUDE.md 就知道"这些已经被锁，可以放手改"。
