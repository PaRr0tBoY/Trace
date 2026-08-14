/**
 * collectStationMembers tests (ticket #5 / ADR-0006).
 *
 * The renderer-side projection from station DTOs into the files view's
 * FileMember rows: ordering, per-path metadata, extname semantics and the
 * image thumbnail URL. The DTO shape itself is produced by the domain
 * (transferStation.test.ts) — here we pin what the files view consumes.
 */
import { describe, expect, it } from 'vitest'
import { collectStationMembers, extname } from '../src/lib/fileTabs'
import type { StationEntryDto } from '../shared/station'

const entry = (overrides: Partial<StationEntryDto>): StationEntryDto => ({
  id: 'entry-1',
  route: 'clipboard',
  pinned: false,
  inTransit: false,
  capturedAt: 1000,
  stale: false,
  paths: ['c:\\docs\\a.pdf', 'c:\\docs\\b.txt'],
  members: [
    { name: 'a.pdf', ext: 'pdf', size: 512, isImage: false, exists: true },
    { name: 'b.txt', ext: 'txt', size: 32, isImage: false, exists: true }
  ],
  ...overrides
})

describe('collectStationMembers', () => {
  it('flattens entries in entry order, paths in path order', () => {
    const members = collectStationMembers([
      entry({ id: 'e1', paths: ['c:\\x\\1.pdf'], members: [{ name: '1.pdf', ext: 'pdf', size: 1, isImage: false, exists: true }] }),
      entry({ id: 'e2', paths: ['c:\\y\\2.txt', 'c:\\y\\3.zip'], members: [
        { name: '2.txt', ext: 'txt', size: 2, isImage: false, exists: true },
        { name: '3.zip', ext: 'zip', size: 3, isImage: false, exists: true }
      ] })
    ])
    expect(members.map((m) => m.path)).toEqual(['c:\\x\\1.pdf', 'c:\\y\\2.txt', 'c:\\y\\3.zip'])
    expect(members.map((m) => m.itemId)).toEqual(['e1', 'e2', 'e2'])
    expect(members.map((m) => m.index)).toEqual([0, 0, 1])
  })

  it('maps name/size/isImage/exists from the per-path member', () => {
    const [m] = collectStationMembers([entry()])
    expect(m).toMatchObject({
      name: 'a.pdf',
      size: 512,
      isImage: false,
      exists: true
    })
  })

  it('falls back to basename when member metadata is absent', () => {
    const [m] = collectStationMembers([entry({ paths: ['c:\\only\\raw.bin'], members: [] })])
    expect(m.name).toBe('raw.bin')
    expect(m.size).toBe(0)
    expect(m.isImage).toBe(false)
    expect(m.exists).toBeUndefined()
  })

  it('sets ext from extname semantics, extension-less members get null', () => {
    const members = collectStationMembers([
      entry({
        paths: ['c:\\x\\archive.tar.gz', 'c:\\x\\.gitignore', 'c:\\x\\noext', 'c:\\x\\UPPER.PDF'],
        members: [
          { name: 'archive.tar.gz', ext: 'gz', size: 1, isImage: false, exists: true },
          { name: '.gitignore', ext: '', size: 1, isImage: false, exists: true },
          { name: 'noext', ext: '', size: 1, isImage: false, exists: true },
          { name: 'UPPER.PDF', ext: 'pdf', size: 1, isImage: false, exists: true }
        ]
      })
    ])
    expect(members.map((m) => m.ext)).toEqual(['.gz', null, null, '.pdf'])
  })

  it('gives image members a tracelocal thumbnail URL when the file exists', () => {
    const [m] = collectStationMembers([
      entry({
        paths: ['c:\\pics\\my image.png'],
        members: [{ name: 'my image.png', ext: 'png', size: 99, isImage: true, exists: true }]
      })
    ])
    expect(m.preview).toBe(`tracelocal://thumb/${encodeURIComponent('c:\\pics\\my image.png')}`)
  })

  it('omits the preview for a missing image file', () => {
    const [m] = collectStationMembers([
      entry({
        paths: ['c:\\pics\\gone.png'],
        members: [{ name: 'gone.png', ext: 'png', size: 0, isImage: true, exists: false }]
      })
    ])
    expect(m.preview).toBeUndefined()
    expect(m.exists).toBe(false)
  })
})

describe('extname', () => {
  it('follows node path.extname semantics (dot-leading names have no extension)', () => {
    expect(extname('c:\\a\\.gitignore')).toBe('')
    expect(extname('c:\\a\\archive.tar.gz')).toBe('.gz')
    expect(extname('c:\\a\\file.')).toBe('')
    expect(extname('c:\\a\\file')).toBe('')
    expect(extname('c:\\a\\UPPER.PDF')).toBe('.pdf')
  })
})
