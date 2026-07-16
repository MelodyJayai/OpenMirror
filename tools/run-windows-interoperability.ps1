#Requires -RunAsAdministrator

[CmdletBinding()]
param(
  [string]$Name = 'OpenMirror',
  [ValidateRange(1, 65535)]
  [int]$Port = 7000,
  [string]$AdvertiseAddress,
  [string]$Diagnostics
)

$ErrorActionPreference = 'Stop'

function Test-UsableLanAddress {
  param([string]$Address)

  if (-not $Address -or $Address -match '^(0\.|127\.|169\.254\.)') {
    return $false
  }
  $octets = $Address.Split('.')
  if ($octets.Count -ne 4) {
    return $false
  }
  if ([int]$octets[0] -eq 198 -and [int]$octets[1] -in 18, 19) {
    return $false
  }
  return $true
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$node = (Get-Command node -ErrorAction Stop).Source
$ffplay = (Get-Command ffplay -ErrorAction Stop).Source
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) {
  $npmCommand = Get-Command npm -ErrorAction Stop
}
$npm = $npmCommand.Source
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (-not $Diagnostics) {
  $Diagnostics = Join-Path $repoRoot ".openmirror-diagnostics\iphone-ipad-$stamp.jsonl"
}
$Diagnostics = [System.IO.Path]::GetFullPath($Diagnostics)
$stopFile = Join-Path ([System.IO.Path]::GetTempPath()) "openmirror-stop-$PID-$stamp.signal"
$ruleNames = @(
  "OpenMirror Interop TCP $PID",
  "OpenMirror Interop UDP $PID"
)

$networkConfigurations = @(
  Get-NetIPConfiguration |
    Where-Object { $_.NetAdapter.Status -eq 'Up' -and $_.IPv4Address }
)
$allAddresses = @(
  $networkConfigurations |
    ForEach-Object { $_.IPv4Address.IPAddress } |
    Where-Object { Test-UsableLanAddress $_ } |
    Sort-Object -Unique
)
$gatewayAddresses = @(
  $networkConfigurations |
    Where-Object { $_.IPv4DefaultGateway } |
    ForEach-Object { $_.IPv4Address.IPAddress } |
    Where-Object { Test-UsableLanAddress $_ } |
    Sort-Object -Unique
)

if ($AdvertiseAddress) {
  if ($AdvertiseAddress -notin $allAddresses) {
    throw "AdvertiseAddress is not assigned to an active local adapter: $AdvertiseAddress"
  }
} elseif ($gatewayAddresses.Count -eq 1) {
  $AdvertiseAddress = $gatewayAddresses[0]
} elseif ($gatewayAddresses.Count -eq 0) {
  throw 'No active LAN IPv4 address with a default gateway was found.'
} else {
  $addressList = $gatewayAddresses -join ', '
  throw "Multiple active LAN IPv4 addresses were found. Re-run with -AdvertiseAddress: $addressList"
}

