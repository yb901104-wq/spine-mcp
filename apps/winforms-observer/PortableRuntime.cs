using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace SpineMcp.WinFormsObserver;

internal sealed class PortableRuntime : IDisposable
{
    private readonly Process process;
    public string PreviewUrl { get; }
    private PortableRuntime(Process process, string url) { this.process = process; PreviewUrl = url; }

    public static PortableRuntime? Start(string[] args, bool selfTest)
    {
        var runtimeDir = Path.Combine(AppContext.BaseDirectory, "runtime");
        if (!Directory.Exists(runtimeDir))
        {
            if (selfTest) throw new InvalidOperationException("缺少便携 runtime 目录。");
            return null; // 开发版本继续使用外部预览服务。
        }
        var index = Array.IndexOf(args, "--workspace");
        var workspace = index >= 0 && index + 1 < args.Length ? args[index + 1] : Environment.GetEnvironmentVariable("SPINE_MCP_WORKSPACE");
        if (string.IsNullOrWhiteSpace(workspace))
        {
            if (selfTest) throw new InvalidOperationException("自检需指定 --workspace。");
            using var dialog = new FolderBrowserDialog { Description = "选择本次 Spine 项目目录（Agent 应打开同一目录）", UseDescriptionForTitle = true };
            if (dialog.ShowDialog() != DialogResult.OK) throw new OperationCanceledException();
            workspace = dialog.SelectedPath;
        }
        workspace = Path.GetFullPath(workspace);
        if (!Directory.Exists(workspace)) throw new DirectoryNotFoundException("项目目录不存在：" + workspace);
        var node = Path.Combine(runtimeDir, "node.exe");
        var server = Path.Combine(runtimeDir, "dist", "previewServer.js");
        if (!File.Exists(node) || !File.Exists(server)) throw new InvalidOperationException("便携运行文件不完整，请保留 exe 与 runtime 整个目录。");
        try { _ = CoreWebView2Environment.GetAvailableBrowserVersionString(); }
        catch { throw new InvalidOperationException("未安装 Microsoft Edge WebView2 Runtime。请安装后重新打开。https://developer.microsoft.com/microsoft-edge/webview2/"); }
        var port = FindPort();
        var url = $"http://127.0.0.1:{port}/";
        var logDir = Path.Combine(workspace, ".spine-mcp"); Directory.CreateDirectory(logDir);
        var logPath = Path.Combine(logDir, $"portable-preview-{port}.log");
        var logLock = new object();
        var info = new ProcessStartInfo(node) { WorkingDirectory = runtimeDir, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        info.ArgumentList.Add(server);
        info.Environment["SPINE_MCP_WORKSPACE"] = workspace;
        info.Environment["SPINE_PREVIEW_PORT"] = port.ToString();
        info.Environment["SPINE_PREVIEW_HOST"] = "127.0.0.1";
        var process = new Process { StartInfo = info };
        void Log(object sender, DataReceivedEventArgs e) { if (e.Data is not null) lock (logLock) { try { File.AppendAllText(logPath, e.Data + Environment.NewLine); } catch { } } }
        process.OutputDataReceived += Log; process.ErrorDataReceived += Log;
        try
        {
            process.Start(); process.BeginOutputReadLine(); process.BeginErrorReadLine();
            using var http = new HttpClient { Timeout = TimeSpan.FromMilliseconds(800) };
            var ready = false;
            for (var attempt = 0; attempt < 40; attempt++)
            {
                if (process.HasExited) throw new InvalidOperationException("预览服务退出，请查看日志：" + logPath);
                try { var config = http.GetStringAsync(url + "api/config").GetAwaiter().GetResult(); using var doc = JsonDocument.Parse(config); if (Path.GetFullPath(doc.RootElement.GetProperty("workspaceRoot").GetString()!) == workspace) { ready = true; break; } }
                catch { }
                Thread.Sleep(100);
            }
            if (!ready) throw new InvalidOperationException("预览服务启动超时，请查看日志：" + logPath);
            Environment.SetEnvironmentVariable("SPINE_MCP_WORKSPACE", workspace);
            Environment.SetEnvironmentVariable("SPINE_PREVIEW_BASE_URL", url);
            return new PortableRuntime(process, url);
        }
        catch { if (!process.HasExited) process.Kill(true); process.Dispose(); throw; }
    }
    private static int FindPort()
    {
        for (var port = 5177; port <= 5199; port++) { var listener = new TcpListener(IPAddress.Loopback, port); try { listener.Start(); return port; } catch (SocketException) { } finally { listener.Stop(); } }
        throw new InvalidOperationException("5177–5199 端口均不可用，请关闭其他预览服务。");
    }
    public static void WriteTestResult(bool ok, string? url, string? error) => File.WriteAllText(Path.Combine(AppContext.BaseDirectory, "self-test.json"), JsonSerializer.Serialize(new { ok, previewUrl = url, error, time = DateTimeOffset.UtcNow }, new JsonSerializerOptions { WriteIndented = true }));
    public void Dispose() { try { if (!process.HasExited) { process.Kill(true); process.WaitForExit(3000); } } finally { process.Dispose(); } }
}
