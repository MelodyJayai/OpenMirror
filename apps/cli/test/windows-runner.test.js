import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('Windows runner removes only firewall rules whose owner PID is gone', {
  skip: process.platform !== 'win32',
}, () => {
  const helper = path.resolve('tools/windows-firewall-rules.ps1').replaceAll("'", "''");
  const script = `
$script:removed = @()
function Get-NetFirewallRule {
  [CmdletBinding()]
  param()
  @(
    [pscustomobject]@{ Name = 'active-tcp'; DisplayName = 'OpenMirror Interop TCP 111' }
    [pscustomobject]@{ Name = 'active-udp'; DisplayName = 'OpenMirror Interop UDP 111' }
    [pscustomobject]@{ Name = 'stale-tcp'; DisplayName = 'OpenMirror Interop TCP 222' }
    [pscustomobject]@{ Name = 'stale-udp'; DisplayName = 'OpenMirror Interop UDP 222' }
    [pscustomobject]@{ Name = 'unrelated'; DisplayName = 'OpenMirror Test TCP' }
  )
}
function Get-Process {
  [CmdletBinding()]
  param([int]$Id)
  if ($Id -eq 111) { [pscustomobject]@{ Id = 111 } }
}
function Remove-NetFirewallRule {
  [CmdletBinding()]
  param([Parameter(ValueFromPipeline = $true)]$InputObject)
  process { $script:removed += $InputObject.Name }
}
. '${helper}'
$count = Remove-StaleOpenMirrorFirewallRules
[ordered]@{ count = $count; removed = @($script:removed) } | ConvertTo-Json -Compress
`;
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = result.stdout.trim().split(/\r?\n/).at(-1);
  assert.deepEqual(JSON.parse(output), {
    count: 2,
    removed: ['stale-tcp', 'stale-udp'],
  });
});
