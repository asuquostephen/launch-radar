// Launch Radar model: one sealed snapshot in, one ranked board of pre-token protocols out.
//
// The idea, in one paragraph. A protocol that records no token has no market price, so the radar
// prices it the way the market already prices its peers: for every category, take the protocols in
// the snapshot whose token DOES trade and compute the median of market cap over TVL — the multiple
// of TVL the market pays for that kind of protocol. A pre-token protocol's implied value is its own
// TVL at its category's multiple, shaded by its seven-day TVL momentum (a protocol shrinking into
// its launch is worth less than its raw TVL suggests; one growing into it, more) and by a maturity
// factor on how long it has run with no token (log-scaled: the second year proves less than the
// first). Every input is a figure the snapshot itself carries. No protocol name is special-cased
// anywhere in this file: the same three multiplications score every row.
//
// The board is the snapshot's watchlist (the floor: every slug, always) plus every protocol below
// the floor that passes the same screen the house applies at the floor — records no token, is not
// an exchange product, not a wrapped, staked or bridged product of a token that already trades, and
// not a versioned pool of another protocol. What the screen turns away is not hidden: the dashboard
// lists it, with the reason, in its Off the board view.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

// ---------------------------------------------------------------- the multiples

/** A category's market multiple: the median market-cap/TVL of its live-token protocols. */
export interface Multiple {
  multiple: number;
  peers: number;
}

/** The multiples table: one entry per category with enough live peers, plus the global fallback. */
export interface Multiples {
  byCategory: Map<string, Multiple>;
  global: Multiple;
}

/** The model's constants, stated on the dashboard so a reader can re-run the arithmetic. */
export const MODEL = {
  /** A category needs at least this many live-token protocols before its own median is trusted. */
  min_peers: 3,
  /** Multiples are clamped into this band so one frothy category cannot price a row at 60x TVL. */
  multiple_floor: 0.02,
  multiple_cap: 2.5,
  /** Momentum: change_7d is clamped to [momentum_min_pct, momentum_max_pct] before it is weighted. */
  momentum_min_pct: -40,
  momentum_max_pct: 60,
  /** A rising protocol gains at most +30% from momentum; a falling one loses at most -45%. */
  momentum_up_weight: 0.3,
  momentum_down_weight: 0.45,
  /** Maturity runs from maturity_base (brand new) to 1.0 at maturity_full_days, log-scaled. */
  maturity_base: 0.72,
  maturity_full_days: 1825,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'launch-radar-2';

/** How many live-token protocols the dashboard's Already trading view carries, by market cap. */
export const LIVE_ROWS = 48;

/** How many screened-out protocols the dashboard's Off the board view carries, by TVL. */
export const EXCLUDED_ROWS = 60;

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Whether a protocol records no token: no market cap, no CoinGecko id, no symbol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * The market's own pricing of TVL, read out of the snapshot: for each category, the median
 * market-cap/TVL over its protocols whose token trades; the global median over all of them is the
 * fallback for categories with too few live peers (and for a protocol with no category).
 */
export function categoryMultiples(snapshot: Snapshot): Multiples {
  const ratios = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (isPreToken(p) || p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    all.push(ratio);
    if (p.category !== null) {
      const list = ratios.get(p.category) ?? [];
      list.push(ratio);
      ratios.set(p.category, list);
    }
  }
  const byCategory = new Map<string, Multiple>();
  for (const [category, list] of ratios) {
    if (list.length >= MODEL.min_peers) {
      byCategory.set(category, { multiple: clamp(median(list), MODEL.multiple_floor, MODEL.multiple_cap), peers: list.length });
    }
  }
  return { byCategory, global: { multiple: clamp(median(all), MODEL.multiple_floor, MODEL.multiple_cap), peers: all.length } };
}

/** The multiple one protocol is priced at: its category's where trusted, else the global median. */
export function multipleFor(p: SnapshotProtocol, multiples: Multiples): Multiple & { source: 'category' | 'global' } {
  if (p.category !== null) {
    const own = multiples.byCategory.get(p.category);
    if (own !== undefined) return { ...own, source: 'category' };
  }
  return { ...multiples.global, source: 'global' };
}

// ---------------------------------------------------------------- age and momentum

const DAY_MS = 86_400_000;

/** Whole days from `listedAt` to the snapshot's `asOf`, clamped at zero; null when either is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The snapshot's median known age: the age an unlisted protocol is assumed to have, from the data. */
export function medianKnownAge(snapshot: Snapshot): number {
  const ages: number[] = [];
  for (const p of snapshot.protocols) {
    const age = ageDays(snapshot.as_of, p.listed_at);
    if (age !== null) ages.push(age);
  }
  return Math.round(median(ages));
}

/** The momentum multiplier: growth into a launch adds, shrinkage subtracts harder. */
export function momentumMultiplier(change7d: number | null): number {
  const g = clamp(change7d ?? 0, MODEL.momentum_min_pct, MODEL.momentum_max_pct);
  if (g >= 0) return 1 + MODEL.momentum_up_weight * (g / MODEL.momentum_max_pct);
  return 1 + MODEL.momentum_down_weight * (g / -MODEL.momentum_min_pct);
}

/** The maturity multiplier: log-scaled in age, from maturity_base up to 1.0 at five years. */
export function maturityMultiplier(age: number): number {
  const share = Math.min(1, Math.log(1 + Math.max(0, age)) / Math.log(1 + MODEL.maturity_full_days));
  return MODEL.maturity_base + (1 - MODEL.maturity_base) * share;
}

// ---------------------------------------------------------------- the screen

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** A whole word wrapped, staked or staking in a name marks a product of another protocol's asset. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
/** Categories that are a wrapped, staked or bridged product of an asset that already trades. */
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);
/** Names that begin with an exchange's name are that exchange's own product. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/**
 * Why the screen keeps a pre-token protocol off the board, or null when it passes: the same screen
 * the house applies to its watchlist at the floor, applied here at every size. A protocol whose
 * token already trades is never asked this question — it is not pre-token to begin with.
 */
