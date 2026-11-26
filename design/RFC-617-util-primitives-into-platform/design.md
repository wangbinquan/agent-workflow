# RFC-617 技术设计

记号：`S/` = `packages/backend/src/`，`T/` = `packages/backend/tests/`。数字取 HEAD `b8864e665`。生产行为不变（逐字迁移）。

## 0. 架构落位与裁定（RFC-294 第 8 条）

- **落位**：

  | 旧位置                   | 新位置                                       | 理由                                                          |
  | ------------------------ | -------------------------------------------- | ------------------------------------------------------------- |
  | `S/util/redact.ts`       | `S/platform/logging/redact.ts`               | 日志与持久化前的脱敏，与结构化日志同目录                      |
  | `S/util/safePath.ts`     | `S/platform/workspace/local/safePath.ts`     | 本机文件系统的越界防护，与 `fsReclaim` 等本机工作区机制同目录 |
  | `S/util/fileTrust.ts`    | `S/platform/execution/local/fileTrust.ts`    | 本机文件的私密性核对，与进程、Windows Job Object 同目录       |
  | `S/util/win32Acl.ts`     | `S/platform/execution/local/win32Acl.ts`     | `fileTrust` 的 Windows 一支，同目录                           |
  | `S/util/gitHardening.ts` | `S/platform/execution/local/gitHardening.ts` | git 运行器（RFC-591 起在这里）的环境策略                      |
  | `S/util/gitRef.ts`       | `S/platform/contracts/gitRef.ts`             | 纯函数，三个模块共用                                          |

- **裁定一：原样迁移**。六个文件逐字迁移，只改两条模块内相对路径（`gitRef` 取同目录的 `./hash`，`gitHardening` 取 `../../configuration/installationPaths`）与
  `fileTrust` 里一处指向旧路径的注释，行数不变，`commons-debt.json` 按行号锚定的条目照旧成立。
- **裁定二：两个 git 文件归 platform，不归 source-control**。架构报告的旧文件 owner 表把 `gitHardening`、`gitRef` 记作 source-control（写于 RFC-591 之前）：
  - `gitHardening` 是 platform 的 git 运行器的环境策略，platform 不得取模块；
  - `gitRef` 是纯函数，development-automation 与 digital-employee 的 application 也在用，放进 source-control 就要给它们新开跨 context 内部文件对（有门禁的计数）。
- **裁定三：凭据助手与 OIDC 一族不在本 RFC**。`gitCredentialHelper` 是单二进制的独立入口（`BINARY_ENTRIES`），与它的租约、`oidcResponse` 随各自一族另立。
- **偏离项**：无。

## 1. 改动

- 六个文件迁移（design §0 的表）；52 个读者文件的 import 改指（别名、相对路径、`mock.module`、`require` 四种写法一并改）。
  改指按语法树上的模块说明符认，别的用例里写在字符串里的负对照（`rfc593` 的两条 `@/util/gitHardening` 伪造源码，其一是 `util/git` 前缀的近似对照）保持原样；
  `rfc591` 对运行器的放行原有一条 `@/util/gitHardening`，运行器现在只取 platform，这条放行删去。
- 指向旧路径的注释（`src` 六处、用例四处与 `.gitattributes` 一处）改指新位置；描述迁移历史的用例文件头与 `docs/` 里的历史条目保持原样。
- 仓库根的性能基准 `tests/perf/run.ts` 直接取 `util/redact` 与 `util/safePath`，一并改指。
- `.github/workflows/windows-platform.yml` 的 push / pull_request 路径过滤里钉着 `util/fileTrust.ts` 与 `util/gitHardening.ts`：两者迁入后已被同一块里的
  `platform/execution/local/**` 覆盖（`win32Acl.ts` 随之也被覆盖），两条字面量删去、在该 glob 旁注明；`ci-workflow-path-filters` 用例锁住过滤项都指向存在的路径。
- 钉着旧路径的账本与源码锁改指：
  - `architecture/commons-manifest.json`（两个内核文件）、`architecture/commons-debt.json`（一条锚点）、`architecture/module-singleton-exceptions.json`（`win32Acl` 两条）；
  - 架构报告的旧文件 owner 表删去六行（它只登记还在 legacy 目录里的文件）；
  - `rfc575` 的 `util/` 余量清单（按它的约定，每个把文件移出 `util/` 的 RFC 同步这一条）、`rfc284` 的路径越界象限锁与 spawn 站点账本、`rfc254` 的两处路径、
    RFC-494 / 495 / 496 / 498 四条闭集依赖锁里的 `@/util/gitRef`。
- `architecture/counts.json`：`legacy-horizontal-files` 53 → 47。

## 2. 用例

- 新增 `T/rfc617-util-primitives-into-platform-boundary.test.ts`，登记 guard-manifest：
  1. 旧位置不在、新位置在。
  2. backend 的 `src`、`tests`、`scripts` 与仓库根 `scripts`、`tests` 里没有文件再经任何写法取旧位置（按语法树取 import、re-export、`import()`、`require()` 与 `mock.module()`，
     别的用例里写在字符串里的负对照不算；语料下限 3,000）。
  3. 六个新文件只取 node 内置、shared 与 platform。
  4. 负对照：判据认得出别名、相对路径与 `mock.module` 三种写法，以及新文件取模块或 legacy 目录。
- 原用例照旧覆盖六个原语的行为（`rfc252` git 加固、`rfc254` Windows ACL 与 git、`rfc284` 路径越界、`rfc247` 脱敏等）。

## 3. 失败模式

- **有人把文件放回 `util/`，或读者重新取旧路径**：RFC-617 用例 ①② 红，`rfc575` 的余量清单红，计数超过 max。
- **新文件取了模块**：RFC-617 用例 ③ 红，`platform-to-modules-file-pairs` 门红。

## 4. 对 RFC-294 刷新后规则的对账

- **design §2.2**：`util/` 中的通用原语归 `platform/`。**C12**：RFC-617 用例扫全部源码与用例，带语料下限与负对照。**C13**：计数降、不升。
