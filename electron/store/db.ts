/**
 * SQLite canonical store (trace.db) — schema skeleton + migration framework.
 *
 * Pure logic: no Electron imports (hard constraint). Owns open/close, WAL
 * journaling, sequential migrations driven by `PRAGMA user_version`, and the
 * seven core tables plus FTS5 indexes. Business logic per table lands in later
 * tickets (39 evidence timeline / 37 sessions / 41 trace / 46 recommendations
 * / 48 memory graph); this module only guarantees the structure exists, is
 * queryable, and migrates cleanly forward.
 *
 * Conventions:
 * - Every time column is Unix epoch ms stored as INTEGER.
 * - Column spelling follows the spec contracts verbatim: `task_sessions` uses
 *   the camelCase interface from spec decision 4 (taskId / startedAt / …);
 *   `facts` uses the snake_case time-validity names from spec decision 10
 *   (valid_at / invalid_at / expired_at).
 * - `kind` values on `events` reuse the existing event-bus vocabulary
 *   (`app-switch` | `clipboard`, see shared/types.ts UsageEvent).
 * - FTS5 uses contentful virtual tables kept in sync by triggers, so readers
 *   query the FTS table directly and join nothing.
 */
import Database from 'better-sqlite3'

export type TraceDatabase = Database.Database