export function screenReason(p: SnapshotProtocol): string | null {
  if (p.category === 'CEX' || EXCHANGE_PREFIXES.some((x) => p.name.startsWith(x))) {
    return 'an exchange product: the venue itself, or an asset the exchange issues — not a protocol waiting on a first token';
  }
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) {
    return `a ${p.category.toLowerCase()} product of an asset that already trades — the underlying token exists, so there is no launch to radar`;
  }
  if (WRAPPED_WORD.test(p.name)) {
    return 'a wrapped or staked product of an asset that already trades — the underlying token exists, so there is no launch to radar';
  }
  if (VERSIONED.test(p.name)) {
    return 'a versioned pool of another protocol: the name ends in a version marker, so any token is the parent protocol’s, not this pool’s';
  }
  return null;
}

// ---------------------------------------------------------------- scoring

/** One protocol's score: the implied value and every factor that produced it. */
export interface Score {
  implied: number;
  multiple: number;
  multipleSource: 'category' | 'global';
  peers: number;
  momentum: number;
  maturity: number;
  age: number | null;
  ageUsed: number;
  ageImputed: boolean;
}

/** Score one pre-token protocol from the snapshot's own figures, and nothing else. */
export function scoreProtocol(p: SnapshotProtocol, snapshot: Snapshot, multiples: Multiples, medianAge: number): Score {
  const m = multipleFor(p, multiples);
  const age = ageDays(snapshot.as_of, p.listed_at);
  const ageUsed = age ?? medianAge;
  const momentum = momentumMultiplier(p.change_7d);
  const maturity = maturityMultiplier(ageUsed);
  const implied = Math.max(1, Math.round(p.tvl_usd * m.multiple * momentum * maturity));
  return {
    implied,
    multiple: m.multiple,
    multipleSource: m.source,
    peers: m.peers,
    momentum,
    maturity,
    age,
    ageUsed,
    ageImputed: age === null,
  };
}

// ---------------------------------------------------------------- farm plans

