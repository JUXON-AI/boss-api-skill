# Read-only fallback when the local WMI provider is unavailable.
$processReaderSource = @'
using System; using System.Runtime.InteropServices;
public static class BossProcessRead {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint a, bool i, int p);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr p, int c, IntPtr b, int n, out int r);
  public static string CommandLine(int pid) {
    IntPtr handle=OpenProcess(0x1000,false,pid);
    if(handle==IntPtr.Zero) throw new Exception("Cannot open process for read-only query");
    IntPtr buffer=Marshal.AllocHGlobal(65536);
    try {
      int size; int status=NtQueryInformationProcess(handle,60,buffer,65536,out size);
      if(status!=0) throw new Exception("Process command-line query failed: "+status);
      int length=Marshal.ReadInt16(buffer)&0xffff;
      IntPtr text=Marshal.ReadIntPtr(buffer,IntPtr.Size==8?8:4);
      long offset=text.ToInt64()-buffer.ToInt64();
      if(offset<0 || offset+length>65536 || length%2!=0) throw new Exception("Invalid command-line buffer bounds");
      return Marshal.PtrToStringUni(text,length/2);
    } finally { Marshal.FreeHGlobal(buffer); CloseHandle(handle); }
  }
}
'@
Add-Type -TypeDefinition $processReaderSource
@(Get-Process -Name boss-zhipin -ErrorAction Stop | ForEach-Object {
  [PSCustomObject]@{ProcessId=$_.Id;ExecutablePath=$_.Path;CommandLine=[BossProcessRead]::CommandLine($_.Id)}
}) | ConvertTo-Json -Compress
