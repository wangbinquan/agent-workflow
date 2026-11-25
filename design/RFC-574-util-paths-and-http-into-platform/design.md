# RFC-574 技术设计

记号：`S/` = `packages/backend/src/`，`P/` = `S/platform/`。落在 platform（接收两个文件）与它们的读者（只改 import）。另改架构报告的归属表、
`architecture/counts.json`、公共内核清单的一条、钉着旧路径的用例（含三个用正则写的“禁止取”判据）与两处文档，新增一个 RFC-574 用例。数字取 HEAD
`3a9a99e64`。不改行为。

## 1. 文件去向

| 原位置            | 新位置                                 | 说明                                                                                                                   |
| ----------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `S/util/paths.ts` | `P/configuration/installationPaths.ts` | 安装目录与其下文件的位置，与同目录的配置文件读写（`fileConfiguration.ts`）同属“这台安装的配置”；只取 node 的 os / path |
| `S/util/http.ts`  | `P/http/requestParsing.ts`             | 与同目录的 `jsonDocument.ts`、`multipartLaunch.ts` 同类；读者都是 HTTP 入站。取 `util/errors` 与 `hono`                |

`requestParsing.ts` 内容原样。`installationPaths.ts` 只改一处：`migrationsDir` 与 `postgresqlMigrationsDir` 用 `import.meta.dirname` 回到 backend
包根再进 `db/`，原来是两级（`util` → `src` → 包根），文件深了一层，改成三级（`configuration` → `platform` → `src` → 包根），并写明层数对应的目录。
单二进制里这两个值本来就不用（嵌入的迁移另行解包，见 `migrationsFolder.ts`），不受影响。

## 2. 读者改指

与 RFC-571～RFC-573 同一个解析器式的改写。读者里有只动 import 那一行、别的不动的文件：`util/gitCredentialLease.ts`、`util/gitHardening.ts`
（取 `paths`）与 `routes/` 下的 `auth.ts`、`oidc.ts`、`oidc-auth.ts`、`accountRepositoryTransportCredentials.ts`（取 `http`）。改写也会改到用例里
当夹具用的源码字符串（`from '@/util/paths'` 一类），对应的期望值随改（§3）。

## 3. 门、用例与文档

- 架构报告的 `LEGACY_BACKEND_FILE_OWNERS` 删去两行；`counts.json` 的 `legacy-horizontal-files` 上限 103 → 101；公共内核清单里 `util/http` 那一条的
  文件路径与标题改成新位置（它的 `claimAudit` 引的是 `rfc284-safejson-convergence` 的行号，那个用例只改行内文字、不增删行）。
- 钉着旧路径的用例随改：`rfc427-entry-root` 的入口 import 白名单、`rfc439` 的 inbound 依赖白名单、`rfc284-safejson-convergence` 跳过的定义文件、
  `rfc254-control-listener` 读的源码（路径是分段拼的）、`rfc505` 的两处 import 描述（一处是夹具的期望值）、RFC-573 用例里两个依赖清单。
- **三个用正则写的“禁止取”判据**：
  - `rfc346-system-operations-cli`：`cli/backup.ts`、`cli/restore.ts` 不许取 `@/db`、`@/services` 与 `util\/(?:lock|paths|migrationsFolder)`。其中 `lock`
    与 `migrationsFolder` 已经分别在 RFC-572、RFC-573 迁走，正则没跟上——**本人缺陷（RFC-572 / RFC-573 引入）**。改认三个文件的新位置
    （`platform/execution/local/daemonLock`、`platform/configuration/installationPaths`、`platform/persistence/migration/migrationsFolder`）。
  - `rfc346-system-operations-contracts`：system-operations 的 domain / public / application 不许取 `util\/paths` 等；`routes/backup.ts`、
    `routes/restore.ts` 不许取 `util\/(?:paths|migrationsFolder)` 等——后者的 `migrationsFolder` 同属上面的漏改。都改认新位置。
  - `rfc303-architecture-lock`：integration 不许取 `@/services/task` 等与 `util\/paths`；改认新位置，它自带的伪造 import 夹具随改写一起换成新路径。
  - 前两个用例原来没有自证，各把正则提到文件顶层并补一条“伪造的越界 import 逐个被认出、走 public 合同的放行”。