/** The gas note for a protocol's first chain: what one transaction roughly costs there. */
function gasNote(chain: string): string {
  if (chain === 'Ethereum') return 'about $6 of ETH gas on mainnet';
  if (chain === 'Solana') return 'a few cents of SOL fees';
  if (chain === 'BSC') return 'under $0.30 of BNB gas';
  if (['Arbitrum', 'Base', 'Optimism', 'zkSync Era', 'Linea', 'Scroll', 'Mantle', 'Blast', 'Mode', 'Taiko', 'Zora'].includes(chain)) {
    return 'under $0.50 of gas on the L2';
  }
  return `a small amount of ${chain} gas`;
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(tvl: number): number {
  if (tvl >= 1_000_000_000) return 200;
  if (tvl >= 250_000_000) return 120;
  if (tvl >= 50_000_000) return 75;
  if (tvl >= 10_000_000) return 50;
  return 30;
}

/** How many weekly actions a farm runs, from the protocol's age: younger protocols qualify longer. */
function weeksFor(age: number | null): number {
  if (age === null) return 8;
  if (age < 180) return 10;
  if (age < 365) return 8;
  if (age < 730) return 6;
  return 5;
}

/** The category's core action, in words a farmer can follow. */
function coreAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC as collateral in ${n} on ${chain} and leave the position open`;
  if (c.includes('dex')) return `Provide $${capital} split evenly across both sides of ${n}'s busiest stablecoin pool on ${chain}`;
  if (c.includes('deriv') || c.includes('perpetual')) return `Deposit $${capital} of USDC as margin on ${n} and open one small hedged position (long spot, short perp, same size)`;
  if (c.includes('basis')) return `Open a $${capital} basis position through ${n} on ${chain}: long the spot asset, short the same size on its perpetual market`;
  if (c.includes('rwa')) return `Mint $${capital} of ${n}'s yield-bearing asset on ${chain} with USDC and hold it in the farming wallet`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${n} on ${chain} against a position you actually hold, and keep the policy NFT`;
  if (c.includes('payment')) return `Route a real $${capital} payment through ${n} on ${chain} (to your own second wallet counts) and keep the account active`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('governance')) return `Deposit $${capital} into a ${n} vault on ${chain} and keep the vault shares untouched`;
  if (c.includes('stable')) return `Deposit $${capital} of USDC into ${n} on ${chain} and hold the stable asset it issues`;
  if (c.includes('staking') || c.includes('restak') || c.includes('chain')) return `Stake $${capital} of the chain's native asset through ${n} and keep the staking receipt in the wallet`;
  if (c.includes('yield')) return `Deposit $${capital} of USDC into ${n}'s main vault on ${chain} and keep the shares`;
  return `Deposit $${capital} of USDC into ${n} on ${chain} and keep the position open`;
}

/** The category's second, depth-building action. */
function secondAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Borrow no more than 35% of your collateral's value from ${n} and re-supply the borrowed asset once, so both sides of the market see the wallet`;
  if (c.includes('dex')) return `Make at least two swaps a week through ${n}'s own interface on ${chain}, even small ones, so the wallet reads as a trader and not only a depositor`;
  if (c.includes('deriv') || c.includes('perpetual')) return `Trade to roughly $${capital * 20} of cumulative volume in small hedged orders rather than one large one, keeping the net exposure near zero`;
  if (c.includes('yield') || c.includes('curator') || c.includes('allocator')) return `Claim and re-deposit any rewards ${n} pays each week instead of withdrawing them, so the position compounds in place`;
  return `Use one more of ${n}'s own features on ${chain} — a second pool, a borrow, a vote or a transfer — so the wallet's history is not a single deposit`;
}

/** The category's standing risk rule. */
function riskNote(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Watch the position weekly: keep the health factor above 1.6 (or the collateral ratio above 160%) so a bad week cannot liquidate the farm`;
  if (c.includes('dex')) return `Check the pool weekly for impermanent loss: if one side has drifted far from 50/50, rebalance or exit rather than letting the farm become a one-sided bet`;
  if (c.includes('deriv') || c.includes('perpetual') || c.includes('basis')) return `Keep the hedge matched after every funding payment and price move; an unmatched leg is a trade, not a farm, and it can be liquidated`;
  if (c.includes('staking') || c.includes('restak')) return `Read ${n}'s unstaking terms before you commit: note the unbonding wait in your log, because staked capital cannot leave quickly if the picture changes`;
  if (c.includes('rwa')) return `Confirm the asset can be redeemed back to USDC from ${n}'s own app before you mint more; a yield asset with no exit is a lock-up, not a farm`;
  return `Re-check ${n}'s TVL trend monthly: if it falls by a third in a week, withdraw first and ask why afterwards`;
}

