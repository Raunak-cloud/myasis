interface RobotsGroup {
  agents: string[];
  rules: Array<{ allow: boolean; pattern: string }>;
  crawlDelaySec?: number;
}

export interface RobotsRules {
  isAllowed(path: string): boolean;
  /** Set when robots.txt itself was refused (5xx/unreachable), which RFC 9309 treats as disallow-all. */
  refusedStatus?: number;
  crawlDelayMs?: number;
  sitemaps: string[];
}

/** Parses robots.txt and selects the group for `agentToken`, falling back to `*`. */
export function parseRobots(body: string, agentToken: string): RobotsRules {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | undefined;
  let lastWasAgent = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const match = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const field = match[1].toLowerCase();
    const value = match[2].trim();
    if (field === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === 'user-agent') {
      // Consecutive user-agent lines share one group.
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === 'allow' || field === 'disallow') {
      // An empty Disallow allows everything; it adds no rule.
      if (value) current.rules.push({ allow: field === 'allow', pattern: value });
    } else if (field === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) current.crawlDelaySec = seconds;
    }
  }

  const token = agentToken.toLowerCase();
  const own = groups.filter((group) => group.agents.some((agent) => agent !== '*' && token.includes(agent)));
  const chosen = own.length ? own : groups.filter((group) => group.agents.includes('*'));
  const rules = chosen.flatMap((group) => group.rules);
  const delay = chosen.map((group) => group.crawlDelaySec).find((value) => value !== undefined);

  return {
    sitemaps,
    crawlDelayMs: delay !== undefined ? delay * 1000 : undefined,
    isAllowed(path: string) {
      // Longest matching rule wins; on a tie, Allow wins (RFC 9309 §2.2.2).
      let best: { allow: boolean; length: number } | undefined;
      for (const rule of rules) {
        if (!robotsPatternMatches(rule.pattern, path)) continue;
        const length = rule.pattern.length;
        if (!best || length > best.length || (length === best.length && rule.allow)) best = { allow: rule.allow, length };
      }
      return best ? best.allow : true;
    },
  };
}

function robotsPatternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const regex = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${regex}${anchored ? '$' : ''}`).test(path);
}

