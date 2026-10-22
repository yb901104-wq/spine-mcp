using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace SpineMcp.WinFormsObserver;

// 只读取观察发现文件；不读取 host-control.json，不取得写入权或启动/停止 Host。
internal sealed record HostConnection(Uri Endpoint, string InstanceId, string SessionId, string WorkspaceRoot);

internal static class HostDiscovery
{
    internal static Uri RequireLocalHttp(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme != "http" ||
            uri.Host != "127.0.0.1" || !string.IsNullOrEmpty(uri.UserInfo) ||
            !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment))
            throw new InvalidOperationException("只连接本机 127.0.0.1 HTTP 服务，不接受凭据、查询参数或远程地址。");
        return uri;
    }

    internal static string NormalizeRoot(string value)
    {
        if (!Path.IsPathFullyQualified(value)) throw new InvalidOperationException("工作区必须是绝对路径。");
        return Path.TrimEndingDirectorySeparator(Path.GetFullPath(value));
    }

    internal static async Task<HostConnection> ProbeAsync(string workspace, HttpClient http)
    {
        var root = NormalizeRoot(workspace);
        var directory = Path.Combine(root, ".spine-mcp");
        var file = Path.Combine(directory, "host-port.json");
        foreach (var candidate in new[] { directory, file })
            if ((File.GetAttributes(candidate) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException("Host 发现路径含链接，无法确认工作区边界。");
        if (new FileInfo(file).Length > 16384) throw new InvalidOperationException("Host 发现文件超出大小上限。");
        var bytes = await File.ReadAllBytesAsync(file);
        using var discovery = JsonDocument.Parse(bytes);
        var d = discovery.RootElement;
        var boundRoot = NormalizeRoot(d.GetProperty("workspaceRoot").GetString()!);
        if (!string.Equals(root, boundRoot, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Host 发现文件属于另一个工作区。");
        if (d.GetProperty("apiVersion").GetString() != "1") throw new InvalidOperationException("不兼容的 Host API 版本。");
        var port = d.GetProperty("port").GetInt32();
        if (port < 1 || port > 65535) throw new InvalidOperationException("Host 端口无效。");
        var token = d.GetProperty("token").GetString() ?? "";
        if (!Regex.IsMatch(token, "^[a-f0-9]{64}$")) throw new InvalidOperationException("Host 观察凭据格式无效。");
        using (var process = Process.GetProcessById(d.GetProperty("pid").GetInt32()))
            if (process.HasExited) throw new InvalidOperationException("Host 进程已退出。");
        var endpoint = RequireLocalHttp($"http://127.0.0.1:{port}/");
        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(endpoint, "api/state?includeCapabilities=false"));
        request.Headers.Add("X-Spine-Host-Token", token);
        using var response = await http.SendAsync(request);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException("Host 身份探测失败，请让 Agent 重新检查连接。");
        using var state = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var s = state.RootElement;
        foreach (var key in new[] { "apiVersion", "sessionId", "instanceId", "startedAt", "projectId" })
            if (s.GetProperty(key).GetRawText() != d.GetProperty(key).GetRawText())
                throw new InvalidOperationException("Host 实例或工程身份与发现文件不符。");
        var latest = await File.ReadAllBytesAsync(file);
        if (!bytes.AsSpan().SequenceEqual(latest))
            throw new InvalidOperationException("连接期间 Host 已切换，请重新连接。");
        return new HostConnection(endpoint, s.GetProperty("instanceId").GetString()!, s.GetProperty("sessionId").GetString()!, root);
    }
}
