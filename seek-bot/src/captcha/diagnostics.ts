/** Keep provider explanations, never connection URLs, credentials or arbitrary payloads. */
export function safeCaptchaDiagnostic(value: unknown, secrets: string[] = []): Record<string, unknown> {
  const privateValues = [...new Set(secrets.filter(x => x.length >= 4).flatMap(x => [x, encodeURIComponent(x)]))]
    .sort((a, b) => b.length - a.length);
  const clean = (text: string): string => {
    for (const secret of privateValues) text = text.split(secret).join('[redacted]');
    return text
      .replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi, '[url]')
      .replace(/\bbrd-customer-[\w-]+/gi, '[account]')
      .replace(/\bBearer\s+[^\s,"'}]+/gi, 'Bearer [redacted]')
      .replace(/((?:password|passwd|token|api[_-]?key|secret|authorization|cookie)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[redacted]')
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
      .replace(/[\r\n\t]+/g, ' ')
      .slice(0, 800);
  };
  const read = (input: unknown, depth: number): Record<string, unknown> => {
    if (typeof input === 'string') return { message: clean(input) };
    if (!input || typeof input !== 'object') return {};
    const output: Record<string, unknown> = {};
    for (const key of ['name', 'code', 'status', 'message', 'reason', 'error']) {
      const field = (input as Record<string, unknown>)[key];
      if (typeof field === 'string') output[key] = clean(field);
      else if (typeof field === 'number' && Number.isFinite(field)) output[key] = field;
      else if (field && typeof field === 'object' && depth < 1) output[key] = read(field, depth + 1);
    }
    return output;
  };
  return read(value, 0);
}

export function captchaDiagnosticSecrets(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env).flatMap(([key, value]) =>
    /password|passwd|secret|token|api_?key|username|cookie|authorization/i.test(key) && value ? [value] : []);
}
