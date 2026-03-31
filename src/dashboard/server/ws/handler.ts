export function registerWebSocket(app, services) {
  const eventBus = services.eventBus;
  const db = services.db;

  app.get('/api/stream', async function (request, reply) {
    const channels = parseChannels(request.query?.channels);
    const lastEventId = toPositiveInt(request.query?.lastEventId);
    const replayLimit = clamp(toPositiveInt(request.query?.replayLimit) ?? 400, 1, 1000);
    const socket = reply.raw;
    const subscriptions = [];
    let closed = false;

    socket.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    socket.write(': connected\n\n');

    if (lastEventId) {
      for (const replayEvent of loadReplayEvents(db, channels, lastEventId, replayLimit)) {
        if (closed) {
          break;
        }

        try {
          socket.write('data: ' + JSON.stringify(replayEvent) + '\n\n');
        } catch {
          break;
        }
      }
    }

    for (const channel of channels) {
      subscriptions.push(
        eventBus.subscribe(channel, function (event) {
          if (closed) {
            return;
          }

          try {
            socket.write('data: ' + JSON.stringify(event) + '\n\n');
          } catch {
            return;
          }
        }),
      );
    }

    const heartbeat = setInterval(function () {
      if (closed) {
        return;
      }

      try {
        socket.write(': ping\n\n');
      } catch {
        return;
      }
    }, 25000);
    heartbeat.unref?.();

    request.raw.on('close', function () {
      closed = true;
      clearInterval(heartbeat);
      for (const unsubscribe of subscriptions) {
        unsubscribe();
      }
    });
  });

  app.get('/ws', { websocket: true }, function (connection) {
    const socket = resolveSocket(connection);

    if (!socket) {
      return;
    }

    const subscriptions = new Map();
    let lastPong = Date.now();

    const heartbeat = setInterval(function () {
      if (Date.now() - lastPong > 60000) {
        socket.close?.();
        clearInterval(heartbeat);
        return;
      }

      safeSend(socket, { type: 'ping' });
    }, 30000);
    heartbeat.unref?.();

    socket.on('message', function (rawMessage) {
      try {
        const message = JSON.parse(rawMessage.toString());

        if (message.type === 'pong') {
          lastPong = Date.now();
          return;
        }

        if (message.type === 'subscribe' && Array.isArray(message.channels)) {
          const channels = message.channels.map(function (channel) {
            return String(channel).trim();
          }).filter(Boolean);
          const lastEventId = toPositiveInt(message.lastEventId);
          const replayLimit = clamp(toPositiveInt(message.replayLimit) ?? 400, 1, 1000);

          if (lastEventId) {
            for (const replayEvent of loadReplayEvents(db, channels, lastEventId, replayLimit)) {
              safeSend(socket, replayEvent);
            }
          }

          for (const channel of channels) {
            if (subscriptions.has(channel)) {
              continue;
            }

            const unsubscribe = eventBus.subscribe(channel, function (event) {
              safeSend(socket, event);
            });
            subscriptions.set(channel, unsubscribe);
          }
          return;
        }

        if (message.type === 'unsubscribe' && Array.isArray(message.channels)) {
          for (const channel of message.channels) {
            const unsubscribe = subscriptions.get(channel);

            if (unsubscribe) {
              unsubscribe();
              subscriptions.delete(channel);
            }
          }
        }
      } catch (error) {
        safeSend(socket, {
          type: 'agent:event',
          data: {
            sessionId: 'system',
            agentRunId: 'system',
            agentType: 'reviewer',
            eventType: 'error',
            payload: {
              message: error instanceof Error ? error.message : String(error),
            },
            timestamp: new Date().toISOString(),
          },
        });
      }
    });

    socket.on('close', function () {
      clearInterval(heartbeat);

      for (const unsubscribe of subscriptions.values()) {
        unsubscribe();
      }

      subscriptions.clear();
    });
  });
}

function parseChannels(rawChannels) {
  const source = String(rawChannels || '').trim();

  if (!source) {
    return ['system'];
  }

  return source
    .split(',')
    .map(function (channel) {
      return channel.trim();
    })
    .filter(Boolean);
}

function resolveSocket(connection) {
  if (connection?.socket && typeof connection.socket.send === 'function') {
    return connection.socket;
  }

  if (connection && typeof connection.send === 'function') {
    return connection;
  }

  return null;
}

function safeSend(socket, payload) {
  if (!socket || typeof socket.send !== 'function') {
    return;
  }

  if (typeof socket.readyState === 'number' && socket.readyState !== 1) {
    return;
  }

  try {
    socket.send(JSON.stringify(payload));
  } catch {
    return;
  }
}

function loadReplayEvents(db, channels, lastEventId, replayLimit) {
  if (!db || !lastEventId || replayLimit <= 0) {
    return [];
  }

  const sessionIds = channels
    .filter(function (channel) {
      return channel.startsWith('session:');
    })
    .map(function (channel) {
      return channel.slice('session:'.length);
    })
    .filter(Boolean);
  const hasSystemChannel = channels.includes('system');

  if (sessionIds.length === 0 && !hasSystemChannel) {
    return [];
  }

  const rows = queryReplayRows(db, sessionIds, lastEventId, replayLimit);

  return rows.map(function (row) {
    return {
      type: 'agent:event',
      timestamp: row.timestamp,
      data: {
        sessionId: row.session_id,
        agentRunId: row.agent_run_id,
        agentType: row.agent_type || 'reviewer',
        eventType: row.event_type,
        payload: parseEventData(row.event_data),
        timestamp: row.timestamp,
        eventId: Number(row.id),
      },
    };
  });
}

function queryReplayRows(db, sessionIds, lastEventId, replayLimit) {
  const baseSql = [
    'SELECT e.id, e.agent_run_id, e.session_id, e.timestamp, e.event_type, e.event_data,',
    "COALESCE(r.agent_type, 'reviewer') AS agent_type",
    'FROM agent_events e',
    'LEFT JOIN agent_runs r ON r.id = e.agent_run_id',
    'WHERE e.id > ?',
  ];
  const params = [lastEventId];

  if (sessionIds.length > 0) {
    const placeholders = sessionIds.map(function () {
      return '?';
    }).join(', ');
    baseSql.push('AND e.session_id IN (' + placeholders + ')');
    params.push(...sessionIds);
  }

  baseSql.push('ORDER BY e.id ASC LIMIT ?');
  params.push(replayLimit);

  return db.prepare(baseSql.join(' ')).all(...params);
}

function parseEventData(raw) {
  if (raw && typeof raw === 'object') {
    return raw;
  }

  try {
    return JSON.parse(String(raw || '{}'));
  } catch {
    return {};
  }
}

function toPositiveInt(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
