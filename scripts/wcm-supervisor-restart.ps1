# Sourced by rdc-supervisor.ps1. Only a fixed, validated state-file signal is accepted.
$wcmRestartRequest = Join-Path $stateDir 'wcm-restart-request.json'
$wcmRestartLast = Join-Path $stateDir 'wcm-restart-last.json'
$wcmHeartbeat = Join-Path $stateDir 'wcm-supervisor-heartbeat.json'

function Wcm-NowMs { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

function Write-WcmState([string]$file, $value) {
    $temporary = "$file.$PID.tmp"
    $serialized = ConvertTo-Json -InputObject $value -Compress
    [System.IO.File]::WriteAllText($temporary, $serialized, (New-Object System.Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $file) {
        [System.IO.File]::Replace($temporary, $file, $null)
    } else {
        [System.IO.File]::Move($temporary, $file)
    }
}

function Write-WcmHeartbeat {
    Write-WcmState $wcmHeartbeat @{ supervisor_pid = $PID; timestamp_ms = (Wcm-NowMs) }
}

function Remove-WcmHeartbeat {
    Remove-Item -LiteralPath $wcmHeartbeat -Force -ErrorAction SilentlyContinue
}

function Read-WcmRestartSignal {
    if (-not (Test-Path -LiteralPath $wcmRestartRequest)) { return $false }
    try {
        $request = Get-Content -LiteralPath $wcmRestartRequest -Raw | ConvertFrom-Json
        $parsedId = [guid]::Empty
        $isValid = $request.version -eq 1 -and
            $request.request_id -is [string] -and
            [guid]::TryParse([string]$request.request_id, [ref]$parsedId) -and
            $request.created_at_ms -is [long]
        if (-not $isValid) { throw 'Invalid WCM restart signal format.' }
        $previous = $null
        if (Test-Path -LiteralPath $wcmRestartLast) {
            $previous = Get-Content -LiteralPath $wcmRestartLast -Raw | ConvertFrom-Json
        }
        if ($previous -and $previous.request_id -eq $request.request_id) {
            Log ('duplicate supervised restart id=' + $request.request_id)
            Remove-Item -LiteralPath $wcmRestartRequest -Force -ErrorAction Stop
            return $false
        }
        $timestamp = Wcm-NowMs
        $age = $timestamp - [long]$request.created_at_ms
        if ($age -lt -2000 -or $age -gt 120000) {
            Log ('discarding expired WCM restart signal id=' + $request.request_id)
            Remove-Item -LiteralPath $wcmRestartRequest -Force -ErrorAction Stop
            return $false
        }
        if ($age -lt 3000) { return $false }
        Write-WcmState $wcmRestartLast @{
            version = 1
            request_id = [string]$request.request_id
            processed_at_ms = $timestamp
        }
        Remove-Item -LiteralPath $wcmRestartRequest -Force -ErrorAction Stop
        Log ('accepted supervised restart id=' + $request.request_id)
        return $true
    } catch {
        # Don't discard a marker that the Router has only just started writing.
        $file = Get-Item -LiteralPath $wcmRestartRequest -ErrorAction SilentlyContinue
        if ($file -and $file.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddSeconds(-5)) {
            Log ('discarding invalid WCM restart signal: ' + $_.Exception.Message)
            Remove-Item -LiteralPath $wcmRestartRequest -Force -ErrorAction SilentlyContinue
        }
        return $false
    }
}
