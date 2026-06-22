# Backtest CLI Design Spec

## Goal

Build a TypeScript command-line backtesting tool for the root `polymarket-bot-app` package. The tool discovers historical Polymarket crypto up/down markets by slug regex, runs a selected strategy over those markets with bounded parallelism, writes one Plotly chart per processed market, shows real-time progress, and emits an hourly stats CSV for the entire requested backtest window.

## Scope

The backtest CLI lives under a new root-app module tree, `src/backtest`, and imports `@catalyst-team/poly-sdk` for market, trade, price-history, and Binance access where those APIs are already exposed.

The first supported strategy is `dip-arb`. The strategy exists to prove the strategy interface, execution runner, charts, and stats output. The architecture must allow additional strategies to be registered later through the same interface.

## User-Facing CLI Contract

The executable command is:

```bash
npm run backtest -- [options]
```

Time window options:

- `--months <months>`: Backtest the last N UTC months from the current clock.
- `--from <iso>` and `--to <iso>`: Explicit UTC bounds. These must be provided together.
- If neither explicit bounds nor `--months` are provided, the default is one month.

Strategy and sizing options:

- `--strategy <name>`: Strategy registry name; default `dip-arb`.
- `--coin <coin>`: One of `btc`, `eth`, or `sol`, used for fetching Binance K-line data; default `btc`.
- `--markets <regex>`: Regex to match Gamma market slugs; default `<coin>`+`-updown-5m-\d+`.
- `--param <key=value>`: Repeatable strategy parameter.

Execution and output options:

- `--concurrency <count>`: Number of markets to process concurrently; default `8`.
- `--output <dir>`: Output directory; default `backtest-output`.
- `--price-fidelity <count>`: Optional CLOB price history fidelity.
- `--underlying-interval <interval>`: Binance K-line candle interval, one of `1m`, `5m`, `15m`, or `1h`; default `1m`.

## Data Sources

Discovery:

- Use Gamma markets as the source for historical market discovery.
- Fetch closed markets in pages.
- Filter locally by slug regex and requested time window.
- The internal executable unit is a binary CLOB market, even if user-facing copy sometimes calls it an event.

Historical replay stream:

- The primary simulation input is an ordered `MarketReplayEvent[]`.
- Build `MarketReplayEvent[]` from every public historical market event available for the matched CLOB market inside the event time span.
- Include Data API market trades as `market_trade` replay events. These are the canonical strategy signal input because the same class of trade prints is available in backtests and live market subscriptions.
- Include CLOB `/prices-history` YES/NO points as `price_tick` replay events for chart continuity and coarse context only. A 5-minute strategy must not use these sparse minute-level points as its primary signal.
- Include synthetic `market_open` and `market_close` events at the discovered market bounds.
- Include Binance candles only as optional `underlying_tick` context events. These must not replace CLOB-derived replay events for CLOB-event-driven strategies.

Market price history:

- Use CLOB `/prices-history` through `sdk.markets.getDualKLines`.
- Use an internal CLOB history window of `max` plus exact market `startTs` and `endTs`.
- Treat this internal CLOB history window as an API lookback selector, not as the sampling interval of a 5-minute market.
- `priceHistoryWindow` is an internal constant set to `max`; it exists only because the SDK requires a CLOB `prices-history` window argument.
- `--price-fidelity` is passed through to CLOB `prices-history` as the requested point density or point count. It is not a candle interval, and the API may return fewer points if history is sparse.
- Convert Polymarket price history timestamps from Unix seconds to milliseconds once at the boundary.
- Convert outcome prices from probability units, `0-1`, into cents, `0-100`.

Observed market trades:

- Use Data API trades through `sdk.dataApi.getAllTrades`.
- Filter by market condition ID and market time span.
- Convert observed BUY executions into ask-side markers and observed SELL executions into bid-side markers for charting.
- Feed observed trades into per-outcome rolling buffers for strategy decisions.
- Maintain separate buffers for the two outcomes, normalized by token/outcome, with timestamp, price cents, size, side, and notional.
- Derive trend and momentum from these trade buffers, not from live-only quote updates. Required features are last trade price, short-window return, trade count, notional volume, side imbalance when side is reliable, time since last trade, and relative momentum between the two outcomes.
- Treat trades as executions, not resting order-book additions. The signal model observes executed prints; it does not infer unobserved order additions, cancellations, or depth.

