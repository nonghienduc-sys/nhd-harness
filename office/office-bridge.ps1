param(
  [Parameter(Mandatory=$true)][string]$Action,
  [Parameter(Mandatory=$true)][string]$PayloadBase64
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadBase64))
$payload = $payloadJson | ConvertFrom-Json

function Get-Sha256Text([string]$Text) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally { $sha.Dispose() }
}

function Limit-Text([string]$Text, [int]$Max = 20000) {
  if ($null -eq $Text) { return '' }
  if ($Text.Length -le $Max) { return $Text }
  return $Text.Substring(0, $Max)
}

function Get-RunningOfficeStatus {
  $names = @('WINWORD','EXCEL','POWERPNT','OUTLOOK')
  $result = @{}
  foreach ($name in $names) { $result[$name.ToLowerInvariant()] = @(Get-Process -Name $name -ErrorAction SilentlyContinue).Count -gt 0 }
  return $result
}

function Get-WordRangeForScope($word, $doc, [string]$scope) {
  $selection = $word.Selection
  switch ($scope) {
    'selection' { return $selection.Range.Duplicate }
    'paragraph' { return $selection.Paragraphs.Item(1).Range.Duplicate }
    'document' { return $doc.Content.Duplicate }
    'current_section' { return $selection.Sections.Item(1).Range.Duplicate }
    default { return $selection.Range.Duplicate }
  }
}

function Get-WordParagraphRange($doc, [int]$StartParagraph, [int]$EndParagraph) {
  $count = [int]$doc.Paragraphs.Count
  if ($StartParagraph -lt 1 -or $EndParagraph -lt $StartParagraph -or $EndParagraph -gt $count) {
    throw "Word paragraph range $StartParagraph-$EndParagraph is outside the document (1-$count)."
  }
  $first = $doc.Paragraphs.Item($StartParagraph).Range
  $last = $doc.Paragraphs.Item($EndParagraph).Range
  return $doc.Range([int]$first.Start, [int]$last.End)
}

function Get-WordTargetRange($word, $doc, $target) {
  $scope = 'selection'
  try { if ($target.scope) { $scope = [string]$target.scope } } catch {}
  if ($scope -eq 'cursor') {
    $selection = $word.Selection
    if ([int]$selection.Start -ne [int]$selection.End) { throw 'Word cursor insert requires a collapsed selection.' }
    return $doc.Range([int]$selection.Start, [int]$selection.Start)
  }
  if ($scope -eq 'document_end') {
    $pos = [Math]::Max(0, [int]$doc.Content.End - 1)
    return $doc.Range($pos, $pos)
  }
  if ($scope -eq 'paragraphs') {
    $startParagraph = 0
    $endParagraph = 0
    try { $startParagraph = [int]$target.paragraphStart } catch {}
    try { $endParagraph = [int]$target.paragraphEnd } catch {}
    if ($startParagraph -lt 1) { throw 'Word paragraphStart must be >= 1.' }
    if ($endParagraph -lt 1) { $endParagraph = $startParagraph }
    return Get-WordParagraphRange $doc $startParagraph $endParagraph
  }
  return Get-WordRangeForScope $word $doc $scope
}

function Get-WordParagraphSummaries($doc, [int]$Max = 250) {
  $items = @()
  $limit = [Math]::Min([int]$doc.Paragraphs.Count, $Max)
  for ($i = 1; $i -le $limit; $i++) {
    $range = $doc.Paragraphs.Item($i).Range
    $text = [string]$range.Text
    $font = $range.Font
    $para = $range.ParagraphFormat
    $items += @{
      index = $i
      start = [int]$range.Start
      end = [int]$range.End
      text = Limit-Text $text 700
      textLength = [int]$text.Length
      font = @{name=[string]$font.Name; size=[double]$font.Size; bold=[int]$font.Bold; italic=[int]$font.Italic; underline=[int]$font.Underline; color=[int]$font.Color}
      paragraph = @{
        alignment=[int]$para.Alignment; firstLineIndent=[double]$para.FirstLineIndent; leftIndent=[double]$para.LeftIndent;
        rightIndent=[double]$para.RightIndent; spaceBefore=[double]$para.SpaceBefore; spaceAfter=[double]$para.SpaceAfter;
        lineSpacingRule=[int]$para.LineSpacingRule; lineSpacing=[double]$para.LineSpacing
      }
    }
  }
  return $items
}

function Get-WordRangeSnapshot($range) {
  $text = [string]$range.Text
  $font = $range.Font
  $para = $range.ParagraphFormat
  return @{
    start = [int]$range.Start
    end = [int]$range.End
    text = Limit-Text $text 12000
    textLength = [int]$text.Length
    font = @{
      name = [string]$font.Name
      size = [double]$font.Size
      bold = [int]$font.Bold
      italic = [int]$font.Italic
      underline = [int]$font.Underline
      color = [int]$font.Color
    }
    paragraph = @{
      alignment = [int]$para.Alignment
      firstLineIndent = [double]$para.FirstLineIndent
      leftIndent = [double]$para.LeftIndent
      rightIndent = [double]$para.RightIndent
      spaceBefore = [double]$para.SpaceBefore
      spaceAfter = [double]$para.SpaceAfter
      lineSpacingRule = [int]$para.LineSpacingRule
      lineSpacing = [double]$para.LineSpacing
      keepTogether = [int]$para.KeepTogether
      keepWithNext = [int]$para.KeepWithNext
    }
  }
}

