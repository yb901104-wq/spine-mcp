param(
  [int]$Port = 0,
  [int]$StartPort = 5177,
  [int]$EndPort = 5199,
  [switch]$SkipBuild,
  [switch]$NoPreview,
  [switch]$NoWinForms,
  [switch]$StopExistingObserver,
  [switch]$CheckOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$runtimeDir = Join-Path $repoRoot ".spine-mcp"
$runtimeStatePath = Join-Path $runtimeDir "observer-runtime.json"
$previewServer = Join-Path $repoRoot "dist\previewServer.js"
$winFormsProject = Join-Path $repoRoot "apps\winforms-observer\SpineMcp.WinFormsObserver.csproj"
$startedAt = (Get-Date).ToUniversalTime().ToString("o")
$previewPid = $null
$winFormsPid = $null
$previewOutLog = $null
$previewErrLog = $null

function Test-LocalPortFree {
  param([int]$CandidatePort)

  $listener = $null
  try {
    $address = [System.Net.IPAddress]::Parse("127.0.0.1")
    $listener = [System.Net.Sockets.TcpListener]::new($address, $CandidatePort)
    $listener.Start()
    return $true
  }
  catch {
    return $false
  }
  finally {
    if ($null -ne $listener) {
      $listener.Stop()
    }
  }
}

function Get-PreviewPort {
  if ($Port -gt 0) {
    if (-not (Test-LocalPortFree $Port)) {
      throw "指定端口 $Port 已被占用。"
    }
    return $Port
  }

  for ($candidate = $StartPort; $candidate -le $EndPort; $candidate++) {
    if (Test-LocalPortFree $candidate) {
      return $candidate
    }
  }

  throw "没有找到可用端口。检查范围：$StartPort-$EndPort。"
}

function Invoke-Step {
  param(
    [string]$Title,
    [scriptblock]$Action
  )

  Write-Host ""
  Write-Host "== $Title ==" -ForegroundColor Cyan
  & $Action
}

function Write-ObserverRuntimeState {
  param(
    [string]$Status
  )

  $state = [ordered]@{
    ok = $true
    status = $Status
    startedAt = $startedAt
    updatedAt = (Get-Date).ToUniversalTime().ToString("o")
    workspaceRoot = [string]$repoRoot
    preview = [ordered]@{
      enabled = -not [bool]$NoPreview
      pid = $previewPid
      port = $selectedPort
      url = $previewUrl
      server = "dist/previewServer.js"
      stdoutLog = $previewOutLog
      stderrLog = $previewErrLog
    }
    winForms = [ordered]@{
      enabled = -not [bool]$NoWinForms
      pid = $winFormsPid
      project = "apps/winforms-observer/SpineMcp.WinFormsObserver.csproj"
      previewUrl = $previewUrl
    }
    options = [ordered]@{
      skipBuild = [bool]$SkipBuild
      noPreview = [bool]$NoPreview
      noWinForms = [bool]$NoWinForms
      stopExistingObserver = [bool]$StopExistingObserver
      startPort = $StartPort
      endPort = $EndPort
    }
    stopCommand = "powershell -ExecutionPolicy Bypass -File scripts/stop-observer.ps1"
  }

  $state | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 $runtimeStatePath
}

Set-Location $repoRoot
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

$selectedPort = Get-PreviewPort
$previewUrl = "http://127.0.0.1:$selectedPort"

Write-Host "Spine MCP 观察平台启动向导" -ForegroundColor Green
Write-Host "工作区：$repoRoot"
Write-Host "预览服务：$previewUrl"

if ($CheckOnly) {
  Write-Host "CheckOnly：只完成端口和路径检查，不启动进程。"
  exit 0
}

if (-not $SkipBuild) {
  Invoke-Step "构建 TypeScript MCP 与预览服务" {
    npm run build
  }

  Invoke-Step "构建 WinForms 观察平台" {
    dotnet build $winFormsProject --no-restore
  }
}

if ($StopExistingObserver) {
  Invoke-Step "关闭已有 WinForms 观察平台" {
    Get-Process SpineMcp.WinFormsObserver -ErrorAction SilentlyContinue | Stop-Process
  }
}

if (-not $NoPreview) {
  if (-not (Test-Path $previewServer)) {
    throw "未找到预览服务构建产物：$previewServer。请先运行 npm run build。"
  }

  $outLog = Join-Path $runtimeDir "preview-$selectedPort.out.log"
  $errLog = Join-Path $runtimeDir "preview-$selectedPort.err.log"
  $previewOutLog = $outLog
  $previewErrLog = $errLog
  $env:SPINE_MCP_WORKSPACE = [string]$repoRoot

  Invoke-Step "启动浏览器预览服务" {
    $previewProcess = Start-Process `
      -FilePath "node" `
      -ArgumentList @("dist/previewServer.js", "--port", "$selectedPort") `
      -WorkingDirectory $repoRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput $outLog `
      -RedirectStandardError $errLog `
      -PassThru
    $script:previewPid = $previewProcess.Id
    Write-Host "Preview PID：$($previewProcess.Id)"
    Write-Host "日志：$outLog"
  }
}

if (-not $NoWinForms) {
  Invoke-Step "启动 WinForms 观察平台" {
    $winFormsProcess = Start-Process `
      -FilePath "dotnet" `
      -ArgumentList @("run", "--no-build", "--project", "apps\winforms-observer\SpineMcp.WinFormsObserver.csproj", "--", "--preview-url", $previewUrl) `
      -WorkingDirectory $repoRoot `
      -PassThru
    $script:winFormsPid = $winFormsProcess.Id
    Write-Host "WinForms PID：$($winFormsProcess.Id)"
  }
}

Write-ObserverRuntimeState "started"

Write-Host ""
Write-Host "启动完成。" -ForegroundColor Green
Write-Host "WinForms 应连接：$previewUrl"
Write-Host "运行态状态：$runtimeStatePath"
Write-Host "停止命令：powershell -ExecutionPolicy Bypass -File scripts/stop-observer.ps1"
Write-Host "如果 Codex 已握手，Agent 连接区选择 Codex 应显示绿灯。"
