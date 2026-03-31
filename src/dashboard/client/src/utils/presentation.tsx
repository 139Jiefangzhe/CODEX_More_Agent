import type { ReactNode } from 'react';

import { getEventTypeLabel } from './labels';

export function formatReviewNotes(reviewNotes: string): ReactNode {
  const parsed = parseStructuredReview(reviewNotes);

  if (!parsed) {
    return reviewNotes;
  }

  return (
    <>
      {parsed.summary ? <p style={{ margin: 0 }}>结论：{translateMessage(parsed.summary)}</p> : null}
      {parsed.notes.length > 0 ? (
        <div>
          <div style={{ marginBottom: 8 }}>评审说明</div>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {parsed.notes.map(function (note, index) {
              return <li key={index}>{translateMessage(note)}</li>;
            })}
          </ul>
        </div>
      ) : null}
      <p style={{ margin: 0 }}>是否建议通过：{parsed.approve == null ? '未说明' : parsed.approve ? '是' : '否'}</p>
      {parsed.risks.length > 0 ? (
        <div>
          <div style={{ marginBottom: 8 }}>风险提示</div>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {parsed.risks.map(function (risk, index) {
              return <li key={index}>{translateMessage(risk)}</li>;
            })}
          </ul>
        </div>
      ) : null}
      {parsed.remainder ? <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{translateMessage(parsed.remainder)}</pre> : null}
    </>
  );
}

export function formatEventData(eventType: string, eventData: Record<string, unknown>): ReactNode {
  if (eventType === 'output' && eventData.review_notes) {
    return formatReviewNotes(String(eventData.review_notes));
  }

  const summary = summarizeEventData(eventType, eventData);

  if (summary) {
    return summary;
  }

  return JSON.stringify(eventData, null, 2);
}

export function summarizeEventData(eventType: string, eventData: Record<string, unknown>) {
  const eventLabel = getEventTypeLabel(eventType);
  const message = firstString(eventData.message);
  const summary = firstString(eventData.summary);
  const architectureSummary = firstString(eventData.architecture_summary);
  const files = toStringList(eventData.files ?? eventData.files_to_read ?? eventData.expected_output_files);
  const risks = toStringList(eventData.risks);

  if (eventType === 'tool_call') {
    const tool = firstString(eventData.tool) || '未知工具';
    const contextFiles = toStringList(eventData.filesContext);
    return [eventLabel + '：' + tool]
      .concat(contextFiles.length ? ['上下文文件：' + contextFiles.join('，')] : [])
      .join('\n');
  }

  if (eventType === 'output' && eventData.review_notes) {
    const review = parseStructuredReview(String(eventData.review_notes));

    if (review) {
      return [
        eventLabel + '：' + translateMessage(review.summary || '评审已完成'),
        review.approve == null ? '' : '审批建议：' + (review.approve ? '建议通过' : '建议拒绝'),
        review.risks.length ? '风险：' + review.risks.map(translateMessage).join('；') : '',
      ]
        .filter(Boolean)
        .join('\n');
    }
  }

  if (eventType === 'output' && (architectureSummary || eventData.implementation_plan)) {
    return [eventLabel + '：已生成架构方案']
      .concat(files.length ? ['涉及文件：' + files.join('，')] : [])
      .join('\n');
  }

  if (summary) {
    return [eventLabel + '：' + translateMessage(summary)]
      .concat(files.length ? ['涉及文件：' + files.join('，')] : [])
      .concat(risks.length ? ['风险：' + risks.map(translateMessage).join('；')] : [])
      .join('\n');
  }

  if (message) {
    return [eventLabel + '：' + translateMessage(message)]
      .concat(files.length ? ['涉及文件：' + files.join('，')] : [])
      .concat(risks.length ? ['风险：' + risks.map(translateMessage).join('；')] : [])
      .join('\n');
  }

  if (files.length > 0) {
    return eventLabel + '：' + files.join('，');
  }

  return '';
}

