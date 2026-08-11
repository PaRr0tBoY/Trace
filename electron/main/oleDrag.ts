/**
 * Native OLE text drag-out (ADR-0007, Ticket 4).
 *
 * The panel window is transparent/frameless, which disables the DWM-native
 * HTML5 drag-out on Windows, so text can never leave the app through the
 * renderer (files/images use webContents.startDrag instead, see drag.ts).
 * Text drags therefore run as a real OLE drag from the main process: we
 * implement a minimal in-memory IDataObject (CF_UNICODETEXT backed by a
 * moveable HGLOBAL), IDropSource and IEnumFORMATETC, and block inside
 * DoDragDrop for the whole gesture. OLE shows the default drag cursor — no
 * ghost image, an accepted design decision.
 *
 * The koffi glue mirrors electron/main/foreground.ts: loaded once at module
 * scope and degraded on failure, so startTextOleDrag returns false and the
 * caller can fall back to the old temp-file path. It never throws.
 */
import koffi from 'koffi'

/* ------------------------------------------------------------------ */
/* COM / Win32 constants                                               */
/* ------------------------------------------------------------------ */

const S_OK = 0
const S_FALSE = 1
const E_NOTIMPL = 0x80004001
const E_NOINTERFACE = 0x80004002
const DV_E_FORMATETC = 0x80040064
const DRAGDROP_S_DROP = 0x00040100
const DRAGDROP_S_CANCEL = 0x00040101
const DRAGDROP_S_USEDEFAULTCURSORS = 0x00040102

const CF_UNICODETEXT = 13
const TYMED_HGLOBAL = 1
const DVASPECT_CONTENT = 1
const DATADIR_GET = 1
const GMEM_MOVEABLE = 0x0002
const DROPEFFECT_COPY = 1
const DROPEFFECT_MOVE = 2
const MK_LBUTTON = 0x0001
const MK_RBUTTON = 0x0002

/* ------------------------------------------------------------------ */
/* koffi type declarations (pure, valid on every platform)             */
/* ------------------------------------------------------------------ */

// x64 default alignment reproduces the C layouts (STGMEDIUM / FORMATETC).
const OleStgMedium = koffi.struct('OleStgMedium', {
  tymed: 'uint32_t',
  hGlobal: 'void *',
  pUnkForRelease: 'void *'
})
const OleFormatEtc = koffi.struct('OleFormatEtc', {
  cfFormat: 'uint32_t',
  ptd: 'void *',
  dwAspect: 'uint32_t',
  lindex: 'int32_t',
  tymed: 'uint32_t'
})

// One prototype per COM method; `self` is the COM `this` pointer and every
// vtable method receives it first. `__stdcall` is cosmetic on x64 but kept.
const OleQueryInterface = koffi.proto('int __stdcall Ole_QueryInterface(void *self, void *riid, void *ppv)')
const OleAddRef = koffi.proto('uint32_t __stdcall Ole_AddRef(void *self)')
const OleRelease = koffi.proto('uint32_t __stdcall Ole_Release(void *self)')
const OleGetData = koffi.proto('int __stdcall Ole_GetData(void *self, void *pFormatetc, void *pMedium)')
const OleGetDataHere = koffi.proto('int __stdcall Ole_GetDataHere(void *self, void *pFormatetc, void *pMedium)')
const OleQueryGetData = koffi.proto('int __stdcall Ole_QueryGetData(void *self, void *pFormatetc)')
const OleGetCanonicalFormatEtc = koffi.proto('int __stdcall Ole_GetCanonicalFormatEtc(void *self, void *pFormatetcIn, void *pFormatetcOut)')
const OleSetData = koffi.proto('int __stdcall Ole_SetData(void *self, void *pFormatetc, void *pMedium, int fRelease)')
const OleEnumFormatEtc = koffi.proto('int __stdcall Ole_EnumFormatEtc(void *self, uint32_t dwDirection, void *ppEnumFormatEtc)')
const OleDAdvise = koffi.proto('int __stdcall Ole_DAdvise(void *self, void *pFormatetc, uint32_t advf, void *pAdvSink, void *pdwConnection)')
const OleDUnadvise = koffi.proto('int __stdcall Ole_DUnadvise(void *self, uint32_t dwConnection)')
const OleEnumDAdvise = koffi.proto('int __stdcall Ole_EnumDAdvise(void *self, void *ppEnumAdvise)')
const OleQueryContinueDrag = koffi.proto('int __stdcall Ole_QueryContinueDrag(void *self, int fEscapePressed, uint32_t grfKeyState)')
const OleGiveFeedback = koffi.proto('int __stdcall Ole_GiveFeedback(void *self, uint32_t dwEffect)')
const OleNext = koffi.proto('int __stdcall Ole_Next(void *self, uint32_t celt, void *pFormatetc, void *pceltFetched)')
const OleSkip = koffi.proto('int __stdcall Ole_Skip(void *self, uint32_t celt)')
const OleReset = koffi.proto('int __stdcall Ole_Reset(void *self)')
const OleClone = koffi.proto('int __stdcall Ole_Clone(void *self, void *ppEnum)')

