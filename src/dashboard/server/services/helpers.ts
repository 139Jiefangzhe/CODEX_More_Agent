export function parseJson(value, fallback) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function toJson(value) {
  return JSON.stringify(value ?? null);
}

export function nowIso() {
  return new Date().toISOString();
}

export function truncate(value, length = 240) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > length ? normalized.slice(0, length - 3) + '...' : normalized;
}
