/**
 * Recycle Bin disposal (FOF_ALLOWUNDO) — shell32 SHFileOperationW via koffi.
 *
 * ADR-0007: no action in the station feature permanently deletes a file; the
 * worst case is a Recycle Bin copy. Deleting an in-transit entry (or
 * completing a staged move) sends the held files here instead of unlinking
 * them. SHFileOperationW handles files and directories in one call and
 * supports the undo flag; koffi keeps shell32 resident in-process (same
 * pattern as fullscreen.ts / keyboardHook.ts).
 */
import koffi from 'koffi'

const FO_DELETE = 0x0003
const FOF_ALLOWUNDO = 0x0040
const FOF_NOCONFIRMATION = 0x0010
const FOF_NOERRORUI = 0x0400
const FOF_SILENT = 0x0004

/** SHFILEOPSTRUCTW — layout follows the Windows SDK (x64: 56 bytes). */
const SHFILEOPSTRUCTW = koffi.struct('SHFILEOPSTRUCTW', {
  hwnd: 'void *',
  wFunc: 'uint32_t',
  pFrom: 'void *',
  pTo: 'void *',
  fFlags: 'uint16_t',
  fAnyOperationsAborted: 'int32_t',
  hNameMappings: 'void *',
  lpszProgressTitle: 'void *'
})

type ShFileOperationFn = (ops: unknown) => number
let shFileOperationW: ShFileOperationFn | null = null
if (process.platform === 'win32') {
  try {
    const shell32 = koffi.load('shell32.dll')
    shFileOperationW = shell32.func('SHFileOperationW', 'int', [koffi.pointer(SHFILEOPSTRUCTW)]) as ShFileOperationFn
    console.log('[RecycleBin] SHFileOperationW loaded via koffi')
  } catch (err) {
    console.error('[RecycleBin] koffi shell32 load failed — recycle-bin disposal disabled:', err)
  }
}

/** Double-null-terminated UTF-16 path list (PCZZWSTR). */
function buildMultiSz(paths: string[]): Buffer {
  const parts = paths.map((p) => Buffer.from(p + '\0', 'utf16le'))
  return Buffer.concat([...parts, Buffer.from('\0', 'utf16le')])
}

/**
 * Move the given files/directories to the Recycle Bin (undo enabled, silent,
 * no confirmation or error dialogs). Returns false when the operation failed
 * or koffi is unavailable — callers must then keep their state unchanged so
 * the user can retry (ADR-0007: nothing is ever permanently deleted).
 */
export function disposeToRecycleBin(paths: string[]): boolean {
  if (paths.length === 0) return true
  if (!shFileOperationW) return false
  try {
    const ops = {
      hwnd: null,
      wFunc: FO_DELETE,
      pFrom: koffi.as(buildMultiSz(paths), 'void *'),
      pTo: null,
      fFlags: FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT,
      fAnyOperationsAborted: 0,
      hNameMappings: null,
      lpszProgressTitle: null
    }
    const rc = shFileOperationW(ops)
    if (rc !== 0) {
      console.error(`[RecycleBin] SHFileOperationW failed rc=${rc}, aborted=${ops.fAnyOperationsAborted}, paths=${JSON.stringify(paths)}`)
      return false
    }
    return true
  } catch (err) {
    console.error('[RecycleBin] dispose failed:', err)
    return false
  }
}