export function translateMessage(message: string) {
  return message
    .replace('README-only patch stays within the requested scope and correctly updates quickstart guidance to mention optional `OPENAI_BASE_URL` support for proxy/relay usage. The change is minimal, consistent with the existing local configuration section, and introduces no code-path or runtime risk.', '仅 README 补丁保持在请求范围内，并正确更新了快速开始说明，补充了可选的 `OPENAI_BASE_URL` 代理/中转支持。变更很小，与现有本地配置说明保持一致，也不会引入代码路径或运行时风险。')
    .replace('Documentation-only change focused on README quickstart and local configuration guidance. No code, config, or behavior changes are needed. The update should clarify that OPENAI_BASE_URL is supported for proxy/relay endpoints during setup, while preserving existing wording about automatic /v1 normalization and optionality.', '这是一次仅文档范围的改动，聚焦 README 的快速开始和本地配置说明。不需要修改代码、配置模板或运行行为。本次更新主要是明确：在初始化配置时，`OPENAI_BASE_URL` 支持代理/中转端点，同时保持现有关于自动补全 `/v1` 和可选性的表述。')
    .replace('This change should be documentation-only and limited to README quickstart/local configuration guidance. The key update is to make OPENAI_BASE_URL support explicit for proxy/relay endpoints in the quickstart flow, while keeping existing semantics consistent with the documented local config section. No code, config templates, or runtime behavior should be changed.', '本次变更应严格保持为文档范围，仅限 README 的快速开始和本地配置说明。关键更新是让快速开始流程明确写出 `OPENAI_BASE_URL` 对代理/中转端点的支持，同时与当前已记录的本地配置语义保持一致。不应修改代码、配置模板或运行时行为。')
    .replace('Documentation-only change. Update the README quickstart and local configuration guidance so users know `OPENAI_BASE_URL` is supported for proxy/relay endpoints, without changing any application code or env templates unless the README explicitly references them.', '这是一次仅文档范围的改动。更新 README 的快速开始和本地配置说明，让用户明确知道 `OPENAI_BASE_URL` 支持代理/中转端点；除非 README 明确引用，否则不修改应用代码或环境模板。')
    .replace('Scope control is good: only `README.md` was changed, with no application code, env templates, or package metadata touched.', '范围控制良好：仅修改了 `README.md`，没有触及应用代码、环境模板或包元数据。')
    .replace('Quickstart wording is aligned with the goal: it now tells users to set `OPENAI_API_KEY` and optionally `OPENAI_BASE_URL` when using a proxy/relay endpoint.', '快速开始文案与目标一致：现在会明确告诉用户，使用代理/中转端点时，需要设置 `OPENAI_API_KEY`，并可选配置 `OPENAI_BASE_URL`。')
    .replace('The new text is consistent with the existing configuration section that already documents `OPENAI_BASE_URL`, so this reduces confusion rather than adding a new undocumented behavior.', '新增文案与现有已说明 `OPENAI_BASE_URL` 的配置章节保持一致，因此是在减少理解歧义，而不是引入新的未记录行为。')
    .replace('No correctness issues found in the diff itself. The documentation does not appear to overpromise beyond already-documented support.', '从 diff 本身看，没有发现正确性问题。文档也没有超出当前已记录能力做额外承诺。')
    .replace('Safety impact is effectively none because this is documentation-only.', '由于这是纯文档变更，因此几乎不存在安全影响。')
    .replace('Tests are not required for this change type, but a quick manual check of rendered README formatting would still be reasonable.', '这类变更不需要测试，但仍建议快速手工检查一下 README 的渲染格式。')
    .replace("Minor wording consideration: quickstart says '代理/中转端点' while the config section says '中转站'; this is acceptable, though terminology could be normalized later for consistency.", "文案上有一个小点需要注意：快速开始写的是“代理/中转端点”，配置章节写的是“中转站”。目前可以接受，但后续可以统一术语。")
    .replace('Potential documentation consistency check: if `.env.example` does not mention `OPENAI_BASE_URL`, some users may still look there first. The request explicitly preferred README-only, so this is not a blocker, just something to verify before merge.', '还可以做一个文档一致性检查：如果 `.env.example` 没有提到 `OPENAI_BASE_URL`，部分用户仍可能先看模板文件。当前请求明确偏向只改 README，所以这不是阻塞项，但合并前可以顺手确认。')
    .replace('README may diverge from .env.example if that template omits OPENAI_BASE_URL', '如果 `.env.example` 模板没有包含 `OPENAI_BASE_URL`，README 与模板之间可能会出现不一致')
    .replace('Terminology inconsistency between 代理/中转端点 and 中转站', '“代理/中转端点”和“中转站”的术语存在不一致')
    .replace('Unverified assumption that current runtime behavior fully matches README wording', '尚未完全验证当前运行时行为是否与 README 文案完全一致')
    .replace('Codex execution completed', 'Codex 执行已完成')
    .replace('Test command ready: ', '测试命令已准备：')
    .replace('Executing test command', '正在执行测试命令')
    .replace('Test command completed successfully', '测试命令执行成功')
    .replace('Change set written to workspace', '变更集已写入工作区')
    .replace('Applying approved change set to workspace', '正在将已批准变更集写入工作区')
    .replace('Dirty files overlap with approved change set', '检测到脏文件与已批准变更集冲突')
    .replace('Non-overlapping dirty files detected', '检测到不冲突的脏文件')
    .replace('Project write slot is now available', '项目写入槽位已释放')
    .replace('Waiting for another session to leave the write phase', '正在等待其他会话退出写入阶段')
    .replace('Planning architecture and implementation strategy', '正在规划架构与实现方案')
    .replace('Review generated implementation', '正在评审生成的实现内容')
    .replace('Implementation generated', '实现内容已生成')
    .replace('Approved change set applied', '已批准的变更集已应用')
    .replace('proxy/relay', '代理/中转')
    .replace('proxy or relay', '代理或中转')
    .replace('proxy/relay endpoints', '代理/中转端点')
    .replace('proxy or relay endpoints', '代理或中转端点')
    .replace('proxy/relay endpoint', '代理/中转端点')
    .replace('proxy or relay endpoint', '代理或中转端点')
    .replace('Configure', '配置')
    .replace('Documentation-only', '仅文档')
    .replace('README-only', '仅 README')
    .replace('proxy/relay', '代理或中转');
}

