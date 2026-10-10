/**
 * Replays Binance's public trades through the slicer detector (src/shared/slicers.ts) to count what it would announce: every episode,
 * and the most alerts in any 24 hours, for several settings at once over the same orders. Nothing is sent anywhere.
 *
 *   node --experimental-strip-types scripts/replay-slicers.mts --symbol ETHUSDT --market spot --from 2026-10-03T21:00Z --to 2026-10-10T21:00Z
 *
 * Trades are Binance's aggregate trades (one row per taker order and price), read by the hour and kept in `--cache`
 * (data/runtime/aggtrades by default, outside git); a taker order is the rows of one millisecond and side. Binance answers the perpetual's
 * trades for the last two days only. `--out file.json` writes the episodes and counts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { GRACE_MS, SLICER_DEFAULTS, SlicerDetector, type SlicerEpisode, type SlicerKind, type SlicerOptions } from '../src/shared/slicers.ts';

const HOUR = 3_600_000, DAY = 24 * HOUR;
const arg = (name: string, fallback?: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : fallback;
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
};
const symbol = arg('symbol'), market = arg('market', 'spot'), from = Date.parse(arg('from')), to = Date.parse(arg('to'));
const cache = arg('cache', path.join('data', 'runtime', 'aggtrades')), out = process.argv.includes('--out') ? arg('out') : null;
const scale = Number(arg('scale', '1'));
if (market !== 'spot' && market !== 'perp') throw new Error('--market is spot or perp');
if (!(to > from)) throw new Error('--from must come before --to');

const HOSTS = market === 'spot' ? ['https://api.binance.com', 'https://data-api.binance.vision'] : ['https://fapi.binance.com'];
const PATH = market === 'spot' ? '/api/v3/aggTrades' : '/fapi/v1/aggTrades';
const PACE_MS = market === 'spot' ? 60 : 500; // the perpetual's trades weigh 20 of 2,400 a minute
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
interface AggTrade { a: number; p: string; q: string; T: number; m: boolean }
/** A page of aggregate trades as Binance documents it, else null: a page that is not one must never be cached as an empty hour. */
function readPage(value: unknown): AggTrade[] | null {
  if (!Array.isArray(value)) return null;
  for (const r of value as Partial<AggTrade>[]) {
    if (typeof r !== 'object' || r === null || !Number.isInteger(r.a) || !Number.isFinite(r.T) || typeof r.m !== 'boolean'
      || !(Number(r.p) > 0) || !(Number(r.q) > 0)) return null;
  }
  return value as AggTrade[];
}
async function get(query: string): Promise<AggTrade[]> {
  for (let attempt = 0; attempt < 6; attempt++) {
    for (const host of HOSTS) {
      await sleep(PACE_MS);
      try {
        const r = await fetch(host + PATH + query);
        if (r.ok) { const page = readPage(await r.json()); if (page) return page; throw new Error(`${host}${PATH}${query}: not a page of trades`); }
        if (r.status === 429 || r.status === 418) { console.error(`${host}: ${r.status}, waiting a minute`); await sleep(60_000); }
        else throw new Error(`${host}${PATH}${query}: ${r.status} ${(await r.text()).slice(0, 200)}`);
      } catch (error) { if (attempt === 5) throw error; }
    }
  }
  throw new Error('no Binance host answered');
}
/** One hour of trades as [time, sold (1) or bought (0), USD], from the cache or from Binance. */
async function hour(start: number): Promise<[number, number, number][]> {
  const file = path.join(cache, `${market}-${symbol}-${start}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as [number, number, number][];
  const rows: [number, number, number][] = [];
  let page = await get(`?symbol=${symbol}&startTime=${start}&endTime=${start + HOUR - 1}&limit=1000`);
  while (page.length) {
    for (const r of page) if (r.T >= start && r.T < start + HOUR) rows.push([r.T, r.m ? 1 : 0, Number(r.p) * Number(r.q)]);
    const last = page[page.length - 1]!;
    if (last.T >= start + HOUR) break;
    page = await get(`?symbol=${symbol}&fromId=${last.a + 1}&limit=1000`);
  }
  // Only a whole past hour is kept: the one under way would be cut short.
  if (start + HOUR < Date.now()) { fs.mkdirSync(cache, { recursive: true }); fs.writeFileSync(file, JSON.stringify(rows)); }
  return rows;
}

// The settings compared: Argus's exact kind alone, the wide kind alone at a few rates and directions, and both (the defaults).
const exact = SLICER_DEFAULTS.kinds.find(k => k.name === 'exact')!, wide = SLICER_DEFAULTS.kinds.find(k => k.name === 'wide')!;
const variants: [string, Partial<SlicerOptions>][] = [['both (defaults)', {}], ['exact only', { kinds: [exact] }]];
for (const bucket of [0.25, 0.4, 0.5, 0.6]) for (const minRate of [10, 20]) for (const minDirection of [0.85, 0.9]) {
  const kind: SlicerKind = { ...wide, bucket, minRate, minDirection };
  variants.push([`wide only, buckets ${bucket}, rate ${minRate}, direction ${minDirection}`, { kinds: [kind] }]);
}
const detectors = variants.map(([name, options]) => ({ name, detector: new SlicerDetector(options, scale), episodes: new Map<string, SlicerEpisode>() }));
const id = `${market}:${symbol}`;

const t0 = Date.now();
let orders = 0;
for (let start = Math.floor(from / HOUR) * HOUR; start < to; start += HOUR) {
  const rows = (await hour(start)).filter(r => r[0] >= from && r[0] < to);
  // A taker order is its rows of one millisecond and side (Binance writes one row per order and price).
  const byKey = new Map<string, { instrumentId: string; side: 'buy' | 'sell'; t: number; usd: number }>();
  for (const [t, sold, usd] of rows) {
    const key = `${t}|${sold}`, o = byKey.get(key);
    if (o) o.usd += usd; else byKey.set(key, { instrumentId: id, side: sold ? 'sell' : 'buy', t, usd });
  }
  const list = [...byKey.values()].sort((a, b) => a.t - b.t);
  orders += list.length;
  let second = -1;
  for (const o of list) {
    if (Math.floor(o.t / 1000) !== second) { second = Math.floor(o.t / 1000); for (const d of detectors) d.detector.step(o.t); }
    for (const d of detectors) d.detector.add([o]);
  }
  for (const d of detectors) {
    d.detector.step(Math.min(start + HOUR, to));
    for (const e of d.detector.takeFresh()) {
      if (!(e.clip > 0 && e.rate > 0 && e.total > 0)) console.error(`\n${d.name}: a snapshot without its numbers: ${JSON.stringify(e)}`);
      d.episodes.set(e.id, e);
    }
  }
  process.stderr.write(`\r${new Date(start).toISOString().slice(0, 13)}h  ${orders} orders  ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
process.stderr.write('\n');
// The minute ending at `to` is judged once the clock is past it and the grace, as it would be live.
for (const d of detectors) { d.detector.step(to + GRACE_MS); for (const e of d.detector.takeFresh()) d.episodes.set(e.id, e); }

const iso = (t: number) => new Date(t).toISOString().slice(5, 16).replace('T', ' ');
const days = (to - from) / DAY;
const report: unknown[] = [];
console.log(`${id}: ${iso(from)} - ${iso(to)} UTC (${days.toFixed(2)} days), ${orders} taker orders, scale ${scale}`);
for (const d of detectors) {
  const all = [...d.episodes.values()].sort((a, b) => a.alertAt - b.alertAt), announced = all.filter(e => !e.repeat);
  let most = 0; for (let i = 0, j = 0; i < announced.length; i++) { while (announced[i]!.alertAt - announced[j]!.alertAt >= DAY) j++; most = Math.max(most, i - j + 1); }
  console.log(`\n== ${d.name}: ${announced.length} announced (${(announced.length / days).toFixed(2)} a day, at most ${most} in 24 h), ${all.length - announced.length} repeats`);
  for (const e of all) {
    console.log(`  ${e.side.padEnd(4)} onset ${iso(e.onset)} alert ${iso(e.alertAt).slice(6)} end ${e.end ? iso(e.end).slice(6) : 'running'}`
      + ` clips $${(e.lo / 1e3).toFixed(2)}-${(e.hi / 1e3).toFixed(2)}K (median ${(e.clip / 1e3).toFixed(2)}K) ${e.rate.toFixed(1)}/min $${(e.usdPerMin / 1e3).toFixed(0)}K/min`
      + ` (average $${(e.total / ((e.last - e.onset) / 60_000 + 1) / 1e3).toFixed(0)}K/min)`
      + ` gap ${e.gap}s ${(100 * e.gapShare).toFixed(0)}% dir ${(100 * e.direction).toFixed(0)}% total $${(e.total / 1e6).toFixed(2)}M${e.exact ? ' exact' : ''}${e.repeat ? ' (repeat)' : ''}`);
  }
  report.push({ variant: d.name, announced: announced.length, perDay: announced.length / days, most24h: most, episodes: all });
}
if (out) fs.writeFileSync(out, JSON.stringify({ id, from, to, orders, scale, report }, null, 1));
