import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';

import { EmptyState } from '../components/EmptyState';
import { useSessionStore } from '../stores/session-store';

type ProjectForm = {
  name: string;
  root_path: string;
  language: string;
  framework: string;
  test_command: string;
  lint_command: string;
  build_command: string;
  ignore_paths: string[] | string;
};

const emptyProject: ProjectForm = {
  name: '',
  root_path: '',
  language: 'typescript',
  framework: '',
  test_command: '',
  lint_command: '',
  build_command: '',
  ignore_paths: [],
};

export function ProjectsPage() {
  const navigate = useNavigate();
  const projects = useSessionStore((state) => state.projects);
  const fetchProjects = useSessionStore((state) => state.fetchProjects);
  const saveProject = useSessionStore((state) => state.saveProject);
  const createSession = useSessionStore((state) => state.createSession);

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [projectForm, setProjectForm] = useState<ProjectForm>(emptyProject);
  const [goal, setGoal] = useState('');
  const [projectSaving, setProjectSaving] = useState(false);
  const [projectError, setProjectError] = useState('');
  const [sessionStartingProjectId, setSessionStartingProjectId] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState('');

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) || null,
    [projects, selectedProjectId],
  );

  useEffect(
    function () {
      void fetchProjects();
    },
    [fetchProjects],
  );

  useEffect(
    function () {
      if (!selectedProject) {
        setProjectForm(emptyProject);
        return;
      }

      setProjectForm({
        ...selectedProject,
        framework: selectedProject.framework ?? '',
        test_command: selectedProject.test_command ?? '',
        lint_command: selectedProject.lint_command ?? '',
        build_command: selectedProject.build_command ?? '',
        ignore_paths: Array.isArray(selectedProject.ignore_paths) ? selectedProject.ignore_paths : [],
      });
    },
    [selectedProject],
  );

  const projectReadiness = useMemo(function () {
    if (!projects.length) {
      return 0;
    }

    const readyCount = projects.filter(function (project) {
      return Boolean(project.test_command || project.lint_command || project.build_command);
    }).length;

    return Math.round((readyCount / projects.length) * 100);
  }, [projects]);

  const projectFormCoverage = useMemo(function () {
    return [projectForm.test_command, projectForm.lint_command, projectForm.build_command].filter(Boolean).length;
  }, [projectForm.build_command, projectForm.lint_command, projectForm.test_command]);

  const ringStyle = {
    '--ring-progress': projectReadiness + '%',
  } as CSSProperties;

  async function handleSaveProject(event: React.FormEvent) {
    event.preventDefault();
    setProjectSaving(true);
    setProjectError('');

    try {
      const payload = {
        ...projectForm,
        ignore_paths: String(projectForm.ignore_paths || '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      } as any;
      const project = await saveProject(payload, selectedProjectId || undefined);
      setSelectedProjectId(project.id);
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : '登记项目失败，请检查输入后重试。');
    } finally {
      setProjectSaving(false);
    }
  }

  async function handleStartSession(projectId: string) {
    if (!goal.trim()) {
      setSessionError('请先填写会话目标。');
      return;
    }

    setSessionStartingProjectId(projectId);
    setSessionError('');

    try {
      const session = await createSession({ projectId, goal: goal.trim() });
      navigate('/sessions/' + session.id);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : '启动会话失败，请稍后重试。');
    } finally {
      setSessionStartingProjectId(null);
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
            <div className="hero-summary__eyebrow">Project Registry</div>
            <h3 className="hero-summary__title">项目登记与会话启动台</h3>
            <p className="hero-summary__description">
              当前已登记 <strong>{projects.length}</strong> 个项目，
              {selectedProjectId ? '正在编辑现有项目配置。' : '可直接创建新项目并发起自动化会话。'}
            </p>
          </div>
          <div className="hero-summary__kpis">
            <div className="kpi-tile">
              <span className="kpi-tile__label">已登记项目</span>
              <span className="kpi-tile__value">{projects.length}</span>
            </div>
            <div className="kpi-tile">
              <span className="kpi-tile__label">已配置框架</span>
              <span className="kpi-tile__value">{projects.filter((project) => Boolean(project.framework)).length}</span>
            </div>
            <div className="kpi-tile">
              <span className="kpi-tile__label">命令覆盖度</span>
              <span className="kpi-tile__value">{projectReadiness}%</span>
            </div>
            <div className="kpi-tile">
              <span className="kpi-tile__label">当前表单命令</span>
              <span className="kpi-tile__value">{projectFormCoverage}/3</span>
            </div>
          </div>
        </div>
        <div className="progress-ring" style={ringStyle}>
          <div className="progress-ring__inner">
            <strong>{projectReadiness}%</strong>
            <span>准备度</span>
          </div>
        </div>
      </motion.section>

      <div className="bento-grid projects-grid">
        <motion.section
          className="glass-card bento-item bento-item--span-2"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.05 }}
        >
          <h3 className="section-title">项目登记</h3>
          <p className="card-subtitle">保存仓库路径与构建命令，后续会话可直接复用，不必重复输入。</p>

          <form className="page-stack" onSubmit={handleSaveProject}>
            {selectedProjectId ? (
              <span className="status-pill status-pill--info" role="status" aria-live="polite">
                <span className="status-pill__dot" aria-hidden="true" />
                编辑模式：{selectedProject?.name || selectedProjectId}
              </span>
            ) : null}

            <div className="form-grid">
              <label className="field">
                <span>名称</span>
                <input
                  className="input"
                  value={projectForm.name}
                  onChange={(event) => setProjectForm({ ...projectForm, name: event.target.value })}
                  required
                />
              </label>
              <label className="field">
                <span>语言</span>
                <input
                  className="input"
                  value={projectForm.language}
                  onChange={(event) => setProjectForm({ ...projectForm, language: event.target.value })}
                  required
                />
              </label>

              <label className="field field--full">
                <span>根目录路径</span>
                <input
                  className="input mono"
                  value={projectForm.root_path}
                  onChange={(event) => setProjectForm({ ...projectForm, root_path: event.target.value })}
                  required
                />
              </label>

              <label className="field">
                <span>框架</span>
                <input
                  className="input"
                  value={projectForm.framework}
                  onChange={(event) => setProjectForm({ ...projectForm, framework: event.target.value })}
                  placeholder="例如 Next.js / Vue / Fastify"
                />
              </label>
              <label className="field">
                <span>忽略路径（逗号分隔）</span>
                <input
                  className="input"
                  value={String(projectForm.ignore_paths || '')}
                  onChange={(event) => setProjectForm({ ...projectForm, ignore_paths: event.target.value })}
                  placeholder="dist,node_modules,.next"
                />
              </label>

              <label className="field">
                <span>测试命令</span>
                <input
                  className="input mono"
                  value={projectForm.test_command}
                  onChange={(event) => setProjectForm({ ...projectForm, test_command: event.target.value })}
                  placeholder="npm run test"
                />
              </label>
              <label className="field">
                <span>Lint 命令</span>
                <input
                  className="input mono"
                  value={projectForm.lint_command}
                  onChange={(event) => setProjectForm({ ...projectForm, lint_command: event.target.value })}
                  placeholder="npm run lint"
                />
              </label>
              <label className="field field--full">
                <span>构建命令</span>
                <input
                  className="input mono"
                  value={projectForm.build_command}
                  onChange={(event) => setProjectForm({ ...projectForm, build_command: event.target.value })}
                  placeholder="npm run build"
                />
              </label>
            </div>

            <div className="button-row">
              <button className="button button--primary" type="submit" disabled={projectSaving}>
                {projectSaving ? '提交中...' : selectedProjectId ? '更新项目' : '登记项目'}
              </button>
              {selectedProjectId ? (
                <button
                  className="button button--ghost"
                  type="button"
                  onClick={() => {
                    setSelectedProjectId(null);
                    setProjectForm(emptyProject);
                  }}
                >
                  新建项目
                </button>
              ) : null}
            </div>
            {projectError ? (
              <div className="notice notice--error" role="alert">
                {projectError}
              </div>
            ) : null}
          </form>
        </motion.section>

        <motion.section
          className="glass-card bento-item bento-item--row-2"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.1 }}
        >
          <h3 className="section-title">发起工作会话</h3>
          <p className="card-subtitle">填写目标后选择项目，系统会自动进入规划、实现、评审与测试流程。</p>

          <label className="field field--full" style={{ marginTop: 18 }}>
            <span>会话目标</span>
            <textarea
              className="textarea"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="例如：新增设置页面，包含个人资料编辑、持久化与测试用例。"
            />
          </label>

          {sessionError ? (
            <div className="notice notice--error" role="alert" style={{ marginTop: 12 }}>
              {sessionError}
            </div>
          ) : null}

          <div className="list" style={{ marginTop: 18 }}>
            {projects.length === 0 ? (
              <EmptyState title="还没有登记项目" description="先完成项目登记，再从这里一键启动会话。" />
            ) : null}

            {projects.map(function (project) {
              const starting = sessionStartingProjectId === project.id;
              const completion = [project.test_command, project.lint_command, project.build_command].filter(Boolean).length;

              return (
                <div key={project.id} className="list-row list-row--interactive">
                  <div className="list-row__meta">
                    <strong>{project.name}</strong>
                    <span className="muted mono">{project.root_path}</span>
                    <span className="muted">
                      {project.language}
                      {project.framework ? ' · ' + project.framework : ''}
                    </span>
                    <span className="muted">命令覆盖：{completion}/3</span>
                  </div>
                  <div className="list-row__actions">
                    <button className="button button--ghost" type="button" onClick={() => setSelectedProjectId(project.id)}>
                      编辑
                    </button>
                    <button
                      className="button button--primary"
                      type="button"
                      disabled={Boolean(sessionStartingProjectId)}
                      onClick={() => handleStartSession(project.id)}
                    >
                      {starting ? '启动中...' : '启动会话'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </motion.section>

        <motion.section
          className="glass-card bento-item"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.15 }}
        >
          <h3 className="section-title">配置完整度</h3>
          <p className="card-subtitle">优先补齐测试、Lint 与构建命令，能显著提升自动化会话成功率。</p>

          <div className="list compact-list" style={{ marginTop: 14 }}>
            {projects.length === 0 ? (
              <EmptyState title="暂无项目" description="登记项目后可查看每个仓库的执行准备度。" />
            ) : (
              projects.slice(0, 6).map(function (project) {
                const completion = [project.test_command, project.lint_command, project.build_command].filter(Boolean).length;
                const tone = completion === 3 ? 'success' : completion === 0 ? 'danger' : 'warning';

                return (
                  <div key={project.id} className="list-row">
                    <div className="list-row__meta">
                      <strong>{project.name}</strong>
                      <span className="muted">{completion === 3 ? '命令齐全，可直接自动化执行。' : '建议补齐命令，提高流水线可靠性。'}</span>
                    </div>
                    <div className="list-row__actions">
                      <span className={'status-pill status-pill--' + tone}>
                        <span className="status-pill__dot" aria-hidden="true" />
                        {completion}/3
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="button-row" style={{ marginTop: 14 }}>
            <button className="button button--ghost" type="button" onClick={() => navigate('/overview')}>
              前往总览监控
            </button>
          </div>
        </motion.section>
      </div>
    </div>
  );
}
