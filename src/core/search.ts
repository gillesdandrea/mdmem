/**
 * Ranked term search over a store's memories, with Claude Code 2.1.311's lexical
 * recall rules (mdmem-02l.43): four fields per memory, a tokenizer that folds case
 * and accents and splits compounds, Porter stemming, BM25F with a phrase boost, and
 * quoted text as a required phrase. mdmem's deviations are decided on mdmem-at1.3 and
 * mdmem-at1.4: a fixed English and French stop list applied to the query, frontmatter
 * values indexed without their keys (mdmem-02l.52: a key such as type, which every
 * memory holds, made every memory a hit for TypeScript), and the relevance floor
 * and a result limit as options, which a search leaves off and the per-prompt hook
 * turns on. Pure: it reads no file and keeps no index between calls (no cache is
 * needed at any store size, mdmem-at1.9).
 */

/** A document to search: its file name in the store and its raw text. */
export interface SearchDocument {
  file: string;
  raw: string;
}

/** A document the query matches, and its score: higher is a better match. */
export interface RankedHit<T extends SearchDocument> {
  document: T;
  score: number;
}

export interface SearchOptions {
  /** Ignore the query's function words (the stop list); a quoted phrase keeps them. */
  stopWords?: boolean;
  /** Drop a hit scoring under the relevance floor, at every store size. */
  floor?: boolean;
  /** Keep at most this many hits, best first; none when it is 0 or less. */
  limit?: number;
}

// --- Porter stemmer (1980) ---

const VOWELS = "aeiou";
/** Consonants after which step 1b's and step 5a's c-v-c rule does not apply. */
const CVC_EXCEPTIONS = "wxy";
/** Consonants step 1b keeps doubled. */
const KEPT_DOUBLES = "lsz";
/** A word this short is left as it is. */
const PORTER_MAX_UNSTEMMED_LENGTH = 2;
const VC_RUN_RE = /v+c+/gu;

/** Whether `word[i]` is a consonant; a y is one at the start or after a vowel. */
function isConsonant(word: string, i: number): boolean {
  const char = word.charAt(i);
  if (VOWELS.includes(char)) {
    return false;
  }
  return char !== "y" || i === 0 || !isConsonant(word, i - 1);
}

/** `word` as a string of c (consonant) and v (vowel), one letter per letter. */
function cvForm(word: string): string {
  let form = "";
  for (let i = 0; i < word.length; i += 1) {
    form += isConsonant(word, i) ? "c" : "v";
  }
  return form;
}

/** Porter's m: the number of vowel-consonant runs in [C](VC)^m[V]. */
function measure(word: string): number {
  return cvForm(word).match(VC_RUN_RE)?.length ?? 0;
}

function hasVowel(word: string): boolean {
  return cvForm(word).includes("v");
}

function endsWithDoubleConsonant(word: string): boolean {
  return (
    word.length >= 2 &&
    word.at(-1) === word.at(-2) &&
    isConsonant(word, word.length - 1)
  );
}

/** Whether `word` ends consonant, vowel, consonant, the last not w, x or y. */
function endsWithCvc(word: string): boolean {
  return (
    cvForm(word).endsWith("cvc") && !CVC_EXCEPTIONS.includes(word.at(-1) ?? "")
  );
}

/** `word` without `suffix`, or undefined when it does not end with it. */
function stripSuffix(word: string, suffix: string): string | undefined {
  return word.endsWith(suffix) ? word.slice(0, -suffix.length) : undefined;
}

function step1a(word: string): string {
  if (word.endsWith("sses") || word.endsWith("ies")) {
    return word.slice(0, -2);
  }
  if (word.endsWith("s") && !word.endsWith("ss")) {
    return word.slice(0, -1);
  }
  return word;
}

/** `word` without `suffix` when what is left holds a vowel. */
function stemWithVowel(word: string, suffix: string): string | undefined {
  const stem = stripSuffix(word, suffix);
  return stem !== undefined && hasVowel(stem) ? stem : undefined;
}