// Vtables + COM objects: lpVtbl points at the vtable, whose slots are the
// registered callback pointers. Field order is the COM vtable order.
const OleIDataObjectVtbl = koffi.struct('OleIDataObjectVtbl', {
  QueryInterface: koffi.pointer(OleQueryInterface),
  AddRef: koffi.pointer(OleAddRef),
  Release: koffi.pointer(OleRelease),
  GetData: koffi.pointer(OleGetData),
  GetDataHere: koffi.pointer(OleGetDataHere),
  QueryGetData: koffi.pointer(OleQueryGetData),
  GetCanonicalFormatEtc: koffi.pointer(OleGetCanonicalFormatEtc),
  SetData: koffi.pointer(OleSetData),
  EnumFormatEtc: koffi.pointer(OleEnumFormatEtc),
  DAdvise: koffi.pointer(OleDAdvise),
  DUnadvise: koffi.pointer(OleDUnadvise),
  EnumDAdvise: koffi.pointer(OleEnumDAdvise)
})
const OleIDropSourceVtbl = koffi.struct('OleIDropSourceVtbl', {
  QueryInterface: koffi.pointer(OleQueryInterface),
  AddRef: koffi.pointer(OleAddRef),
  Release: koffi.pointer(OleRelease),
  QueryContinueDrag: koffi.pointer(OleQueryContinueDrag),
  GiveFeedback: koffi.pointer(OleGiveFeedback)
})
const OleIEnumVtbl = koffi.struct('OleIEnumVtbl', {
  QueryInterface: koffi.pointer(OleQueryInterface),
  AddRef: koffi.pointer(OleAddRef),
  Release: koffi.pointer(OleRelease),
  Next: koffi.pointer(OleNext),
  Skip: koffi.pointer(OleSkip),
  Reset: koffi.pointer(OleReset),
  Clone: koffi.pointer(OleClone)
})

const OleDataObject = koffi.struct('OleDataObject', { lpVtbl: koffi.pointer(OleIDataObjectVtbl) })
const OleDropSource = koffi.struct('OleDropSource', { lpVtbl: koffi.pointer(OleIDropSourceVtbl) })
const OleEnumObject = koffi.struct('OleEnumObject', { lpVtbl: koffi.pointer(OleIEnumVtbl) })

const VoidPtr = koffi.pointer('void')

/* ------------------------------------------------------------------ */
/* koffi Win32 glue (loaded once; drags degrade to a no-op on failure) */
/* ------------------------------------------------------------------ */

