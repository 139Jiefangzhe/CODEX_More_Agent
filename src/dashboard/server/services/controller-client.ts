import path from 'node:path';

import { ResponsesHttpClient, normalizeBaseUrl } from './openai-responses-client.js';

export class ControllerClient {
  apiKey: string | undefined;
  baseUrl: string | undefined;
  model: string;
  client: ResponsesHttpClient | null;

  constructor(config) {
    this.apiKey = config.apiKey;
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.model = config.model;
    this.client = config.apiKey ? new ResponsesHttpClient({ apiKey: config.apiKey, baseUrl: this.baseUrl }) : null;
  }

  async planSession(input) {
    this.assertConfigured();

    const systemPrompt = [
      'You are gpt-5.4 acting as the orchestration and architecture controller for a personal software workbench.',
      'Decide the implementation shape, select the most relevant files to read, and define what the coder should produce.',
      'Focus on practical implementation and reviewability.',
      'Return valid JSON only.',
      'Use exactly these top-level keys: architecture_summary, implementation_plan, files_to_read, expected_output_files, review_focus.',
      'files_to_read and expected_output_files must be arrays of project-relative file paths as strings.',
      'review_focus must be an array of short review checkpoints.'
    ].join('\n');
    const userPrompt = [
      'Project name: ' + input.project.name,
      'Project root: ' + input.project.root_path,
      'Language: ' + input.project.language,
      'Framework: ' + (input.project.framework ?? 'unknown'),
      'Goal:',
      input.goal,
      '',
      'Available commands:',
      '- test: ' + (input.project.test_command ?? 'not configured'),
      '- lint: ' + (input.project.lint_command ?? 'not configured'),
      '- build: ' + (input.project.build_command ?? 'not configured'),
      '',
      'Project tree:',
      input.context.fileTree.join('\n'),
      '',
      'Key file excerpts:',
      formatContextFiles(input.context.keyFiles),
    ].join('\n');

    const payload = await this.requestJson(systemPrompt, userPrompt);
    return normalizePlanPayload(payload, input.project.root_path);
  }

  async reviewChangeSet(input) {
    this.assertConfigured();

    const systemPrompt = [
      'You are gpt-5.4 acting as the final reviewer for a local development workbench.',
      'Review the proposed implementation produced by gpt-5.3-codex.',
      'Be concrete about correctness, safety, missing tests, and integration risks.',
      'Return valid JSON only.',
      'Use exactly these top-level keys: summary, review_notes, approve, risks.',
      'approve must be a boolean. risks must be an array of short strings.'
    ].join('\n');
    const userPrompt = [
      'Goal:',
      input.goal,
      '',
      'Architecture summary:',
      input.plan.architecture_summary,
      '',
      'Implementation plan:',
      input.plan.implementation_plan,
      '',
      'Diff summary:',
      input.diffText,
      '',
      'Generated files:',
      formatGeneratedFiles(input.generatedFiles),
      '',
      'Codex logs:',
      input.codexLogs || 'No logs available',
    ].join('\n');

    const payload = await this.requestJson(systemPrompt, userPrompt);
    return normalizeReviewPayload(payload);
  }

  async requestJson(systemPrompt, userPrompt) {
    const response = await this.getClient().create({
      model: this.model,
      instructions: systemPrompt,
      input: userPrompt,
      text: {
        verbosity: 'high',
      },
    }, {
      maxAttempts: 3,
    });

    return parseJsonPayload(extractOutputText(response), this.model);
  }

  assertConfigured() {
    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY is not configured');
    }
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  getClient() {
    this.assertConfigured();

    if (!this.client) {
      this.client = new ResponsesHttpClient({ apiKey: this.apiKey, baseUrl: this.baseUrl });
    }

    return this.client;
  }
}

function parseJsonPayload(text, modelName) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error('Invalid JSON from ' + modelName + ': ' + (error instanceof Error ? error.message : String(error)));
  }
}

function extractOutputText(response) {
  if (typeof response.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const fragments = [];
  collectText(response.output, fragments);
  return fragments.join('\n').trim();
}

function collectText(value, fragments) {
  if (!value) {
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectText(entry, fragments);
    }
    return;
  }

  if (typeof value !== 'object') {
    return;
  }

  if (typeof value.text === 'string') {
    fragments.push(value.text);
  }

  if (Array.isArray(value.content)) {
    collectText(value.content, fragments);
  }
}

function formatContextFiles(files) {
  if (!files.length) {
    return '- No context files available';
  }

  return files
    .map(function (file) {
      return ['File: ' + file.path, '```', file.content, '```'].join('\n');
    })
    .join('\n\n');
}