/** Step 1b's repair of a stem that lost -ed or -ing: hop(p)ing → hop, fil(e)ing → file. */
function repairStep1b(stem: string): string {
  if (stem.endsWith("at") || stem.endsWith("bl") || stem.endsWith("iz")) {
    return `${stem}e`;
  }
  if (
    endsWithDoubleConsonant(stem) &&
    !KEPT_DOUBLES.includes(stem.at(-1) ?? "")
  ) {
    return stem.slice(0, -1);
  }
  if (measure(stem) === 1 && endsWithCvc(stem)) {
    return `${stem}e`;
  }
  return stem;
}

function step1b(word: string): string {
  const eedStem = stripSuffix(word, "eed");
  if (eedStem !== undefined) {
    return measure(eedStem) > 0 ? word.slice(0, -1) : word;
  }
  const stem = stemWithVowel(word, "ed") ?? stemWithVowel(word, "ing");
  return stem === undefined ? word : repairStep1b(stem);
}

function step1c(word: string): string {
  const stem = stripSuffix(word, "y");
  return stem !== undefined && hasVowel(stem) ? `${stem}i` : word;
}

const STEP2_SUFFIXES = [
  ["ational", "ate"],
  ["tional", "tion"],
  ["enci", "ence"],
  ["anci", "ance"],
  ["izer", "ize"],
  ["abli", "able"],
  ["bli", "ble"],
  ["alli", "al"],
  ["entli", "ent"],
  ["eli", "e"],
  ["ousli", "ous"],
  ["ization", "ize"],
  ["ation", "ate"],
  ["ator", "ate"],
  ["alism", "al"],
  ["iveness", "ive"],
  ["fulness", "ful"],
  ["ousness", "ous"],
  ["aliti", "al"],
  ["iviti", "ive"],
  ["biliti", "ble"],
  ["logi", "log"],
] as const;

const STEP3_SUFFIXES = [
  ["icate", "ic"],
  ["ative", ""],
  ["alize", "al"],
  ["iciti", "ic"],
  ["ical", "ic"],
  ["ful", ""],
  ["ness", ""],
] as const;

const STEP4_SUFFIXES = [
  "al",
  "ance",
  "ence",
  "er",
  "ic",
  "able",
  "ible",
  "ant",
  "ement",
  "ment",
  "ent",
  "ion",
  "ou",
  "ism",
  "ate",
  "iti",
  "ous",
  "ive",
  "ize",
] as const;

/** Steps 2 and 3: the first suffix of `rules` that `word` ends with is replaced when the stem's m is above 0. */
function replaceSuffix(
  word: string,
  rules: readonly (readonly [string, string])[]
): string {
  for (const [suffix, replacement] of rules) {
    const stem = stripSuffix(word, suffix);
    if (stem !== undefined) {
      return measure(stem) > 0 ? stem + replacement : word;
    }
  }
  return word;
}

function step4(word: string): string {
  for (const suffix of STEP4_SUFFIXES) {
    const stem = stripSuffix(word, suffix);
    if (stem !== undefined) {
      const ionAllowed =
        suffix !== "ion" || stem.endsWith("s") || stem.endsWith("t");
      return measure(stem) > 1 && ionAllowed ? stem : word;
    }
  }
  return word;
}

function step5a(word: string): string {
  const stem = stripSuffix(word, "e");
  if (stem === undefined) {
    return word;
  }
  const m = measure(stem);
  return m > 1 || (m === 1 && !endsWithCvc(stem)) ? stem : word;
}

function step5b(word: string): string {
  return measure(word) > 1 &&
    endsWithDoubleConsonant(word) &&
    word.endsWith("l")
    ? word.slice(0, -1)
    : word;
}

/** The Porter (1980) stem of a lowercase ASCII word. */
export function porterStem(word: string): string {
  if (word.length <= PORTER_MAX_UNSTEMMED_LENGTH) {
    return word;
  }
  let stem = step1c(step1b(step1a(word)));
  stem = replaceSuffix(stem, STEP2_SUFFIXES);
  stem = replaceSuffix(stem, STEP3_SUFFIXES);
  return step5b(step5a(step4(stem)));
}

// --- Stop list ---

/**
 * English and French function words, as the tokenizer folds them (été is ete): what
 * a query's words are matched against before stemming. Memories are short, one fact
 * each, so these words are rare enough in a store to score, unlike in long documents.
 */
