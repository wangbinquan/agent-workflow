# RFC-262 · upload 输入的同名冲突策略（可选覆盖代码仓已有文件）

状态：Draft
作者：本 session（用户提出）
关联：[RFC-020](../RFC-020-input-file-upload/proposal.md)（上传输入本体）、[RFC-107](../RFC-107-url-launch-multipart-upload/proposal.md)（URL 启动 + 上传的路径安全）、[RFC-218](../RFC-218-agent-launch-port-form/proposal.md)（agent 端口派生 upload 输入）、[RFC-248](../RFC-248-repo-groups/proposal.md)（多仓上传落 `.agent-workflow-inputs/`）

## 1. 背景

`kind: 'upload'` 输入把用户本地文件写进任务 worktree 的 `targetDir`，再把 repo-relative 路径按 `\n` 打包喂给下游 `{{port}}`（RFC-020）。

今天的**重名语义是硬编码的"永不覆盖"**：

- `packages/backend/src/services/upload.ts:145` `resolveUniqueName()` 一旦发现同名条目（`lstat` 判定，软链 / 目录 / 悬空链接都算占用），就改名成 `report (1).pdf`、`report (2).pdf`；
- `design/RFC-020-input-file-upload/design.md:215` 明文写死："**重名占位**：始终是"加 (n) 起新名"，**绝不覆盖** 已经存在的文件（即使是 untracked 用户文件）"。

这在"上传物是**新增**参考资料"的场景下是对的，但覆盖不了另一个同样高频的场景：**上传物就是要替换仓里那一份**。

典型：仓里有 `spec/api.yaml`（或 `data/input.csv`、`docs/prd.md`），用户手上有一份修订过的同名文件，想让 agent 基于新版本干活。今天的结果是：

1. 文件落成 `spec/api (1).yaml`，仓里的旧版仍在；
2. agent 若按 prompt 里的 `{{port}}` 路径读，读到的是新文件——但**仓内其它文件对 `spec/api.yaml` 的既有引用（import / include / 相对路径）仍然指向旧版**，agent 顺着引用读就读回旧内容；
3. 用户没有任何办法表达"替换"，只能事后让 agent 自己 `mv`，等于把框架该做的事塞进 prompt 里赌模型执行。

## 2. 目标

- **G1**：工作流作者可对每个 `kind: 'upload'` 输入声明同名冲突策略——`rename`（默认，与今天字节级一致）或 `overwrite`（覆盖 worktree 内已存在的同名文件）。
- **G2**：覆盖路径**不削弱** RFC-107 的安全性质——绝不写穿一个已存在的路径（尤其是不可信 URL-clone 仓提交进来的符号链接），落点永远在 worktree 内。
- **G3**：同一次上传里出现同名文件时，**在启动校验阶段就报错**并提示重名，不落盘、不建 worktree、不 clone 仓库。
- **G4**：策略随工作流定义走（DB 唯一事实源 + YAML 导入导出原样往返），启动者不需要也不能临时改。

## 3. 非目标

- **启动者级开关**：不在启动表单里加"本次覆盖"勾选（用户拍板 D1：作者级）。
- **RFC-218 agent 端口派生的 upload 输入**：它们落在框架私有目录 `.agent-inputs/<port>`（`packages/shared/src/agentLaunchForm.ts:24`），与仓内文件天然不冲突，不暴露该选项，恒为 `rename`。
- **被覆盖文件的备份 / 撤销**：见 design §D5——上传写盘失败会整棵清理 worktree 且不建任务行，没有"恢复"这一说。
- **跨 workflow-call 传递**：`call-workflow` 本就拒绝 upload 输入（`workflow.validator.ts:2501`），本 RFC 不改。
- **MCP / 定时任务启动**：这两条路径本就拒绝含 upload 输入的工作流（`mcp/tools.ts:396`、`scheduledTasks.ts` uploadUnsupported），不受影响。

## 4. 用户故事

1. **替换规格文件**：作者在画布 Input 节点上把 `spec` 输入的冲突策略设为"覆盖"。用户启动任务时上传 `api.yaml`，任务 worktree 里的 `spec/api.yaml` 被替换为上传版本，`{{spec}}` 拿到 `spec/api.yaml`（而不是 `spec/api (1).yaml`），仓内所有既有引用自动指向新内容；wrapper-git 的 `git_diff` 把这次替换如实记为一条 modification。
2. **保留默认行为**：另一个工作流的 `refs` 输入没动过策略，行为与今天完全一致——同名就改名，仓里原文件一个字节都不动。
3. **重名提醒**：用户一次选了两个 `report.pdf`（从两个目录各选一个），启动按钮旁立刻提示"文件名重复"，硬点提交也会被后端 422 拒掉，不会静默丢文件、也不会先 clone 完仓再失败。

## 5. 验收标准

