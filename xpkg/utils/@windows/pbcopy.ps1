Add-Type -AssemblyName System.Drawing

$memStream = New-Object System.IO.MemoryStream
$image = $null

try {
    [Console]::OpenStandardInput().CopyTo($memStream)
    if ($memStream.Length -gt 0) {
        $memStream.Position = 0
        $image = [System.Drawing.Image]::FromStream($memStream)
        [System.Windows.Forms.Clipboard]::SetImage($image)
    }
}
catch {
    Write-Error "Failed to process pipeline data as an image. Error: $($_.Exception.Message)"
}
finally {
    if ($null -ne $image) { $image.Dispose() }
    $memStream.Dispose()
}