const STOP_WORDS: ReadonlySet<string> = new Set(
  [
    // English: articles, pronouns, determiners
    "an the this that these those it its they them their theirs i me my mine we us our ours you your yours he him his she her hers who whom whose which what",
    // English: auxiliaries and modals
    "am is are was were be been being have has had having do does did doing will would shall should can could may might must",
    // English: prepositions
    "of in at by for from to into onto with without about above below over under after before between through during up down out off",
    // English: conjunctions and adverbs
    "and or but nor so yet if then than as when where why how there here not no just also very too all any some each such only own same other more most",
    // French: articles, determiners, pronouns
    "le la les un une des du au aux ce cet cette ces se sa son ses ma mon mes ta ton tes notre nos votre vos leur leurs je tu il elle on nous vous ils elles te lui moi toi eux en",
    // French: conjunctions, relatives, prepositions, adverbs
    "et ou mais donc car ni que qui quoi dont de dans sur sous pour par avec sans chez vers entre comme si ne pas plus tres aussi ca",
    // French: etre and avoir
    "est sont etre ete etait suis es sommes etes avons avez ont avait",
  ]
    .join(" ")
    .split(" ")
);

// --- Tokenizer ---

const MIN_TOKEN_LENGTH = 2;
const LINK_RE = /\[\[(?<target>[^[\]]*)\]\]/gu;
/** Before a rewrite: the start or a character that is no letter or digit. */
const BEFORE = String.raw`(?<before>^|[^\p{L}\p{N}])`;
/** After a rewrite: no letter or digit follows. */
const AFTER = String.raw`(?![\p{L}\p{N}])`;
const LANGUAGE_REWRITES = [
  [new RegExp(`${BEFORE}[cC]\\+\\+${AFTER}`, "gu"), "cpp"],
  [new RegExp(`${BEFORE}[cC]#${AFTER}`, "gu"), "csharp"],
  [new RegExp(`${BEFORE}[fF]#${AFTER}`, "gu"), "fsharp"],
  [new RegExp(`${BEFORE}\\.[nN][eE][tT]${AFTER}`, "gu"), "dotnet"],
] as const;
const VERSION_RE = new RegExp(
  `${BEFORE}(?<version>[vV]?\\d+(?:\\.\\d+)+)`,
  "gu"
);
/** A version with its dots (2.1.306, v1.2), or a run of letters, marks and digits. */
const WORD_RE = /[vV]?\d+(?:\.\d+)+|[\p{L}\p{M}\p{N}]+/gu;
const COMBINING_MARK_RE = /[\u0300-\u036F]/gu;
const ASCII_WORD_RE = /^[a-z]+$/u;
const UPPER_RE = /[A-Z]/u;
const LOWER_RE = /[a-z]/u;
const DIGIT_RE = /\d/u;
const LETTER_RE = /[A-Za-z]/u;

/** `text` with accents folded (NFKD, combining marks removed) and lowercased. */
function fold(text: string): string {
  return text.normalize("NFKD").replaceAll(COMBINING_MARK_RE, "").toLowerCase();
}

/** Whether a compound splits between `token[i - 1]` and `token[i]`. */
function isCompoundBoundary(token: string, i: number): boolean {
  const previous = token.charAt(i - 1);
  const current = token.charAt(i);
  const next = token.charAt(i + 1);
  const pluralEnd = next === "s" && i + 2 === token.length;
  return (
    // camelCase, or a digit then a capital: autoMemory, v2Api
    ((LOWER_RE.test(previous) || DIGIT_RE.test(previous)) &&
      UPPER_RE.test(current)) ||
    // the last capital of an acronym before a word: HTMLParser, but not URLs
    (UPPER_RE.test(previous) &&
      UPPER_RE.test(current) &&
      LOWER_RE.test(next) &&
      !pluralEnd) ||
    // letters then digits, or digits then letters: utf8, 3d
    (LETTER_RE.test(previous) && DIGIT_RE.test(current)) ||
    (DIGIT_RE.test(previous) && LETTER_RE.test(current))
  );
}

/** The parts of a compound word (autoMemoryEnabled: auto, Memory, Enabled), or the word alone. */
function compoundParts(token: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 1; i < token.length; i += 1) {
    if (isCompoundBoundary(token, i)) {
      parts.push(token.slice(start, i));
      start = i;
    }
  }
  parts.push(token.slice(start));
  return parts;
}

