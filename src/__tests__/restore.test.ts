import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dbBackup, fixedNow, makeTempDir, makeRuntime, cleanupTempDirs } from './helpers';

const {
  restoreBackup,
  runBackupJob,
  restoreSqliteBackup,
  detectSqliteQuiescence,
} = dbBackup;

afterEach(() => {
  cleanupTempDirs();
});

describe('@andrewpopov/db-backup — restore (round-trip, safety guards, writer quiescence, rescue snapshot)', () => {
  it('restores PostgreSQL dumps with clean transactional pg_restore and redacts the target URL', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    const backupPath = path.join(outputDir, 'postgres-backup-20260705-150000Z.dump');
    const calls: Array<{ command: string; args: string[] }> = [];
    const databaseUrl = 'postgresql://user:secret@db.example/app';
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(backupPath, 'postgres dump');

    const result = restoreBackup({
      cwd,
      databaseUrl,
      outputDir,
      backupFile: path.basename(backupPath),
      createPreRestoreBackup: false,
      runtime: makeRuntime({
        commandExists: (command) => command === 'pg_restore',
        execFileSync: (command, args) => calls.push({ command, args }),
      }),
    });

    expect(calls).toEqual([
      {
        command: 'pg_restore',
        args: [
          '--clean',
          '--if-exists',
          '--no-owner',
          '--no-privileges',
          '--single-transaction',
          '--dbname',
          databaseUrl,
          backupPath,
        ],
      },
    ]);
    expect(result.target).toBe('postgresql://user:***@db.example/app');
  });

  it('restores compressed SQLite backups atomically through a temp file', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    const dbPath = path.join(cwd, 'data', 'app.db');
    const backupPath = path.join(outputDir, 'sqlite-backup-20260705-150000Z.db.gz');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(dbPath, 'old database');
    fs.writeFileSync(backupPath, zlib.gzipSync(Buffer.from('restored database')));

    const result = restoreBackup({
      cwd,
      databaseUrl: 'file:./data/app.db',
      outputDir,
      backupFile: path.basename(backupPath),
      createPreRestoreBackup: false,
      skipVerify: true,
      allowOnlineRestore: true,
      runtime: makeRuntime(),
      allowUnsafeCopy: true,
    });

    expect(result.target).toBe(dbPath);
    expect(fs.readFileSync(dbPath, 'utf8')).toBe('restored database');
    expect(fs.existsSync(path.join(path.dirname(dbPath), '.restore-fixed-restore-id.db'))).toBe(false);
  });

  it('restore discards the old database’s -wal/-shm/-journal sidecars', () => {
    // Regression (BWK-118): the sidecars describe the database being REPLACED.
    // Left on disk, SQLite replays the old WAL's frames onto the restored file
    // on next open — silently resurrecting pre-restore rows, while
    // `PRAGMA integrity_check` still reports "ok".
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    const dbPath = path.join(cwd, 'data', 'app.db');
    const backupPath = path.join(outputDir, 'sqlite-backup-20260705-150000Z.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(dbPath, 'old database');
    fs.writeFileSync(backupPath, 'restored database');

    // Sidecars from the pre-restore database, as a crashed writer would leave.
    const sidecars = ['-wal', '-shm', '-journal'].map((suffix) => `${dbPath}${suffix}`);
    sidecars.forEach((file) => fs.writeFileSync(file, 'stale frames from the OLD database'));

    restoreBackup({
      cwd,
      databaseUrl: 'file:./data/app.db',
      outputDir,
      backupFile: path.basename(backupPath),
      createPreRestoreBackup: false,
      skipVerify: true,
      allowOnlineRestore: true,
      runtime: makeRuntime(),
      allowUnsafeCopy: true,
    });

    expect(fs.readFileSync(dbPath, 'utf8')).toBe('restored database');
    for (const file of sidecars) {
      expect(fs.existsSync(file), `${path.basename(file)} must not survive a restore`).toBe(false);
    }
  });

  it('restore succeeds when the database has no sidecars to remove', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    const dbPath = path.join(cwd, 'data', 'app.db');
    const backupPath = path.join(outputDir, 'sqlite-backup-20260705-150000Z.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(backupPath, 'restored database');
    // No pre-existing database file at all — removal must be a no-op, not a throw.

    const result = restoreBackup({
      cwd,
      databaseUrl: 'file:./data/app.db',
      outputDir,
      backupFile: path.basename(backupPath),
      createPreRestoreBackup: false,
      skipVerify: true,
      allowOnlineRestore: true,
      allowMissing: true,
      runtime: makeRuntime(),
      allowUnsafeCopy: true,
    });

    expect(result.target).toBe(dbPath);
    expect(fs.readFileSync(dbPath, 'utf8')).toBe('restored database');
  });

  // --- P0 #3: restore round-trip, --latest, engine mismatch, truncated .gz ---

  it('restores a SQLite backup created via the cp-fallback path, round-tripping bytes exactly', () => {
    const cwd = makeTempDir();
    const dbPath = path.join(cwd, 'data', 'app.db');
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const originalBytes = Buffer.from('arbitrary sqlite bytes, not a real sqlite file, 12345');
    fs.writeFileSync(dbPath, originalBytes);

    const runtime = makeRuntime({ commandExists: () => false });
    const created = runBackupJob({ skipRemote: true,
      allowUnsafeCopy: true,
      cwd,
      databaseUrl: 'file:./data/app.db',
      outputDir,
      compressSqlite: false,
      runtime,
    });

    // Mutate the live DB so the assertion actually proves restore rewrote it.
    fs.writeFileSync(dbPath, 'mutated after backup');

    const result = restoreBackup({
      cwd,
      databaseUrl: 'file:./data/app.db',
      outputDir,
      backupFile: created.created.fileName,
      createPreRestoreBackup: false,
      skipVerify: true,
      allowOnlineRestore: true,
      runtime,
    });

    expect(result.target).toBe(dbPath);
    expect(fs.readFileSync(dbPath).equals(originalBytes)).toBe(true);
  });

  it('restore --latest picks the newest backup by timestamp', () => {
    const cwd = makeTempDir();
    const dbPath = path.join(cwd, 'app.db');
    const outputDir = path.join(cwd, 'backups');
    fs.writeFileSync(dbPath, 'version 1');

    const olderRuntime = makeRuntime({ now: () => new Date('2026-07-01T00:00:00.000Z') });
    runBackupJob({ skipRemote: true, cwd, databaseUrl: 'file:./app.db', outputDir, compressSqlite: false, runtime: olderRuntime, allowUnsafeCopy: true });

    fs.writeFileSync(dbPath, 'version 2');
    const newerRuntime = makeRuntime({ now: () => new Date('2026-07-05T00:00:00.000Z') });
    const second = runBackupJob({ skipRemote: true, cwd, databaseUrl: 'file:./app.db', outputDir, compressSqlite: false, runtime: newerRuntime, allowUnsafeCopy: true });

    fs.writeFileSync(dbPath, 'mutated after both backups');

    const result = restoreBackup({
      cwd,
      databaseUrl: 'file:./app.db',
      outputDir,
      useLatest: true,
      createPreRestoreBackup: false,
      skipVerify: true,
      allowOnlineRestore: true,
      runtime: newerRuntime,
    });

    expect(result.restored.fileName).toBe(second.created.fileName);
    expect(fs.readFileSync(dbPath, 'utf8')).toBe('version 2');
  });

  it('throws an engine-mismatch error when the selected backup engine does not match DATABASE_URL', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'sqlite-backup-20260705-150000Z.db'), 'sqlite bytes');

    expect(() =>
      restoreBackup({
        cwd,
        databaseUrl: 'postgres://user:pass@host/db',
        outputDir,
        backupFile: 'sqlite-backup-20260705-150000Z.db',
        createPreRestoreBackup: false,
        runtime: makeRuntime(),
      allowUnsafeCopy: true,
      }),
    ).toThrow(/engine mismatch/i);
  });

  it('leaves the live DB untouched and cleans up the temp file when a truncated .gz backup fails to decompress', () => {
    const cwd = makeTempDir();
    const dbPath = path.join(cwd, 'data', 'app.db');
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    const originalBytes = Buffer.from('the live database, unchanged');
    fs.writeFileSync(dbPath, originalBytes);
    const backupPath = path.join(outputDir, 'sqlite-backup-20260705-150000Z.db.gz');
    fs.writeFileSync(backupPath, 'not actually gzip data');

    expect(() =>
      restoreBackup({
        cwd,
        databaseUrl: 'file:./data/app.db',
        outputDir,
        backupFile: path.basename(backupPath),
        createPreRestoreBackup: false,
        runtime: makeRuntime(),
      allowUnsafeCopy: true,
      }),
    ).toThrow();

    expect(fs.readFileSync(dbPath).equals(originalBytes)).toBe(true);
    const remaining = fs.readdirSync(path.dirname(dbPath)).filter((name) => name.startsWith('.restore-'));
    expect(remaining).toEqual([]);
  });

  // --- P1 #7: SQLite restore validation (temp-first, non-deleting) ---

  it('fails restore when the temp file fails SQLite integrity check, leaving the live DB untouched', () => {
    const cwd = makeTempDir();
    const dbPath = path.join(cwd, 'data', 'app.db');
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    const originalBytes = Buffer.from('the live database, unchanged');
    fs.writeFileSync(dbPath, originalBytes);

    const backupPath = path.join(outputDir, 'sqlite-backup-20260705-150000Z.db');
    fs.writeFileSync(backupPath, 'a backup file (cp-fallback path, no compression)');

    const runtime = makeRuntime({
      commandExists: (command) => command === 'sqlite3',
      execFileSync: (command: string, args: string[]) => {
        if (command === 'sqlite3' && args[1] === 'PRAGMA integrity_check;') {
          return Buffer.from('*** in database main ***\nrow 1 missing from index idx') as unknown as void;
        }
        return undefined;
      },
    });

    expect(() =>
      restoreBackup({
        cwd,
        databaseUrl: 'file:./data/app.db',
        outputDir,
        backupFile: path.basename(backupPath),
        createPreRestoreBackup: false,
        runtime,
      }),
    ).toThrow(/integrity check failed/i);

    expect(fs.readFileSync(dbPath).equals(originalBytes)).toBe(true);
    const remaining = fs.readdirSync(path.dirname(dbPath)).filter((name) => name.startsWith('.restore-'));
    expect(remaining).toEqual([]);
  });
