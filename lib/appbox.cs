// Obstat's Windows install walls: starts a program inside an AppContainer, the
// sandbox Windows runs Store apps in. Compiled on first use by lib/appbox.js with
// the C# compiler that comes with Windows (.NET Framework 4).
//
//   appbox run --name N [--rw DIR]... [--ro PATH]... [--shared-rw DIR]... [--shared-ro PATH]...
//              [--cwd DIR] -- PROGRAM ARGS...
//   appbox test
//
// Inside, the program (and everything it starts) can read and write only what it's
// given: --rw/--ro to this container alone (the app's own folder), --shared-rw and
// --shared-ro to every Obstat install (the package caches, Obstat's runtimes and
// program), through a capability only Obstat's containers hold. The rest of the user's
// files, other apps' folders, and Obstat's own (keys, sign-in) can't be read. It can
// reach the internet (the internetClient capability) but not this computer's localhost
// or the local network, which Windows blocks for AppContainers.
// Handles Obstat passed to this process (its IPC pipe, stderr) are passed on, and the
// program runs in a job that ends with this process, so stopping it ends everything.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

static class AppBox {
  const string CAPABILITY = "obstatInstalls";
  const int SE_GROUP_ENABLED = 4;
  const int EXTENDED_STARTUPINFO_PRESENT = 0x80000, CREATE_SUSPENDED = 4, CREATE_UNICODE_ENVIRONMENT = 0x400;
  const int PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x20009;
  const int JobObjectExtendedLimitInformation = 9, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
  const uint INFINITE = 0xFFFFFFFF;

