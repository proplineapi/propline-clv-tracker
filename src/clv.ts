/**
 * Closing-line value (CLV) math.
 *
 * For each placed bet, the "closing line" is the last price the market
 * offered before the game started. Beating the close is the strongest
 * proxy a bettor has for "I'm betting +EV" — over enough samples it's
 * the only metric that matters, because closing lines (especially
 * Pinnacle's) approach the true probability of the event.
 *
 *    decimal_bet / decimal_close - 1   →  CLV %
 *
 * +12% CLV means you got 12% better odds than the line closed at, which
 * (under the assumption that the close ≈ true probability) translates
 * roughly 1-to-1 into expected value per dollar staked.
 */

export function americanToDecimal(price: number): number {
  if (price > 0) return price / 100 + 1;
  return 100 / -price + 1;
}

export function americanToImpliedProb(price: number): number {
  if (price > 0) return 100 / (price + 100);
  return -price / (-price + 100);
}

export interface PlacedBet {
  book: string;
  sport: string;
  eventId: string;
  market: string;
  /** Player name for prop markets, empty for game-level markets. */
  player: string;
  /** Line / point — null for h2h moneylines. */
  line: number | null;
  /** "Over", "Under", "Yes", "No", or a team name. */
  outcome: string;
  /** American odds the user placed at. */
  priceAmerican: number;
  /** Stake in USD. */
  stake: number;
  /** ISO-8601 timestamp of when the bet was placed. */
  placedAt: string;
}

export interface ClvSnapshot {
  recordedAt: string;
  priceAmerican: number;
  point: number | null;
}

export interface ClvResult {
  bet: PlacedBet;
  /** Closing snapshot (last snapshot before commence_time). null = no
   *  matching outcome found in PropLine's history. */
  closing: ClvSnapshot | null;
  /** Decimal odds the bet was placed at. */
  decimalBet: number;
  /** Decimal odds at the close (null if `closing` is null). */
  decimalClose: number | null;
  /** CLV % — positive means you got better odds than the close. */
  clvPct: number | null;
  /** Expected value per dollar at close (positive = +EV). */
  evDollars: number | null;
  reason?: string;
}

/**
 * Compute CLV given a placed bet and the closing snapshot. Returns null
 * fields when a closing match wasn't found (so callers can render
 * "—" for un-matched bets without errors fanning out).
 */
export function computeClv(
  bet: PlacedBet,
  closing: ClvSnapshot | null,
): ClvResult {
  const decimalBet = americanToDecimal(bet.priceAmerican);
  if (closing === null) {
    return {
      bet,
      closing,
      decimalBet,
      decimalClose: null,
      clvPct: null,
      evDollars: null,
      reason: "no closing snapshot found",
    };
  }
  const decimalClose = americanToDecimal(closing.priceAmerican);
  const clvPct = (decimalBet / decimalClose - 1) * 100;
  // EV uses the close as the "true" probability anchor. Profit if win =
  // stake × (decimal_bet - 1); loss = stake. Expected payout =
  // p_close × win_profit - (1 - p_close) × stake = stake × (clvPct/100 ×
  // p_close)... but the simpler equivalent form in money terms:
  //   ev = stake × (p_close × decimal_bet - 1)
  const pClose = americanToImpliedProb(closing.priceAmerican);
  const evDollars = bet.stake * (pClose * decimalBet - 1);
  return {
    bet,
    closing,
    decimalBet,
    decimalClose,
    clvPct,
    evDollars,
  };
}

export interface PortfolioSummary {
  bets: number;
  matched: number;
  totalStake: number;
  totalEv: number;
  avgClvPct: number;
  /** Stake-weighted CLV — usually a more honest "did I generate edge"
   *  number than a simple average, since it doesn't let a $1 bet at
   *  +50% CLV swamp a $500 bet at -1% CLV. */
  weightedClvPct: number;
}

export function summarize(results: ClvResult[]): PortfolioSummary {
  let matched = 0;
  let totalStake = 0;
  let matchedStake = 0;
  let totalEv = 0;
  let clvSum = 0;
  let weightedNumerator = 0;
  for (const r of results) {
    totalStake += r.bet.stake;
    if (r.clvPct === null || r.evDollars === null) continue;
    matched++;
    matchedStake += r.bet.stake;
    totalEv += r.evDollars;
    clvSum += r.clvPct;
    weightedNumerator += r.clvPct * r.bet.stake;
  }
  return {
    bets: results.length,
    matched,
    totalStake,
    totalEv,
    avgClvPct: matched === 0 ? 0 : clvSum / matched,
    weightedClvPct: matchedStake === 0 ? 0 : weightedNumerator / matchedStake,
  };
}
