# Registers a logon task that brings the party-mode web app back up after a reboot.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove
#
# Web server AND tunnel in ONE task on purpose. Starting the tunnel on its own -- which is what
# `cloudflared service install` does -- leaves it fronting a dead port whenever the web server
# is not also running, and Cloudflare answers that with a 502 that reads as "the site is broken"
# and sends you debugging the wrong process. start-all already supervises the pair and stops
# them together, so let it own both.
#
# No admin needed: this runs as you, at your logon, which is also when your user profile (and so
# ~/.cloudflared/config.yml) is actually readable. A LocalSystem service cannot see that file --
# that is the other half of the same trap.

param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$TaskName = 'Guess the Character'
$root = Split-Path -Parent $PSScriptRoot

if ($Remove) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    "Removed scheduled task '$TaskName'."
    return
}

$node = (Get-Command node).Source
$action = New-ScheduledTaskAction -Execute $node `
    -Argument 'scripts\start-all.js --secure --tunnel --no-discord' `
    -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

# ExecutionTimeLimit zero means "never time it out": this is a server, not a batch job, and the
# default three-day cap would silently kill it mid-party. RestartCount covers a crash without
# leaving the domain dark until the next time you happen to log in.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Starts the Guess the Character web server and its named Cloudflare tunnel at logon.' `
    -Force | Out-Null

"Registered '$TaskName':"
(Get-ScheduledTask -TaskName $TaskName).Actions |
    Select-Object Execute, Arguments, WorkingDirectory | Format-List
