import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import { holdSetupPort } from '../lib/ui/setup-port';

function fakePort() {
  const listeners: Array<() => void> = [];
  const port = {
    disconnect: vi.fn(),
    onDisconnect: {
      addListener: (listener: () => void) => listeners.push(listener),
    },
  } as unknown as Browser.runtime.Port;

  return {
    port,
    remoteDisconnect: () => listeners.forEach((listener) => listener()),
  };
}

describe('setup presence port', () => {
  afterEach(() => vi.useRealTimers());

  it('reattaches after a service-worker disconnect and releases the live port on completion', async () => {
    vi.useFakeTimers();
    const first = fakePort();
    const second = fakePort();
    const connect = vi.fn()
      .mockReturnValueOnce(first.port)
      .mockReturnValueOnce(second.port);
    const release = holdSetupPort(connect, 500);

    first.remoteDisconnect();
    await vi.advanceTimersByTimeAsync(500);

    expect(connect).toHaveBeenCalledTimes(2);
    release();
    expect(second.port.disconnect).toHaveBeenCalledTimes(1);
  });

  it('does not reconnect after setup completes while a retry is pending', async () => {
    vi.useFakeTimers();
    const first = fakePort();
    const connect = vi.fn().mockReturnValue(first.port);
    const release = holdSetupPort(connect, 500);

    first.remoteDisconnect();
    release();
    await vi.advanceTimersByTimeAsync(500);

    expect(connect).toHaveBeenCalledTimes(1);
  });
});
