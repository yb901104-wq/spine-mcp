using System.Text.Json.Serialization;

namespace SpineMcp.WinFormsObserver;

public sealed class PreviewSessionResponse
{
    [JsonPropertyName("ok")]
    public bool Ok { get; set; }

    [JsonPropertyName("revision")]
    public int Revision { get; set; }

    [JsonPropertyName("updatedAt")]
    public string? UpdatedAt { get; set; }

    [JsonPropertyName("context")]
    public PreviewSessionContext Context { get; set; } = new();

    [JsonPropertyName("operation")]
    public PreviewSessionOperation Operation { get; set; } = new();

    [JsonPropertyName("logs")]
    public List<PreviewSessionLogEntry> Logs { get; set; } = [];

    [JsonPropertyName("previewUrl")]
    public PreviewUrlResponse PreviewUrl { get; set; } = new();

    [JsonPropertyName("sessionPath")]
    public string? SessionPath { get; set; }

    [JsonPropertyName("message")]
    public string? Message { get; set; }
}

public sealed class PreviewSessionContext
{
    [JsonPropertyName("filePath")]
    public string? FilePath { get; set; }

    [JsonPropertyName("atlasPath")]
    public string? AtlasPath { get; set; }

    [JsonPropertyName("animation")]
    public string? Animation { get; set; }

    [JsonPropertyName("skin")]
    public string? Skin { get; set; }

    [JsonPropertyName("speed")]
    public double Speed { get; set; }

    [JsonPropertyName("premultipliedAlpha")]
    public bool PremultipliedAlpha { get; set; }

    [JsonPropertyName("mipmaps")]
    public bool Mipmaps { get; set; }

    [JsonPropertyName("autoload")]
    public bool Autoload { get; set; }
}

public sealed class PreviewSessionOperation
{
    [JsonPropertyName("title")]
    public string? Title { get; set; }

    [JsonPropertyName("status")]
    public string? Status { get; set; }

    [JsonPropertyName("detail")]
    public string? Detail { get; set; }

    [JsonPropertyName("toolName")]
    public string? ToolName { get; set; }

    [JsonPropertyName("dryRun")]
    public bool? DryRun { get; set; }
}

public sealed class PreviewSessionLogEntry
{
    [JsonPropertyName("time")]
    public string? Time { get; set; }

    [JsonPropertyName("level")]
    public string? Level { get; set; }

    [JsonPropertyName("message")]
    public string? Message { get; set; }

    [JsonPropertyName("toolName")]
    public string? ToolName { get; set; }
}

public sealed class PreviewUrlResponse
{
    [JsonPropertyName("ok")]
    public bool Ok { get; set; }

    [JsonPropertyName("url")]
    public string? Url { get; set; }

    [JsonPropertyName("baseUrl")]
    public string? BaseUrl { get; set; }

    [JsonPropertyName("message")]
    public string? Message { get; set; }
}

public sealed class ValidationPipelineResponse
{
    [JsonPropertyName("ok")]
    public bool Ok { get; set; }

    [JsonPropertyName("filePath")]
    public string? FilePath { get; set; }

    [JsonPropertyName("atlasPath")]
    public string? AtlasPath { get; set; }

    [JsonPropertyName("animation")]
    public string? Animation { get; set; }

    [JsonPropertyName("version")]
    public string? Version { get; set; }

    [JsonPropertyName("hash")]
    public string? Hash { get; set; }

    [JsonPropertyName("checks")]
    public List<ValidationPipelineCheck> Checks { get; set; } = [];

    [JsonPropertyName("recommendedNextSteps")]
    public List<string> RecommendedNextSteps { get; set; } = [];

    [JsonPropertyName("message")]
    public string? Message { get; set; }
}

public sealed class ValidationPipelineCheck
{
    [JsonPropertyName("name")]
    public string? Name { get; set; }

    [JsonPropertyName("ok")]
    public bool Ok { get; set; }