type OleInitializeFn = (pvReserved: null) => number
type OleUninitializeFn = () => void
type DoDragDropFn = (pDataObj: bigint, pDropSource: bigint, dwOKEffects: number, pdwEffect: number[]) => number
type GlobalAllocFn = (uFlags: number, dwBytes: number) => bigint
type GlobalLockFn = (hMem: bigint) => bigint
type GlobalUnlockFn = (hMem: bigint) => number
type GlobalFreeFn = (hMem: bigint) => bigint

let oleInitialize: OleInitializeFn | null = null
let oleUninitialize: OleUninitializeFn | null = null
let doDragDrop: DoDragDropFn | null = null
let globalAlloc: GlobalAllocFn | null = null
let globalLock: GlobalLockFn | null = null
let globalUnlock: GlobalUnlockFn | null = null
let globalFree: GlobalFreeFn | null = null

if (process.platform === 'win32') {
  try {
    const ole32 = koffi.load('ole32.dll')
    const kernel32 = koffi.load('kernel32.dll')
    oleInitialize = ole32.func('int __stdcall OleInitialize(void *pvReserved)')
    oleUninitialize = ole32.func('void __stdcall OleUninitialize()')
    doDragDrop = ole32.func('int __stdcall DoDragDrop(void *pDataObj, void *pDropSource, uint32_t dwOKEffects, _Out_ uint32_t *pdwEffect)')
    globalAlloc = kernel32.func('void * __stdcall GlobalAlloc(uint32_t uFlags, size_t dwBytes)')
    globalLock = kernel32.func('void * __stdcall GlobalLock(void *hMem)')
    globalUnlock = kernel32.func('int __stdcall GlobalUnlock(void *hMem)')
    globalFree = kernel32.func('void * __stdcall GlobalFree(void *hMem)')
  } catch (err) {
    console.error('[OleDrag] koffi load failed — text drag-out disabled:', err)
  }
}

/* ------------------------------------------------------------------ */
/* COM state (one drag at a time — DoDragDrop blocks the main process) */
/* ------------------------------------------------------------------ */

/** Text payload served by IDataObject::GetData during the current drag. */
let dragText = ''
/** IEnumFORMATETC cursor: 0 = the single CF_UNICODETEXT entry not fetched yet. */
let enumCursor = 0
/** Address of the current drag's IEnumFORMATETC object, for EnumFormatEtc. */
let enumObjAddress: bigint | null = null

let oleInitialized = false

/** OleInitialize must run once on the calling (main) thread before any drag. */
function ensureOleInitialized(): boolean {
  if (oleInitialized) return true
  if (!oleInitialize) return false
  try {
    // S_FALSE means another component already initialized OLE — also usable.
    const hr = oleInitialize(null)
    oleInitialized = hr === S_OK || hr === S_FALSE
  } catch (err) {
    console.error('[OleDrag] OleInitialize failed — text drag-out disabled:', err)
  }
  return oleInitialized
}

// Tear the COM apartment down on exit; the OS would reclaim it anyway, this
// just leaves OLE in a clean state.
process.once('exit', () => {
  if (oleInitialized && oleUninitialize) {
    try {
      oleUninitialize()
    } catch {
      /* ignore */
    }
  }
})

/* ------------------------------------------------------------------ */
/* Interface implementations (module-level, registered per drag)       */
/* ------------------------------------------------------------------ */

function cbQueryInterface(_self: bigint, _riid: bigint, _ppv: bigint): number {
  // No interface is exposed beyond the concrete object itself.
  return E_NOINTERFACE
}

function cbAddRef(_self: bigint): number {
  return 1
}

function cbRelease(_self: bigint): number {
  return 1
}

/** True when pFormatetc asks for CF_UNICODETEXT as a moveable HGLOBAL, content aspect. */
function isTextFormatEtc(pFormatetc: bigint): boolean {
  try {
    const fmt = koffi.decode(pFormatetc, OleFormatEtc)
    return (
      fmt.cfFormat === CF_UNICODETEXT &&
      (fmt.tymed & TYMED_HGLOBAL) !== 0 &&
      fmt.dwAspect === DVASPECT_CONTENT
    )
  } catch {
    return false
  }
}