function Get-WordPageSnapshot($page) {
  return @{
    topMargin = [double]$page.TopMargin
    bottomMargin = [double]$page.BottomMargin
    leftMargin = [double]$page.LeftMargin
    rightMargin = [double]$page.RightMargin
    headerDistance = [double]$page.HeaderDistance
    footerDistance = [double]$page.FooterDistance
    orientation = [int]$page.Orientation
    paperSize = [int]$page.PaperSize
  }
}

function Get-WordInspect($Request, $word = $null, $doc = $null) {
  try {
    if ($null -eq $word) { $word = [Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application') }
    if ($null -eq $doc) { $doc = $word.ActiveDocument }
    if ($null -eq $doc) { return @{ok=$true; open=$false} }
    $selection = $word.Selection
    $scope = 'selection'
    try { if ($Request.target.scope) { $scope = [string]$Request.target.scope } } catch {}
    $targetRange = Get-WordTargetRange $word $doc $Request.target
    $selectionRange = $selection.Range.Duplicate
    $paragraphRange = $selection.Paragraphs.Item(1).Range.Duplicate
    $section = $selection.Sections.Item(1)
    $contextChars = 4000
    try { if ($null -ne $Request.contextChars) { $contextChars = [Math]::Max(0, [Math]::Min(20000, [int]$Request.contextChars)) } } catch {}
    $beforeStart = [Math]::Max(0, [int]$selectionRange.Start - $contextChars)
    $afterEnd = [Math]::Min([int]$doc.Content.End, [int]$selectionRange.End + $contextChars)
    $before = ''
    $after = ''
    if ($contextChars -gt 0) {
      $before = [string]$doc.Range($beforeStart, [int]$selectionRange.Start).Text
      $after = [string]$doc.Range([int]$selectionRange.End, $afterEnd).Text
    }
    $targetText = [string]$targetRange.Text
    $paragraphs = Get-WordParagraphSummaries $doc 250
    $targetSnapshot = Get-WordRangeSnapshot $targetRange
    $fingerprintParagraphs = @($paragraphs | ForEach-Object { @{index=$_.index; start=$_.start; end=$_.end; text=$_.text; textLength=$_.textLength; font=$_.font; paragraph=$_.paragraph} })
    $fingerprintMaterial = @{
      path = [string]$doc.FullName
      name = [string]$doc.Name
      scope = $scope
      targetStart = [int]$targetRange.Start
      targetEnd = [int]$targetRange.End
      targetText = $targetText
      targetSnapshot = $targetSnapshot
      paragraphFormats = $fingerprintParagraphs
      saved = [bool]$doc.Saved
      chars = [int]$doc.Characters.Count
      words = [int]$doc.Words.Count
      section = [int]$section.Index
      page = Get-WordPageSnapshot $section.PageSetup
    } | ConvertTo-Json -Depth 8 -Compress
    return @{
      ok = $true
      open = $true
      application = 'word'
      path = [string]$doc.FullName
      name = [string]$doc.Name
      saved = [bool]$doc.Saved
      readOnly = [bool]$doc.ReadOnly
      protectionType = [int]$doc.ProtectionType
      wordCount = [int]$doc.Words.Count
      characterCount = [int]$doc.Characters.Count
      paragraphCount = [int]$doc.Paragraphs.Count
      paragraphs = $paragraphs
      paragraphsTruncated = ([int]$doc.Paragraphs.Count -gt 250)
      tableCount = [int]$doc.Tables.Count
      sectionCount = [int]$doc.Sections.Count
      selection = Get-WordRangeSnapshot $selectionRange
      paragraph = Get-WordRangeSnapshot $paragraphRange
      targetScope = $scope
      target = $targetSnapshot
      currentSection = @{
        index = [int]$section.Index
        pageSetup = Get-WordPageSnapshot $section.PageSetup
      }
      context = @{before = Limit-Text $before $contextChars; after = Limit-Text $after $contextChars}
      fingerprint = Get-Sha256Text $fingerprintMaterial
    }
  } catch {
    return @{ok=$true; open=$false; error=$_.Exception.Message}
  }
}


function Convert-HexToWordColor([string]$Hex) {
  $value = ([string]$Hex).Trim()
  if ($value.StartsWith('#')) { $value = $value.Substring(1) }
  if ($value -notmatch '^[0-9A-Fa-f]{6}$') { throw 'fontColorHex must be #RRGGBB.' }
  $r = [Convert]::ToInt32($value.Substring(0,2),16)
  $g = [Convert]::ToInt32($value.Substring(2,2),16)
  $b = [Convert]::ToInt32($value.Substring(4,2),16)
  return [int]($r + 256*$g + 65536*$b)
}

function Set-WordFormat($word, $range, $format) {
  if ($null -ne $format.fontName) { $range.Font.Name = [string]$format.fontName }
  if ($null -ne $format.fontSize) { $range.Font.Size = [double]$format.fontSize }
  if ($null -ne $format.bold) { $range.Font.Bold = $(if ([bool]$format.bold) { -1 } else { 0 }) }
  if ($null -ne $format.italic) { $range.Font.Italic = $(if ([bool]$format.italic) { -1 } else { 0 }) }
  if ($null -ne $format.underline) { $range.Font.Underline = $(if ([bool]$format.underline) { 1 } else { 0 }) }
  if ($null -ne $format.fontColorHex) { $range.Font.Color = Convert-HexToWordColor ([string]$format.fontColorHex) }
  if ($null -ne $format.alignment) {
    $map = @{left=0; center=1; right=2; justify=3}
    $range.ParagraphFormat.Alignment = [int]$map[[string]$format.alignment]
  }
  if ($null -ne $format.firstLineIndentCm) { $range.ParagraphFormat.FirstLineIndent = $word.CentimetersToPoints([double]$format.firstLineIndentCm) }
  if ($null -ne $format.leftIndentCm) { $range.ParagraphFormat.LeftIndent = $word.CentimetersToPoints([double]$format.leftIndentCm) }
  if ($null -ne $format.rightIndentCm) { $range.ParagraphFormat.RightIndent = $word.CentimetersToPoints([double]$format.rightIndentCm) }
  if ($null -ne $format.spaceBeforePt) { $range.ParagraphFormat.SpaceBefore = [double]$format.spaceBeforePt }
  if ($null -ne $format.spaceAfterPt) { $range.ParagraphFormat.SpaceAfter = [double]$format.spaceAfterPt }
  if ($null -ne $format.lineSpacingMultiple) {
    $range.ParagraphFormat.LineSpacingRule = 5
    $range.ParagraphFormat.LineSpacing = $word.LinesToPoints([double]$format.lineSpacingMultiple)
  }
  if ($null -ne $format.lineSpacingPt) {
    $range.ParagraphFormat.LineSpacingRule = 4
    $range.ParagraphFormat.LineSpacing = [double]$format.lineSpacingPt
  }
  if ($null -ne $format.keepTogether) { $range.ParagraphFormat.KeepTogether = $(if ([bool]$format.keepTogether) { -1 } else { 0 }) }
  if ($null -ne $format.keepWithNext) { $range.ParagraphFormat.KeepWithNext = $(if ([bool]$format.keepWithNext) { -1 } else { 0 }) }
}

function Set-WordPage($word, $pageSetup, $spec) {
  if ($null -ne $spec.topMarginCm) { $pageSetup.TopMargin = $word.CentimetersToPoints([double]$spec.topMarginCm) }
  if ($null -ne $spec.bottomMarginCm) { $pageSetup.BottomMargin = $word.CentimetersToPoints([double]$spec.bottomMarginCm) }
  if ($null -ne $spec.leftMarginCm) { $pageSetup.LeftMargin = $word.CentimetersToPoints([double]$spec.leftMarginCm) }
  if ($null -ne $spec.rightMarginCm) { $pageSetup.RightMargin = $word.CentimetersToPoints([double]$spec.rightMarginCm) }
  if ($null -ne $spec.headerDistanceCm) { $pageSetup.HeaderDistance = $word.CentimetersToPoints([double]$spec.headerDistanceCm) }
  if ($null -ne $spec.footerDistanceCm) { $pageSetup.FooterDistance = $word.CentimetersToPoints([double]$spec.footerDistanceCm) }
  if ($null -ne $spec.orientation) { $pageSetup.Orientation = $(if ([string]$spec.orientation -eq 'landscape') { 1 } else { 0 }) }
  if ($null -ne $spec.paperSize) { $pageSetup.PaperSize = $(if ([string]$spec.paperSize -eq 'LETTER') { 2 } else { 7 }) }
}

function Test-Approx([double]$Actual, [double]$Expected, [double]$Tolerance = 0.75) {
  return [Math]::Abs($Actual - $Expected) -le $Tolerance
}


function Convert-ToWordInsertText([string]$Text) {
  if ($null -eq $Text) { return '' }
  $value = $Text -replace "`r`n", "`n"
  $value = $value -replace "`r", "`n"
  return ($value -replace "`n", "`r")
}

function Test-WordFormatSnapshot($snap, $format) {
  $ok = $true
  if ($null -ne $format.fontName) { $ok = $ok -and ([string]$snap.font.name -eq [string]$format.fontName) }
  if ($null -ne $format.fontSize) { $ok = $ok -and (Test-Approx ([double]$snap.font.size) ([double]$format.fontSize) 0.1) }
  if ($null -ne $format.bold) { $ok = $ok -and (([int]$snap.font.bold -ne 0) -eq [bool]$format.bold) }
  if ($null -ne $format.italic) { $ok = $ok -and (([int]$snap.font.italic -ne 0) -eq [bool]$format.italic) }
  if ($null -ne $format.fontColorHex) { $ok = $ok -and ([int]$snap.font.color -eq (Convert-HexToWordColor ([string]$format.fontColorHex))) }
  if ($null -ne $format.alignment) {
    $map = @{left=0; center=1; right=2; justify=3}
    $ok = $ok -and ([int]$snap.paragraph.alignment -eq [int]$map[[string]$format.alignment])
  }
  return [bool]$ok
}

function Apply-WordOperation($operation, $word = $null, $doc = $null) {
  if ($null -eq $word) { $word = [Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application') }
  if ($null -eq $doc) { $doc = $word.ActiveDocument }
  if ($null -eq $doc) { throw 'Word has no active document.' }
  $type = [string]$operation.type
  $verified = $false
  $receipt = @{}
  switch ($type) {
    'replace_selection' {
      $selection = $word.Selection
      if ($selection.End -le $selection.Start) { throw 'Word selection is empty.' }
      $replacement = [string]$operation.text
      if ($replacement.Length -gt 20000) { throw 'Word live replacement exceeds 20,000 characters.' }
      $start = [int]$selection.Start
      $selection.Text = $replacement
      $range = $doc.Range($start, $start + $replacement.Length)
      $range.Select()
      $verified = ([string]$range.Text -eq $replacement)
      $receipt = @{start=$start; end=($start + $replacement.Length); characters=$replacement.Length}
    }
    'word_insert_at_cursor' {
      $selection = $word.Selection
      if ([int]$selection.Start -ne [int]$selection.End) { throw 'Word cursor insert requires a collapsed selection.' }
      $start = [int]$selection.Start
      $position = $start
      $blockReceipts = @()
      $expected = ''
      foreach ($block in @($operation.blocks)) {
        $text = Convert-ToWordInsertText ([string]$block.text)
        if ($text.Length -lt 1) { throw 'Word live insert block is empty.' }
        $r = $doc.Range($position, $position)
        $r.Text = $text
        $inserted = $doc.Range($position, $position + $text.Length)
        if ($null -ne $block.format) { Set-WordFormat $word $inserted $block.format }
        $snap = Get-WordRangeSnapshot $inserted
        $formatVerified = $true
        if ($null -ne $block.format) { $formatVerified = Test-WordFormatSnapshot $snap $block.format }
        $blockReceipts += @{start=$position; end=($position+$text.Length); characters=$text.Length; formatVerified=[bool]$formatVerified}
        if (-not $formatVerified) { throw 'Word inserted block formatting verification failed.' }
        $expected += $text
        $position += $text.Length
      }
      $verifyRange = $doc.Range($start, $position)
      $verified = ([string]$verifyRange.Text -eq $expected)
      $offset = $expected.Length
      try { if ($null -ne $operation.cursorOffset) { $offset = [Math]::Max(0, [Math]::Min($expected.Length, [int]$operation.cursorOffset)) } } catch {}
      $word.Selection.SetRange($start + $offset, $start + $offset)
      $receipt = @{mode='cursor'; start=$start; end=$position; characters=$expected.Length; cursor=[int]($start+$offset); blocks=$blockReceipts}
    }
    'word_append' {
      $start = [Math]::Max(0, [int]$doc.Content.End - 1)
      $position = $start
      $blockReceipts = @()
      $expected = ''
      foreach ($block in @($operation.blocks)) {
        $text = Convert-ToWordInsertText ([string]$block.text)
        if ($text.Length -lt 1) { throw 'Word live insert block is empty.' }
        $r = $doc.Range($position, $position)
        $r.Text = $text
        $inserted = $doc.Range($position, $position + $text.Length)
        if ($null -ne $block.format) { Set-WordFormat $word $inserted $block.format }
        $snap = Get-WordRangeSnapshot $inserted
        $formatVerified = $true
        if ($null -ne $block.format) { $formatVerified = Test-WordFormatSnapshot $snap $block.format }
        $blockReceipts += @{start=$position; end=($position+$text.Length); characters=$text.Length; formatVerified=[bool]$formatVerified}
        if (-not $formatVerified) { throw 'Word appended block formatting verification failed.' }
        $expected += $text
        $position += $text.Length
      }
      $verifyRange = $doc.Range($start, $position)
      $verified = ([string]$verifyRange.Text -eq $expected)
      $offset = $expected.Length
      try { if ($null -ne $operation.cursorOffset) { $offset = [Math]::Max(0, [Math]::Min($expected.Length, [int]$operation.cursorOffset)) } } catch {}
      $word.Selection.SetRange($start + $offset, $start + $offset)
      $receipt = @{mode='append'; start=$start; end=$position; characters=$expected.Length; cursor=[int]($start+$offset); blocks=$blockReceipts}
    }
    'word_format' {
      $scope = [string]$operation.scope
      $range = Get-WordRangeForScope $word $doc $scope
      if ($scope -eq 'selection' -and $range.End -le $range.Start) { throw 'Word selection is empty.' }
      Set-WordFormat $word $range $operation.format
      $snap = Get-WordRangeSnapshot $range
      $verified = $true
      if ($null -ne $operation.format.fontName) { $verified = $verified -and ([string]$snap.font.name -eq [string]$operation.format.fontName) }
      if ($null -ne $operation.format.fontSize) { $verified = $verified -and (Test-Approx ([double]$snap.font.size) ([double]$operation.format.fontSize) 0.1) }
      if ($null -ne $operation.format.bold) { $verified = $verified -and (([int]$snap.font.bold -ne 0) -eq [bool]$operation.format.bold) }
      if ($null -ne $operation.format.italic) { $verified = $verified -and (([int]$snap.font.italic -ne 0) -eq [bool]$operation.format.italic) }
      if ($null -ne $operation.format.alignment) {
        $map = @{left=0; center=1; right=2; justify=3}
        $verified = $verified -and ([int]$snap.paragraph.alignment -eq [int]$map[[string]$operation.format.alignment])
      }
      $receipt = @{scope=$scope; start=[int]$range.Start; end=[int]$range.End}
    }
    'word_format_paragraphs' {
      $startParagraph = [int]$operation.startParagraph
      $endParagraph = $startParagraph
      try { if ($null -ne $operation.endParagraph) { $endParagraph = [int]$operation.endParagraph } } catch {}
      $range = Get-WordParagraphRange $doc $startParagraph $endParagraph
      Set-WordFormat $word $range $operation.format
      $snap = Get-WordRangeSnapshot $range
      $verified = $true
      if ($null -ne $operation.format.fontName) { $verified = $verified -and ([string]$snap.font.name -eq [string]$operation.format.fontName) }
      if ($null -ne $operation.format.fontSize) { $verified = $verified -and (Test-Approx ([double]$snap.font.size) ([double]$operation.format.fontSize) 0.1) }
      if ($null -ne $operation.format.bold) { $verified = $verified -and (([int]$snap.font.bold -ne 0) -eq [bool]$operation.format.bold) }
      if ($null -ne $operation.format.italic) { $verified = $verified -and (([int]$snap.font.italic -ne 0) -eq [bool]$operation.format.italic) }
      if ($null -ne $operation.format.alignment) {
        $map = @{left=0; center=1; right=2; justify=3}
        $verified = $verified -and ([int]$snap.paragraph.alignment -eq [int]$map[[string]$operation.format.alignment])
      }
      $receipt = @{scope='paragraphs'; startParagraph=$startParagraph; endParagraph=$endParagraph; start=[int]$range.Start; end=[int]$range.End}
    }
    'word_replace_paragraph' {
      $paragraphIndex = [int]$operation.paragraph
      $paragraphRange = Get-WordParagraphRange $doc $paragraphIndex $paragraphIndex
      $contentRange = $paragraphRange.Duplicate
      if ($contentRange.End -gt $contentRange.Start) { $contentRange.End = $contentRange.End - 1 }
      $replacement = [string]$operation.text
      if ($replacement -match "[\r\n]") { throw 'word_replace_paragraph accepts one paragraph only; newline characters are not allowed.' }
      $start = [int]$contentRange.Start
      $contentRange.Text = $replacement
      $verifyRange = $doc.Range($start, $start + $replacement.Length)
      $verified = ([string]$verifyRange.Text -eq $replacement)
      $receipt = @{paragraph=$paragraphIndex; start=$start; end=($start + $replacement.Length); characters=$replacement.Length}
    }
    'word_page_setup' {
      $scope = [string]$operation.scope
      if ($scope -eq 'document') {
        foreach ($section in $doc.Sections) { Set-WordPage $word $section.PageSetup $operation.page }
      } else {
        Set-WordPage $word $word.Selection.Sections.Item(1).PageSetup $operation.page
      }
      $page = $word.Selection.Sections.Item(1).PageSetup
      $verified = $true
      if ($null -ne $operation.page.topMarginCm) { $verified = $verified -and (Test-Approx ([double]$page.TopMargin) ([double]$word.CentimetersToPoints([double]$operation.page.topMarginCm)) 0.75) }
      if ($null -ne $operation.page.bottomMarginCm) { $verified = $verified -and (Test-Approx ([double]$page.BottomMargin) ([double]$word.CentimetersToPoints([double]$operation.page.bottomMarginCm)) 0.75) }
      if ($null -ne $operation.page.leftMarginCm) { $verified = $verified -and (Test-Approx ([double]$page.LeftMargin) ([double]$word.CentimetersToPoints([double]$operation.page.leftMarginCm)) 0.75) }
      if ($null -ne $operation.page.rightMarginCm) { $verified = $verified -and (Test-Approx ([double]$page.RightMargin) ([double]$word.CentimetersToPoints([double]$operation.page.rightMarginCm)) 0.75) }
      if ($null -ne $operation.page.orientation) { $verified = $verified -and ([int]$page.Orientation -eq $(if ([string]$operation.page.orientation -eq 'landscape') {1} else {0})) }
      if ($null -ne $operation.page.paperSize) { $verified = $verified -and ([int]$page.PaperSize -eq $(if ([string]$operation.page.paperSize -eq 'LETTER') {2} else {7})) }
      $receipt = @{scope=$scope; sectionCount=[int]$doc.Sections.Count}
    }
    'word_save' {
      $doc.Save()
      $verified = [bool]$doc.Saved
      $receipt = @{saved=[bool]$doc.Saved}
    }
    default { throw "Unsupported Word live operation: $type" }
  }
  return @{ok=$true; verified=[bool]$verified; receipt=$receipt; path=[string]$doc.FullName; name=[string]$doc.Name; saved=[bool]$doc.Saved}
}

function Get-ExcelRange($excel, $sheet, $target) {
  $address = $null
  try { $address = [string]$target.address } catch {}
  if ([string]::IsNullOrWhiteSpace($address)) { return $excel.Selection }
  return $sheet.Range($address)
}

function Get-ExcelRangeSnapshot($range) {
  $cells = @()
  $count = [double]$range.Cells.CountLarge
  if ($count -le 400) {
    foreach ($cell in $range.Cells) {
      $cells += @{address=[string]$cell.Address($false,$false); value=$cell.Value2; formula=[string]$cell.Formula; text=[string]$cell.Text}
    }
  }
  return @{
    address = [string]$range.Address($false,$false)
    rowCount = [int]$range.Rows.Count
    columnCount = [int]$range.Columns.Count
    cellCount = $count
    truncated = ($count -gt 400)
    cells = $cells
    format = @{
      fontName = [string]$range.Font.Name
      fontSize = [double]$range.Font.Size
      bold = [bool]$range.Font.Bold
      italic = [bool]$range.Font.Italic
      numberFormat = [string]$range.NumberFormat
      horizontalAlignment = $range.HorizontalAlignment
      verticalAlignment = $range.VerticalAlignment
      wrapText = [bool]$range.WrapText
      columnWidth = $range.ColumnWidth
      rowHeight = $range.RowHeight
    }
  }
}

function Get-ExcelInspect($Request) {
  try {
    $excel = [Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application')
    $book = $excel.ActiveWorkbook
    if ($null -eq $book) { return @{ok=$true; open=$false} }
    $sheet = $excel.ActiveSheet
    $target = @{}
    try { if ($Request.target) { $target = $Request.target } } catch {}
    $range = Get-ExcelRange $excel $sheet $target
    $snap = Get-ExcelRangeSnapshot $range
    $used = $sheet.UsedRange
    $fingerprintMaterial = @{
      path=[string]$book.FullName; sheet=[string]$sheet.Name; address=[string]$snap.address; cells=$snap.cells; format=$snap.format; saved=[bool]$book.Saved
    } | ConvertTo-Json -Depth 10 -Compress
    return @{
      ok=$true; open=$true; application='excel'; path=[string]$book.FullName; name=[string]$book.Name; saved=[bool]$book.Saved;
      sheet=[string]$sheet.Name; selection=Get-ExcelRangeSnapshot $excel.Selection; target=$snap;
      usedRange=@{address=[string]$used.Address($false,$false); rows=[int]$used.Rows.Count; columns=[int]$used.Columns.Count};
      fingerprint=Get-Sha256Text $fingerprintMaterial
    }
  } catch { return @{ok=$true; open=$false; error=$_.Exception.Message} }
}

function Set-ExcelFormat($range, $format) {
  if ($null -ne $format.fontName) { $range.Font.Name = [string]$format.fontName }
  if ($null -ne $format.fontSize) { $range.Font.Size = [double]$format.fontSize }
  if ($null -ne $format.bold) { $range.Font.Bold = [bool]$format.bold }
  if ($null -ne $format.italic) { $range.Font.Italic = [bool]$format.italic }
  if ($null -ne $format.numberFormat) { $range.NumberFormat = [string]$format.numberFormat }
  if ($null -ne $format.horizontalAlignment) {
    $map = @{general=1; left=-4131; center=-4108; right=-4152; fill=5; justify=-4130; centerAcrossSelection=7; distributed=-4117}
    $range.HorizontalAlignment = $map[[string]$format.horizontalAlignment]
  }
  if ($null -ne $format.verticalAlignment) {
    $map = @{top=-4160; center=-4108; bottom=-4107; justify=-4130; distributed=-4117}
    $range.VerticalAlignment = $map[[string]$format.verticalAlignment]
  }
  if ($null -ne $format.wrapText) { $range.WrapText = [bool]$format.wrapText }
  if ([bool]$format.autofitColumns) { $range.Columns.AutoFit() | Out-Null }
  if ([bool]$format.autofitRows) { $range.Rows.AutoFit() | Out-Null }
}

function Apply-ExcelOperation($operation) {
  $excel = [Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application')
  $book = $excel.ActiveWorkbook
  if ($null -eq $book) { throw 'Excel has no active workbook.' }
  $sheet = $excel.ActiveSheet
  $type = [string]$operation.type
  $verified = $false
  $receipt = @{}
  switch ($type) {
    'excel_set_range' {
      $address = $null; try { $address = [string]$operation.address } catch {}
      $base = if ([string]::IsNullOrWhiteSpace($address)) { $excel.Selection } else { $sheet.Range($address) }
      $rows = @($operation.values).Count
      $cols = @($operation.values[0]).Count
      if ($rows -lt 1 -or $cols -lt 1 -or ($rows * $cols) -gt 2000) { throw 'Excel set_range dimensions are invalid.' }
      if ([double]$base.Cells.CountLarge -eq 1) { $range = $base.Resize($rows, $cols) }
      else {
        if ([int]$base.Rows.Count -ne $rows -or [int]$base.Columns.Count -ne $cols) { throw 'Excel target range dimensions do not match values matrix.' }
        $range = $base
      }
      for ($r = 1; $r -le $rows; $r++) {
        for ($c = 1; $c -le $cols; $c++) { $range.Cells.Item($r,$c).Value2 = $operation.values[$r-1][$c-1] }
      }
      $verified = $true
      for ($r = 1; $r -le $rows; $r++) {
        for ($c = 1; $c -le $cols; $c++) {
          $actual = $range.Cells.Item($r,$c).Value2
          $expected = $operation.values[$r-1][$c-1]
          if ([string]$actual -ne [string]$expected) { $verified = $false }
        }
      }
      $receipt = @{address=[string]$range.Address($false,$false); rows=$rows; columns=$cols}
    }
    'excel_set_formula' {
      $address = $null; try { $address = [string]$operation.address } catch {}
      $range = if ([string]::IsNullOrWhiteSpace($address)) { $excel.Selection } else { $sheet.Range($address) }
      $range.Formula = [string]$operation.formula
      $verified = ([string]$range.Formula -eq [string]$operation.formula)
      $receipt = @{address=[string]$range.Address($false,$false)}
    }
    'excel_format_range' {
      $address = $null; try { $address = [string]$operation.address } catch {}
      $range = if ([string]::IsNullOrWhiteSpace($address)) { $excel.Selection } else { $sheet.Range($address) }
      Set-ExcelFormat $range $operation.format
      $verified = $true
      if ($null -ne $operation.format.fontName) { $verified = $verified -and ([string]$range.Font.Name -eq [string]$operation.format.fontName) }
      if ($null -ne $operation.format.fontSize) { $verified = $verified -and (Test-Approx ([double]$range.Font.Size) ([double]$operation.format.fontSize) 0.1) }
      if ($null -ne $operation.format.bold) { $verified = $verified -and ([bool]$range.Font.Bold -eq [bool]$operation.format.bold) }
      if ($null -ne $operation.format.italic) { $verified = $verified -and ([bool]$range.Font.Italic -eq [bool]$operation.format.italic) }
      if ($null -ne $operation.format.numberFormat) { $verified = $verified -and ([string]$range.NumberFormat -eq [string]$operation.format.numberFormat) }
      if ($null -ne $operation.format.wrapText) { $verified = $verified -and ([bool]$range.WrapText -eq [bool]$operation.format.wrapText) }
      $receipt = @{address=[string]$range.Address($false,$false)}
    }
    'excel_save' {
      $book.Save()
      $verified = [bool]$book.Saved
      $receipt = @{saved=[bool]$book.Saved}
    }
    default { throw "Unsupported Excel live operation: $type" }
  }
  return @{ok=$true; verified=[bool]$verified; receipt=$receipt; path=[string]$book.FullName; name=[string]$book.Name; sheet=[string]$sheet.Name; saved=[bool]$book.Saved}
}

function Get-PowerPointSelectionSnapshot($powerpoint, $slide) {
  $selected = @()
  $selectionType = 0
  $selectedText = ''
  try {
    $selection = $powerpoint.ActiveWindow.Selection
    $selectionType = [int]$selection.Type
    if ($selectionType -eq 2) {
      $limit = [Math]::Min([int]$selection.ShapeRange.Count, 50)
      for ($i=1; $i -le $limit; $i++) {
        $shape = $selection.ShapeRange.Item($i)
        $text = ''
        try { if ($shape.HasTextFrame -and $shape.TextFrame.HasText) { $text = [string]$shape.TextFrame.TextRange.Text } } catch {}
        $selected += @{name=[string]$shape.Name; text=Limit-Text $text 8000; left=[double]$shape.Left; top=[double]$shape.Top; width=[double]$shape.Width; height=[double]$shape.Height}
      }
    } elseif ($selectionType -eq 3) {
      try { $selectedText = [string]$selection.TextRange.Text } catch {}
    }
  } catch {}
  return @{type=$selectionType; text=Limit-Text $selectedText 12000; shapes=$selected}
}

function Get-PowerPointInspect($Request) {
  try {
    $powerpoint = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')
    $deck = $powerpoint.ActivePresentation
    if ($null -eq $deck) { return @{ok=$true; open=$false} }
    $slide = $powerpoint.ActiveWindow.View.Slide
    $slideText = @()
    $shapeLimit = [Math]::Min([int]$slide.Shapes.Count, 100)
    for ($i=1; $i -le $shapeLimit; $i++) {
      $shape = $slide.Shapes.Item($i)
      $text = ''
      try { if ($shape.HasTextFrame -and $shape.TextFrame.HasText) { $text = [string]$shape.TextFrame.TextRange.Text } } catch {}
      if ($text) { $slideText += @{name=[string]$shape.Name; text=Limit-Text $text 8000} }
    }
    $selection = Get-PowerPointSelectionSnapshot $powerpoint $slide
    $fingerprintMaterial = @{path=[string]$deck.FullName; slide=[int]$slide.SlideIndex; selection=$selection; saved=[bool]$deck.Saved} | ConvertTo-Json -Depth 10 -Compress
    return @{
      ok=$true; open=$true; application='powerpoint'; path=[string]$deck.FullName; name=[string]$deck.Name; saved=[bool]$deck.Saved;
      slideIndex=[int]$slide.SlideIndex; slideCount=[int]$deck.Slides.Count; slideText=$slideText; selection=$selection; target=$selection;
      fingerprint=Get-Sha256Text $fingerprintMaterial
    }
  } catch { return @{ok=$true; open=$false; error=$_.Exception.Message} }
}

function Get-PowerPointTargetTextRange($powerpoint) {
  $selection = $powerpoint.ActiveWindow.Selection
  if ([int]$selection.Type -eq 3) { return $selection.TextRange }
  if ([int]$selection.Type -eq 2 -and [int]$selection.ShapeRange.Count -eq 1) {
    $shape = $selection.ShapeRange.Item(1)
    if ($shape.HasTextFrame -and $shape.TextFrame.HasText) { return $shape.TextFrame.TextRange }
  }
  throw 'Select text or exactly one text shape in PowerPoint.'
}

function Apply-PowerPointOperation($operation) {
  $powerpoint = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')
  $deck = $powerpoint.ActivePresentation
  if ($null -eq $deck) { throw 'PowerPoint has no active presentation.' }
  $type = [string]$operation.type
  $verified = $false
  $receipt = @{}
  switch ($type) {
    'powerpoint_replace_selected_text' {
      $range = Get-PowerPointTargetTextRange $powerpoint
      $range.Text = [string]$operation.text
      $verified = ([string]$range.Text -eq [string]$operation.text)
      $receipt = @{characters=([string]$operation.text).Length}
    }
    'powerpoint_format_selected_text' {
      $range = Get-PowerPointTargetTextRange $powerpoint
      $format = $operation.format
      if ($null -ne $format.fontName) { $range.Font.Name = [string]$format.fontName }
      if ($null -ne $format.fontSize) { $range.Font.Size = [double]$format.fontSize }
      if ($null -ne $format.bold) { $range.Font.Bold = $(if ([bool]$format.bold) { -1 } else { 0 }) }
      if ($null -ne $format.italic) { $range.Font.Italic = $(if ([bool]$format.italic) { -1 } else { 0 }) }
      if ($null -ne $format.alignment) {
        $map = @{left=1; center=2; right=3; justify=4}
        $range.ParagraphFormat.Alignment = [int]$map[[string]$format.alignment]
      }
      $verified = $true
      if ($null -ne $format.fontName) { $verified = $verified -and ([string]$range.Font.Name -eq [string]$format.fontName) }
      if ($null -ne $format.fontSize) { $verified = $verified -and (Test-Approx ([double]$range.Font.Size) ([double]$format.fontSize) 0.1) }
      $receipt = @{formatted=$true}
    }
    'powerpoint_set_selected_shape_geometry' {
      $selection = $powerpoint.ActiveWindow.Selection
      if ([int]$selection.Type -ne 2 -or [int]$selection.ShapeRange.Count -ne 1) { throw 'Select exactly one PowerPoint shape before changing geometry.' }
      $shape = $selection.ShapeRange.Item(1)
      if ($null -ne $operation.leftPt) { $shape.Left = [double]$operation.leftPt }
      if ($null -ne $operation.topPt) { $shape.Top = [double]$operation.topPt }
      if ($null -ne $operation.widthPt) { $shape.Width = [double]$operation.widthPt }
      if ($null -ne $operation.heightPt) { $shape.Height = [double]$operation.heightPt }
      $verified = $true
      if ($null -ne $operation.leftPt) { $verified = $verified -and (Test-Approx ([double]$shape.Left) ([double]$operation.leftPt) 0.2) }
      if ($null -ne $operation.topPt) { $verified = $verified -and (Test-Approx ([double]$shape.Top) ([double]$operation.topPt) 0.2) }
      if ($null -ne $operation.widthPt) { $verified = $verified -and (Test-Approx ([double]$shape.Width) ([double]$operation.widthPt) 0.2) }
      if ($null -ne $operation.heightPt) { $verified = $verified -and (Test-Approx ([double]$shape.Height) ([double]$operation.heightPt) 0.2) }
      $receipt = @{shape=[string]$shape.Name; left=[double]$shape.Left; top=[double]$shape.Top; width=[double]$shape.Width; height=[double]$shape.Height}
    }
    'powerpoint_save' {
      $deck.Save()
      $verified = [bool]$deck.Saved
      $receipt = @{saved=[bool]$deck.Saved}
    }
    default { throw "Unsupported PowerPoint live operation: $type" }
  }
  return @{ok=$true; verified=[bool]$verified; receipt=$receipt; path=[string]$deck.FullName; name=[string]$deck.Name; saved=[bool]$deck.Saved}
}

switch ($Action) {
  '__load_functions_only__' { }
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
  'word_documents_list' {
    try {
      $existingWord = [Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')
      $openedPaths = @()
      foreach ($openedDoc in $existingWord.Documents) {
        if ($openedPaths.Count -ge 200) { break }
        try { $openedPaths += [string]$openedDoc.FullName } catch {}
      }
      @{ok=$true;paths=@($openedPaths)} | ConvertTo-Json -Depth 4 -Compress
    } catch { @{ok=$true;paths=@()} | ConvertTo-Json -Compress }
  }
  'word_document_status' {
    try {
      $word = [Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')
      $doc = $word.ActiveDocument
      if ($null -eq $doc) { @{ok=$true; open=$false} | ConvertTo-Json -Compress; break }
      @{ok=$true; open=$true; path=[string]$doc.FullName; saved=[bool]$doc.Saved; name=[string]$doc.Name} | ConvertTo-Json -Compress
    } catch { @{ok=$true; open=$false} | ConvertTo-Json -Compress }
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
    $out = Get-WordInspect @{target=@{scope='selection'}; contextChars=0}
    if ($out.open) {
      @{ok=$true; open=$true; path=$out.path; name=$out.name; saved=$out.saved; selection=$out.selection} | ConvertTo-Json -Depth 8 -Compress
    } else { $out | ConvertTo-Json -Depth 8 -Compress }
  }
  'word_selection_replace' {
    (Apply-WordOperation @{type='replace_selection'; text=[string]$payload.text}) | ConvertTo-Json -Depth 8 -Compress
  }
  'excel_selection_read' {
    $out = Get-ExcelInspect @{target=@{}}
    if ($out.open) {
      @{ok=$true; open=$true; path=$out.path; name=$out.name; saved=$out.saved; sheet=$out.sheet; selection=$out.selection} | ConvertTo-Json -Depth 9 -Compress
    } else { $out | ConvertTo-Json -Depth 8 -Compress }
  }
  'powerpoint_selection_read' {
    $out = Get-PowerPointInspect @{}
    if ($out.open) {
      @{ok=$true; open=$true; path=$out.path; name=$out.name; saved=$out.saved; slideIndex=$out.slideIndex; slideText=$out.slideText; selectedShapes=$out.selection.shapes; selection=$out.selection} | ConvertTo-Json -Depth 9 -Compress
    } else { $out | ConvertTo-Json -Depth 8 -Compress }
  }
  'word_inspect' { (Get-WordInspect $payload) | ConvertTo-Json -Depth 10 -Compress }
  'word_apply' { (Apply-WordOperation $payload.operation) | ConvertTo-Json -Depth 10 -Compress }
  'excel_inspect' { (Get-ExcelInspect $payload) | ConvertTo-Json -Depth 10 -Compress }
  'excel_apply' { (Apply-ExcelOperation $payload.operation) | ConvertTo-Json -Depth 10 -Compress }
  'powerpoint_inspect' { (Get-PowerPointInspect $payload) | ConvertTo-Json -Depth 10 -Compress }
  'powerpoint_apply' { (Apply-PowerPointOperation $payload.operation) | ConvertTo-Json -Depth 10 -Compress }
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
      ok=$true; entryId=[string]$item.EntryID; subject=[string]$item.Subject; sender=[string]$item.SenderName;
      senderEmail=[string]$item.SenderEmailAddress; received=$item.ReceivedTime.ToString('o'); to=[string]$item.To; cc=[string]$item.CC;
      body=$body; attachments=$attachments
    } | ConvertTo-Json -Depth 4 -Compress
  }
  default { throw "Unsupported Office action: $Action" }
}
