/**
 * OCR pipeline (t30) — Windows.Media.Ocr (WinRT, offline, zh-capable) through
 * the persistent PowerShell channel.
 *
 * Product = foreground-window screenshot text, fed to the suggestion engine
 * as ocrContext for the LLM annotation (AI material only — never stored,
 * never shown in the UI). Runs only when an analysis triggers; a single
 * attempt with a hard timeout; silent degradation keeps the task system
 * untouched on any failure.
 *
 * Privacy: the whole pipeline is gated on the three capture switches
 * (task-capture master / L0 / incognito). Log lines never carry OCR text —
 * only a character count, so screen content can't leak into logs.
 */
import koffi from 'koffi'
import { psHost } from './powershell'
import { loadSettings } from './state'
import type { Settings } from '../../shared/types'

const OCR_TIMEOUT_MS = 10_000
const OCR_MAX_BYTES = 2_048

/**
 * Clip text to a UTF-8 byte budget without splitting a multi-byte character
 * (the prompt budget is a byte limit; a mid-codepoint cut would garble CJK).
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  const max = Math.max(0, Math.floor(maxBytes))
  if (Buffer.byteLength(text, 'utf8') <= max) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= max) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo)
}

/**
 * The PS script emits UTF-8 bytes base64-encoded so the pipe encoding can
 * never mangle CJK text. Anything that doesn't look like base64 (e.g. a PS
 * error line) is rejected — Node's base64 decoder is lenient and would
 * otherwise turn garbage into mojibake that lands in the LLM prompt.
 */
export function decodeOcrOutput(raw: string): string {
  const t = raw.trim()
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(t)) return ''
  try {
    return truncateUtf8(Buffer.from(t, 'base64').toString('utf8'), OCR_MAX_BYTES)
  } catch {
    return ''
  }
}

/** OCR must respect all three privacy switches; any one off = no capture. */
export function isOcrAllowed(
  settings: Pick<Settings, 'taskCaptureEnabled' | 'l0CaptureEnabled' | 'incognito'>
): boolean {
  return settings.taskCaptureEnabled && settings.l0CaptureEnabled && !settings.incognito
}

export interface ScreenRect {
  left: number
  top: number
  right: number
  bottom: number
}

// ---- koffi Win32 glue (same pattern as foreground.ts) ----------------------

type GetForegroundWindowFn = () => unknown
type GetWindowRectFn = (hwnd: unknown, rect: number[]) => number

let getForegroundWindow: GetForegroundWindowFn | null = null
let getWindowRect: GetWindowRectFn | null = null

if (process.platform === 'win32') {
  try {
    const user32 = koffi.load('user32.dll')
    getForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()')
    getWindowRect = user32.func('int __stdcall GetWindowRect(void *hWnd, _Out_ int32_t *lpRect)')
  } catch (err) {
    console.error('[Ocr] koffi Win32 load failed — OCR disabled:', err)
  }
}

/** Foreground window bounds in virtual-screen pixels; null when unavailable. */
export function queryForegroundRect(): ScreenRect | null {
  if (!getForegroundWindow || !getWindowRect) return null
  let hwnd: unknown
  try {
    hwnd = getForegroundWindow()
  } catch {
    return null
  }
  if (!hwnd) return null
  const rect = [0, 0, 0, 0]
  try {
    if (!getWindowRect(hwnd, rect)) return null
  } catch {
    return null
  }
  const [left, top, right, bottom] = rect
  const width = right - left
  const height = bottom - top
  // Minimized windows report their icon rect at (-32000, -32000); anything
  // degenerate or off-screen is not worth capturing.
  if (width <= 0 || height <= 0 || left < -10000 || top < -10000) return null
  return { left, top, right, bottom }
}

/**
 * PS 5.1 WinRT interop: System.Drawing screenshot -> PNG stream ->
 * BitmapDecoder -> SoftwareBitmap (BGRA8 premultiplied, the only format
 * OcrEngine accepts) -> Windows.Media.Ocr, zh-Hans preferred. Any step
 * failing prints '' so main sees "no OCR" instead of an error.
 */
export function buildOcrScript(rect: ScreenRect): string {
  // Single-line body: the persistent PS session reads stdin line by line, and
  // multi-line blocks have proven unreliable there — every statement is joined
  // with ';' and braces blocks stay on one line.
  return `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
Add-Type -AssemblyName System.Drawing;
Add-Type -AssemblyName System.Runtime.WindowsRuntime;

$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime];
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime];
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType=WindowsRuntime];
$null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType=WindowsRuntime];
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime];
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0];
function Await($WinRtTask, $ResultType) { $asTask = $asTaskGeneric.MakeGenericMethod($ResultType); $netTask = $asTask.Invoke($null, @($WinRtTask)); $netTask.Wait(-1) | Out-Null; $netTask.Result }
$width = [int](${rect.right} - ${rect.left});
$height = [int](${rect.bottom} - ${rect.top});
if ($width -le 0 -or $height -le 0) { Write-Output ''; exit 0 }
$bmp = New-Object System.Drawing.Bitmap($width, $height);
$g = [System.Drawing.Graphics]::FromImage($bmp);

try { $g.CopyFromScreen(${rect.left}, ${rect.top}, 0, 0, $bmp.Size) } catch { $g.Dispose(); $bmp.Dispose(); Write-Output ''; exit 0 }
$g.Dispose();
$stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream;
try { $bmp.Save([System.IO.WindowsRuntimeStreamExtensions]::AsStream($stream), [System.Drawing.Imaging.ImageFormat]::Png) } catch { $bmp.Dispose(); $stream.Dispose(); Write-Output ''; exit 0 }
$bmp.Dispose();

$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder]);
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap]);

if ($bitmap.BitmapPixelFormat -ne [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8 -or $bitmap.BitmapAlphaMode -ne [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied) { $converted = [Windows.Graphics.Imaging.SoftwareBitmap]::Convert($bitmap, [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied); $bitmap.Dispose(); $bitmap = $converted }
$lang = New-Object Windows.Globalization.Language('zh-Hans');

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang);
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if (-not $engine) { $bitmap.Dispose(); Write-Output ''; exit 0 }

$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult]);

$text = [string]$result.Text;
$bitmap.Dispose();
[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($text))`
}

/**
 * One OCR attempt on the foreground window; null on any failure (privacy
 * gate closed, no window, timeout, decode error). Never throws.
 */
export async function ocrFromForeground(): Promise<string | null> {
  if (!isOcrAllowed(loadSettings())) return null
  const rect = queryForegroundRect()
  if (!rect) return null
  try {
    const raw = await psHost.runOutput(buildOcrScript(rect), OCR_TIMEOUT_MS)
    const text = decodeOcrOutput(raw)
    if (text.length === 0) return null
    console.log(`[Ocr] captured ${text.length} chars from foreground window`)
    return text
  } catch (err) {
    console.log(`[Ocr] capture failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
