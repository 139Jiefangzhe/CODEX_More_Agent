import { create } from 'zustand';

import { api } from '../api/client';

const MAX_EVENT_ROWS = 500;
const bufferedEvents: any[] = [];
let flushHandle: number | null = null;
let syntheticEventId = 0;
let highestServerEventId = 0;

export const useSessionStore = create<any>(function (set, get) {
  return {
    projects: [],
    overview: null,
    sessionsPage: { data: [], total: 0, page: 1, limit: 20 },
    currentDetail: null,
    currentEvents: [],
    selectedRunId: null,
    loading: false,
    async fetchProjects() {
      const projects = await api.projects.list();
      set({ projects });
    },
    async saveProject(input, projectId) {
      const project = projectId ? await api.projects.update(projectId, input) : await api.projects.create(input);
      await get().fetchProjects();
      return project;
    },
    async fetchOverview() {
      const overview = await api.system.overview();
      set({ overview });
    },
    async fetchSessions(filters) {
      const sessionsPage = await api.sessions.list(filters);
      set({ sessionsPage });
    },
    async createSession(input) {
      const session = await api.sessions.create(input);
      await get().fetchSessions();
      await get().fetchOverview();
      return session;
    },
    async fetchSessionDetail(sessionId) {
      const detail = await api.sessions.get(sessionId);
      const selectedRunId = get().selectedRunId || detail.agents.at(-1)?.id || null;
      set({ currentDetail: detail, selectedRunId });

      if (selectedRunId) {
        await get().fetchAgentEvents(selectedRunId);
      } else {
        set({ currentEvents: [] });
      }
    },
    async fetchAgentEvents(runId) {
      const result = await api.agents.events(runId, { limit: 300 });
      const maxEventId = result.data.reduce(function (maxId, row) {
        return typeof row.id === 'number' && row.id > maxId ? row.id : maxId;
      }, 0);

      if (maxEventId > highestServerEventId) {
        highestServerEventId = maxEventId;
      }

      resetBufferedEvents();
      set({ currentEvents: result.data, selectedRunId: runId });
    },
    async approveCurrent(runTests) {
      const detail = get().currentDetail;

      if (!detail) {
        return;
      }

      const next = await api.sessions.approve(detail.session.id, runTests);
      set({ currentDetail: next });
    },
    async rejectCurrent() {
      const detail = get().currentDetail;

      if (!detail) {
        return;
      }

      const next = await api.sessions.reject(detail.session.id);
      set({ currentDetail: next });
    },
    async abortCurrent() {
      const detail = get().currentDetail;

      if (!detail) {
        return;
      }

      const next = await api.sessions.abort(detail.session.id);
      set({ currentDetail: next });
    },
    selectRun(runId) {
      set({ selectedRunId: runId });
      if (runId) {
        void get().fetchAgentEvents(runId);
      }
    },
    handleWsMessage(message) {
      const detail = get().currentDetail;

      if (!detail) {
        return;
      }

      if (message.type === 'agent:event' && message.data.sessionId === detail.session.id) {
        const serverEventId = toServerEventId(message);

        if (serverEventId && serverEventId <= highestServerEventId) {
          return;
        }

        if (serverEventId > 0) {
          highestServerEventId = serverEventId;
        }

        enqueueSessionEvent({
          id: serverEventId || nextSyntheticEventId(),
          agent_run_id: message.data.agentRunId,
          session_id: message.data.sessionId,
          timestamp: message.data.timestamp,
          event_type: message.data.eventType,
          event_data: message.data.payload,
        });
        return;
      }

      if (message.type === 'agent:control_signal' && message.data.sessionId === detail.session.id) {
        enqueueSessionEvent({
          id: nextSyntheticEventId(),
          agent_run_id: message.data.agentRunId,
          session_id: message.data.sessionId,
          timestamp: message.data.timestamp,
          event_type: 'checkpoint',
          event_data: {
            message: '控制指令已下发: ' + message.data.action,
            action: message.data.action,
            mode: message.data.mode,
            signal_id: message.data.signalId,
          },
        });
        return;
      }

      if (message.type === 'agent:control_applied' && message.data.sessionId === detail.session.id) {
        enqueueSessionEvent({
          id: nextSyntheticEventId(),
          agent_run_id: message.data.agentRunId,
          session_id: message.data.sessionId,
          timestamp: message.data.timestamp,
          event_type: 'checkpoint',
          event_data: {
            message: '控制指令已执行: ' + message.data.action + ' -> ' + message.data.result,
            action: message.data.action,
            mode: message.data.mode,
            result: message.data.result,
            signal_id: message.data.signalId,
          },
        });
        return;
      }

      if (message.type === 'slot_event' && message.data.sessionId === detail.session.id) {
        const slotState = String(message.data.state || 'unknown');
        const blockingSessions = Array.isArray(message.data.blockingSessions)
          ? message.data.blockingSessions
          : [];
        const suffix = blockingSessions.length > 0 ? '（阻塞会话: ' + blockingSessions.join(', ') + '）' : '';

        enqueueSessionEvent({
          id: nextSyntheticEventId(),
          agent_run_id: 'slot:' + detail.session.id,
          session_id: message.data.sessionId,
          timestamp: message.data.timestamp,
          event_type: 'checkpoint',
          event_data: {
            message: '写槽状态: ' + slotState + suffix,
            slot_state: slotState,
            project_id: message.data.projectId || null,
            blocking_sessions: blockingSessions,
          },
        });
        return;
      }

      if (message.type === 'agent:status_change' && message.data.sessionId === detail.session.id) {
        set(function (state) {
          return {
            currentDetail: {
              ...state.currentDetail,
              agents: state.currentDetail.agents.map(function (run) {
                if (run.id !== message.data.agentRunId) {
                  return run;
                }

                return {
                  ...run,
                  status: message.data.newStatus,
                  finished_at:
                    message.data.newStatus === 'completed' || message.data.newStatus === 'failed' || message.data.newStatus === 'aborted'
                      ? message.data.timestamp
                      : run.finished_at,
                };
              }),
            },
          };
        });
        return;
      }

      if (message.type === 'session:update' && message.data.sessionId === detail.session.id) {
        set(function (state) {
          return {
            currentDetail: {
              ...state.currentDetail,
              session: {
                ...state.currentDetail.session,
                phase: message.data.phase,
                status: message.data.status,
                end_time: message.data.status === 'running' ? state.currentDetail.session.end_time : message.data.timestamp,
              },
            },
          };
        });
        return;
      }

      if (message.type === 'changeset:update' && message.data.sessionId === detail.session.id) {
        void get().fetchSessionDetail(detail.session.id);
      }
    },
  };
});

function enqueueSessionEvent(event: any) {
  bufferedEvents.push(event);

  if (flushHandle !== null) {
    return;
  }

  const schedule = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame.bind(window)
    : function (cb: FrameRequestCallback) {
      return globalThis.setTimeout(function () {
        cb(0);
      }, 16);
    };

  flushHandle = schedule(function () {
    flushHandle = null;

    if (bufferedEvents.length === 0) {
      return;
    }

    const batch = bufferedEvents.splice(0, bufferedEvents.length);
    useSessionStore.setState(function (state: any) {
      return {
        currentEvents: state.currentEvents.concat(batch).slice(-MAX_EVENT_ROWS),
      };
    });
  });
}

function toServerEventId(message: any): number {
  const parsed = Number.parseInt(String(message?.data?.eventId ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function nextSyntheticEventId(): number {
  syntheticEventId += 1;
  return Date.now() * 1000 + syntheticEventId;
}

function resetBufferedEvents() {
  bufferedEvents.length = 0;

  if (flushHandle === null) {
    return;
  }

  if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(flushHandle);
  } else {
    globalThis.clearTimeout(flushHandle);
  }

  flushHandle = null;
}
