/**
 * File-view tab derivation (ADR-0004): extname semantics, member
 * collection, tab sorting/truncation, 'other' bucket, tab liveness.
 */
import { describe, expect, it } from 'vitest'
import type { ClipboardItemDto } from '../shared/types'
import { collectFileMembers, deriveFileTabs, extname, filterMembersByTab, isFileTabAlive, isImageItem } from '../src/lib/fileTabs'

function filesItem(id: string, paths: string[]): ClipboardItemDto {
  return {
    id,
    capturedAt: 1,
    hitCount: 1,
    pinned: false,
    data: { kind: 'files', paths, entries: paths.map((p) => ({ name: p.split(/[\\/]/).pop() ?? p, size: 10, isImage: false })) }
  } as ClipboardItemDto
}

describe('extname (Node path.extname semantics)', () => {
  it('returns the last extension with a dot', () => {
    expect(extname('a/b/report.pdf')).toBe('.pdf')
    expect(extname('archive.tar.gz')).toBe('.gz')
  })

  it('lowercases the extension', () => {
    expect(extname('PHOTO.JPG')).toBe('.jpg')
    expect(extname('Mixed.Case.Png')).toBe('.png')
  })

  it('treats dot-leading names as extension-less', () => {
    expect(extname('/home/x/.gitignore')).toBe('')
    expect(extname('.env')).toBe('')
  })

  it('treats names without a dot as extension-less', () => {
    expect(extname('README')).toBe('')
    expect(extname('C:\\Users\\Acid\\Desktop\\notes')).toBe('')
  })

  it('treats a trailing dot as extension-less', () => {
    expect(extname('foo.')).toBe('')
  })
})

describe('isImageItem (clipboard vs files classification)', () => {
  it('classifies image and image-collection entries as images', () => {
    const img = { id: 'i', capturedAt: 1, hitCount: 1, pinned: false, data: { kind: 'image', imageId: 'x', width: 1, height: 1, bytes: 1 } } as ClipboardItemDto
    expect(isImageItem(img)).toBe(true)
  })

  it('classifies an all-image-path file entry as an image', () => {
    expect(isImageItem(filesItem('f', ['a/photo.png', 'b/photo.jpg']))).toBe(true)
  })

  it('keeps mixed or non-image file entries in the files view', () => {
    expect(isImageItem(filesItem('f', ['a/photo.png', 'b/doc.pdf']))).toBe(false)
    expect(isImageItem(filesItem('f', ['a/doc.pdf']))).toBe(false)
  })
})

describe('collectFileMembers', () => {
  it('flattens every non-image file entry into members in item order', () => {
    const items = [
      filesItem('f1', ['a/one.pdf', 'b/two.txt']),
      filesItem('f2', ['c/three.png', 'd/four.docx']),
      // all-image entry → excluded from the files view
      filesItem('f3', ['e/five.png', 'f/six.png'])
    ]
    const members = collectFileMembers(items)
    expect(members.map((m) => m.path)).toEqual(['a/one.pdf', 'b/two.txt', 'c/three.png', 'd/four.docx'])
    expect(members[0]).toMatchObject({ itemId: 'f1', index: 0, ext: '.pdf', name: 'one.pdf' })
    expect(members[3]).toMatchObject({ itemId: 'f2', index: 1, ext: '.docx', name: 'four.docx' })
  })
})

describe('deriveFileTabs', () => {
  it('sorts by count desc, ties alphabetical', () => {
    const members = collectFileMembers([
      filesItem('f1', ['a/b.pdf', 'b/c.pdf']),
      filesItem('f2', ['d/e.txt', 'e/f.txt']),
      filesItem('f3', ['g/h.zip']),
      filesItem('f4', ['i/j.docx'])
    ])
    const { tabs, otherCount } = deriveFileTabs(members, 10)
    expect(tabs.map((t) => t.ext)).toEqual(['.pdf', '.txt', '.docx', '.zip'])
    expect(tabs[0].count).toBe(2)
    expect(otherCount).toBe(0)
  })

  it('groups case-insensitively', () => {
    const members = collectFileMembers([filesItem('f1', ['a/b.PDF', 'c/d.pdf'])])
    const { tabs } = deriveFileTabs(members, 10)
    expect(tabs).toEqual([{ ext: '.pdf', count: 2 }])
  })

  it('truncates from the tail while keeping all + other', () => {
    const members = collectFileMembers([
      filesItem('f1', ['a/1.pdf', 'b/2.pdf', 'c/3.pdf']),
      filesItem('f2', ['d/1.txt', 'e/2.txt']),
      filesItem('f3', ['f/1.png']),
      filesItem('f4', ['g/1.docx']),
      filesItem('f5', ['h/1.xlsx']),
      filesItem('f6', ['i/README', 'j/NOTES'])
    ])
    const { tabs, otherCount } = deriveFileTabs(members, 3)
    expect(tabs.map((t) => t.ext)).toEqual(['.pdf', '.txt', '.docx'])
    expect(otherCount).toBe(2)
  })

  it('counts extension-less members into other regardless of count', () => {
    const members = collectFileMembers([
      filesItem('f1', ['a/1', 'b/2', 'c/3', 'd/4']),
      filesItem('f2', ['e/5.pdf'])
    ])
    const { tabs, otherCount } = deriveFileTabs(members, 10)
    expect(tabs.map((t) => t.ext)).toEqual(['.pdf'])
    expect(otherCount).toBe(4)
  })
})

describe('filterMembersByTab', () => {
  const members = collectFileMembers([
    filesItem('f1', ['a/one.pdf', 'b/two.txt', 'c/README']),
    filesItem('f2', ['d/three.pdf'])
  ])

  it('returns everything for all', () => {
    expect(filterMembersByTab(members, 'all')).toHaveLength(4)
  })

  it('filters by extension', () => {
    expect(filterMembersByTab(members, '.pdf').map((m) => m.path)).toEqual(['a/one.pdf', 'd/three.pdf'])
  })

  it('filters the other bucket (extension-less)', () => {
    expect(filterMembersByTab(members, 'other').map((m) => m.path)).toEqual(['c/README'])
  })
})

describe('isFileTabAlive', () => {
  const members = collectFileMembers([filesItem('f1', ['a/one.pdf'])])

  it('accepts all and other always', () => {
    expect(isFileTabAlive([], 'all', 4)).toBe(true)
    expect(isFileTabAlive([], 'other', 4)).toBe(true)
  })

  it('accepts a live extension tab and rejects a vanished one', () => {
    expect(isFileTabAlive(members, '.pdf', 4)).toBe(true)
    expect(isFileTabAlive(members, '.txt', 4)).toBe(false)
    expect(isFileTabAlive(members, '.png', 4)).toBe(false)
  })

  it('rejects a tab that exists only after truncation (killed by maxTabs)', () => {
    const many = collectFileMembers([
      filesItem('f1', ['a/one.pdf', 'b/two.pdf']),
      filesItem('f2', ['c/one.docx', 'd/two.docx']),
      filesItem('f3', ['e/one.xlsx', 'f/two.xlsx']),
      filesItem('f4', ['g/one.pptx', 'h/two.pptx']),
      filesItem('f5', ['i/one.zip'])
    ])
    // top-4 tabs: pdf, docx, xlsx, pptx — .zip is truncated away
    expect(deriveFileTabs(many, 4).tabs.map((t) => t.ext)).not.toContain('.zip')
    expect(isFileTabAlive(many, '.zip', 4)).toBe(false)
  })
})
