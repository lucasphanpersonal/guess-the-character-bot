# Registers the scheduled tasks that keep this machine serving: the party-mode web app (with its
# tunnel) from logon, and the Discord bot always -- see the note on the bot task below for why
# that one is separate and why it has a watchdog.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove
#
# Safe to re-run with everything up: re-registering a task does not stop a running instance.
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
$BotTaskName = 'Guess the Character (Discord bot)'
$root = Split-Path -Parent $PSScriptRoot

if ($Remove) {
    # Each one only if present, so removing still works on a machine that installed before the
    # bot task existed.
    foreach ($name in $TaskName, $BotTaskName) {
        if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $name -Confirm:$false
            "Removed scheduled task '$name'."
        }
    }
    return
}

# Each task on its own: they are independent, and one that cannot be updated must not stop the
# other from installing. "Access is denied" almost always means that task was first registered
# from an elevated prompt, which leaves it owned by Administrators -- updating it then needs
# elevation too, while creating a new task never does.
$failed = @()
function Install-Task([string]$name, [hashtable]$definition) {
    try {
        Register-ScheduledTask -TaskName $name @definition -Force -ErrorAction Stop | Out-Null
        "Registered '$name':"
        (Get-ScheduledTask -TaskName $name).Actions |
            Select-Object Execute, Arguments, WorkingDirectory | Format-List
    } catch {
        Write-Warning "Could not register '$name': $($_.Exception.Message)"
        if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
            Write-Warning "  It already exists, probably registered from an elevated prompt. It is unchanged; re-run this from an elevated prompt to update it."
        }
        $script:failed += $name
    }
}

$node = (Get-Command node).Source
$action = New-ScheduledTaskAction -Execute $node `
    -Argument 'scripts\start-all.js --secure --tunnel --no-discord' `
    -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

# ExecutionTimeLimit zero means "never time it out": this is a server, not a batch job, and the
# default three-day cap would silently kill it mid-party. RestartCount does NOT cover a crash --
# it only retries a failed launch (see the bot task below, where that was tested) -- so once this
# is running, a crash or a kill leaves the domain dark until the next logon. That is exactly how
# it sat down for a day in September.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Install-Task $TaskName @{
    Action = $action; Trigger = $trigger; Settings = $settings
    Description = 'Starts the Guess the Character web server and its named Cloudflare tunnel at logon.'
}

# --- the Discord bot: its own task, on purpose ------------------------------------------------
#
# Not folded into the task above by dropping --no-discord, because then nothing would ever bring
# it back. start-all deliberately does not restart a dead child (a bad token must not take a
# party down with it), and Task Scheduler judges the TASK -- which stays "Running" for as long as
# the web half is alive. A crashed bot would sit dead indefinitely with every indicator green.
# On its own task, the task's state IS the bot's state, and both mechanisms below can act on it.
#
# What brings it back is a trigger that fires every five minutes, forever: a crash, a kill, a
# failed login -- whatever ended it, the next tick starts it again. RestartCount does NOT do that,
# whatever its name suggests. It only retries a task that failed to LAUNCH, and ignores a program
# that ran and then exited or was killed. Both were tested rather than assumed: a task exiting 1
# with RestartCount 3 ran exactly once, and a force-killed bot came back on the watchdog tick,
# not a minute later. RestartCount stays for the launch case, which is all it covers.
#
# MultipleInstances IgnoreNew is what makes that watchdog safe: it does nothing while the bot is
# running and starts it only when it isn't. It is the default, and stated anyway, because a
# second copy of the bot answers every slash command twice. For the same reason the action runs
# node directly, with no cmd wrapper -- see scripts/run-discord-bot.js.
$botAction = New-ScheduledTaskAction -Execute $node `
    -Argument 'scripts\run-discord-bot.js' `
    -WorkingDirectory $root
$botTriggers = @(
    (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"),
    (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5))
)
$botSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew

Install-Task $BotTaskName @{
    Action = $botAction; Trigger = $botTriggers; Settings = $botSettings
    Description = 'Keeps the Guess the Character Discord bot running. Logs to data\discord-bot.log.'
}

if ($failed) { exit 1 }
