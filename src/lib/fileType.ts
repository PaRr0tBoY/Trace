/**
 * File-type awareness for non-image files.
 *
 * Maps a file path (by extension) to a stable category used for icon tinting,
 * labels, and kind badges. Kept dependency-free: one small lookup table plus a
 * tinted-file-icon renderer, no per-format rendering libs.
 */

/** Semantic category a file falls into for display purposes. */
export type FileKind =
  | 'pdf'
  | 'word'
  | 'excel'
  | 'powerpoint'
  | 'archive'
  | 'text'
  | 'code'
  | 'audio'
  | 'video'
  | 'image'
  | 'file' // generic fallback

export interface FileKindInfo {
  kind: FileKind
  /** Short human label, e.g. "PDF", "Word". */
  label: string
  /** Hex color used to tint the file icon / badge. */
  color: string
}

/** Extension sets per category. Compared case-insensitively. */
const EXT_MAP: Record<string, FileKind> = {
  pdf: 'pdf',
  doc: 'word', docx: 'word', docm: 'word', odt: 'word', rtf: 'word', pages: 'word',
  xls: 'excel', xlsx: 'excel', xlsm: 'excel', csv: 'excel', ods: 'excel', numbers: 'excel',
  ppt: 'powerpoint', pptx: 'powerpoint', pptm: 'powerpoint', odp: 'powerpoint', key: 'powerpoint',
  zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive', bz2: 'archive', xz: 'archive', iso: 'archive', dmg: 'archive',
  txt: 'text', md: 'text', markdown: 'text', log: 'text', rtf2: 'text',
  js: 'code', ts: 'code', jsx: 'code', tsx: 'code', json: 'code', html: 'code', css: 'code', scss: 'code',
  py: 'code', java: 'code', c: 'code', cpp: 'code', cs: 'code', go: 'code', rs: 'code', rb: 'code',
  php: 'code', sh: 'code', yml: 'code', yaml: 'code', xml: 'code', sql: 'code', vue: 'code', svelte: 'code',
  mp3: 'audio', wav: 'audio', flac: 'audio', aac: 'audio', ogg: 'audio', m4a: 'audio', wma: 'audio',
  mp4: 'video', mkv: 'video', avi: 'video', mov: 'video', wmv: 'video', flv: 'video', webm: 'video', m4v: 'video',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', svg: 'image', avif: 'image', ico: 'image',
  tif: 'image', tiff: 'image', jfif: 'image', pjpeg: 'image', pjp: 'image'
}

const KIND_INFO: Record<FileKind, FileKindInfo> = {
  pdf: { kind: 'pdf', label: 'PDF', color: '#E53935' },
  word: { kind: 'word', label: 'Word', color: '#2B579A' },
  excel: { kind: 'excel', label: 'Excel', color: '#217346' },
  powerpoint: { kind: 'powerpoint', label: 'Slides', color: '#D24726' },
  archive: { kind: 'archive', label: 'Archive', color: '#B0621A' },
  text: { kind: 'text', label: 'Text', color: '#9AA0A6' },
  code: { kind: 'code', label: 'Code', color: '#26A69A' },
  audio: { kind: 'audio', label: 'Audio', color: '#8E44AD' },
  video: { kind: 'video', label: 'Video', color: '#8E44AD' },
  image: { kind: 'image', label: 'Image', color: '#E91E63' },
  file: { kind: 'file', label: 'File', color: '#9AA0A6' }
}

/** Extract the lowercase extension (no dot) from a path. */
export function extOf(path: string): string {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return ''
  // Guard against directory-ish trailing dots and keep it lowercase.
  return path.slice(dot + 1).toLowerCase()
}

import { t } from '../i18n'

/** Resolve a file path to its display metadata (kind / label / color). */
export function getFileKind(path: string): FileKindInfo {
  const ext = extOf(path)
  const kind = EXT_MAP[ext] ?? 'file'
  const base = KIND_INFO[kind]
  const keyMap: Record<FileKind, any> = {
    pdf: 'fileKinds.pdf',
    word: 'fileKinds.word',
    excel: 'fileKinds.excel',
    powerpoint: 'fileKinds.powerpoint',
    archive: 'fileKinds.archive',
    text: 'fileKinds.text',
    code: 'fileKinds.code',
    audio: 'fileKinds.audio',
    video: 'fileKinds.video',
    image: 'fileKinds.image',
    file: 'fileKinds.file'
  }
  return {
    ...base,
    label: t(keyMap[kind]) || base.label
  }
}

/** Resolve from an already-extracted extension string. */
export function getFileKindByExt(ext: string): FileKindInfo {
  const kind = EXT_MAP[ext.toLowerCase()] ?? 'file'
  const base = KIND_INFO[kind]
  const keyMap: Record<FileKind, any> = {
    pdf: 'fileKinds.pdf',
    word: 'fileKinds.word',
    excel: 'fileKinds.excel',
    powerpoint: 'fileKinds.powerpoint',
    archive: 'fileKinds.archive',
    text: 'fileKinds.text',
    code: 'fileKinds.code',
    audio: 'fileKinds.audio',
    video: 'fileKinds.video',
    image: 'fileKinds.image',
    file: 'fileKinds.file'
  }
  return {
    ...base,
    label: t(keyMap[kind]) || base.label
  }
}
