/**
 * Screen-history storage and the three month retention limit.
 *
 *   npm run historytest
 *
 * This is the module that DELETES your data, so the tests lean hard on the
 * boundary: nothing inside the window may be removed, and nothing outside it
 * may survive.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  append, dayKey, dayStart, dayEnd, listDays, loadRange, loadAll,
  prune, usage, migrateLegacy, historyDir, RETENTION_DAYS,
} from "./frontier/history.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

const DAY = 86_400_000;
const roots: string[] = [];
const newRoot = () => {
  const r = mkdtempSync(join(tmpdir(), "jarvis-history-"));
  roots.push(r);
  return r;
};

// A fixed point in local time, so the day-boundary tests are not at the mercy
// of when the suite happens to run.
const NOW = new Date(2026, 6, 21, 15, 0, 0).getTime(); // 21 Jul 2026, 3pm local

console.log("\nScreen history\n");

console.log("  days are local days");
{
  // 11pm local must belong to today, not tomorrow. A UTC key would move the
  // whole evening into the next day for anyone east of Greenwich, so "what did
  // I do yesterday" would miss the evening you actually mean.
  const lateNight = new Date(2026, 6, 21, 23, 30).getTime();
  ok(dayKey(lateNight) === "2026-07-21", `11:30pm stays on its own day (${dayKey(lateNight)})`);
  const earlyMorning = new Date(2026, 6, 21, 0, 15).getTime();
  ok(dayKey(earlyMorning) === "2026-07-21", "and 00:15 does too");
  ok(dayStart("2026-07-21") <= lateNight && lateNight <= dayEnd("2026-07-21"),
     "a day's bounds contain its own timestamps");
  ok(dayEnd("2026-07-21") + 1 === dayStart("2026-07-22"), "days meet with no gap between them");
}

console.log("  writing and reading back");
{
  const root = newRoot();
  append(root, { timestamp: NOW, text: "hello from today" });
  append(root, { timestamp: NOW - 2 * DAY, text: "two days back" });
  append(root, { timestamp: NOW, text: "today again" });

  ok(listDays(root).length === 2, `two distinct days on disk (${listDays(root).length})`);
  ok(listDays(root)[0] < listDays(root)[1], "days come back oldest first");
  ok(loadAll(root).length === 3, "every row survives the round trip");
  ok(loadAll(root)[0].text === "two days back", "rows come back in time order across files");
}

console.log("  a window only opens the files it needs");
{
  const root = newRoot();
  for (let d = 0; d < 10; d++) append(root, { timestamp: NOW - d * DAY, text: `day ${d}` });

  const recent = loadRange(root, NOW - 2 * DAY, NOW);
  ok(recent.length === 3, `three days back returns three rows (${recent.length})`);
  ok(recent.every((r) => r.timestamp >= NOW - 2 * DAY), "and nothing older leaks in");
  ok(loadRange(root, NOW + DAY, NOW + 2 * DAY).length === 0, "a window in the future is empty, not an error");
}

console.log("  a corrupt day costs that day, not the history");
{
  const root = newRoot();
  append(root, { timestamp: NOW, text: "good row" });
  append(root, { timestamp: NOW - DAY, text: "yesterday" });
  // Corrupt the middle of yesterday's file.
  const path = join(historyDir(root), `${dayKey(NOW - DAY)}.jsonl`);
  writeFileSync(path, `{"broken`, "utf8");

  const all = loadAll(root);
  ok(all.length === 1 && all[0].text === "good row", "the unaffected day still reads");
}
{
  const root = newRoot();
  const path = join(historyDir(root), `${dayKey(NOW)}.jsonl`);
  mkdirSync(historyDir(root), { recursive: true });
  writeFileSync(path, `{"timestamp":${NOW},"text":"first"}\n{oops\n{"timestamp":${NOW},"text":"third"}\n`, "utf8");
  ok(loadAll(root).length === 2, "a bad line inside a file loses only that line");
}
{
  const root = newRoot();
  mkdirSync(historyDir(root), { recursive: true });
  writeFileSync(join(historyDir(root), "notes.txt"), "not history", "utf8");
  writeFileSync(join(historyDir(root), "2026-13-99.jsonl"), "", "utf8");
  ok(listDays(root).length === 0, "files that are not day shards are ignored");
}

console.log(`  keeping ${RETENTION_DAYS} days and no more`);
{
  const root = newRoot();
  // 120 days of history, one row each.
  for (let d = 0; d < 120; d++) append(root, { timestamp: NOW - d * DAY, text: `day minus ${d}` });
  ok(listDays(root).length === 120, "120 days written");

  const before = usage(root).bytes;
  const res = prune(root, RETENTION_DAYS, NOW);

  ok(listDays(root).length <= RETENTION_DAYS + 1,
     `at most ${RETENTION_DAYS + 1} days survive (${listDays(root).length})`);
  ok(res.removedDays.length > 0, `${res.removedDays.length} days removed`);
  ok(res.freedBytes > 0 && usage(root).bytes < before, "and the space is actually reclaimed");

  // The boundary is what matters. Nothing inside three months may be gone.
  const cutoff = NOW - RETENTION_DAYS * DAY;
  const survivors = loadAll(root);
  ok(survivors.every((r) => r.timestamp >= cutoff - DAY),
     "nothing meaningfully older than the window survived");
  ok(loadRange(root, NOW - 30 * DAY, NOW).length === 31,
     "recent history is completely intact after pruning");

  const keptDays = listDays(root);
  ok(keptDays.every((k) => dayEnd(k) >= cutoff),
     "every surviving day still has part of itself inside the window");
}
{
  // The dangerous off-by-one: a day that is partly inside the window.
  const root = newRoot();
  const edgeDay = dayKey(NOW - RETENTION_DAYS * DAY);
  // A row late in that day is still within three months.
  append(root, { timestamp: dayEnd(edgeDay) - 1000, text: "just inside" });
  prune(root, RETENTION_DAYS, NOW);
  ok(loadAll(root).some((r) => r.text === "just inside"),
     "a day straddling the cutoff is kept, not deleted");
}
{
  const root = newRoot();
  append(root, { timestamp: NOW - 400 * DAY, text: "ancient" });
  append(root, { timestamp: NOW, text: "today" });
  prune(root, RETENTION_DAYS, NOW);
  const left = loadAll(root);
  ok(left.length === 1 && left[0].text === "today", "a year-old day is definitely gone");
}
{
  const root = newRoot();
  append(root, { timestamp: NOW, text: "only today" });
  const res = prune(root, RETENTION_DAYS, NOW);
  ok(res.removedDays.length === 0, "pruning fresh history removes nothing");
  ok(loadAll(root).length === 1, "and leaves it readable");
}
{
  ok(prune(newRoot(), RETENTION_DAYS, NOW).removedDays.length === 0,
     "pruning an empty history is a no-op, not a crash");
}

console.log("  moving an existing single-file history across");
{
  const root = newRoot();
  const legacy = join(root, "rewind.jsonl");
  let raw = "";
  for (let d = 0; d < 5; d++) {
    raw += JSON.stringify({ timestamp: NOW - d * DAY, text: `legacy day ${d}` }) + "\n";
  }
  raw += "{corrupt line\n";
  writeFileSync(legacy, raw, "utf8");

  const res = migrateLegacy(root);
  ok(res.migrated === 5, `all five rows moved (${res.migrated})`);
  ok(!existsSync(legacy), "the old file is gone once it is safely split");
  ok(listDays(root).length === 5, "one file per day now exists");
  ok(loadAll(root).some((r) => r.text === "legacy day 3"), "and the content is readable");
}
{
  // Running it twice must not double the history.
  const root = newRoot();
  writeFileSync(join(root, "rewind.jsonl"),
    JSON.stringify({ timestamp: NOW, text: "once" }) + "\n", "utf8");
  migrateLegacy(root);
  const first = loadAll(root).length;
  const again = migrateLegacy(root);
  ok(again.migrated === 0 && loadAll(root).length === first,
     "a second migration is a no-op");
}
{
  // An interrupted migration parks the data under .migrating; resuming must
  // recover it rather than leaving it stranded.
  const root = newRoot();
  writeFileSync(join(root, "rewind.jsonl.migrating"),
    JSON.stringify({ timestamp: NOW, text: "interrupted" }) + "\n", "utf8");
  const res = migrateLegacy(root);
  ok(res.migrated === 1, "an interrupted migration resumes from where it parked the data");
  ok(loadAll(root)[0].text === "interrupted", "and nothing was lost");
}
{
  // The nastiest case: interrupted AFTER writing some of a day.
  const root = newRoot();
  append(root, { timestamp: NOW, text: "already written" });
  writeFileSync(join(root, "rewind.jsonl.migrating"),
    JSON.stringify({ timestamp: NOW, text: "already written" }) + "\n" +
    JSON.stringify({ timestamp: NOW, text: "not yet written" }) + "\n", "utf8");
  migrateLegacy(root);
  const rows = loadAll(root);
  ok(rows.length === 2, `resuming does not duplicate rows already written (${rows.length})`);
  ok(rows.some((r) => r.text === "not yet written"), "and it finishes the job");
}
{
  const root = newRoot();
  ok(migrateLegacy(root).migrated === 0, "nothing to migrate is fine");
}

console.log("  reporting what it holds");
{
  const root = newRoot();
  append(root, { timestamp: NOW - 3 * DAY, text: "older" });
  append(root, { timestamp: NOW, text: "newer" });
  const u = usage(root);
  ok(u.days === 2 && u.bytes > 0, `usage reports ${u.days} days, ${u.bytes} bytes`);
  ok(u.oldest === dayKey(NOW - 3 * DAY), "and names the oldest day it still has");
  ok(usage(newRoot()).oldest === null, "an empty history reports no oldest day");
}

for (const r of roots) rmSync(r, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} history checks passed\n`);
process.exit(fail ? 1 : 0);