/** One sequential migration step. `version` equals `user_version` after applying. */
export interface Migration {
  version: number
  name: string
  up: (db: TraceDatabase) => void
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial schema: events / episodes / entities / facts / task_sessions / trace / recommendation_history + FTS5',
    up: (db) => {
      db.exec(`
        -- Evidence timeline (spec decision 2): raw captured events, never edited.
        CREATE TABLE events (
          id          TEXT    PRIMARY KEY,
          kind        TEXT    NOT NULL,  -- 'app-switch' | 'clipboard' (UsageEvent.type)
          capturedAt  INTEGER NOT NULL,  -- epoch ms
          source      TEXT,              -- normalized exePath / process name
          windowTitle TEXT,              -- foreground window title (app-switch)
          payload     TEXT               -- JSON, kind-specific fields (pid, itemId, …)
        );
        CREATE INDEX idx_events_capturedAt ON events (capturedAt);
        CREATE INDEX idx_events_source      ON events (source);

        -- Memory graph (spec decision 10): raw-material windows for consolidation.
        CREATE TABLE episodes (
          id        TEXT    PRIMARY KEY,
          sessionId TEXT,                -- owning task_session id (container, 1:N), nullable
          startedAt INTEGER NOT NULL,    -- epoch ms
          endedAt   INTEGER,             -- epoch ms, null while open
          summary   TEXT,                -- extracted digest, null until consolidation
          content   TEXT    NOT NULL,    -- raw material persisted at capture time
          createdAt INTEGER NOT NULL     -- epoch ms
        );
        CREATE INDEX idx_episodes_sessionId ON episodes (sessionId);
        CREATE INDEX idx_episodes_startedAt ON episodes (startedAt);

        -- Memory graph: entity nodes, unique per (name, type).
        CREATE TABLE entities (
          id        TEXT    PRIMARY KEY,
          name      TEXT    NOT NULL,
          type      TEXT    NOT NULL,    -- 'person' | 'app' | 'project' | … (free-form)
          createdAt INTEGER NOT NULL     -- epoch ms
        );
        CREATE UNIQUE INDEX idx_entities_name_type ON entities (name, type);
        CREATE INDEX idx_entities_type ON entities (type);

        -- Memory graph: long-term memory rows. Profile / Pattern / Task memory /
        -- Preference are fact *types*, never separate tables (spec decision 10).
        CREATE TABLE facts (
          id         TEXT    PRIMARY KEY,
          type       TEXT    NOT NULL,   -- 'profile' | 'pattern' | 'task' | 'preference' | …
          content    TEXT    NOT NULL,
          source     TEXT    NOT NULL,   -- 'ai-suggest' | 'task-feedback' | 'user' | 'inferred'
          userState  TEXT    NOT NULL DEFAULT 'suggested',  -- confirmed | suggested | ignored | banned
          weight     REAL    NOT NULL DEFAULT 1,            -- intent tier × decay × time fields (computed by ticket 48)
          episodeId  TEXT,               -- provenance: originating episode (source chain)
          entityIds  TEXT,               -- JSON array of entity ids (relation-diffusion edges, v1, no separate edge table)
          valid_at   INTEGER,            -- epoch ms, time-validity window (spec decision 10)
          invalid_at INTEGER,            -- epoch ms, null while valid
          expired_at INTEGER,            -- epoch ms, null while valid
          createdAt  INTEGER NOT NULL,   -- epoch ms
          updatedAt  INTEGER NOT NULL    -- epoch ms
        );
        CREATE INDEX idx_facts_type      ON facts (type);
        CREATE INDEX idx_facts_userState ON facts (userState);
        CREATE INDEX idx_facts_episodeId ON facts (episodeId);
        CREATE INDEX idx_facts_valid_at  ON facts (valid_at);

        -- Task sessions (spec decision 4): one continuous run of a task.
        -- taskId references tasks.json entries — TaskStore stays JSON-backed.
        CREATE TABLE task_sessions (
          id               TEXT    PRIMARY KEY,
          taskId           TEXT    NOT NULL,
          startedAt        INTEGER NOT NULL,   -- epoch ms
          endedAt          INTEGER,            -- epoch ms, null while running
          confidence       REAL    NOT NULL DEFAULT 0,
          transitionReason TEXT    NOT NULL DEFAULT '',
          previousTaskId   TEXT
        );
        CREATE INDEX idx_task_sessions_taskId    ON task_sessions (taskId);
        CREATE INDEX idx_task_sessions_startedAt ON task_sessions (startedAt);

        -- AI rationale records (spec decision 8): canonical trace; JSONL is demoted
        -- to diagnostics/export. One row per observed/recall/decision/result/privacy
        -- event, grouped by decisionId.
        CREATE TABLE trace (
          id                TEXT    PRIMARY KEY,
          decisionId        TEXT    NOT NULL,   -- groups one decision chain (observed → … → result)
          kind              TEXT    NOT NULL,   -- observed | recall | decision | result | privacy
          payload           TEXT    NOT NULL,   -- JSON body for the kind
          taskId            TEXT,               -- adopted-proposal linkage (retention: lives with task)
          agentVersion      TEXT,
          policyVersion     TEXT,
          classifierVersion TEXT,
          promptVersion     TEXT,
          createdAt         INTEGER NOT NULL    -- epoch ms
        );
        CREATE INDEX idx_trace_decisionId ON trace (decisionId);
        CREATE INDEX idx_trace_createdAt  ON trace (createdAt);

        -- Recommendation history (spec decision 9): fingerprint + cooling + outcome.
        CREATE TABLE recommendation_history (
          id           TEXT    PRIMARY KEY,
          fingerprint  TEXT    NOT NULL,   -- semantic fingerprint (cluster + entities + time bucket)
          level        INTEGER NOT NULL CHECK (level IN (1, 2, 3)),
          shownAt      INTEGER NOT NULL,   -- epoch ms
          outcome      TEXT,               -- accepted | ignored | dismissed | noop
          actionReason TEXT                -- user_confirmed | user_manually_dismissed | wrong_task | already_exists | not_now
        );
        CREATE INDEX idx_recommendation_history_fingerprint ON recommendation_history (fingerprint);
        CREATE INDEX idx_recommendation_history_shownAt     ON recommendation_history (shownAt);

        -- FTS5 (事件与记忆检索). Contentful virtual tables mirrored by triggers so
        -- deletes/updates stay in sync; readers query the FTS table directly.
        CREATE VIRTUAL TABLE events_fts USING fts5(
          id UNINDEXED, kind UNINDEXED, source, windowTitle, payload
        );
        CREATE TRIGGER events_ai AFTER INSERT ON events BEGIN
          INSERT INTO events_fts (id, kind, source, windowTitle, payload)
          VALUES (new.id, new.kind, new.source, new.windowTitle, new.payload);
        END;
        CREATE TRIGGER events_ad AFTER DELETE ON events BEGIN
          DELETE FROM events_fts WHERE id = old.id;
        END;
        CREATE TRIGGER events_au AFTER UPDATE ON events BEGIN
          DELETE FROM events_fts WHERE id = old.id;
          INSERT INTO events_fts (id, kind, source, windowTitle, payload)
          VALUES (new.id, new.kind, new.source, new.windowTitle, new.payload);
        END;

        CREATE VIRTUAL TABLE episodes_fts USING fts5(
          id UNINDEXED, summary, content
        );
        CREATE TRIGGER episodes_ai AFTER INSERT ON episodes BEGIN
          INSERT INTO episodes_fts (id, summary, content)
          VALUES (new.id, new.summary, new.content);
        END;
        CREATE TRIGGER episodes_ad AFTER DELETE ON episodes BEGIN
          DELETE FROM episodes_fts WHERE id = old.id;
        END;
        CREATE TRIGGER episodes_au AFTER UPDATE ON episodes BEGIN
          DELETE FROM episodes_fts WHERE id = old.id;
          INSERT INTO episodes_fts (id, summary, content)
          VALUES (new.id, new.summary, new.content);
        END;

        CREATE VIRTUAL TABLE facts_fts USING fts5(
          id UNINDEXED, type UNINDEXED, content
        );
        CREATE TRIGGER facts_ai AFTER INSERT ON facts BEGIN
          INSERT INTO facts_fts (id, type, content)
          VALUES (new.id, new.type, new.content);
        END;
        CREATE TRIGGER facts_ad AFTER DELETE ON facts BEGIN
          DELETE FROM facts_fts WHERE id = old.id;
        END;
        CREATE TRIGGER facts_au AFTER UPDATE ON facts BEGIN
          DELETE FROM facts_fts WHERE id = old.id;
          INSERT INTO facts_fts (id, type, content)
          VALUES (new.id, new.type, new.content);
        END;
      `)
    }
  },
  {
    version: 2,
    name: 'facts: hitCount / lastSeenAt / intent (t48 memory graph)',
    up: (db) => {
      // MemoryStore 面板适配器与事实权重（五档 × 衰减 × 时段）需要命中计数、
      // 最近命中时刻与意图档位；v1 建表时未含，后补（有默认值，旧行安全）。
      db.exec(`
        ALTER TABLE facts ADD COLUMN hitCount INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE facts ADD COLUMN lastSeenAt INTEGER;
        ALTER TABLE facts ADD COLUMN intent TEXT NOT NULL DEFAULT 'system-infer';
      `)
    }
  }
]

