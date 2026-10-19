using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace SpineMcp.WinFormsObserver;

public sealed class MainForm : Form
{
    private readonly HttpClient httpClient = new();
    private readonly JsonSerializerOptions jsonOptions = new(JsonSerializerDefaults.Web);
    private readonly System.Windows.Forms.Timer pollTimer = new();
    private readonly TextBox previewServerInput = new();
    private readonly Label connectionLabel = new();
    private readonly Label runtimeStatusLabel = new();
    private readonly TextBox runtimeBox = new();
    private readonly Button refreshRuntimeButton = new();
    private readonly Button copyStopCommandButton = new();
    private readonly Button openLogDirectoryButton = new();
    private readonly ComboBox agentTypeCombo = new();
    private readonly Label agentConnectionLabel = new();
    private readonly TextBox agentConfigBox = new();
    private readonly Button refreshAgentButton = new();
    private readonly Button copyAgentConfigButton = new();
    private readonly Button installAgentConfigButton = new();
    private readonly ComboBox agentConfigScopeCombo = new();
    private readonly Label contextLabel = new();
    private readonly Label operationLabel = new();
    private readonly Label validationLabel = new();
    private readonly TextBox logBox = new();
    private readonly TextBox urlBox = new();
    private readonly Button copyUrlButton = new();
    private readonly Button openExternalButton = new();
    private readonly Button refreshButton = new();
    private readonly WebView2 webView = new();
    private int? lastRevision;
    private string? lastPreviewUrl;
    private string? lastValidationKey;
    private string? lastStopCommand;
    private string? lastLogDirectory;

    public MainForm(string[]? args = null)
    {
        Text = "Spine MCP 观察平台";
        Width = 1280;
        Height = 820;
        MinimumSize = new Size(1040, 680);
        StartPosition = FormStartPosition.CenterScreen;

        BuildLayout(GetInitialPreviewServer(args ?? []));
        ConfigureTimer();
    }

