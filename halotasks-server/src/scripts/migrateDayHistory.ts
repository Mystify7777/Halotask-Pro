import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import DayHistory from '../models/DayHistory.model';
import { migrateDayHistory, supportsTransactions, type MigrationOptions } from '../utils/completionMigration';

// Issue #47, Phase 2B: migrate legacy DayHistory rows into CompletionRecord.
//
//   npm run build && npm run migrate:history                       dry run (default): reads and reports, writes nothing
//   npm run build && npm run migrate:history -- --apply            writes the missing migrated records
//   ... -- --user=<userId>                                         one account only
//   ... -- --include-writable-days                                 ALSO the last 7 local days. Only after legacy history
//                                                                  writes are retired: see utils/completionMigration.ts.
// Safe to rerun at any time: records have deterministic ids, a day that has any record is never touched, DayHistory is never modified.
// --apply needs a replica set or mongos (every day is written in one transaction, so a day is never left partly migrated).

export type CliArgs = Pick<MigrationOptions, 'apply' | 'includeWritableDays'> & { userId?: string };

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { apply: false, includeWritableDays: false };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg === '--include-writable-days') args.includeWritableDays = true;
    else if (arg.startsWith('--user=')) {
      const id = arg.slice('--user='.length);
      if (!/^[a-f0-9]{24}$/i.test(id)) throw new Error('--user must be a 24-character hex user id');
      args.userId = id;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.includeWritableDays) {
    const bar = '!'.repeat(78);
    console.error(
      `${bar}\n!! --include-writable-days: this also migrates the last 7 local days, which legacy clients can still write.\n` +
        `!! A legacy history write to a day that becomes canonical is IGNORED from then on. Only continue if legacy\n` +
        `!! history writes are retired (Issue #47 Phase 2C).\n${bar}`,
    );
  }
  await connectDB();
  try {
    if (args.apply) {
      // Each day is written in one transaction (all of its records or none): refuse where that is impossible.
      const hello = await mongoose.connection.db?.admin().command({ hello: 1 });
      if (!supportsTransactions(hello)) {
        console.error('[migrate:history] refusing to --apply: this MongoDB is not a replica set or mongos, so a day cannot be written atomically. Nothing was written.');
        return 1;
      }
    }
    const filter = args.userId ? { userId: args.userId } : {};
    const cursor = DayHistory.find(filter).sort({ userId: 1, date: 1 }).lean().cursor();
    const report = await migrateDayHistory(cursor, { apply: args.apply, includeWritableDays: args.includeWritableDays });
    console.log(JSON.stringify(report, null, 2));
    return report.rowsFailed > 0 ? 1 : 0;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error('[migrate:history] failed:', error instanceof Error ? error.name : 'unknown error');
      process.exit(1);
    },
  );
}