  [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public int Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public int CapabilityCount; public int Reserved; }
  // pointers, not strings: these belong to Windows (GetStartupInfoW), and .NET would free them
  [StructLayout(LayoutKind.Sequential)]
  struct STARTUPINFO {
    public int cb; public IntPtr lpReserved; public IntPtr lpDesktop; public IntPtr lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public int LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public int ActiveProcessLimit;
    public UIntPtr Affinity; public int PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION Basic; public IO_COUNTERS Io;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }

  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int CreateAppContainerProfile(string name, string display, string desc, IntPtr caps, int count, out IntPtr sid);
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
  [DllImport("kernelbase.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool DeriveCapabilitySidsFromName(string name, out IntPtr groupSids, out int groupCount, out IntPtr capSids, out int capCount);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertStringSidToSid(string s, out IntPtr sid);
  [DllImport("kernel32.dll")] static extern void GetStartupInfoW(out STARTUPINFO si);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, int flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr retSize);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, int flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr a, IntPtr name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll")] static extern int ResumeThread(IntPtr t);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out int code);

  static int Main(string[] argv) {
    try {
      if (argv.Length > 0 && argv[0] == "test") return Test();
      if (argv.Length > 0 && argv[0] == "run") return Run(argv);
      Console.Error.WriteLine("usage: appbox run --name N ... -- PROGRAM ARGS | appbox test");
      return 2;
    } catch (Win32Exception e) {
      Console.Error.WriteLine("Obstat's Windows install walls: " + e.Message + " (Windows error " + e.NativeErrorCode + ": " + new Win32Exception(e.NativeErrorCode).Message + ")");
      return 125;
    } catch (Exception e) {
      Console.Error.WriteLine("Obstat's Windows install walls: " + e.Message);
      return 125;
    }
  }

  // a container that can start cmd.exe and gets its exit code back: the walls work here
  static int Test() {
    IntPtr sid = Container("obstat.walls.test");
    int code = Launch(sid, Capabilities(), Environment.SystemDirectory, new[] { Path.Combine(Environment.SystemDirectory, "cmd.exe"), "/d", "/c", "exit 7" });
    if (code != 7) { Console.Error.WriteLine("the test program ended with " + code + ", not 7"); return 1; }
    Console.Out.WriteLine("ok");
    return 0;
  }

  static int Run(string[] argv) {
    string name = null, cwd = null;
    var rw = new List<string>(); var ro = new List<string>(); var srw = new List<string>(); var sro = new List<string>();
    int i = 1;
    for (; i < argv.Length && argv[i] != "--"; i++) {
      string a = argv[i], v = i + 1 < argv.Length ? argv[i + 1] : null;
      if (v == null) throw new ArgumentException(a + " needs a value");
      if (a == "--name") name = v; else if (a == "--cwd") cwd = v;
      else if (a == "--rw") rw.Add(v); else if (a == "--ro") ro.Add(v);
      else if (a == "--shared-rw") srw.Add(v); else if (a == "--shared-ro") sro.Add(v);
      else throw new ArgumentException("unknown option " + a);
      i++;
    }
    if (name == null || i >= argv.Length - 1) throw new ArgumentException("needs --name and a program after --");
    var program = new string[argv.Length - i - 1];
    Array.Copy(argv, i + 1, program, 0, program.Length);

    IntPtr sid = Container(name);
    var own = new SecurityIdentifier(sid);
    var shared = new SecurityIdentifier(CapabilitySid());
    foreach (var p in rw) Grant(p, own, true);
    foreach (var p in ro) Grant(p, own, false);
    foreach (var p in srw) Grant(p, shared, true);
    foreach (var p in sro) Grant(p, shared, false);
    return Launch(sid, Capabilities(), cwd, program);
  }

  // this app's container (made the first time; its id is derived from the name)
  static IntPtr Container(string name) {
    IntPtr sid;
    int hr = CreateAppContainerProfile(name, name, "Obstat install walls", IntPtr.Zero, 0, out sid);
    if (hr == unchecked((int)0x800700B7)) hr = DeriveAppContainerSidFromAppContainerName(name, out sid);
    if (hr != 0) throw new Win32Exception(hr, "couldn't make the AppContainer (0x" + hr.ToString("X8") + ")");
    return sid;
  }

  static IntPtr CapabilitySid() {
    IntPtr groups, caps; int gc, cc;
    if (!DeriveCapabilitySidsFromName(CAPABILITY, out groups, out gc, out caps, out cc) || cc < 1) throw new Win32Exception(Marshal.GetLastWin32Error(), "couldn't derive Obstat's capability");
    return Marshal.ReadIntPtr(caps);
  }

  // internetClient (outbound internet only) and Obstat's own shared-folders capability
  static SID_AND_ATTRIBUTES[] Capabilities() {
    IntPtr internet;
    if (!ConvertStringSidToSid("S-1-15-3-1", out internet)) throw new Win32Exception(Marshal.GetLastWin32Error());
    return new[] {
      new SID_AND_ATTRIBUTES { Sid = internet, Attributes = SE_GROUP_ENABLED },
      new SID_AND_ATTRIBUTES { Sid = CapabilitySid(), Attributes = SE_GROUP_ENABLED },
    };
  }

  // Lets the container (or every Obstat container) at a folder and everything in it, or
  // a single file. Done once: an access rule that's already there is left as it is. A
  // folder or file this user can't change (Program Files) is skipped: there, read access
  // for every AppContainer is already Windows' default.
  static void Grant(string p, SecurityIdentifier sid, bool write) {
    var rights = write ? FileSystemRights.Modify | FileSystemRights.Synchronize : FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize;
    try {
      if (Directory.Exists(p)) {
        var d = new DirectoryInfo(p);
        var acl = d.GetAccessControl(AccessControlSections.Access);
        if (Has(acl.GetAccessRules(true, false, typeof(SecurityIdentifier)), sid, rights)) return;
        acl.AddAccessRule(new FileSystemAccessRule(sid, rights, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        d.SetAccessControl(acl);
      } else if (File.Exists(p)) {
        var f = new FileInfo(p);
        var acl = f.GetAccessControl(AccessControlSections.Access);
        if (Has(acl.GetAccessRules(true, false, typeof(SecurityIdentifier)), sid, rights)) return;
        acl.AddAccessRule(new FileSystemAccessRule(sid, rights, AccessControlType.Allow));
        f.SetAccessControl(acl);
      }
    } catch (UnauthorizedAccessException) {}
  }
  static bool Has(AuthorizationRuleCollection rules, SecurityIdentifier sid, FileSystemRights rights) {
    foreach (FileSystemAccessRule r in rules)
      if (r.AccessControlType == AccessControlType.Allow && sid.Equals(r.IdentityReference) && (r.FileSystemRights & rights) == rights) return true;
    return false;
  }

  static int Launch(IntPtr sid, SID_AND_ATTRIBUTES[] caps, string cwd, string[] program) {
    int sz = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
    IntPtr capArray = Marshal.AllocHGlobal(sz * caps.Length);
    for (int k = 0; k < caps.Length; k++) Marshal.StructureToPtr(caps[k], capArray + k * sz, false);
    var sc = new SECURITY_CAPABILITIES { AppContainerSid = sid, Capabilities = capArray, CapabilityCount = caps.Length };
    IntPtr scPtr = Marshal.AllocHGlobal(Marshal.SizeOf(sc));
    Marshal.StructureToPtr(sc, scPtr, false);

    IntPtr size = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
    IntPtr list = Marshal.AllocHGlobal(size);
    if (!InitializeProcThreadAttributeList(list, 1, 0, ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
    if (!UpdateProcThreadAttribute(list, 0, (IntPtr)PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, scPtr, (IntPtr)Marshal.SizeOf(sc), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());

    // the handles Obstat gave this process (stdio, and Node's IPC pipe in lpReserved2)
    // go to the program as they are
    STARTUPINFO own;
    GetStartupInfoW(out own);
    var si = new STARTUPINFOEX();
    si.StartupInfo = own;
    si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
    si.StartupInfo.lpReserved = IntPtr.Zero; si.StartupInfo.lpTitle = IntPtr.Zero;
    si.lpAttributeList = list;

    var cmd = new StringBuilder();
    foreach (var a in program) { if (cmd.Length > 0) cmd.Append(' '); cmd.Append(Quote(a)); }

    IntPtr job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
    var lim = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    lim.Basic.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (job == IntPtr.Zero || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref lim, Marshal.SizeOf(lim))) throw new Win32Exception(Marshal.GetLastWin32Error(), "couldn't make a job");

    PROCESS_INFORMATION pi;
    if (!CreateProcessW(null, cmd, IntPtr.Zero, IntPtr.Zero, true, EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, cwd, ref si, out pi))
      throw new Win32Exception(Marshal.GetLastWin32Error(), "couldn't start " + program[0] + " in the AppContainer");
    if (!AssignProcessToJobObject(job, pi.hProcess)) throw new Win32Exception(Marshal.GetLastWin32Error(), "couldn't put it in a job");
    ResumeThread(pi.hThread);
    WaitForSingleObject(pi.hProcess, INFINITE);
    int code;
    GetExitCodeProcess(pi.hProcess, out code);
    // Windows' own failures (a DLL it couldn't load, access denied) end a program
    // with an NTSTATUS and nothing printed: say which
    if ((uint)code >= 0xC0000000) Console.Error.WriteLine("Obstat's Windows install walls: " + program[0] + " ended with 0x" + ((uint)code).ToString("X8"));
    return code;
  }

  // one argument as CommandLineToArgvW reads it back
  static string Quote(string a) {
    if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return a;
    var sb = new StringBuilder("\"");
    for (int k = 0; k < a.Length; k++) {
      int bs = 0;
      while (k < a.Length && a[k] == '\\') { bs++; k++; }
      if (k == a.Length) { sb.Append('\\', bs * 2); break; }
      if (a[k] == '"') sb.Append('\\', bs * 2 + 1).Append('"');
      else sb.Append('\\', bs).Append(a[k]);
    }
    return sb.Append('"').ToString();
  }
}