function cbQueryGetData(_self: bigint, pFormatetc: bigint): number {
  return isTextFormatEtc(pFormatetc) ? S_OK : DV_E_FORMATETC
}

function cbGetData(_self: bigint, pFormatetc: bigint, pMedium: bigint): number {
  if (!pMedium) return E_NOTIMPL
  if (!isTextFormatEtc(pFormatetc)) return DV_E_FORMATETC
  if (!globalAlloc || !globalLock || !globalUnlock || !globalFree) return E_NOTIMPL

  const hGlobal = globalAlloc(GMEM_MOVEABLE, (dragText.length + 1) * 2)
  if (!hGlobal) return E_NOTIMPL

  let locked = false
  try {
    const dst = globalLock(hGlobal)
    if (!dst) throw new Error('GlobalLock failed')
    locked = true
    // CF_UNICODETEXT payload: UTF-16LE code units + NUL terminator.
    // charCodeAt() walks code units, so surrogate pairs survive intact.
    const units = new Array<number>(dragText.length + 1)
    for (let i = 0; i < dragText.length; i++) units[i] = dragText.charCodeAt(i)
    units[dragText.length] = 0
    koffi.encode(dst, 'uint16_t', units, units.length)
    koffi.encode(pMedium, OleStgMedium, { tymed: TYMED_HGLOBAL, hGlobal, pUnkForRelease: null })
    return S_OK
  } catch {
    // The medium never reached the target, so nothing will ReleaseStgMedium
    // it — free it here to avoid leaking the HGLOBAL.
    try {
      globalFree(hGlobal)
    } catch {
      /* ignore */
    }
    return E_NOTIMPL
  } finally {
    if (locked) {
      try {
        globalUnlock(hGlobal)
      } catch {
        /* ignore */
      }
    }
  }
}

function cbEnumFormatEtc(_self: bigint, dwDirection: number, ppEnum: bigint): number {
  if (dwDirection !== DATADIR_GET || !ppEnum || !enumObjAddress) return E_NOTIMPL
  koffi.encode(ppEnum, VoidPtr, enumObjAddress)
  return S_OK
}

function cbNext(_self: bigint, celt: number, pFormatetc: bigint, pceltFetched: bigint): number {
  if (celt === 0) {
    if (pceltFetched) koffi.encode(pceltFetched, 'uint32_t', 0)
    return S_OK
  }
  if (!pFormatetc) return S_FALSE
  if (enumCursor === 0) {
    koffi.encode(pFormatetc, OleFormatEtc, {
      cfFormat: CF_UNICODETEXT,
      ptd: null,
      dwAspect: DVASPECT_CONTENT,
      lindex: -1,
      tymed: TYMED_HGLOBAL
    })
    if (pceltFetched) koffi.encode(pceltFetched, 'uint32_t', 1)
    enumCursor = 1
    return S_OK
  }
  if (pceltFetched) koffi.encode(pceltFetched, 'uint32_t', 0)
  return S_FALSE
}

function cbSkip(_self: bigint, _celt: number): number {
  return S_OK
}

function cbReset(_self: bigint): number {
  enumCursor = 0
  return S_OK
}

function cbClone(_self: bigint, _ppEnum: bigint): number {
  return E_NOTIMPL
}

function cbQueryContinueDrag(_self: bigint, fEscapePressed: number, grfKeyState: number): number {
  if (fEscapePressed) return DRAGDROP_S_CANCEL
  if ((grfKeyState & MK_LBUTTON) === 0 && (grfKeyState & MK_RBUTTON) === 0) return DRAGDROP_S_DROP
  return S_OK
}

function cbGiveFeedback(_self: bigint, _dwEffect: number): number {
  return DRAGDROP_S_USEDEFAULTCURSORS
}

