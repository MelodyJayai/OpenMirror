function Remove-StaleOpenMirrorFirewallRules {
  [CmdletBinding()]
  param()

  $removed = 0
  $rules = @(
    Get-NetFirewallRule -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -match '^OpenMirror Interop (TCP|UDP) ([1-9][0-9]*)$' }
  )

  foreach ($rule in $rules) {
    $match = [regex]::Match(
      $rule.DisplayName,
      '^OpenMirror Interop (TCP|UDP) ([1-9][0-9]*)$'
    )
    $ownerProcessId = 0
    if (
      -not $match.Success -or
      -not [int]::TryParse($match.Groups[2].Value, [ref]$ownerProcessId)
    ) {
      continue
    }

    # A running PowerShell host still owns this rule. If its process is gone,
    # a previous console was terminated before its finally block could run.
    if (Get-Process -Id $ownerProcessId -ErrorAction SilentlyContinue) {
      continue
    }

    try {
      $rule | Remove-NetFirewallRule -ErrorAction Stop
      $removed++
    } catch {
      Write-Warning "Could not remove stale firewall rule '$($rule.DisplayName)': $($_.Exception.Message)"
    }
  }

  return $removed
}
