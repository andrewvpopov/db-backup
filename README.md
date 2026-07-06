# @bewks/db-backup-manager

## Document Status
- Status: Active package reference
- Last reviewed: 2026-07-05

Reusable database backup utilities with a fixed retention strategy:

- Keep up to **6** backups total
- Keep **3 recent daily** backups
- Always keep **1 backup from last week**
- Always keep **1 backup from last month**
- Always keep **1 backup from two months ago**

## Supported databases

- SQLite (`DATABASE_URL=file:...`)
- PostgreSQL (`DATABASE_URL=postgres://...` or `postgresql://...`)

## Usage

```bash
# Create backup + apply retention policy
db-backup-manager backup --prod --output-dir /var/backups/myapp

# List backups and retention decisions
db-backup-manager list --prod --output-dir /var/backups/myapp

# Print cron entry for daily execution
db-backup-manager cron --hour 3 --minute 0

# Restore from a specific backup file
db-backup-manager restore --prod --output-dir /var/backups/myapp --file sqlite-backup-20260219-030000Z.db.gz

# Restore from the latest backup in output-dir
db-backup-manager restore --prod --output-dir /var/backups/myapp --latest
```

## Adoption recipes

### SQLite app

Set `DATABASE_URL` to a Prisma-style SQLite URL and choose a directory that is
outside your source checkout when possible:

```bash
DATABASE_URL=file:./data/app.db
db-backup-manager backup --prod --output-dir /var/backups/myapp
```

When `sqlite3` is available, backups are created with SQLite's online `.backup`
command. If `sqlite3` is not installed, the package falls back to copying the DB
file. SQLite backups are compressed with `gzip` when it is available.

Backup filenames are UTC-timestamped to the second. If another backup already
exists for the same second, the package appends a numeric suffix, such as
`sqlite-backup-20260705-150000Z-2.db.gz`, rather than overwriting the existing
file.

### PostgreSQL app

Set `DATABASE_URL` to a Postgres connection string:

```bash
DATABASE_URL=postgresql://user:password@db.example.com:5432/myapp
db-backup-manager backup --prod --output-dir /var/backups/myapp
```

PostgreSQL backups require `pg_dump`. Restores require `pg_restore`.
Same-second PostgreSQL backups use the same numeric suffix pattern, such as
`postgres-backup-20260705-150000Z-2.dump`.

### Daily cron

Generate a starter cron entry:

```bash
db-backup-manager cron --hour 3 --minute 0
```

For an app-specific script, prefer a command that changes into the deployed app
directory and writes logs next to the backup directory:

```cron
0 3 * * * /usr/bin/env bash -lc 'cd "/srv/myapp" && npm run db:backup -- --prod --output-dir "/var/backups/myapp" >> "/var/backups/myapp/backup.log" 2>&1'
```

## Environment resolution

The package can read `DATABASE_URL` directly from the process environment, or it
can load env files relative to `cwd`.

- Base file: `.env`
- Dev file: `.env.local`
- Prod file: `.env.production`

Base env is loaded first; mode-specific env is loaded second and overrides base
values. In production mode, `DATABASE_URL` must either be exported in the shell
before the process starts or be present in `.env.production`, unless
`strictProductionEnv: false` is passed programmatically.

## Programmatic API

```js
const {
  runBackupJob,
  listBackupsWithPlan,
  restoreBackup,
  DEFAULT_RETENTION_POLICY,
} = require('@bewks/db-backup-manager');

const result = runBackupJob({
  mode: 'prod',
  outputDir: '/var/backups/myapp',
});

console.log(result.created.fileName);

const restored = restoreBackup({
  mode: 'prod',
  outputDir: '/var/backups/myapp',
  backupFile: 'sqlite-backup-20260219-030000Z.db.gz',
});

console.log(restored.target);
```

### Runtime injection for tests and hosted environments

Most apps should not pass `runtime`. It exists for deterministic tests and for
hosts that need to wrap command execution:

```js
runBackupJob({
  databaseUrl: 'postgresql://user:password@db.example.com/myapp',
  outputDir: '/var/backups/myapp',
  runtime: {
    now: () => new Date('2026-07-05T03:00:00.000Z'),
    commandExists: (command) => command === 'pg_dump',
    execFileSync: (command, args, options) => {
      // Run, log, sandbox, or fake command execution here.
    },
  },
});
```

The default runtime uses Node's `child_process.execFileSync`, checks commands via
`command -v`, sleeps between locked-SQLite retries, and reads the current time
from `new Date()`.

## Restore behavior

- `restore` requires `--file <name|path>` or `--latest`.
- By default, a safety backup is created before restore.
- Disable safety backup with `--no-pre-backup`.
- SQLite restore replaces the configured DB file.
- PostgreSQL restore uses `pg_restore --clean --if-exists --single-transaction`.
- PostgreSQL restore targets are redacted in return values so passwords are not
  echoed in logs.

After restore, restart the application before serving traffic.

## What stays app-specific

The package does not decide where backups should live, who can trigger them, or
how a web UI should present them. In Bewks, those concerns live in the admin
controller and settings layer; other apps should keep the same adapter boundary.
