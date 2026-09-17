# 发布流程（npm）

发布只走 CI：推送一个 `v*` 版本 tag → GitHub Actions 在 `ubuntu-latest` 与 `windows-latest` 上跑完
`typecheck` / `test` / `validate:config` / `check:pack` → `publish` job 用 OIDC 信任发布把包发到 npm。

本地 `npm publish` 不是支持路径：它会绕过上面的门禁，也拿不到 provenance。

## 一次性配置（npm 侧，需包维护者带 2FA 操作）

npmjs.com → Packages → `pi-permission-guardian` → Settings → Trusted publishing → Add a trusted publisher →
GitHub Actions：

| 字段 | 值 |
|---|---|
| Organization or user | `deqiying` |
| Repository | `pi-permission-guardian` |
| Workflow filename | `ci.yml`（只填文件名，不带路径；**改了 workflow 文件名必须同步改这里**，否则 OIDC 换 token 会失败） |
| Environment name | 留空（workflow 未使用 GitHub environment） |
| Allowed actions | **必须勾选 `npm publish`**。2026-09-03 之后新建的 trusted publisher 默认只允许 `npm stage publish`，不勾选是「配了也发不出去」 |

配置依据（docs.npmjs.com/trusted-publishers 与 /generating-provenance-statements）：

- 要求 npm CLI ≥ 11.5.1、Node ≥ 22.14.0。Node 22.x 内置的 npm 是 10.9.x，不满足，所以 `publish` job 单独用
  `node-version: 24.x`（内置 npm 11.x），而 verify 双腿保持 22.x 守 `engines >= 22` 的下限。
- 配好 trusted publishing 后 provenance 自动生成，不需要 `--provenance` 参数；provenance 要求 `package.json`
  的 public repository 与 GitHub 仓库大小写一致（当前满足）。
- 配好后建议在同一页把 Publishing access 设为 "Require two-factor authentication and disallow tokens"，
  把长期写入 token 这条路径也关掉。

## 一次正式发布

```bash
bash scripts/release.sh 0.2.0        # 改版本号 + 提交 + 打本地 tag（Windows：pwsh -File scripts/release.ps1 0.2.0）
git push origin main
git push origin v0.2.0               # tag 推送触发 CI；verify 双腿全绿后 publish job 才会跑
```

`publish` job 的第一步会断言 tag 与 `package.json` 的版本一致，不一致直接失败——发布不可回退，宁可停在这里。

发布后自查：

```bash
npm view pi-permission-guardian version dist-tags time.modified
```

- `dist-tags.latest` 应指向刚发的正式版本。
- npm 包页面上应出现 provenance 徽标（attestation 指向本仓库的 commit 与 workflow）。
- `npm publish` 会触发 `prepack` 重新生成 `schemas/guardian.schema.json`，所以发出去的 schema 与 zod 同步；
  漂移门禁（`test` 与 `check:pack`）已经在 verify 里跑过。

## 首次演练（建议）

第一次走 CI 发布时，先用预发布版本验证 OIDC 与 provenance，`latest` 不受影响：

```bash
bash scripts/release.sh 0.2.0-rc.1
git push origin main
git push origin v0.2.0-rc.1
```

预发布版本会以自身的预发布标识作为 dist-tag（`0.2.0-rc.1` → `--tag rc`）。这不是可选优化：
npm CLI 明确拒绝把预发布版本隐式发到 `latest`（`You must specify a tag using --tag when publishing a prerelease version.`，
npm 11 `lib/commands/publish.js`），所以 `publish` job 会从版本号推导 dist-tag。

验证无误后再发正式版。

## 失败与重跑

| 情况 | 处理 |
|---|---|
| verify 失败（含 flake） | 修好或直接重跑失败 job；`needs: verify` 保证不会在半绿状态下发布 |
| `publish` 在发布前失败（OIDC、provenance、网络） | 直接重跑失败 job；版本尚未发出，不会冲突 |
| 版本已经发布过又重跑 `publish` | 报 `cannot publish over previously published version`；这是 npm 的既有版本保护。当前 workflow 未做「已发布则跳过」，所以整轮重跑会红在这一步——但产物已经发出，不要为此改版本号 |
| tag 与 `package.json` 版本不一致 | `publish` job 第一步失败；删掉本地与远端 tag，重新发 |
| 想给已存在但未发布的 tag 补跑（如历史 tag `v0.1.2`） | 在 Actions 页面用 `workflow_dispatch` 选择该 tag 作为 ref：`publish` 的 `if` 只看 `refs/tags/v*`，tag ref 下的手动触发会正常发布；分支 ref 下则只跑 verify |

发布不可回退：npm 对已发布版本的删除有严格限制，所以守卫失败要好过发出错误版本。

## 与 release 脚本的关系

`scripts/release.sh` / `scripts/release.ps1` 只做「改版本号 + 提交 + 打本地 tag」，不 push、不发布；
发布动作只发生在 CI 里。版本号的唯一真源是 `package.json`，CI 会断言 tag 与它一致。