function parseStructuredReview(input: string) {
  const extracted = extractLeadingJsonObject(input);

  if (!extracted) {
    return null;
  }

  try {
    const parsed = JSON.parse(extracted.jsonText);

    return {
      summary: firstString(parsed.summary),
      notes: toStringList(parsed.review_notes),
      approve: typeof parsed.approve === 'boolean' ? parsed.approve : null,
      risks: toStringList(parsed.risks),
      remainder: normalizeReviewRemainder(extracted.remainder, toStringList(parsed.risks)),
    };
  } catch {
    return null;
  }
}

function extractLeadingJsonObject(input: string) {
  const text = input.trim();

  if (!text.startsWith('{')) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;

      if (depth === 0) {
        return {
          jsonText: text.slice(0, index + 1),
          remainder: text.slice(index + 1),
        };
      }
    }
  }

  return null;
}

function toStringList(value: unknown) {
  if (value == null) {
    return [];
  }

  if (Array.isArray(value)) {
    return value
      .map(function (entry) {
        return typeof entry === 'string' ? entry.trim() : '';
      })
      .filter(Boolean);
  }

  if (typeof value === 'string') {
    return [value.trim()].filter(Boolean);
  }

  return [];
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
}

function normalizeReviewRemainder(remainder: string, risks: string[]) {
  const trimmed = remainder.trim();

  if (!trimmed) {
    return '';
  }

  if (trimmed.startsWith('Risks:') && risks.length > 0) {
    return '';
  }

  return trimmed;
}
