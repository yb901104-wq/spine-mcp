namespace SpineMcp.WinFormsObserver;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        var selfTest = args.Contains("--self-test");
        try
        {
            using var runtime = PortableRuntime.Start(args, selfTest);
            if (selfTest)
            {
                PortableRuntime.WriteTestResult(true, runtime?.PreviewUrl, null);
                return;
            }
            Application.Run(new MainForm(args));
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            Environment.ExitCode = 1;
            if (selfTest) PortableRuntime.WriteTestResult(false, null, ex.Message);
            else MessageBox.Show(ex.Message, "Spine MCP 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
