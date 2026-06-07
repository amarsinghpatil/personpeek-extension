/**
 * PersonPeek — Background Service Worker
 * ========================================
 * Handles all API communication (Wikipedia + Wikidata) on behalf of content
 * scripts and the popup.  Content scripts can't make cross-origin requests
 * reliably across all browsers, so every network call is proxied here.
 *
 * Supported message actions:
 *   lookupPerson   — search + fetch summary + optional Wikidata facts
 *   getRecentLookups — retrieve the 20 most-recent lookups from storage
 *   clearHistory   — wipe stored lookup history
 */

'use strict';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const USER_AGENT = 'PersonPeek/1.0 (Browser Extension)';
const MAX_HISTORY = 20;

const WIKIPEDIA_OPENSEARCH = 'https://en.wikipedia.org/w/api.php';
const WIKIPEDIA_SUMMARY   = 'https://en.wikipedia.org/api/rest_v1/page/summary';
const WIKIDATA_API         = 'https://www.wikidata.org/w/api.php';

/** Wikidata property IDs we care about */
const PROPS = {
  birthDate:    'P569',
  deathDate:    'P570',
  occupation:   'P106',
  nationality:  'P27',
  placeOfBirth: 'P19',
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Thin wrapper around fetch that injects our User-Agent header.
 * @param {string} url
 * @returns {Promise<Response>}
 */
async function apiFetch(url) {
  return fetch(url, {
    headers: { 'Api-User-Agent': USER_AGENT },
  });
}

/**
 * Extract a human-readable date string from a Wikidata time claim value.
 * Wikidata stores dates as "+YYYY-MM-DDT00:00:00Z".
 * @param {{ time: string, precision: number }} val
 * @returns {string}
 */
function parseWikidataDate(val) {
  if (!val?.time) return '';
  try {
    // Strip leading "+" and parse
    const raw = val.time.replace(/^\+/, '');
    const date = new Date(raw);
    if (isNaN(date.getTime())) return raw.split('T')[0];

    // precision 9 = year, 10 = month, 11 = day
    const options = { year: 'numeric' };
    if (val.precision >= 10) options.month = 'long';
    if (val.precision >= 11) options.day = 'numeric';
    return date.toLocaleDateString('en-US', options);
  } catch {
    return val.time;
  }
}

/**
 * Safely retrieve a property from an object, preventing prototype pollution.
 * @param {object} obj
 * @param {string} key
 * @returns {*}
 */
function safeGet(obj, key) {
  if (obj && key && Object.prototype.hasOwnProperty.call(obj, key)) {
    return Reflect.get(obj, key);
  }
  return undefined;
}

/**
 * Given an array of Wikidata claim objects for a property, return the first
 * "preferred" (or "normal") mainsnak value.
 * @param {Array} claims
 * @returns {object|null}
 */
function bestClaim(claims) {
  if (!claims?.length) return null;
  // Prefer rank=preferred, fall back to normal
  const rank = new Map([
    ['preferred', 0],
    ['normal', 1],
    ['deprecated', 2]
  ]);
  const sorted = [...claims].sort((a, b) => {
    const aRankVal = rank.has(a.rank) ? rank.get(a.rank) : 1;
    const bRankVal = rank.has(b.rank) ? rank.get(b.rank) : 1;
    return aRankVal - bRankVal;
  });
  return sorted[0]?.mainsnak?.datavalue?.value ?? null;
}

/**
 * Collect all entity QIDs referenced by the claims we care about so we can
 * batch-fetch their labels.
 * @param {object} claims  — entity.claims from Wikidata
 * @returns {string[]}
 */
function collectEntityIds(claims) {
  const ids = new Set();
  for (const prop of [PROPS.occupation, PROPS.nationality, PROPS.placeOfBirth]) {
    const list = safeGet(claims, prop);
    if (!list) continue;
    for (const claim of list) {
      const val = claim?.mainsnak?.datavalue?.value;
      if (val?.id) ids.add(val.id);
    }
  }
  return [...ids];
}

/* ------------------------------------------------------------------ */
/*  Wikipedia helpers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Use the OpenSearch API to find the best article title matching `name`.
 * Returns null when nothing is found.
 * @param {string} name
 * @returns {Promise<string|null>}
 */
async function searchWikipedia(name) {
  const params = new URLSearchParams({
    action: 'opensearch',
    search: name,
    limit: '5',
    namespace: '0',
    format: 'json',
    origin: '*',
  });

  const res = await apiFetch(`${WIKIPEDIA_OPENSEARCH}?${params}`);
  if (!res.ok) throw new Error(`OpenSearch failed: ${res.status}`);

  const data = await res.json();
  // OpenSearch returns [query, [titles], [descriptions], [urls]]
  const titles = data[1];
  if (!titles?.length) return null;

  // Prefer an exact (case-insensitive) match, else take first result
  const lowerName = name.toLowerCase();
  return (
    titles.find((t) => t.toLowerCase() === lowerName) ??
    titles.find((t) => t.toLowerCase().startsWith(lowerName)) ??
    titles[0]
  );
}

/**
 * Fetch the Wikipedia REST summary for a given article title.
 * @param {string} title
 * @returns {Promise<object>}
 */
async function fetchSummary(title) {
  const encoded = encodeURIComponent(title);
  const res = await apiFetch(`${WIKIPEDIA_SUMMARY}/${encoded}`);
  if (!res.ok) throw new Error(`Summary API failed: ${res.status}`);
  return res.json();
}

/* ------------------------------------------------------------------ */
/*  Wikidata helpers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Fetch structured facts from Wikidata for the given QID.
 * Returns an object like { birthDate, deathDate, occupation, nationality, placeOfBirth }.
 * @param {string} qid  e.g. "Q5"
 * @returns {Promise<object>}
 */
async function fetchWikidataFacts(qid) {
  const facts = {
    birthDate: '',
    deathDate: '',
    occupation: '',
    nationality: '',
    placeOfBirth: '',
  };

  // 1. Fetch the entity
  const entityParams = new URLSearchParams({
    action: 'wbgetentities',
    ids: qid,
    props: 'claims',
    format: 'json',
    origin: '*',
  });

  const entityRes = await apiFetch(`${WIKIDATA_API}?${entityParams}`);
  if (!entityRes.ok) return facts;

  const entityData = await entityRes.json();
  const entity = safeGet(entityData?.entities, qid);
  if (!entity?.claims) return facts;

  const claims = entity.claims;

  // 2. Parse date properties directly (they are time values, not entities)
  const birthVal = bestClaim(safeGet(claims, PROPS.birthDate));
  if (birthVal) facts.birthDate = parseWikidataDate(birthVal);

  const deathVal = bestClaim(safeGet(claims, PROPS.deathDate));
  if (deathVal) facts.deathDate = parseWikidataDate(deathVal);

  // 3. Collect entity IDs for occupation, nationality, place of birth
  const entityIds = collectEntityIds(claims);

  if (entityIds.length > 0) {
    // Batch-fetch labels (max 50 per call — we'll never hit that)
    const labelParams = new URLSearchParams({
      action: 'wbgetentities',
      ids: entityIds.join('|'),
      props: 'labels',
      languages: 'en',
      format: 'json',
      origin: '*',
    });

    const labelRes = await apiFetch(`${WIKIDATA_API}?${labelParams}`);
    if (labelRes.ok) {
      const labelData = await labelRes.json();
      const entities = labelData?.entities ?? {};

      /** Resolve a single entity-valued claim to its English label */
      const label = (prop) => {
        const val = bestClaim(safeGet(claims, prop));
        if (!val?.id) return '';
        const entityVal = safeGet(entities, val.id);
        return entityVal?.labels?.en?.value ?? val.id;
      };

      /** Resolve ALL values for a property (e.g. multiple occupations) */
      const allLabels = (prop) => {
        const list = safeGet(claims, prop);
        if (!list?.length) return '';
        return list
          .map((c) => {
            const v = c?.mainsnak?.datavalue?.value;
            if (!v?.id) return null;
            const entityVal = safeGet(entities, v.id);
            return entityVal?.labels?.en?.value ?? null;
          })
          .filter(Boolean)
          .slice(0, 3) // keep it concise
          .join(', ');
      };

      facts.occupation   = allLabels(PROPS.occupation);
      facts.nationality  = label(PROPS.nationality);
      facts.placeOfBirth = label(PROPS.placeOfBirth);
    }
  }

  return facts;
}

/* ------------------------------------------------------------------ */
/*  Core lookup flow                                                   */
/* ------------------------------------------------------------------ */

/**
 * Full lookup pipeline: search → summary → wikidata facts.
 * @param {string} name
 * @returns {Promise<object>}
 */
async function lookupPerson(name) {
  // Step 1 — search for the best Wikipedia article
  const title = await searchWikipedia(name);
  if (!title) {
    return { error: `No Wikipedia article found for "${name}".` };
  }

  // Step 2 — fetch the article summary
  const summary = await fetchSummary(title);

  // We only want "standard" articles (not disambiguation, etc.)
  if (summary.type === 'disambiguation') {
    return { error: `"${name}" is a disambiguation page — try a more specific name.` };
  }

  // Step 3 — build the result object
  const result = {
    title:         summary.title ?? title,
    description:   summary.description ?? '',
    extract:       summary.extract ?? '',
    thumbnail:     summary.thumbnail?.source ?? '',
    image:         summary.originalimage?.source ?? '',
    wikibaseItem:  summary.wikibase_item ?? '',
    wikidataFacts: null,
    pageUrl:       summary.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
  };

  // Step 4 — optionally enrich with Wikidata
  if (result.wikibaseItem) {
    try {
      result.wikidataFacts = await fetchWikidataFacts(result.wikibaseItem);
    } catch (err) {
      console.warn('[PersonPeek] Wikidata fetch failed:', err.message);
      // Non-fatal — we still return the Wikipedia data
    }
  }

  // Step 5 — save to history
  await saveToHistory(result);

  return result;
}

/* ------------------------------------------------------------------ */
/*  History (chrome.storage.local)                                     */
/* ------------------------------------------------------------------ */

/**
 * Append a lookup result to the front of the recent history list.
 * Keeps at most MAX_HISTORY entries.
 * @param {object} entry
 */
async function saveToHistory(entry) {
  try {
    const { recentLookups = [] } = await chrome.storage.local.get('recentLookups');
    // De-duplicate by title
    const filtered = recentLookups.filter((e) => e.title !== entry.title);
    filtered.unshift({
      title:       entry.title,
      description: entry.description,
      thumbnail:   entry.thumbnail,
      pageUrl:     entry.pageUrl,
      timestamp:   Date.now(),
    });
    await chrome.storage.local.set({
      recentLookups: filtered.slice(0, MAX_HISTORY),
    });
  } catch (err) {
    console.warn('[PersonPeek] Failed to save history:', err.message);
  }
}

/**
 * Retrieve the recent lookups list.
 * @returns {Promise<Array>}
 */
async function getRecentLookups() {
  try {
    const { recentLookups = [] } = await chrome.storage.local.get('recentLookups');
    return recentLookups;
  } catch {
    return [];
  }
}

/**
 * Clear all stored lookup history.
 */
async function clearHistory() {
  await chrome.storage.local.remove('recentLookups');
}

/* ------------------------------------------------------------------ */
/*  Message listener                                                   */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const { action, name } = message;

  switch (action) {
    case 'lookupPerson':
      lookupPerson(name)
        .then(sendResponse)
        .catch((err) => {
          console.error('[PersonPeek] lookupPerson error:', err);
          sendResponse({ error: err.message || 'Lookup failed.' });
        });
      return true; // async response

    case 'getRecentLookups':
      getRecentLookups()
        .then(sendResponse)
        .catch(() => sendResponse([]));
      return true;

    case 'clearHistory':
    case 'clearRecentLookups':
      clearHistory()
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ error: err.message }));
      return true;

    default:
      // Unknown action — don't hold the channel open
      return false;
  }
});

/* Log startup */
console.log('[PersonPeek] Service worker started.');
