import { describe, expect, it, vi } from 'vitest';
import { PolymarketSDK } from './index.js';

describe('PolymarketSDK lifecycle', () => {
  it('awaits DipArb cleanup before disconnecting shared realtime', async () => {
    const sdk = new PolymarketSDK();
    const order: string[] = [];

    vi.spyOn(sdk.dipArb, 'stop').mockImplementation(async () => {
      order.push('dip-stop-start');
      await Promise.resolve();
      order.push('dip-stop-end');
    });
    vi.spyOn(sdk.realtime, 'disconnect').mockImplementation(() => {
      order.push('realtime-disconnect');
    });

    const stopResult = sdk.stop();

    expect(stopResult).toBeInstanceOf(Promise);
    await stopResult;
    expect(order).toEqual(['dip-stop-start', 'dip-stop-end', 'realtime-disconnect']);
  });

  it('disconnects shared realtime when DipArb cleanup rejects', async () => {
    const sdk = new PolymarketSDK();
    const disconnect = vi.spyOn(sdk.realtime, 'disconnect').mockImplementation(() => {});

    vi.spyOn(sdk.dipArb, 'stop').mockRejectedValueOnce(new Error('dip stop failed'));

    await expect(sdk.stop()).rejects.toThrow('dip stop failed');
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
