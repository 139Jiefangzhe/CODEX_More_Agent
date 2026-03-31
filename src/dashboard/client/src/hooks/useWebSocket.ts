import { useEffect } from 'react';

import { useWsStore } from '../stores/ws-store';

export function useWebSocket(options: any = {}) {
  const connect = useWsStore((state) => state.connect);
  const subscribe = useWsStore((state) => state.subscribe);
  const unsubscribe = useWsStore((state) => state.unsubscribe);
  const addListener = useWsStore((state) => state.addListener);
  const status = useWsStore((state) => state.status);

  useEffect(function () {
    connect();
  }, [connect]);

  useEffect(function () {
    if (options.enabled === false) {
      return undefined;
    }

    const channels = options.channels || [];
    subscribe(channels);
    const removeListener = options.onEvent ? addListener(options.onEvent) : undefined;

    return function () {
      unsubscribe(channels);
      removeListener?.();
    };
  }, [addListener, options.channels, options.enabled, options.onEvent, subscribe, unsubscribe]);

  return { status };
}