    protected override async void OnShown(EventArgs e)
    {
        base.OnShown(e);
        await InitializeWebViewAsync();
        RefreshRuntimeState();
        await RefreshSessionAsync(forceNavigate: true);
        pollTimer.Start();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            pollTimer.Dispose();
            httpClient.Dispose();
            webView.Dispose();
        }
        base.Dispose(disposing);
    }

    private void BuildLayout(string previewServerUrl)
    {
        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            RowCount = 1,
        };
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 400));
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        Controls.Add(root);

        var side = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(12),
            ColumnCount = 1,
            RowCount = 17,
        };
        side.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        side.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        side.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        side.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        side.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        side.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        side.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        side.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        side.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        side.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        side.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        side.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        side.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        side.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        side.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        side.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        side.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.Controls.Add(side, 0, 0);

        var title = new Label
        {
            Text = "Agent 驱动观察",
            AutoSize = true,
            Font = new Font(Font.FontFamily, 15, FontStyle.Bold),
            Margin = new Padding(0, 0, 0, 10),
        };
        side.Controls.Add(title);

        side.Controls.Add(new Label { Text = "Preview server", AutoSize = true });
        previewServerInput.Text = previewServerUrl;
        previewServerInput.Dock = DockStyle.Top;
        side.Controls.Add(previewServerInput);

        refreshButton.Text = "刷新会话";
        refreshButton.Dock = DockStyle.Top;
        refreshButton.Margin = new Padding(0, 8, 0, 8);
        refreshButton.Click += async (_, _) => await RefreshSessionAsync(forceNavigate: true);
        side.Controls.Add(refreshButton);

        connectionLabel.Text = "连接：等待检测";
        connectionLabel.AutoSize = true;
        connectionLabel.MaximumSize = new Size(340, 0);
        side.Controls.Add(connectionLabel);

        side.Controls.Add(new Label
        {
            Text = "运行状态",
            AutoSize = true,
            Font = new Font(Font.FontFamily, 10, FontStyle.Bold),
            Margin = new Padding(0, 12, 0, 0),
        });

        var runtimeButtonRow = new FlowLayoutPanel
        {
            Dock = DockStyle.Top,
            FlowDirection = FlowDirection.LeftToRight,
            AutoSize = true,
            Margin = new Padding(0, 4, 0, 0),
        };
        refreshRuntimeButton.Text = "刷新";
        refreshRuntimeButton.AutoSize = true;
        refreshRuntimeButton.Click += (_, _) => RefreshRuntimeState();
        copyStopCommandButton.Text = "复制停止命令";
        copyStopCommandButton.AutoSize = true;
        copyStopCommandButton.Click += (_, _) =>
        {
            if (!string.IsNullOrWhiteSpace(lastStopCommand)) Clipboard.SetText(lastStopCommand);
        };
        openLogDirectoryButton.Text = "打开日志";
        openLogDirectoryButton.AutoSize = true;
        openLogDirectoryButton.Click += (_, _) => OpenDirectory(lastLogDirectory);
        runtimeButtonRow.Controls.Add(refreshRuntimeButton);
        runtimeButtonRow.Controls.Add(copyStopCommandButton);
        runtimeButtonRow.Controls.Add(openLogDirectoryButton);
        side.Controls.Add(runtimeButtonRow);

        runtimeStatusLabel.Text = "运行：等待检测";
        runtimeStatusLabel.AutoSize = true;
        runtimeStatusLabel.MaximumSize = new Size(360, 0);
        runtimeStatusLabel.Margin = new Padding(0, 4, 0, 0);
        side.Controls.Add(runtimeStatusLabel);

        runtimeBox.Dock = DockStyle.Top;
        runtimeBox.Height = 92;
        runtimeBox.Multiline = true;
        runtimeBox.ReadOnly = true;
        runtimeBox.ScrollBars = ScrollBars.Vertical;
        runtimeBox.Margin = new Padding(0, 6, 0, 0);
        side.Controls.Add(runtimeBox);

        side.Controls.Add(new Label
        {
            Text = "Agent 连接",
            AutoSize = true,
            Font = new Font(Font.FontFamily, 10, FontStyle.Bold),
            Margin = new Padding(0, 12, 0, 0),
        });

        var agentRow = new FlowLayoutPanel
        {
            Dock = DockStyle.Top,
            FlowDirection = FlowDirection.LeftToRight,
            AutoSize = true,
            Margin = new Padding(0, 4, 0, 0),
        };
        agentTypeCombo.DropDownStyle = ComboBoxStyle.DropDownList;
        agentTypeCombo.Width = 130;
        agentTypeCombo.Items.AddRange([
            new AgentChoice("Codex", "codex"),
            new AgentChoice("Claude Code", "claude-code"),
            new AgentChoice("opencode", "opencode"),
            new AgentChoice("自定义", "custom"),
        ]);
        agentTypeCombo.SelectedIndex = 0;
        agentTypeCombo.SelectedIndexChanged += async (_, _) => {
            if (agentConfigScopeCombo.Items.Count > 0) agentConfigScopeCombo.SelectedIndex = GetSelectedAgentClientType() == "codex" ? 1 : 0;
            await RefreshAgentConnectionAsync(NormalizeBaseUrl(previewServerInput.Text));
        };
        refreshAgentButton.Text = "检测";
        refreshAgentButton.AutoSize = true;
        refreshAgentButton.Click += async (_, _) => await RefreshAgentConnectionAsync(NormalizeBaseUrl(previewServerInput.Text));
        copyAgentConfigButton.Text = "复制配置";
        copyAgentConfigButton.AutoSize = true;
        copyAgentConfigButton.Click += (_, _) =>
        {
            if (!string.IsNullOrWhiteSpace(agentConfigBox.Text)) Clipboard.SetText(agentConfigBox.Text);
        };
        agentRow.Controls.Add(agentTypeCombo);
        agentRow.Controls.Add(refreshAgentButton);
        agentRow.Controls.Add(copyAgentConfigButton);
        side.Controls.Add(agentRow);
        var installRow = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Top };
        agentConfigScopeCombo.DropDownStyle = ComboBoxStyle.DropDownList;
        agentConfigScopeCombo.Items.AddRange(["当前项目", "用户级（Codex 桌面推荐）"]);
        agentConfigScopeCombo.SelectedIndex = 1;
        agentConfigScopeCombo.Width = 190;
        installAgentConfigButton.Text = "一键配置";
        installAgentConfigButton.AutoSize = true;
        installAgentConfigButton.Click += async (_, _) => await InstallAgentConfigAsync();
        installRow.Controls.Add(agentConfigScopeCombo);
        installRow.Controls.Add(installAgentConfigButton);
        side.Controls.Add(installRow);

        agentConnectionLabel.Text = "Agent：等待检测";
        agentConnectionLabel.AutoSize = true;
        agentConnectionLabel.MaximumSize = new Size(340, 0);
        agentConnectionLabel.Margin = new Padding(0, 4, 0, 0);
        side.Controls.Add(agentConnectionLabel);

        agentConfigBox.Dock = DockStyle.Top;
        agentConfigBox.Height = 120;
        agentConfigBox.Multiline = true;
        agentConfigBox.ReadOnly = true;
        agentConfigBox.ScrollBars = ScrollBars.Vertical;
        agentConfigBox.Margin = new Padding(0, 6, 0, 0);
        side.Controls.Add(agentConfigBox);

        contextLabel.Text = "上下文：等待 Agent 设置";
        contextLabel.AutoSize = true;
        contextLabel.MaximumSize = new Size(340, 0);
        contextLabel.Margin = new Padding(0, 10, 0, 0);
        side.Controls.Add(contextLabel);

        operationLabel.Text = "操作：等待 Agent 操作";
        operationLabel.AutoSize = true;
        operationLabel.MaximumSize = new Size(340, 0);
        operationLabel.Margin = new Padding(0, 10, 0, 0);
        side.Controls.Add(operationLabel);

        validationLabel.Text = "验证：等待会话";
        validationLabel.AutoSize = true;
        validationLabel.MaximumSize = new Size(340, 0);
        validationLabel.Margin = new Padding(0, 10, 0, 0);
        side.Controls.Add(validationLabel);

        logBox.Dock = DockStyle.Fill;
        logBox.Multiline = true;
        logBox.ReadOnly = true;
        logBox.ScrollBars = ScrollBars.Vertical;
        logBox.Margin = new Padding(0, 12, 0, 8);
        side.Controls.Add(logBox);

        urlBox.Dock = DockStyle.Top;
        urlBox.ReadOnly = true;
        side.Controls.Add(urlBox);

        var buttonRow = new FlowLayoutPanel
        {
            Dock = DockStyle.Top,
            FlowDirection = FlowDirection.LeftToRight,
            AutoSize = true,
            Margin = new Padding(0, 8, 0, 0),
        };
        copyUrlButton.Text = "复制 URL";
        copyUrlButton.AutoSize = true;
        copyUrlButton.Click += (_, _) =>
        {
            if (!string.IsNullOrWhiteSpace(urlBox.Text)) Clipboard.SetText(urlBox.Text);
        };
        openExternalButton.Text = "外部打开";
        openExternalButton.AutoSize = true;
        openExternalButton.Click += (_, _) => OpenExternal(lastPreviewUrl);
        buttonRow.Controls.Add(copyUrlButton);
        buttonRow.Controls.Add(openExternalButton);
        side.Controls.Add(buttonRow);

        webView.Dock = DockStyle.Fill;
        root.Controls.Add(webView, 1, 0);
    }

    private void ConfigureTimer()
    {
        pollTimer.Interval = 1200;
        pollTimer.Tick += async (_, _) => await RefreshSessionAsync(forceNavigate: false);
    }

    private async Task InitializeWebViewAsync()
    {
        try
        {
            await webView.EnsureCoreWebView2Async();
            webView.CoreWebView2.Settings.AreDevToolsEnabled = true;
            webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
        }
        catch (Exception ex)
        {
            connectionLabel.Text = $"WebView2 初始化失败：{ex.Message}";
        }
    }

    private async Task RefreshSessionAsync(bool forceNavigate)
    {
        PreviewSessionResponse? session = null;
        try
        {
            RefreshRuntimeState();
            var baseUrl = NormalizeBaseUrl(previewServerInput.Text);
            var response = await httpClient.GetAsync($"{baseUrl}api/session");
            response.EnsureSuccessStatusCode();
            var json = await response.Content.ReadAsStringAsync();
            session = JsonSerializer.Deserialize<PreviewSessionResponse>(json, jsonOptions);
            if (session is null || !session.Ok) throw new InvalidOperationException("会话返回为空或 ok=false。");

            connectionLabel.Text = session.Revision == 0 ? "预览服务：正常；尚无 Agent 制作记录。Agent 连接见下方状态灯。" : $"预览服务：正常，会话 revision={session.Revision}，updatedAt={session.UpdatedAt}";
            RenderSession(session);

            var shouldNavigate = forceNavigate || lastRevision != session.Revision || lastPreviewUrl != session.PreviewUrl.Url;
            lastRevision = session.Revision;
            lastPreviewUrl = session.PreviewUrl.Url;
            if (shouldNavigate && !string.IsNullOrWhiteSpace(session.Context.FilePath))
            {
                await RefreshValidationAsync(baseUrl, session);
            }
            if (shouldNavigate && !string.IsNullOrWhiteSpace(lastPreviewUrl) && webView.CoreWebView2 is not null)
            {
                webView.CoreWebView2.Navigate(lastPreviewUrl);
            }
            await RefreshAgentConnectionAsync(baseUrl);
        }
        catch (Exception ex)
        {
            connectionLabel.Text = $"连接：失败。{ex.Message}";
            agentConnectionLabel.Text = "Agent：灰灯，预览服务不可用，实时连接状态未知。";
            AppendLocalLog($"无法读取 /api/session：{ex.Message}");
        }
    }

    private void RenderSession(PreviewSessionResponse session)
    {
        var c = session.Context;
        contextLabel.Text = new StringBuilder()
            .AppendLine($"JSON：{c.FilePath}")
            .AppendLine($"Atlas：{c.AtlasPath}")
            .AppendLine($"动画：{c.Animation}")
            .AppendLine($"Skin：{(string.IsNullOrWhiteSpace(c.Skin) ? "默认" : c.Skin)}")
            .Append($"预览：speed={c.Speed}, PMA={c.PremultipliedAlpha}, Mipmaps={c.Mipmaps}")
            .ToString();

        var op = session.Operation;
        operationLabel.Text = new StringBuilder()
            .AppendLine($"操作：{op.Title ?? "等待 Agent 操作"}")
            .AppendLine($"状态：{op.Status ?? "idle"}")
            .AppendLine($"工具：{op.ToolName ?? "-"}")
            .AppendLine($"dryRun：{(op.DryRun.HasValue ? (op.DryRun.Value ? "是" : "否") : "-")}")
            .Append($"说明：{op.Detail ?? "-"}")
            .ToString();

        logBox.Text = string.Join(Environment.NewLine, session.Logs
            .TakeLast(80)
            .Select(entry => $"{entry.Time} {entry.Level} {FormatTool(entry.ToolName)}{entry.Message}"));

        urlBox.Text = session.PreviewUrl.Url ?? string.Empty;
    }

    private async Task RefreshValidationAsync(string baseUrl, PreviewSessionResponse session)
    {
        var key = $"{session.Context.FilePath}|{session.Context.AtlasPath}|{session.Context.Animation}|{session.Context.Skin}|{session.Revision}";
        if (lastValidationKey == key) return;
        lastValidationKey = key;
        validationLabel.Text = "验证：正在运行验证流水线...";

        try
        {
            var url = BuildValidationUrl(baseUrl, session.Context);
            var response = await httpClient.GetAsync(url);
            var json = await response.Content.ReadAsStringAsync();
            var validation = JsonSerializer.Deserialize<ValidationPipelineResponse>(json, jsonOptions)
                ?? throw new InvalidOperationException("验证流水线返回为空。");

            validationLabel.Text = FormatValidation(validation);
        }
        catch (Exception ex)
        {
            validationLabel.Text = $"验证：失败。{ex.Message}";
        }
    }

    private async Task RefreshAgentConnectionAsync(string baseUrl)
    {
        try
        {
            var clientType = GetSelectedAgentClientType();
            var response = await httpClient.GetAsync($"{baseUrl}api/agent-connection?clientType={Uri.EscapeDataString(clientType)}");
            response.EnsureSuccessStatusCode();
            var json = await response.Content.ReadAsStringAsync();
            var status = JsonSerializer.Deserialize<AgentConnectionResponse>(json, jsonOptions)
                ?? throw new InvalidOperationException("Agent 连接状态返回为空。");

            var selected = status.Selected;
            agentConnectionLabel.Text = new StringBuilder()
                .AppendLine($"状态：{FormatAgentLight(selected?.Light ?? status.Light)}")
                .AppendLine(selected?.Summary ?? status.Summary ?? "-")
                .AppendLine($"握手 revision：{status.Handshake.Revision}")
                .Append($"规则文件：{FormatProjectCheck(status, "AGENTS.md")}")
                .ToString();
            agentConfigBox.Text = BuildAgentConfigText(selected);
        }
        catch (Exception ex)
        {
            agentConnectionLabel.Text = $"Agent：检测失败。{ex.Message}";
        }
    }

    private async Task InstallAgentConfigAsync()
    {
        installAgentConfigButton.Enabled = false;
        try
        {
            var client = GetSelectedAgentClientType();
            var scope = agentConfigScopeCombo.SelectedIndex == 1 ? "user" : "project";
            if (client == "custom" || scope == "user" && client != "codex") throw new InvalidOperationException("请选择支持的客户端；用户级目前只支持 Codex。自定义客户端可复制配置。");
            var baseUrl = NormalizeBaseUrl(previewServerInput.Text);
            var uri = new Uri(baseUrl);
            if (!uri.IsLoopback || uri.Scheme != "http") throw new InvalidOperationException("一键配置只允许本机预览服务。");
            var previewResponse = await httpClient.GetAsync($"{baseUrl}api/agent-config?clientType={client}&scope={scope}");
            previewResponse.EnsureSuccessStatusCode();
            using var preview = JsonDocument.Parse(await previewResponse.Content.ReadAsStringAsync());
            var root = preview.RootElement;
            var target = root.GetProperty("targetPath").GetString();
            var note = root.GetProperty("note").GetString();
            if (MessageBox.Show(this, $"将配置写入：\n{target}\n\n{note}\n已有文件会备份，其他设置保留。\n是否继续？", "配置 Agent", MessageBoxButtons.OKCancel, MessageBoxIcon.Information) != DialogResult.OK) return;
            using var request = new HttpRequestMessage(HttpMethod.Post, $"{baseUrl}api/agent-config");
            request.Headers.Add("X-Spine-Config-Action", "install");
            request.Content = new StringContent(JsonSerializer.Serialize(new { clientType = client, scope, expectedHash = root.GetProperty("expectedHash").GetString() }), Encoding.UTF8, "application/json");
            var response = await httpClient.SendAsync(request);
            var content = await response.Content.ReadAsStringAsync();
            if (!response.IsSuccessStatusCode) throw new InvalidOperationException(content);
            using var result = JsonDocument.Parse(content);
            var backup = result.RootElement.TryGetProperty("backupPath", out var b) ? b.GetString() : null;
            var reload = client == "codex" ? "请完全退出并重新打开 Codex，再打开此项目检查 MCP 列表。项目级配置仍需项目受信任。" : "请在 Agent 中打开该项目并重新加载 MCP。";
            MessageBox.Show(this, $"配置已完成：\n{target}\n备份：{backup ?? "无（新配置或无需变更）"}\n\n{reload}\n连接灯在协议检测成功后变绿。", "配置已写入，等待客户端加载");
            await RefreshAgentConnectionAsync(baseUrl);
        }
        catch (Exception ex) { MessageBox.Show(this, ex.Message, "配置失败", MessageBoxButtons.OK, MessageBoxIcon.Error); }
        finally { installAgentConfigButton.Enabled = true; }
    }

    private void RefreshRuntimeState()
    {
        try
        {
            var runtimePath = GetObserverRuntimePath();
            if (!File.Exists(runtimePath))
            {
                lastStopCommand = "npm run observer:stop";
                lastLogDirectory = Path.Combine(GetWorkspaceRoot(), ".spine-mcp");
                runtimeStatusLabel.Text = "运行：未找到 observer-runtime.json";
                runtimeBox.Text = "尚未检测到一键启动脚本写入的运行态状态。\r\n使用 npm run observer 启动后会显示 preview/WinForms PID、端口和日志路径。";
                return;
            }

            var json = File.ReadAllText(runtimePath);
            var state = JsonSerializer.Deserialize<ObserverRuntimeState>(json, jsonOptions)
                ?? throw new InvalidOperationException("运行态状态文件为空。");
            lastStopCommand = string.IsNullOrWhiteSpace(state.StopCommand) ? "npm run observer:stop" : state.StopCommand;
            lastLogDirectory = GetRuntimeLogDirectory(state);

            runtimeStatusLabel.Text = new StringBuilder()
                .AppendLine($"运行：{state.Status ?? "-"}")
                .AppendLine($"Preview：{FormatPid(state.Preview.Pid)} {state.Preview.Url ?? "-"}")
                .Append($"WinForms：{FormatPid(state.WinForms.Pid)}")
                .ToString();
            runtimeBox.Text = new StringBuilder()
                .AppendLine($"状态文件：{runtimePath}")
                .AppendLine($"启动时间：{state.StartedAt ?? "-"}")
                .AppendLine($"更新时间：{state.UpdatedAt ?? "-"}")
                .AppendLine($"Preview 日志：{state.Preview.StdoutLog ?? "-"}")
                .AppendLine($"错误日志：{state.Preview.StderrLog ?? "-"}")
                .Append($"停止命令：{lastStopCommand}")
                .ToString();
        }
        catch (Exception ex)
        {
            runtimeStatusLabel.Text = $"运行：读取失败。{ex.Message}";
        }
    }

    private void AppendLocalLog(string message)
    {
        if (logBox.TextLength > 0) logBox.AppendText(Environment.NewLine);
        logBox.AppendText($"{DateTime.Now:HH:mm:ss} error {message}");
    }

    private static string NormalizeBaseUrl(string value)
    {
        var trimmed = string.IsNullOrWhiteSpace(value) ? "http://127.0.0.1:5177" : value.Trim();
        return trimmed.EndsWith('/') ? trimmed : $"{trimmed}/";
    }

    private static string GetWorkspaceRoot()
    {
        var configured = Environment.GetEnvironmentVariable("SPINE_MCP_WORKSPACE");
        if (!string.IsNullOrWhiteSpace(configured)) return Path.GetFullPath(configured);
        var candidates = new[]
        {
            Environment.CurrentDirectory,
            AppContext.BaseDirectory,
        };

        foreach (var candidate in candidates)
        {
            var current = new DirectoryInfo(candidate);
            while (current is not null)
            {
                if (File.Exists(Path.Combine(current.FullName, "package.json"))
                    && File.Exists(Path.Combine(current.FullName, "AGENTS.md")))
                {
                    return current.FullName;
                }
                current = current.Parent;
            }
        }

        return Environment.CurrentDirectory;
    }

    private static string GetObserverRuntimePath()
    {
        return Path.Combine(GetWorkspaceRoot(), ".spine-mcp", "observer-runtime.json");
    }

    private static string GetInitialPreviewServer(string[] args)
    {
        var cliValue = GetArgValue(args, "--preview-url") ?? GetArgValue(args, "--preview");
        var envValue = Environment.GetEnvironmentVariable("SPINE_PREVIEW_BASE_URL");
        return string.IsNullOrWhiteSpace(cliValue)
            ? string.IsNullOrWhiteSpace(envValue) ? "http://127.0.0.1:5177" : envValue
            : cliValue;
    }

    private static string? GetArgValue(string[] args, string name)
    {
        var index = Array.IndexOf(args, name);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }

    private static string FormatTool(string? toolName)
    {
        return string.IsNullOrWhiteSpace(toolName) ? string.Empty : $"[{toolName}] ";
    }

    private string GetSelectedAgentClientType()
    {
        return agentTypeCombo.SelectedItem is AgentChoice choice ? choice.Value : "codex";
    }

    private static string FormatAgentLight(string? light)
    {
        return light switch
        {
            "green" => "绿灯：MCP 在线（近期协议响应）",
            "yellow" => "黄灯：等待连接或响应",
            "red" => "红灯：离线或心跳过期",
            _ => "灰灯：未知",
        };
    }

    private static string FormatProjectCheck(AgentConnectionResponse status, string name)
    {
        var check = status.ProjectChecks.FirstOrDefault(item => item.Name == name);
        return check is null ? "-" : check.Exists ? "存在" : "缺失";
    }

    private static string BuildAgentConfigText(AgentClientStatus? selected)
    {
        if (selected is null) return "请选择 Agent 类型并刷新检测。";
        var builder = new StringBuilder()
            .AppendLine(selected.Config.Note ?? selected.Summary ?? string.Empty)
            .AppendLine();
        if (!string.IsNullOrWhiteSpace(selected.Config.CommandExample))
        {
            builder.AppendLine("命令示例：")
                .AppendLine(selected.Config.CommandExample)
                .AppendLine();
        }
        builder.AppendLine("配置片段：")
            .AppendLine(selected.Config.Snippet ?? "-")
            .AppendLine()
            .AppendLine("握手验证：")
            .Append(selected.Config.HandshakeExample ?? "连接成功后调用 spine_agent_ping。");
        return builder.ToString();
    }

    private static string BuildValidationUrl(string baseUrl, PreviewSessionContext context)
    {
        var builder = new UriBuilder(new Uri(new Uri(baseUrl), "api/validation-pipeline"));
        var query = new List<string>();
        AddQuery(query, "file", context.FilePath);
        AddQuery(query, "atlas", context.AtlasPath);
        AddQuery(query, "animation", context.Animation);
        AddQuery(query, "skin", context.Skin);
        AddQuery(query, "speed", context.Speed == 0 ? null : context.Speed.ToString(System.Globalization.CultureInfo.InvariantCulture));
        AddQuery(query, "pma", context.PremultipliedAlpha.ToString().ToLowerInvariant());
        AddQuery(query, "mipmaps", context.Mipmaps.ToString().ToLowerInvariant());
        AddQuery(query, "autoload", context.Autoload.ToString().ToLowerInvariant());
        builder.Query = string.Join("&", query);
        return builder.Uri.ToString();
    }

    private static void AddQuery(List<string> query, string name, string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return;
        query.Add($"{Uri.EscapeDataString(name)}={Uri.EscapeDataString(value)}");
    }

    private static string FormatValidation(ValidationPipelineResponse validation)
    {
        var builder = new StringBuilder()
            .AppendLine($"验证：{(validation.Ok ? "通过" : "未通过")}")
            .AppendLine($"版本：{validation.Version ?? "-"}")
            .AppendLine($"Hash：{ShortHash(validation.Hash)}");

        foreach (var check in validation.Checks)
        {
            builder.AppendLine($"{(check.Ok ? "通过" : "失败")} {check.Name}");
        }

        if (validation.RecommendedNextSteps.Count > 0)
        {
            builder.Append("建议：").Append(validation.RecommendedNextSteps[0]);
        }
        else
        {
            builder.Append(validation.Message ?? "-");
        }

        return builder.ToString();
    }

    private static string ShortHash(string? hash)
    {
        return string.IsNullOrWhiteSpace(hash) ? "-" : hash[..Math.Min(12, hash.Length)];
    }

    private static string FormatPid(int? pid)
    {
        return pid.HasValue ? $"PID={pid.Value}" : "PID=-";
    }

    private static string? GetRuntimeLogDirectory(ObserverRuntimeState state)
    {
        var logPath = state.Preview.StdoutLog ?? state.Preview.StderrLog;
        if (string.IsNullOrWhiteSpace(logPath)) return Path.Combine(GetWorkspaceRoot(), ".spine-mcp");
        return Path.GetDirectoryName(logPath);
    }

    private static void OpenExternal(string? url)
    {
        if (string.IsNullOrWhiteSpace(url)) return;
        Process.Start(new ProcessStartInfo
        {
            FileName = url,
            UseShellExecute = true,
        });
    }

    private static void OpenDirectory(string? directory)
    {
        if (string.IsNullOrWhiteSpace(directory)) return;
        if (!Directory.Exists(directory)) return;
        Process.Start(new ProcessStartInfo
        {
            FileName = directory,
            UseShellExecute = true,
        });
    }

    private sealed record AgentChoice(string Text, string Value)
    {
        public override string ToString() => Text;
    }
}
