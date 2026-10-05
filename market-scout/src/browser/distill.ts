import type { Page } from 'patchright';

/**
 * The page as a model should read it: main content as compact markdown, plus
 * the on-page SEO and marketing facts a competitor audit needs, measured in
 * the page itself rather than guessed from text.
 *
 * Pruning follows Crawl4AI's "fit markdown" idea: chrome (nav, footer,
 * banners) is dropped by role, and link-dense blocks — menus, tag clouds,
 * footers without semantic tags — by ratio of link text to all text.
 */

export interface PageFacts {
  url: string;
  title: string;
  metaDescription: string;
  canonical: string;
  robotsMeta: string;
  lang: string;
  h1: string[];
  outline: string[];
  jsonLdTypes: string[];
  openGraph: Record<string, string>;
  hreflangCount: number;
  wordCount: number;
  imagesWithoutAlt: number;
  internalLinks: number;
  externalLinks: number;
  /** Button and CTA-like link labels visible in the first screen. */
  aboveFoldCtas: string[];
  /** Every external script source, for stack and ad-pixel detection. */
  scriptSources: string[];
  /** Inline script fingerprints worth matching (fbq(, ttq., gtag(…), truncated. */
  inlineSignals: string[];
  generator: string;
  /** Internal links with their anchor text, for crawling and site structure. */
  links: Array<{ text: string; href: string }>;
  markdown: string;
}

/**
 * Runs in the page. Run the CLI from the compiled build (`npm run dev`), not
 * tsx: esbuild's keepNames wraps the helpers below in `__name()`, which does
 * not exist in patchright's isolated evaluation world.
 */
