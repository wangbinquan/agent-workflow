# RFC-619 技术设计

记号：`S/` = `packages/backend/src/`，`T/` = `packages/backend/tests/`。生产行为不变。

## 0. 架构落位与裁定（RFC-294 第 8 条）

- **落位**：

  | 旧位置                          | 新位置                                              |
  | ------------------------------- | --------------------------------------------------- |
  | `S/util/gitCredentialLease.ts`  | `S/platform/execution/local/gitCredentialLease.ts`  |
  | `S/util/gitCredentialHelper.ts` | `S/platform/execution/local/gitCredentialHelper.ts` |
  | `S/util/oidcResponse.ts`        | `S/routes/oidcResponse.ts`                          |

- **裁定一：凭据租约与助手入口归 platform，不归 source-control**。架构报告的旧文件 owner 表把两者记作 source-control，但读者里有 bootstrap 与入口
  `main.ts`：放进 source-control，前者要深引模块 `infrastructure/`（design §3 的 bootstrap 禁止项），后者同样越界。它们是 git 厂商命令行的凭据通道，与 git
  运行器 `gitProcess.ts`、加固参数 `gitHardening.ts`（RFC-591 / RFC-617）和另一个单二进制额外入口 `managedProcessLauncherEntry.ts` 同目录；platform 取
  `@/embed` / `@/embed.generated` 已有先例（`managedProcessLauncher.ts`、`migrationsFolder.ts`）。
- **裁定二：OIDC 失败页放到唯一读者 `routes/oidc-auth.ts` 旁边，随 OIDC 路由一族迁入 identity-access**。它是该 context OIDC 回调路由的 HTTP 呈现，不 import
  任何东西。直接放进 identity-access 的 `inbound/http/` 会让 legacy 路由取模块内部——RFC-317 R1 禁止的新边（集中验证第一轮 `rfc317-module-boundary` 与 `rfc305`
  的 identity-access 边账都因此红），而路由本身要等 `auth/` 一族才能迁。owner 表登记 `routes/oidcResponse.ts` → identity-access。
- **裁定三：source-control `composition.ts` 里 `cleanupOrphanedGitCredentialLeases` 的转出删除**。没有读者（bootstrap 一直直取 `util/`，用例也是），
  转出一个 platform 机制不是模块装配的职责。
- **唯一的代码改动**：租约在源码运行时（非内嵌）用 `resolve(import.meta.dir, '..', 'main.ts')` 找入口，迁移后目录深了两层，改为
  `resolve(import.meta.dir, '..', '..', '..', 'main.ts')`；内嵌二进制走 `process.execPath` 的隐藏子命令，不受影响。由 RFC-619 用例 ④ 锁住。
- **偏离项**：无。

## 1. 改动

- 迁移三个文件（§0 的表），`util/` 目录删除。
- 读者改指：`bootstrap/daemonApplication.ts`、`main.ts`、source-control 四个文件（`repositoryMirrorCache.ts`、`repositoryPublicationTransport.ts`、
  `crewstation/gitCredentials.ts`、`crewstation/publicationTransport.ts`）、`routes/oidc-auth.ts`；source-control `composition.ts` 的转出删除。
- 构建：`scripts/build-binary.ts` 的 `gitCredentialHelperEntry` 指向新位置；`T/architecture/rfc294Gates.ts` 的 `BINARY_ENTRIES` 随之改。
- 钉着旧路径的锁与账本：`T/architecture/rfc427-entry-root.test.ts`（入口 `main.ts` 的 import 白名单）、`T/rfc321-repository-publication-ratchet.test.ts`
  两处、`T/rfc205-git-credential.test.ts` 与 `T/rfc321-repository-publication-transport.test.ts` 的 import、`T/rfc321-cached-repo-refresh-credential.test.ts`
  的注释、`T/rfc575-util-errors-hash-log-into-platform-boundary.test.ts` 的 `util/` 余量清单（清空，目录不在时按空清单计）、架构报告的旧文件 owner 表删三行、
  加 `routes/oidcResponse.ts` 一行。
- CI：`.github/workflows/windows-platform.yml` 的 push / pull_request 路径过滤删去 `util/gitCredentialHelper.ts` 与 `util/gitCredentialLease.ts` 两条字面量，
  迁移后它们已被同一块里的 `platform/execution/local/**` 覆盖（注释随之改）。
- `architecture/counts.json`：`legacy-horizontal-files` 47 → 45（两个凭据文件离开 legacy 目录，OIDC 失败页从 `util/` 换到 `routes/`）。

## 2. 用例

- 新增 `T/rfc619-util-emptied-boundary.test.ts`，登记 guard-manifest：
  1. `util/` 目录不在，三个文件在新位置。
  2. backend 的 `src`、`tests`、`scripts` 与仓库根 `scripts`、`tests` 里没有文件再经任何写法取 `util/` 下的路径（按语法树取模块说明符，语料下限 3,000）。
  3. 构建脚本解析出的单二进制入口含新位置的凭据助手，`BINARY_ENTRIES` 也含，两者都不再含 `util/`。
  4. 源码运行时 `gitCredentialHelperValue()` 的命令里，入口就是存在的 `src/main.ts`（相对路径错一层就红）。
  5. 负对照：别名、相对路径与 `mock.module` 三种写法都认得出，字符串里的路径与同前缀的 `@/utility/…` 不算；命令解析认得出带空格与单引号的路径。
- 原用例照旧覆盖行为：`rfc205-git-credential`（租约、子命令、开机清理）、`rfc321-*`（发布凭据通道）、`rfc254` 的 Windows 一族、OIDC 路由用例。

## 3. 失败模式

- **有人重建 `util/` 或再取旧路径**：RFC-619 用例 ①② 红、`rfc575` 余量清单红、计数超过 max。
- **构建入口与门的清单不一致**：RFC-619 用例 ③ 红。
- **租约的入口路径算错**：RFC-619 用例 ④ 红。

## 4. 对 RFC-294 刷新后规则的对账

- **design §2.2**：`util/` 中的通用原语归 `platform/`。**C12**：RFC-619 用例扫全部源码与用例，带语料下限与负对照。**C13**：计数降、不升。
