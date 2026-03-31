import { NavLink } from 'react-router-dom';

const items = [
  { to: '/', label: '项目' },
  { to: '/overview', label: '总览' },
  { to: '/sessions', label: '会话' },
  { to: '/agents', label: 'Agents' },
  { to: '/config', label: '配置' },
  { to: '/history', label: '历史' },
];

export function Sidebar({ isMonitorMode }: { isMonitorMode: boolean }) {
  return (
    <aside className={'sidebar' + (isMonitorMode ? ' sidebar--collapsed' : '')}>
      <div className="sidebar__brand">
        <div className="sidebar__eyebrow">Multi-Agent Workbench</div>
        <h1 className="sidebar__title">Liquid Control</h1>
        <p className="sidebar__subtitle">Bento-aware orchestration workspace</p>
      </div>
      <nav className="sidebar__nav">
        {items.map(function (item) {
          return (
            <NavLink key={item.to} to={item.to}>
              {item.label}
            </NavLink>
          );
        })}
      </nav>
      <div className="sidebar__footer">
        <div>Controller: GPT-5.4</div>
        <div>Executor: GPT-5.3-codex</div>
      </div>
    </aside>
  );
}
