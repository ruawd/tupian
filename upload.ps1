# 批量上传图片到 Cloudflare 图床
$baseUrl = "https://e8bf8239.cloudflare-imgbed-19p.pages.dev/upload"
$dirs = @("ri\h", "ri\v")
$total = 0
$success = 0
$fail = 0

foreach ($dir in $dirs) {
    $files = Get-ChildItem -Path $dir -File -Recurse
    Write-Host "=== 目录: $dir, 共 $($files.Count) 个文件 ==="
    
    foreach ($f in $files) {
        $total++
        $fileName = $f.Name
        $ext = $f.Extension.ToLower()
        
        # 确定 Content-Type
        $contentType = switch ($ext) {
            ".webp" { "image/webp" }
            ".jpg"  { "image/jpeg" }
            ".jpeg" { "image/jpeg" }
            ".png"  { "image/png" }
            ".gif"  { "image/gif" }
            ".avif" { "image/avif" }
            default { "application/octet-stream" }
        }
        
        try {
            $boundary = [System.Guid]::NewGuid().ToString()
            $fileBytes = [System.IO.File]::ReadAllBytes($f.FullName)
            $enc = [System.Text.Encoding]::UTF8
            
            $header = "--$boundary`r`nContent-Disposition: form-data; name=`"file`"; filename=`"$fileName`"`r`nContent-Type: $contentType`r`n`r`n"
            $footer = "`r`n--$boundary--`r`n"
            
            $headerBytes = $enc.GetBytes($header)
            $footerBytes = $enc.GetBytes($footer)
            
            $body = New-Object byte[] ($headerBytes.Length + $fileBytes.Length + $footerBytes.Length)
            [System.Buffer]::BlockCopy($headerBytes, 0, $body, 0, $headerBytes.Length)
            [System.Buffer]::BlockCopy($fileBytes, 0, $body, $headerBytes.Length, $fileBytes.Length)
            [System.Buffer]::BlockCopy($footerBytes, 0, $body, $headerBytes.Length + $fileBytes.Length, $footerBytes.Length)
            
            $resp = Invoke-RestMethod -Uri $baseUrl -Method POST -ContentType "multipart/form-data; boundary=$boundary" -Body $body -TimeoutSec 30
            $success++
            Write-Host "[$success/$total] OK: $fileName"
            
            # 避免速率限制，每次上传后等待 500ms
            Start-Sleep -Milliseconds 500
        }
        catch {
            $fail++
            Write-Host "[$total] FAIL: $fileName - $_"
            # 失败后等久一点再重试
            Start-Sleep -Seconds 2
        }
    }
}

Write-Host ""
Write-Host "========== 上传完成 =========="
Write-Host "总计: $total, 成功: $success, 失败: $fail"
