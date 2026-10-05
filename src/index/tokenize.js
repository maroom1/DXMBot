// Shared analyzer for documents and queries: lowercase, accent-fold, Unicode
// letter/digit runs, English stopwords removed, light stemming (Porter step 1:
// plural s/es/ies, -ed, -ing, trailing y).

export const STOPWORDS = new Set(
  (
    'a about above after again against all am an and any are aren as at be because been before being below ' +
    'between both but by can cannot could couldn did didn do does doesn doing don down during each few for from ' +
    'further had hadn has hasn have haven having he her here hers herself him himself his how i if in into is ' +
    'isn it its itself just let ll me more most mustn my myself no nor not now of off on once only or other ought ' +
    'our ours ourselves out over own re s same shan she should shouldn so some such t than that the their theirs ' +
    'them themselves then there these they this those through to too under until up us ve very was wasn we were ' +
    'weren what when where which while who whom why will with won would wouldn you your yours yourself yourselves'
  ).split(' '),
);

const MAX_TOKEN_LENGTH = 64;
const TOKEN_RE = /\p{N}+(?:\.\p{N}+)+|[\p{L}\p{N}]+/gu;

function isConsonant(w, i) {
  const c = w[i];
  if (c === 'a' || c === 'e' || c === 'i' || c === 'o' || c === 'u') return false;
  if (c === 'y') return i === 0 ? true : !isConsonant(w, i - 1);
  return true;
}

// Porter's m: the number of vowel→consonant transitions in the stem.
function measure(stem) {
  let m = 0;
  let i = 0;
  const n = stem.length;
  while (i < n && isConsonant(stem, i)) i++;
  while (i < n) {
    while (i < n && !isConsonant(stem, i)) i++;
    if (i >= n) break;
    while (i < n && isConsonant(stem, i)) i++;
    m++;
  }
  return m;
}

function hasVowel(stem) {
  for (let i = 0; i < stem.length; i++) if (!isConsonant(stem, i)) return true;
  return false;
}

function endsDoubleConsonant(w) {
  const n = w.length;
  return n >= 2 && w[n - 1] === w[n - 2] && isConsonant(w, n - 1);
}

function endsCvc(w) {
  const n = w.length;
  return (
    n >= 3 && isConsonant(w, n - 3) && !isConsonant(w, n - 2) && isConsonant(w, n - 1) && !'wxy'.includes(w[n - 1])
  );
}

export function stem(word) {
  let w = word;
  if (w.length <= 3 || !/^[a-z]+$/.test(w)) return w;

  // Step 1a: plurals.
  if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('ies')) w = w.slice(0, -2);
  else if (/(?:x|ch|sh|zz)es$/.test(w)) w = w.slice(0, -2); // boxes, watches, wishes, buzzes
  else if (!w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is') && w.endsWith('s')) w = w.slice(0, -1);

  // Step 1b: -eed / -ed / -ing.
  let stripped = false;
  if (w.endsWith('eed')) {
    if (measure(w.slice(0, -3)) > 0) w = w.slice(0, -1);
  } else if (w.endsWith('ed') && hasVowel(w.slice(0, -2))) {
    w = w.slice(0, -2);
    stripped = true;
  } else if (w.endsWith('ing') && hasVowel(w.slice(0, -3))) {
    w = w.slice(0, -3);
    stripped = true;
  }
  if (stripped) {
    if (w.endsWith('at') || w.endsWith('bl') || w.endsWith('iz')) w += 'e';
    else if (endsDoubleConsonant(w) && !/[lsz]$/.test(w)) w = w.slice(0, -1);
    else if (measure(w) === 1 && endsCvc(w)) w += 'e';
  }

  // Step 1c: terminal y → i when the stem has a vowel (happy/happiness, battery/batteries).
  if (w.endsWith('y') && w.length > 3 && hasVowel(w.slice(0, -1))) w = `${w.slice(0, -1)}i`;
  return w;
}

function fold(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/(\p{L})['\u{2019}]s(?![\p{L}\p{N}])/gu, '$1') // possessive: "northwind's" → "northwind"
    .replace(/(\p{L})['\u{2019}](?=\p{L})/gu, '$1'); // contractions: "don't" → "dont"
}

export function tokenize(text) {
  const out = [];
  const folded = fold(text);
  for (const m of folded.matchAll(TOKEN_RE)) {
    const word = m[0];
    if (word.length > MAX_TOKEN_LENGTH || STOPWORDS.has(word)) continue;
    out.push(stem(word));
  }
  return out;
}

// Distinct terms in first-seen order (handy for query processing).
export function uniqueTerms(text) {
  return [...new Set(tokenize(text))];
}
