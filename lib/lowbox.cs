// Obstat's install walls on Windows Home (and any Windows): starts a program at low
// integrity, the level browsers run their sandboxes at. Compiled on first use by
// lib/lowbox.js with the C# compiler that comes with Windows (.NET Framework 4).
//
//   lowbox run [--low DIR]... [--hide PATH]... [--cwd DIR] -- PROGRAM ARGS...
//   lowbox test
//
// Windows doesn't let a low-integrity program write anything that isn't labelled low
// itself: --low labels the folders the install may write (its own folder, its install
// home, the package caches), and everything else on this computer stays out of its
// reach for writing. --hide labels Obstat's own secrets (keys, sign-in, logs) "no
// read up", so it can't read those either. It can still read the rest of your files,
// and reach the network.
// Handles Obstat passed to this process (its IPC pipe, stderr) are passed on, and the
// program runs in a job that ends with this process, so stopping it ends everything.
using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

static class LowBox {
  const int TOKEN_DUPLICATE = 0x2, TOKEN_QUERY = 0x8, TOKEN_ADJUST_DEFAULT = 0x80, TOKEN_ASSIGN_PRIMARY = 0x1;
  const int TokenIntegrityLevel = 25, SE_GROUP_INTEGRITY = 0x20, SecurityImpersonation = 2, TokenPrimary = 1;
  const int CREATE_SUSPENDED = 4, CREATE_UNICODE_ENVIRONMENT = 0x400;
  const int JobObjectExtendedLimitInformation = 9, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
  const int SE_FILE_OBJECT = 1, LABEL_SECURITY_INFORMATION = 0x10;
  const uint INFINITE = 0xFFFFFFFF;