/** Latest schema version — equals the `user_version` of a fully migrated DB. */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version

/**
 * Apply every migration with a version above the DB's current `user_version`,
 * in ascending order. Each step runs atomically (DDL + version bump inside one
 * transaction). Idempotent: already-applied versions are skipped, so repeated
 * opens never re-run work and the version only ever advances.
 */
/** Read `user_version`, rejecting non-numeric results instead of trusting a cast. */
function userVersion(db: TraceDatabase): number {
  const v = db.pragma('user_version', { simple: true })
  if (typeof v !== 'number') throw new Error(`PRAGMA user_version returned ${String(v)}`)
  return v
}

export function runMigrations(db: TraceDatabase, migrations: readonly Migration[]): void {
  const current = userVersion(db)
  for (const migration of migrations) {
    if (migration.version <= current) continue
    db.transaction(() => {
      migration.up(db)
      db.pragma(`user_version = ${migration.version}`)
    })()
  }
}

/** Run the built-in schema migrations (used by openDatabase and tests). */
export function applyMigrations(db: TraceDatabase): void {
  runMigrations(db, MIGRATIONS)
}

export interface OpenDatabaseOptions {
  /**
   * Absolute path to a custom native addon, passed through to better-sqlite3's
   * `nativeBinding` option (its official injection seam). Production callers
   * omit it and get the default ABI-matched binding; tests use it when the
   * installed binding targets another runtime (e.g. Electron) than the test
   * runner's Node.
   */
  nativeBinding?: string
}

/**
 * Open (creating if needed) and fully migrate a database file.
 *
 * - Enables WAL journaling; the mode persists in the file header, so this is
 *   idempotent across opens. In-memory databases (`:memory:`) ignore it.
 * - `:memory:` yields a fresh empty DB per call — use for tests.
 */
export function openDatabase(filePath: string, options: OpenDatabaseOptions = {}): TraceDatabase {
  const db = options.nativeBinding
    ? new Database(filePath, { nativeBinding: options.nativeBinding })
    : new Database(filePath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  applyMigrations(db)
  return db
}

/** Close the handle; safe to call on an already-closed database. */
export function closeDatabase(db: TraceDatabase): void {
  if (db.open) db.close()
}