/** A text's words before folding: links unbracketed, languages and versions rewritten. */
function rawWords(text: string): string[] {
  let normalized = text.replaceAll(LINK_RE, " $<target> ");
  for (const [pattern, name] of LANGUAGE_REWRITES) {
    normalized = normalized.replaceAll(pattern, `$<before> ${name} `);
  }
  // A version keeps its dotted form (WORD_RE reads it whole) and gains its digits
  // run together: 2.1.306 21306.
  normalized = normalized.replaceAll(
    VERSION_RE,
    (_match: string, before: string, version: string) =>
      `${before}${version} ${version.replaceAll(".", "")}`
  );
  return normalized.match(WORD_RE) ?? [];
}

interface TokenizeOptions {
  /** A query: an ASCII word gives its stem and itself, where a document gives its stem only. */
  dualStem?: boolean;
  /** When every word is one character, keep them all rather than none. */
  singleCharFallback?: boolean;
  /** Folded words to drop before stemming. */
  skip?: ReadonlySet<string>;
}

/** A token and its position in the text: the number of its word, so every token a word gives shares it. */
interface Token {
  term: string;
  position: number;
  /** A part of a compound word, not a word of its own. */
  part: boolean;
}

/**
 * The tokens one word gives, all at the word's `position`: a compound's whole and its
 * parts (TypeScript: typescript, type and script), so a phrase lines up word by word
 * whether a compound is written camelCase or lowercase.
 */
function wordTokens(
  word: string,
  { dualStem = false, skip }: TokenizeOptions,
  position: number
): Token[] {
  const parts = compoundParts(word);
  const isCompound = parts.length > 1;
  const tokens: Token[] = [];
  if (isCompound) {
    const whole = fold(word);
    if (!skip?.has(whole)) {
      tokens.push({ term: whole, position, part: false });
      const stem =
        dualStem && ASCII_WORD_RE.test(whole) ? porterStem(whole) : whole;
      if (stem !== whole) {
        tokens.push({ term: stem, position, part: false });
      }
    }
  }
  for (const part of parts) {
    const token = fold(part);
    if (token.length < MIN_TOKEN_LENGTH || skip?.has(token)) {
      continue;
    }
    const stem = ASCII_WORD_RE.test(token) ? porterStem(token) : token;
    tokens.push({ term: stem, position, part: isCompound });
    if (dualStem && stem !== token) {
      tokens.push({ term: token, position, part: isCompound });
    }
  }
  return tokens.filter(({ term }) => term.length >= MIN_TOKEN_LENGTH);
}

/** The tokens of `text`, in order, with their positions, as the index and the query read them. */
function positionedTokens(
  text: string,
  options: TokenizeOptions = {}
): Token[] {
  const words = rawWords(text);
  const tokens: Token[] = [];
  let position = 0;
  for (const word of words) {
    const wordTokensAt = wordTokens(word, options, position);
    tokens.push(...wordTokensAt);
    position += wordTokensAt.length > 0 ? 1 : 0;
  }
  const allSingleChars = words.every(
    (word) => fold(word).length < MIN_TOKEN_LENGTH
  );
  if (tokens.length > 0 || !options.singleCharFallback || !allSingleChars) {
    return tokens;
  }
  return words
    .map(fold)
    .filter((word) => !options.skip?.has(word))
    .map((term, i) => ({ term, position: i, part: false }));
}

/** The terms of `text`, in order, without their positions. */
function tokenize(text: string, options: TokenizeOptions = {}): string[] {
  return positionedTokens(text, options).map(({ term }) => term);
}

/**
 * One word of a phrase, as the terms a document may hold at the word's position. A
 * compound has `wholes`, its raw and stemmed forms, and holds where a word is one of
 * them or where one word's parts are all its `parts`; a plain word has one part and
 * holds where a word is that part, never where it is only a compound's part.
 */
interface PhraseWord {
  wholes: string[];
  parts: string[][];
}

/** The words of `text` as a phrase to find, word by word; a word with no term is left out. */
function phraseWords(text: string): PhraseWord[] {
  const words: PhraseWord[] = [];
  for (const word of rawWords(text)) {
    const forms = (token: string) => [
      ...new Set([
        ASCII_WORD_RE.test(token) ? porterStem(token) : token,
        token,
      ]),
    ];
    const split = compoundParts(word);
    const whole = fold(word);
    const wholes =
      split.length > 1 && whole.length >= MIN_TOKEN_LENGTH ? forms(whole) : [];
    const parts = split
      .map(fold)
      .filter((part) => part.length >= MIN_TOKEN_LENGTH)
      .map(forms);
    if (wholes.length > 0 || parts.length > 0) {
      words.push({ wholes, parts });
    }
  }
  return words;
}

