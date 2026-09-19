#!/usr/bin/env bash
# 准备一次发布：改写 package.json / package-lock.json 的版本号，提交并打本地 tag（不推送）。
# 版本号的单一真源是 package.json；package-lock.json 由 npm version 一并同步。
# 以「工作树干净」为前提，避免把无关改动裹进发布提交。
# 失败时可能已改写版本文件（npm version 先执行），此时需 git restore 后重试。
set -euo pipefail

usage='用法: bash scripts/release.sh <semver>   例: bash scripts/release.sh 0.2.0'

if [[ $# -ne 1 ]]; then
  printf '%s\n' "${usage}" >&2
  exit 1
fi

version="$1"
if [[ ! "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
  printf '版本号不是合法 semver：%s\n%s\n' "${version}" "${usage}" >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "${script_dir}/.."

tag_name="v${version}"

current_version="$(node -p "require('./package.json').version")"
if [[ "${version}" == "${current_version}" ]]; then
  printf 'package.json 版本已是 %s，未做修改。\n' "${current_version}" >&2
  exit 1
fi

# 只比较核心数字段：预发布/构建元数据的变化不算降级。
current_core="${current_version%%[-+]*}"
new_core="${version%%[-+]*}"
IFS=. read -r cur_major cur_minor cur_patch <<<"${current_core}"
IFS=. read -r new_major new_minor new_patch <<<"${new_core}"
if ((new_major < cur_major)) \
  || ((new_major == cur_major && new_minor < cur_minor)) \
  || ((new_major == cur_major && new_minor == cur_minor && new_patch < cur_patch)); then
  printf '新版本 %s 低于当前版本 %s，拒绝降级。\n' "${version}" "${current_version}" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  printf '工作树不干净，请先提交或 stash 后再准备发布：\n%s\n' "$(git status --porcelain)" >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/${tag_name}" >/dev/null 2>&1; then
  printf 'tag %s 已存在。\n' "${tag_name}" >&2
  exit 1
fi

branch="$(git rev-parse --abbrev-ref HEAD)"

# npm version 是唯一同时正确改写 package.json 与 package-lock.json 的路径。
npm version "${version}" --no-git-tag-version >/dev/null
# PI-Desktop 的 manifest 与 npm 版本共用同一个发布版本。
npm run sync:plugin-version -- "${version}" >/dev/null

git add -- package.json package-lock.json pi-desktop/manifest.json
if git diff --cached --quiet -- package.json package-lock.json pi-desktop/manifest.json; then
  printf 'npm version 未产生可提交的版本改动，已中止。\n' >&2
  exit 1
fi

# 提交信息经文件传递，避免中文在参数传递链上被按 ANSI 转码。
message_file="$(mktemp)"
trap 'rm -f -- "${message_file}"' EXIT
printf 'chore(release): 发布 %s\n' "${version}" >"${message_file}"
git commit -F "${message_file}"

git tag "${tag_name}"

# 分支名不是 main（如 release/x）时，推送命令里的分支要跟着改。
printf '已在 %s 上准备发布 %s：提交 + 本地 tag %s（未推送）。\n' "${branch}" "${version}" "${tag_name}"
printf '推送后 CI 会先跑双平台门禁，再自动发布到 npm（npm 侧配置见 docs/release.md）：\n'
printf '  git push origin %s\n' "${branch}"
printf '  git push origin %s\n' "${tag_name}"
