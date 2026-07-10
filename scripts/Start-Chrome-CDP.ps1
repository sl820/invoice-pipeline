<#
.SYNOPSIS
  启动带远程调试端口的 Chrome，供 Playwright/CDP 自动化接管。

.DESCRIPTION
  使用独立的 user-data-dir（不污染你日常的 Chrome），开 --remote-debugging-port=9222，
  首次手动登录公益平台后 cookie 落盘，后续可复用。

  复用方式（你日常用 Chrome 不受影响）：
    1. 跑本脚本
    2. 弹出的 Chrome 窗口里手动登录 https://open.alibabafoundation.com/index
    3. 关掉窗口时 cookie 已落盘到 -user-data-dir 指定目录
    4. 下次再跑本脚本，自动恢复登录态
    5. 跑 .\scripts\Invoke-Upload.ps1 上传发票

.PARAMETER Port
  CDP 远程调试端口，默认 9222

.PARAMETER ProfileDir
  Chrome user-data-dir，默认 C:\codex\chrome-gongyi（首次自动创建）

.PARAMETER FirstRun
  首次跑：检查 ProfileDir 是否为空，是则提示"请在新窗口登录"
#>
[CmdletBinding()]
param(
    [int]$Port = 9222,
    [string]$ProfileDir = "C:\codex\chrome-gongyi",
    [switch]$FirstRun
)

$ErrorActionPreference = "Stop"

# 找 Chrome
$chromePaths = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
)
$chrome = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) {
    throw "找不到 Chrome.exe，请先安装 Google Chrome"
}

# 检查端口占用
$portInUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($portInUse) {
    Write-Host "[cdp] 端口 $Port 已被占用（可能是已有 Chrome 启动着 CDP）"
    $existing = (Invoke-RestMethod "http://127.0.0.1:${Port}/json/version" -ErrorAction SilentlyContinue)
    if ($existing) {
        Write-Host "[cdp] Browser: $($existing.Browser)"
        Write-Host "[cdp] 可直接用，连 Invoke-Upload.ps1 即可"
        return
    }
}

# 准备 profile 目录
if (-not (Test-Path $ProfileDir)) {
    New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
    Write-Host "[cdp] 创建独立 profile: $ProfileDir"
}

# 首次运行提示
$isFirst = $FirstRun -or -not (Get-ChildItem $ProfileDir -Force | Where-Object { -not $_.PSIsContainer })
if ($isFirst) {
    Write-Host ""
    Write-Host "=========================================="
    Write-Host "  首次运行：在弹出窗口里登录公益平台"
    Write-Host "=========================================="
    Write-Host "  1. 弹窗会打开 Chrome（独立 profile，不影响你日常）"
    Write-Host "  2. 在地址栏打开 https://open.alibabafoundation.com/index"
    Write-Host "  3. 登录（扫码/账号密码均可）"
    Write-Host "  4. 看到自己的头像/用户名后，**关掉这个 Chrome 窗口**（cookie 已落盘）"
    Write-Host "  5. 下次再跑本脚本，会自动恢复登录态"
    Write-Host "=========================================="
    Write-Host ""
}

# 启动 Chrome
Write-Host "[cdp] 启动 Chrome (port=$Port profile=$ProfileDir)"
$args = @(
    "--remote-debugging-port=$Port"
    "--user-data-dir=$ProfileDir"
    "--no-first-run"
    "--no-default-browser-check"
    "about:blank"
)
$proc = Start-Process -FilePath $chrome -ArgumentList $args -PassThru
Write-Host "[cdp] PID: $($proc.Id)"
Write-Host "[cdp] 等待 Chrome 就绪 ..."

# 等待 CDP ready
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try {
        $ver = Invoke-RestMethod "http://127.0.0.1:${Port}/json/version" -ErrorAction Stop
        if ($ver) {
            $ready = $true
            Write-Host "[cdp] OK: $($ver.Browser)"
            break
        }
    } catch {}
}
if (-not $ready) {
    Write-Warning "[cdp] 30s 内未检测到 CDP，可能 Chrome 启动失败"
    exit 1
}

Write-Host ""
Write-Host "[cdp] CDP 已在 http://127.0.0.1:${Port} 就绪"
Write-Host "[cdp] 下一步：跑 .\scripts\Invoke-Upload.ps1 -SourceDir <path>"