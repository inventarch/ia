import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, lstatSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonical, copy, identifier, requireValue, SessionError } from './codec.js';
import { assertOwner, JournalStore } from './store.js';
import type { Checkpoint, Command, CommandResult, Event, Journal, JournalBackend, Owner } from './types.js';

interface Lease {
  owner: Owner;
  connection: DatabaseSync;
}
/** The durability settings read back from a connection after `durabilityPragmas` ran. */
export interface Durability {
  journal_mode: string;
  synchronous: number;
  fullfsync: number;
}
/** Pragmas every connection sets: WAL, synchronous FULL, a 1,000-ms busy timeout and, on darwin only, fullfsync (SS-08). */
export function durabilityPragmas(platform: NodeJS.Platform): string {
  return `PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;${platform === 'darwin' ? ' PRAGMA fullfsync=ON;' : ''}`;
}
/** Refuses with IA-SESSION-STORE-UNAVAILABLE unless the read-back settings are WAL and FULL, with fullfsync on darwin. */
export function assertDurable(settings: Durability, platform: NodeJS.Platform): void {
  requireValue(
    settings.journal_mode === 'wal' &&
      settings.synchronous === 2 &&
      (platform !== 'darwin' || settings.fullfsync === 1),
    'IA-SESSION-STORE-UNAVAILABLE',
    'Required durability settings unavailable',
  );
}
export interface SqliteBackendOptions {
  /** Platform whose durability profile applies; defaults to process.platform. */ platform?: NodeJS.Platform;
}
function assertDirectory(path: string): void {
  for (let current = path; ; current = dirname(current)) {
    const stat = lstatSync(current, { throwIfNoEntry: false });
    requireValue(
      stat === undefined || stat.isDirectory(),
      'IA-SESSION-PATH-UNSAFE',
      'Storage requires regular directories without aliases',
    );
    if (dirname(current) === current) break;
  }
}
/** OS-local adapter: ownership uses a separate lock-only database, released by process death. On macOS each database also syncs with F_FULLFSYNC, which SQLite uses only when told, since fsync(2) there leaves the drive's own cache unflushed (#323). */
export class SqliteBackend implements JournalBackend {
  private readonly databases = new Map<string, DatabaseSync>();
  private readonly leases = new Map<string, Lease>();
  readonly root: string;
  readonly platform: NodeJS.Platform;
  constructor(root: string, options: SqliteBackendOptions = {}) {
    this.root = resolve(root);
    this.platform = options.platform ?? process.platform;
    requireValue(
      !this.root.startsWith('\\\\'),
      'IA-SESSION-PATH-UNSAFE',
      'SQLite storage requires an OS-local directory',
    );
    assertDirectory(this.root);
    mkdirSync(this.root, { recursive: true });
  }
  private directory(id: string): string {
    identifier(id);
    const path = resolve(this.root, createHash('sha256').update(id).digest('hex'));
    assertDirectory(path);
    mkdirSync(path, { recursive: true });
    return path;
  }
  private connect(path: string): DatabaseSync {
    assertDirectory(dirname(path));
    // SQLite opens these companions itself. Refuse aliases before any recovery or pragma can write through them.
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const stat = lstatSync(path + suffix, { throwIfNoEntry: false });
      requireValue(
        stat === undefined || (stat.isFile() && stat.nlink === 1),
        'IA-SESSION-PATH-UNSAFE',
        'Database and sidecars require regular files without aliases',
      );
    }
    const db = new DatabaseSync(path);
    try {
      db.exec(durabilityPragmas(this.platform));
      const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      const sync = db.prepare('PRAGMA synchronous').get() as { synchronous: number },
        full = db.prepare('PRAGMA fullfsync').get() as { fullfsync: number };
      assertDurable(
        { journal_mode: mode.journal_mode, synchronous: sync.synchronous, fullfsync: full.fullfsync },
        this.platform,
      );
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  private database(id: string): DatabaseSync {
    let db = this.databases.get(id);
    if (db) return db;
    db = this.connect(resolve(this.directory(id), 'journal.sqlite'));
    db.exec(`CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fences (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL);
      INSERT OR IGNORE INTO fences VALUES(1,0);`);
    this.databases.set(id, db);
    return db;
  }
  async load(id: string): Promise<Journal | null> {
    const db = this.database(id),
      rows = db.prepare('SELECT body FROM events ORDER BY sequence').all() as { body: string }[];
    if (!rows.length) return null;
    try {
      const commands: Record<string, CommandResult> = {};
      for (const row of db.prepare('SELECT id, result FROM commands').all() as { id: string; result: string }[])
        commands[row.id] = JSON.parse(row.result) as CommandResult;
      const checkpoint = db.prepare('SELECT body FROM checkpoints WHERE id=1').get() as { body: string } | undefined;
      let parsed: Checkpoint | null = null;
      try {
        if (checkpoint) parsed = JSON.parse(checkpoint.body) as Checkpoint;
      } catch {
        /* journal replay is authoritative */
      }
      return { events: rows.map((r) => JSON.parse(r.body) as Event), commands, checkpoint: parsed };
    } catch {
      throw new SessionError('IA-SESSION-STORE-CORRUPT', 'Stored journal is not valid JSON');
    }
  }
  async commit(command: Command, hash: string, events: Event[], owner?: Owner): Promise<CommandResult> {
    assertOwner(command, owner);
    if (owner) await this.validate(owner);
    const db = this.database(command.sessionId);
    db.exec('BEGIN IMMEDIATE');
    try {
      const prior = db.prepare('SELECT digest, result FROM commands WHERE id=?').get(command.id) as
        | { digest: string; result: string }
        | undefined;
      if (prior) {
        requireValue(prior.digest === hash, 'IA-SESSION-COMMAND-CONFLICT', 'Command ID changed');
        db.exec('COMMIT');
        return JSON.parse(prior.result) as CommandResult;
      }
      const head = db.prepare('SELECT COALESCE(MAX(sequence),0) AS sequence FROM events').get() as { sequence: number };
      requireValue(head.sequence === command.expected, 'IA-SESSION-REVISION-CONFLICT', 'Session changed');
      for (const event of events) db.prepare('INSERT INTO events VALUES(?,?)').run(event.sequence, canonical(event));
      const last = events.at(-1)!,
        result: CommandResult = { id: command.id, digest: hash, sequence: last.sequence, hash: last.hash };
      db.prepare('INSERT INTO commands VALUES(?,?,?)').run(command.id, hash, canonical(result));
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }
  async checkpoint(id: string, checkpoint: Checkpoint, owner: Owner): Promise<void> {
    await this.validate(owner);
    requireValue(owner.sessionId === id, 'IA-SESSION-OWNER-LOST', 'Wrong session owner');
    const db = this.database(id);
    db.exec('BEGIN IMMEDIATE');
    try {
      const head = db.prepare('SELECT MAX(sequence) AS sequence FROM events').get() as { sequence: number };
      requireValue(head.sequence === checkpoint.sequence, 'IA-SESSION-REVISION-CONFLICT', 'Session changed');
      db.prepare('INSERT OR REPLACE INTO checkpoints VALUES(1,?)').run(canonical(checkpoint));
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }
  async acquire(id: string): Promise<Owner> {
    requireValue(!this.leases.has(id), 'IA-SESSION-OWNER-BUSY', 'Session has an owner');
    const connection = this.connect(resolve(this.directory(id), 'owner.sqlite'));
    try {
      connection.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
    } catch {
      connection.close();
      throw new SessionError('IA-SESSION-OWNER-BUSY', 'Another process owns this session');
    }
    try {
      const row = this.database(id).prepare('UPDATE fences SET value=value+1 WHERE id=1 RETURNING value').get() as {
        value: number;
      };
      const owner: Owner = { sessionId: id, token: randomUUID(), fence: row.value };
      this.leases.set(id, { owner, connection });
      return copy(owner);
    } catch (error) {
      connection.close();
      throw error;
    }
  }
  async validate(owner: Owner): Promise<void> {
    const lease = this.leases.get(owner.sessionId);
    requireValue(
      lease?.owner.token === owner.token && lease.owner.fence === owner.fence && lease.connection.isTransaction,
      'IA-SESSION-OWNER-LOST',
      'Ownership lost',
    );
  }
  async release(owner: Owner): Promise<void> {
    await this.validate(owner);
    this.leases.get(owner.sessionId)!.connection.close();
    this.leases.delete(owner.sessionId);
  }
  async close(): Promise<void> {
    for (const lease of this.leases.values()) lease.connection.close();
    this.leases.clear();
    for (const db of this.databases.values()) db.close();
    this.databases.clear();
  }
}
export function sqliteStore(root: string): JournalStore {
  return new JournalStore(new SqliteBackend(root));
}