// Methods the interface must implement but never legitimately receives.
function cbGetDataHere(_self: bigint, _pFormatetc: bigint, _pMedium: bigint): number {
  return E_NOTIMPL
}
function cbGetCanonicalFormatEtc(_self: bigint, _pFormatetcIn: bigint, _pFormatetcOut: bigint): number {
  return E_NOTIMPL
}
function cbSetData(_self: bigint, _pFormatetc: bigint, _pMedium: bigint, _fRelease: number): number {
  return E_NOTIMPL
}
function cbDAdvise(_self: bigint, _pFormatetc: bigint, _advf: number, _pAdvSink: bigint, _pdwConnection: bigint): number {
  return E_NOTIMPL
}
function cbDUnadvise(_self: bigint, _dwConnection: number): number {
  return E_NOTIMPL
}
function cbEnumDAdvise(_self: bigint, _ppEnum: bigint): number {
  return E_NOTIMPL
}

/* ------------------------------------------------------------------ */
/* Per-drag callback registration (unregistered in a finally)          */
/* ------------------------------------------------------------------ */

interface DragCallbacks {
  queryInterface: bigint
  addRef: bigint
  release: bigint
  getData: bigint
  getDataHere: bigint
  queryGetData: bigint
  getCanonicalFormatEtc: bigint
  setData: bigint
  enumFormatEtc: bigint
  dAdvise: bigint
  dUnadvise: bigint
  enumDAdvise: bigint
  queryContinueDrag: bigint
  giveFeedback: bigint
  next: bigint
  skip: bigint
  reset: bigint
  clone: bigint
}

function registerDragCallbacks(): DragCallbacks | null {
  const cbs: Partial<DragCallbacks> = {}
  try {
    cbs.queryInterface = koffi.register(cbQueryInterface, koffi.pointer(OleQueryInterface))
    cbs.addRef = koffi.register(cbAddRef, koffi.pointer(OleAddRef))
    cbs.release = koffi.register(cbRelease, koffi.pointer(OleRelease))
    cbs.getData = koffi.register(cbGetData, koffi.pointer(OleGetData))
    cbs.getDataHere = koffi.register(cbGetDataHere, koffi.pointer(OleGetDataHere))
    cbs.queryGetData = koffi.register(cbQueryGetData, koffi.pointer(OleQueryGetData))
    cbs.getCanonicalFormatEtc = koffi.register(cbGetCanonicalFormatEtc, koffi.pointer(OleGetCanonicalFormatEtc))
    cbs.setData = koffi.register(cbSetData, koffi.pointer(OleSetData))
    cbs.enumFormatEtc = koffi.register(cbEnumFormatEtc, koffi.pointer(OleEnumFormatEtc))
    cbs.dAdvise = koffi.register(cbDAdvise, koffi.pointer(OleDAdvise))
    cbs.dUnadvise = koffi.register(cbDUnadvise, koffi.pointer(OleDUnadvise))
    cbs.enumDAdvise = koffi.register(cbEnumDAdvise, koffi.pointer(OleEnumDAdvise))
    cbs.queryContinueDrag = koffi.register(cbQueryContinueDrag, koffi.pointer(OleQueryContinueDrag))
    cbs.giveFeedback = koffi.register(cbGiveFeedback, koffi.pointer(OleGiveFeedback))
    cbs.next = koffi.register(cbNext, koffi.pointer(OleNext))
    cbs.skip = koffi.register(cbSkip, koffi.pointer(OleSkip))
    cbs.reset = koffi.register(cbReset, koffi.pointer(OleReset))
    cbs.clone = koffi.register(cbClone, koffi.pointer(OleClone))
  } catch (err) {
    for (const ptr of Object.values(cbs)) {
      if (ptr) {
        try {
          koffi.unregister(ptr)
        } catch {
          /* ignore */
        }
      }
    }
    console.error('[OleDrag] koffi.register failed — text drag-out disabled:', err)
    return null
  }
  return cbs as DragCallbacks
}

