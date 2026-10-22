using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace SpineMcp.WinFormsObserver;

internal sealed class HostObserverPanel : UserControl
{
    private readonly HttpClient http = new(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(3) };
    private readonly Label status = new() { AutoSize = true, MaximumSize = new Size(1000, 0), Text = "Host：等待连接。由 Agent 打开工程；此处只显示当前会话。" };
    private readonly Button reconnect = new() { AutoSize = true, Text = "连接 / 刷新 Host" };
    private readonly WebView2 browser = new() { Dock = DockStyle.Fill };
    private HostConnection? connection;
    private bool busy;
    [System.ComponentModel.DesignerSerializationVisibility(System.ComponentModel.DesignerSerializationVisibility.Hidden)]
    internal Func<string>? PreviewBaseUrl { get; set; }
    internal WebView2 Browser => browser;
    internal HostConnection? Connection => connection;
    internal string StatusText => status.Text;
    internal bool PageReady;
    internal string PageDiagnostic = "尚未导航";
    internal void SetPresentationVisible(bool visible)
    {
        browser.Visible = visible;
        if (!visible && browser.CoreWebView2 is not null) { PageReady = false; browser.CoreWebView2.Navigate("about:blank"); }
    }

    internal HostObserverPanel()
    {
        Dock = DockStyle.Fill;
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2 };
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        var header = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, Padding = new Padding(8), FlowDirection = FlowDirection.TopDown, WrapContents = false };
        header.Controls.Add(reconnect); header.Controls.Add(status);
        layout.Controls.Add(header, 0, 0); layout.Controls.Add(browser, 0, 1); Controls.Add(layout);
        reconnect.Click += async (_, _) => await RefreshFromPreviewAsync(true);
    }

    internal async Task RefreshFromPreviewAsync(bool force = false)
    {
        if (busy || IsDisposed) return;
        busy = true; reconnect.Enabled = false;
        try
        {
            var preview = HostDiscovery.RequireLocalHttp(PreviewBaseUrl?.Invoke() ?? "");
            using var response = await http.GetAsync(new Uri(preview, "api/config"));
            if (!response.IsSuccessStatusCode) throw new InvalidOperationException("无法读取当前预览服务的工作区。");
            using var config = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            await ConnectWorkspaceAsync(config.RootElement.GetProperty("workspaceRoot").GetString()!, force);
        }
        catch (Exception error) { Disconnect(error); }
        finally { busy = false; if (!IsDisposed) reconnect.Enabled = true; }
    }

    internal async Task ConnectWorkspaceAsync(string workspace, bool force = false, CoreWebView2Environment? environment = null)
    {
        try
        {
            var next = await HostDiscovery.ProbeAsync(workspace, http);
            if (IsDisposed) return;
            if (!force && connection == next && PageReady) return;
            if (browser.CoreWebView2 is null)
            {
                await browser.EnsureCoreWebView2Async(environment);
                var core = browser.CoreWebView2 ?? throw new InvalidOperationException("WebView2 初始化未完成。");
                core.Settings.AreHostObjectsAllowed = false;
                core.Settings.IsWebMessageEnabled = false;
                core.Settings.IsStatusBarEnabled = false;
                core.NewWindowRequested += (_, e) => e.Handled = true;
                core.NavigationCompleted += (_, e) => { PageReady = e.IsSuccess && browser.Source?.Scheme == "http"; PageDiagnostic = $"导航结果：{e.IsSuccess} / {e.WebErrorStatus}"; };
                core.ProcessFailed += (_, e) => { PageReady = false; PageDiagnostic = $"WebView2 进程失败：{e.ProcessFailedKind}"; status.Text = PageDiagnostic + "，请重新打开观察平台。"; };
                core.NavigationStarting += (_, e) =>
                {
                    if (e.Uri == "about:blank") return;
                    if (connection is null || !Uri.TryCreate(e.Uri, UriKind.Absolute, out var target) ||
                        target.GetLeftPart(UriPartial.Authority) != connection.Endpoint.GetLeftPart(UriPartial.Authority) ||
                        target.AbsolutePath != "/" || target.Query.Length > 0 || target.Fragment.Length > 0) e.Cancel = true;
                };
                core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
                core.WebResourceRequested += (_, e) =>
                {
                    if (Uri.TryCreate(e.Request.Uri, UriKind.Absolute, out var target) && target.Scheme is "http" or "https" &&
                        (connection is null || target.GetLeftPart(UriPartial.Authority) != connection.Endpoint.GetLeftPart(UriPartial.Authority)))
                        e.Response = core.Environment.CreateWebResourceResponse(null, 403, "Origin blocked", "Content-Type: text/plain");
                };
            }
            connection = next;
            PageReady = false;
            status.Text = $"Host：已连接 · {Path.GetFileName(next.WorkspaceRoot)} · 会话 {next.SessionId[..8]}。写入、资源和审查状态以工作台为准。";
            // Host 自己提供观察 token；URL 不携带凭据，也不注入 MCP control。
            browser.CoreWebView2.Navigate(next.Endpoint.AbsoluteUri);
        }
        catch (Exception error) { Disconnect(error); throw; }
    }

    private void Disconnect(Exception error)
    {
        connection = null;
        PageReady = false;
        if (IsDisposed) return;
        browser.CoreWebView2?.Navigate("about:blank");
        status.Text = error is FileNotFoundException or DirectoryNotFoundException
            ? "Host：尚未启动。请由 Agent 打开当前工作区的 Host；连接不会自动创建或接管写入者。"
            : $"Host：未连接。{error.Message}";
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) { http.Dispose(); browser.Dispose(); }
        base.Dispose(disposing);
    }
}