Live strategy parity:

- The live strategy should reuse the same trade-buffer signal model used by the backtest.
- Live CLOB order-book or quote updates are execution gates only: best ask for buys, best bid for sells, spread, depth, slippage, and staleness checks.
- Live quote updates must not be part of the alpha signal unless the system also archives the same quote stream for replay. Otherwise the backtest and live strategy are testing different strategies.
- Backtests must model fills conservatively from observed trade prints plus explicit spread/slippage assumptions. They must not pretend historical best bid, best ask, or depth were known.

Underlying price:

- Use Binance K-lines through `sdk.binance.getKLines` only as auxiliary underlying context for strategies and plots.
- Supported symbols are derived from `--coin`:
  - `btc` -> `BTCUSDT`
  - `eth` -> `ETHUSDT`
  - `sol` -> `SOLUSDT`
- Fetch K-lines in chunks because Binance limits rows per request.

## Important Data Limitation

Polymarket public historical price data does not provide a complete historical resting order-book archive. Therefore this first version must not fabricate historical bid/ask curves.

This creates a strict strategy-design rule: backtestable strategy signals must be derived from historical trades and other replayable context, not from live-only CLOB quote updates. Quote-derived data may still protect live execution, but it is an execution filter rather than the source of the signal.

The chart must contain:

- Continuous YES and NO historical price lines from CLOB price history.
- Observed trade-side markers derived from Data API trades:
  - observed YES ask executions,
  - observed YES bid executions,
  - observed NO ask executions,
  - observed NO bid executions.
- Bot-generated buy/sell markers from strategy simulation.

If a later version needs true historical bid/ask curves, it requires an external order-book archive or a separately collected depth dataset.

The same limitation applies to "all historical CLOB events": the first version can replay all historical public events available through planned data sources, but it cannot replay live-only CLOB WebSocket book-update events unless those events were separately archived.

## Strategy Signal And Execution Model

The selected option is trade-based signal generation with quote-gated live execution.

Signal generation:

- The strategy consumes `market_trade` events as the primary signal source.
- The strategy keeps one rolling `OutcomeTradeBuffer` per outcome.
- Each buffer tracks the most recent trades inside a configurable time window or count window.
- Signal features are computed from the buffers after each new trade:
  - last trade price,
  - short-window price return,
  - weighted price change by notional,
  - trade count,
  - notional volume,
  - buy/sell imbalance when trade side is reliable,
  - time since last trade,
  - relative YES-vs-NO momentum.
- A candidate entry or hedge signal may be emitted only from data whose timestamp is less than or equal to the replay cursor. This prevents lookahead bias.

Backtest execution:

- The backtest has no historical bid/ask depth. It must simulate execution from observed trades and explicit assumptions only.
- A candidate buy can fill at the current or subsequent observed print for the selected outcome, adjusted by `assumedSpreadCents` or a stricter configured slippage model.
- A candidate sell can fill at the current or subsequent observed print for the selected outcome, adjusted conservatively in the opposite direction.
- If no observed print supports the simulated action before the market closes, the action is skipped or left unfilled according to the strategy's configured behavior.
- Price-history points may be plotted and may provide broad context, but they must not trigger entries, hedges, exits, or fills for this 5-minute strategy.

Live execution:

- The live version should process CLOB `last_trade_price` or equivalent trade events through the same per-outcome buffers.
- When the trade-buffer signal emits a candidate action, the live execution layer checks the current order book.
- Buy orders use best ask and available ask depth; sell orders use best bid and available bid depth.
- The live gate rejects stale books, excessive spread, insufficient depth, or quoted execution prices that erase the expected edge.
- This preserves backtest/live signal parity while still using the order book where it is actually required: deciding whether an order can be executed safely now.

## Core Data Model

The implementation defines these logical entities in `src/backtest/types.ts`:

