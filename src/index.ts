#!/usr/bin/env node
/**
 * propline-clv-tracker — CLV scorecard for a CSV of placed bets.
 *
 * Usage:
 *   PROPLINE_API_KEY=... npx tsx src/index.ts bets.csv
 *
 * For each bet in the CSV, fetches the event's PropLine line-movement
 * history, finds the closing snapshot for the same (book, market,
 * player, line, outcome), and reports CLV%. Shows a per-bet table and
 * a portfolio summary at the bottom.
 */

import { readFileSync } from "node:fs";
import { PropLine } from "propline";
import {
  americanToDecimal,
  computeClv,
  summarize,
  type ClvResult,
  type ClvSnapshot,
  type PlacedBet,
} from "./clv.js";
import { makeHeader, parseCsv } from "./csv.js";

interface CliArgs {
  csvPath: string;
}

function parseArgs(argv: string[]): CliArgs {
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    printHelp();
    process.exit(argv.length === 0 ? 2 : 0);
  }
  return { csvPath: argv[0]! };
}

function printHelp(): void {
  console.log(`
propline-clv-tracker

Usage:
  PROPLINE_API_KEY=... propline-clv-tracker <bets.csv>

CSV columns (header required, order doesn't matter):
  book          PropLine book key (bovada, draftkings, fanduel, pinnacle, unibet).
  sport         PropLine sport key (e.g. baseball_mlb).
  event_id      PropLine event ID.
  market        PropLine market key (e.g. batter_total_bases, h2h, totals).
  player        Player name for prop markets. Empty for h2h/totals/spreads.
  line          Numeric line / point. Empty for h2h moneylines.
  outcome       "Over", "Under", "Yes", "No", or a team name.
  price         American odds you placed at (e.g. -110, +130).
  stake         USD stake.
  placed_at     ISO-8601 timestamp when bet was placed (informational).

See examples/sample-bets.csv for a working example.
`);
}

async function main(): Promise<void> {
  const apiKey = process.env.PROPLINE_API_KEY;
  if (!apiKey) {
    console.error(
      "PROPLINE_API_KEY env var is required. Get a free key at https://prop-line.com",
    );
    process.exit(2);
  }
  const cli = parseArgs(process.argv.slice(2));

  const csvText = readFileSync(cli.csvPath, "utf8");
  const rows = parseCsv(csvText);
  if (rows.length < 2) {
    console.error("CSV is empty or missing rows.");
    process.exit(1);
  }
  const header = makeHeader(rows[0]!);
  const bets: PlacedBet[] = rows.slice(1).map((r) => ({
    book: header.required(r, "book").toLowerCase(),
    sport: header.required(r, "sport"),
    eventId: header.required(r, "event_id"),
    market: header.required(r, "market"),
    player: header.optional(r, "player") ?? "",
    line: parseLine(header.optional(r, "line")),
    outcome: header.required(r, "outcome"),
    priceAmerican: Number(header.required(r, "price")),
    stake: Number(header.required(r, "stake")),
    placedAt: header.optional(r, "placed_at") ?? "",
  }));

  const client = new PropLine(apiKey);

  // Group bets by (sport, event_id) so we hit /odds/history once per
  // event regardless of how many legs the user took on it.
  const byEvent = new Map<string, PlacedBet[]>();
  for (const b of bets) {
    const key = `${b.sport}::${b.eventId}`;
    const arr = byEvent.get(key);
    if (arr) arr.push(b);
    else byEvent.set(key, [b]);
  }

  const results: ClvResult[] = [];
  for (const [key, bucket] of byEvent) {
    const [sport, eventId] = key.split("::") as [string, string];
    const closingsByBet = await fetchClosings(client, sport, eventId, bucket);
    for (const bet of bucket) {
      const closing = closingsByBet.get(betKey(bet)) ?? null;
      results.push(computeClv(bet, closing));
    }
  }

  printResults(results);
}

function parseLine(s: string | null): number | null {
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function betKey(b: PlacedBet): string {
  return `${b.book}::${b.market}::${normalizeName(b.player)}::${b.line ?? ""}::${b.outcome.toLowerCase()}`;
}

function normalizeName(s: string): string {
  // Strip Bovada-style "(SEA)" team suffix and lowercase, so the user's
  // CSV "Cal Raleigh" matches PropLine's "Cal Raleigh (SEA)" history.
  return s.replace(/\s*\([^)]+\)\s*$/, "").trim().toLowerCase();
}

