<#
    check-upload.ps1 - chan doan loi upload WinSCP cua batch OLSDB024

    Muc dich: tai hien DUNG lenh WinSCP ma spec OLSDB024 dang chay, nhung in ra
    day du exit code + stdout + stderr + log cua WinSCP. Spec hien tai chi log
    error.message nen ly do that bi mat.

    Script chi DOC danh muc tren server o cac buoc dau; buoc cuoi moi upload dung
    file ban dinh upload. Dung -SkipUpload neu chi muon kiem tra thu muc.

    Chay:
        .\check-upload.ps1
        .\check-upload.ps1 -SkipUpload
        .\check-upload.ps1 -SftpHost 192.168.99.89 -RemotePath /sftp/apps-SG-auto/ -File OLSTERM-20260916-01.dat
#>
param(
    [string]$SftpHost   = '192.168.99.83',
    [string]$User       = 'root',
    [string]$Password,
    [string]$RemotePath = '/apps/MY-dev/OE/cls/USER_INPUT/OLSDB024/',
    [string]$ParentDir  = '/apps/MY-dev/OE/cls/USER_INPUT/',
    [string]$LocalDir   = 'C:\BATCH-OCBC-PW1\src\',
    [string]$File       = 'OLSTERM-20260824-01.dat',
    [string]$WinSCP     = 'C:\Program Files (x86)\WinSCP\WinSCP.com',
    [int]$Timeout       = 20,
    [int]$KillAfterSec  = 90,
    [switch]$SkipUpload
)

$ErrorActionPreference = 'Continue'
$logPath = Join-Path $env:TEMP 'winscp-olsdb024-check.log'

function Mask([string]$text, [string]$secret) {
    if ([string]::IsNullOrEmpty($secret)) { return $text }
    return ($text -replace [regex]::Escape($secret), '***')
}

# ---------- 1. Mat khau ----------
if (-not $Password) {
    $envFile = 'F:\BATCH-OCBC-PW1\.env'
    if (Test-Path $envFile) {
        $line = Get-Content $envFile |
            Where-Object { $_ -match '^\s*SFTP_PASSWORD\s*=' } |
            Select-Object -First 1
        if ($line) {
            $Password = ($line -replace '^\s*SFTP_PASSWORD\s*=\s*', '' -replace '\s+#.*$', '').Trim()
        }
    }
}
if (-not $Password) {
    Write-Host 'KHONG DOC DUOC MAT KHAU tu .env - truyen bang: -Password <...>' -ForegroundColor Red
    exit 1
}

# ---------- 2. Cong cu & file nguon ----------
Write-Host '=== 1. Cong cu & file nguon ===' -ForegroundColor Cyan
if (Test-Path $WinSCP) {
    "WinSCP.com     : OK ($WinSCP)"
} else {
    "WinSCP.com     : THIEU ($WinSCP)"
    exit 1
}

$localFile = Join-Path $LocalDir $File
if (-not (Test-Path $localFile)) {
    "File nguon     : KHONG THAY $localFile"
    exit 1
}
$fi = Get-Item $localFile
"File nguon     : OK - $($fi.Length) bytes, sua lan cuoi $($fi.LastWriteTime)"

if ($File -match '^\w+-(\d{8})-') {
    $fileDate = $matches[1]
    $today    = Get-Date -Format 'yyyyMMdd'
    if ($fileDate -ne $today) {
        Write-Host "CANH BAO       : ten file mang ngay $fileDate, khong phai hom nay ($today)." -ForegroundColor Yellow
        Write-Host "                 Chay 'npm run generate:olsdb024' de sinh file ngay hom nay," -ForegroundColor Yellow
        Write-Host "                 neu khong buoc verify se fail vi spec tim output theo ngay hien tai." -ForegroundColor Yellow
    }
}

# ---------- 3. Dung lenh y nhu spec ----------
# Spec OLSDB024 tao ra:  put ""C:\...\file.dat"""
$putArg = 'put ""' + $localFile + '"""'

