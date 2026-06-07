/**
 * PersonPeek — Background Service Worker (TypeScript)
 * ===================================================
 * Handles all API communication (Wikipedia + Wikidata) on behalf of content
 * scripts and the popup. Content scripts can't make cross-origin requests
 * reliably across all browsers, so every network call is proxied here.
 *
 * Supported message actions:
 *   lookupPerson      — search + fetch summary + optional Wikidata facts
 *   getRecentLookups  — retrieve the 20 most-recent lookups from storage
 *   clearHistory      — wipe stored lookup history
 *   clearRecentLookups — wipe stored lookup history (alias)
 */

(() => {
  'use strict';

  /* ------------------------------------------------------------------ */
  /*  Interfaces                                                        */
  /* ------------------------------------------------------------------ */

  interface WikidataFacts {
    birthDate: string;
    deathDate: string;
    occupation: string;
    nationality: string;
    placeOfBirth: string;
  }

  interface SocialLinks {
    twitter: string;
    instagram: string;
    linkedin: string;
    youtube: string;
    facebook: string;
  }

  interface NewsItem {
    title: string;
    link: string;
    pubDate: string;
    source: string;
  }

  interface LookupResult {
    title: string;
    description: string;
    extract: string;
    thumbnail: string;
    image: string;
    wikibaseItem: string;
    wikidataFacts: WikidataFacts | null;
    socials: SocialLinks;
    news: NewsItem[];
    pageUrl: string;
    error?: string;
  }

  interface HistoryEntry {
    title: string;
    description: string;
    thumbnail: string;
    pageUrl: string;
    timestamp: number;
  }

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

  /** Wikidata property IDs for social profiles */
  const SOCIAL_PROPS = {
    twitter:   'P2002',
    instagram: 'P2003',
    linkedin:  'P4263',
    youtube:   'P2397',
    facebook:  'P2013',
  };

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Thin wrapper around fetch that injects our User-Agent header.
   * @param url The URL to fetch.
   */
  async function apiFetch(url: string): Promise<Response> {
    return fetch(url, {
      headers: { 'Api-User-Agent': USER_AGENT },
    });
  }

  /**
   * Extract a human-readable date string from a Wikidata time claim value.
   * Wikidata stores dates as "+YYYY-MM-DDT00:00:00Z".
   * @param val The Wikidata time value container.
   */
  function parseWikidataDate(val: { time: string; precision: number }): string {
    if (!val?.time) return '';
    try {
      // Strip leading "+" and parse
      const raw = val.time.replace(/^\+/, '');
      const date = new Date(raw);
      if (isNaN(date.getTime())) return raw.split('T')[0];

      // precision 9 = year, 10 = month, 11 = day
      const options: Intl.DateTimeFormatOptions = { year: 'numeric' };
      if (val.precision >= 10) options.month = 'long';
      if (val.precision >= 11) options.day = 'numeric';
      return date.toLocaleDateString('en-US', options);
    } catch {
      return val.time;
    }
  }

  /**
   * Safely retrieve a property from an object, preventing prototype pollution.
   * @param obj The source object.
   * @param key The key to retrieve.
   */
  function safeGet(obj: any, key: string): any {
    if (obj && key && Object.prototype.hasOwnProperty.call(obj, key)) {
      return Reflect.get(obj, key);
    }
    return undefined;
  }

  /**
   * Given an array of Wikidata claim objects for a property, return the first
   * "preferred" (or "normal") mainsnak value.
   * @param claims Array of claims.
   */
  function bestClaim(claims: any[] | undefined): any | null {
    if (!claims?.length) return null;
    // Prefer rank=preferred, fall back to normal
    const rank = new Map<string, number>([
      ['preferred', 0],
      ['normal', 1],
      ['deprecated', 2]
    ]);
    const sorted = [...claims].sort((a, b) => {
      const aRankVal = rank.has(a.rank) ? rank.get(a.rank)! : 1;
      const bRankVal = rank.has(b.rank) ? rank.get(b.rank)! : 1;
      return aRankVal - bRankVal;
    });
    return sorted[0]?.mainsnak?.datavalue?.value ?? null;
  }

  /**
   * Collect all entity QIDs referenced by the claims we care about so we can
   * batch-fetch their labels.
   * @param claims entity.claims from Wikidata.
   */
  function collectEntityIds(claims: any): string[] {
    const ids = new Set<string>();
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
   * @param name The search text.
   */
  async function searchWikipedia(name: string): Promise<string | null> {
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
    const titles: string[] = data[1];
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
   * @param title Canonical Wikipedia article title.
   */
  async function fetchSummary(title: string): Promise<any> {
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
   * Returns facts and social links.
   * @param qid Wikidata entity ID (QID).
   */
  async function fetchWikidataFacts(qid: string): Promise<{ wikidataFacts: WikidataFacts; socials: SocialLinks }> {
    const facts: WikidataFacts = {
      birthDate: '',
      deathDate: '',
      occupation: '',
      nationality: '',
      placeOfBirth: '',
    };

    const socials: SocialLinks = {
      twitter: '',
      instagram: '',
      linkedin: '',
      youtube: '',
      facebook: '',
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
    if (!entityRes.ok) return { wikidataFacts: facts, socials };

    const entityData = await entityRes.json();
    const entity = safeGet(entityData?.entities, qid);
    if (!entity?.claims) return { wikidataFacts: facts, socials };

    const claims = entity.claims;

    // 2. Parse date properties directly (they are time values, not entities)
    const birthVal = bestClaim(safeGet(claims, PROPS.birthDate));
    if (birthVal) facts.birthDate = parseWikidataDate(birthVal);

    const deathVal = bestClaim(safeGet(claims, PROPS.deathDate));
    if (deathVal) facts.deathDate = parseWikidataDate(deathVal);

    // 3. Collect entity IDs for occupation, nationality, place of birth
    const entityIds = collectEntityIds(claims);

    if (entityIds.length > 0) {
      // Batch-fetch labels (max 50 per call)
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
        const label = (prop: string): string => {
          const val = bestClaim(safeGet(claims, prop));
          if (!val?.id) return '';
          const entityVal = safeGet(entities, val.id);
          return entityVal?.labels?.en?.value ?? val.id;
        };

        /** Resolve ALL values for a property (e.g. multiple occupations) */
        const allLabels = (prop: string): string => {
          const list = safeGet(claims, prop);
          if (!list?.length) return '';
          return list
            .map((c: any) => {
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

    // 4. Extract social media links
    const extractSocial = (prop: string, baseUrl: string): string => {
      const val = bestClaim(safeGet(claims, prop));
      return val ? `${baseUrl}${val}` : '';
    };

    socials.twitter   = extractSocial(SOCIAL_PROPS.twitter, 'https://x.com/');
    socials.instagram = extractSocial(SOCIAL_PROPS.instagram, 'https://instagram.com/');
    socials.linkedin  = extractSocial(SOCIAL_PROPS.linkedin, 'https://linkedin.com/in/');
    socials.youtube   = extractSocial(SOCIAL_PROPS.youtube, 'https://youtube.com/channel/');
    socials.facebook  = extractSocial(SOCIAL_PROPS.facebook, 'https://facebook.com/');

    return { wikidataFacts: facts, socials };
  }

  /* ------------------------------------------------------------------ */
  /*  News helpers                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Parse XML feed from Google News RSS using regex.
   * Designed to run securely and fast in a service worker environment.
   * @param xmlText XML response payload.
   */
  function parseNewsRSS(xmlText: string): NewsItem[] {
    const items: NewsItem[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match: RegExpExecArray | null;
    while ((match = itemRegex.exec(xmlText)) !== null && items.length < 3) {
      const content = match[1];
      const titleMatch = content.match(/<title>([\s\S]*?)<\/title>/);
      const linkMatch = content.match(/<link>([\s\S]*?)<\/link>/);
      const pubDateMatch = content.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
      const sourceMatch = content.match(/<source[^>]*>([\s\S]*?)<\/source>/);

      if (titleMatch && linkMatch) {
        let title = titleMatch[1];
        let source = sourceMatch ? sourceMatch[1] : '';
        
        // Clean up XML entity encodings
        const decodeEntities = (str: string): string => {
          return str
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#039;/g, "'")
            .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
        };

        title = decodeEntities(title);
        source = decodeEntities(source);

        // Remove " - Source" suffix from title if present
        if (source && title.endsWith(` - ${source}`)) {
          title = title.substring(0, title.length - (source.length + 3));
        }

        // Parse date to clean format e.g. "Jun 7, 2026"
        let dateLabel = '';
        if (pubDateMatch) {
          const rawDate = decodeEntities(pubDateMatch[1]);
          try {
            const d = new Date(rawDate);
            if (!isNaN(d.getTime())) {
              dateLabel = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            } else {
              dateLabel = rawDate.split(' ')[0] + ' ' + rawDate.split(' ')[1];
            }
          } catch {
            dateLabel = rawDate;
          }
        }

        items.push({
          title: title.trim(),
          link: decodeEntities(linkMatch[1]).trim(),
          pubDate: dateLabel.trim(),
          source: source.trim()
        });
      }
    }
    return items;
  }

  /**
   * Fetch the latest news articles for the person using Google News RSS.
   * @param name The canonical name of the person.
   */
  async function fetchLatestNews(name: string): Promise<NewsItem[]> {
    try {
      const query = encodeURIComponent(name);
      const url = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;
      const res = await apiFetch(url);
      if (!res.ok) return [];
      const xmlText = await res.text();
      return parseNewsRSS(xmlText);
    } catch (err: any) {
      console.warn('[PersonPeek] News fetch failed:', err.message);
      return [];
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Core lookup flow                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Resolve ambiguous name to canonical person name using Gemini Flash API
   * @param name The highlighted word/phrase.
   * @param context Surrounding text.
   * @param apiKey Gemini Flash API Key.
   */
  async function resolveEntityName(name: string, context: string, apiKey: string): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
    
    const systemInstruction = 
      "You are a context-aware entity resolution assistant. Given a highlighted term and its surrounding context, " +
      "resolve the canonical name of the specific person being referred to. Output ONLY the resolved name, and nothing else. " +
      "If it is not a person or cannot be resolved, output the original term exactly as is. Output nothing else.";

    const prompt = `Term: "${name}"\nContext: "${context}"\nResolved Name:`;

    const requestBody = {
      contents: [
        {
          parts: [
            { text: systemInstruction },
            { text: prompt }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 20
      }
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      throw new Error(`Gemini API returned status ${response.status}`);
    }

    const data = await response.json();
    const candidateText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (candidateText) {
      return candidateText.trim();
    }
    return name;
  }

  /**
   * Full lookup pipeline: search → summary → wikidata facts + socials + news.
   * @param name Search query.
   * @param context Context surrounding the term.
   */
  async function lookupPerson(name: string, context?: string): Promise<LookupResult | { error: string }> {
    let searchName = name;
    if (context && name) {
      try {
        const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
        if (geminiApiKey && geminiApiKey.trim()) {
          const resolved = await resolveEntityName(name, context, geminiApiKey);
          if (resolved && resolved.trim()) {
            console.log(`[PersonPeek] Gemini resolved "${name}" in context to "${resolved}"`);
            searchName = resolved.trim();
          }
        }
      } catch (err: any) {
        console.warn('[PersonPeek] Gemini resolution failed, falling back:', err.message);
      }
    }

    // Step 1 — search for the best Wikipedia article
    const title = await searchWikipedia(searchName);
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
    const result: LookupResult = {
      title:         summary.title ?? title,
      description:   summary.description ?? '',
      extract:       summary.extract ?? '',
      thumbnail:     summary.thumbnail?.source ?? '',
      image:         summary.originalimage?.source ?? '',
      wikibaseItem:  summary.wikibase_item ?? '',
      wikidataFacts: null,
      socials: {
        twitter: '',
        instagram: '',
        linkedin: '',
        youtube: '',
        facebook: '',
      },
      news: [],
      pageUrl:       summary.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    };

    // Steps 4 & 5 — fetch Wikidata and latest news concurrently
    const wikidataPromise = result.wikibaseItem
      ? fetchWikidataFacts(result.wikibaseItem).catch((err: any) => {
          console.warn('[PersonPeek] Wikidata fetch failed:', err.message);
          return null;
        })
      : Promise.resolve(null);

    const newsPromise = fetchLatestNews(result.title).catch((err: any) => {
      console.warn('[PersonPeek] News fetch failed:', err.message);
      return [] as NewsItem[];
    });

    const [wikidataData, newsData] = await Promise.all([wikidataPromise, newsPromise]);

    if (wikidataData) {
      result.wikidataFacts = wikidataData.wikidataFacts;
      result.socials = wikidataData.socials;
    }
    result.news = newsData || [];

    // Step 6 — save to history
    await saveToHistory(result);

    return result;
  }

  /* ------------------------------------------------------------------ */
  /*  History (chrome.storage.local)                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Append a lookup result to the front of the recent history list.
   * Keeps at most MAX_HISTORY entries.
   * @param entry The lookup result object.
   */
  async function saveToHistory(entry: LookupResult): Promise<void> {
    try {
      const { recentLookups = [] } = await chrome.storage.local.get('recentLookups');
      // De-duplicate by title
      const filtered = (recentLookups as HistoryEntry[]).filter((e) => e.title !== entry.title);
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
    } catch (err: any) {
      console.warn('[PersonPeek] Failed to save history:', err.message);
    }
  }

  /**
   * Retrieve the recent lookups list.
   */
  async function getRecentLookups(): Promise<HistoryEntry[]> {
    try {
      const { recentLookups = [] } = await chrome.storage.local.get('recentLookups');
      return recentLookups as HistoryEntry[];
    } catch {
      return [];
    }
  }

  /**
   * Clear all stored lookup history.
   */
  async function clearHistory(): Promise<void> {
    await chrome.storage.local.remove('recentLookups');
  }

  /* ------------------------------------------------------------------ */
  /*  Message listener                                                   */
  /* ------------------------------------------------------------------ */

  chrome.runtime.onMessage.addListener((message: any, _sender: chrome.runtime.MessageSender, sendResponse: (response: any) => void) => {
    const { action, name, context } = message;

    switch (action) {
      case 'lookupPerson':
        lookupPerson(name, context)
          .then(sendResponse)
          .catch((err: any) => {
            console.error('[PersonPeek] lookupPerson error:', err);
            sendResponse({ error: err.message || 'Lookup failed.' });
          });
        return true; // async response

      case 'openPopupForPerson':
        chrome.storage.local.set({ activeLookupName: name, activeLookupContext: context || '' })
          .then(() => {
            if (chrome.action && chrome.action.openPopup) {
              return chrome.action.openPopup();
            }
          })
          .then(() => {
            sendResponse({ success: true });
          })
          .catch((err: any) => {
            console.error('[PersonPeek] Failed to open popup:', err);
            sendResponse({ error: err.message });
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
          .catch((err: any) => sendResponse({ error: err.message }));
        return true;

      default:
        return false;
    }
  });

  /* ------------------------------------------------------------------ */
  /*  Context Menus                                                     */
  /* ------------------------------------------------------------------ */

  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: "lookupInPersonPeek",
        title: "Look up \"%s\" in PersonPeek",
        contexts: ["selection"]
      });
    });
  });

  chrome.contextMenus.onClicked.addListener((info: chrome.contextMenus.OnClickData, _tab?: chrome.tabs.Tab) => {
    if (info.menuItemId === "lookupInPersonPeek" && info.selectionText) {
      const name = info.selectionText.trim();
      chrome.storage.local.set({ activeLookupName: name, activeLookupContext: "" })
        .then(() => {
          if (chrome.action && chrome.action.openPopup) {
            return chrome.action.openPopup();
          }
        })
        .catch((err: any) => {
          console.error('[PersonPeek] Context menu popup open failed:', err);
        });
    }
  });

  /* Log startup */
  console.log('[PersonPeek] Service worker started.');
})();
