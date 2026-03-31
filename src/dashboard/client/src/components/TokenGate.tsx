import { useState } from 'react';
import type { FormEvent } from 'react';

import { setDashboardToken } from '../api/client';

type TokenGateProps = {
  onAuthenticated: (token: string) => void;
};

export function TokenGate({ onAuthenticated }: TokenGateProps) {
  const [tokenInput, setTokenInput] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = tokenInput.trim();

    if (!token) {
      setError('请输入 x-dashboard-token。');
      return;
    }

    setPending(true);
    setError('');

    try {
      const response = await fetch('/api/config/mcp-servers', {
        headers: {
          'x-dashboard-token': token,
        },
      });

      if (!response.ok) {
        const payload = await parseErrorPayload(response);
        setError(payload || 'Token 校验失败，请确认与服务端 DASHBOARD_TOKEN 完全一致。');
        return;
      }

      setDashboardToken(token);
      onAuthenticated(token);
    } catch {
      setError('无法连接服务，请确认 Dashboard 服务已启动且端口可访问。');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="token-gate">
      <div className="token-gate__panel">
        <div className="token-gate__eyebrow">Access Control</div>
        <h1 className="token-gate__title">请输入 Dashboard Token</h1>
        <p className="token-gate__subtitle">
          受保护接口要求在请求头携带
          {' '}
          <span className="mono">x-dashboard-token</span>
          。
        </p>

        <form className="token-gate__form" onSubmit={handleSubmit}>
          <label className="field">
            <span>Token</span>
            <input
              autoFocus
              className="input mono"
              type="password"
              value={tokenInput}
              placeholder="请输入与服务端一致的 DASHBOARD_TOKEN"
              onChange={function (event) {
                setTokenInput(event.target.value);
              }}
            />
          </label>

          {error ? <div className="notice notice--error">{error}</div> : null}

          <div className="button-row">
            <button className="button button--primary" disabled={pending} type="submit">
              {pending ? '校验中...' : '验证并进入'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

async function parseErrorPayload(response: Response) {
  try {
    const payload = await response.json();

    if (payload && typeof payload === 'object' && typeof payload.error === 'string') {
      return payload.error;
    }
  } catch {
    return '';
  }

  return '';
}
