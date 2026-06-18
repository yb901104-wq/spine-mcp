param(
  [string]$StatePath = "",
  [switch]$PreviewOnly,
  [switch]$WinFormsOnly,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$runtimeDir = Join-Path $repoRoot ".spine-mcp"
if ([string]::IsNullOrWhiteSpace($StatePath)) {
  $StatePath = Join-Path $runtimeDir "observer-runtime.json"
}

function Read-RuntimeState {
  if (-not (Test-Path $StatePath)) {
    throw "未找到运行态状态文件：$StatePath。请先使用 npm run observer 启动，或手动指定 -StatePath。"
  }

  return Get-Content -Encoding UTF8 $StatePath | ConvertFrom-Json
}

function Stop-RecordedProcess {
  param(
    [string]$Label,
    [object]$PidValue,
    [string[]]$AllowedNames
  )

  if ($null -eq $PidValue) {
    Write-Host "$Label：没有记录 PID，跳过。"
    return [ordered]@{
      label = $Label
      pid = $null
      action = "skipped"
      reason = "未记录 PID"
    }
  }

  $processId = [int]$PidValue
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    Write-Host "$Label：PID $processId 已不在运行。"
    return [ordered]@{
      label = $Label
      pid = $processId
      action = "not-running"
      reason = "进程不存在"
    }
  }

  if ($AllowedNames -notcontains $process.ProcessName) {
    Write-Host "$Label：PID $processId 当前进程名为 $($process.ProcessName)，不在允许列表内，跳过。" -ForegroundColor Yellow
    return [ordered]@{
      label = $Label
      pid = $processId
      processName = $process.ProcessName
      action = "skipped"
      reason = "进程名不匹配"
    }
  }

  if ($DryRun) {
    Write-Host "$Label：DryRun，将停止 PID $processId ($($process.ProcessName))。"
    return [ordered]@{
      label = $Label
      pid = $processId
      processName = $process.ProcessName
      action = "dry-run"
      reason = "DryRun 未停止"
    }
  }

  Stop-Process -Id $processId
  Write-Host "$Label：已停止 PID $processId ($($process.ProcessName))。"
  return [ordered]@{
    label = $Label
    pid = $processId
    processName = $process.ProcessName
    action = "stopped"
  }
}

function Write-StoppedState {
  param(
    [object]$State,
    [object[]]$Results
  )

  $State | Add-Member -Force -NotePropertyName status -NotePropertyValue "stopped"
  $State | Add-Member -Force -NotePropertyName updatedAt -NotePropertyValue ((Get-Date).ToUniversalTime().ToString("o"))
  $State | Add-Member -Force -NotePropertyName stoppedAt -NotePropertyValue ((Get-Date).ToUniversalTime().ToString("o"))
  $State | Add-Member -Force -NotePropertyName stopResults -NotePropertyValue $Results
  $State | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 $StatePath
}

Set-Location $repoRoot
$state = Read-RuntimeState

Write-Host "Spine MCP 观察平台停止向导" -ForegroundColor Green
Write-Host "状态文件：$StatePath"
Write-Host "工作区：$($state.workspaceRoot)"

$results = @()

if (-not $WinFormsOnly) {
  $results += Stop-RecordedProcess `
    -Label "Preview server" `
    -PidValue $state.preview.pid `
    -AllowedNames @("node")
}

if (-not $PreviewOnly) {
  $results += Stop-RecordedProcess `
    -Label "WinForms" `
    -PidValue $state.winForms.pid `
    -AllowedNames @("dotnet", "SpineMcp.WinFormsObserver")
}

if (-not $DryRun) {
  Write-StoppedState -State $state -Results $results
  Write-Host "运行态状态已更新为 stopped。"
}
else {
  Write-Host "DryRun：未停止进程，也未改写状态文件。"
}
