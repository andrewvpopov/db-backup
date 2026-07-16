import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { dbBackup, fixedNow, makeTempDir, makeRuntime, cleanupTempDirs, backupEntry } from './helpers';

const {
  DEFAULT_RETENTION_POLICY,
  buildGfsAnchors,
  listBackupsWithPlan,
  pruneBackupsJob,
  resolveRetentionPolicy,
  planRetention,
  runCli,
} = dbBackup;

afterEach(() => {
  cleanupTempDirs();
});

describe('@andrewpopov/db-backup — retention (age-tier, keep-last/keep-days, GFS, listBackupsWithPlan, pruneBackupsJob)', () => {
  it('plans retention with recent daily slots plus anchor backups', () => {
    const backups = [
      backupEntry('day-0.db.gz', 0),
      backupEntry('day-1.db.gz', 1),
      backupEntry('day-2.db.gz', 2),
      backupEntry('day-8.db.gz', 8),
      backupEntry('day-31.db.gz', 31),
      backupEntry('day-61.db.gz', 61),
      backupEntry('day-90.db.gz', 90),
    ];

    const plan = planRetention(backups, DEFAULT_RETENTION_POLICY, fixedNow);

    expect(plan.keep.map((entry) => [entry.fileName, entry.retentionReason])).toEqual([
      ['day-0.db.gz', 'daily'],
      ['day-1.db.gz', 'daily'],
      ['day-2.db.gz', 'daily'],
      ['day-8.db.gz', 'last_week'],
      ['day-31.db.gz', 'last_month'],
      ['day-61.db.gz', 'two_months_ago'],
    ]);
    expect(plan.remove.map((entry) => entry.fileName)).toEqual(['day-90.db.gz']);
  });

  it('age-tier plan is unchanged when the policy carries an explicit mode', () => {
    // Golden guard: a policy with mode:'age-tier' must produce the identical
    // keep/remove split (order, reasons, labels) as the mode-less default.
    const backups = [
      backupEntry('day-0.db.gz', 0),
      backupEntry('day-1.db.gz', 1),
      backupEntry('day-2.db.gz', 2),
      backupEntry('day-8.db.gz', 8),
      backupEntry('day-31.db.gz', 31),
      backupEntry('day-61.db.gz', 61),
      backupEntry('day-90.db.gz', 90),
    ];

    const base = planRetention(backups, DEFAULT_RETENTION_POLICY, fixedNow);
    const explicit = planRetention(
      backups,
      { ...DEFAULT_RETENTION_POLICY, mode: 'age-tier' },
      fixedNow,
    );

    expect(explicit.keep.map((e) => [e.fileName, e.retentionReason, e.retentionLabel])).toEqual(
      base.keep.map((e) => [e.fileName, e.retentionReason, e.retentionLabel]),
    );
    expect(explicit.remove.map((e) => [e.fileName, e.retentionReason])).toEqual(
      base.remove.map((e) => [e.fileName, e.retentionReason]),
    );
  });

  it('the default policy keeps its exact shape — no `mode` key leaks into plan.policy', () => {
    // Hard compat requirement: consumers serialize plan.policy, so adding a
    // `mode` field to DEFAULT_RETENTION_POLICY would change their JSON output.
    expect(Object.keys(DEFAULT_RETENTION_POLICY).sort()).toEqual([
      'anchors',
      'dailySlots',
      'maxBackups',
    ]);
    expect('mode' in DEFAULT_RETENTION_POLICY).toBe(false);

    const plan = planRetention([backupEntry('day-0.db', 0)], DEFAULT_RETENTION_POLICY, fixedNow);
    expect(plan.policy).toBe(DEFAULT_RETENTION_POLICY);
    expect(JSON.parse(JSON.stringify(plan.policy))).not.toHaveProperty('mode');

    // resolveRetentionPolicy with no overrides returns the shared default object.
    expect(resolveRetentionPolicy()).toBe(DEFAULT_RETENTION_POLICY);
  });

  it('an empty-string retention option means "absent" (pre-existing contract)', () => {
    // readInt() has always treated '' as not-provided, because callers pass raw
    // env values through. Pinned here because it decides which mode is selected.
    expect(resolveRetentionPolicy({ maxBackups: '' })).toBe(DEFAULT_RETENTION_POLICY);
    expect(resolveRetentionPolicy({ keepLast: '' })).toBe(DEFAULT_RETENTION_POLICY);

    // An absent explicit option therefore lets a flat-mode env var win — which is
    // why the typed overloads only narrow on a `number` discriminator.
    expect(resolveRetentionPolicy({ maxBackups: '', env: { DB_BACKUP_KEEP_LAST: '8' } })).toEqual({
      mode: 'keep-last',
      keepLast: 8,
    });
    expect(resolveRetentionPolicy({ keepLast: '', env: { DB_BACKUP_MAX_BACKUPS: '99' } })).toMatchObject(
      { maxBackups: 99 },
    );
  });

  it('keep-last retains the N most-recent backups', () => {
    const backups = [
      backupEntry('day-0.db', 0),
      backupEntry('day-1.db', 1),
      backupEntry('day-9.db', 9),
      backupEntry('day-40.db', 40),
      backupEntry('day-99.db', 99),
    ];

    const plan = planRetention(backups, { mode: 'keep-last', keepLast: 2 }, fixedNow);

    expect(plan.keep.map((e) => [e.fileName, e.retentionReason])).toEqual([
      ['day-0.db', 'keep_last'],
      ['day-1.db', 'keep_last'],
    ]);
    expect(plan.remove.map((e) => e.fileName)).toEqual(['day-9.db', 'day-40.db', 'day-99.db']);
  });

  it('keep-days retains backups younger than the window', () => {
    const backups = [
      backupEntry('day-0.db', 0),
      backupEntry('day-6.db', 6),
      backupEntry('day-7.db', 7),
      backupEntry('day-20.db', 20),
    ];

    const plan = planRetention(backups, { mode: 'keep-days', keepDays: 7 }, fixedNow);

    // Strictly younger than 7 days: day-0 and day-6 stay; day-7 (exactly at the
    // boundary) and day-20 rotate out.
    expect(plan.keep.map((e) => e.fileName)).toEqual(['day-0.db', 'day-6.db']);
    expect(plan.keep.every((e) => e.retentionReason === 'keep_days')).toBe(true);
    expect(plan.remove.map((e) => e.fileName)).toEqual(['day-7.db', 'day-20.db']);
  });

  it('keep-days always keeps the most-recent backup even past the window (age guard)', () => {
    const backups = [backupEntry('old-30.db', 30), backupEntry('old-45.db', 45)];

    const plan = planRetention(backups, { mode: 'keep-days', keepDays: 7 }, fixedNow);

    expect(plan.keep.map((e) => [e.fileName, e.retentionReason])).toEqual([['old-30.db', 'newest']]);
    expect(plan.remove.map((e) => e.fileName)).toEqual(['old-45.db']);
  });

  it('flat modes handle an empty backup list without error', () => {
    expect(planRetention([], { mode: 'keep-last', keepLast: 3 }, fixedNow)).toMatchObject({
      keep: [],
      remove: [],
    });
    expect(planRetention([], { mode: 'keep-days', keepDays: 5 }, fixedNow)).toMatchObject({
      keep: [],
      remove: [],
    });
  });

  it('keep-days clamps a future-dated backup to now (no negative age)', () => {
    const backups = [
      backupEntry('future.db', -5), // 5 days in the future (clock skew)
      backupEntry('day-2.db', 2),
      backupEntry('day-10.db', 10),
    ];

    const plan = planRetention(backups, { mode: 'keep-days', keepDays: 7 }, fixedNow);

    // future.db clamps to age 0 (kept); day-2 kept; day-10 rotates out.
    expect(plan.keep.map((e) => e.fileName).sort()).toEqual(['day-2.db', 'future.db']);
    expect(plan.remove.map((e) => e.fileName)).toEqual(['day-10.db']);
  });

  it('resolveRetentionPolicy selects flat modes from args and env', () => {
    expect(resolveRetentionPolicy({ keepLast: 5 })).toEqual({ mode: 'keep-last', keepLast: 5 });
    expect(resolveRetentionPolicy({ keepDays: 14 })).toEqual({ mode: 'keep-days', keepDays: 14 });
    expect(resolveRetentionPolicy({ env: { DB_BACKUP_KEEP_LAST: '8' } })).toEqual({
      mode: 'keep-last',
      keepLast: 8,
    });
    // Explicit arg wins over env of either mode.
    expect(resolveRetentionPolicy({ keepDays: 3, env: { DB_BACKUP_KEEP_LAST: '8' } })).toEqual({
      mode: 'keep-days',
      keepDays: 3,
    });
  });

  it('an explicit age-tier arg beats a stale flat-mode env var', () => {
    // Regression: a stale DB_BACKUP_KEEP_LAST must not silently override an
    // explicit --max-backups and switch the whole policy to keep-last.
    const policy = resolveRetentionPolicy({
      maxBackups: 9,
      env: { DB_BACKUP_KEEP_LAST: '8' },
    });

    expect(policy).toMatchObject({ maxBackups: 9 });
    expect('mode' in policy && policy.mode).not.toBe('keep-last');
  });

  it('an explicit flat arg beats a stale age-tier env var', () => {
    const policy = resolveRetentionPolicy({
      keepDays: 3,
      env: { DB_BACKUP_MAX_BACKUPS: '99', DB_BACKUP_DAILY_SLOTS: '9' },
    });

    expect(policy).toEqual({ mode: 'keep-days', keepDays: 3 });
  });

  it('resolveRetentionPolicy rejects invalid or conflicting flat options', () => {
    expect(() => resolveRetentionPolicy({ keepLast: 0 })).toThrow(/keepLast/);
    expect(() => resolveRetentionPolicy({ keepDays: 0 })).toThrow(/keepDays/);
    expect(() => resolveRetentionPolicy({ keepLast: 2, keepDays: 2 })).toThrow(/mutually exclusive/);
    expect(() =>
      resolveRetentionPolicy({ env: { DB_BACKUP_KEEP_LAST: '2', DB_BACKUP_KEEP_DAYS: '2' } }),
    ).toThrow(/mutually exclusive/);
    expect(() => resolveRetentionPolicy({ keepLast: 2, maxBackups: 4 })).toThrow(
      /cannot be combined/,
    );
  });


  it('lists only supported backup filenames and annotates retention decisions', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'sqlite-backup-20260705-150000Z.db'), 'sqlite');
    fs.writeFileSync(path.join(outputDir, 'sqlite-backup-20260705-150000Z-2.db'), 'sqlite again');
    fs.writeFileSync(path.join(outputDir, 'notes.txt'), 'ignore me');

    const result = listBackupsWithPlan({
      cwd,
      databaseUrl: 'file:./app.db',
      outputDir,
      runtime: makeRuntime(),
      allowUnsafeCopy: true,
    });

    expect(result.backups).toHaveLength(2);
    expect(result.backups[0]).toMatchObject({
      fileName: 'sqlite-backup-20260705-150000Z-2.db',
      keep: true,
      retentionReason: 'daily',
    });
    expect(result.backups[1]).toMatchObject({
      fileName: 'sqlite-backup-20260705-150000Z.db',
      keep: true,
      retentionReason: 'daily',
    });
  });

  it('lists backups without a DATABASE_URL (list never opens the database)', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'sqlite-backup-20260705-150000Z.db'), 'sqlite');

    const originalUrl = process.env.DATABASE_URL;
    try {
      delete process.env.DATABASE_URL;
      const result = listBackupsWithPlan({ cwd, outputDir, runtime: makeRuntime() });
      expect(result.backups).toHaveLength(1);
    } finally {
      if (originalUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalUrl;
    }
  });

  it('resolveRetentionPolicy prefers CLI args over env, and env over the default', () => {
    expect(resolveRetentionPolicy()).toBe(DEFAULT_RETENTION_POLICY);

    const fromEnv = resolveRetentionPolicy({
      env: { DB_BACKUP_MAX_BACKUPS: '4', DB_BACKUP_DAILY_SLOTS: '1' },
    });
    expect(fromEnv.maxBackups).toBe(4);
    expect(fromEnv.dailySlots).toBe(1);
    expect(fromEnv.anchors).toEqual(DEFAULT_RETENTION_POLICY.anchors);

    const argsWin = resolveRetentionPolicy({
      maxBackups: 9,
      env: { DB_BACKUP_MAX_BACKUPS: '4', DB_BACKUP_DAILY_SLOTS: '1' },
    });
    expect(argsWin.maxBackups).toBe(9);
    expect(argsWin.dailySlots).toBe(1);

    expect(() => resolveRetentionPolicy({ maxBackups: 0 })).toThrow(/maxBackups/);
    expect(() => resolveRetentionPolicy({ env: { DB_BACKUP_MAX_BACKUPS: 'x' } })).toThrow(
      /DB_BACKUP_MAX_BACKUPS/,
    );
    // Strict: fractional/suffixed strings are rejected, not silently truncated.
    expect(() => resolveRetentionPolicy({ maxBackups: '1.5' })).toThrow(/maxBackups/);
    expect(() => resolveRetentionPolicy({ env: { DB_BACKUP_DAILY_SLOTS: '3x' } })).toThrow(
      /DB_BACKUP_DAILY_SLOTS/,
    );
  });

  it('rejects fractional/suffixed --max-backups on the CLI instead of truncating', async () => {
    const outputDir = makeTempDir();
    await expect(runCli(['list', '--output-dir', outputDir, '--max-backups', '2x'])).rejects.toThrow(
      /--max-backups/,
    );
  });

  it('pruneBackupsJob deletes overflow backups to the policy without creating one', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    // Four consecutive daily snapshots, newest first.
    const files = [
      'sqlite-backup-20260705-150000Z.db',
      'sqlite-backup-20260704-150000Z.db',
      'sqlite-backup-20260703-150000Z.db',
      'sqlite-backup-20260702-150000Z.db',
    ];
    for (const name of files) {
      fs.writeFileSync(path.join(outputDir, name), 'sqlite');
    }

    const originalUrl = process.env.DATABASE_URL;
    try {
      delete process.env.DATABASE_URL; // prune must not require it
      const result = pruneBackupsJob({
        cwd,
        outputDir,
        runtime: makeRuntime(),
      allowUnsafeCopy: true,
        policy: resolveRetentionPolicy({ maxBackups: 2, dailySlots: 2 }),
      });

      expect(result.kept.map((entry) => entry.fileName)).toEqual([
        'sqlite-backup-20260705-150000Z.db',
        'sqlite-backup-20260704-150000Z.db',
      ]);
      expect(result.removed.map((entry) => entry.fileName)).toEqual([
        'sqlite-backup-20260703-150000Z.db',
        'sqlite-backup-20260702-150000Z.db',
      ]);
      // The overflow files are actually gone from disk; the kept ones remain.
      expect(fs.readdirSync(outputDir).sort()).toEqual([
        'sqlite-backup-20260704-150000Z.db',
        'sqlite-backup-20260705-150000Z.db',
      ]);
    } finally {
      if (originalUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalUrl;
    }
  });

  // --- P0 #3: retention edges on planRetention ---

  it('planRetention: dailySlots > maxBackups keeps only maxBackups worth of dailies', () => {
    const backups = [
      backupEntry('day-0.db.gz', 0),
      backupEntry('day-1.db.gz', 1),
      backupEntry('day-2.db.gz', 2),
      backupEntry('day-3.db.gz', 3),
    ];
    const policy = { ...DEFAULT_RETENTION_POLICY, maxBackups: 2, dailySlots: 10 };

    const plan = planRetention(backups, policy, fixedNow);

    expect(plan.keep.map((entry) => entry.fileName)).toEqual(['day-0.db.gz', 'day-1.db.gz']);
    expect(plan.remove.map((entry) => entry.fileName)).toEqual(['day-2.db.gz', 'day-3.db.gz']);
  });

  it('planRetention: an empty backup list keeps and removes nothing', () => {
    const plan = planRetention([], DEFAULT_RETENTION_POLICY, fixedNow);
    expect(plan.keep).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it('planRetention: a future-dated (clock-skewed) backup cannot starve the newest real daily slot', () => {
    // Both effective (clamped) times tie at `fixedNow`: the future entry's raw
    // createdAt is capped down to `fixedNow`, and the just-created real entry's
    // createdAt IS `fixedNow`. Array.prototype.sort is stable (ES2019+), so with
    // the real entry listed first, the tie resolves in its favor — daily slot 1
    // goes to the real backup, not the clock-skewed one.
    const realSlot1 = backupEntry('day-0.db.gz', 0);
    const future = backupEntry('future.db.gz', -30); // createdAt ~30 days ahead of "now"
    const day1 = backupEntry('day-1.db.gz', 1);
    const day8 = backupEntry('day-8.db.gz', 8);

    const plan = planRetention([realSlot1, future, day1, day8], DEFAULT_RETENTION_POLICY, fixedNow);

    expect(plan.keep[0].fileName).toBe('day-0.db.gz');
    expect(plan.keep[0].retentionReason).toBe('daily');
    expect(plan.keep.some((entry) => entry.retentionReason === 'last_week' && entry.fileName === 'day-8.db.gz')).toBe(
      true,
    );
  });

  // ---------------------------------------------------------------------------
  // GFS (grandfather-father-son) retention — expressed as slots (daily) plus
  // generated anchors (weekly/monthly/yearly), the SAME selection engine the
  // legacy age-tier policy uses (selectSlotsAndAnchors). See buildGfsAnchors.
  // ---------------------------------------------------------------------------
  describe('GFS retention (mode: "gfs")', () => {
    it('keeps the exact set a 3-year GFS policy implies, deduping buckets a broader tier already satisfied', () => {
      // policy: 3 daily slots, one per week for 3 weeks, one per month (2
      // buckets), one per year for 3 years (~1095 days).
      const policy = { mode: 'gfs' as const, daily: 3, weekly: 3, monthly: 2, yearly: 3 };
      const backups = [
        backupEntry('d0.db', 0), // daily slot 1
        backupEntry('d1.db', 1), // daily slot 2
        backupEntry('d2.db', 2), // daily slot 3
        backupEntry('w10.db', 10), // weekly bucket 2 ([7,14))
        backupEntry('w17.db', 17), // weekly bucket 3 ([14,21))
        backupEntry('m45.db', 45), // monthly bucket 2 ([30,60))
        backupEntry('y400.db', 400), // yearly bucket 2 ([365,730))
        backupEntry('y1000.db', 1000), // yearly bucket 3 ([730,1095))
        backupEntry('ancient.db', 1200), // outside every bucket -> pruned
      ];

      const plan = planRetention(backups, policy, fixedNow);

      // weekly bucket 1 ([0,7)), monthly bucket 1 ([0,30)), and yearly bucket 1
      // ([0,365)) all only contain backups the daily/weekly tiers already kept
      // — so they contribute NO additional entry. This is the "kept once, not
      // double-counted" boundary: d0 is simultaneously the newest daily AND
      // would be weekly bucket 1's pick, but appears once, reason 'daily'.
      expect(plan.keep.map((e) => [e.fileName, e.retentionReason])).toEqual([
        ['d0.db', 'daily'],
        ['d1.db', 'daily'],
        ['d2.db', 'daily'],
        ['w10.db', 'weekly_2'],
        ['w17.db', 'weekly_3'],
        ['m45.db', 'monthly_2'],
        ['y400.db', 'yearly_2'],
        ['y1000.db', 'yearly_3'],
      ]);
      expect(plan.remove.map((e) => e.fileName)).toEqual(['ancient.db']);
      // No filename appears in both keep and remove, and no filename is kept twice.
      const keptNames = plan.keep.map((e) => e.fileName);
      expect(new Set(keptNames).size).toBe(keptNames.length);
    });

    it('picks the NEWEST backup within a weekly bucket, not the closest chronologically-first one', () => {
      const policy = { mode: 'gfs' as const, daily: 0, weekly: 1, monthly: 0, yearly: 0 };
      // Both fall inside weekly bucket 1 ([0,7)); the newer one must win.
      const backups = [backupEntry('older.db', 5), backupEntry('newer.db', 2)];

      const plan = planRetention(backups, policy, fixedNow);

      expect(plan.keep.map((e) => e.fileName)).toEqual(['newer.db']);
      // older.db is not the overall newest either, so the safety guard doesn't
      // rescue it — it is genuinely pruned.
      expect(plan.remove.map((e) => e.fileName)).toEqual(['older.db']);
    });

    it('a --retention-policy-style custom anchors list is honored over generated weekly/monthly/yearly buckets', () => {
      const policy = {
        mode: 'gfs' as const,
        daily: 1,
        anchors: [{ key: 'quarter', label: 'One quarter ago', minAgeDays: 80, maxAgeDays: 100, targetAgeDays: 90 }],
      };
      const backups = [backupEntry('now.db', 0), backupEntry('q.db', 90), backupEntry('outside.db', 200)];

      const plan = planRetention(backups, policy, fixedNow);

      expect(plan.keep.map((e) => [e.fileName, e.retentionReason])).toEqual([
        ['now.db', 'daily'],
        ['q.db', 'quarter'],
      ]);
      expect(plan.remove.map((e) => e.fileName)).toEqual(['outside.db']);
    });

    it('buildGfsAnchors generates non-overlapping, minAgeDays-targeted buckets per tier', () => {
      const anchors = buildGfsAnchors({ weekly: 2, monthly: 1, yearly: 0 });
      expect(anchors).toEqual([
        { key: 'weekly_1', label: 'Weekly slot 1', minAgeDays: 0, maxAgeDays: 7, targetAgeDays: 0 },
        { key: 'weekly_2', label: 'Weekly slot 2', minAgeDays: 7, maxAgeDays: 14, targetAgeDays: 7 },
        { key: 'monthly_1', label: 'Monthly slot 1', minAgeDays: 0, maxAgeDays: 30, targetAgeDays: 0 },
      ]);
    });
  });

  describe('destructive-operation safety guards (planRetention)', () => {
    it('NEVER prunes the newest backup, even under a policy whose own selection excludes it', () => {
      // Every anchor window here excludes age 0 (the newest backup) on
      // purpose — the global safety guard must still keep it.
      const policy = {
        mode: 'gfs' as const,
        daily: 0,
        anchors: [{ key: 'old_only', label: 'Old only', minAgeDays: 100, maxAgeDays: 200, targetAgeDays: 100 }],
      };
      const backups = [backupEntry('newest.db', 0), backupEntry('old.db', 150)];

      const plan = planRetention(backups, policy, fixedNow);

      expect(plan.keep.map((e) => e.fileName).sort()).toEqual(['newest.db', 'old.db']);
      expect(plan.remove).toEqual([]);
      const newestEntry = plan.keep.find((e) => e.fileName === 'newest.db');
      expect(newestEntry?.retentionReason).toBe('newest');
    });

    it('a policy that would prune every backup THROWS rather than emptying the directory', () => {
      const backups = [backupEntry('a.db', 10), backupEntry('b.db', 20)];
      // mode 'gfs' with every count at its default (0/undefined) and no
      // anchors selects nothing.
      expect(() => planRetention(backups, { mode: 'gfs' }, fixedNow)).toThrow(/would prune every/i);
    });

    it('an empty backup list never throws (nothing to prune, nothing to protect)', () => {
      expect(() => planRetention([], { mode: 'gfs', daily: 0 }, fixedNow)).not.toThrow();
    });

    it('is deterministic: identical inputs and `now` produce an identical plan', () => {
      const policy = { mode: 'gfs' as const, daily: 2, weekly: 2, monthly: 1, yearly: 1 };
      const backups = [
        backupEntry('a.db', 0),
        backupEntry('b.db', 1),
        backupEntry('c.db', 9),
        backupEntry('d.db', 40),
        backupEntry('e.db', 400),
      ];

      const planA = planRetention(backups, policy, fixedNow);
      const planB = planRetention(backups, policy, fixedNow);

      expect(JSON.stringify(planA.keep)).toBe(JSON.stringify(planB.keep));
      expect(JSON.stringify(planA.remove)).toBe(JSON.stringify(planB.remove));
    });
  });

  describe('resolveRetentionPolicy: GFS flags and mutual exclusion', () => {
    it('builds a gfs policy from --retain-* style args', () => {
      expect(
        resolveRetentionPolicy({ retainDaily: 7, retainWeekly: 4, retainMonthly: 12, retainYearly: 2 }),
      ).toEqual({ mode: 'gfs', daily: 7, weekly: 4, monthly: 12, yearly: 2 });
    });

    it('a full custom policy file (retentionPolicyFile) is passed through as-is', () => {
      const custom = { mode: 'age-tier', maxBackups: 9, dailySlots: 4, anchors: [] };
      expect(resolveRetentionPolicy({ retentionPolicyFile: custom })).toBe(custom);
    });

    it('legacy retention flags (keep-last/keep-days/age-tier) still resolve exactly as before GFS existed', () => {
      expect(resolveRetentionPolicy({ keepLast: 5 })).toEqual({ mode: 'keep-last', keepLast: 5 });
      expect(resolveRetentionPolicy({ maxBackups: 8, dailySlots: 2 })).toMatchObject({ maxBackups: 8, dailySlots: 2 });
      expect(resolveRetentionPolicy()).toBe(DEFAULT_RETENTION_POLICY);
    });

    it('GFS flags combined with legacy retention flags is an ERROR, not a silent pick', () => {
      expect(() => resolveRetentionPolicy({ retainDaily: 5, keepLast: 3 })).toThrow(/cannot be combined/);
      expect(() => resolveRetentionPolicy({ retainWeekly: 2, maxBackups: 6 })).toThrow(/cannot be combined/);
    });

    it('a retentionPolicyFile combined with ANY other retention flag is an ERROR', () => {
      const custom = { mode: 'gfs', daily: 1 };
      expect(() => resolveRetentionPolicy({ retentionPolicyFile: custom, keepLast: 3 })).toThrow(
        /cannot be combined/,
      );
      expect(() => resolveRetentionPolicy({ retentionPolicyFile: custom, retainDaily: 2 })).toThrow(
        /cannot be combined/,
      );
    });
  });
});
