const COMPANY_SUFFIXES = new Set([
  'company', 'co', 'corp', 'corporation',
  'inc', 'incorporated', 'limited', 'ltd', 'llc', 'plc', 'pty', 'holdings', 'group',
]);
const CONNECTORS = new Set(['and', 'of', 'the']);

/** Normalised words used for literal and typo-tolerant company comparison. */
function companyTokens(value: string): string[] {
  const words = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .match(/[a-z0-9]+/g) ?? [];

  while (words.length && COMPANY_SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.filter((word) => !CONNECTORS.has(word) && !COMPANY_SUFFIXES.has(word));
}

function acronym(tokens: readonly string[]): string {
  return tokens.map((token) => token[0] ?? '').join('');
}

/** Jaro-Winkler is well suited to short names and transposed letters. */
function jaroWinkler(left: string, right: string): number {
  if (left === right) return 1;
  if (!left.length || !right.length) return 0;

  const range = Math.max(0, Math.floor(Math.max(left.length, right.length) / 2) - 1);
  const leftMatched = new Array<boolean>(left.length).fill(false);
  const rightMatched = new Array<boolean>(right.length).fill(false);
  let matches = 0;

  for (let i = 0; i < left.length; i++) {
    const start = Math.max(0, i - range);
    const end = Math.min(i + range + 1, right.length);
    for (let j = start; j < end; j++) {
      if (rightMatched[j] || left[i] !== right[j]) continue;
      leftMatched[i] = true;
      rightMatched[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;

  const leftSequence = [...left].filter((_, index) => leftMatched[index]);
  const rightSequence = [...right].filter((_, index) => rightMatched[index]);
  let transpositions = 0;
  for (let i = 0; i < leftSequence.length; i++) {
    if (leftSequence[i] !== rightSequence[i]) transpositions++;
  }
  const jaro = (
    matches / left.length
    + matches / right.length
    + (matches - transpositions / 2) / matches
  ) / 3;
  let prefix = 0;
  while (prefix < Math.min(4, left.length, right.length) && left[prefix] === right[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

function tokensAppearTogether(needle: readonly string[], haystack: readonly string[]): boolean {
  if (!needle.length || needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start++) {
    if (needle.every((token, offset) => token === haystack[start + offset])) return true;
  }
  return false;
}

function tokenSimilar(left: string, right: string): boolean {
  if (left === right) return true;
  // Short names and acronyms are too collision-prone for fuzzy matching.
  if (Math.min(left.length, right.length) < 5) return false;
  return jaroWinkler(left, right) >= 0.93;
}

function companyNamesMatch(excluded: readonly string[], advertised: readonly string[]): boolean {
  if (!excluded.length || !advertised.length) return false;
  if (excluded.join(' ') === advertised.join(' ')) return true;
  if (tokensAppearTogether(excluded, advertised) || tokensAppearTogether(advertised, excluded)) return true;

  const excludedAcronym = acronym(excluded);
  const advertisedAcronym = acronym(advertised);
  if (excludedAcronym.length >= 3 && excludedAcronym === advertised.join('')) return true;
  if (advertisedAcronym.length >= 3 && advertisedAcronym === excluded.join('')) return true;

  // Every word the user supplied must have a close counterpart. This accepts
  // "Commonweath Bank" but not a generic one-word overlap such as "Bank".
  const used = new Set<number>();
  for (const wanted of excluded) {
    const index = advertised.findIndex((actual, candidate) => !used.has(candidate) && tokenSimilar(wanted, actual));
    if (index === -1) return false;
    used.add(index);
  }
  return true;
}

/** Returns the user's entry that matched the advertised employer, or null. */
export function matchingExcludedCompany(company: string, exclusions: readonly string[]): string | null {
  const advertised = companyTokens(company);
  for (const raw of exclusions) {
    const excluded = companyTokens(raw);
    if (companyNamesMatch(excluded, advertised)) return raw;
  }
  return null;
}
