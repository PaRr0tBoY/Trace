/**
 * Content hash for text clipboard items (dedup signature key).
 *
 * Why a hash: after the disk-payload migration (large text > 300 chars keeps
 * only a preview in `data.text`), a signature built from the preview no
 * longer identifies the content — re-copies stop deduping after a restart,
 * and a short text that equals another item's preview is wrongly swallowed
 * as a duplicate. The hash is computed from the FULL text at capture time
 * (before truncation) and backfilled for legacy items at load, so the
 * signature stays stable across restarts and payload migration.
 *
 * Pure node:crypto module — vitest imports it without an electron mock.
 */
import { createHash } from 'node:crypto'

/** SHA-256 hex digest of the full text (content identity, not security). */
export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
