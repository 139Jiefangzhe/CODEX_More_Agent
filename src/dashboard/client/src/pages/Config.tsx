import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { motion } from 'framer-motion';

import { JsonEditor } from '../components/JsonEditor';
import { EmptyState } from '../components/EmptyState';
import { api } from '../api/client';

const emptyMcp = {
  name: '',
  command: '',
  argsText: '',
  envText: '{}',
  enabled: true,
};
const emptyHook = {
  id: '',
  hook_type: 'postEdit',
  match_pattern: '.*',
  command: '',
  enabled: true,
};

const HOOK_TYPES = ['postEdit', 'preCommit', 'prePush'] as const;

const HOOK_TYPE_LABELS: Record<string, string> = {
  postEdit: 'postEdit（编辑后）',
  preCommit: 'preCommit（提交前）',
  prePush: 'prePush（推送前）',
};

export function ConfigPage() {
  const [tab, setTab] = useState<'mcp' | 'hooks' | 'commands'>('mcp');
  const [mcpServers, setMcpServers] = useState<any[]>([]);
  const [hooks, setHooks] = useState<any[]>([]);
  const [commands, setCommands] = useState<any[]>([]);
  const [mcpForm, setMcpForm] = useState<any>(emptyMcp);
  const [hookForm, setHookForm] = useState<any>(emptyHook);
  const [commandName, setCommandName] = useState('');
  const [commandContent, setCommandContent] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(function () {
    void loadAll();
  }, []);

  async function loadAll() {
    setLoading(true);
    setError('');

    try {
      const [mcpResult, hookResult, commandResult] = await Promise.all([
        api.config.mcpServers.list(),
        api.config.hooks.list(),
        api.config.commands.list(),
      ]);

      setMcpServers(mcpResult || []);
      setHooks(hookResult || []);
      setCommands(commandResult || []);

      if (!commandName && commandResult.length > 0) {
        setCommandName(commandResult[0].name);
        setCommandContent(commandResult[0].content || '');
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }

  const groupedHooks = useMemo(function () {
    const grouped = {
      postEdit: [],
      preCommit: [],
      prePush: [],
    };

    hooks.forEach(function (hook) {
      grouped[hook.hook_type] = grouped[hook.hook_type] || [];
      grouped[hook.hook_type].push(hook);
    });

    return grouped;
  }, [hooks]);

  const enabledMcpCount = useMemo(
    () => mcpServers.filter((item) => Boolean(item.enabled)).length,
    [mcpServers],
  );
  const enabledHookCount = useMemo(
    () => hooks.filter((item) => Boolean(item.enabled)).length,
    [hooks],
  );
  const configReady = useMemo(function () {
    const total = mcpServers.length + hooks.length + commands.length;

    if (total === 0) {
      return 0;
    }

    const active = enabledMcpCount + enabledHookCount + commands.length;
    return Math.round((active / total) * 100);
  }, [commands.length, enabledHookCount, enabledMcpCount, hooks.length, mcpServers.length]);

  const ringStyle = {
    '--ring-progress': configReady + '%',
  } as CSSProperties;

  function parseArgs(argsText) {
    return String(argsText || '')
      .split(',')
      .map(function (value) {
        return value.trim();
      })
      .filter(Boolean);
  }

  function parseEnv(envText) {
    const text = String(envText || '').trim();

    if (!text) {
      return {};
    }

    try {
      const parsed = JSON.parse(text);

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('env 必须是 JSON 对象');
      }

      return parsed;
    } catch (parseError) {
      throw new Error(parseError instanceof Error ? parseError.message : 'env JSON 解析失败');
    }
  }

  async function handleSaveMcp(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');

    try {
      const payload = {
        name: mcpForm.name.trim(),
        command: mcpForm.command.trim(),
        args: parseArgs(mcpForm.argsText),
        env: parseEnv(mcpForm.envText),
        enabled: Boolean(mcpForm.enabled),
      };

      if (!payload.name) {
        throw new Error('MCP 名称不能为空');
      }

      const existing = mcpServers.find((item) => item.name === payload.name);

      if (existing) {
        await api.config.mcpServers.update(payload.name, payload);
      } else {
        await api.config.mcpServers.create(payload);
      }

      setMcpForm(emptyMcp);
      await loadAll();
      setNotice('MCP 配置已保存');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    }
  }

  async function handleDeleteMcp(name: string) {
    setError('');
    setNotice('');

    try {
      await api.config.mcpServers.remove(name);
      await loadAll();
      setNotice('MCP 配置已删除');
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError));
    }
  }

  async function handleSyncMcp() {
    setError('');
    setNotice('');

    try {
      const result = await api.config.mcpServers.sync();
      setNotice(result.message + (result.backupPath ? '，备份：' + result.backupPath : ''));
      await loadAll();
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : String(syncError));
    }
  }

  async function handleSaveHook(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');

    try {
      const payload = {
        hook_type: hookForm.hook_type,
        match_pattern: hookForm.match_pattern,
        command: hookForm.command,
        enabled: Boolean(hookForm.enabled),
      };

      if (hookForm.id) {
        await api.config.hooks.update(hookForm.id, payload);
      } else {
        await api.config.hooks.create(payload);
      }

      setHookForm(emptyHook);
      await loadAll();
      setNotice('Hook 配置已保存');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    }
  }

  async function handleDeleteHook(id: string) {
    setError('');
    setNotice('');

    try {
      await api.config.hooks.remove(id);
      await loadAll();
      setNotice('Hook 已删除');
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError));
    }
  }

  async function moveHook(hookType: string, hookId: string, direction: -1 | 1) {
    const list = (groupedHooks as any)[hookType] || [];
    const index = list.findIndex((item) => item.id === hookId);

    if (index < 0) {
      return;
    }

    const targetIndex = index + direction;

    if (targetIndex < 0 || targetIndex >= list.length) {
      return;
    }

    const next = list.slice();
    const [item] = next.splice(index, 1);
    next.splice(targetIndex, 0, item);

    try {
      await api.config.hooks.reorder(
        hookType,
        next.map(function (entry) {
          return entry.id;
        }),
      );
      await loadAll();
    } catch (reorderError) {
      setError(reorderError instanceof Error ? reorderError.message : String(reorderError));
    }
  }

  async function handleSyncHooks() {
    setError('');
    setNotice('');

    try {
      const result = await api.config.hooks.sync();
      setNotice(result.message + (result.backupPath ? '，备份：' + result.backupPath : ''));
      await loadAll();
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : String(syncError));
    }
  }

  async function handleSaveCommand() {
    setError('');
    setNotice('');

    try {
      const name = commandName.trim();

      if (!name) {
        throw new Error('命令名称不能为空');
      }

      const exists = commands.some((command) => command.name === name);

      if (exists) {
        await api.config.commands.update(name, commandContent);
      } else {
        await api.config.commands.create({ name, content: commandContent });
      }

      await loadAll();
      setNotice('命令文件已保存');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    }
  }

  async function handleDeleteCommand(name: string) {
    setError('');
    setNotice('');

    try {
      const next = commands.find((item) => item.name !== name);
      await api.config.commands.remove(name);
      await loadAll();
      setCommandName(next?.name || '');
      setCommandContent(next?.content || '');
      setNotice('命令文件已删除');
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError));
    }
  }

  async function handleSyncCommands() {
    setError('');
    setNotice('');

    try {
      const result = await api.config.commands.sync();
      setNotice(result.message);
      await loadAll();
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : String(syncError));
    }
  }

  return (
    <div className="page-stack">
      <motion.section
        className="glass-card glass-card--hero hero-summary"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        <div className="hero-summary__content">
          <div>
            <div className="hero-summary__eyebrow">Configuration Control</div>
            <h3 className="hero-summary__title">配置管理中心</h3>
            <p className="hero-summary__description">统一管理 MCP Servers、Hooks 与 Slash Commands，保持配置与文件系统一致。</p>
          </div>
          <div className="hero-summary__kpis">
            <div className="kpi-tile">
              <span className="kpi-tile__label">MCP</span>
              <span className="kpi-tile__value">{mcpServers.length}</span>
            </div>
            <div className="kpi-tile">
              <span className="kpi-tile__label">启用 MCP</span>
              <span className="kpi-tile__value">{enabledMcpCount}</span>
            </div>
            <div className="kpi-tile">
              <span className="kpi-tile__label">Hooks</span>
              <span className="kpi-tile__value">{hooks.length}</span>
            </div>
            <div className="kpi-tile">
              <span className="kpi-tile__label">Commands</span>
              <span className="kpi-tile__value">{commands.length}</span>
            </div>
          </div>
        </div>
        <div className="progress-ring" style={ringStyle}>
          <div className="progress-ring__inner">
            <strong>{configReady}%</strong>
            <span>配置健康度</span>
          </div>
        </div>
      </motion.section>

      <div className="tab-row" role="tablist" aria-label="配置类型切换">
        <button
          className={'tab-button' + (tab === 'mcp' ? ' active' : '')}
          type="button"
          role="tab"
          aria-selected={tab === 'mcp'}
          onClick={() => setTab('mcp')}
        >
          MCP Servers
        </button>
        <button
          className={'tab-button' + (tab === 'hooks' ? ' active' : '')}
          type="button"
          role="tab"
          aria-selected={tab === 'hooks'}
          onClick={() => setTab('hooks')}
        >
          Hooks
        </button>
        <button
          className={'tab-button' + (tab === 'commands' ? ' active' : '')}
          type="button"
          role="tab"
          aria-selected={tab === 'commands'}
          onClick={() => setTab('commands')}
        >
          Slash Commands
        </button>
        <button className="button button--ghost" type="button" onClick={() => void loadAll()}>
          刷新
        </button>
      </div>

      {loading ? <div className="glass-card">配置加载中...</div> : null}
      {notice ? (
        <div className="notice" role="status" aria-live="polite">
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className="notice notice--error" role="alert">
          {error}
        </div>
      ) : null}

      {tab === 'mcp' ? (
        <div className="bento-grid config-grid">
          <section className="glass-card bento-item bento-item--span-2">
            <h3 className="section-title">MCP 列表</h3>
            <p className="card-subtitle">状态变更后可一键同步到 `settings.json`。</p>

            {mcpServers.length === 0 ? <EmptyState title="暂无 MCP 配置" description="从右侧表单创建第一条 MCP 配置。" /> : null}

            <div className="list" style={{ marginTop: 14 }}>
              {mcpServers.map(function (item) {
                return (
                  <div key={item.name} className="list-row">
                    <div className="list-row__meta">
                      <strong>{item.name}</strong>
                      <span className="muted mono">{item.command} {(item.args || []).join(' ')}</span>
                      <span className="muted mono">env: {JSON.stringify(item.env || {})}</span>
                    </div>
                    <div className="list-row__actions">
                      <span className={'status-pill status-pill--' + (item.enabled ? 'success' : 'neutral')}>
                        <span className="status-pill__dot" aria-hidden="true" />
                        {item.enabled ? '启用' : '禁用'}
                      </span>
                      <button
                        className="button button--ghost"
                        type="button"
                        onClick={() =>
                          setMcpForm({
                            name: item.name,
                            command: item.command,
                            argsText: (item.args || []).join(','),
                            envText: JSON.stringify(item.env || {}, null, 2),
                            enabled: item.enabled,
                          })
                        }
                      >
                        编辑
                      </button>
                      <button className="button button--warning" type="button" onClick={() => void handleDeleteMcp(item.name)}>
                        删除
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="button-row" style={{ marginTop: 14 }}>
              <button className="button button--primary" type="button" onClick={() => void handleSyncMcp()}>
                同步到 settings.json
              </button>
            </div>
          </section>

          <section className="glass-card bento-item">
            <h3 className="section-title">编辑 MCP</h3>
            <form className="page-stack" onSubmit={handleSaveMcp}>
              <label className="field">
                <span>名称</span>
                <input className="input" value={mcpForm.name} onChange={(event) => setMcpForm({ ...mcpForm, name: event.target.value })} />
              </label>
              <label className="field">
                <span>命令</span>
                <input className="input mono" value={mcpForm.command} onChange={(event) => setMcpForm({ ...mcpForm, command: event.target.value })} />
              </label>
              <label className="field">
                <span>参数（逗号分隔）</span>
                <input className="input mono" value={mcpForm.argsText} onChange={(event) => setMcpForm({ ...mcpForm, argsText: event.target.value })} />
              </label>
              <label className="field">
                <span>环境变量（JSON）</span>
                <textarea className="textarea mono" value={mcpForm.envText} onChange={(event) => setMcpForm({ ...mcpForm, envText: event.target.value })} />
              </label>
              <label className="button-row" style={{ alignItems: 'center' }}>
                <input type="checkbox" checked={mcpForm.enabled} onChange={(event) => setMcpForm({ ...mcpForm, enabled: event.target.checked })} />
                <span>启用</span>
              </label>
              <div className="button-row">
                <button className="button button--primary" type="submit">
                  保存
                </button>
                <button className="button button--ghost" type="button" onClick={() => setMcpForm(emptyMcp)}>
                  清空
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {tab === 'hooks' ? (
        <div className="bento-grid config-grid">
          <section className="glass-card bento-item bento-item--span-2">
            <h3 className="section-title">Hook 列表</h3>
            <p className="card-subtitle">可调整顺序，保存后同步到 `settings.json`。</p>

            <div className="page-stack" style={{ marginTop: 14 }}>
              {HOOK_TYPES.map(function (hookType) {
                const items = groupedHooks[hookType] || [];

                return (
                  <div key={hookType} className="page-stack">
                    <strong>{HOOK_TYPE_LABELS[hookType]}</strong>
                    <div className="list compact-list">
                      {items.length === 0 ? <EmptyState title="暂无 Hook" description="可在右侧新增对应类型的 Hook。" /> : null}
                      {items.map(function (hook, index) {
                        return (
                          <div key={hook.id} className="list-row">
                            <div className="list-row__meta">
                              <span className="muted mono">{hook.command}</span>
                              {hookType === 'postEdit' ? <span className="muted mono">match: {hook.match_pattern || '.*'}</span> : null}
                            </div>
                            <div className="list-row__actions">
                              <span className={'status-pill status-pill--' + (hook.enabled ? 'success' : 'neutral')}>
                                <span className="status-pill__dot" aria-hidden="true" />
                                {hook.enabled ? '启用' : '禁用'}
                              </span>
                              <button
                                className="button button--ghost"
                                type="button"
                                disabled={index === 0}
                                onClick={() => void moveHook(hookType, hook.id, -1)}
                              >
                                上移
                              </button>
                              <button
                                className="button button--ghost"
                                type="button"
                                disabled={index === items.length - 1}
                                onClick={() => void moveHook(hookType, hook.id, 1)}
                              >
                                下移
                              </button>
                              <button className="button button--ghost" type="button" onClick={() => setHookForm(hook)}>
                                编辑
                              </button>
                              <button className="button button--warning" type="button" onClick={() => void handleDeleteHook(hook.id)}>
                                删除
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="button-row" style={{ marginTop: 14 }}>
              <button className="button button--primary" type="button" onClick={() => void handleSyncHooks()}>
                同步到 settings.json
              </button>
            </div>
          </section>

          <section className="glass-card bento-item">
            <h3 className="section-title">编辑 Hook</h3>
            <form className="page-stack" onSubmit={handleSaveHook}>
              <label className="field">
                <span>类型</span>
                <select className="select" value={hookForm.hook_type} onChange={(event) => setHookForm({ ...hookForm, hook_type: event.target.value })}>
                  <option value="postEdit">postEdit</option>
                  <option value="preCommit">preCommit</option>
                  <option value="prePush">prePush</option>
                </select>
              </label>
              {hookForm.hook_type === 'postEdit' ? (
                <label className="field">
                  <span>匹配模式</span>
                  <input className="input mono" value={hookForm.match_pattern} onChange={(event) => setHookForm({ ...hookForm, match_pattern: event.target.value })} />
                </label>
              ) : null}
              <label className="field">
                <span>命令</span>
                <textarea className="textarea mono" value={hookForm.command} onChange={(event) => setHookForm({ ...hookForm, command: event.target.value })} />
              </label>
              <label className="button-row" style={{ alignItems: 'center' }}>
                <input type="checkbox" checked={hookForm.enabled} onChange={(event) => setHookForm({ ...hookForm, enabled: event.target.checked })} />
                <span>启用</span>
              </label>
              <div className="button-row">
                <button className="button button--primary" type="submit">
                  保存
                </button>
                <button className="button button--ghost" type="button" onClick={() => setHookForm(emptyHook)}>
                  清空
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {tab === 'commands' ? (
        <div className="bento-grid config-grid">
          <section className="glass-card bento-item">
            <h3 className="section-title">命令文件</h3>
            <p className="card-subtitle">选择命令后在右侧编辑内容。</p>

            {commands.length === 0 ? <EmptyState title="暂无命令文件" description="创建命令后可同步到命令目录。" /> : null}

            <div className="list" style={{ marginTop: 14 }}>
              {commands.map(function (command) {
                const isActive = command.name === commandName;

                return (
                  <div key={command.name} className={'list-row' + (isActive ? ' list-row--active' : '')}>
                    <div className="list-row__meta">
                      <strong>/{command.name}</strong>
                      <span className="muted mono">{command.path}</span>
                    </div>
                    <div className="list-row__actions">
                      <button
                        className="button button--ghost"
                        type="button"
                        onClick={() => {
                          setCommandName(command.name);
                          setCommandContent(command.content || '');
                        }}
                      >
                        编辑
                      </button>
                      <button className="button button--warning" type="button" onClick={() => void handleDeleteCommand(command.name)}>
                        删除
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="button-row" style={{ marginTop: 14 }}>
              <button className="button button--primary" type="button" onClick={() => void handleSyncCommands()}>
                同步命令目录
              </button>
            </div>
          </section>

          <section className="glass-card bento-item bento-item--span-2">
            <h3 className="section-title">编辑命令</h3>
            <div className="page-stack">
              <label className="field">
                <span>命令名称</span>
                <input
                  className="input mono"
                  value={commandName}
                  onChange={(event) => setCommandName(event.target.value)}
                  placeholder="例如 architect"
                />
              </label>
              <JsonEditor language="markdown" value={commandContent} onChange={setCommandContent} height="420px" />
              <div className="button-row">
                <button className="button button--primary" type="button" onClick={() => void handleSaveCommand()}>
                  保存命令
                </button>
                <button className="button button--ghost" type="button" onClick={() => setCommandContent('')}>
                  清空内容
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
