import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

import { RealTimeIndicator } from './RealTimeIndicator';
import { useSessionStore } from '../stores/session-store';
import { useWsStore } from '../stores/ws-store';

type ThemeMode = 'system' | 'dark' | 'light';
type ViewMode = 'shell' | 'monitor';

const TITLES = [
  { prefix: '/history', title: '历史与审计', subtitle: '聚合查看执行历史、时间轴和统计走势。' },
  { prefix: '/config', title: '配置管理', subtitle: '集中维护 MCP、Hooks 与命令配置。' },
  { prefix: '/agents', title: 'Agent 管理', subtitle: '实时观察 7 个 Agent 的状态与触发入口。' },
  { prefix: '/sessions/', title: '会话详情', subtitle: '追踪从规划到应用的完整执行链路。' },
  { prefix: '/sessions', title: '会话中心', subtitle: '扫描进行中与历史会话。' },
  { prefix: '/overview', title: '总览监控', subtitle: '多 Agent 运行态、KPI 与告警信息总览。' },
  { prefix: '/', title: '项目', subtitle: '登记本地仓库并发起自动编排会话。' },
];

export function Header({
  onSignOut,
  themeMode,
  resolvedTheme,
  viewMode,
  onThemeModeChange,
  onViewModeChange,
}: {
  onSignOut: () => void;
  themeMode: ThemeMode;
  resolvedTheme: 'dark' | 'light';
  viewMode: ViewMode;
  onThemeModeChange: (mode: ThemeMode) => void;
  onViewModeChange: (mode: ViewMode) => void;
}) {
  const location = useLocation();
  const status = useWsStore((state) => state.status);
  const overview = useSessionStore((state) => state.overview);
  const fetchOverview = useSessionStore((state) => state.fetchOverview);
  const match =
    TITLES.find(function (item) {
      return location.pathname.startsWith(item.prefix);
    }) || { title: '工作台', subtitle: '多 Agent 协作开发控制台。' };

  useEffect(
    function () {
      void fetchOverview();
      const timer = setInterval(function () {
        void fetchOverview();
      }, 15000);

      return function () {
        clearInterval(timer);
      };
    },
    [fetchOverview],
  );

  const activeSessions = overview?.activeSessions?.length || 0;
  const totalRuns = overview?.stats?.totals?.runs || 0;
  const successRate = overview?.stats?.totals?.successRate || 0;

  return (
    <header className="header">
      <div className="header__meta">
        <div className="header__kicker">{resolvedTheme === 'dark' ? 'Dark Mode' : 'Light Mode'} · {viewMode === 'monitor' ? 'Monitor View' : 'Shell View'}</div>
        <h2 className="page-title">{match.title}</h2>
        <div className="page-subtitle">{match.subtitle}</div>
      </div>
      <div className="header__status-strip">
        <span className="header-chip">
          <span className="header-chip__label">活跃会话</span>
          <strong>{activeSessions}</strong>
        </span>
        <span className="header-chip">
          <span className="header-chip__label">总运行</span>
          <strong>{totalRuns}</strong>
        </span>
        <span className="header-chip">
          <span className="header-chip__label">成功率</span>
          <strong>{successRate}%</strong>
        </span>
      </div>
      <div className="header__actions">
        <RealTimeIndicator status={status} />
        <div className="segmented-control" role="group" aria-label="主题模式">
          <button
            type="button"
            className={'segmented-control__button' + (themeMode === 'system' ? ' active' : '')}
            onClick={() => onThemeModeChange('system')}
          >
            系统
          </button>
          <button
            type="button"
            className={'segmented-control__button' + (themeMode === 'dark' ? ' active' : '')}
            onClick={() => onThemeModeChange('dark')}
          >
            暗色
          </button>
          <button
            type="button"
            className={'segmented-control__button' + (themeMode === 'light' ? ' active' : '')}
            onClick={() => onThemeModeChange('light')}
          >
            亮色
          </button>
        </div>
        <button
          className="button button--ghost"
          type="button"
          onClick={() => onViewModeChange(viewMode === 'monitor' ? 'shell' : 'monitor')}
        >
          {viewMode === 'monitor' ? '退出全屏监控' : '全屏监控'}
        </button>
        <button className="button button--ghost header__signout" onClick={onSignOut} type="button">
          退出
        </button>
      </div>
    </header>
  );
}
