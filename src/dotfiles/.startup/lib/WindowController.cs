using System;
using System.Runtime.InteropServices;
public class WindowController
{
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    // [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    public static void FocusWindow(IntPtr windowHandle)
    {
        uint outNull;
        uint currentThreadId = GetCurrentThreadId();
        uint foregroundThreadId = GetWindowThreadProcessId(GetForegroundWindow(), out outNull);
        if (currentThreadId != foregroundThreadId)
        {
            AttachThreadInput(currentThreadId, foregroundThreadId, true);
            // SetForegroundWindow(windowHandle);
            BringWindowToTop(windowHandle);
            AttachThreadInput(currentThreadId, foregroundThreadId, false);
        }
    }
}
public enum WindowShowStyle : uint
{
    Hide = 0,
    ShowNormal = 1,
    ShowMinimized = 2,
    ShowMaximized = 3,
    ShowNormalNoActivate = 4,
    Show = 5,
    Minimize = 6,
    ShowMinNoActivate = 7,
    ShowNoActivate = 8,
    Restore = 9,
    ShowDefault = 10,
    ForceMinimized = 11
}
