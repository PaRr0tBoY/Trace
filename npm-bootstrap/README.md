# @parrotboy/trace

一条命令安装 [Trace](https://github.com/PaRr0tBoY/Trace)（Windows 剪贴板管理器）。

```bash
npm install -g --allow-scripts=@parrotboy/trace @parrotboy/trace
```

或一次性试用（不污染全局）：

```bash
npx --yes @parrotboy/trace
```

## 它是怎么工作的

这个包本身只有几百字节，**不携带任何二进制**。`postinstall` 脚本会：

1. 从 GitHub 最新 release 拉取 `latest.yml`（electron-updater 同款元数据，内含安装包 SHA-512）；
2. 下载 NSIS 安装器（`Trace-Setup-<version>.exe`）；
3. 校验 SHA-512，不匹配则拒绝执行并删除文件；
4. 静默执行 `/S` 安装（per-user，无需管理员权限）。

安装完成后应用内自动更新由 Trace 自带的 electron-updater 负责（从 GitHub Releases 拉取），与本包无关。本包是"版本无关的跳板"：**发布一次即可，永远装最新版**。

## 环境变量

| 变量 | 作用 |
|---|---|
| `TRACE_SKIP_INSTALL=1` | 跳过安装（exit 0），适用于只想下载不想装的场景 |
| `TRACE_REPO=owner/repo` | 指定其他 GitHub 仓库 |
| `TRACE_SETUP_URL=...` | 跳过 latest.yml，直接下载指定 URL（测试用） |
| `TRACE_SETUP_SHA512=...` | 配合 `TRACE_SETUP_URL` 指定期望的 SHA-512（base64） |
| `TRACE_TEST_MODE=1` | 只下载+校验，不执行安装器 |

## 安全说明

`postinstall` 下载并执行安装器属于供应链审计工具会关注的模式。本包采取的缓解措施：

- 安装包 SHA-512 与 release 内发布的 `latest.yml` 比对，篡改即中止；
- 安装器与 release 均发布在受控的 `PaRr0tBoY/Trace` 仓库；
- 支持 `TRACE_SKIP_INSTALL=1` 逃生口。

## 系统要求

- Windows 10/11（x64），Node.js ≥ 18。

## 发布

```bash
cd npm-bootstrap
npm publish --access public
```

需要 npm 账号 + 名为 `parrotboy` 的 npm 组织（[npmjs.com/org/create](https://www.npmjs.com/org/create) 免费创建，成员用现有账号即可）。发布一次即可，后续 Trace 发版无需重发本包。
