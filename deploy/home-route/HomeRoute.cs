// Holds this computer's tunnel to the server open, and reopens it whenever it drops.
//
// A program rather than a script, for one reason: it has no console. A console
// program lives and dies with its console host, and on a desktop where
// developer tools come and go those hosts get closed — measured here, a
// PowerShell loop doing this job was ended with a Ctrl+C exit code within
// seconds, every time. This is a windowless program, and it starts ssh
// detached, so neither has a console for anything to close.
//
// Build (no SDK needed; the compiler ships with Windows):
//   %WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:winexe /out:home-route.exe HomeRoute.cs
// Run: home-route.exe [server] [port]      Log: %LOCALAPPDATA%\owtomate-home-route.log
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class HomeRoute
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb; public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcess(string app, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
        bool inheritHandles, uint flags, IntPtr environment, string directory, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    const uint DETACHED_PROCESS = 0x00000008;
    const uint INFINITE = 0xFFFFFFFF;

    static string log;

    static void Note(string text)
    {
        try
        {
            // Small on purpose: the last few hundred lines answer "was it up, and why did it drop".
            var file = new FileInfo(log);
            if (file.Exists && file.Length > 200 * 1024)
            {
                var lines = File.ReadAllLines(log);
                File.WriteAllLines(log, new ArraySegment<string>(lines, Math.Max(0, lines.Length - 300), Math.Min(300, lines.Length)));
            }
            File.AppendAllText(log, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + text + Environment.NewLine);
        }
        catch { /* a log that cannot be written must not take the tunnel down */ }
    }

    static int Main(string[] args)
    {
        var server = args.Length > 0 ? args[0] : "195.114.15.103";
        var port = args.Length > 1 ? args[1] : "1080";
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var key = Path.Combine(home, ".ssh", "owtomate_home_route");
        var ssh = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "OpenSSH", "ssh.exe");
        log = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "owtomate-home-route.log");

        // One tunnel per computer: a second copy would only fight the first for the port.
        bool first;
        using (new Mutex(true, "Local\\OwtomateHomeRoute-" + port, out first))
        {
            if (!first) return 0;
            Note("started (pid " + System.Diagnostics.Process.GetCurrentProcess().Id + ")");

            // -R with a port and no destination makes this end the SOCKS exit. The keep-alives
            // notice a dead link within a minute and a half, so the loop can redial.
            var command = "\"" + ssh + "\" -N -T -i \"" + key + "\""
                + " -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
                + " -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3"
                + " -E \"" + log + ".ssh\""
                + " -R 127.0.0.1:" + port + " homeroute@" + server;

            while (true)
            {
                var startup = new STARTUPINFO();
                startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                PROCESS_INFORMATION process;
                if (!CreateProcess(null, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, false, DETACHED_PROCESS, IntPtr.Zero, home, ref startup, out process))
                {
                    Note("could not start ssh: " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
                }
                else
                {
                    Note("tunnel up (ssh pid " + process.dwProcessId + ")");
                    WaitForSingleObject(process.hProcess, INFINITE);
                    uint code;
                    GetExitCodeProcess(process.hProcess, out code);
                    CloseHandle(process.hThread);
                    CloseHandle(process.hProcess);
                    Note("ssh exited (" + code + "); redialling in 10s");
                }
                Thread.Sleep(10000);
            }
        }
    }
}
