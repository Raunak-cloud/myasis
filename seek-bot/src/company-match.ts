const COMPANY_SUFFIXES = new Set([
  'company', 'co', 'corp', 'corporation',
  'inc', 'incorporated', 'limited', 'ltd', 'llc', 'plc', 'pty',
]);

/** Normalised words used for full-name equality and nonbinding research proposals. */
function companyTokens(value: string): string[] {
  const words = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .match(/[a-z0-9]+/g) ?? [];

  while (words.length && COMPANY_SUFFIXES.has(words[words.length - 1])) words.pop();
  return words;
}

function acronym(tokens: readonly string[]): string {
  return tokens.filter(token=>!['and','of','the'].includes(token)).map((token) => token[0] ?? '').join('');
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
  // A shared prefix must not erase a short brand's distinctive ending:
  // "CyberCX" and the generic word "Cyber" score highly in Jaro-Winkler.
  if (Math.min(left.length, right.length) < 8 && Math.abs(left.length - right.length) > 1) return false;
  return jaroWinkler(left, right) >= 0.93;
}

/** Only full canonical equality can exclude before reasoning. A substring,
 * acronym, parent brand or typo is an identity question, never a match. */
export function matchingExcludedCompany(company: string, exclusions: readonly string[]): string | null {
  const advertised = companyTokens(company).join('');
  if (!advertised) return null;
  return exclusions.find(raw => companyTokens(raw).join('') === advertised) ?? null;
}

/** Search proposals only. Every decision about these pairs belongs to the
 * evidence-grounded reviewer; similarity never authorizes an exclusion. */
export function possibleExcludedCompanies(company: string, exclusions: readonly string[]): string[] {
  const advertised = companyTokens(company);
  return exclusions.filter(raw => {
    const excluded = companyTokens(raw);
    if (!excluded.length || !advertised.length) return false;
    return (excluded.length===1&&advertised.length===1&&Math.max(excluded[0].length,advertised[0].length)<=4)
      || tokensAppearTogether(excluded, advertised) || tokensAppearTogether(advertised, excluded)
      || acronym(excluded) === advertised.join('') || acronym(advertised) === excluded.join('')
      || jaroWinkler(excluded.join(''), advertised.join('')) >= 0.8
      || excluded.some(word => advertised.some(other => tokenSimilar(word, other)));
  });
}
