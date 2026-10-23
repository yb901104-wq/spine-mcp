using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace SpineMcp.WinFormsObserver;

// 仅显式 --host-self-test 启用：真实 WebView2 联调，报告和截图不具备 MCP 审查准入资格。
internal static class HostObserverSelfTest
{
    internal static void Run(string[] args)
    {
        string Argument(string key) { var i = Array.IndexOf(args, key); return i >= 0 && i + 1 < args.Length ? args[i + 1] : throw new ArgumentException($"自检缺少 {key}"); }
        var workspace = HostDiscovery.NormalizeRoot(Argument("--workspace"));
        var reportPath = Path.GetFullPath(Argument("--report"));
        var screenshotPath = Path.GetFullPath(Argument("--screenshot"));
        foreach (var output in new[] { reportPath, screenshotPath })
        {
            if (!output.StartsWith(workspace + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("自检输出必须位于指定工作区内。");
            for (var item = Path.GetDirectoryName(output); item is not null && item.Length > workspace.Length; item = Path.GetDirectoryName(item))
                if (Directory.Exists(item) && (File.GetAttributes(item) & FileAttributes.ReparsePoint) != 0) throw new ArgumentException("自检输出目录不能经过链接。");
        }
        Environment.SetEnvironmentVariable("WEBVIEW2_USER_DATA_FOLDER", Path.Combine(workspace, ".spine-mcp", "native-self-test-profile"));
        var checks = new List<string>();
        object? performance = null;
        using var form = new MainForm(args);
        async Task Wait(Func<Task<bool>> condition, string label, int seconds = 20)
        {
            var until = DateTime.UtcNow.AddSeconds(seconds);
            while (DateTime.UtcNow < until) { if (await condition()) return; await Task.Delay(50); }
            throw new InvalidOperationException($"等待失败：{label}；{form.HostPanel.StatusText}；{form.HostPanel.PageDiagnostic}");
        }
        void Check(bool value, string label) { if (!value) throw new InvalidOperationException(label); checks.Add(label); }
        async Task CaptureCheckpoint(string stage)
        {
            if (!args.Contains("--capture-checkpoints")) return;
            var marker = reportPath + "." + stage;
            await using (var file = new FileStream(marker + ".ready", FileMode.CreateNew))
                await file.WriteAsync(System.Text.Encoding.UTF8.GetBytes(stage));
            await Wait(async () => File.Exists(marker + ".release") && await File.ReadAllTextAsync(marker + ".release") == stage, $"MCP 截图检查点 {stage}", args.Contains("--benchmark-host") ? 120 : 20);
            checks.Add($"实际页面完成 MCP 截图检查点：{stage}");
        }
        form.Shown += async (_, _) =>
        {
            object report;
            try
            {
                var panel = form.HostPanel;
                form.SelectPreviewTab(1);
                await Wait(() => Task.FromResult(panel.Browser.CoreWebView2 is not null && panel.Connection is not null && panel.PageReady), "工作台连接");
                var core = panel.Browser.CoreWebView2!;
                async Task<bool> Js(string expression) => await core.ExecuteScriptAsync(expression) == "true";
                await Wait(() => Js("!!document.getElementById('frame')?.complete && document.getElementById('frame').naturalWidth===480"), "当前实际帧");
                Check(await Js("document.getElementById('status').textContent.includes('仅观察')"), "当前 Host 为观察模式");
                Check(await Js("!location.search && !location.hash"), "页面 URL 不含凭据");
                Check(!core.Settings.AreHostObjectsAllowed && !core.Settings.IsWebMessageEnabled, "未开放原生对象或 WebMessage 桥");
                if (args.Contains("--benchmark-host"))
                {
                    var samples = new List<double>();
                    for (var index = -2; index < 30; index++)
                    {
                        await core.ExecuteScriptAsync("window.__reloadBenchmarkOldDocument=true");
                        var timer = System.Diagnostics.Stopwatch.StartNew();
                        core.Reload();
                        var until = DateTime.UtcNow.AddSeconds(20);
                        while (!await Js("window.__reloadBenchmarkOldDocument===undefined && document.readyState==='complete' && document.getElementById('frame')?.complete && document.getElementById('frame').naturalWidth===480"))
                        {
                            if (DateTime.UtcNow >= until) throw new InvalidOperationException("性能采样等待新文档帧超时：" + await core.ExecuteScriptAsync("JSON.stringify({ready:document.readyState,width:document.getElementById('frame')?.naturalWidth,message:document.getElementById('message')?.textContent,oldDocument:window.__reloadBenchmarkOldDocument})"));
                            await Task.Delay(5);
                        }
                        // 等待新图跨过两个浏览器动画帧；不把仅收到 NavigationCompleted 当作可见帧。
                        await core.ExecuteScriptAsync("requestAnimationFrame(()=>requestAnimationFrame(()=>window.__reloadBenchmarkPaintReady=true))");
                        while (!await Js("window.__reloadBenchmarkPaintReady===true"))
                        {
                            if (DateTime.UtcNow >= until) throw new InvalidOperationException("性能采样等待浏览器呈现超时。");
                            await Task.Delay(5);
                        }
                        timer.Stop();
                        if (index >= 0) samples.Add(timer.Elapsed.TotalMilliseconds);
                        await Task.Delay(120);
                    }
                    var sorted = samples.Order().ToArray();
                    performance = new { scope = "实际 WebView2 热缓存 reload 到新文档 480 PNG 完整加载并跨两次 rAF；含原生轮询开销，不代表物理屏幕呈现时间。", warmups = 2, sampleCount = samples.Count,
                        interSampleDelayMs = 120, samples, p50 = sorted[(int)Math.Ceiling(sorted.Length * .5) - 1], p95 = sorted[(int)Math.Ceiling(sorted.Length * .95) - 1], maximum = sorted[^1], budgetMs = 800,
                        budgetPassed = sorted[(int)Math.Ceiling(sorted.Length * .95) - 1] < 800 };
                    checks.Add("完成 30 次实际页面重载性能采样（门限结果独立报告）");
                }
                await CaptureCheckpoint("initial");
                Check(await Js("!document.getElementById('message').textContent.includes('RATE_LIMITED')"), "初始页面与截图后没有 frame 限流错误");
                await core.ExecuteScriptAsync("window.__nativeSelfTestMarker='same-document'");
                form.SelectPreviewTab(0);
                await Wait(() => Js("location.href==='about:blank'"), "后台卸载页面");
                using var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false });
                using var discovery = JsonDocument.Parse(await File.ReadAllBytesAsync(Path.Combine(workspace, ".spine-mcp", "host-port.json")));
                var endpoint = new Uri($"http://127.0.0.1:{discovery.RootElement.GetProperty("port").GetInt32()}/");
                await Wait(async () =>
                {
                    using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(endpoint, "api/state?includeCapabilities=false"));
                    request.Headers.Add("X-Spine-Host-Token", discovery.RootElement.GetProperty("token").GetString());
                    using var response = await http.SendAsync(request);
                    using var state = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
                    return state.RootElement.GetProperty("preview").TryGetProperty("visibilityState", out var value) && value.GetString() == "hidden";
                }, "Host 收到卸载状态");
                checks.Add("切到旧预览后卸载 Host 页，服务实际收到 hidden");
                form.SelectPreviewTab(1);
                await Wait(() => Task.FromResult(panel.PageReady), "切回后重新加载");
                await Wait(() => Js("!!document.getElementById('frame')?.complete && document.getElementById('frame').naturalWidth===480"), "重新读取当前帧");
                Check(await Js("window.__nativeSelfTestMarker===undefined"), "切回后从当前 Host 重新加载页面");
                form.WindowState = FormWindowState.Minimized;
                await Wait(() => Js("location.href==='about:blank'"), "最小化后卸载");
                form.WindowState = FormWindowState.Normal;
                await Wait(() => Task.FromResult(panel.PageReady), "还原后重新连接");
                await Wait(() => Js("!!document.getElementById('frame')?.complete && document.getElementById('frame').naturalWidth===480"), "还原后当前帧");
                checks.Add("最小化卸载，还原后重新读取当前帧");
                await core.ExecuteScriptAsync("window.__nativeSelfTestMarker='same-document'");
                var blocked = new TaskCompletionSource<bool>();
                void BlockCheck(object? sender, CoreWebView2NavigationStartingEventArgs e) { if (e.Uri.StartsWith("https://example.invalid/")) blocked.TrySetResult(e.Cancel); }
                core.NavigationStarting += BlockCheck;
                core.Navigate("https://example.invalid/");
                Check(await blocked.Task.WaitAsync(TimeSpan.FromSeconds(5)), "跨来源导航在请求前阻止");
                core.NavigationStarting -= BlockCheck;
                await Task.Delay(100);
                Check(await Js("window.__nativeSelfTestMarker==='same-document'"), "阻止导航后保留原 Host 页面");
                await using (var image = new FileStream(screenshotPath, FileMode.CreateNew)) await core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, image);
                checks.Add("已保存实际 WebView2 诊断截图（非审查证据）");
                var originalProvider = panel.PreviewBaseUrl;
                panel.PreviewBaseUrl = () => "http://example.invalid/";
                await panel.RefreshFromPreviewAsync(true);
                Check(panel.Connection is null, "远程预览来源拒绝并断开旧 Host");
                await Wait(() => Js("location.href==='about:blank'"), "断开后清空旧画面");
                panel.PreviewBaseUrl = originalProvider;
                foreach (var directory in Directory.GetDirectories(Path.Combine(workspace, "negative-cases")))
                {
                    var rejected = false;
                    try { await panel.ConnectWorkspaceAsync(directory, true); } catch { rejected = true; }
                    Check(rejected && panel.Connection is null, $"发现负例拒绝：{Path.GetFileName(directory)}");
                }
                await panel.RefreshFromPreviewAsync(true);
                await Wait(() => Js("!!document.getElementById('frame')?.complete && document.getElementById('frame').naturalWidth===480"), "失败后重新连接");
                Check(panel.Connection is not null, "负例之后可以显式重连正确 Host");
                await CaptureCheckpoint("restored");
                Check(await Js("!document.getElementById('message').textContent.includes('RATE_LIMITED')"), "重连历史事件后没有 frame 限流错误");
                var environment = core.Environment;
                var browserPid = core.BrowserProcessId;
                var exited = new TaskCompletionSource<bool>();
                environment.BrowserProcessExited += (_, _) => exited.TrySetResult(true);
                form.ClosePreviewBrowsersForSelfTest();
                await exited.Task.WaitAsync(TimeSpan.FromSeconds(15));
                checks.Add("本次 WebView2 浏览器进程已退出");
                report = new { ok = true, checks, time = DateTimeOffset.UtcNow, screenshot = screenshotPath, browserPid, evidenceEligible = false, performance };
            }
            catch (Exception error) { Environment.ExitCode = 1; report = new { ok = false, checks, error = error.ToString(), time = DateTimeOffset.UtcNow }; }
            try { await using var file = new FileStream(reportPath, FileMode.CreateNew); await JsonSerializer.SerializeAsync(file, report, new JsonSerializerOptions { WriteIndented = true }); }
            finally { form.Close(); }
        };
        Application.Run(form);
    }
}
