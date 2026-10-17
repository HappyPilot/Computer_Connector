import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const supervisor = path.join(root, 'scripts', 'rdc-supervisor.ps1');
const helper = path.join(root, 'scripts', 'wcm-supervisor-restart.ps1');

test('Supervisor restart handler parses and consumes only fixed signals', () => {
  fs.mkdirSync(path.join(root, '.state'), { recursive: true });
  const stateDir = fs.mkdtempSync(path.join(root, '.state', 'test-supervisor-'));
  try {
    const script = `
$ErrorActionPreference = 'Stop'
foreach ($file in @(${quote(supervisor)},${quote(helper)})) {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors) | Out-Null
    if (@($errors).Count -ne 0) { throw ('PowerShell parse error: ' + $file + ': ' + $errors[0].Message) }
}
$stateDir = ${quote(stateDir)}
function Log([string]$message) {}
. ${quote(helper)}
Write-WcmHeartbeat
$heartbeat = Get-Content -LiteralPath $wcmHeartbeat -Raw | ConvertFrom-Json
if ($heartbeat.supervisor_pid -ne $PID) { throw 'Heartbeat PID mismatch' }
Start-Sleep -Milliseconds 10
Write-WcmHeartbeat
$heartbeat2 = Get-Content -LiteralPath $wcmHeartbeat -Raw | ConvertFrom-Json
if ($heartbeat2.timestamp_ms -le $heartbeat.timestamp_ms) { throw 'Heartbeat failed to refresh' }
$id = [guid]::NewGuid().ToString()
Write-WcmState $wcmRestartRequest @{ version = 1; request_id = $id; created_at_ms = ([long]((Wcm-NowMs) - 4000)) }
if (-not (Read-WcmRestartSignal)) { throw 'Valid restart signal was not consumed' }
$last = Get-Content -LiteralPath $wcmRestartLast -Raw | ConvertFrom-Json
if ($last.request_id -ne $id) { throw 'Consumed ID not recorded' }
if (Test-Path -LiteralPath $wcmRestartRequest) { throw 'Consumed signal still present' }
if (Read-WcmRestartSignal) { throw 'Duplicate restart from consumed signal' }
Write-WcmState $wcmRestartRequest @{ version = 1; request_id = $id; created_at_ms = ([long]((Wcm-NowMs) - 130000)) }
if (Read-WcmRestartSignal) { throw 'Expired signal accepted' }
if (Test-Path -LiteralPath $wcmRestartRequest) { throw 'Expired signal not removed' }
Remove-WcmHeartbeat
if (Test-Path -LiteralPath $wcmHeartbeat) { throw 'Heartbeat not cleared' }
Write-Output 'Supervisor signal contract: PASS'
`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 20_000,
    });
    assert.equal(result.status, 0, `Supervisor helper test failed: ${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /Supervisor signal contract: PASS/u);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
