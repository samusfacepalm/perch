# Creates "Perch" shortcuts on the desktop and in the Start menu, with the parrot icon.
# Run again after moving the project folder.

$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root "node_modules\electron\dist\electron.exe"
$icon = Join-Path $root "electron\icon.ico"
$shell = New-Object -ComObject WScript.Shell

$targets = @(
    (Join-Path ([Environment]::GetFolderPath("Desktop")) "Perch.lnk"),
    (Join-Path ([Environment]::GetFolderPath("Programs")) "Perch.lnk")
)
foreach ($path in $targets) {
    $lnk = $shell.CreateShortcut($path)
    $lnk.TargetPath = $electron
    $lnk.Arguments = "`"$root`""
    $lnk.WorkingDirectory = $root
    $lnk.IconLocation = "$icon,0"
    $lnk.Description = "Perch coding agent"
    $lnk.Save()
    "Created $path"
}