function unregisterDragCallbacks(cbs: DragCallbacks): void {
  for (const ptr of Object.values(cbs)) {
    try {
      koffi.unregister(ptr)
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */
/* Public entry point                                                  */
/* ------------------------------------------------------------------ */

/**
 * Run a blocking OLE drag for `text` (CF_UNICODETEXT) from the main process.
 *
 * Returns true when DoDragDrop ran to completion (drop or cancel) and false
 * when OLE is unavailable (koffi failed to load, OleInitialize failed, a
 * callback could not be registered) or an exception escaped. Never throws.
 */
export function startTextOleDrag(text: string): boolean {
  if (!doDragDrop || !globalAlloc || !globalLock || !globalUnlock || !globalFree) return false
  if (!ensureOleInitialized()) return false

  // koffi.register reads the call-memory pool, which is only allocated by
  // the first real FFI call — OleInitialize above guarantees it exists.
  const callbacks = registerDragCallbacks()
  if (!callbacks) return false

  dragText = text
  enumCursor = 0
  const effectOut = [0]
  try {
    // vtable + object buffers must stay alive for the whole blocking drag;
    // they are locals referenced until DoDragDrop returns.
    const dataObjVtbl = koffi.alloc(OleIDataObjectVtbl, 1)
    koffi.encode(dataObjVtbl, OleIDataObjectVtbl, {
      QueryInterface: callbacks.queryInterface,
      AddRef: callbacks.addRef,
      Release: callbacks.release,
      GetData: callbacks.getData,
      GetDataHere: callbacks.getDataHere,
      QueryGetData: callbacks.queryGetData,
      GetCanonicalFormatEtc: callbacks.getCanonicalFormatEtc,
      SetData: callbacks.setData,
      EnumFormatEtc: callbacks.enumFormatEtc,
      DAdvise: callbacks.dAdvise,
      DUnadvise: callbacks.dUnadvise,
      EnumDAdvise: callbacks.enumDAdvise
    })
    const dropSourceVtbl = koffi.alloc(OleIDropSourceVtbl, 1)
    koffi.encode(dropSourceVtbl, OleIDropSourceVtbl, {
      QueryInterface: callbacks.queryInterface,
      AddRef: callbacks.addRef,
      Release: callbacks.release,
      QueryContinueDrag: callbacks.queryContinueDrag,
      GiveFeedback: callbacks.giveFeedback
    })
    const enumVtbl = koffi.alloc(OleIEnumVtbl, 1)
    koffi.encode(enumVtbl, OleIEnumVtbl, {
      QueryInterface: callbacks.queryInterface,
      AddRef: callbacks.addRef,
      Release: callbacks.release,
      Next: callbacks.next,
      Skip: callbacks.skip,
      Reset: callbacks.reset,
      Clone: callbacks.clone
    })

    const dataObj = koffi.alloc(OleDataObject, 1)
    koffi.encode(dataObj, OleDataObject, { lpVtbl: koffi.address(dataObjVtbl) })
    const dropSource = koffi.alloc(OleDropSource, 1)
    koffi.encode(dropSource, OleDropSource, { lpVtbl: koffi.address(dropSourceVtbl) })
    const enumObj = koffi.alloc(OleEnumObject, 1)
    koffi.encode(enumObj, OleEnumObject, { lpVtbl: koffi.address(enumVtbl) })
    enumObjAddress = koffi.address(enumObj)

    // Blocks until the gesture ends (drop / cancel / escape); the callbacks
    // above serve the drop target while it runs.
    doDragDrop(koffi.address(dataObj), koffi.address(dropSource), DROPEFFECT_COPY | DROPEFFECT_MOVE, effectOut)
    return true
  } catch (err) {
    console.error('[OleDrag] DoDragDrop failed:', err)
    return false
  } finally {
    dragText = ''
    enumCursor = 0
    enumObjAddress = null
    unregisterDragCallbacks(callbacks)
  }
}