/** A phrase's terms for its boost: each word's parts, stemmed, or its whole where it has no part. */
function phraseTerms(phrase: readonly PhraseWord[]): string[] {
  return phrase.flatMap(({ wholes, parts }) =>
    parts.length > 0 ? parts.map(([stem = ""]) => stem) : wholes.slice(0, 1)
  );
}

// --- Fields and index ---

const FIELDS = ["filename", "frontmatter", "headings", "body"] as const;
type Field = (typeof FIELDS)[number];

/** BM25F's weight of a match in each field: a memory's name and description count most. */
const FIELD_WEIGHTS: Readonly<Record<Field, number>> = {
  filename: 3,
  frontmatter: 3,
  headings: 2.5,
  body: 1,
};
/** BM25's term-frequency saturation. */
const BM25_K1 = 1.2;
/** BM25's length normalization, the same for every field. */
const BM25_B = 0.75;
/** The share of its terms' IDF a document gains when it holds the query's words in a row. */
const PHRASE_BOOST = 0.5;
/** The relevance floor, as a share of the IDF of a term only one memory holds. */
const FLOOR_FACTOR = 0.7;
/** The IDF of a term in half the memories or more: almost nothing, never zero. */
const MIN_IDF = 1e-6;
/** BM25's smoothing of the document counts in the IDF. */
const IDF_SMOOTHING = 0.5;