| 编号  | 验收点                                                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------- |
| AC-1  | `UploadInputSchema` 接受可选 `onConflict: 'rename' \| 'overwrite'`；缺省视为 `rename`；非法值在保存工作流时被拒                  |
| AC-2  | `onConflict` 缺省 / `'rename'` 时，与既有同名文件冲突仍产出 `report (1).pdf` 且原文件内容不变（存量断言不改判）                  |
| AC-3  | `onConflict: 'overwrite'` 且目标是普通文件时：文件被替换为上传内容，packed 路径是**原名**（无 ` (n)` 后缀）                      |
| AC-4  | `onConflict: 'overwrite'` 且目标是**符号链接**时：链接本体被删除并换成真实文件；链接指向的 worktree 外文件**内容不被改写**       |
| AC-5  | `onConflict: 'overwrite'` 且目标是**目录**时：以 `upload-target-is-dir` 失败，不写任何文件                                       |
| AC-6  | 同一次上传里两个文件落到同一目录同一文件名 → `upload-duplicate-filename` 422，**发生在 clone / worktree 物化之前**               |
| AC-7  | 判重跨 input key 生效：两个不同 upload 输入配了同一 `targetDir`、各上传一个同名文件 → 同样报 `upload-duplicate-filename`         |
| AC-8  | 画布 Input 节点 inspector 能编辑该策略，用既有 `.segmented` 公共样式；改动进撤销栈、自动保存、YAML 导出/导入原样往返             |
| AC-9  | 启动表单在提交前就提示同名冲突并阻止 Start（与后端共用同一个 shared 纯函数判重）                                                 |
| AC-10 | 覆盖模式仍不跟随符号链接、不写出 worktree：RFC-107 的既有安全用例全绿，且新增覆盖分支的对应安全用例                              |
| AC-11 | e2e：预置仓内同名文件 + `overwrite` 工作流 → 启动后 packed 路径无 ` (1)` 后缀、agent prompt 拿到原路径、worktree 内是上传的内容   |
| AC-12 | 错误码 `upload-duplicate-filename` / `upload-target-is-dir` 有中英文案；`docs/workflow-yaml.md`、`intentDoc.ts` 的字段清单已更新 |

## 6. 能力影响清单（CLAUDE.md §7 强制章节）

本 RFC **关闭了一项既有能力**（G3 是用户明确要求的收缩），逐项列出待确认：

| #   | 被关闭 / 收缩的既有能力                                                                                                      | 今天的行为                                                                | 变更后                                                        | 受影响面                                                                                                    | 判据                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| C1  | **同一次上传内同名文件自动改名**（对**全部** upload 输入生效，含未开覆盖的）                                                  | 两个 `report.pdf` 一起提交 → 落成 `report.pdf` + `report (1).pdf`，都成功 | 启动被拒：`upload-duplicate-filename` 422                     | launcher UI 启动、`POST /api/tasks` multipart、agent 启动 multipart（`agentLaunch.ts:472`）；RFC-218 派生端口同样受限 | 用户拍板"对所有 upload 输入一律报错"；仓内**无**存量测试锁定同批改名行为   |
| C2  | **大小写不同的同名文件同批上传**（`Report.pdf` + `report.pdf`）                                                               | Linux（大小写敏感 FS）上两份都落地；macOS 上第二份被 `resolveUniqueName` 改名 | 两个平台一律拒（判重按 NFC + 大小写折叠）                     | 同 C1                                                                                                       | **待你确认**：见下方"C2 备选"                                              |
| C3  | 覆盖模式下目标是**目录**时的"绕开"能力                                                                                       | 改名成 `report (1).pdf` 后照常成功                                        | `upload-target-is-dir` 启动失败                               | 仅 `onConflict: 'overwrite'` 的输入（新能力，无存量用户）                                                    | 覆盖一个目录没有合理语义，静默改名等于"我开了覆盖但它没覆盖"               |
| C4  | 覆盖模式下**保留仓内符号链接**                                                                                               | 改名绕开，链接原样保留                                                    | 链接本体被删除、替换为真实文件（不跟随、不改写链接目标）      | 仅 `onConflict: 'overwrite'` 的输入（新能力，无存量用户）                                                    | 这是"覆盖"的字面语义；不跟随是 RFC-107 的安全底线                          |

**C2 备选**（需你拍板其一）：

- **方案 A（本 RFC 现取）**：判重大小写不敏感。理由：macOS / Windows 的文件系统大小写不敏感，`Report.pdf` 与 `report.pdf` 在那里**必然**互相覆盖或改名——覆盖模式下就是静默丢文件，正是 G3 要拦的洞。跨平台行为统一，代价是 Linux 上原本合法的一对被拒。
- **方案 B**：判重只按精确名（NFC）。Linux 行为不变，代价是 macOS 上覆盖模式仍可能静默丢一份（框架层无法从 `lstat` 结果区分"命中的是同批刚写的那份"还是"仓里原有的那份"，除非再引入 inode 比对）。

C1 / C3 / C4 无备选（C1 是你的明确要求，C3 / C4 只作用于本 RFC 新引入的模式）。

## 7. 风险

- **误开覆盖导致仓内文件被替换**：影响面限于该任务的 worktree 副本，**用户本地源仓工作区不受影响**（任务跑在 `git worktree add` 出来的独立目录里）；被覆盖的已跟踪文件在 worktree 里可 `git restore`，且会如实出现在 `git_diff` 里被审计到。默认值是 `rename`，需要作者显式改。
- **C1 让存量工作流的某些启动从"成功"变"422"**：仅限"一次提交里选了同名文件"这种本就有歧义的输入，错误信息直接指出重名文件，用户改名重传即可。