function normalizePlanPayload(payload, rootPath) {
  if (payload?.architecture_summary && payload?.implementation_plan) {
    return {
      architecture_summary: String(payload.architecture_summary),
      implementation_plan: String(payload.implementation_plan),
      files_to_read: dedupeStrings((payload.files_to_read ?? []).map((value) => normalizePathValue(rootPath, value))).slice(0, 16),
      expected_output_files: dedupeStrings((payload.expected_output_files ?? []).map((value) => normalizePathValue(rootPath, value))),
      review_focus: dedupeStrings(payload.review_focus ?? []).slice(0, 8),
    };
  }

  const architectureSummary =
    firstNonEmptyString(
      payload?.architecture_summary,
      payload?.summary,
      payload?.implementation_shape?.goal,
      payload?.implementation_shape?.reviewability,
    ) || 'Prepare a focused implementation plan for the requested change.';
  const planLines = []
    .concat(normalizeStringList(payload?.implementation_shape?.scope))
    .concat(normalizeStringList(payload?.coder_instructions?.requirements))
    .concat(normalizeStringList(payload?.validation?.notes));
  const filesToRead = normalizePathList(rootPath, payload?.files_to_read);
  const expectedOutputFiles = dedupeStrings(
    normalizePathList(rootPath, payload?.expected_output_files).concat(
      normalizePathList(rootPath, payload?.coder_instructions?.produce),
      normalizePathList(rootPath, payload?.coder_instructions?.suggested_edit?.file),
    ),
  );
  const reviewFocus = dedupeStrings(
    normalizeStringList(payload?.review_focus)
      .concat(normalizeStringList(payload?.coder_instructions?.acceptance_criteria))
      .concat(normalizeStringList(payload?.implementation_shape?.non_goals)),
  );

  return {
    architecture_summary: architectureSummary,
    implementation_plan: planLines.filter(Boolean).join('\n') || JSON.stringify(payload, null, 2),
    files_to_read: dedupeStrings(filesToRead).slice(0, 16),
    expected_output_files: expectedOutputFiles,
    review_focus: reviewFocus.slice(0, 8),
  };
}

function normalizeReviewPayload(payload) {
  if (typeof payload?.summary === 'string' && typeof payload?.review_notes === 'string') {
    return {
      summary: payload.summary,
      review_notes: payload.review_notes,
      approve: Boolean(payload.approve),
      risks: dedupeStrings(payload.risks ?? []),
    };
  }

  const risks = dedupeStrings(
    normalizeStringList(payload?.risks).concat(
      normalizeStringList(payload?.findings),
      normalizeStringList(payload?.concerns),
    ),
  );

  return {
    summary: firstNonEmptyString(payload?.summary, payload?.overall_assessment, payload?.decision) || 'Review completed.',
    review_notes:
      firstNonEmptyString(payload?.review_notes, payload?.notes, payload?.details, payload?.recommendation) ||
      JSON.stringify(payload, null, 2),
    approve: payload?.approve === true || payload?.approved === true || payload?.decision === 'approve',
    risks,
  };
}

function normalizePathList(rootPath, values) {
  if (values == null) {
    return [];
  }

  if (Array.isArray(values)) {
    return values
      .flatMap(function (entry) {
        if (typeof entry === 'string') {
          return [entry];
        }

        if (entry && typeof entry === 'object') {
          return [entry.path, entry.file, entry.filename].filter(Boolean);
        }

        return [];
      })
      .map((value) => normalizePathValue(rootPath, value))
      .filter(Boolean);
  }

  return [normalizePathValue(rootPath, values)].filter(Boolean);
}

function normalizePathValue(rootPath, value) {
  if (typeof value !== 'string' || !value.trim()) {
    return '';
  }

  const trimmed = value.trim();

  if (!path.isAbsolute(trimmed)) {
    return trimmed;
  }

  const relative = path.relative(rootPath, trimmed);
  return relative && !relative.startsWith('..') ? relative : trimmed;
}

function normalizeStringList(values) {
  if (values == null) {
    return [];
  }

  if (Array.isArray(values)) {
    return values
      .flatMap(function (entry) {
        if (typeof entry === 'string') {
          return [entry];
        }

        if (entry && typeof entry === 'object') {
          return [entry.path, entry.reason, entry.file, entry.message, entry.summary].filter(Boolean);
        }

        return [];
      })
      .map(function (value) {
        return String(value).trim();
      })
      .filter(Boolean);
  }

  return [String(values).trim()].filter(Boolean);
}

function dedupeStrings(values) {
  return Array.from(new Set(normalizeStringList(values)));
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
}

function formatGeneratedFiles(files) {
  if (!files.length) {
    return '- No files generated';
  }

  return files
    .map(function (file) {
      return ['File: ' + file.path, '```', file.content, '```'].join('\n');
    })
    .join('\n\n');
}