/**
 * A protocol's farm plan: seven steps, each an action with its cost and its time, every figure
 * derived from the protocol's own record — category, chains, TVL and age. Nothing here is written
 * per protocol name; two protocols with the same record shape get the same shaped plan.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const capital = capitalFor(p.tvl_usd);
  const weeks = weeksFor(age);
  const gas = gasNote(chain);
  const steps = [
    `Set up a fresh wallet that holds only this farm's funds, write its seed phrase on paper, and fund it with $${capital + 25} of USDC plus gas money on ${chain}. Cost: about 10 minutes of setup and the gas to fund it. Time: 10 minutes, once.`,
    `${coreAction(p, capital, chain)}. Cost: $${capital} of capital and ${gas}. Time: 15 minutes to set up.`,
    `${secondAction(p, capital, chain)}. Cost: ${gas} per action. Time: 10 minutes, in the first week.`,
    `Repeat one qualifying action every week for ${weeks} weeks — a deposit, a swap, a borrow or a vote through ${p.name}'s own interface — so the wallet's history spans more than one snapshot. Cost: ${gas} a week. Time: 10 minutes a week for ${weeks} weeks.`,
    `Check ${p.name}'s official site and docs for a points or rewards page, and only ever claim from a link the protocol itself publishes; a claim that asks for a fee or a seed phrase is a scam. Cost: nothing to check, never pay to claim. Time: 10 minutes, monthly.`,
    `${riskNote(p)}. Cost: nothing but attention. Time: 5 minutes a week while the position is open.`,
    `Keep a farm log — wallet, dates, amounts, transaction hashes — and review it monthly; exit when the rewards program ends, the position has run ${weeks} weeks past any announced snapshot, or the risk note above trips. Cost: nothing but the log. Time: 5 minutes to start, 15 minutes a month.`,
  ];
  return steps.map((s) => (s.length > 600 ? `${s.slice(0, 596)}...` : s));
}

// ---------------------------------------------------------------- the board

/** One row of board.json: the ranked board's row, with the score's workings attached. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    multiple: number;
    multiple_source: 'category' | 'global';
    category_peers: number;
    momentum_multiplier: number;
    maturity_multiplier: number;
    age_days_used: number;
    age_imputed: boolean;
  };
  farm_steps: string[];
}

/** The board: every watchlist slug, plus every screened pre-token protocol below the floor. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const multiples = categoryMultiples(snapshot);
  const medianAge = medianKnownAge(snapshot);
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  for (const p of snapshot.protocols) {
    if (chosen.has(p.slug) || !isPreToken(p) || p.tvl_usd >= snapshot.floor_usd) continue;
    if (screenReason(p) === null) chosen.set(p.slug, p);
  }
  const watchlist = new Set(snapshot.watchlist);
  const scored = [...chosen.values()].map((p) => ({ p, score: scoreProtocol(p, snapshot, multiples, medianAge) }));
  scored.sort((a, b) => b.score.implied - a.score.implied || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map(({ p, score }, i) => ({
    rank: i + 1,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    mcap_usd: p.mcap_usd,
    listed_at: p.listed_at,
    gecko_id: p.gecko_id,
    symbol: p.symbol,
    token_status: 'pre-token',
    watchlist: watchlist.has(p.slug),
    age_days: score.age,
    implied_value_usd: score.implied,
    model: {
      // Full precision, not rounded: the dashboard recomputes the implied value from these very
      // factors and must land on the board's figure exactly, so nothing here is rounded away.
      multiple: score.multiple,
      multiple_source: score.multipleSource,
      category_peers: score.peers,
      momentum_multiplier: score.momentum,
      maturity_multiplier: score.maturity,
      age_days_used: score.ageUsed,
      age_imputed: score.ageImputed,
    },
    farm_steps: farmSteps(p, score.age),
  }));
}

// ---------------------------------------------------------------- the dashboard's other views

/** A live-token protocol: it already trades, so the page shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  multiple: number | null;
}

/** The live-token protocols, by market cap: the comparison set the multiples are read from. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p))
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      multiple: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

/** A pre-token protocol the screen kept off the board, with the reason. */
export interface ExcludedRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  reason: string;
}

/** The screened-out pre-token protocols, biggest first: shown, with reasons, never ranked. */
export function excludedRows(snapshot: Snapshot, board: BoardRow[]): ExcludedRow[] {
  const onBoard = new Set(board.map((r) => r.slug));
  return snapshot.protocols
    .filter((p) => isPreToken(p) && !onBoard.has(p.slug))
    .map((p) => ({ p, reason: screenReason(p) }))
    .filter((x): x is { p: SnapshotProtocol; reason: string } => x.reason !== null)
    .sort((a, b) => b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : 1))
    .slice(0, EXCLUDED_ROWS)
    .map(({ p, reason }) => ({ slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, reason }));
}

// ---------------------------------------------------------------- the dashboard data

/** Everything the dashboard renders, from the snapshot. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: typeof MODEL;
  global_multiple: number;
  global_peers: number;
  median_age_days: number;
  protocols_size: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  excluded_size: number;
  rows: BoardRow[];
  live: LiveRow[];
  excluded: ExcludedRow[];
}

/** Build the board and everything the dashboard shows beside it. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot);
  const live = liveRows(snapshot);
  const excluded = excludedRows(snapshot, board);
  const multiples = categoryMultiples(snapshot);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model: MODEL,
    global_multiple: round4(multiples.global.multiple),
    global_peers: multiples.global.peers,
    median_age_days: medianKnownAge(snapshot),
    protocols_size: snapshot.protocols.length,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.watchlist).length,
    live_size: live.length,
    excluded_size: excluded.length,
    rows: board,
    live,
    excluded,
  };
  return { board, radar };
}

// ---------------------------------------------------------------- reading and checking

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared value, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100) return `the board holds ${board.length} rows, under the gate's 100`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