- `e2e/` 里四个 spec 的注释与一条断言说明里有指向被挪文件的“现状指针”（`util/paths.ts`、以及 RFC-572 迁走的 `util/process.ts`、
  `util/lock.ts`、`util/archive.ts`），改成新路径；其中两处 `process.ts` 的行号在本 RFC 之前就已经对不上，顺手改成 `killStaleRunProcessTree` 与它的
  命令行身份闸现在的行号。描述过往事故的注释（“曾把 …”“主干 … 收敛到 …”）照旧不改。
- `docs/env-flags.md` 里 `AGENT_WORKFLOW_HOME` 一行的文件路径与 `docs/dev-gotchas.md`“挪文件前的检索”一节（补正则写法与 `import.meta` 相对路径两种
  检索盲区）。
- 新增 `tests/rfc574-util-paths-and-http-into-platform-boundary.test.ts`，登记 guard-manifest：① 两个旧路径不存在，`src` / `tests` / `scripts` 的全部
  说明符不再解析到它们（带负对照）；② 新位置的两个文件只取登记过的依赖，不取模块；③ 导出的名字与搬迁前相同；④ `Paths.migrationsDir` 与
  `Paths.postgresqlMigrationsDir` 解析到 `packages/backend/db/migrations` 与 `db/postgresql-migrations`，两处都有迁移日志。

## 4. 检索补充（RFC-572 / RFC-573 的教训之外）

这次按路径检索之外另查了四类：`e2e/` 与其余几个包（RFC-572 的检索没覆盖 `e2e/`，留下了指向 `process.ts`、`lock.ts`、`archive.ts` 的五处注释与
断言说明）；用正则写的路径（`util\/`、`util/(?:` 一类，找出上面三个判据）；按 `@/util/` 前缀放行或拒绝的判据（两个：组合层的禁止清单不涉及
新位置，`util/git` 的叶子锁只读 `util/git.ts`，它不取这两个文件）；以及用 `import.meta` 算相对位置的代码（RFC-571～RFC-573 迁走的 19 个文件都
没有；`paths.ts` 有两处，见 §1）。

## 5. 取舍（可推翻）

1. **`paths.ts` 进 `platform/configuration/` 并改名 `installationPaths.ts`**：它说的是这台安装的文件放在哪，与配置文件的读写同类；`configuration/`
   下一个叫 `paths` 的文件说不清是什么的路径。代价是层数要跟着改一处，由用例 ④ 直接锁住。
2. **`http.ts` 进 `platform/http/` 并改名 `requestParsing.ts`**：它只做请求参数与正文的解析；`http/` 下一个叫 `http` 的文件没有信息量。
3. **正则判据改认新位置，不保留旧路径**：旧路径已经不存在、也被各 RFC 的用例锁住不许再出现，留在正则里没有作用。
4. **平台文件仍取 `util/errors`**：随 `errors` 自己的迁移（读者上千处，另立）；RFC-572 起平台取 `util/` 是容许的过渡。

## 6. 失败模式

- **有人在旧路径重建文件或重新取它**：RFC-574 用例 ① 红。
- **`installationPaths.ts` 的层数写错**：用例 ④ 红；源码树里读第一代迁移历史的用例（`rfc395-v1-frozen-source`、`rfc395-v1-source-evidence`、
  `rfc395-history-response-parity`）经 `resolveMigrationsFolder()` 读这两个目录，也红。开库本身走 epoch-2 的运行时、不读编号迁移目录，所以开库
  的用例不受这一项影响（起初这里写的是“开库的用例也会红”，被变异 m5 推翻后改正）。
- **三个正则判据又被收窄或漏认新位置**：各自的自证红。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：两个平台机制进 platform 的对应目录。**C11**：不涉及 public。**C12**：RFC-574 用例 ① 覆盖 `src` / `tests` / `scripts` 的全部说明符；② ③
  只读两个新文件；④ 跑真实的 `Paths`。三个正则判据各自覆盖它们原来的文件集合。**C13**：`legacy-horizontal-files` 103 → 101，其余计数不升。
- **本 RFC 承担的演进**：W9-D 里 `util/` 的第四批；修正 RFC-572 / RFC-573 漏改的两条正则判据。
- **留下的债**：`util/` 余 13 个（proposal 非目标一节）。