export async function distill(page: Page, maxChars = 20_000): Promise<PageFacts> {
  return page.evaluate((limit: number) => {
    const doc = document;
    const origin = location.origin;
    const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
    const meta = (selector: string) => clean(doc.querySelector(selector)?.getAttribute('content'));

    const jsonLdTypes: string[] = [];
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const stack: unknown[] = [JSON.parse(script.textContent ?? '')];
        while (stack.length) {
          const node = stack.pop();
          if (Array.isArray(node)) stack.push(...node);
          else if (node && typeof node === 'object') {
            const type = (node as Record<string, unknown>)['@type'];
            if (typeof type === 'string') jsonLdTypes.push(type);
            else if (Array.isArray(type)) jsonLdTypes.push(...type.filter((t): t is string => typeof t === 'string'));
            stack.push(...Object.values(node as Record<string, unknown>));
          }
        }
      } catch {
        // Malformed JSON-LD is itself an audit finding, but not one we report.
      }
    }

    const openGraph: Record<string, string> = {};
    for (const tag of doc.querySelectorAll('meta[property^="og:"], meta[name^="twitter:"]')) {
      const key = tag.getAttribute('property') ?? tag.getAttribute('name') ?? '';
      if (key) openGraph[key] = clean(tag.getAttribute('content')).slice(0, 300);
    }

    let internalLinks = 0;
    let externalLinks = 0;
    const links: Array<{ text: string; href: string }> = [];
    const seenLinks = new Set<string>();
    for (const anchor of doc.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      let href: URL;
      try {
        href = new URL(anchor.getAttribute('href') ?? '', location.href);
      } catch {
        continue;
      }
      if (!/^https?:$/.test(href.protocol)) continue;
      if (href.origin === origin) {
        internalLinks += 1;
        href.hash = '';
        const key = href.toString();
        if (!seenLinks.has(key) && links.length < 400) {
          seenLinks.add(key);
          links.push({ text: clean(anchor.innerText || anchor.getAttribute('aria-label')).slice(0, 80), href: key });
        }
      } else externalLinks += 1;
    }

    const viewportHeight = innerHeight;
    const aboveFoldCtas: string[] = [];
    for (const element of doc.querySelectorAll<HTMLElement>('button, a[class*="btn" i], a[class*="button" i], a[role="button"], input[type="submit"]')) {
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1 || rect.top > viewportHeight || rect.bottom < 0) continue;
      const label = clean(element.innerText || (element as HTMLInputElement).value || element.getAttribute('aria-label'));
      if (label && label.length <= 60 && !aboveFoldCtas.includes(label)) aboveFoldCtas.push(label);
    }

    const scriptSources = [...new Set([...doc.querySelectorAll<HTMLScriptElement>('script[src]')].map((s) => s.src).filter((src) => !src.startsWith(origin)))].slice(0, 120);
    const inlineSignals: string[] = [];
    for (const script of doc.querySelectorAll('script:not([src])')) {
      const text = script.textContent ?? '';
      const hit = /(fbq\(['"]init['"],\s*['"]?\d+|ttq\.load\(['"][A-Z0-9]+|gtag\(['"]config['"],\s*['"][A-Z]{1,3}-[\w-]+|rdt\(['"]init['"],\s*['"][\w-]+|_linkedin_partner_id\s*=\s*['"]?\d+|pintrk\(['"]load['"],\s*['"]\d+|snaptr\(['"]init['"]|twq\(['"]config['"]|GTM-[A-Z0-9]+|hotjar|clarity\.ms|klaviyo|hubspot|intercom|shopify|wp-content)/i.exec(text);
      if (hit && !inlineSignals.includes(hit[0])) inlineSignals.push(hit[0].slice(0, 80));
    }

    // ---- Main content → markdown ----
    const root = (doc.querySelector('main, [role="main"], article') as HTMLElement | null) ?? doc.body;
    const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS', 'IFRAME', 'TEMPLATE', 'NAV', 'FOOTER', 'ASIDE', 'FORM', 'BUTTON', 'SELECT', 'INPUT']);
    const out: string[] = [];
    let size = 0;
    const stack: Array<{ node: Node; depth: number }> = [{ node: root, depth: 0 }];
    while (stack.length && size < limit) {
      const { node } = stack.pop()!;
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const element = node as HTMLElement;
      if (skip.has(element.tagName)) continue;
      const role = element.getAttribute('role') ?? '';
      if (/^(navigation|banner|contentinfo|dialog|alertdialog|search)$/.test(role) || element.getAttribute('aria-hidden') === 'true') continue;
      if (/cookie|consent|newsletter-popup|modal/i.test(`${element.id} ${typeof element.className === 'string' ? element.className : ''}`) && element !== root) continue;
      if (element.tagName === 'HEADER' && element !== root && element.closest('article') === null) continue;
      if (!element.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) && element !== root) continue;

      const tag = element.tagName;
      const text = clean(element.innerText);
      if (!text) continue;
      let line = '';
      if (/^H[1-6]$/.test(tag)) line = `${'#'.repeat(Number(tag[1]))} ${text}`;
      else if (tag === 'P' || tag === 'BLOCKQUOTE' || tag === 'FIGCAPTION' || tag === 'DT' || tag === 'DD') line = tag === 'BLOCKQUOTE' ? `> ${text}` : text;
      else if (tag === 'LI') line = `- ${text}`;
      else if (tag === 'TR') line = `| ${[...element.children].map((cell) => clean((cell as HTMLElement).innerText)).join(' | ')} |`;
      else if (tag === 'PRE') line = text.slice(0, 500);
      else if (tag === 'IMG') continue;
      else {
        // A container: prune it if it is mostly links, otherwise descend.
        const linkText = [...element.querySelectorAll('a')].reduce((sum, a) => sum + clean(a.innerText).length, 0);
        if (text.length > 0 && linkText / text.length > 0.65 && text.length < 1_500 && element !== root) continue;
        const blockChildren = [...element.children].some((child) => /^(P|DIV|SECTION|ARTICLE|UL|OL|LI|H[1-6]|TABLE|TBODY|THEAD|TR|BLOCKQUOTE|PRE|DL|FIGURE|HEADER|MAIN)$/.test(child.tagName));
        if (!blockChildren) {
          if (text.length >= 2) line = text;
        } else {
          const children = [...element.children];
          for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], depth: 0 });
          continue;
        }
      }
      if (line && out[out.length - 1] !== line) {
        out.push(line.slice(0, 2_000));
        size += line.length + 1;
      }
    }

    const bodyText = clean(doc.body?.innerText);
    return {
      url: location.href,
      title: clean(doc.title),
      metaDescription: meta('meta[name="description"]'),
      canonical: clean(doc.querySelector('link[rel="canonical"]')?.getAttribute('href')),
      robotsMeta: meta('meta[name="robots"]'),
      lang: clean(doc.documentElement.getAttribute('lang')),
      h1: [...doc.querySelectorAll('h1')].map((h) => clean((h as HTMLElement).innerText)).filter(Boolean).slice(0, 5),
      outline: [...doc.querySelectorAll('h2, h3')].map((h) => `${h.tagName === 'H2' ? '' : '  '}${clean((h as HTMLElement).innerText)}`).filter((h) => h.trim()).slice(0, 60),
      jsonLdTypes: [...new Set(jsonLdTypes)],
      openGraph,
      hreflangCount: doc.querySelectorAll('link[rel="alternate"][hreflang]').length,
      wordCount: bodyText ? bodyText.split(' ').length : 0,
      imagesWithoutAlt: [...doc.querySelectorAll('img')].filter((img) => !img.getAttribute('alt')?.trim()).length,
      internalLinks,
      externalLinks,
      aboveFoldCtas: aboveFoldCtas.slice(0, 20),
      scriptSources,
      inlineSignals,
      generator: meta('meta[name="generator"]'),
      links,
      markdown: out.join('\n').slice(0, limit),
    };
  }, maxChars);
}