const FRONTMATTER_RE =
  /^---[ \t]*\r?\n(?<yaml>[\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u;
const HEADING_RE = /^#{1,6}\s+(?<title>.*)$/u;
/** A YAML key opening a frontmatter line: `name: `, `  type: `, `metadata:`. */
const FRONTMATTER_KEY_RE = /^[ \t]*[\w-]+:(?:[ \t]+|$)/u;
const LINE_BREAK_RE = /\r?\n/u;
const MD_EXTENSION_RE = /\.md$/u;

const INDENT_RE = /^[ \t]*/u;

/**
 * A frontmatter's text without the key opening each key line: its values alone. A
 * line indented under a key that has a value (a block scalar, a wrapped string)
 * continues that value and is kept whole; under a key with no value (metadata:) the
 * lines are nested keys.
 */
function frontmatterValues(yaml: string): string {
  let valueIndent: number | undefined;
  const values: string[] = [];
  for (const line of yaml.split(LINE_BREAK_RE)) {
    const indent = INDENT_RE.exec(line)?.[0].length ?? 0;
    const continues =
      valueIndent !== undefined && (line.trim() === "" || indent > valueIndent);
    if (continues) {
      values.push(line);
      continue;
    }
    const key = FRONTMATTER_KEY_RE.exec(line)?.[0];
    if (key === undefined) {
      valueIndent = undefined;
      values.push(line);
      continue;
    }
    const value = line.slice(key.length);
    valueIndent = value.trim() === "" ? undefined : indent;
    values.push(value);
  }
  return values.join("\n");
}

/** A memory's four fields as tokens: its file name, its frontmatter's values, its headings and the rest. */
function fieldsOf(file: string, raw: string): Record<Field, Token[]> {
  const frontmatter = FRONTMATTER_RE.exec(raw);
  const rest = frontmatter ? raw.slice(frontmatter[0].length) : raw;
  const headings: string[] = [];
  const body: string[] = [];
  for (const line of rest.split(LINE_BREAK_RE)) {
    const heading = HEADING_RE.exec(line)?.groups?.title;
    if (heading === undefined) {
      body.push(line);
    } else {
      headings.push(heading);
    }
  }
  const short = { singleCharFallback: true };
  return {
    filename: positionedTokens(file.replace(MD_EXTENSION_RE, ""), short),
    frontmatter: positionedTokens(
      frontmatterValues(frontmatter?.groups?.yaml ?? ""),
      short
    ),
    headings: positionedTokens(headings.join("\n")),
    body: positionedTokens(body.join("\n")),
  };
}

/** Where a term occurs in one document: its positions in each field. */
interface Postings {
  /** Where the term is a word, or a compound's whole. */
  words: Record<Field, number[]>;
  /** Where the term is a part of a compound word. */
  parts: Record<Field, number[]>;
}

interface SearchIndex {
  /** Each document's field lengths, in tokens. */
  lengths: Record<Field, number>[];
  /** Each field's average length over the documents where it is not empty. */
  averages: Record<Field, number>;
  /** Each term's postings, by document number. */
  terms: Map<string, Map<number, Postings>>;
}

function emptyPostings(): Postings {
  return {
    words: { filename: [], frontmatter: [], headings: [], body: [] },
    parts: { filename: [], frontmatter: [], headings: [], body: [] },
  };
}

function buildIndex(documents: readonly SearchDocument[]): SearchIndex {
  const index: SearchIndex = {
    lengths: [],
    averages: { filename: 0, frontmatter: 0, headings: 0, body: 0 },
    terms: new Map(),
  };
  const totals = { filename: 0, frontmatter: 0, headings: 0, body: 0 };
  const nonEmpty = { filename: 0, frontmatter: 0, headings: 0, body: 0 };
  for (const [id, { file, raw }] of documents.entries()) {
    const fields = fieldsOf(file, raw);
    const lengths = { filename: 0, frontmatter: 0, headings: 0, body: 0 };
    for (const field of FIELDS) {
      const tokens = fields[field];
      lengths[field] = tokens.length;
      totals[field] += tokens.length;
      nonEmpty[field] += tokens.length > 0 ? 1 : 0;
      for (const { term, position, part } of tokens) {
        const byDocument = index.terms.get(term) ?? new Map<number, Postings>();
        index.terms.set(term, byDocument);
        const postings = byDocument.get(id) ?? emptyPostings();
        byDocument.set(id, postings);
        (part ? postings.parts : postings.words)[field].push(position);
      }
    }
    index.lengths.push(lengths);
  }
  for (const field of FIELDS) {
    index.averages[field] =
      nonEmpty[field] > 0 ? totals[field] / nonEmpty[field] : 0;
  }
  return index;
}

/** Claude's IDF: a term in half the documents or more is worth almost nothing. */
function idf(documentCount: number, documentFrequency: number): number {
  const value = Math.log(
    (documentCount - documentFrequency + IDF_SMOOTHING) /
      (documentFrequency + IDF_SMOOTHING)
  );
  return value > 0 ? value : MIN_IDF;
}

/** Whether document `id` holds `phrase`'s words at consecutive positions in one field. */
function hasPhrase(
  index: SearchIndex,
  id: number,
  phrase: readonly PhraseWord[]
): boolean {
  const [first] = phrase;
  if (!first) {
    return false;
  }
  const postingsOf = (term: string) => index.terms.get(term)?.get(id);
  return FIELDS.some((field) => {
    const isWordAt = (term: string, position: number) =>
      postingsOf(term)?.words[field].includes(position) ?? false;
    const isPartAt = (term: string, position: number) =>
      postingsOf(term)?.parts[field].includes(position) ?? false;
    const wordAt = ({ wholes, parts }: PhraseWord, position: number) => {
      if (wholes.length === 0) {
        return parts.some((forms) =>
          forms.some((term) => isWordAt(term, position))
        );
      }
      return (
        wholes.some((term) => isWordAt(term, position)) ||
        (parts.length > 0 &&
          parts.every((forms) =>
            forms.some((term) => isPartAt(term, position))
          ))
      );
    };
    const starts = new Set(
      [...first.wholes, ...first.parts.flat()].flatMap((term) => {
        const postings = postingsOf(term);
        return postings
          ? [...postings.words[field], ...postings.parts[field]]
          : [];
      })
    );
    return [...starts].some((start) =>
      phrase.every((word, i) => wordAt(word, start + i))
    );
  });
}

// --- Query and scoring ---

const QUOTE = '"';
const QUOTED_RE = /"(?<phrase>[^"]*)"/gu;

interface ParsedQuery {
  /** The distinct terms to score. */
  terms: string[];
  /** Quoted phrases, each required in a hit. */
  phrases: PhraseWord[][];
  /** The query's words in a row, boosting a document that holds them so. */
  run: PhraseWord[];
}

