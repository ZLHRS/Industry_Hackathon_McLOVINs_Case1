# Portable entrypoint. Python is the only toolbelt runtime dependency.
$ErrorActionPreference = 'Stop'
$toolArguments = @($args)
if ($toolArguments.Count -eq 0) { $toolArguments = @('doctor') }
$pythonCandidates = @()
if ($env:CODEX_TOOLBELT_PYTHON) {
    $pythonCandidates = @($env:CODEX_TOOLBELT_PYTHON)
} else {
    foreach ($pythonName in @('python', 'python3')) {
        $pythonCommand = Get-Command $pythonName -CommandType Application -ErrorAction SilentlyContinue
        if ($pythonCommand -and $pythonCommand.Source -notlike '*WindowsApps*') {
            $pythonCandidates += $pythonCommand.Source
        }
    }
    if ($env:USERPROFILE) {
        $pythonCandidates += Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
    }
}
foreach ($pythonCandidate in ($pythonCandidates | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $pythonCandidate -PathType Leaf)) { continue }
    try {
        & $pythonCandidate -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 2)' 2>$null
        if ($LASTEXITCODE -ne 0) { continue }
        & $pythonCandidate (Join-Path $PSScriptRoot 'toolbelt.py') @toolArguments
        exit $LASTEXITCODE
    } catch {
        Write-Error "Could not execute Python toolbelt: $($_.Exception.Message)"
        exit 2
    }
}
Write-Error 'Python 3.11+ is required. Set CODEX_TOOLBELT_PYTHON to its executable path or add Python to PATH.' -ErrorAction Continue
exit 2
