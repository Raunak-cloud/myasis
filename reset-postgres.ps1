# Resets the forgotten PostgreSQL password and creates the Myasis database.
#
#   Right-click PowerShell -> "Run as Administrator", then:
#   cd C:\path\to\myasis
#   .\reset-postgres.ps1
#
# It briefly switches local authentication to "trust" (the documented recovery
# route), sets a new password, then restores the original config — and restores
# it even if something fails partway, so the database is never left open.

param(
  [string]$PgRoot   = 'C:\Program Files\PostgreSQL\17',
  [string]$Service  = 'postgresql-x64-17',
  [string]$NewPostgresPassword = 'postgres',
  [string]$AppUser  = 'myasis',
  [string]$AppPass  = 'myasis_local_dev',
  [string]$AppDb    = 'myasis'
)

$ErrorActionPreference = 'Stop'

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
      ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "This must run in an elevated PowerShell (Run as Administrator)." -ForegroundColor Red
  exit 1
}

$hba    = Join-Path $PgRoot 'data\pg_hba.conf'
$psql   = Join-Path $PgRoot 'bin\psql.exe'
$backup = "$hba.myasis-backup"

foreach ($p in @($hba, $psql)) {
  if (-not (Test-Path $p)) { Write-Host "Not found: $p" -ForegroundColor Red; exit 1 }
}

function Restore-Hba {
  if (Test-Path $backup) {
    Copy-Item $backup $hba -Force
    Remove-Item $backup -Force
    Restart-Service $Service
    Write-Host "  pg_hba.conf restored and service restarted." -ForegroundColor Green
  }
}

try {
  Write-Host "`n1/5  Backing up pg_hba.conf"
  Copy-Item $hba $backup -Force

  Write-Host "2/5  Switching local auth to trust (temporary)"
  # Only the loopback lines are relaxed, and only for a few seconds.
  (Get-Content $hba) -replace '^(host\s+all\s+all\s+(127\.0\.0\.1/32|::1/128)\s+)\S+', '$1trust' |
    Set-Content $hba -Encoding ascii
  Restart-Service $Service
  Start-Sleep -Seconds 3

  Write-Host "3/5  Setting the postgres password and creating the app database"
  $sql = @"
ALTER USER postgres WITH PASSWORD '$NewPostgresPassword';
DROP DATABASE IF EXISTS $AppDb;
DROP ROLE IF EXISTS $AppUser;
CREATE ROLE $AppUser WITH LOGIN PASSWORD '$AppPass';
CREATE DATABASE $AppDb OWNER $AppUser;
"@
  $sql | & $psql -U postgres -h 127.0.0.1 -d postgres -v ON_ERROR_STOP=1
  if ($LASTEXITCODE -ne 0) { throw "psql failed with exit code $LASTEXITCODE" }

  Write-Host "4/5  Restoring the original authentication config"
  Restore-Hba

  Write-Host "5/5  Verifying the new credentials"
  $env:PGPASSWORD = $AppPass
  & $psql -U $AppUser -h 127.0.0.1 -d $AppDb -c "select current_user, current_database();"
  $env:PGPASSWORD = ''

  Write-Host "`n============================================================" -ForegroundColor Green
  Write-Host " Done. Connection string for Myasis:" -ForegroundColor Green
  Write-Host "   postgresql://$AppUser`:$AppPass@localhost:5432/$AppDb"
  Write-Host " postgres superuser password is now: $NewPostgresPassword"
  Write-Host "============================================================`n" -ForegroundColor Green
}
catch {
  Write-Host "`nFailed: $_" -ForegroundColor Red
  Write-Host "Restoring the original config so the database is not left open..." -ForegroundColor Yellow
  Restore-Hba
  exit 1
}
