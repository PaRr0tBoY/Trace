# 分发与上架（distribution）

Trace 的软件分发体系。**主渠道 = GitHub Releases**（应用内 electron-updater 自动更新）；npm 是"跳板安装器"；winget / scoop / chocolatey 是系统包管理器渠道。发版自动化由 `.github/workflows/release.yml` 承担。

## 渠道总览

| 渠道 | 用户命令 | 更新方式 | 状态（2026.8.15） |
|---|---|---|---|
| GitHub Releases | 官网下载 | electron-updater 应用内自动更新 | ✅ 主渠道 |
| npm `@parrotboy/trace` | `npm i -g @parrotboy/trace` | 跳板包永远拉 latest；应用内自动更新 | ✅ 包就绪，待发布（需 parrotboy 账号） |
| winget | `winget install PaRr0tBoY.Trace` | 发版时 workflow 自动开更新 PR（winget-releaser） | ⏳ [PR #417780](https://github.com/microsoft/winget-pkgs/pull/417780) 待合并 |
| scoop 官方 Extras | `scoop install trace` | 合入后官方 Excavator bot 自动更新 | ⏳ [PR #18532](https://github.com/ScoopInstaller/Extras/pull/18532) 待合并 |
| scoop 自有 bucket | `scoop bucket add trace https://github.com/PaRr0tBoY/Trace` + `scoop install trace` | workflow 自动更新 `bucket/trace.json` | ✅ 立即可用 |
| chocolatey | `choco install trace` | workflow 发版时自动 `choco pack` + `choco push` | ⏳ 待 chocolatey 账号 + API key |

## 一次发版（发布 vX.Y.Z）

1. `package.json` 版本号改为 `X.Y.Z`（构建产物名与 release 资产名都由此决定）。
2. `git commit` + `git tag vX.Y.Z` + `git push origin vX.Y.Z`。
3. `.github/workflows/release.yml` 自动完成：
   - **build**：`typecheck` + `test` + `npm run build:github`（构建 NSIS 并上传 release 资产）+ 附加 `Trace-Setup-<ver>.exe.sha256` 校验文件；
   - **scoop**：`scripts/update-scoop-manifest.mjs` 更新 `bucket/trace.json` 与 `distrib/scoop/trace.json` 并提交；
   - **choco**：`scripts/update-choco-package.mjs` 更新 nuspec/install 脚本 → `choco pack` → `choco push`（需 `CHOCO_API_KEY`）；
   - **winget**：`vedantmgoyal9/winget-releaser` 自动向 microsoft/winget-pkgs 开更新 PR（需 `WINGET_TOKEN`，且包必须已存在——初始 PR 合并后才生效）。
4. scoop Extras 中的包由 Excavator bot 自动同步，无需操作。
5. npm 跳板包**无需重发**（版本无关，永远拉 GitHub latest）。

## 仓库布局

```
npm-bootstrap/                          @parrotboy/trace 跳板包（postinstall 下载+校验+静默安装）
distrib/winget/manifests/p/PaRr0tBoY/Trace/   winget manifest（winget-pkgs 目录布局）
distrib/scoop/trace.json                scoop Extras 提交副本（与 bucket/trace.json 相同）
distrib/chocolatey/                     choco 包（Trace.nuspec + tools/ 脚本）
bucket/trace.json                       自有 scoop bucket 清单
scripts/update-scoop-manifest.mjs       发版时更新 scoop 清单（版本/URL/SHA-256）
scripts/update-choco-package.mjs        发版时更新 choco 包（版本/URL/SHA-256）
.github/workflows/release.yml           发版自动化
```

## 一次性设置（尚未完成的部分）

### npm — 用现有账号 + 创建 org `parrotboy`

1. 用当前登录的 npm 账号（`ryan2343`）在 **https://www.npmjs.com/org/create** 创建组织，名字填 `parrotboy`（免费；`npm org ls parrotboy` 返回 "Scope not found" 说明还没被占，先到先得）。
2. `npm login`（确认 `npm whoami` 输出自己的账号）。
3. `cd npm-bootstrap && npm publish --access public`（org 包默认私有，必须加 `--access public`）。
4. 发布后验证：`npm view @parrotboy/trace`。之后无需再发。

### chocolatey — 需要 chocolatey.org 账号

1. 注册 chocolatey.org 账号（开源软件免费发布），在个人设置页生成 API key。
2. 本地验证：`choco apikey add -s https://community.chocolatey.org/api/v2/ -k <KEY>`。
3. 仓库 Settings → Secrets and variables → Actions → 新建 `CHOCO_API_KEY`。
4. 首次发布（含审核）可手动：`cd distrib/chocolatey && choco pack && choco push trace.<ver>.nupkg --source https://community.chocolatey.org/api/v2/ --key <KEY>`。合入后 workflow 自动接管。

### winget — 需要 GitHub PAT

1. 创建 classic PAT（勾选 `public_repo` scope）或 fine-grained PAT（winget-pkgs fork 的 contents:write）。
2. 仓库 Secrets 添加 `WINGET_TOKEN`。
3. 等初始 [PR #417780](https://github.com/microsoft/winget-pkgs/pull/417780) 合并后，每次发版 workflow 自动开更新 PR。

### scoop Extras — 无需额外操作

等 [PR #18532](https://github.com/ScoopInstaller/Extras/pull/18532) 合并即可，Excavator bot 自动更新。自有 bucket 立即可用：

```powershell
scoop bucket add trace https://github.com/PaRr0tBoY/Trace
scoop install trace
```

## 手动命令速查

```powershell
# winget manifest 本地验证
winget validate --manifest distrib\winget\manifests\p\PaRr0tBoY\Trace\2026.8.15

# choco 本地打包
choco pack distrib\chocolatey\Trace.nuspec

# npm 本地打包
cd npm-bootstrap; npm pack

# 演练清单更新脚本（用真实 release 资产）
$env:GITHUB_REF = 'refs/tags/v2026.8.15'; $env:GITHUB_REPOSITORY = 'PaRr0tBoY/Trace'
node scripts/update-scoop-manifest.mjs
node scripts/update-choco-package.mjs
```

## 设计要点

- **npm 跳板包是版本无关的**：publish 一次，postinstall 永远从 GitHub latest release 拉安装包，SHA-512 用该 release 内的 `latest.yml` 校验（与 electron-updater 同源），校验失败拒绝执行。安装后的应用更新完全走 electron-updater，与安装渠道无关。
- **每个 release 附带 `.sha256` 资产**（workflow 自动生成）：scoop `autoupdate` 与 choco 更新脚本都以它为哈希来源。
- **winget-releaser 要求包已存在**于 winget-pkgs：首次上架必须走人工 PR（本仓库 `distrib/winget/` 已备好 manifest）。
- **微软商店（appx）是独立渠道**：`npm run build:store`，上架需在 Partner Center 提交，不在本 workflow 内。
