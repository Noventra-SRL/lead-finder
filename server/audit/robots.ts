/*
 * robots.txt secondo l'RFC 9309: si applica il gruppo del nostro user-agent ("NoventraLeadFinder") o, in mancanza,
 * quello "*". Vince la regola più lunga; a parità vince Allow. Supporta "*" e "$".
 * Stato del file (RFC 9309, sezione 2.3.1): 2xx = regole lette; 4xx = nessuna restrizione; 5xx o sito
 * irraggiungibile = tutto vietato (finché non si riesce a leggerlo).
 */

export const ROBOTS_TOKEN = 'noventraleadfinder';

interface Rule {
  allow: boolean;
  pattern: string;
}

export interface Robots {
  /** Come è stato ottenuto: letto, assente (4xx), non leggibile (5xx o errore: tutto vietato). */
  source: 'parsed' | 'missing' | 'unavailable';
  rules: Rule[];
  /** Gruppo applicato: il nostro user-agent, "*" o nessuno. */
  group: 'specific' | 'any' | 'none';
  crawlDelaySeconds: number | null;
  sitemaps: string[];
}

export function parseRobots(text: string, baseUrl: string): Robots {
  const groups: { agents: string[]; rules: Rule[]; crawlDelay: number | null }[] = [];
  const sitemaps: string[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/).slice(0, 5000)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === 'sitemap') {
      try {
        sitemaps.push(new URL(value, baseUrl).toString());
      } catch {
        // indirizzo della sitemap non valido: ignorato
      }
      continue;
    }
    if (!current) continue;
    if (key === 'allow' || key === 'disallow') {
      // "Disallow:" vuoto non vieta nulla
      if (value) current.rules.push({ allow: key === 'allow', pattern: value });
    } else if (key === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    }
  }
  // il token di prodotto deve coincidere (senza versione), non basta una parte del nome
  const specific = groups.filter((g) => g.agents.some((a) => a.split('/')[0]!.trim() === ROBOTS_TOKEN));
  const any = groups.filter((g) => g.agents.includes('*'));
  const chosen = specific.length ? specific : any;
  return {
    source: 'parsed',
    rules: chosen.flatMap((g) => g.rules),
    group: specific.length ? 'specific' : any.length ? 'any' : 'none',
    crawlDelaySeconds: chosen.find((g) => g.crawlDelay !== null)?.crawlDelay ?? null,
    sitemaps: [...new Set(sitemaps)].slice(0, 20),
  };
}

export const robotsMissing = (): Robots => ({
  source: 'missing',
  rules: [],
  group: 'none',
  crawlDelaySeconds: null,
  sitemaps: [],
});
export const robotsUnavailable = (): Robots => ({
  source: 'unavailable',
  rules: [],
  group: 'none',
  crawlDelaySeconds: null,
  sitemaps: [],
});

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/** Percorso (con query) consentito dalle regole. */
export function isAllowed(robots: Robots, pathWithQuery: string): boolean {
  if (robots.source === 'unavailable') return false;
  if (robots.source === 'missing') return true;
  let best: Rule | null = null;
  for (const rule of robots.rules) {
    if (!patternToRegex(rule.pattern).test(pathWithQuery)) continue;
    if (
      !best ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow)
    )
      best = rule;
  }
  return best ? best.allow : true;
}
