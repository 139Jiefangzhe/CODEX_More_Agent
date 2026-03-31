import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import type { ComponentType } from 'react';
import { Routes, Route } from 'react-router-dom';

import { clearDashboardToken, readDashboardToken } from './api/client';
import { AppShell } from './components/AppShell';
import { TokenGate } from './components/TokenGate';
import { useWsStore } from './stores/ws-store';

type ThemeMode = 'system' | 'dark' | 'light';
type ViewMode = 'shell' | 'monitor';

type UiPreferences = {
  themeMode: ThemeMode;
  viewMode: ViewMode;
};

const UI_PREFERENCES_STORAGE_KEY = 'dashboard_ui_preferences_v1';

const ProjectsPage = lazyPage(() => import('./pages/Projects'), 'ProjectsPage');
const OverviewPage = lazyPage(() => import('./pages/Overview'), 'OverviewPage');
const SessionsPage = lazyPage(() => import('./pages/Sessions'), 'SessionsPage');
const SessionDetailPage = lazyPage(() => import('./pages/SessionDetail'), 'SessionDetailPage');
const AgentsPage = lazyPage(() => import('./pages/Agents'), 'AgentsPage');
const ConfigPage = lazyPage(() => import('./pages/Config'), 'ConfigPage');
const HistoryPage = lazyPage(() => import('./pages/History'), 'HistoryPage');

export function App() {
  const [dashboardToken, setDashboardTokenState] = useState(function () {
    return readDashboardToken();
  });
  const [themeMode, setThemeMode] = useState<ThemeMode>(function () {
    return readUiPreferences().themeMode;
  });
  const [viewMode, setViewMode] = useState<ViewMode>(function () {
    return readUiPreferences().viewMode;
  });
  const [systemPrefersDark, setSystemPrefersDark] = useState(function () {
    return getSystemPrefersDark();
  });
  const connect = useWsStore((state) => state.connect);
  const disconnect = useWsStore((state) => state.disconnect);

  const resolvedTheme = useMemo<'dark' | 'light'>(
    function () {
      if (themeMode === 'system') {
        return systemPrefersDark ? 'dark' : 'light';
      }

      return themeMode;
    },
    [systemPrefersDark, themeMode],
  );

  useEffect(function () {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = function (event: MediaQueryListEvent) {
      setSystemPrefersDark(event.matches);
    };

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', onChange);
      return function () {
        mediaQuery.removeEventListener('change', onChange);
      };
    }

    mediaQuery.addListener(onChange);
    return function () {
      mediaQuery.removeListener(onChange);
    };
  }, []);

  useEffect(
    function () {
      writeUiPreferences({
        themeMode,
        viewMode,
      });
    },
    [themeMode, viewMode],
  );

  useEffect(
    function () {
      if (typeof document === 'undefined') {
        return;
      }

      document.documentElement.dataset.theme = resolvedTheme;
      document.documentElement.style.colorScheme = resolvedTheme;
    },
    [resolvedTheme],
  );

  useEffect(function () {
    if (dashboardToken) {
      connect();
      return function () {
        disconnect();
      };
    }

    disconnect();
    return undefined;
  }, [connect, dashboardToken, disconnect]);

  if (!dashboardToken) {
    return (
      <TokenGate
        onAuthenticated={function (token) {
          setDashboardTokenState(token);
        }}
      />
    );
  }

  return (
    <AppShell
      onSignOut={function () {
        clearDashboardToken();
        setDashboardTokenState('');
      }}
      themeMode={themeMode}
      resolvedTheme={resolvedTheme}
      viewMode={viewMode}
      onThemeModeChange={setThemeMode}
      onViewModeChange={setViewMode}
    >
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<ProjectsPage />} />
          <Route path="/overview" element={<OverviewPage />} />
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/sessions/:id" element={<SessionDetailPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/config" element={<ConfigPage />} />
          <Route path="/history" element={<HistoryPage />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}

function lazyPage<T extends Record<string, any>>(loader: () => Promise<T>, exportName: keyof T) {
  return lazy(async function () {
    const module = await loader();
    return {
      default: module[exportName] as ComponentType,
    };
  });
}

function RouteFallback() {
  return (
    <div className="page-stack">
      <div className="glass-card route-fallback" aria-live="polite">
        页面加载中...
      </div>
    </div>
  );
}

function readUiPreferences(): UiPreferences {
  if (typeof window === 'undefined') {
    return {
      themeMode: 'system',
      viewMode: 'shell',
    };
  }

  try {
    const raw = window.localStorage.getItem(UI_PREFERENCES_STORAGE_KEY);

    if (!raw) {
      return {
        themeMode: 'system',
        viewMode: 'shell',
      };
    }

    const parsed = JSON.parse(raw);

    return {
      themeMode: normalizeThemeMode(parsed?.themeMode),
      viewMode: normalizeViewMode(parsed?.viewMode),
    };
  } catch {
    return {
      themeMode: 'system',
      viewMode: 'shell',
    };
  }
}

function writeUiPreferences(value: UiPreferences): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(UI_PREFERENCES_STORAGE_KEY, JSON.stringify(value));
}

function normalizeThemeMode(value: unknown): ThemeMode {
  if (value === 'dark' || value === 'light' || value === 'system') {
    return value;
  }

  return 'system';
}

function normalizeViewMode(value: unknown): ViewMode {
  if (value === 'monitor' || value === 'shell') {
    return value;
  }

  return 'shell';
}

function getSystemPrefersDark() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
