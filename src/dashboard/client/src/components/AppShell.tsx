import type { ReactNode } from 'react';

import { Header } from './Header';
import { Sidebar } from './Sidebar';

type ThemeMode = 'system' | 'dark' | 'light';
type ViewMode = 'shell' | 'monitor';

type AppShellProps = {
  children: ReactNode;
  onSignOut: () => void;
  themeMode: ThemeMode;
  resolvedTheme: 'dark' | 'light';
  viewMode: ViewMode;
  onThemeModeChange: (mode: ThemeMode) => void;
  onViewModeChange: (mode: ViewMode) => void;
};

export function AppShell({
  children,
  onSignOut,
  themeMode,
  resolvedTheme,
  viewMode,
  onThemeModeChange,
  onViewModeChange,
}: AppShellProps) {
  const isMonitorMode = viewMode === 'monitor';

  return (
    <div className={'app-shell' + (isMonitorMode ? ' app-shell--monitor' : '')}>
      <Sidebar isMonitorMode={isMonitorMode} />
      <div className="main-shell">
        <Header
          onSignOut={onSignOut}
          themeMode={themeMode}
          resolvedTheme={resolvedTheme}
          viewMode={viewMode}
          onThemeModeChange={onThemeModeChange}
          onViewModeChange={onViewModeChange}
        />
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
