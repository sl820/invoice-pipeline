<#
.SYNOPSIS
  Step 5 入口：调用 upload/Upload-Gongyi.js 上传 SourceDir 下的所有 PDF。

.DESCRIPTION
  前置条件：
    1. 已跑 scripts/Start-Chrome-CDP.ps1 启动 Chrome 且登录了公益平台
    2. SourceDir 下 PDF 已是 {payer}.pdf 形式（先跑 Step 3 rename）

.PARAMETER SourceDir
  待上传目录

.PARAMETER DryRun
  只列出待上传文件，不真传

.PARAMETER Limit
  限制本次上传张数（用于测试）
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SourceDir,

    [switch]$DryRun,

    [int]$Limit = 0
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $PSCommandPath
$uploadScript = Join-Path $scriptDir "..\upload\Upload-Gongyi.js"

if (-not (Test-Path $uploadScript)) {
    throw "找不到 upload 脚本: $uploadScript"
}

if (-not (Test-Path $SourceDir)) {
    throw "SourceDir 不存在: $SourceDir"
}

# 检查 node
$nodeCheck = (& node --version 2>&1) | Out-String
if ($LASTEXITCODE -ne 0) {
    throw "node 不可用，请先安装 Node.js >= 20"
}

# 检查 CDP 端口
$cdpReady = $false
try {
    $null = Invoke-RestMethod "http://127.0.0.1:9222/json/version" -ErrorAction Stop
    $cdpReady = $true
} catch {
    Write-Host "[invoke-upload] CDP 端口 9222 未就绪" -ForegroundColor Yellow
    Write-Host "[invoke-upload] 提示：先跑 .\scripts\Start-Chrome-CDP.ps1" -ForegroundColor Yellow
    exit 1
}

Write-Host "[invoke-upload] CDP ready, 启动 Node 上传脚本"
Write-Host "[invoke-upload] source: $SourceDir"

# 组装参数
$nodeArgs = @($uploadScript, "--source-dir", $SourceDir)
if ($DryRun) { $nodeArgs += "--dry-run" }
if ($Limit -gt 0) { $nodeArgs += "--limit"; $nodeArgs += "$Limit" }

& node @nodeArgs
exit $LASTEXITCODE