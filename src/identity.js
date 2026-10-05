// Cairn's public identity: one product family, three independently
// controllable roles (mirrors OAI-SearchBot / GPTBot / ChatGPT-User).
export const PRODUCT = 'Cairn';
export const VERSION = '1.0';
export const FAMILY_TOKEN = 'Cairn';

export const ROLES = {
  search: {
    id: 'search',
    token: 'CairnSearch',
    name: 'Search indexer',
    purpose: 'Discovers and indexes public pages so they can be surfaced, with citations, in Cairn answers.',
    trigger: 'Automatic crawl jobs',
    respectsRobots: true,
    ipFile: 'cairnsearch.json',
  },
  corpus: {
    id: 'corpus',
    token: 'CairnCorpus',
    name: 'Corpus collector',
    purpose: 'Collects pages into a local dataset (JSONL) for model evaluation or training. Disallowing it opts content out of datasets without affecting search.',
    trigger: 'Explicit corpus crawl jobs only',
    respectsRobots: true,
    ipFile: 'cairncorpus.json',
  },
  user: {
    id: 'user',
    token: 'Cairn-User',
    name: 'User-triggered fetcher',
    purpose: 'Fetches a specific page because a person asked a question or pasted a URL. Never used for automatic crawling.',
    trigger: 'A user action (Ask, Fetch inspector, research agent)',
    respectsRobots: true, // configurable via config.robots.respectForUserFetch
    ipFile: 'cairn-user.json',
  },
};

export const ROLE_IDS = Object.keys(ROLES);

export function getRole(role) {
  const r = ROLES[role];
  if (!r) throw new Error(`Unknown role "${role}" (expected one of ${ROLE_IDS.join(', ')})`);
  return r;
}

export function userAgent(role, publicBaseUrl) {
  const r = getRole(role);
  return `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ${r.token}/${VERSION}; +${publicBaseUrl}/bot`;
}

// robots.txt group-selection order: most specific first, then the family token.
export function robotsTokens(role) {
  return [getRole(role).token, FAMILY_TOKEN];
}
