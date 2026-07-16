// Shared test fixtures for the split test-suite (see PKG-28). Every file below
// imports what it needs from here rather than redeclaring it — keep this file
// the single source of truth for makeTempDir/makeRuntime/fixedNow/backupEntry
// and the `require('../index.js')` module handle.
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

// A single untyped require of the whole module. Each test file destructures
// only the exports it actually uses from this, e.g.:
//   const { runBackupJob, planRetention } = dbBackup;
export const dbBackup = require('../index.js') as typeof import('../index');

export const fixedNow = new Date('2026-07-05T15:00:00.000Z');

// Every temp dir created via makeTempDir across a test file is removed by
// that file's own `afterEach` (see the boilerplate each spec file repeats —
// tempDirs itself is per-module-instance since vitest gives each test file
// its own module graph).
export const tempDirs: string[] = [];

export function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-backup-'));
  tempDirs.push(dir);
  return dir;
}

export function makeRuntime(overrides: Partial<{
  commandExists: (command: string) => boolean;
  execFileSync: (command: string, args: string[], options?: unknown) => void;
  sleep: (ms: number) => void;
  now: () => Date;
  randomId: () => string;
}> = {}) {
  return {
    commandExists: () => false,
    execFileSync: () => undefined,
    sleep: () => undefined,
    now: () => fixedNow,
    randomId: () => 'fixed-restore-id',
    ...overrides,
  };
}

export function backupEntry(fileName: string, ageDays: number) {
  const createdAt = new Date(fixedNow.getTime() - ageDays * 24 * 60 * 60 * 1000).toISOString();

  return {
    fileName,
    fullPath: `/backups/${fileName}`,
    engine: 'sqlite' as const,
    compressed: true,
    createdAt,
    sizeBytes: 128,
  };
}

export function cleanupTempDirs() {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
