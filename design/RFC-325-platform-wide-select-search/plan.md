# RFC-325 任务分解 —— 全平台下拉框搜索能力

## 1. 子任务

| 编号    | 任务                                                                                                       | 依赖   | 触及文件                                                                 |
| ------- | ---------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------ |
| **T1**  | 新增搜索纯函数模块 `normalizeSearchText` / `matchesSearchQuery`                                            | —      | `packages/frontend/src/lib/option-search.ts`（新）                       |
| **T2**  | T1 的纯函数单测（归一化 4 类 + 匹配 3 类）                                                                 | T1     | `packages/frontend/tests/option-search.test.ts`（新）                    |
| **T3**  | `Select` 条件默认值：导出 `SELECT_SEARCH_THRESHOLD = 8`，五处 `props.searchable` 判断改读局部 `searchable` | T1     | `packages/frontend/src/components/Select.tsx`                            |
| **T4**  | `Select` 匹配面扩到 `label/value/description/group` + 消除 `onChange` 里那份重复过滤逻辑                   | T3     | 同上                                                                     |
| **T5**  | `Select` Esc 两段语义（有词清词、无词关闭，均不冒泡）                                                      | T3     | 同上                                                                     |
| **T6**  | `MultiSelect` 改用共享匹配（不套阈值）                                                                     | T1     | `packages/frontend/src/components/MultiSelect.tsx`                       |
| **T7**  | 收敛 `lib/user-permissions.ts` 的私有归一化到共享实现（行为等价）                                          | T1     | `packages/frontend/src/lib/user-permissions.ts`                          |
| **T8**  | 收敛 `runtime-parameters/catalog.ts` 的 `normalizedSearch`（保留其拼接语义与去花括号步骤）                 | T1     | `packages/frontend/src/components/runtime-parameters/catalog.ts`         |
| **T9**  | 删除 `CodeHostCallEdit.tsx:906` 手写阈值                                                                   | T3     | `packages/frontend/src/components/canvas/inspector/CodeHostCallEdit.tsx` |
| **T10** | `Select` 默认值契约测试（A1–A6，共 8 条）                                                                  | T3–T5  | `packages/frontend/tests/select-search-default.test.tsx`（新）           |
| **T11** | 源码棘轮 + 负 fixture 并入既有 UX 棘轮文件（A7）                                                           | T3、T6 | `packages/frontend/tests/ux-source-ratchets.test.ts`                     |
| **T12** | 同步 `architecture/guard-manifest.json` 里 `ux-source-ratchets` 的 `lines`                                 | T11    | `architecture/guard-manifest.json`                                       |
| **T13** | `multi-select.test.tsx` 补全角 / description 匹配用例                                                      | T6     | `packages/frontend/tests/multi-select.test.tsx`                          |
| **T14** | 全量回归核对：跑前端测试套件，逐条确认既有锁测是否零改动通过；有例外则记入 §3                              | T3–T13 | —                                                                        |
| **T15** | 登记 `design/plan.md` RFC 索引 + `STATE.md` 状态流转                                                       | T14    | `design/plan.md`、`STATE.md`                                             |

## 2. PR 拆分建议

**单 PR**（CLAUDE.md §RFC workflow 第 5 条默认形态）。改动集中在 2 个共享组件 + 1 个新纯函数模块 + 3 处收敛，拆开反而会让"棘轮先落地、实现后落地"这种半截态推上共享 `main`。

commit message 前缀：`feat(frontend): RFC-325 全平台下拉框搜索能力`。

## 3. 变更记录（实现期逐条追加）

> 本节在实现过程中倒序追加。特别是：任何一条既有锁测因本 RFC 而必须修改，都要在这里写明**是哪条测试、原本锁的是什么、为什么这次的改法让它不再成立**——不得静默改测试（proposal §6 A9）。

### 2026-08-25 —— T1–T15 实现落地

**做了什么**（按 §1 编号）：T1/T2 新增 `lib/option-search.ts` + 12 条纯函数单测；T3–T5 `Select` 条件默认值、
四字段匹配、Esc 两段；T6 `MultiSelect` 接入同一 matcher；T7/T8 收敛 `user-permissions` 与
`runtime-parameters/catalog` 的私有归一化；T9 删除 `CodeHostCallEdit` 手写阈值；T10 新增 17 条默认值契约测试；
T11 棘轮 + 负 fixture 并入 `ux-source-ratchets.test.ts`；T13 `multi-select.test.tsx` 补 2 条归一化用例；
额外补了 A8 的直接锁测（见下）。

**T12 判定为不做（不改 `architecture/guard-manifest.json`）**：查证 `lines` 字段**全仓没有任何消费者**
——`rfc317-architecture-ledgers` / `rfc317-guard-negative-fixture` / `rfc317-guard-corpus-floor` 三个守卫
（58 条断言）跑绿，都不读它；它是生成器在 `recordedAtSha: 0d4010e53` 那一刻记的快照元数据。手工只改一行
`lines` 反而会让它与 `recordedAtSha` 的快照语义脱节，而这份文件又是多 session 混文件。`ux-source-ratchets`
条目本身的 `assertsAbsence: true` / `negativeFixture: true` / `corpusScanner: true` / `minCorpusFiles: 250`
在新增断言后**全部仍然属实**，无需改动。

**唯一被改动的既有锁测：`select-searchable.test.tsx` 的 S6**（proposal §6 A9 要求逐条交代）：

- 它锁的是「筛选过之后重开，Enter 必须选中**当前选中项**（reviewer / 索引 2），而不是筛选态下索引 0 那一行」
  ——Codex P2 报出的真实回归。
