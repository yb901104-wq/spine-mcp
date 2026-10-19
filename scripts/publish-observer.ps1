param([string]$OutputDirectory = "")
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$taskRepo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { $OutputDirectory = Join-Path $taskRepo ("releases\SpineMCP-win-x64-" + (Get-Date -Format "yyyyMMdd-HHmmss")) }
$taskOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
Push-Location $taskRepo
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "TypeScript 构建失败。" }
    dotnet publish apps/winforms-observer/SpineMcp.WinFormsObserver.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o $taskOutput
    if ($LASTEXITCODE -ne 0) { throw "WinForms 发布失败。" }
    $taskRuntime = Join-Path $taskOutput "runtime"
    New-Item -ItemType Directory -Path $taskRuntime -Force | Out-Null
    foreach ($taskName in @("dist", "preview")) { Copy-Item -LiteralPath (Join-Path $taskRepo $taskName) -Destination $taskRuntime -Recurse }
    foreach ($taskName in @("package.json", "package-lock.json")) { Copy-Item -LiteralPath (Join-Path $taskRepo $taskName) -Destination $taskRuntime }
    $taskNode = (& node -p "process.execPath").Trim()
    Copy-Item -LiteralPath $taskNode -Destination (Join-Path $taskRuntime "node.exe")
    Push-Location $taskRuntime
    try { npm ci --omit=dev --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw "运行依赖安装失败。" } } finally { Pop-Location }
    @"
Spine MCP 便携版（Windows x64）

1. 双击 SpineMcp.WinFormsObserver.exe。
2. 选择角色项目目录；Agent 也应打开该项目。
3. 在 Agent 连接区选择客户端并点击一键配置，再在客户端重新加载 MCP。

包含 .NET 和 Node 运行时；电脑仍需安装 Microsoft Edge WebView2 Runtime。
请保留 exe 与 runtime 整个目录。移动发布目录后请重新配置 Agent。
关闭窗口会关闭该窗口启动的预览服务，不关闭独立 Agent。
启动参数：--workspace "D:\项目目录"
日志：项目目录\.spine-mcp\portable-preview-端口.log
"@ | Set-Content -LiteralPath (Join-Path $taskOutput "使用说明.txt") -Encoding utf8
    Write-Host "发布完成：$taskOutput"
} finally { Pop-Location }