describe('restore safety: writer quiescence, rescue snapshot, fail-closed sqlite3', () => {
  // A runtime whose sqlite3 exists and whose `BEGIN EXCLUSIVE; COMMIT;` lock
  // attempt either succeeds (quiescent) or fails (a writer is "active"),
  // independent of the separate `PRAGMA integrity_check;` call the temp-file
  // verification step makes.
  function makeSqliteRuntime({ lockSucceeds }: { lockSucceeds: boolean }) {
    return makeRuntime({
      commandExists: (command) => command === 'sqlite3',
      execFileSync: (command: string, args: string[]) => {
        if (command === 'sqlite3' && args[1] === 'PRAGMA integrity_check;') {
          return Buffer.from('ok\n') as unknown as void;
        }
        if (command === 'sqlite3' && args.includes('BEGIN EXCLUSIVE; COMMIT;')) {
          if (!lockSucceeds) {
            const error = new Error('database is locked') as Error & { stderr?: Buffer };
            error.stderr = Buffer.from('Error: database is locked');
            throw error;
          }
          return undefined;
        }
        return undefined;
      },
    });
  }

  it('HEADLINE (data loss): restoring while the DB is in use aborts, and the live DB is untouched', () => {
    const cwd = makeTempDir();
    const dbPath = path.join(cwd, 'app.db');
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    const liveBytes = Buffer.from('live database bytes still being written by the app');
    fs.writeFileSync(dbPath, liveBytes);
    const backupPath = path.join(outputDir, 'sqlite-backup-20260705-150000Z.db');
    fs.writeFileSync(backupPath, 'a backup that would otherwise be restored');

    // No stopWriters given, and the exclusive-lock probe fails: quiescence
    // cannot be proven — this MUST refuse rather than destroy the live DB.
    expect(() =>
      restoreBackup({
        cwd,
        databaseUrl: 'file:./app.db',
        outputDir,
        backupFile: path.basename(backupPath),
        createPreRestoreBackup: false,
        runtime: makeSqliteRuntime({ lockSucceeds: false }),
      }),
    ).toThrow(/could not prove no writer is active/i);

    expect(fs.readFileSync(dbPath).equals(liveBytes)).toBe(true);
    // No rescue snapshot either — restore never got far enough to need one.
    expect(fs.existsSync(path.join(outputDir, '.rescue'))).toBe(false);
  });

  it('allowOnlineRestore overrides the quiescence guard (documented UNSAFE escape hatch)', () => {
    const cwd = makeTempDir();
    const dbPath = path.join(cwd, 'app.db');
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(dbPath, 'old database');
    const backupPath = path.join(outputDir, 'sqlite-backup-20260705-150000Z.db');
    fs.writeFileSync(backupPath, 'restored database');

    const result = restoreBackup({
      cwd,
      databaseUrl: 'file:./app.db',
      outputDir,
      backupFile: path.basename(backupPath),
      createPreRestoreBackup: false,
      allowOnlineRestore: true,
      runtime: makeSqliteRuntime({ lockSucceeds: false }),
    });

    expect(fs.readFileSync(dbPath, 'utf8')).toBe('restored database');
    expect(result.rescuePath).toBeTruthy();
  });

  it('stopWriters is called before the unlink, and startWriters after — including on a later failure path', () => {
    const cwd = makeTempDir();
    const dbPath = path.join(cwd, 'app.db');
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(dbPath, 'old database');
    const backupPath = path.join(outputDir, 'sqlite-backup-20260705-150000Z.db');
    fs.writeFileSync(backupPath, 'restored database');

    const calls: string[] = [];
    const result = restoreBackup({
      cwd,
      databaseUrl: 'file:./app.db',
      outputDir,
      backupFile: path.basename(backupPath),
      createPreRestoreBackup: false,
      stopWriters: () => calls.push('stop'),
      startWriters: () => calls.push('start'),
      // Lock succeeds only AFTER stopWriters would have quiesced the app —
      // this is exactly the "stopWriters proves it" path.
      runtime: makeSqliteRuntime({ lockSucceeds: true }),
    });

    expect(calls).toEqual(['stop', 'start']);
    expect(fs.readFileSync(dbPath, 'utf8')).toBe('restored database');
    expect(result.rescuePath).toBeTruthy();

    // --- now the failure path: startWriters must still run ---
    // A fresh cwd/outputDir so `.rescue` doesn't already exist as a directory
    // from the successful restore above (a file there blocks `.rescue` from
    // being created at all, forcing the rescue-snapshot step to throw — a
    // failure that happens AFTER stopWriters ran but BEFORE the live DB is
    // ever touched).
    const cwd2 = makeTempDir();
    const outputDir2 = path.join(cwd2, 'backups');
    const dbPath2 = path.join(cwd2, 'app.db');
    fs.mkdirSync(outputDir2, { recursive: true });
    fs.writeFileSync(dbPath2, 'old database again');
    const backupPath2 = path.join(outputDir2, 'sqlite-backup-20260705-150000Z.db');
    fs.writeFileSync(backupPath2, 'restored database');
    fs.writeFileSync(path.join(outputDir2, '.rescue'), 'blocking file, not a directory');

    const failCalls: string[] = [];
    expect(() =>
      restoreBackup({
        cwd: cwd2,
        databaseUrl: 'file:./app.db',
        outputDir: outputDir2,
        backupFile: path.basename(backupPath2),
        createPreRestoreBackup: false,
        stopWriters: () => failCalls.push('stop'),
        startWriters: () => failCalls.push('start'),
        runtime: makeSqliteRuntime({ lockSucceeds: true }),
      }),
    ).toThrow();

    expect(failCalls).toEqual(['stop', 'start']);
    // The live DB was never touched — the rescue step failed before the unlink.
    expect(fs.readFileSync(dbPath2, 'utf8')).toBe('old database again');
  });

  it('RESCUE SNAPSHOT: a failure after the unlink restores the live DB from the rescue copy, not left missing', () => {
    const cwd = makeTempDir();
    const dbPath = path.join(cwd, 'app.db');
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    const liveBytes = 'the live database, must survive a failed restore';
    fs.writeFileSync(dbPath, liveBytes);
    const backupPath = path.join(outputDir, 'sqlite-backup-20260705-150000Z.db');
    fs.writeFileSync(backupPath, 'restored database');

    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('simulated failure installing the restored copy');
    });

    try {
      expect(() =>
        restoreBackup({
          cwd,
          databaseUrl: 'file:./app.db',
          outputDir,
          backupFile: path.basename(backupPath),
          createPreRestoreBackup: false,
          allowOnlineRestore: true, // isolate this test to the rescue mechanism
          runtime: makeSqliteRuntime({ lockSucceeds: false }),
        }),
      ).toThrow(/simulated failure installing/);
    } finally {
      renameSpy.mockRestore();
    }

    // This is the assertion that proves data loss is impossible: the live DB
    // was unlinked mid-restore, but the catch block put the rescue copy back.
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.readFileSync(dbPath, 'utf8')).toBe(liveBytes);
  });

  it('sqlite3 absent: restore aborts (fail closed) unless skipVerify is passed', () => {
    const cwd = makeTempDir();
    const dbPath = path.join(cwd, 'app.db');
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(dbPath, 'old database');
    const backupPath = path.join(outputDir, 'sqlite-backup-20260705-150000Z.db');
    fs.writeFileSync(backupPath, 'restored database');

    expect(() =>
      restoreBackup({
        cwd,
        databaseUrl: 'file:./app.db',
        outputDir,
        backupFile: path.basename(backupPath),
        createPreRestoreBackup: false,
        runtime: makeRuntime({ commandExists: () => false }),
      }),
    ).toThrow(/sqlite3.*unavailable/i);
    expect(fs.readFileSync(dbPath, 'utf8')).toBe('old database');

    const result = restoreBackup({
      cwd,
      databaseUrl: 'file:./app.db',
      outputDir,
      backupFile: path.basename(backupPath),
      createPreRestoreBackup: false,
      skipVerify: true,
      allowOnlineRestore: true,
      runtime: makeRuntime({ commandExists: () => false }),
    });
    expect(fs.readFileSync(dbPath, 'utf8')).toBe('restored database');
    expect(result.target).toBe(dbPath);
  });

  it('detectSqliteQuiescence: a nonexistent destination is trivially quiescent; a missing sqlite3 binary is not', () => {
    const cwd = makeTempDir();
    const dbPath = path.join(cwd, 'app.db');

    expect(detectSqliteQuiescence(dbPath, makeRuntime({ commandExists: () => true })).quiescent).toBe(true);

    fs.writeFileSync(dbPath, 'exists');
    expect(detectSqliteQuiescence(dbPath, makeRuntime({ commandExists: () => false })).quiescent).toBe(false);
  });

  // restoreSqliteBackup directly (not through restoreBackup) so this exercises
  // the same quiescence guard the manual data-loss regression check patches.
  it('restoreSqliteBackup: refuses a live restore with no stopWriters and an unprovable lock', () => {
    const cwd = makeTempDir();
    const dbPath = path.join(cwd, 'app.db');
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(dbPath, 'live bytes');
    const backupPath = path.join(outputDir, 'candidate.db');
    fs.writeFileSync(backupPath, 'candidate bytes');

    expect(() =>
      restoreSqliteBackup({
        databaseUrl: 'file:./app.db',
        backupEntry: { fullPath: backupPath, compressed: false },
        cwd,
        outputDir,
        runtime: makeSqliteRuntime({ lockSucceeds: false }),
      }),
    ).toThrow(/could not prove no writer is active/i);
    expect(fs.readFileSync(dbPath, 'utf8')).toBe('live bytes');
  });
});
});
