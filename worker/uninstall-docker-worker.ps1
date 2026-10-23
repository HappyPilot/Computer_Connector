[CmdletBinding()]
param([string]$ContainerName='computer-connector-worker')
$ErrorActionPreference='Stop'
$docker=(Get-Command docker.exe -CommandType Application -ErrorAction Stop).Source
$existing=& $docker ps -a --filter "name=^/$ContainerName$" --format '{{.Names}}'
if($existing -eq $ContainerName){
    & $docker rm -f $ContainerName | Out-Null
    Write-Output ("Removed worker container: {0}" -f $ContainerName)
} else {
    Write-Output ("Worker container not found: {0}" -f $ContainerName)
}