$workspaceLink = Join-Path $repoRoot 'node_modules\@openmirror\core\package.json'
if (-not (Test-Path -LiteralPath $workspaceLink)) {
  Write-Host 'Installing zero-dependency npm workspace links...'
  Push-Location $repoRoot
  try {
    & $npm install
    if ($LASTEXITCODE -ne 0) {
      throw "npm install failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

$computerSystem = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
if (
  $computerSystem -and
  "$($computerSystem.Manufacturer) $($computerSystem.Model)" -match
  'OpenStack|VirtualBox|VMware|KVM|Hyper-V|Virtual Machine'
) {
  $virtualWarning = 'This appears to be a virtual machine. AirPlay mDNS requires the VM network ' +
    'to be bridged onto the same layer-2 LAN as the iPhone/iPad.'
  Write-Warning $virtualWarning
}

Write-Host 'OpenMirror physical-LAN interoperability run'
Write-Host "  node              : $node"
Write-Host "  ffplay            : $ffplay"
Write-Host "  advertise address : $AdvertiseAddress"
Write-Host "  diagnostics       : $Diagnostics"
Write-Host 'Temporary firewall rules are restricted to node.exe and LocalSubnet.'

$cliArgs = @(
  'apps/cli/src/main.js',
  '--port', [string]$Port,
  '--stats-interval', '2',
  '--advertise-address', $AdvertiseAddress
)

Write-Host ''
Write-Host 'Regression sequence:'
Write-Host '  1. Connect from Control Center > Screen Mirroring.'
Write-Host '  2. Play audible motion content for at least 60 seconds.'
Write-Host '  3. Rotate portrait/landscape twice.'
Write-Host '  4. Lock for at least 10 seconds, then unlock.'
Write-Host '  5. Stop mirroring, reconnect, and play again.'
Write-Host '  6. Keep the final media session active for at least 30 seconds.'
Write-Host '  7. Stop mirroring normally, then press Enter here to finish.'
Write-Host ''

$cliExitCode = 0
$cliProcess = $null
try {
  New-NetFirewallRule `
    -DisplayName $ruleNames[0] `
    -Description 'Temporary OpenMirror true-device interoperability rule.' `
    -Direction Inbound `
    -Action Allow `
    -Program $node `
    -Protocol TCP `
    -RemoteAddress LocalSubnet `
    -Profile Any | Out-Null
  New-NetFirewallRule `
    -DisplayName $ruleNames[1] `
    -Description 'Temporary OpenMirror true-device interoperability rule.' `
    -Direction Inbound `
    -Action Allow `
    -Program $node `
    -Protocol UDP `
    -RemoteAddress LocalSubnet `
    -Profile Any | Out-Null

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $node
  $startInfo.WorkingDirectory = $repoRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.Arguments = $cliArgs -join ' '
  $startInfo.EnvironmentVariables['OPENMIRROR_NAME'] = $Name
  $startInfo.EnvironmentVariables['OPENMIRROR_DIAGNOSTICS'] = $Diagnostics
  $startInfo.EnvironmentVariables['OPENMIRROR_STOP_FILE'] = $stopFile

  $cliProcess = New-Object System.Diagnostics.Process
  $cliProcess.StartInfo = $startInfo
  if (-not $cliProcess.Start()) {
    throw 'Failed to start the OpenMirror CLI process.'
  }

  $stdoutTask = $cliProcess.StandardOutput.ReadLineAsync()
  $stderrTask = $cliProcess.StandardError.ReadLineAsync()
  $stopRequested = $false
  Write-Host 'OpenMirror is running. Press Enter after completing the regression sequence.'
  while (-not $cliProcess.HasExited) {
    while ($stdoutTask -and $stdoutTask.IsCompleted) {
      $line = $stdoutTask.Result
      if ($null -eq $line) {
        $stdoutTask = $null
      } else {
        Write-Host $line
        $stdoutTask = $cliProcess.StandardOutput.ReadLineAsync()
      }
    }
    while ($stderrTask -and $stderrTask.IsCompleted) {
      $line = $stderrTask.Result
      if ($null -eq $line) {
        $stderrTask = $null
      } else {
        Write-Host $line -ForegroundColor DarkYellow
        $stderrTask = $cliProcess.StandardError.ReadLineAsync()
      }
    }
    if (-not $stopRequested -and [Console]::KeyAvailable) {
      $key = [Console]::ReadKey($true)
      if ($key.Key -eq [ConsoleKey]::Enter) {
        $stopRequested = $true
        [System.IO.File]::WriteAllText($stopFile, 'stop')
        Write-Host 'Graceful shutdown requested; waiting for final diagnostics...'
      }
    }
    Start-Sleep -Milliseconds 20
  }
  $cliProcess.WaitForExit()
  while ($stdoutTask -or $stderrTask) {
    if ($stdoutTask -and $stdoutTask.IsCompleted) {
      $line = $stdoutTask.Result
      if ($null -eq $line) {
        $stdoutTask = $null
      } else {
        Write-Host $line
        $stdoutTask = $cliProcess.StandardOutput.ReadLineAsync()
      }
    }
    if ($stderrTask -and $stderrTask.IsCompleted) {
      $line = $stderrTask.Result
      if ($null -eq $line) {
        $stderrTask = $null
      } else {
        Write-Host $line -ForegroundColor DarkYellow
        $stderrTask = $cliProcess.StandardError.ReadLineAsync()
      }
    }
    if ($stdoutTask -or $stderrTask) {
      Start-Sleep -Milliseconds 10
    }
  }
  $cliExitCode = $cliProcess.ExitCode
  if ($cliExitCode -ne 0) {
    Write-Warning "OpenMirror CLI exited with code $cliExitCode."
  }
} finally {
  if ($cliProcess -and -not $cliProcess.HasExited) {
    try {
      [System.IO.File]::WriteAllText($stopFile, 'stop')
      if (-not $cliProcess.WaitForExit(10000)) {
        $cliProcess.Kill()
        $cliProcess.WaitForExit()
      }
    } catch {
      Write-Warning "Could not gracefully stop OpenMirror: $($_.Exception.Message)"
      try {
        if (-not $cliProcess.HasExited) {
          $cliProcess.Kill()
          $cliProcess.WaitForExit()
        }
      } catch {
        Write-Warning "Could not terminate OpenMirror: $($_.Exception.Message)"
      }
    }
  }
  Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
  Get-NetFirewallRule -DisplayName $ruleNames -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue
  Write-Host 'Temporary OpenMirror firewall rules removed.'
}

if (-not (Test-Path -LiteralPath $Diagnostics)) {
  throw "Diagnostics file was not created: $Diagnostics"
}

& $node (Join-Path $repoRoot 'tools\analyze-interoperability.js') $Diagnostics --confirm
$analysisExitCode = $LASTEXITCODE
if ($analysisExitCode -ne 0) {
  exit $analysisExitCode
}
if ($cliExitCode -ne 0) {
  exit $cliExitCode
}
exit 0
