# Older history from disk, on demand (2026-10-12)

The local server (`npm run dev`, :8787) held the whole week of its recording in memory: every depth column of every market and every
footprint row. On a copy of the live recording (28 depth books, 12 footprint markets, Oct 5-12) the two recorders alone took **584 MB of
heap and 423 MB outside it (1.5 GB resident)** once loaded, and the server process about 1.9 GB. Most of that is days nobody looks at
most of the time. The browser path is unchanged: a page that reads the exchanges itself keeps one day, all in memory.

## What changed

- **Depth** (`shared/recorder.ts`). The server's `DepthRecorder` keeps `HOT_MS` (24 h) of columns in memory (`memoryMs`). Older ones stay
  in SQLite and are read back when a question reaches them (`ColumnStore.range`, by the hour; `ColumnStore.extent` gives what the store
  holds per market for `coverage()` and each market's grid step, so "recorded since" and the grid do not change). A recorder whose store
  cannot read back (the browser's IndexedDB store, tests) keeps all of its retention in memory, as before.
- **Footprint** (`shared/footprint.ts`). Each minute's sums and statistics stay in memory for the week (the sizes, the dot rows and "which
  minutes are recorded" read them); its rows only for 24 h. Older rows are read back by the hour (`FootprintStore.range`). A late trade
  or order for a minute only the store holds reads that minute back into memory first, so what is written for it next is all of it.
- **Kept for the next question.** Hours read back are kept (16 M bins of depth, about three days of every BTC book, some 190 MB at
  most; 20,000 footprint minutes, about a day of its markets), merged windows as before (6 M bins). Only what can no longer change is kept:
  depth hours wholly before the first minute memory holds, footprint hours wholly before the first minute with rows in memory; both go at
  the retention cutoff, and a footprint hour goes when a minute in it is read back to be changed.
- **The columns route** (`/api/v2/columns`) answers instrument by instrument and lets the event loop run between them, so a first look at
  older days (which reads the disk) does not hold every other request for the whole answer.

What does not change: every answer. Two recorders over the same copied recording, the old one holding the week and the new one reading
back, gave the same answer to 656 questions (depth columns at 1 to 32 minutes over windows in and out of memory, footprint bars, ranges,
profiles, value areas, sizes; floats to 1e-9 relative where footprint sums add in another order); two throwaway servers on spare ports
over copies of the same recording gave byte-identical answers on every route compared (12 of 12).

### The cache that kept nothing

Measuring the refresh found a second problem, in the old code too. The page asks for its whole window again every 30 s
(`heat-pane.ts`), and the merged windows were kept least recently asked first, letting the oldest go one by one. A two-day view of every
market is more windows than the cache holds, so each window was let go just before it was asked again: the refresh found **none** of
them and merged everything, every 30 s. And letting go one entry at a time from the front of a `Map` walks every entry deleted since the
map was last rebuilt: about 20 µs per window kept (180,000 keeps took 3.9 s one at a time, 0.2 s made room for in one go). The old
server's two-day refresh took longer than its first answer (2.7 s against 2.1 s).

`KeptCache` (`shared/kept-cache.ts`) is now what both recorders keep things in: it makes room in one go (down to seven eighths of its
limit), and it never lets go an entry asked within 45 s (`PROTECT_MS`); when everything is that recent, the new entry is simply not kept.
So a refresh finds what it found the time before and merges only the rest. The price: after a zoom, the windows of the view before stay
for up to 45 s after its last refresh, so the new view may be merged afresh once more before it is kept. A tab in the background, which
the browser lets refresh once a minute, does not hold its share.

## Measured

Recorders alone, Node 22, the copied recording, the clock at the copy's time (`--expose-gc`, after two collections):

| | old (the week in memory) | new (a day in memory) |
|---|---|---|
| load | 8-12 s | 5.6-6.2 s |
| after load: heap / outside the heap / resident | 584 MB / 423 MB / 1,514 MB | 122 MB / 73 MB / 484 MB |
| after every question below: heap / outside / resident | 628 MB / 492 MB / 1,695 MB | 263 MB / 326 MB / 1,240 MB |

The second row is what the server holds at rest; the third includes everything the caches keep once a person has looked at the whole
week (resident memory also counts what the allocator has not given back).

The questions the page asks (every market, in parts of 12; the clock moves 30 s between a question and its refresh and two minutes
between views, as a person using the page would):

| question | old: first | old: again | new: first | new: again |
|---|---|---|---|---|
| 1-day live view at 1 min (36 h) | 1 ms | 1 ms | 395 ms | 23 ms |
| 2-day live view at 2 min (72 h) | 2,063 ms | 2,747 ms | 3,217 ms | **755 ms** |
| week view at 8 min | 2,220 ms | 87 ms | 5,486 ms | 74 ms |
| Range over 2 old days (footprint) | 219 ms | 218 ms | 1,847 ms | 795 ms |
| value area of an old day | 142 ms | 92 ms | 544 ms | 111 ms |
| profile of 30 h | 162 ms | 143 ms | 297 ms | 154 ms |

"First" for the new server is the first look after a start: the disk is read once and kept. With the clock frozen instead (every entry
stays recently asked, the worst case for the 45 s rule), the week view asked right after the 2-day view is merged afresh each time
(3.9 s), since the 2-day view's windows fill the cache.

Two throwaway servers on spare ports (fixture feeds, no live venues) over copies of the same recording:

| | old | new |
|---|---|---|
| answering after start | 19.5 s | 13.4 s |
| private memory | 1,900 MB | 907 MB |
| first zoom out to the week (12 markets at 8 min) | 1.25 s | 3.29 s |
| worst wait of a small request meanwhile | 1,217 ms | 607 ms |
| the same zoom again | ~220 ms | ~220 ms |

## Still open

- **The first look at older days reads the disk**: a week view is 3-5 s the first time after a start (it was 2 s), a Range over two
  old days about 2 s. It is once per start for the depth (the cache holds about three days), but the footprint cache holds about a
  day of minutes, so asking again for a Range over two old days reads part of it again (0.8 s; it was 0.2 s). The panel asks again only
  for a live selection, so this is a person selecting the same old days twice.
- **The footprint still parses the week at start** (its sums and statistics are built from the rows): 5.3 s against 6.1 s.
- **The page asks for its whole window every 30 s**, where only its newest minutes can have changed. Asking for the tail alone would cut
  every refresh (old server or new) to milliseconds; it is the next step, and a change to the page, not the server.
- Merged windows of days that have ended could be stored, so a first look at the week after a start would not merge it again.
