import { create } from 'zustand';

import { useSessionStore } from './session-store';

const listeners = new Set<(message: any) => void>();

export const useWsStore = create<any>(function (set, get) {
  return {
    status: 'disconnected',
    transport: 'none',
    reconnectAttempts: 0,
    lastEventId: 0,
    lastPong: null,
    subscribedChannels: new Set(),
    socket: null,
    eventSource: null,
    reconnectTimer: null,
    upgradeTimer: null,
    manualClose: false,
    connect() {
      set({ manualClose: false });
      const existing = get().socket;
      const existingSse = get().eventSource;

      if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
        return;
      }

      if (existingSse && (existingSse.readyState === EventSource.OPEN || existingSse.readyState === EventSource.CONNECTING)) {
        return;
      }

      clearTimer(get().reconnectTimer);
      set({ reconnectTimer: null });
      get().connectViaWs(false);
    },
    connectViaWs(isUpgradeProbe) {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(protocol + '//' + window.location.host + '/ws');
      let opened = false;
      set({ socket, status: 'connecting', transport: isUpgradeProbe ? get().transport : 'ws' });

      socket.onopen = function () {
        const channels = Array.from(get().subscribedChannels);
        opened = true;
        get().closeEventSource();
        set({ status: 'connected', reconnectAttempts: 0, transport: 'ws' });

        if (channels.length > 0) {
          socket.send(JSON.stringify({
            type: 'subscribe',
            channels,
            lastEventId: get().lastEventId || undefined,
          }));
        }
      };

      socket.onmessage = function (event) {
        const message = JSON.parse(event.data);
        const eventId = extractEventId(message);

        if (eventId && eventId > (get().lastEventId || 0)) {
          set({ lastEventId: eventId });
        }

        if (message.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong' }));
          set({ lastPong: Date.now() });
          return;
        }

        useSessionStore.getState().handleWsMessage(message);
        listeners.forEach(function (listener) {
          listener(message);
        });
      };

      socket.onclose = function () {
        if (get().socket !== socket) {
          return;
        }

        set({ socket: null });

        if (get().manualClose) {
          set({ status: 'disconnected', transport: 'none' });
          return;
        }

        if (!opened) {
          get().connectViaSse();
          return;
        }

        const attempts = get().reconnectAttempts + 1;
        const delay = Math.min(1000 * Math.pow(2, attempts - 1), 15000);
        set({ status: 'connecting', reconnectAttempts: attempts, transport: 'ws' });
        const timer = window.setTimeout(function () {
          get().connectViaWs(false);
        }, delay);
        set({ reconnectTimer: timer });
      };

      socket.onerror = function () {
        if (get().socket === socket) {
          set({ status: 'connecting' });
        }
      };
    },
    connectViaSse() {
      if (typeof EventSource === 'undefined') {
        get().connectViaWs(false);
        return;
      }

      const existing = get().eventSource;

      if (existing && (existing.readyState === EventSource.OPEN || existing.readyState === EventSource.CONNECTING)) {
        return;
      }

      const channels = Array.from(get().subscribedChannels);
      const params = new URLSearchParams();

      if (channels.length > 0) {
        params.set('channels', channels.join(','));
      }

      if (get().lastEventId > 0) {
        params.set('lastEventId', String(get().lastEventId));
      }

      const url = '/api/stream' + (params.toString() ? '?' + params.toString() : '');
      const source = new EventSource(url);
      set({ eventSource: source, status: 'connecting', transport: 'sse' });

      source.onopen = function () {
        set({ status: 'connected', reconnectAttempts: 0, transport: 'sse' });
        get().ensureUpgradeProbe();
      };

      source.onmessage = function (event) {
        let message = null;

        try {
          message = JSON.parse(event.data);
        } catch {
          message = null;
        }

        if (!message || typeof message !== 'object') {
          return;
        }

        const eventId = extractEventId(message);

        if (eventId && eventId > (get().lastEventId || 0)) {
          set({ lastEventId: eventId });
        }

        useSessionStore.getState().handleWsMessage(message);
        listeners.forEach(function (listener) {
          listener(message);
        });
      };

      source.onerror = function () {
        if (get().manualClose) {
          return;
        }

        if (source.readyState === EventSource.CLOSED) {
          get().closeEventSource();
          get().connectViaWs(false);
        }
      };
    },
    ensureUpgradeProbe() {
      if (get().upgradeTimer) {
        return;
      }

      const timer = window.setInterval(function () {
        if (get().transport !== 'sse' || get().manualClose) {
          return;
        }

        const existing = get().socket;

        if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
          return;
        }

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const probe = new WebSocket(protocol + '//' + window.location.host + '/ws');
        let settled = false;
        const timeout = window.setTimeout(function () {
          if (settled) {
            return;
          }

          settled = true;
          probe.close();
        }, 3000);

        probe.onopen = function () {
          if (settled) {
            return;
          }

          settled = true;
          window.clearTimeout(timeout);
          probe.close();
          get().closeEventSource();
          get().connectViaWs(true);
        };

        probe.onerror = function () {
          if (settled) {
            return;
          }

          settled = true;
          window.clearTimeout(timeout);
          probe.close();
        };

        probe.onclose = function () {
          if (settled) {
            return;
          }

          settled = true;
          window.clearTimeout(timeout);
        };
      }, 30000);

      set({ upgradeTimer: timer });
    },
    stopUpgradeProbe() {
      clearTimer(get().upgradeTimer);
      set({ upgradeTimer: null });
    },
    closeEventSource() {
      const source = get().eventSource;

      if (source) {
        source.close();
      }

      get().stopUpgradeProbe();
      set({ eventSource: null });
    },
    disconnect() {
      set({ manualClose: true });
      const socket = get().socket;
      if (socket) {
        socket.close();
      }
      get().closeEventSource();
      clearTimer(get().reconnectTimer);
      set({ status: 'disconnected', transport: 'none', socket: null, reconnectTimer: null });
    },
    subscribe(channels) {
      const next = new Set(get().subscribedChannels);
      channels.forEach(function (channel) {
        next.add(channel);
      });
      set({ subscribedChannels: next });
      if (get().socket?.readyState === WebSocket.OPEN) {
        get().socket.send(JSON.stringify({
          type: 'subscribe',
          channels,
          lastEventId: get().lastEventId || undefined,
        }));
      }

      if (get().transport === 'sse') {
        get().closeEventSource();
        get().connectViaSse();
      }
    },
    unsubscribe(channels) {
      const next = new Set(get().subscribedChannels);
      channels.forEach(function (channel) {
        next.delete(channel);
      });
      set({ subscribedChannels: next });
      if (get().socket?.readyState === WebSocket.OPEN) {
        get().socket.send(JSON.stringify({ type: 'unsubscribe', channels }));
      }

      if (get().transport === 'sse') {
        get().closeEventSource();
        get().connectViaSse();
      }
    },
    addListener(listener) {
      listeners.add(listener);
      return function () {
        listeners.delete(listener);
      };
    },
  };
});

function clearTimer(value) {
  if (value) {
    window.clearTimeout(value);
    window.clearInterval(value);
  }
}

function extractEventId(message: any): number {
  const value = Number.parseInt(String(message?.data?.eventId ?? ''), 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}
