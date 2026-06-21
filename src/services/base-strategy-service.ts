import { EventEmitter } from 'events';
import {
  RealtimeServiceV2,
  type MarketDataHandlers,
  type MarketSubscription,
  type OrderbookSnapshot,
} from './realtime-service-v2.js';
import { TradingService } from './trading-service.js';
import { MarketService } from './market-service.js';

export interface BaseStrategyServiceOptions<TConfig extends object> {
  /** Human-readable service name used in lifecycle errors. */
  strategyName: string;
  /** Initial strategy configuration. Subclasses can mutate it through protected helpers. */
  config: TConfig;
  /** Realtime data source used by the strategy lifecycle. */
  realtimeService: RealtimeServiceV2;
  /** Optional execution service. Monitor-only strategies can omit this. */
  tradingService?: TradingService | null;
  /** Optional market-data service for strategies that discover or enrich markets. */
  marketService?: MarketService | null;
  /** Disconnect the realtime service on stop. Leave false when realtime is shared by a parent SDK. */
  disconnectRealtimeOnStop?: boolean;
  /** Optional custom duplicate-start message for backward-compatible errors. */
  alreadyRunningMessage?: string;
}

/**
 * Base lifecycle for realtime market strategies.
 *
 * Custom strategies only need to provide token selection and orderbook logic:
 * `getMarketTokenIds()` chooses subscriptions and `handleOrderbookUpdate()`
 * implements the strategy-specific signal/execution behavior.
 */
export abstract class BaseStrategyService<
  TMarket,
  TConfig extends object = Record<string, never>,
> extends EventEmitter {
  protected readonly strategyName: string;
  protected readonly realtimeService: RealtimeServiceV2;
  protected tradingService: TradingService | null;
  protected readonly marketService: MarketService | null;
  protected config: TConfig;

  protected market: TMarket | null = null;
  protected marketSubscription: MarketSubscription | null = null;
  protected isRunning = false;
  protected isExecuting = false;
  protected lastExecutionTime = 0;

  private readonly disconnectRealtimeOnStop: boolean;
  private readonly alreadyRunningMessage?: string;

  constructor(options: BaseStrategyServiceOptions<TConfig>) {
    super();
    this.strategyName = options.strategyName;
    this.config = options.config;
    this.realtimeService = options.realtimeService;
    this.tradingService = options.tradingService ?? null;
    this.marketService = options.marketService ?? null;
    this.disconnectRealtimeOnStop = options.disconnectRealtimeOnStop ?? false;
    this.alreadyRunningMessage = options.alreadyRunningMessage;
  }

  /**
   * Start the strategy for a market using the standard realtime lifecycle.
   */
  async start(market: TMarket): Promise<void> {
    this.assertCanStart();
    await this.validateMarket(market);

    this.market = market;
    this.isRunning = true;

    try {
      await this.onBeforeStart(market);
      await this.realtimeService.connect();
      await this.onAfterRealtimeConnected(market);

      const tokenIds = this.getMarketTokenIds(market);
      if (tokenIds.length > 0) {
        this.marketSubscription = this.realtimeService.subscribeMarkets(
          tokenIds,
          this.createMarketHandlers()
        );
      }

      await this.onAfterMarketSubscribed(market);
      this.emit('started', market);
      await this.onStarted(market);
    } catch (error) {
      await this.cleanupAfterStartFailure();
      throw error;
    }
  }

  /**
   * Stop the strategy and clean up lifecycle resources.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;

    try {
      await this.onBeforeStop();
    } finally {
      this.clearMarketSubscription();
      if (this.disconnectRealtimeOnStop) {
        this.realtimeService.disconnect();
      }
    }

    await this.onAfterStop();
    this.emit('stopped');
  }

  /**
   * Check whether the strategy lifecycle is currently active.
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Return the market currently being monitored.
   */
  getMarket(): TMarket | null {
    return this.market;
  }

  protected abstract getMarketTokenIds(market: TMarket): string[];

  protected abstract handleOrderbookUpdate(book: OrderbookSnapshot): void | Promise<void>;

  protected validateMarket(_market: TMarket): void | Promise<void> {}

  protected onBeforeStart(_market: TMarket): void | Promise<void> {}

  protected onAfterRealtimeConnected(_market: TMarket): void | Promise<void> {}

  protected onAfterMarketSubscribed(_market: TMarket): void | Promise<void> {}

  protected onStarted(_market: TMarket): void | Promise<void> {}

  protected onBeforeStop(): void | Promise<void> {}

  protected onAfterStop(): void | Promise<void> {}

  protected updateStrategyConfig(config: Partial<TConfig>): void {
    this.config = {
      ...this.config,
      ...config,
    };
  }

  protected getStrategyConfig(): TConfig {
    return { ...this.config };
  }

  protected async initializeTradingService(options: { rethrow?: boolean; onError?: (error: unknown) => void } = {}): Promise<boolean> {
    if (!this.tradingService) return false;

    try {
      await this.tradingService.initialize();
      return true;
    } catch (error) {
      options.onError?.(error);
      if (options.rethrow ?? true) {
        throw error;
      }
      return false;
    }
  }

  protected handleStrategyError(error: unknown): void {
    this.emit('error', error instanceof Error ? error : new Error(String(error)));
  }

  private assertCanStart(): void {
    if (this.isRunning) {
      throw new Error(this.alreadyRunningMessage ?? `${this.strategyName} is already running. Call stop() first.`);
    }
  }

  private createMarketHandlers(): MarketDataHandlers {
    return {
      onOrderbook: (book: OrderbookSnapshot) => {
        try {
          const maybePromise = this.handleOrderbookUpdate(book);
          if (maybePromise instanceof Promise) {
            maybePromise.catch((error) => this.handleStrategyError(error));
          }
        } catch (error) {
          this.handleStrategyError(error);
        }
      },
      onError: (error: Error) => this.handleStrategyError(error),
    };
  }

  private clearMarketSubscription(): void {
    if (this.marketSubscription) {
      this.marketSubscription.unsubscribe();
      this.marketSubscription = null;
    }
  }

  private async cleanupAfterStartFailure(): Promise<void> {
    this.isRunning = false;
    this.isExecuting = false;

    try {
      await this.onBeforeStop();
    } catch (cleanupError) {
      if (this.listenerCount('error') > 0) {
        this.handleStrategyError(cleanupError);
      }
    } finally {
      this.clearMarketSubscription();
      if (this.disconnectRealtimeOnStop) {
        this.realtimeService.disconnect();
      }
      this.market = null;
    }
  }
}