- `BacktestTimeWindow`: resolved start/end timestamps in milliseconds and seconds.
- `BacktestCliConfig`: validated CLI options and derived fields.
- `BacktestMarket`: condition ID, slug, question, time span, and binary outcome names.
- `SeriesPoint`: timestamped numeric value for prices or underlying data.
- `MarketPriceSeries`: YES and NO market price series.
- `ObservedTradePoint`: observed market trade marker with side, outcome, price cents, and size.
- `MarketReplayEvent`: ordered event consumed by the strategy runner. Event types are `market_open`, `price_tick`, `market_trade`, `underlying_tick`, and `market_close`.
- `OutcomeTradeBuffer`: rolling per-outcome trade window used for backtestable signal generation.
- `TradeMomentumSnapshot`: derived features from one or both outcome buffers at a replay timestamp.
- `BotTrade`: simulated strategy trade with action, outcome, price, size, notional, cash flow, realized PnL, and reason.
- `EventBacktestInput`: all data needed by a strategy for one market, including the ordered `replayEvents`.
- `EventBacktestResult`: one market's simulated trades and PnL summary.
- `HourlyStatsSnapshot`: one CSV row for aggregate performance at an hourly timestamp.

## Module Responsibilities

`src/backtest/time-window.ts`

- Resolves `--months` or `--from`/`--to` into a concrete UTC time window.
- Rejects invalid, non-positive, partial, or inverted windows.

`src/backtest/cli-config.ts`

- Parses CLI arguments with `commander`.
- Validates positive numeric fields and supported enum values.
- Converts repeated `--param key=value` flags into a string map.
- Derives Binance symbol from coin.

`src/backtest/discovery.ts`

- Fetches Gamma closed markets by page.
- Filters by slug regex, condition ID presence, closed state, and requested window.
- Normalizes each result into `BacktestMarket`.
- Sorts matches by start time.

`src/backtest/history.ts`

- Loads YES/NO market price series from CLOB price history.
- Loads observed market trades from Data API.
- Loads auxiliary underlying K-lines from Binance.
- Builds one timestamp-ordered `MarketReplayEvent[]` from market-open, CLOB price ticks, market trades, optional underlying ticks, and market-close events.
- Marks market trades as the replayable strategy signal source and price ticks as chart/context events.
- Returns `EventBacktestInput` for one market.

`src/backtest/strategies/types.ts`

- Defines the strategy interface:

```ts
interface BacktestStrategy {
  name: string;
  run(input: EventBacktestInput): EventBacktestResult;
}
```

`src/backtest/strategies/dip-arb.ts`

- Implements the initial strategy based on `DipArbService`.
- Iterates over `input.replayEvents` in timestamp order.
- Maintains rolling trade buffers for the two outcomes.
- Computes trade-derived trend and momentum after each `market_trade` event.
- Simulates flash-crash detection (Leg 1) from trade-buffer momentum, price drops, and recent notional activity, not from minute-level CLOB price history.
- Buys the crashed side when trade-derived conditions are met and the conservative simulated fill model allows it.
- Waits for hedge condition (Leg 2) using the other outcome's trade buffer and buys the other side only when the simulated total basket cost remains below 100 cents after penalties.
- Uses `assumedSpreadCents`, default `1.5`, to apply a synthetic spread penalty to execution prices, avoiding the zero-slippage trap.
- Returns a skipped result when required trade data or executable observed prints are unavailable.

`src/backtest/strategies/registry.ts`

- Maps `dip-arb` to the starter strategy.
- Throws a clear error for unknown strategy names and lists available strategies.

`src/backtest/stats.ts`

- Aggregates event results into hourly snapshots from window start through window end.
- Computes cumulative PnL, equity, ROI, hourly return, annualized hourly Sharpe ratio, maximum drawdown, win rate, event count, and trade count.

`src/backtest/csv.ts`

- Serializes `HourlyStatsSnapshot[]` to CSV.
- Writes `<output>/stats-hourly.csv`.
- Uses explicit column order:
  - `timestampIso`
  - `timestampMs`
  - `eventsCompleted`
  - `trades`
  - `cumulativePnlUsd`
  - `equityUsd`
  - `roiPct`
  - `hourlyReturnPct`
  - `sharpeRatio`
  - `maxDrawdownUsd`
  - `maxDrawdownPct`
  - `winRatePct`

`src/backtest/plot.ts`

