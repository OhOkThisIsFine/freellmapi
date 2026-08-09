import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';
import { connectDb } from '../../db/index.js';
import { aclEntries } from '../helpers/acl.js';

const isWindows = process.platform === 'win32';
const itPosix = it.skipIf(isWindows);
const itWindows = it.skipIf(!isWindows);

const created: string[] = [];

function tempDbPath(): string {
  const p = path.join(os.tmpdir(), `freeapi-hardening-${Date.now()}-${Math.random()}.db`);
  created.push(p);
  return p;
}

afterEach(() => {
  for (const p of created.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(`${p}${suffix}`); } catch { /* best effort */ }
    }
  }
});

describe('database runtime hardening', () => {
  it('sets a busy timeout so concurrent writers wait instead of erroring', () => {
    const db = connectDb(tempDbPath());
    // pragma() returns a scalar or a row list depending on driver; normalise.
    const raw = db.pragma('busy_timeout');
    const value = Array.isArray(raw)
      ? Number((raw[0] as Record<string, unknown>).timeout ?? (raw[0] as Record<string, unknown>).busy_timeout)
      : Number(raw);
    expect(value).toBe(5000);
  });

  it('keeps foreign keys and WAL on', () => {
    const db = connectDb(tempDbPath());
    const fk = db.pragma('foreign_keys');
    const fkValue = Array.isArray(fk)
      ? Number((fk[0] as Record<string, unknown>).foreign_keys)
      : Number(fk);
    expect(fkValue).toBe(1);

    const jm = db.pragma('journal_mode');
    const jmValue = Array.isArray(jm)
      ? String((jm[0] as Record<string, unknown>).journal_mode)
      : String(jm);
    expect(jmValue.toLowerCase()).toBe('wal');
  });

  // The DB holds encrypted provider keys and the dashboard password hash, so it
  // must not be readable by other local accounts. The guarantee is the same on
  // both platforms; only the mechanism that expresses it differs, so each leg
  // asserts what its own OS can actually enforce. Asserting POSIX modes on
  // Windows is not a stricter test — it is an unfalsifiable one: Node
  // synthesizes 0o666 there and chmod cannot clear it, so the assertion failed
  // whether or not the file was protected.

  itPosix('restricts the database file to the owner', () => {
    const dbPath = tempDbPath();
    connectDb(dbPath);

    const mode = fs.statSync(dbPath).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  itPosix('restricts the WAL sidecars once they exist', () => {
    const dbPath = tempDbPath();
    const db = connectDb(dbPath);
    // Force a write so -wal/-shm are created, then reconnect to chmod them.
    db.exec('CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY)');
    db.exec('INSERT INTO probe (id) VALUES (1)');
    connectDb(dbPath);

    for (const suffix of ['-wal', '-shm']) {
      const target = `${dbPath}${suffix}`;
      if (!fs.existsSync(target)) continue;
      const mode = fs.statSync(target).mode & 0o777;
      expect(mode & 0o077).toBe(0);
    }
  });

  itWindows('restricts the database file to the owner', () => {
    const dbPath = tempDbPath();
    connectDb(dbPath);

    const entries = aclEntries(dbPath);
    // Inherited ACEs are where the extra principals come from: a file created
    // under %TEMP% or a shared profile inherits Modify for app containers and
    // for other local accounts. If any (I) survives, hardening did not run.
    expect(entries.filter(e => e.includes('(I)'))).toEqual([]);
    // Exactly the owner, SYSTEM and Administrators — the POSIX 0600 equivalent,
    // where root likewise keeps access.
    expect(entries).toHaveLength(3);
  });

  itWindows('restricts the WAL sidecars once they exist', () => {
    const dbPath = tempDbPath();
    const db = connectDb(dbPath);
    // Force a write so -wal/-shm are created, then reconnect to harden them.
    db.exec('CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY)');
    db.exec('INSERT INTO probe (id) VALUES (1)');
    connectDb(dbPath);

    let checked = 0;
    for (const suffix of ['-wal', '-shm']) {
      const target = `${dbPath}${suffix}`;
      if (!fs.existsSync(target)) continue;
      checked++;
      expect(aclEntries(target).filter(e => e.includes('(I)'))).toEqual([]);
    }
    // The original test silently passed when neither sidecar existed; make the
    // Windows leg say so rather than pretending it verified something.
    //
    // Note what the reconnect above buys, and what it does not: it proves the
    // pass restricts sidecars THAT ALREADY EXIST. A real server never gets
    // here — it opens once, and SQLite creates the sidecars afterwards on the
    // first write. See the known gap on restrictDbFilePermissions.
    expect(checked).toBeGreaterThan(0);
  });

  itWindows('leaves an already-restricted file unchanged when reconnecting', () => {
    const dbPath = tempDbPath();
    connectDb(dbPath);
    const first = aclEntries(dbPath);
    connectDb(dbPath);

    expect(aclEntries(dbPath)).toEqual(first);
  });

  it('works for an in-memory database without touching the filesystem', () => {
    expect(() => connectDb(':memory:')).not.toThrow();
  });
});
