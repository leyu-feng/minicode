using System.Diagnostics;

var cli = Path.Combine(AppContext.BaseDirectory, "minicode", "cli.js");
if (!File.Exists(cli)) throw new FileNotFoundException("The contained Minicode CLI is missing.", cli);
var start = new ProcessStartInfo("node") { UseShellExecute = false };
start.ArgumentList.Add(cli);
foreach (var argument in args) start.ArgumentList.Add(argument);
using var process = Process.Start(start) ?? throw new InvalidOperationException("Could not start the Minicode CLI.");
await process.WaitForExitAsync();
return process.ExitCode;
