const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export class ResponsesHttpClient {
  apiKey: string;
  baseUrl: string;

  constructor(config) {
    this.apiKey = config.apiKey;
    this.baseUrl = normalizeBaseUrl(config.baseUrl) || DEFAULT_BASE_URL;
  }

  async create(body, requestOptions: any = {}) {
    return this.request('/responses', {
      method: 'POST',
      body,
      maxAttempts: requestOptions.maxAttempts,
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  async retrieve(responseId, requestOptions: any = {}) {
    return this.request('/responses/' + encodeURIComponent(responseId), {
      method: 'GET',
      maxAttempts: requestOptions.maxAttempts,
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  async cancel(responseId, requestOptions: any = {}) {
    return this.request('/responses/' + encodeURIComponent(responseId) + '/cancel', {
      method: 'POST',
      body: {},
      maxAttempts: requestOptions.maxAttempts,
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  async request(endpoint, options) {
    const maxAttempts = options.maxAttempts ?? 1;
    const timeoutMs = Number(options.timeoutMs ?? 0);
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let timeout = null;

      try {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        timeout = controller && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
        const response = await fetch(buildUrl(this.baseUrl, endpoint), {
          method: options.method,
          headers: {
            Accept: 'application/json',
            Authorization: 'Bearer ' + this.apiKey,
            ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller?.signal,
        });
        const rawText = await response.text();
        const parsed = parseRelayPayload(rawText);

        if (!response.ok) {
          const error = new Error(buildErrorMessage(response.status, parsed, rawText));

          if (attempt < maxAttempts && isRetryableStatus(response.status)) {
            lastError = error;
            await delay(attempt * 1000);
            continue;
          }

          throw error;
        }

        return parsed;
      } catch (error) {
        if (attempt < maxAttempts && isRetryableNetworkError(error)) {
          lastError = error;
          await delay(attempt * 1000);
          continue;
        }

        throw error;
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }
    }

    throw lastError ?? new Error('OpenAI relay request failed');
  }
}

export function normalizeBaseUrl(baseUrl) {
  if (!baseUrl) {
    return undefined;
  }

  const trimmed = String(baseUrl).trim().replace(/\/+$/, '');

  if (!trimmed) {
    return undefined;
  }

  try {
    const url = new URL(trimmed);
    return url.pathname === '/' || url.pathname === '' ? trimmed + '/v1' : trimmed;
  } catch {
    return trimmed;
  }
}

function buildUrl(baseUrl, endpoint) {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  return new URL(endpoint.replace(/^\//, ''), normalizedBase).toString();
}

function buildErrorMessage(status, parsed, rawText) {
  const rawFallback = rawText.trim() || 'OpenAI relay request failed';
  const errorMessage = parsed?.error?.message ?? parsed?.message ?? parsed?.error ?? rawFallback;

  return 'OpenAI relay request failed (' + status + '): ' + String(errorMessage);
}

function parseRelayPayload(rawText) {
  const trimmed = rawText.trim();

  if (!trimmed) {
    return null;
  }

  const json = tryParseJson(trimmed);

  if (json !== undefined) {
    return json;
  }

  const streamed = parseSsePayload(trimmed);

  if (streamed !== undefined) {
    return streamed;
  }

  return {
    object: 'response',
    status: 'completed',
    output_text: trimmed,
    output: [
      {
        type: 'message',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: trimmed,
          },
        ],
      },
    ],
  };
}

function parseSsePayload(rawText) {
  if (!/(^|\n)(event:|data:)/.test(rawText)) {
    return undefined;
  }

  let lastResponse = undefined;
  let lastPayload = undefined;

  for (const block of rawText.split(/\r?\n\r?\n/)) {
    let eventType = '';
    const dataLines = [];

    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    const dataText = dataLines.join('\n').trim();

    if (!dataText || dataText === '[DONE]') {
      continue;
    }

    const payload = tryParseJson(dataText);

    if (payload === undefined) {
      continue;
    }

    lastPayload = payload;

    if (payload?.response && typeof payload.response === 'object') {
      lastResponse = payload.response;
      continue;
    }

    if (eventType === 'response.completed' && payload && typeof payload === 'object') {
      lastResponse = payload;
    }
  }

  return lastResponse ?? lastPayload;
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isRetryableNetworkError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('fetch failed') ||
    message.includes('ETIMEDOUT') ||
    message.includes('ECONNRESET') ||
    message.includes('aborted') ||
    message.includes('AbortError')
  );
}

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}