- Writes one HTML file per processed market under `<output>/plots`.
- Uses Plotly with:
  - x-axis: event time,
  - left y-axis: underlying USD price,
  - right y-axis: market price in cents, fixed to `0-100`.
- Includes traces for:
  - underlying USD,
  - YES price cents,
  - NO price cents,
  - observed YES ask executions,
  - observed YES bid executions,
  - observed NO ask executions,
  - observed NO bid executions,
  - bot BUY markers,
  - bot SELL markers.

`src/backtest/runner.ts`

- Runs markets with bounded concurrency using `p-limit`.
- Loads historical input, invokes the selected strategy, writes the plot, and returns the result.
- Emits progress callbacks containing completed count, total count, market slug, status, and error message when applicable.
- Converts per-market failures into skipped results instead of aborting the whole run.

`src/backtest/cli.ts`

- Wires the full workflow:
  1. Parse CLI config.
  2. Create output directory.
  3. Discover matching markets.
  4. Create the SDK with `autoConnect: false`.
  5. Resolve the strategy by name.
  6. Start a terminal progress bar.
  7. Run backtests with configured concurrency.
  8. Stop the SDK.
  9. Build hourly stats.
  10. Write `stats-hourly.csv`.
  11. Print summary paths and total PnL.

## Output Contract

For `--output backtest-output-btc-3m`, the CLI writes:

```text
backtest-output-btc-3m/
  stats-hourly.csv
  plots/
    <market-slug>.html
```

There is one plot file per successfully loaded and processed market. Markets that fail during historical loading or simulation return skipped results and do not need to produce a valid chart.

## Progress Contract

The CLI displays a real-time progress bar in the terminal:

```text
Backtesting |########--------| 12/40 | btc-updown-5m-...
```

The progress count advances once per market, whether that market completed successfully or failed and was converted to a skipped result.

## Package And TypeScript Changes

Runtime dependencies:

- `commander`
- `cli-progress`
- `p-limit`
- `plotly.js-dist-min`

Development dependency:

- `@types/cli-progress`, if TypeScript requires it.

Script changes:

- Add `backtest`: `tsx src/backtest/cli.ts`.
- Add `test:backtest`: `tsx --test src/backtest/**/*.test.ts`.
- Expand `test` to run all `src/**/*.test.ts`.

TypeScript config:

- Include `src/**/*.ts` so the new backtest modules and tests typecheck.

## Testing Requirements

Use Node's built-in test runner through `tsx --test`.

Required focused tests:

- `src/backtest/time-window.test.ts`: time-window resolution and validation.
- `src/backtest/cli-config.test.ts`: CLI parsing, numeric validation, regex, and strategy params.
- `src/backtest/discovery.test.ts`: market filtering by slug, closed state, condition ID, and window.
- `src/backtest/history.test.ts`: price/trade timestamp and unit normalization, plus correct `market_trade` and `price_tick` event classification.
- `src/backtest/strategies/dip-arb.test.ts`: starter strategy trade generation, trade-buffer momentum behavior, conservative fill behavior, and skip behavior.
- `src/backtest/stats.test.ts`: hourly PnL, ROI, drawdown, and win-rate aggregation.
- `src/backtest/csv.test.ts`: CSV header and row serialization.
- `src/backtest/plot.test.ts`: generated Plotly HTML contains double y-axis and bot markers.
- `src/backtest/runner.test.ts`: concurrency limit enforcement.

Required verification commands:

```bash
npm run test:backtest
npm run typecheck
npm run build
```

Required smoke command:

```bash
npm run backtest -- \
  --from 2026-06-01T00:00:00Z \
  --to 2026-06-08T00:00:00Z \
  --strategy dip-arb \
  --coin btc \
  --concurrency 2 \
  --param orderSize=5 \
  --param assumedSpreadCents=1.5 \
  --output backtest-output-smoke
```

Expected smoke output:

- CLI prints the resolved backtest window.
- CLI prints matched market count.
- Progress bar reaches completion.
- `backtest-output-smoke/stats-hourly.csv` exists.
- `backtest-output-smoke/plots/*.html` exists when at least one market has usable history.

## Acceptance Criteria