$parts = @(
    '"' + $WinSCP + '"'
    "/log=`"$logPath`""
    "/timeout=$Timeout"
    '/command'
    '"option batch abort"'
    '"option confirm off"'
    '"open sftp://' + $User + ':' + $Password + '@' + $SftpHost + '/"'
    '"cd ' + $ParentDir + '"'
    '"ls"'
    '"cd ' + $RemotePath + '"'
    '"ls"'
)
if (-not $SkipUpload) { $parts += $putArg }
$parts += '"exit"'
$cmdLine = $parts -join ' '

if (Test-Path $logPath) { Remove-Item $logPath -Force }

Write-Host "`n=== 2. Lenh WinSCP (da che mat khau) ===" -ForegroundColor Cyan
Mask $cmdLine $Password

# ---------- 4. Chay bang cmd.exe dung nhu child_process.exec cua Node ----------
Write-Host "`n=== 3. Ket qua ===" -ForegroundColor Cyan
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName               = 'cmd.exe'
# Node child_process.exec goi: cmd.exe /d /s /c "<toan bo lenh>"
# Phai bao quote y nhu vay, neu khong cmd se cat nham quote va bao
# "'C:\Program' is not recognized as an internal or external command".
$psi.Arguments              = '/d /s /c "' + $cmdLine + '"'
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError  = $true
$psi.UseShellExecute        = $false
$psi.CreateNoWindow         = $true

$proc   = [System.Diagnostics.Process]::Start($psi)
$stdout = $proc.StandardOutput.ReadToEnd()
$stderr = $proc.StandardError.ReadToEnd()

$finished = $proc.WaitForExit($KillAfterSec * 1000)
if (-not $finished) {
    Write-Host "WinSCP KHONG KET THUC sau $KillAfterSec giay -> dang bi treo. Dang kill..." -ForegroundColor Yellow
    try { $proc.Kill() } catch { }
    $proc.WaitForExit(5000) | Out-Null
    $code = 'KILLED (treo > ' + $KillAfterSec + 's)'
} else {
    $code = $proc.ExitCode
}

"EXIT CODE : $code  $(if ($code -eq 0) { '(THANH CONG)' } elseif ($code -is [string]) { '' } else { '(THAT BAI)' })"

if ($code -is [string]) {
    Write-Host 'Trieu chung nay thuong gap khi WinSCP dang cho nhap lieu (host key chua duoc chap nhan, hoac' -ForegroundColor Yellow
    Write-Host 'auth dang hoi lai mat khau) va khong co stdin. Spec OLSDB024 se bi execAsync kill o 60s va bao' -ForegroundColor Yellow
    Write-Host 'loi rong dung nhu ban dang thay.' -ForegroundColor Yellow
}

Write-Host "`n--- stdout ---"
Mask $stdout $Password | Write-Host
Write-Host "--- stderr ---"
Mask $stderr $Password | Write-Host

Write-Host "`n=== 4. Log WinSCP (40 dong cuoi) ===" -ForegroundColor Cyan
if (Test-Path $logPath) {
    (Get-Content $logPath -Tail 40) | ForEach-Object { Mask $_ $Password } | Write-Host
} else {
    'Khong tao duoc log.'
}

# ---------- 5. Goi y ----------
if ($code -ne 0) {
    Write-Host "`n=== 5. Goi y theo thong bao loi ===" -ForegroundColor Yellow
    $all = $stdout + $stderr + $(if (Test-Path $logPath) { Get-Content $logPath -Raw } else { '' })
    $hints = @(
        @{ P = 'No such file|not found|No such directory';            M = 'Duong dan khong ton tai (kiem tra hoa/thuong vi Linux phan biet)' }
        @{ P = 'Permission denied|Access denied';                     M = 'Khong co quyen ghi vao thu muc dich - kiem tra owner/quyen cua dir tren server (NFS root_squash cung gay loi nay)' }
        @{ P = 'Authentication failed|Auth fail';                     M = 'Sai user/mat khau tren host nay' }
        @{ P = 'Host key|hostkey|verification';                       M = 'Host key khac ban da cache - them /hostkey="SHA256:..."' }
        @{ P = 'timed out|timeout|Connection refused|Network error';  M = 'VPN/mang - thu lai khi VPN da ket noi' }
        @{ P = 'No space left';                                       M = 'Het dung luong tren server' }
        @{ P = 'already exists|Overwrite';                            M = 'File dich da ton tai' }
    )
    foreach ($h in $hints) {
        if ($all -match $h.P) { " -> $($h.M)" }
    }
}

Write-Host "`nXong. Gui lai cho toi phan '=== 3 ===' va '=== 4 ===' o tren." -ForegroundColor Green