function parseQuery(query: string, stopWords: boolean): ParsedQuery {
  const quotesBalanced = query.split(QUOTE).length % 2 === 1;
  const quoted = quotesBalanced
    ? [...query.matchAll(QUOTED_RE)].map((match) => match.groups?.phrase ?? "")
    : [];
  // A phrase of one plain word is no phrase; one compound is: its parts in a row.
  const phrases = quoted
    .map(phraseWords)
    .filter((phrase) => phraseTerms(phrase).length > 1);
  // The stop list applies outside the quotes: a quoted word always counts.
  const unquoted = quotesBalanced ? query.replaceAll(QUOTED_RE, " ") : query;
  const terms = [
    ...tokenize(unquoted, {
      dualStem: true,
      singleCharFallback: true,
      skip: stopWords ? STOP_WORDS : undefined,
    }),
    ...quoted.flatMap((text) =>
      tokenize(text, { dualStem: true, singleCharFallback: true })
    ),
  ];
  return {
    terms: [...new Set(terms)],
    phrases,
    run: phraseWords(query),
  };
}

/** BM25F's weighted, length-normalized frequency of a term in one document. */
function weightedFrequency(
  index: SearchIndex,
  id: number,
  postings: Postings
): number {
  let frequency = 0;
  for (const field of FIELDS) {
    const count = postings.words[field].length + postings.parts[field].length;
    const average = index.averages[field];
    const length = index.lengths[id]?.[field] ?? 0;
    if (count > 0 && average > 0) {
      const normalization = 1 - BM25_B + (BM25_B * length) / average;
      frequency += (FIELD_WEIGHTS[field] * count) / normalization;
    }
  }
  return frequency;
}

/** The score of document `id`: each term's BM25F share, plus the phrase boost. */
function scoreOf(
  index: SearchIndex,
  id: number,
  { terms, run }: ParsedQuery,
  idfOf: (term: string) => number
): number {
  let score = 0;
  for (const term of terms) {
    const postings = index.terms.get(term)?.get(id);
    if (postings) {
      const frequency = weightedFrequency(index, id, postings);
      score += idfOf(term) * (frequency / (BM25_K1 + frequency));
    }
  }
  if (run.length > 1 && hasPhrase(index, id, run)) {
    score +=
      PHRASE_BOOST *
      phraseTerms(run).reduce((sum, term) => sum + idfOf(term), 0);
  }
  return score;
}

/** File-name order by code unit, the same on every machine: what breaks a tie in score. */
function byFile(a: SearchDocument, b: SearchDocument): number {
  if (a.file === b.file) {
    return 0;
  }
  return a.file < b.file ? -1 : 1;
}

/**
 * The documents matching `query`, best first, ties by file name. The query is any
 * text, a few words or a whole prompt: each word counts on its own, stemmed; quoted
 * text with balanced quotes is a phrase every hit must hold. Every hit with a positive
 * score is returned unless `options` sets the floor or a limit.
 */
export function rankDocuments<T extends SearchDocument>(
  documents: readonly T[],
  query: string,
  options: SearchOptions = {}
): RankedHit<T>[] {
  const parsed = parseQuery(query, options.stopWords ?? false);
  if (documents.length === 0 || parsed.terms.length === 0) {
    return [];
  }
  const index = buildIndex(documents);
  const idfOf = (term: string) =>
    idf(documents.length, index.terms.get(term)?.size ?? 0);
  const candidates = new Set(
    parsed.terms.flatMap((term) => [...(index.terms.get(term)?.keys() ?? [])])
  );
  const floor = options.floor
    ? FLOOR_FACTOR * idf(documents.length, 1)
    : Number.NEGATIVE_INFINITY;
  const hits: RankedHit<T>[] = [];
  for (const id of candidates) {
    const document = documents[id];
    const required = parsed.phrases.every((phrase) =>
      hasPhrase(index, id, phrase)
    );
    const score = required ? scoreOf(index, id, parsed, idfOf) : 0;
    if (document && score > 0 && score >= floor) {
      hits.push({ document, score });
    }
  }
  hits.sort((a, b) => b.score - a.score || byFile(a.document, b.document));
  return options.limit === undefined
    ? hits
    : hits.slice(0, Math.max(0, options.limit));
}
