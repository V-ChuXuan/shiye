param([Parameter(Mandatory=$true)][string]$Biz)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type -AssemblyName System.Web
    $condition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Document
    )
    $processes = @(Get-Process -Name WeChatAppEx -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
    foreach ($wechatProcess in $processes) {
        try {
            $root = [System.Windows.Automation.AutomationElement]::FromHandle($wechatProcess.MainWindowHandle)
            $documents = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
            foreach ($document in $documents) {
                try {
                    $pattern = $null
                    if (-not $document.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { continue }
                    $uri = $null
                    if (-not [System.Uri]::TryCreate($pattern.Current.Value, [System.UriKind]::Absolute, [ref]$uri)) { continue }
                    if ($uri.Scheme -ne 'https' -or $uri.Host -ne 'mp.weixin.qq.com' -or $uri.AbsolutePath -notmatch '^/s(?:/|$)') { continue }
                    $query = [System.Web.HttpUtility]::ParseQueryString($uri.Query)
                    if ($query['__biz'] -ne $Biz -or -not $query['uin'] -or -not $query['key']) { continue }
                    @{biz=$Biz;uin=$query['uin'];key=$query['key'];passTicket=[string]$query['pass_ticket']} | ConvertTo-Json -Compress
                    exit 0
                } catch { continue }
            }
        } catch { continue }
    }
    [Console]::Out.WriteLine('{"error":"need_session"}')
    exit 1
} catch {
    [Console]::Out.WriteLine('{"error":"need_session"}')
    exit 1
}
