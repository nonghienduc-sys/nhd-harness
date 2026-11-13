param(
  [Parameter(Mandatory=$true)][string]$Action,
  [Parameter(Mandatory=$true)][string]$PayloadBase64
)

$ErrorActionPreference = 'Stop'
$payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadBase64))
$payload = $payloadJson | ConvertFrom-Json

function Get-RunningOfficeStatus {
  $names = @('WINWORD','EXCEL','POWERPNT','OUTLOOK')
  $result = @{}
  foreach ($name in $names) { $result[$name.ToLowerInvariant()] = @(Get-Process -Name $name -ErrorAction SilentlyContinue).Count -gt 0 }
  return $result
}

switch ($Action) {
  'status' {
    Get-RunningOfficeStatus | ConvertTo-Json -Compress
  }
  'word_export_pdf' {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    try {
      $doc = $word.Documents.Open([string]$payload.path, $false, $true)
      $doc.Fields.Update() | Out-Null
      $doc.ExportAsFixedFormat([string]$payload.output, 17)
      $doc.Close($false)
      @{ok=$true; output=[string]$payload.output} | ConvertTo-Json -Compress
    } finally { $word.Quit() }
  }
  'word_document_status' {
    try {
      $word = [Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')
      $doc = $word.ActiveDocument
      if ($null -eq $doc) { @{ok=$true; open=$false} | ConvertTo-Json -Compress; break }
      @{ok=$true; open=$true; path=[string]$doc.FullName; saved=[bool]$doc.Saved; name=[string]$doc.Name} | ConvertTo-Json -Compress
    } catch {
      @{ok=$true; open=$false} | ConvertTo-Json -Compress
    }
  }
  'excel_export_pdf' {
    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $false
    $excel.DisplayAlerts = $false
    try {
      $book = $excel.Workbooks.Open([string]$payload.path, 0, $true)
      $excel.CalculateFullRebuild()
      $book.ExportAsFixedFormat(0, [string]$payload.output)
      $book.Close($false)
      @{ok=$true; output=[string]$payload.output} | ConvertTo-Json -Compress
    } finally { $excel.Quit() }
  }
  'powerpoint_export_pdf' {
    $powerpoint = New-Object -ComObject PowerPoint.Application
    try {
      $deck = $powerpoint.Presentations.Open([string]$payload.path, $true, $false, $false)
      $deck.SaveAs([string]$payload.output, 32)
      $deck.Close()
      @{ok=$true; output=[string]$payload.output} | ConvertTo-Json -Compress
    } finally { $powerpoint.Quit() }
  }
  'word_selection_read' {
    try {
      $word = [Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')
      $doc = $word.ActiveDocument
      if ($null -eq $doc) { @{ok=$true; open=$false} | ConvertTo-Json -Compress; break }
      $selection = $word.Selection
      $text = [string]$selection.Text
      if ($text.Length -gt 20000) { $text = $text.Substring(0, 20000) }
      @{
        ok=$true
        open=$true
        path=[string]$doc.FullName
        name=[string]$doc.Name
        saved=[bool]$doc.Saved
        selection=@{
          text=$text
          start=[int]$selection.Start
          end=[int]$selection.End
          type=[int]$selection.Type
          font=@{name=[string]$selection.Font.Name; size=[double]$selection.Font.Size; bold=[int]$selection.Font.Bold; italic=[int]$selection.Font.Italic}
          paragraph=@{alignment=[int]$selection.ParagraphFormat.Alignment}
        }
      } | ConvertTo-Json -Depth 6 -Compress
    } catch { @{ok=$true; open=$false; error=$_.Exception.Message} | ConvertTo-Json -Compress }
  }
  'word_selection_replace' {
    try {
      $word = [Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')
      $doc = $word.ActiveDocument
      if ($null -eq $doc) { throw 'Word has no active document.' }
      $selection = $word.Selection
      if ($selection.End -le $selection.Start) { throw 'Word selection is empty.' }
      $replacement = [string]$payload.text
      if ($replacement.Length -gt 20000) { throw 'Word live replacement exceeds 20,000 characters.' }
      $start = [int]$selection.Start
      $selection.Text = $replacement
      $range = $doc.Range($start, $start + $replacement.Length)
      $range.Select()
      @{ok=$true; path=[string]$doc.FullName; name=[string]$doc.Name; saved=[bool]$doc.Saved; start=$start; end=($start + $replacement.Length); text=[string]$range.Text} | ConvertTo-Json -Depth 4 -Compress
    } catch { throw }
  }
  'excel_selection_read' {
    try {
      $excel = [Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application')
      $book = $excel.ActiveWorkbook
      if ($null -eq $book) { @{ok=$true; open=$false} | ConvertTo-Json -Compress; break }
      $sheet = $excel.ActiveSheet
      $selection = $excel.Selection
      $count = [double]$selection.Cells.CountLarge
      $cells = @()
      if ($count -le 200) {
        foreach ($cell in $selection.Cells) {
          $cells += @{address=[string]$cell.Address($false,$false); value=$cell.Value2; formula=[string]$cell.Formula}
        }
      }
      @{
        ok=$true
        open=$true
        path=[string]$book.FullName
        name=[string]$book.Name
        saved=[bool]$book.Saved
        sheet=[string]$sheet.Name
        selection=@{address=[string]$selection.Address($false,$false); cellCount=$count; truncated=($count -gt 200); cells=$cells}
      } | ConvertTo-Json -Depth 7 -Compress
    } catch { @{ok=$true; open=$false; error=$_.Exception.Message} | ConvertTo-Json -Compress }
  }
  'powerpoint_selection_read' {
    try {
      $powerpoint = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')
      $deck = $powerpoint.ActivePresentation
      if ($null -eq $deck) { @{ok=$true; open=$false} | ConvertTo-Json -Compress; break }
      $slideIndex = $null
      $slideText = @()
      try {
        $slide = $powerpoint.ActiveWindow.View.Slide
        $slideIndex = [int]$slide.SlideIndex
        $shapeLimit = [Math]::Min([int]$slide.Shapes.Count, 100)
        for ($i = 1; $i -le $shapeLimit; $i++) {
          $shape = $slide.Shapes.Item($i)
          $text = ''
          try { if ($shape.HasTextFrame -and $shape.TextFrame.HasText) { $text = [string]$shape.TextFrame.TextRange.Text } } catch {}
          if ($text.Length -gt 4000) { $text = $text.Substring(0,4000) }
          if ($text) { $slideText += @{name=[string]$shape.Name; text=$text} }
        }
      } catch {}
      $selected = @()
      try {
        $selection = $powerpoint.ActiveWindow.Selection
        if ($selection.Type -eq 2) {
          $limit = [Math]::Min([int]$selection.ShapeRange.Count, 50)
          for ($i = 1; $i -le $limit; $i++) {
            $shape = $selection.ShapeRange.Item($i)
            $text = ''
            try { if ($shape.HasTextFrame -and $shape.TextFrame.HasText) { $text = [string]$shape.TextFrame.TextRange.Text } } catch {}
            if ($text.Length -gt 4000) { $text = $text.Substring(0,4000) }
            $selected += @{name=[string]$shape.Name; text=$text}
          }
        }
      } catch {}
      @{
        ok=$true
        open=$true
        path=[string]$deck.FullName
        name=[string]$deck.Name
        saved=[bool]$deck.Saved
        slideIndex=$slideIndex
        slideText=$slideText
        selectedShapes=$selected
      } | ConvertTo-Json -Depth 7 -Compress
    } catch { @{ok=$true; open=$false; error=$_.Exception.Message} | ConvertTo-Json -Compress }
  }
  'outlook_search' {
    $outlook = New-Object -ComObject Outlook.Application
    $namespace = $outlook.GetNamespace('MAPI')
    $folder = $namespace.GetDefaultFolder(6)
    $items = $folder.Items
    $items.Sort('[ReceivedTime]', $true)
    $query = [string]$payload.query
    $limit = [Math]::Min([int]$payload.limit, 50)
    $results = @()
    foreach ($item in $items) {
      if ($results.Count -ge $limit) { break }
      if (($item.Subject -like "*$query*") -or ($item.SenderName -like "*$query*")) {
        $results += @{subject=$item.Subject; sender=$item.SenderName; received=$item.ReceivedTime.ToString('o'); entryId=$item.EntryID}
      }
    }
    @{ok=$true; results=$results} | ConvertTo-Json -Depth 4 -Compress
  }
  'outlook_read' {
    $outlook = New-Object -ComObject Outlook.Application
    $namespace = $outlook.GetNamespace('MAPI')
    $item = $namespace.GetItemFromID([string]$payload.entryId)
    if ($null -eq $item) { throw 'Outlook message was not found.' }
    $attachments = @()
    foreach ($attachment in $item.Attachments) { $attachments += [string]$attachment.FileName }
    $body = [string]$item.Body
    if ($body.Length -gt 100000) { $body = $body.Substring(0, 100000) }
    @{
      ok=$true
      entryId=[string]$item.EntryID
      subject=[string]$item.Subject
      sender=[string]$item.SenderName
      senderEmail=[string]$item.SenderEmailAddress
      received=$item.ReceivedTime.ToString('o')
      to=[string]$item.To
      cc=[string]$item.CC
      body=$body
      attachments=$attachments
    } | ConvertTo-Json -Depth 4 -Compress
  }
  default { throw "Unsupported Office action: $Action" }
}
