import { describe, it, expect, vi } from 'vitest';
import { BaseStrategyService } from './base-strategy-service.js';
import type { MarketDataHandlers, MarketSubscription, OrderbookSnapshot } from './realtime-service-v2.js';

interface TestMarket {
  name: string;
  yesTokenId: string;
  noTokenId: string;
}

interface TestConfig {
  autoExecute: boolean;
}

function makeRealtimeService() {
  let handlers: MarketDataHandlers | null = null;
  const unsubscribe = vi.fn();
  const subscription: MarketSubscription = {
    id: 'sub-1',
    topic: 'market',
    type: 'market',
    tokenIds: ['yes-token', 'no-token'],
    unsubscribe,
  };

  const realtime = {
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(),
    subscribeMarkets: vi.fn((tokenIds: string[], nextHandlers: MarketDataHandlers) => {
      handlers = nextHandlers;
      return { ...subscription, tokenIds };
    }),
  };

  return {
    realtime,
    getHandlers: () => handlers,
    unsubscribe,
  };
}

class TestStrategy extends BaseStrategyService<TestMarket, TestConfig> {
  readonly books: OrderbookSnapshot[] = [];
  readonly hooks: string[] = [];

  protected getMarketTokenIds(market: TestMarket): string[] {
    return [market.yesTokenId, market.noTokenId];
  }

  protected handleOrderbookUpdate(book: OrderbookSnapshot): void {
    this.books.push(book);
  }

  protected override onBeforeStart(market: TestMarket): void {
    this.hooks.push(`before:${market.name}`);
  }

  protected override onAfterStop(): void {
    this.hooks.push('after-stop');
  }
}

describe('BaseStrategyService', () => {
  it('lets a custom strategy inherit realtime lifecycle by defining token and orderbook logic', async () => {
    const { realtime, getHandlers, unsubscribe } = makeRealtimeService();
    const strategy = new TestStrategy({
      strategyName: 'TestStrategy',
      config: { autoExecute: false },
      realtimeService: realtime as any,
      disconnectRealtimeOnStop: true,
    });
    const started = vi.fn();
    const stopped = vi.fn();
    strategy.on('started', started);
    strategy.on('stopped', stopped);

    await strategy.start({
      name: 'example',
      yesTokenId: 'yes-token',
      noTokenId: 'no-token',
    });

    expect(strategy.isActive()).toBe(true);
    expect(strategy.getMarket()).toEqual({
      name: 'example',
      yesTokenId: 'yes-token',
      noTokenId: 'no-token',
    });
    expect(realtime.connect).toHaveBeenCalledTimes(1);
    expect(realtime.subscribeMarkets).toHaveBeenCalledWith(
      ['yes-token', 'no-token'],
      expect.objectContaining({ onOrderbook: expect.any(Function), onError: expect.any(Function) })
    );
    expect(started).toHaveBeenCalledWith({
      name: 'example',
      yesTokenId: 'yes-token',
      noTokenId: 'no-token',
    });

    const book: OrderbookSnapshot = {
      tokenId: 'yes-token',
      assetId: 'yes-token',
      market: 'condition-id',
      tickSize: '0.01',
      minOrderSize: '5',
      hash: 'hash',
      bids: [{ price: 0.4, size: 10 }],
      asks: [{ price: 0.41, size: 5 }],
      timestamp: 123,
    };
    getHandlers()?.onOrderbook?.(book);

    expect(strategy.books).toEqual([book]);

    await strategy.stop();

    expect(strategy.isActive()).toBe(false);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(realtime.disconnect).toHaveBeenCalledTimes(1);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(strategy.hooks).toEqual(['before:example', 'after-stop']);
  });

  it('cleans up subscription state when startup fails after subscribing', async () => {
    const { realtime, unsubscribe } = makeRealtimeService();
    class FailingStrategy extends TestStrategy {
      protected override onAfterMarketSubscribed(): void {
        throw new Error('startup hook failed');
      }
    }
    const strategy = new FailingStrategy({
      strategyName: 'FailingStrategy',
      config: { autoExecute: false },
      realtimeService: realtime as any,
      disconnectRealtimeOnStop: true,
    });

    await expect(strategy.start({
      name: 'example',
      yesTokenId: 'yes-token',
      noTokenId: 'no-token',
    })).rejects.toThrow('startup hook failed');

    expect(strategy.isActive()).toBe(false);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(realtime.disconnect).toHaveBeenCalledTimes(1);
  });

  it('runs subclass cleanup when startup fails after subclass resources are created', async () => {
    const { realtime } = makeRealtimeService();
    realtime.connect.mockRejectedValueOnce(new Error('connect failed'));

    class ResourceStrategy extends TestStrategy {
      resourceActive = false;

      protected override onBeforeStart(market: TestMarket): void {
        super.onBeforeStart(market);
        this.resourceActive = true;
      }

      protected override onBeforeStop(): void {
        this.resourceActive = false;
        this.hooks.push('before-stop');
      }
    }

    const strategy = new ResourceStrategy({
      strategyName: 'ResourceStrategy',
      config: { autoExecute: false },
      realtimeService: realtime as any,
      disconnectRealtimeOnStop: true,
    });

    await expect(strategy.start({
      name: 'example',
      yesTokenId: 'yes-token',
      noTokenId: 'no-token',
    })).rejects.toThrow('connect failed');

    expect(strategy.isActive()).toBe(false);
    expect(strategy.resourceActive).toBe(false);
    expect(strategy.hooks).toEqual(['before:example', 'before-stop']);
    expect(realtime.disconnect).toHaveBeenCalledTimes(1);
  });
});