  [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public int Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct TOKEN_MANDATORY_LABEL { public SID_AND_ATTRIBUTES Label; }
  // pointers, not strings: these belong to Windows (GetStartupInfoW), and .NET would free them
  [StructLayout(LayoutKind.Sequential)]
  struct STARTUPINFO {
    public int cb; public IntPtr lpReserved; public IntPtr lpDesktop; public IntPtr lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
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

  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr proc, int access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr token, int access, IntPtr attrs, int level, int type, out IntPtr dup);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertStringSidToSid(string s, out IntPtr sid);
  [DllImport("advapi32.dll", SetLastError = true)] static extern int GetLengthSid(IntPtr sid);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int cls, ref TOKEN_MANDATORY_LABEL info, int len);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, int rev, out IntPtr sd, IntPtr size);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr sd, int rev, int info, out IntPtr sddl, IntPtr len);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetSecurityDescriptorSacl(IntPtr sd, out bool present, out IntPtr sacl, out bool defaulted);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern int SetNamedSecurityInfoW(string name, int type, int info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern int GetNamedSecurityInfoW(string name, int type, int info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl, out IntPtr sd);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  [DllImport("kernel32.dll")] static extern void GetStartupInfoW(out STARTUPINFO si);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessAsUserW(IntPtr token, string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, int flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
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
      Console.Error.WriteLine("usage: lowbox run [--low DIR]... [--hide PATH]... [--cwd DIR] -- PROGRAM ARGS | lowbox test");
      return 2;
    } catch (Win32Exception e) {
      Console.Error.WriteLine("Obstat's Windows install walls: " + e.Message + " (Windows error " + e.NativeErrorCode + ": " + new Win32Exception(e.NativeErrorCode).Message + ")");
      return 125;
    } catch (Exception e) {
      Console.Error.WriteLine("Obstat's Windows install walls: " + e.Message);
      return 125;
    }
  }

  // a low-integrity cmd.exe starts and its exit code comes back: the walls work here
  static int Test() {
    int code = Launch(Environment.SystemDirectory, new[] { Path.Combine(Environment.SystemDirectory, "cmd.exe"), "/d", "/c", "exit 7" });
    if (code != 7) { Console.Error.WriteLine("the test program ended with " + code + ", not 7"); return 1; }
    Console.Out.WriteLine("ok");
    return 0;
  }

  static int Run(string[] argv) {
    string cwd = null;
    var low = new List<string>(); var hide = new List<string>();
    int i = 1;
    for (; i < argv.Length && argv[i] != "--"; i++) {
      string a = argv[i], v = i + 1 < argv.Length ? argv[i + 1] : null;
      if (v == null) throw new ArgumentException(a + " needs a value");
      if (a == "--cwd") cwd = v; else if (a == "--low") low.Add(v); else if (a == "--hide") hide.Add(v);
      else throw new ArgumentException("unknown option " + a);
      i++;
    }
    if (i >= argv.Length - 1) throw new ArgumentException("needs a program after --");
    var program = new string[argv.Length - i - 1];
    Array.Copy(argv, i + 1, program, 0, program.Length);
    // secrets first, then the folders the install may write
    foreach (var p in hide) Label(p, Directory.Exists(p) ? "(ML;OICI;NWNR;;;ME)" : "(ML;;NWNR;;;ME)");
    foreach (var p in low) if (Directory.Exists(p)) Label(p, "(ML;OICI;NW;;;LW)");
    return Launch(cwd, program);
  }

  // Sets a folder's or file's integrity label (one label ACE, as SDDL), and for a folder
  // everything in it, unless it already has that label of its own. Done once: later files
  // inherit it. (Not "protected": that needs a privilege only administrators have.)
  static void Label(string p, string ace) {
    string sddl = "S:" + ace;
    if (!File.Exists(p) && !Directory.Exists(p)) return;
    IntPtr current;
    if (GetNamedSecurityInfoW(p, SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out current) == 0) {
      IntPtr str;
      if (ConvertSecurityDescriptorToStringSecurityDescriptorW(current, 1, LABEL_SECURITY_INFORMATION, out str, IntPtr.Zero)) {
        string have = Marshal.PtrToStringUni(str);
        LocalFree(str);
        if (have != null && have.Contains(ace)) { LocalFree(current); return; }
      }
      LocalFree(current);
    }
    IntPtr sd;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out sd, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error(), "bad label");
    bool present, defaulted; IntPtr sacl;
    if (!GetSecurityDescriptorSacl(sd, out present, out sacl, out defaulted)) throw new Win32Exception(Marshal.GetLastWin32Error());
    int err = SetNamedSecurityInfoW(p, SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl);
    LocalFree(sd);
    if (err != 0) throw new Win32Exception(err, "couldn't label " + p);
  }

  // this process's own token, at low integrity
  static IntPtr LowToken() {
    IntPtr token, dup, sid;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT | TOKEN_ASSIGN_PRIMARY, out token)) throw new Win32Exception(Marshal.GetLastWin32Error(), "couldn't read this program's token");
    if (!DuplicateTokenEx(token, TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT | TOKEN_ASSIGN_PRIMARY, IntPtr.Zero, SecurityImpersonation, TokenPrimary, out dup)) throw new Win32Exception(Marshal.GetLastWin32Error(), "couldn't copy the token");
    if (!ConvertStringSidToSid("S-1-16-4096", out sid)) throw new Win32Exception(Marshal.GetLastWin32Error());
    var tml = new TOKEN_MANDATORY_LABEL { Label = new SID_AND_ATTRIBUTES { Sid = sid, Attributes = SE_GROUP_INTEGRITY } };
    if (!SetTokenInformation(dup, TokenIntegrityLevel, ref tml, Marshal.SizeOf(tml) + GetLengthSid(sid))) throw new Win32Exception(Marshal.GetLastWin32Error(), "couldn't lower the token's integrity");
    return dup;
  }

  static int Launch(string cwd, string[] program) {
    // the handles Obstat gave this process (stdio, and Node's IPC pipe in lpReserved2)
    // go to the program as they are
    STARTUPINFO si;
    GetStartupInfoW(out si);
    si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    si.lpReserved = IntPtr.Zero; si.lpTitle = IntPtr.Zero;

    var cmd = new StringBuilder();
    foreach (var a in program) { if (cmd.Length > 0) cmd.Append(' '); cmd.Append(Quote(a)); }

    IntPtr job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
    var lim = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    lim.Basic.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (job == IntPtr.Zero || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref lim, Marshal.SizeOf(lim))) throw new Win32Exception(Marshal.GetLastWin32Error(), "couldn't make a job");

    PROCESS_INFORMATION pi;
    if (!CreateProcessAsUserW(LowToken(), null, cmd, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, cwd, ref si, out pi))
      throw new Win32Exception(Marshal.GetLastWin32Error(), "couldn't start " + program[0] + " at low integrity");
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
