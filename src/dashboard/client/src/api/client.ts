const JSON_HEADERS = {
  'Content-Type': 'application/json',
};
const DASHBOARD_TOKEN_STORAGE_KEY = 'dashboard_token';

function normalizeHeaders(headers) {
  if (!headers) {
    return {};
  }

  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  return headers;
}

async function request(path: string, options: RequestInit = {}) {
  const dashboardToken = readDashboardToken();
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? JSON_HEADERS : {}),
      ...(dashboardToken ? { 'x-dashboard-token': dashboardToken } : {}),
      ...normalizeHeaders(options.headers),
    },
  });

  const text = await response.text();
  let payload = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    if (payload && typeof payload === 'object' && 'error' in payload) {
      throw new Error(String(payload.error));
    }

    throw new Error(response.statusText || 'Request failed');
  }

  return payload;
}

export function readDashboardToken(): string {
  if (typeof window !== 'undefined') {
    const fromGlobal = String((window as any).__DASHBOARD_TOKEN__ || '').trim();

    if (fromGlobal) {
      return fromGlobal;
    }

    const fromStorage = window.localStorage.getItem(DASHBOARD_TOKEN_STORAGE_KEY);

    if (fromStorage && fromStorage.trim()) {
      return fromStorage.trim();
    }
  }

  return '';
}

export function setDashboardToken(token: string) {
  if (typeof window === 'undefined') {
    return;
  }

  const normalized = String(token || '').trim();
  (window as any).__DASHBOARD_TOKEN__ = normalized;

  if (!normalized) {
    window.localStorage.removeItem(DASHBOARD_TOKEN_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(DASHBOARD_TOKEN_STORAGE_KEY, normalized);
}

export function clearDashboardToken() {
  if (typeof window === 'undefined') {
    return;
  }

  (window as any).__DASHBOARD_TOKEN__ = '';
  window.localStorage.removeItem(DASHBOARD_TOKEN_STORAGE_KEY);
}

function toQuery(filters: Record<string, unknown> = {}) {
  const params = new URLSearchParams();

  Object.entries(filters).forEach(function ([key, value]) {
    if (value === undefined || value === null || value === '') {
      return;
    }

    params.set(key, String(value));
  });

  const query = params.toString();
  return query ? '?' + query : '';
}

export const api = {
  projects: {
    list() {
      return request('/api/projects');
    },
    get(id) {
      return request('/api/projects/' + id);
    },
    create(input) {
      return request('/api/projects', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },
    update(id, input) {
      return request('/api/projects/' + id, {
        method: 'PUT',
        body: JSON.stringify(input),
      });
    },
  },
  sessions: {
    list(filters) {
      return request('/api/sessions' + toQuery(filters));
    },
    get(id) {
      return request('/api/sessions/' + id);
    },
    create(input) {
      return request('/api/sessions', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },
    approve(id, runTests) {
      return request('/api/sessions/' + id + '/approve', {
        method: 'POST',
        body: JSON.stringify({ runTests }),
      });
    },
    reject(id) {
      return request('/api/sessions/' + id + '/reject', {
        method: 'POST',
        body: JSON.stringify({}),
      });
    },
    abort(id) {
      return request('/api/sessions/' + id + '/abort', {
        method: 'POST',
        body: JSON.stringify({}),
      });
    },
  },
  agents: {
    events(runId, filters) {
      return request('/api/agents/' + runId + '/events' + toQuery(filters));
    },
    control(runId, input) {
      return request('/api/agents/' + runId + '/control', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },
  },
  trigger: {
    agent(input) {
      return request('/api/trigger/agent', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },
  },
  config: {
    mcpServers: {
      list() {
        return request('/api/config/mcp-servers');
      },
      create(input) {
        return request('/api/config/mcp-servers', {
          method: 'POST',
          body: JSON.stringify(input),
        });
      },
      update(name, input) {
        return request('/api/config/mcp-servers/' + encodeURIComponent(name), {
          method: 'PUT',
          body: JSON.stringify(input),
        });
      },
      remove(name) {
        return request('/api/config/mcp-servers/' + encodeURIComponent(name), {
          method: 'DELETE',
        });
      },
      sync() {
        return request('/api/config/mcp-servers/sync', {
          method: 'POST',
          body: JSON.stringify({}),
        });
      },
    },
    hooks: {
      list() {
        return request('/api/config/hooks');
      },
      create(input) {
        return request('/api/config/hooks', {
          method: 'POST',
          body: JSON.stringify(input),
        });
      },
      update(id, input) {
        return request('/api/config/hooks/' + encodeURIComponent(id), {
          method: 'PUT',
          body: JSON.stringify(input),
        });
      },
      remove(id) {
        return request('/api/config/hooks/' + encodeURIComponent(id), {
          method: 'DELETE',
        });
      },
      reorder(hookType, orderedIds) {
        return request('/api/config/hooks/reorder', {
          method: 'POST',
          body: JSON.stringify({
            hook_type: hookType,
            ordered_ids: orderedIds,
          }),
        });
      },
      sync() {
        return request('/api/config/hooks/sync', {
          method: 'POST',
          body: JSON.stringify({}),
        });
      },
    },
    commands: {
      list() {
        return request('/api/config/commands');
      },
      get(name) {
        return request('/api/config/commands/' + encodeURIComponent(name));
      },
      create(input) {
        return request('/api/config/commands', {
          method: 'POST',
          body: JSON.stringify(input),
        });
      },
      update(name, content) {
        return request('/api/config/commands/' + encodeURIComponent(name), {
          method: 'PUT',
          body: JSON.stringify({ content }),
        });
      },
      remove(name) {
        return request('/api/config/commands/' + encodeURIComponent(name), {
          method: 'DELETE',
        });
      },
      sync() {
        return request('/api/config/commands/sync', {
          method: 'POST',
          body: JSON.stringify({}),
        });
      },
    },
  },
  history: {
    list(filters) {
      return request('/api/history' + toQuery(filters));
    },
    timeline(sessionId) {
      return request('/api/history/' + encodeURIComponent(sessionId) + '/timeline');
    },
    auditLog(filters) {
      return request('/api/audit-log' + toQuery(filters));
    },
  },
  system: {
    health() {
      return request('/api/health');
    },
    stats() {
      return request('/api/stats');
    },
    overview() {
      return request('/api/overview');
    },
  },
};