- 为什么这次会红：它原本用**一次 Esc 关闭**下拉；RFC-325 把 Esc 改成两段，第一次只清词、下拉还开着，
  紧接着那句 `click(trigger)` 就把它**切换成了关闭**，再点一次才重开——于是断言时下拉是关的，
  `getByTestId('sel-search')` 直接抛错。红的是收尾动作，不是它锁的那条不变式。
- 改法：改用**点 trigger 关闭**，并**刻意不用「按两次 Esc」**——两次 Esc 会先把词清掉，于是变成
  「在全量列表上关闭再重开」，那正好**不再复现**它要锁的场景。现在的写法保持「带着筛选态关闭」这一
  原始状态，另外顺手多断言了两句（第一次 Esc 后 listbox 仍在、点 trigger 后 listbox 消失），
  等于把两段 Esc 的行为也一起钉进这条用例。文件顶部注释同步写明默认值与两段 Esc 的契约归属新文件。

**额外补的 A8 直接锁测**：`model-select.test.tsx` 加一条——10 个模型（+ 占位行 + custom 行 = 12 项）时
`ModelSelect` **零调用点改动**自动长出搜索框，且按 provider 名（`group`，改动前搜不到的字段）与模型名
两路收敛。US1 这条最痛的诉求由此有了自己的回归防护。

**变异实证（注入 → 红 → 还原 → 绿）**，8 条全部咬中：

| 变异 | 注入内容                                               | 结果                |
| ---- | ------------------------------------------------------ | ------------------- |
| M1   | 默认值回退成 `props.searchable === true`（改动前形态） | 10 红               |
| M2   | Esc 回退成一段                                         | 3 红                |
| M3   | 匹配面缩回 `label + value`                             | 3 红                |
| M4   | 去掉空格选中的 `!searchable` 闸门                      | 1 红                |
| M5   | 去掉 typeahead 的 `!searchable` 闸门                   | 2 红                |
| M6   | `normalizeSearchText` 去掉 NFKC                        | 4 红（跨 3 个文件） |
| M7   | 棘轮的 `HAND_ROLLED_THRESHOLD_RE` 收窄成永不匹配       | 1 红                |
| M8   | 阈值从 8 改成 4                                        | 3 红                |

> M5 第一次注入**没咬中**（17 条全绿）——不是用例不行，是替换串按多行写的，而 prettier 早把那个
> `else if` 条件折成了一行，注入压根没生效。按单行形态重注后 2 红。**变异实证必须先确认注入真的发生**，
> 否则「没红」会被误读成「用例没覆盖」或（更糟）「覆盖了」。

**全量核对**：`bunx vitest run`（frontend）**803/803 文件、6807/6807 用例全绿**。
`bunx tsc --noEmit` 报 5 个文件有错——`AclPanel.tsx` / `TaskMembersPanel.tsx` / `tasks.new.tsx` /
`acl-manage-loss.test.tsx` / `task-members-manage-loss.test.tsx`——**全部归属并发的 RFC-324 session**
（他们正在改 `packages/shared/src/schemas/resourceAcl.ts` 把 grant 拆出 level，`users` 字段已从 schema 摘掉、
消费方还没跟上，是典型的跨文件重构半截态）。本 RFC 触及的 12 个文件**零 TS 报错**，eslint `--max-warnings 0`
与 prettier 均通过。

**e2e / 视觉基线**：按 design §9 的核查结论零改动——11 处 e2e combobox 交互全是「点 trigger → 点 option」，
不打字、不依赖焦点落点；`visual-regression.spec.ts` 没有任何一张基线截的是展开中的 listbox。

## 4. 共享工作树注意事项

- `architecture/guard-manifest.json` 是**多 session 混文件**（session 启动时已处于 modified 状态，属他人在制品）。T12 必须**以 `origin/main` 为底、只叠加 `ux-source-ratchets` 那一处 `lines`**，姿势见 `docs/dev-gotchas.md` 的「`git commit -- <路径>` 读的是工作树不是 index」——同一个坑把 main 弄红过两次。
- 提交一律**按路径精确 `git add`**，`git commit -- <本 RFC 的路径…>`，提交前 `git diff --cached --stat` 复核暂存区。
- 不碰工作树里他人的未追踪文件（如 `packages/backend/tests/helpers/staticCachedRepositoryPreparation.ts`）与他人改过的视觉基线 png。

## 5. 验收清单

- [x] **A1** 8 项渲染搜索框 / 7 项不渲染；`SELECT_SEARCH_THRESHOLD` 导出且 === 8
- [x] **A2** `searchable={false}` 在 20 项上关闭；`searchable` 在 3 项上开启
- [x] **A3** `description` 命中；`group` 命中
- [x] **A4** 全角 ↔ 半角、大小写、中文子串命中
- [x] **A5** Esc 两段（有词清词不关闭 / 无词关闭回焦），且不冒泡关掉外层 Dialog
- [x] **A6** 阈值以下：首字母 typeahead + 空格选中照旧
- [x] **A7** `Select` 与 `MultiSelect` 共用同一匹配函数；全仓无手写 `searchable={...length > N}`（含负 fixture）
- [x] **A8** `ModelSelect` 在 8+ 模型时自动获得搜索
- [~] **A9** 本机 frontend 全量 803/803 绿；唯一例外（select-searchable S6）已按要求记入 §3。**hosted CI 待推后按 exact SHA 盯**
- [ ] Codex 实现门跑过并修完 findings（按路径限定审查范围，剔除指向他人路径的条目）
- [ ] push 后按 exact SHA 盯 CI 到绿
