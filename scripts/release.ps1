#Requires -Version 7.0
<#
.SYNOPSIS
    准备一次发布：改写 package.json / package-lock.json 的版本号，提交并打本地 tag（不推送）。
.DESCRIPTION
    版本号的单一真源是 package.json；package-lock.json 由 npm version 一并同步。
    脚本以「工作树干净」为前提，避免把无关改动裹进发布提交。
    失败时可能已改写版本文件（npm version 先执行），此时需 git restore 后重试。
.NOTES
    需要 pwsh 7+：脚本是 UTF-8 无 BOM，Windows PowerShell 5.1 会把中文字面量读成 ANSI。
.EXAMPLE
    pwsh -File scripts/release.ps1 0.2.0
#>
param(
    [Parameter(Position = 0)]
    [string]$Version,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ExtraArguments = @()
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# Windows 控制台与管道的默认输出编码是 OEM 码页（简体中文系统为 gb2312），
# 中文提示在 pwsh 里正常、被 bash 捕获时却乱码；统一成 UTF-8。
# 该赋值只影响本进程的输出显示，个别宿主不支持时不应中断发布。
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
}
catch {
    # 无控制台的宿主可能拒绝该赋值，忽略即可（仅影响提示文字的显示）。
}

# pwsh 7.4+ 可将原生命令的非零退出码升级为异常；本脚本自行检查退出码，故显式关闭该行为。
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}

$usage = "用法: pwsh -File scripts/release.ps1 <semver>   例: pwsh -File scripts/release.ps1 0.2.0"
$versionPattern = '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'
$versionFiles = @("package.json", "package-lock.json")

if ([string]::IsNullOrWhiteSpace($Version)) {
    throw $usage
}
if ($ExtraArguments.Count -gt 0) {
    throw $usage
}
if ($Version -notmatch $versionPattern) {
    throw "版本号不是合法 semver: $Version$([Environment]::NewLine)$usage"
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath $($Arguments -join ' ') 失败，退出码 $LASTEXITCODE"
    }
}

function Get-CheckedOutput {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )

    $output = & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath $($Arguments -join ' ') 失败，退出码 $LASTEXITCODE"
    }
    return $output
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Content
    )

    # 提交信息经文件传递，避免中文在参数传递链上被按 ANSI 转码。
    $encoding = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$tagName = "v$Version"

Push-Location $repoRoot
try {
    $currentVersion = (Get-Content -LiteralPath "package.json" -Raw | ConvertFrom-Json).version

    if ($Version -eq $currentVersion) {
        throw "package.json 版本已是 $currentVersion，未做修改。"
    }

    # 只比较核心数字段：预发布/构建元数据的变化不算降级。
    $currentCore = ($currentVersion -split '[-+]')[0]
    $newCore = ($Version -split '[-+]')[0]
    if ([version]$newCore -lt [version]$currentCore) {
        throw "新版本 $Version 低于当前版本 $currentVersion，拒绝降级。"
    }

    $statusLines = @(Get-CheckedOutput git @("status", "--porcelain"))
    if ($statusLines.Count -gt 0) {
        $details = ($statusLines | ForEach-Object { "  $_" }) -join [Environment]::NewLine
        throw "工作树不干净，请先提交或 stash 后再准备发布：$([Environment]::NewLine)$details"
    }

    $null = & git rev-parse -q --verify "refs/tags/$tagName" *> $null
    if ($LASTEXITCODE -eq 0) {
        throw "tag $tagName 已存在。"
    }

    $branch = Get-CheckedOutput git @("rev-parse", "--abbrev-ref", "HEAD")

    # npm version 是唯一同时正确改写 package.json 与 package-lock.json 的路径。
    Invoke-Checked npm @("version", $Version, "--no-git-tag-version") *> $null

    $gitAddArgs = @("add", "--") + $versionFiles
    Invoke-Checked git $gitAddArgs

    $gitDiffArgs = @("diff", "--cached", "--quiet", "--") + $versionFiles
    & git @gitDiffArgs
    if ($LASTEXITCODE -gt 1) {
        throw "git diff 失败，退出码 $LASTEXITCODE"
    }
    if ($LASTEXITCODE -eq 0) {
        throw "npm version 未产生可提交的版本改动，已中止。"
    }

    $messageFile = [System.IO.Path]::GetTempFileName()
    try {
        Write-Utf8NoBom -Path $messageFile -Content "chore(release): 发布 $Version$([Environment]::NewLine)"
        Invoke-Checked git @("commit", "-F", $messageFile)
    }
    finally {
        Remove-Item -LiteralPath $messageFile -Force -ErrorAction SilentlyContinue
    }

    Invoke-Checked git @("tag", $tagName)

    # 分支名不是 main（如 release/x）时，推送命令里的分支要跟着改。
    Write-Host "已在 $branch 上准备发布 $Version：提交 + 本地 tag $tagName（未推送）。"
    Write-Host "推送后 CI 会先跑双平台门禁，再自动发布到 npm（npm 侧配置见 docs/release.md）："
    Write-Host "  git push origin $branch"
    Write-Host "  git push origin $tagName"
}
finally {
    Pop-Location
}
