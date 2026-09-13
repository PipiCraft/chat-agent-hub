param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ScriptArgs
)

& "$PSScriptRoot\run.bat" @ScriptArgs
