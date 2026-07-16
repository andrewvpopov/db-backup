import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { dbBackup, fixedNow, makeTempDir, makeRuntime, cleanupTempDirs } from './helpers';

const {
  restoreBackup,
} = dbBackup;

afterEach(() => {
  cleanupTempDirs();
});

describe('@andrewpopov/db-backup — encryption at rest (gpg)', () => {
  it('encryption refuses rather than writing an unencrypted backup when gpg is missing', () => {
    const dir = makeTempDir();
    const passphraseFile = path.join(dir, 'pass');
    fs.writeFileSync(passphraseFile, 'secret');
    const entry = { fileName: 'x.db', fullPath: path.join(dir, 'x.db'), sizeBytes: 3 } as never;
    fs.writeFileSync(path.join(dir, 'x.db'), 'db');

    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (require('../index.js') as any).encryptBackupEntry(
        entry,
        { passphraseFile },
        makeRuntime({ commandExists: () => false }),
      ),
    ).toThrow(/gpg.*unavailable/i);
  });

  it('restoring an encrypted backup without a passphrase fails loudly', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(path.join(cwd, 'data'), { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'sqlite-backup-20260705-150000Z.db.gpg'), 'ciphertext');

    expect(() =>
      restoreBackup({
        cwd,
        databaseUrl: 'file:./data/app.db',
        outputDir,
        backupFile: 'sqlite-backup-20260705-150000Z.db.gpg',
        createPreRestoreBackup: false,
        runtime: makeRuntime(),
      }),
    ).toThrow(/encrypted; encryption.passphraseFile is required/);
  });
});