async function fetchClosings(
  client: PropLine,
  sport: string,
  eventId: string,
  bucket: PlacedBet[],
): Promise<Map<string, ClvSnapshot>> {
  const out = new Map<string, ClvSnapshot>();

  // Pass the union of market keys the user actually bet on, so the
  // history endpoint returns those rows. Without a `markets=` filter
  // the API truncates to the first few markets per book, which can
  // miss the prop the user took.
  const marketKeys = [...new Set(bucket.map((b) => b.market))];

  let history;
  try {
    history = await client.getOddsHistory(sport, eventId, {
      markets: marketKeys,
    });
  } catch (err) {
    console.error(
      `[warn] getOddsHistory failed for ${sport}/${eventId}: ${err instanceof Error ? err.message : err}`,
    );
    return out;
  }

  // The /odds/history response is shaped:
  //   { bookmakers: [{ key, markets: [{ key, outcomes: [{ name,
  //     description, snapshots: [{ recorded_at, price, point }] }] }] }] }
  // Loose-typed via SDK's [k: string]: unknown; cast at the boundary.
  const r = history as unknown as {
    commence_time: string;
    bookmakers?: Array<{
      key: string;
      markets?: Array<{
        key: string;
        outcomes?: Array<{
          name: string;
          description?: string | null;
          snapshots?: Array<{
            recorded_at: string;
            price: number;
            point?: number | null;
          }>;
        }>;
      }>;
    }>;
  };
  const commence = Date.parse(r.commence_time);

  // Index every (book, market, normalized-player, line, outcome) → its
  // closing snapshot for fast lookup against each placed bet.
  for (const book of r.bookmakers ?? []) {
    for (const market of book.markets ?? []) {
      for (const oc of market.outcomes ?? []) {
        const snaps = oc.snapshots ?? [];
        // Closing line = last snapshot at-or-before commence_time. If the
        // game already started and the snapshot stream extends past that
        // (live odds), we still want the kickoff price.
        const before = snaps.filter(
          (s) => Date.parse(s.recorded_at) <= commence,
        );
        const closing = (before.length > 0 ? before : snaps).at(-1);
        if (!closing) continue;
        // A book sometimes restated the line over the night; we group
        // by the closing snapshot's `point`, not by individual leg's
        // historical points. Each bet picks its own line up by
        // matching on what the user actually wagered.
        for (const bet of bucket) {
          if (bet.book !== book.key) continue;
          if (bet.market !== market.key) continue;
          if (bet.outcome.toLowerCase() !== oc.name.toLowerCase()) continue;
          // For player props, match on description (player name).
          // For game-level markets (h2h, totals, spreads), the bet's
          // player is empty and the outcome's description either
          // duplicates the team name (h2h) or is empty (totals);
          // matching on outcome name alone is sufficient and correct.
          if (bet.player) {
            if (
              normalizeName(bet.player) !==
              normalizeName(oc.description ?? "")
            ) {
              continue;
            }
          }
          if (bet.line !== null && closing.point !== bet.line) continue;
          out.set(betKey(bet), {
            recordedAt: closing.recorded_at,
            priceAmerican: closing.price,
            point: closing.point ?? null,
          });
        }
      }
    }
  }
  return out;
}

function fmtPrice(p: number): string {
  return p > 0 ? `+${p}` : String(p);
}

function fmtPct(n: number | null): string {
  if (n === null) return "  —  ";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function fmtUsd(n: number | null): string {
  if (n === null) return "    —    ";
  const sign = n >= 0 ? "+" : "−";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function pad(s: string, n: number, right = false): string {
  if (s.length >= n) return s;
  const fill = " ".repeat(n - s.length);
  return right ? fill + s : s + fill;
}

function printResults(results: ClvResult[]): void {
  console.log("");
  console.log(
    pad("Bet", 38) +
      pad("Bet$", 10, true) +
      pad("Placed@", 8, true) +
      pad("Close@", 8, true) +
      pad("CLV", 9, true) +
      pad("EV", 11, true),
  );
  console.log("─".repeat(38 + 10 + 8 + 8 + 9 + 11));
  for (const r of results) {
    const label =
      (r.bet.player ? `${r.bet.player} · ` : "") +
      r.bet.market +
      (r.bet.line !== null ? ` ${r.bet.outcome} ${r.bet.line}` : ` ${r.bet.outcome}`);
    const closingPriceStr = r.closing ? fmtPrice(r.closing.priceAmerican) : "—";
    console.log(
      pad(label.slice(0, 38), 38) +
        pad(`$${r.bet.stake.toFixed(0)}`, 10, true) +
        pad(fmtPrice(r.bet.priceAmerican), 8, true) +
        pad(closingPriceStr, 8, true) +
        pad(fmtPct(r.clvPct), 9, true) +
        pad(fmtUsd(r.evDollars), 11, true),
    );
    if (r.reason) {
      console.log(pad(`  └ ${r.reason}`, 38));
    }
  }
  const sum = summarize(results);
  console.log("─".repeat(38 + 10 + 8 + 8 + 9 + 11));
  console.log(
    `\nPortfolio:  ${sum.bets} bets, ${sum.matched} matched. ` +
      `Total stake $${sum.totalStake.toFixed(2)}.`,
  );
  console.log(
    `  Avg CLV (per bet):       ${fmtPct(sum.avgClvPct)}\n` +
      `  Stake-weighted CLV:      ${fmtPct(sum.weightedClvPct)}\n` +
      `  Expected $ at the close: ${fmtUsd(sum.totalEv)}\n`,
  );
  console.log(
    `Closing-line value treats Pinnacle/Bovada's closing line as the\n` +
      `truest available probability — beating it consistently is the\n` +
      `single best long-run signal of +EV betting.`,
  );

  // Use the array length to short-circuit unused-import linters.
  void americanToDecimal;
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
