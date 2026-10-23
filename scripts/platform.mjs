import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

// EncodedCommand and a separate encoded JSON value avoid shell/path interpolation.
export function powershell(script, data = {}) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64');
  const source = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; try { $data=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json; ${script} } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
  try {
    return execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
      {encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024, stdio: 'pipe'}).replace(/^\uFEFF/, '').trim();
  } catch (error) {
    throw new Error('Windows adapter failed: ' + (error.stderr?.trim() || error.code || error.status));
  }
}

export function windowsProcesses() {
  const raw = powershell(`@((Get-CimInstance Win32_Process -Filter "Name='boss-zhipin.exe'") |
    Select-Object ProcessId,ExecutablePath,CommandLine) | ConvertTo-Json -Compress`);
  const rows = raw ? JSON.parse(raw) : [];
  return Array.isArray(rows) ? rows : [rows];
}

export function selectWindowsMain(rows, expectedPath) {
  const normalized = value => path.win32.normalize(value).toLowerCase();
  const matches = rows.filter(row => Number.isSafeInteger(row.ProcessId) && row.ProcessId > 0 &&
    typeof row.ExecutablePath === 'string' && typeof row.CommandLine === 'string' &&
    (!expectedPath || normalized(row.ExecutablePath) === normalized(expectedPath)) &&
    !/(?:^|\s)"?--type(?:=|\s|"|$)/i.test(row.CommandLine));
  if (matches.length !== 1) throw new Error('Expected one accessible Windows BOSS main process; no process was started');
  return matches[0];
}

export function defaultAppMain(platform = process.platform, env = process.env, rows) {
  if (env.BOSS_APP_MAIN) return env.BOSS_APP_MAIN;
  if (platform === 'darwin') return '/Applications/BOSS直聘.app/Contents/MacOS/BOSS直聘';
  if (platform !== 'win32') throw new Error('Unsupported platform; Windows and macOS have separate adapters');
  const running = rows ?? windowsProcesses();
  if (running.length) return selectWindowsMain(running).ExecutablePath;
  const candidates = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs')]
    .filter(Boolean).map(root => path.win32.join(root, 'boss-zhipin', 'boss-zhipin.exe')).filter(file => fs.existsSync(file));
  if (candidates.length > 1) throw new Error('Cannot uniquely locate BOSS; set BOSS_APP_MAIN to its installed executable');
  // This fallback lets help/offline tests run without an installed client. pid()
  // still requires a unique real process and takes its actual executable path.
  return candidates[0] || path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'boss-zhipin', 'boss-zhipin.exe');
}

export function archivePath(executable, platform = process.platform) {
  if (platform === 'win32') return path.win32.join(path.win32.dirname(executable), 'resources', 'app.asar');
  if (platform === 'darwin') return path.posix.resolve(path.posix.dirname(executable), '../Resources/app.asar');
  throw new Error('Unsupported archive layout');
}

export function sameOutputPath(left, right) {
  const canonical = file => {
    let existing = path.resolve(file);
    if (process.platform === 'win32' && existing.slice(path.parse(existing).root.length).split(/[\\/]/).some(part => /[. ]$|[<>:"|?*\x00-\x1f]/.test(part)))
      throw new Error('Ambiguous Windows output path; use ordinary file names without aliases or streams');
    const missing = [];
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error('Output path has no accessible filesystem ancestor');
      missing.unshift(path.basename(existing)); existing = parent;
    }
    const resolved = path.join(fs.realpathSync(existing), ...missing);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return canonical(left) === canonical(right);
}

export function activateInspector(bossPid, platform = process.platform) {
  if (platform === 'darwin') { process.kill(bossPid, 'SIGUSR1'); return; }
  if (platform !== 'win32') throw new Error('Unsupported Inspector activation platform');
  // Node's Windows adapter requests the target's registered debug handler. No signals,
  // patched binaries, arbitrary injected code, or client relaunch are used.
  execFileSync(process.execPath, ['-e', 'process._debugProcess(Number(process.argv[1]))', String(bossPid)],
    {windowsHide: true, timeout: 8000, stdio: 'pipe'});
}

export function verifyWindowsListener(port, bossPid) {
  const raw = powershell(`@(Get-NetTCPConnection -State Listen -LocalPort $data.port -ErrorAction SilentlyContinue |
    Select-Object LocalAddress,OwningProcess) | ConvertTo-Json -Compress`, {port});
  const parsed = raw ? JSON.parse(raw) : [], rows = Array.isArray(parsed) ? parsed : [parsed];
  if (rows.length !== 1 || rows[0].LocalAddress !== '127.0.0.1' || rows[0].OwningProcess !== bossPid)
    throw new Error('Inspector listener is not exclusively loopback-owned by the selected BOSS PID');
}

export function privateDirectory(directory) {
  const absolute = path.resolve(directory);
  if (process.platform !== 'win32') { fs.mkdirSync(absolute, {recursive: true, mode: 0o700}); return; }
  powershell(`
    $target=$data.path; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
    $allowed=@($sid.Value,'S-1-5-18');
    if (!(Test-Path -LiteralPath $target)) {
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null;
      $acl=New-Object Security.AccessControl.DirectorySecurity;
      $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false);
      foreach($id in $allowed) {
        $rule=New-Object Security.AccessControl.FileSystemAccessRule(
          (New-Object Security.Principal.SecurityIdentifier($id)), 'FullControl','ContainerInherit,ObjectInherit','None','Allow');
        $acl.AddAccessRule($rule);
      }
      [IO.Directory]::CreateDirectory($target,$acl) | Out-Null;
    }
    $item=Get-Item -LiteralPath $target -Force;
    if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Private output directory must be an ordinary directory' }
    $actual=[IO.Directory]::GetAccessControl($target);
    if (!$actual.AreAccessRulesProtected) { throw 'Existing output directory inherits permissions; use a new private subdirectory' }
    foreach($rule in $actual.Access) {
      $id=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;
      if($rule.AccessControlType -eq 'Allow' -and $id -notin $allowed) { throw 'Output directory grants access to another principal' }
    }
    if ($actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Private directory owner mismatch' }
  `, {path: absolute});
}
