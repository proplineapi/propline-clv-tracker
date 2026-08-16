# propline-clv-tracker

CLV scorecard for a CSV of placed bets, graded against [PropLine's](https://prop-line.com) closing-line history.

> **Closing-line value (CLV)** is the gap between the price you placed at and the price the line closed at. Over enough bets, beating the close is the strongest available signal that you're betting +EV — because closing lines (especially Pinnacle's) approach the true probability of the event.

This is a reference implementation (~350 LOC) showing how to use the [`propline`](https://www.npmjs.com/package/propline) Node SDK's `getOddsHistory` to compute CLV per bet plus a portfolio summary.

## Quickstart

```bash
git clone https://github.com/proplineapi/propline-clv-tracker
cd propline-clv-tracker
npm install

export PROPLINE_API_KEY=...   # free key at https://prop-line.com/?ref=github (Pro tier needed
                              # for full snapshot data; Free tier returns redacted history)
npm start -- examples/sample-bets.csv
```

Sample output:

```
Bet                                           Bet$  Placed@  Close@      CLV          EV
──────────────────────────────────────────────────────────────────────────────────────
Cal Raleigh · batter_total_bases Over 1.5    $100    +130     +120     +4.55%      +$4.55
Alec Burleson · batter_doubles Under 0.5      $50    -550     -575     -0.96%      −$0.48
h2h Seattle Mariners                         $200    -115     -120     +2.33%      +$4.66
──────────────────────────────────────────────────────────────────────────────────────

Portfolio:  3 bets, 3 matched. Total stake $350.00.
  Avg CLV (per bet):       +1.97%
  Stake-weighted CLV:      +2.79%
  Expected $ at the close: +$8.73

Closing-line value treats Pinnacle/Bovada's closing line as the
truest available probability — beating it consistently is the
single best long-run signal of +EV betting.
```

## CSV format

Header required, column order doesn't matter. Empty values for non-applicable columns (e.g. `player` for a moneyline) are fine.

| Column     | Required | Notes |
| ---------- | -------- | ----- |
| `book`     | yes      | PropLine book key: `bovada`, `draftkings`, `fanduel`, `pinnacle`, `unibet`. |
| `sport`    | yes      | PropLine sport key: `baseball_mlb`, `basketball_nba`, `hockey_nhl`, etc. |
| `event_id` | yes      | PropLine event ID. Find via `GET /v1/sports/{sport}/events`. |
| `market`   | yes      | PropLine market key: `h2h`, `totals`, `batter_total_bases`, etc. |
| `player`   | no       | Player name for prop markets. Empty for h2h/totals/spreads. PropLine's "(SEA)" team-suffix style is auto-stripped — `Cal Raleigh` matches `Cal Raleigh (SEA)`. |
| `line`     | no       | Numeric line / point. Empty for h2h moneylines. |
| `outcome`  | yes      | `Over`, `Under`, `Yes`, `No`, or a team name. |
| `price`    | yes      | American odds you placed at, e.g. `+130`, `-110`. |
| `stake`    | yes      | USD stake. |
| `placed_at`| no       | ISO-8601 timestamp; informational only — closing line is determined by the event's commence time, not when you placed. |

See [`examples/sample-bets.csv`](examples/sample-bets.csv).

## How CLV is computed

For each row in your CSV:

1. Fetch the event's full snapshot history via `client.getOddsHistory(sport, eventId)`.
2. Find the matching `(book, market, player, line, outcome)` outcome.
3. Take its closing snapshot — the last one recorded **at or before** the game's `commence_time`.
4. Compute:

```
decimal_bet   = americanToDecimal(price_bet)
decimal_close = americanToDecimal(price_close)
clv_pct       = (decimal_bet / decimal_close - 1) × 100
ev_dollars    = stake × (impliedProb(price_close) × decimal_bet - 1)
```

`+12% CLV` ≈ `+12% EV per dollar staked`, under the assumption that the closing line is the truest probability available. See [`src/clv.ts`](src/clv.ts) for the full implementation.

## Two CLV metrics that matter

The tool reports both:

- **Average CLV per bet** — straight mean across all matched bets. Easy to read but misleading if your bet sizes vary wildly.
- **Stake-weighted CLV** — `Σ(clv × stake) / Σ(stake)`. The number that actually matches your dollar PnL expectation. Use this one if you size differently across bets.

A persistently positive stake-weighted CLV is the strongest evidence you're +EV; a persistently negative one is the strongest evidence you're not, regardless of how this season's variance has gone.

## Tier requirements

- `getOddsHistory` returns full snapshots on the **Pro tier** ($19/mo). Free tier gets a redacted response with snapshot counts only — useful for sanity-checking that PropLine has the data, but not enough to compute CLV.
- All grading on this tool is read-only against the PropLine API; no DB or storage of your bets.

## Links

- Endpoints this tool uses: [`/odds/history`](https://prop-line.com/docs?ref=github#odds-history) and [`/odds/closing`](https://prop-line.com/docs?ref=github#odds-closing) (opening + closing line per outcome)
- [Pinnacle closing odds API](https://prop-line.com/pinnacle-closing-odds-api?ref=github) — the sharp reference line for CLV
- [Historical backfill](https://prop-line.com/historical-backfill?ref=github) — one-time full-archive export for backtests
- [More recipes](https://prop-line.com/recipes?ref=github) · [Pricing](https://prop-line.com/pricing?ref=github) · [Node SDK](https://www.npmjs.com/package/propline)

## License

MIT.