    [JsonPropertyName("note")]
    public string? Note { get; set; }
}

public sealed class AgentConnectionResponse
{
    [JsonPropertyName("ok")]
    public bool Ok { get; set; }

    [JsonPropertyName("light")]
    public string? Light { get; set; }

    [JsonPropertyName("summary")]
    public string? Summary { get; set; }

    [JsonPropertyName("handshake")]
    public AgentHandshakeInfo Handshake { get; set; } = new();

    [JsonPropertyName("projectChecks")]
    public List<AgentProjectCheck> ProjectChecks { get; set; } = [];

    [JsonPropertyName("selected")]
    public AgentClientStatus? Selected { get; set; }

    [JsonPropertyName("message")]
    public string? Message { get; set; }
}

public sealed class AgentHandshakeInfo
{
    [JsonPropertyName("revision")]
    public int Revision { get; set; }

    [JsonPropertyName("updatedAt")]
    public string? UpdatedAt { get; set; }

    [JsonPropertyName("path")]
    public string? Path { get; set; }
}

public sealed class AgentProjectCheck
{
    [JsonPropertyName("name")]
    public string? Name { get; set; }

    [JsonPropertyName("exists")]
    public bool Exists { get; set; }

    [JsonPropertyName("note")]
    public string? Note { get; set; }
}

public sealed class AgentClientStatus
{
    [JsonPropertyName("clientType")]
    public string? ClientType { get; set; }

    [JsonPropertyName("displayName")]
    public string? DisplayName { get; set; }

    [JsonPropertyName("light")]
    public string? Light { get; set; }

    [JsonPropertyName("summary")]
    public string? Summary { get; set; }

    [JsonPropertyName("config")]
    public AgentClientConfig Config { get; set; } = new();
}

public sealed class AgentClientConfig
{
    [JsonPropertyName("displayName")]
    public string? DisplayName { get; set; }

    [JsonPropertyName("note")]
    public string? Note { get; set; }

    [JsonPropertyName("snippet")]
    public string? Snippet { get; set; }

    [JsonPropertyName("commandExample")]
    public string? CommandExample { get; set; }

    [JsonPropertyName("handshakeExample")]
    public string? HandshakeExample { get; set; }
}

public sealed class ObserverRuntimeState
{
    [JsonPropertyName("ok")]
    public bool Ok { get; set; }

    [JsonPropertyName("status")]
    public string? Status { get; set; }

    [JsonPropertyName("startedAt")]
    public string? StartedAt { get; set; }

    [JsonPropertyName("updatedAt")]
    public string? UpdatedAt { get; set; }

    [JsonPropertyName("workspaceRoot")]
    public string? WorkspaceRoot { get; set; }

    [JsonPropertyName("preview")]
    public ObserverPreviewRuntime Preview { get; set; } = new();

    [JsonPropertyName("winForms")]
    public ObserverWinFormsRuntime WinForms { get; set; } = new();

    [JsonPropertyName("stopCommand")]
    public string? StopCommand { get; set; }
}

public sealed class ObserverPreviewRuntime
{
    [JsonPropertyName("enabled")]
    public bool Enabled { get; set; }

    [JsonPropertyName("pid")]
    public int? Pid { get; set; }

    [JsonPropertyName("port")]
    public int Port { get; set; }

    [JsonPropertyName("url")]
    public string? Url { get; set; }

    [JsonPropertyName("stdoutLog")]
    public string? StdoutLog { get; set; }

    [JsonPropertyName("stderrLog")]
    public string? StderrLog { get; set; }
}

public sealed class ObserverWinFormsRuntime
{
    [JsonPropertyName("enabled")]
    public bool Enabled { get; set; }

    [JsonPropertyName("pid")]
    public int? Pid { get; set; }

    [JsonPropertyName("previewUrl")]
    public string? PreviewUrl { get; set; }
}
