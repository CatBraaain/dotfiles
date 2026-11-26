import { dlopen, ptr } from "bun:ffi";
import { win32 } from "node:path";
import { encodePowerShell, windowsPowerShell } from "../platform";
import { isRecord } from "../session-model";

const DRIVE_FIXED = 3;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const INVALID_FILE_ATTRIBUTES = 0xffff_ffff;
const ACL_QUERY_TIMEOUT_MS = 10_000;
const FULL_CONTROL = 0x1f01ff;
const INHERIT_TO_FILES_AND_DIRECTORIES = 3;

const inspectPrivateDirectory = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$inputJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
$request = ConvertFrom-Json -InputObject $inputJson
$path = [IO.Path]::GetFullPath($request.path)
$parent = [IO.Path]::GetDirectoryName($path)
$drive = [IO.Path]::GetPathRoot($path)
if ($parent -notmatch '^[A-Za-z]:\\' -or [IO.DriveInfo]::new($drive).DriveType -ne [IO.DriveType]::Fixed) {
    throw 'Launch directory is not on a local drive'
}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$localSystem = 'S-1-5-18'
$administrators = 'S-1-5-32-544'
$trustedInstaller = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
$trustedOwners = @($sid.Value, $localSystem, $administrators, $trustedInstaller)
$genericWriteOrAll = 0x50000000
$deleteOrChangeSecurity = 0x000D0000
$deleteChildrenOrSetAttributes = 0x150
$ancestorMutationRights = $genericWriteOrAll -bor $deleteOrChangeSecurity -bor $deleteChildrenOrSetAttributes
function Assert-PlainDirectory($directory) {
    $attributes = [IO.File]::GetAttributes($directory)
    if (-not ($attributes -band [IO.FileAttributes]::Directory) -or
        ($attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Not a plain directory' }
}
function Read-Dacl($directory) {
    $acl = [IO.Directory]::GetAccessControl($directory, 'Access, Owner')
    $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
    if ($null -eq $descriptor.DiscretionaryAcl -or $null -eq $descriptor.Owner) { throw 'No directory ACL' }
    return $descriptor
}
for ($ancestor = $parent; $ancestor; $ancestor = [IO.Path]::GetDirectoryName($ancestor)) {
    Assert-PlainDirectory $ancestor
    $descriptor = Read-Dacl $ancestor
    if ($descriptor.Owner.Value -notin $trustedOwners -or
        ($ancestor -eq $parent -and $descriptor.Owner.Value -ne $sid.Value)) { throw 'Untrusted ancestor owner' }
    foreach ($ace in $descriptor.DiscretionaryAcl) {
        if ([int]$ace.AceFlags -band [int][Security.AccessControl.AceFlags]::InheritOnly) { continue }
        if ($ace -isnot [Security.AccessControl.QualifiedAce]) { throw 'Unknown ancestor ACL rule' }
        if ($ace.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed) { continue }
        $rights = $ace.AccessMask
        $canReplace = ($rights -band $ancestorMutationRights) -ne 0
        if ($canReplace -and $ace.SecurityIdentifier.Value -notin $trustedOwners) { throw 'Writable ancestor' }
    }
}
if (-not [IO.Directory]::Exists($path) -and $request.create) {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($sid)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    $null = [IO.Directory]::CreateDirectory($path, $acl)
}
Assert-PlainDirectory $path
$descriptor = Read-Dacl $path
$rules = @(foreach ($ace in $descriptor.DiscretionaryAcl) {
    if ($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback) { throw 'Unknown launch ACL rule' }
    @{ sid = $ace.SecurityIdentifier.Value; rights = $ace.AccessMask; flags = [int]$ace.AceFlags; allow = ($ace.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed) }
})
@{
    user = $sid.Value
    owner = $descriptor.Owner.Value
    protected = [bool]([int]$descriptor.ControlFlags -band [int][Security.AccessControl.ControlFlags]::DiscretionaryAclProtected)
    rules = $rules
} | ConvertTo-Json -Compress -Depth 4
`;

export function isPrivateWindowsLaunchAcl(acl: unknown): boolean {
  if (
    !isRecord(acl) ||
    typeof acl.user !== "string" ||
    !/^S-1-\d+(?:-\d+)+$/.test(acl.user) ||
    acl.owner !== acl.user ||
    acl.protected !== true ||
    !Array.isArray(acl.rules) ||
    acl.rules.length !== 1
  )
    return false;
  const [rule] = acl.rules;
  return (
    isRecord(rule) &&
    rule.sid === acl.user &&
    rule.allow === true &&
    rule.flags === INHERIT_TO_FILES_AND_DIRECTORIES &&
    rule.rights === FULL_CONTROL
  );
}

export function assertWindowsLaunchDirectory(path: string, create: boolean): void {
  if (!win32.isAbsolute(path)) throw new Error("Windows LocalAppData is not available");
  const input = Buffer.from(JSON.stringify({ path, create })).toString("base64");
  try {
    const result = Bun.spawnSync(
      [
        windowsPowerShell,
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encodePowerShell(inspectPrivateDirectory),
      ],
      {
        stdin: Buffer.from(input),
        stdout: "pipe",
        stderr: "ignore",
        timeout: ACL_QUERY_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    if (
      result.exitCode === 0 &&
      isPrivateWindowsLaunchAcl(JSON.parse(result.stdout.toString("utf8")))
    )
      return;
  } catch {
    throw new Error("Cannot verify a private Windows initial-request directory");
  }
  throw new Error("Cannot verify a private Windows initial-request directory");
}

export function hasPlainLocalWindowsDirectory(path: string): boolean {
  const normalized = win32.normalize(path);
  const { root } = win32.parse(normalized);
  if (!/^[a-z]:\\$/i.test(root) || path.includes("\0")) return false;

  const { GetDriveTypeW } = (windowsPathApis ??= loadWindowsPathApis()).symbols;
  const wideRoot = Buffer.from(`${root}\0`, "utf16le");
  if (GetDriveTypeW(ptr(wideRoot)) !== DRIVE_FIXED) return false;

  let directory = root;
  for (const component of normalized.slice(root.length).split("\\")) {
    directory = win32.join(directory, component);
    const attributes = windowsFileAttributes(directory);
    if (!isPlainWindowsPath(attributes) || (attributes & FILE_ATTRIBUTE_DIRECTORY) === 0)
      return false;
  }
  return true;
}

export function isPlainWindowsLaunchFile(path: string): boolean {
  return isPlainWindowsPath(windowsFileAttributes(path));
}

function isPlainWindowsPath(attributes: number): boolean {
  return (
    attributes !== INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_REPARSE_POINT) === 0
  );
}

let windowsPathApis: ReturnType<typeof loadWindowsPathApis> | undefined;

function loadWindowsPathApis() {
  return dlopen("kernel32.dll", {
    GetDriveTypeW: { args: ["ptr"], returns: "u32" },
    GetFileAttributesW: { args: ["ptr"], returns: "u32" },
  });
}

function windowsFileAttributes(path: string): number {
  const { GetFileAttributesW } = (windowsPathApis ??= loadWindowsPathApis()).symbols;
  const widePath = Buffer.from(`${path}\0`, "utf16le");
  return GetFileAttributesW(ptr(widePath));
}