- Discovery finds historical closed Gamma markets whose slugs match a regex such as `btc-updown-5m-\d+` inside the requested time window.
- Each per-market strategy run consumes a timestamp-ordered `MarketReplayEvent[]` built from market trades, historical CLOB price ticks, market bounds, and optional underlying ticks.
- Strategy entries, hedges, exits, and fills for the 5-minute strategy are driven by observed `market_trade` events and conservative fill assumptions, not by sparse `/prices-history` points.
- The strategy maintains separate rolling trade buffers for both outcomes and computes trend/momentum without reading future replay events.
- The spec preserves live parity by treating real-time CLOB quote/order-book data as an execution gate only, not as a different live-only signal source.
- Runner processes markets concurrently with default concurrency `8` and never exceeds the configured limit.
- Real-time terminal progress is visible while the backtest runs.
- Each successfully processed market writes one Plotly HTML file under `<output>/plots`.
- Plotly output uses x-axis event time, left y-axis underlying USD, right y-axis market price in cents, YES/NO price lines, observed trade-side execution markers, and bot buy/sell markers.
- CSV output writes hourly snapshots over the full backtest window with PnL, ROI, Sharpe ratio, maximum drawdown, win rate, and supporting counts.
- `npm run test:backtest`, `npm run typecheck`, and `npm run build` pass.

## Out Of Scope

- True historical resting order-book bid/ask reconstruction without an external order-book archive.
- Using live-only quote updates as strategy alpha in a backtest that cannot replay those updates.
- Browser dashboard integration.
- Live trading or replaying orders through CLOB.
- Strategy-specific optimization sweeps.
- Persisted database cache.
- Changes to `@catalyst-team/poly-sdk` internals.
- Changes to `bot-config.ts` or `bot-with-dashboard.ts`.

## Design Decisions

The CLI is isolated from the dashboard and live bot because the root app currently has live-trading and dashboard concerns coupled around `bot-config.ts` and `bot-with-dashboard.ts`. Backtesting is a separate offline workflow with different error-handling and data-loading needs, so placing it under `src/backtest` keeps the runtime boundary clean.

The implementation uses the published SDK as the main API facade because this checkout is a root app that depends on `@catalyst-team/poly-sdk@^0.5.0`. Direct public HTTP is allowed only for Gamma discovery where the plan requires fields and pagination behavior that are easier to control explicitly.

The first version uses HTML files for charts instead of a dashboard page because the user requested saved plots in a folder. This also keeps the output portable and avoids adding a local web server.

The first version computes hourly stats after all event results are collected. Streaming stats can be added later, but batch aggregation is simpler, deterministic, and sufficient for producing the requested CSV.

The strategy uses option 3 from the data-source review: trade-based signal generation with quote-gated live execution. This keeps backtest and live signal logic aligned on replayable trade prints while preserving live order-book checks for execution safety. It deliberately rejects the inconsistent design where backtests evaluate trade records but live mode takes signals from unarchived quote updates.

## Implementation Plan Alignment

This spec maps to the same implementation phases as the saved implementation plan, but Task 4 and Task 5 must be updated before implementation to reflect the revised trade-buffer signal model:

- Project wiring maps to Task 1.
- CLI config and time-window behavior map to Task 2.
- Gamma market discovery maps to Task 3.
- Historical data loading maps to Task 4, with explicit `market_trade` versus chart-only `price_tick` classification.
- Strategy interface and `dip-arb` map to Task 5, with trade-buffer momentum and conservative observed-print fill modeling.
- Hourly metrics and CSV map to Task 6.
- Plotly output maps to Task 7.
- Concurrent runner and progress events map to Task 8.
- CLI entrypoint and smoke command map to Task 9.
- Final verification maps to Task 10.

Do not implement from the older plan without first carrying these option 3 revisions into it.

## Self-Review

- Placeholder scan: no unfinished marker or deferred requirement language is present.
- Consistency check: CLI flags, output paths, modules, tests, and acceptance criteria now consistently define trade-derived strategy signals and quote-gated live execution.
- Scope check: this is one offline CLI feature and does not require decomposition.
- Ambiguity check: historical bid/ask behavior is explicitly constrained to observed trade-side markers and conservative fill assumptions because no historical resting order-book archive is available in the planned data sources.
- Plan-alignment check: the spec explicitly says the saved implementation plan needs a follow-up revision before implementation.
