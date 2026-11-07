# Registers the scheduled tasks that keep this machine serving:
#
#   'Guess the Character'          the web app with its tunnel, from logon, with a five-minute
#                                  watchdog -- see the notes below for what the watchdog relies on.
#   'Guess the Character (keeper)' scripts/host-keeper.js every two minutes: deploys each merge to
#                                  main once no game is in progress, and restarts a site that is
#                                  running but has stopped answering. Its log is
#                                  data\host-keeper\keeper.log.
#
# To stop this machine hosting, DISABLE 'Guess the Character' (or run -Remove): stopping it is not
# enough, because the watchdog starts it again. The keeper does nothing while that task is
# disabled or missing.
#
# -Remove removes both, and the old "Guess the Character (Discord bot)" task, if a machine still
# has it from before the Discord bot was retired.
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
$KeeperTaskName = 'Guess the Character (keeper)'
$BotTaskName = 'Guess the Character (Discord bot)'
$root = Split-Path -Parent $PSScriptRoot

if ($Remove) {
    # Each one only if present: the bot task exists only on machines set up before it was retired.
    foreach ($name in $TaskName, $KeeperTaskName, $BotTaskName) {
        if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $name -Confirm:$false
            "Removed scheduled task '$name'."
        }
    }
    return
}

# "Access is denied" almost always means that task was first registered
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
    -Argument 'scripts\start-all.js --secure --tunnel' `
    -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

# ExecutionTimeLimit zero means "never time it out": this is a server, not a batch job, and the
# default three-day cap would silently kill it mid-party. RestartCount does NOT cover a crash --
# it only retries a failed launch (tested: a task exiting 1 with RestartCount 3 ran exactly once,
# and a force-killed process came back on the watchdog tick, not a minute later) -- so with only
# the logon trigger, a crash or a kill left the domain dark until the next logon. That is how it
# sat down for a day in September, and twice more in October (the launcher ended with
# 0xC000013A, "closed", overnight, and the site 502'd until someone looked).
#
# So it has a watchdog: a trigger every five minutes that starts it only if it is not
# running (MultipleInstances IgnoreNew -- stated, because a second launcher would fight the first
# for :4180). That only works because start-all now EXITS when the web server or the tunnel dies,
# instead of staying up with the survivor and looking "Running" to this scheduler forever.
#
# One consequence: a launcher started by hand, outside this task, is invisible to it -- the next
# tick starts a second stack that loses the race for :4180. Stop the task, or run the hand-started
# one with this task disabled.
#
# What the watchdog CANNOT cover: the task runs only while you are logged on (Interactive). The
# October outage that settled this was Windows Update restarting the machine at 5am -- twice --
# and nobody logging on until 1pm, so no trigger fired at all and the site was dark for eight
# hours. Surviving that means running whether logged on or not (an S4U principal, plus an
# at-startup trigger), which needs an elevated prompt and changes how the task authenticates. It
# is deliberately not done here; make it a decision, not a side effect of re-running this script.
$triggers = @(
    $trigger,
    (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5))
)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew

Install-Task $TaskName @{
    Action = $action; Trigger = $triggers; Settings = $settings
    Description = 'Starts the Guess the Character web server and its named Cloudflare tunnel at logon.'
}

# The keeper. A short job every two minutes rather than a long-running process, so there is no
# second thing to keep alive: a run that crashes is simply followed by the next one.
#
# Under `conhost --headless` because a console program started by an interactive task opens a
# window, and one flashing up every two minutes on the host's desktop is not acceptable. (The
# launcher's own window is a single one that stays.)
#
# ExecutionTimeLimit covers the slowest run, a deploy with `npm ci` (which host-keeper.js itself
# caps at 15 minutes). IgnoreNew so a slow run is never joined by a second one halfway through a
# deploy. Interactive like the launcher, so it runs as you and git sees your credentials and config.
$keeperAction = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\conhost.exe') `
    -Argument "--headless `"$node`" scripts\host-keeper.js" `
    -WorkingDirectory $root
$keeperTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 2)
$keeperSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -StartWhenAvailable `
    -MultipleInstances IgnoreNew

Install-Task $KeeperTaskName @{
    Action = $keeperAction; Trigger = $keeperTrigger; Settings = $keeperSettings
    Description = 'Deploys merges to main and restarts the Guess the Character site if it stops answering (scripts/host-keeper.js).'
}

if ($failed) { exit 1 }
