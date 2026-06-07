/**
 * PersonPeek — Popup Script (TypeScript)
 * ======================================
 * Handles search functionality, result rendering, recent lookups,
 * and all UI state transitions for the extension popup.
 *
 * Communicates with the service worker (background.js) via
 * chrome.runtime.sendMessage for data fetching and storage.
 */

(() => {
  'use strict';

  // ─── Interfaces ───────────────────────────────────────────────

  interface HistoryEntry {
    title: string;
    name?: string;
    description: string;
    thumbnail: string;
    pageUrl: string;
    timestamp: number;
  }

  interface ResultData {
    title: string;
    description?: string;
    thumbnail?: string;
    extract?: string;
    pageUrl?: string;
    wikidataFacts?: {
      birthDate: string;
      deathDate: string;
      occupation: string;
      nationality: string;
      placeOfBirth: string;
    } | null;
    socials?: {
      twitter: string;
      instagram: string;
      linkedin: string;
      youtube: string;
      facebook: string;
    };
    news?: {
      title: string;
      link: string;
      pubDate: string;
      source: string;
    }[];
  }

  // ─── DOM References ───────────────────────────────────────────
  const searchForm       = document.getElementById('searchForm') as HTMLFormElement;
  const searchInput      = document.getElementById('searchInput') as HTMLInputElement;
  const searchBtn        = document.getElementById('searchBtn') as HTMLButtonElement;
  const loadingState     = document.getElementById('loadingState') as HTMLElement;
  const errorState       = document.getElementById('errorState') as HTMLElement;
  const errorMessage     = document.getElementById('errorMessage') as HTMLElement;
  const resultState      = document.getElementById('resultState') as HTMLElement;
  const recentState      = document.getElementById('recentState') as HTMLElement;
  const emptyState       = document.getElementById('emptyState') as HTMLElement;
  const backBtn          = document.getElementById('backBtn') as HTMLButtonElement;
  const clearHistoryBtn  = document.getElementById('clearHistoryBtn') as HTMLButtonElement;
  const recentList       = document.getElementById('recentList') as HTMLUListElement;

  // Result card elements
  const resultPhoto = document.getElementById('resultPhoto') as HTMLImageElement;
  const resultName  = document.getElementById('resultName') as HTMLElement;
  const resultDesc  = document.getElementById('resultDesc') as HTMLElement;
  const resultFacts = document.getElementById('resultFacts') as HTMLElement;
  const resultBio   = document.getElementById('resultBio') as HTMLElement;
  const resultLink  = document.getElementById('resultLink') as HTMLAnchorElement;

  // Settings elements
  const settingsBtn           = document.getElementById('settingsBtn') as HTMLButtonElement;
  const settingsState         = document.getElementById('settingsState') as HTMLElement;
  const settingsBackBtn       = document.getElementById('settingsBackBtn') as HTMLButtonElement;
  const settingsForm          = document.getElementById('settingsForm') as HTMLFormElement;
  const apiKeyInput           = document.getElementById('apiKeyInput') as HTMLInputElement;
  const toggleKeyVisibility   = document.getElementById('toggleKeyVisibility') as HTMLButtonElement;
  const settingsFeedback      = document.getElementById('settingsFeedback') as HTMLElement;

  // ─── State ────────────────────────────────────────────────────
  /** @type {'idle'|'loading'|'result'|'error'|'settings'} */
  let currentView: 'idle' | 'loading' | 'result' | 'error' | 'settings' = 'idle';

  // ─── Utility: Show / Hide Sections ───────────────────────────
  /**
   * Transition the popup to a specific view state.
   * Only one of loading / error / result / settings is shown at a time.
   * Recent and empty states are toggled separately.
   * @param view View state string.
   */
  function setView(view: 'idle' | 'loading' | 'result' | 'error' | 'settings') {
    currentView = view;

    // Hide all dynamic sections first
    loadingState.classList.add('hidden');
    errorState.classList.add('hidden');
    resultState.classList.add('hidden');
    settingsState.classList.add('hidden');

    switch (view) {
      case 'loading':
        loadingState.classList.remove('hidden');
        recentState.classList.add('hidden');
        emptyState.classList.add('hidden');
        break;

      case 'result':
        resultState.classList.remove('hidden');
        recentState.classList.add('hidden');
        emptyState.classList.add('hidden');
        break;

      case 'error':
        errorState.classList.remove('hidden');
        recentState.classList.add('hidden');
        emptyState.classList.add('hidden');
        break;

      case 'settings':
        settingsState.classList.remove('hidden');
        recentState.classList.add('hidden');
        emptyState.classList.add('hidden');
        break;

      case 'idle':
      default:
        // Show recent or empty — decided by loadRecentLookups()
        loadRecentLookups();
        break;
    }
  }

  // ─── Search ───────────────────────────────────────────────────

  /**
   * Perform a person lookup by sending a message to the service worker.
   * @param name — The person's name to search for.
   */
  async function lookupPerson(name: string, context = '') {
    if (!name?.trim()) return;

    const query = name.trim();
    setView('loading');

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'lookupPerson',
        name: query,
        context: context
      });

      if (response?.error) {
        showError(response.error);
        return;
      }

      // Service worker returns { title, description, extract, thumbnail, pageUrl, wikidataFacts }
      if (!response || !response.title) {
        showError(`No results found for "${query}".`);
        return;
      }

      renderResult(response);
      setView('result');
    } catch (err) {
      console.error('[PersonPeek] Lookup failed:', err);
      showError('Could not connect to the extension. Please try again.');
    }
  }

  /**
   * Display an error message.
   * @param msg Error message text.
   */
  function showError(msg: string) {
    errorMessage.textContent = msg;
    setView('error');
  }

  // Listen for form submit
  searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    lookupPerson(searchInput.value);
  });

  // ─── Result Rendering ─────────────────────────────────────────

  /** Default placeholder when no photo is available */
  const PLACEHOLDER_PHOTO = 'data:image/svg+xml,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="90" height="90" viewBox="0 0 90 90">
      <rect width="90" height="90" rx="16" fill="#1a1a2e"/>
      <circle cx="45" cy="35" r="14" stroke="#6C63FF" stroke-width="2" fill="none"/>
      <path d="M18 75c0-14.912 12.088-27 27-27s27 12.088 27 27" stroke="#6C63FF" stroke-width="2" fill="none" stroke-linecap="round"/>
    </svg>`
  );

  /**
   * Render a person result card into the result section.
   * Maps the service worker response format to the popup UI.
   * @param data — Person data from the service worker.
   */
  function renderResult(data: ResultData) {
    // Photo
    resultPhoto.src = data.thumbnail || PLACEHOLDER_PHOTO;
    resultPhoto.alt = data.title || 'Person photo';

    // Handle broken images gracefully
    resultPhoto.onerror = () => {
      resultPhoto.src = PLACEHOLDER_PHOTO;
    };

    // Name & description
    resultName.textContent = data.title || 'Unknown';
    resultDesc.textContent = data.description || '';

    // Facts — build from wikidataFacts object
    resultFacts.replaceChildren();
    const facts = data.wikidataFacts;
    if (facts) {
      const factEntries: { icon: string; label: string; value: string }[] = [];
      if (facts.birthDate) {
        let dateLabel = facts.birthDate;
        if (facts.deathDate) dateLabel += ` — ${facts.deathDate}`;
        factEntries.push({ icon: '📅', label: 'Born', value: dateLabel });
      }
      if (facts.nationality) {
        factEntries.push({ icon: '🌍', label: 'Nationality', value: facts.nationality });
      }
      if (facts.occupation) {
        factEntries.push({ icon: '💼', label: 'Occupation', value: facts.occupation });
      }
      if (facts.placeOfBirth) {
        factEntries.push({ icon: '📍', label: 'Birthplace', value: facts.placeOfBirth });
      }

      factEntries.forEach((fact) => {
        const factEl = document.createElement('div');
        factEl.className = 'result-fact';

        const iconSpan = document.createElement('span');
        iconSpan.className = 'result-fact-icon';
        iconSpan.textContent = fact.icon;
        factEl.appendChild(iconSpan);

        const labelSpan = document.createElement('span');
        labelSpan.className = 'result-fact-label';
        labelSpan.textContent = fact.label;
        factEl.appendChild(labelSpan);

        const valSpan = document.createElement('span');
        valSpan.className = 'result-fact-value';
        valSpan.textContent = fact.value;
        factEl.appendChild(valSpan);

        resultFacts.appendChild(factEl);
      });
    }

    // Bio excerpt
    if (data.extract) {
      resultBio.textContent = truncate(data.extract, 400);
      resultBio.classList.remove('hidden');
    } else {
      resultBio.textContent = '';
      resultBio.classList.add('hidden');
    }

    // Wikipedia link
    if (data.pageUrl) {
      resultLink.href = data.pageUrl;
      resultLink.classList.remove('hidden');
    } else {
      resultLink.classList.add('hidden');
    }

    // Ensure the tabs navigation is created
    let tabsContainer = document.getElementById('resultTabs') as HTMLElement | null;
    if (!tabsContainer) {
      tabsContainer = document.createElement('div');
      tabsContainer.id = 'resultTabs';
      tabsContainer.className = 'result-tabs';
      const header = document.querySelector('.result-header');
      if (header && header.parentNode) {
        header.parentNode.insertBefore(tabsContainer, header.nextSibling);
      }
    }

    // Ensure socials container exists
    let resultSocials = document.getElementById('resultSocials') as HTMLElement | null;
    if (!resultSocials) {
      resultSocials = document.createElement('div');
      resultSocials.id = 'resultSocials';
      resultSocials.className = 'result-socials hidden';
      if (resultBio.parentNode) {
        resultBio.parentNode.insertBefore(resultSocials, resultLink);
      }
    }

    // Ensure news container exists
    let resultNews = document.getElementById('resultNews') as HTMLElement | null;
    if (!resultNews) {
      resultNews = document.createElement('div');
      resultNews.id = 'resultNews';
      resultNews.className = 'result-news hidden';
      if (resultBio.parentNode) {
        resultBio.parentNode.insertBefore(resultNews, resultLink);
      }
    }

    const switchTab = (tabName: 'bio' | 'socials' | 'news') => {
      const buttons = tabsContainer!.querySelectorAll('.tab-btn');
      buttons.forEach((btnNode) => {
        const btn = btnNode as HTMLButtonElement;
        if (btn.dataset.tab === tabName) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });

      if (tabName === 'bio') {
        resultFacts.classList.remove('hidden');
        if (data.extract) resultBio.classList.remove('hidden');
        if (data.pageUrl) resultLink.classList.remove('hidden');
        resultSocials!.classList.add('hidden');
        resultNews!.classList.add('hidden');
      } else if (tabName === 'socials') {
        resultFacts.classList.add('hidden');
        resultBio.classList.add('hidden');
        resultLink.classList.add('hidden');
        resultSocials!.classList.remove('hidden');
        resultNews!.classList.add('hidden');
      } else if (tabName === 'news') {
        resultFacts.classList.add('hidden');
        resultBio.classList.add('hidden');
        resultLink.classList.add('hidden');
        resultSocials!.classList.add('hidden');
        resultNews!.classList.remove('hidden');
      }
    };

    // Populate tabs buttons
    tabsContainer!.replaceChildren();

    const bioBtn = document.createElement('button');
    bioBtn.className = 'tab-btn active';
    bioBtn.dataset.tab = 'bio';
    bioBtn.textContent = 'Bio';
    bioBtn.addEventListener('click', () => switchTab('bio'));
    tabsContainer!.appendChild(bioBtn);

    const socialsBtn = document.createElement('button');
    socialsBtn.className = 'tab-btn';
    socialsBtn.dataset.tab = 'socials';
    socialsBtn.textContent = 'Socials';
    socialsBtn.addEventListener('click', () => switchTab('socials'));
    tabsContainer!.appendChild(socialsBtn);

    const newsBtn = document.createElement('button');
    newsBtn.className = 'tab-btn';
    newsBtn.dataset.tab = 'news';
    newsBtn.textContent = 'News';
    newsBtn.addEventListener('click', () => switchTab('news'));
    tabsContainer!.appendChild(newsBtn);

    // Populate Socials tab
    resultSocials!.replaceChildren();
    const socials = data.socials || {};
    const socialEntries = Object.entries(socials).filter(([_, url]) => url);

    if (socialEntries.length === 0) {
      const noSocials = document.createElement('div');
      noSocials.className = 'no-results-msg';
      noSocials.textContent = 'No social media profiles found on Wikidata.';
      resultSocials!.appendChild(noSocials);
    } else {
      const socialsGrid = document.createElement('div');
      socialsGrid.className = 'socials-grid';

      const socialLabels = new Map<string, { name: string; icon: string; color: string }>([
        ['twitter', { name: 'X / Twitter', icon: '𝕏', color: '#1da1f2' }],
        ['instagram', { name: 'Instagram', icon: '📸', color: '#e1306c' }],
        ['linkedin', { name: 'LinkedIn', icon: '💼', color: '#0077b5' }],
        ['youtube', { name: 'YouTube', icon: '📺', color: '#ff0000' }],
        ['facebook', { name: 'Facebook', icon: '👥', color: '#1877f2' }]
      ]);

      socialEntries.forEach(([key, url]) => {
        const info = socialLabels.has(key) ? socialLabels.get(key)! : { name: key, icon: '🔗', color: 'var(--primary)' };
        
        const link = document.createElement('a');
        link.className = 'social-chip';
        link.href = url as string;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.style.setProperty('--chip-color', info.color);

        const iconSpan = document.createElement('span');
        iconSpan.className = 'social-chip-icon';
        iconSpan.textContent = info.icon;
        link.appendChild(iconSpan);

        const labelSpan = document.createElement('span');
        labelSpan.className = 'social-chip-label';
        labelSpan.textContent = info.name;
        link.appendChild(labelSpan);

        socialsGrid.appendChild(link);
      });

      resultSocials!.appendChild(socialsGrid);
    }

    // Populate News tab
    resultNews!.replaceChildren();
    const newsList = data.news || [];

    if (newsList.length === 0) {
      const noNews = document.createElement('div');
      noNews.className = 'no-results-msg';
      noNews.textContent = 'No recent news stories found.';
      resultNews!.appendChild(noNews);
    } else {
      const listContainer = document.createElement('div');
      listContainer.className = 'news-list';

      newsList.forEach((story) => {
        const item = document.createElement('a');
        item.className = 'news-item';
        item.href = story.link;
        item.target = '_blank';
        item.rel = 'noopener noreferrer';

        const title = document.createElement('div');
        title.className = 'news-item-title';
        title.textContent = story.title;
        item.appendChild(title);

        const meta = document.createElement('div');
        meta.className = 'news-item-meta';

        const source = document.createElement('span');
        source.className = 'news-item-source';
        source.textContent = story.source || 'News';
        meta.appendChild(source);

        const date = document.createElement('span');
        date.className = 'news-item-date';
        date.textContent = story.pubDate || '';
        meta.appendChild(date);

        item.appendChild(meta);
        listContainer.appendChild(item);
      });

      resultNews!.appendChild(listContainer);
    }

    // Default to bio tab
    switchTab('bio');
  }

  // ─── Recent Lookups ───────────────────────────────────────────

  /**
   * Load recent lookups from the service worker and render them.
   * Toggles between the recent list and empty state.
   */
  async function loadRecentLookups() {
    try {
      const lookups = await chrome.runtime.sendMessage({
        action: 'getRecentLookups',
      });

      if (!Array.isArray(lookups) || lookups.length === 0) {
        recentState.classList.add('hidden');
        emptyState.classList.remove('hidden');
        return;
      }

      emptyState.classList.add('hidden');
      recentState.classList.remove('hidden');
      renderRecentList(lookups);
    } catch (err) {
      console.error('[PersonPeek] Failed to load recent lookups:', err);
      // Show empty state on error as a graceful fallback
      recentState.classList.add('hidden');
      emptyState.classList.remove('hidden');
    }
  }

  /**
   * Render the list of recent lookups into the DOM.
   * @param lookups — Array of person data objects.
   */
  function renderRecentList(lookups: HistoryEntry[]) {
    recentList.replaceChildren();

    lookups.forEach((person, index) => {
      const li = document.createElement('li');
      li.className = 'popup-recent-item';
      // Staggered entrance animation
      li.style.animationDelay = `${index * 60}ms`;

      const thumb = person.thumbnail || PLACEHOLDER_PHOTO;
      const displayName = person.title || person.name || 'Unknown';

      const img = document.createElement('img');
      img.className = 'popup-recent-thumb';
      img.src = thumb;
      img.alt = displayName;
      img.addEventListener('error', () => {
        img.src = PLACEHOLDER_PHOTO;
      });
      li.appendChild(img);

      const infoDiv = document.createElement('div');
      infoDiv.className = 'popup-recent-info';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'popup-recent-name';
      nameSpan.textContent = displayName;
      infoDiv.appendChild(nameSpan);

      const descSpan = document.createElement('span');
      descSpan.className = 'popup-recent-desc';
      descSpan.textContent = truncate(person.description || '', 60);
      infoDiv.appendChild(descSpan);

      li.appendChild(infoDiv);

      // SVG Arrow
      const svgNamespace = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNamespace, 'svg');
      svg.setAttribute('class', 'popup-recent-arrow');
      svg.setAttribute('width', '12');
      svg.setAttribute('height', '12');
      svg.setAttribute('viewBox', '0 0 12 12');
      svg.setAttribute('fill', 'none');

      const path = document.createElementNS(svgNamespace, 'path');
      path.setAttribute('d', 'M4 2l4 4-4 4');
      path.setAttribute('stroke', '#9A9AB0');
      path.setAttribute('stroke-width', '1.2');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(path);

      li.appendChild(svg);

      // Clicking a recent item re-searches that person
      li.addEventListener('click', () => {
        searchInput.value = displayName;
        lookupPerson(displayName);
      });

      recentList.appendChild(li);
    });
  }

  // Clear history button
  clearHistoryBtn.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ action: 'clearRecentLookups' });
      // Transition to empty state
      recentList.replaceChildren();
      recentState.classList.add('hidden');
      emptyState.classList.remove('hidden');
    } catch (err) {
      console.error('[PersonPeek] Failed to clear history:', err);
    }
  });

  // ─── Back Button ──────────────────────────────────────────────

  backBtn.addEventListener('click', () => {
    setView('idle');
    searchInput.value = '';
    searchInput.focus();
  });

  // ─── Helpers ──────────────────────────────────────────────────

  /**
   * Truncate a string to a maximum length, adding an ellipsis.
   * @param str The string to truncate.
   * @param max Max allowed characters before truncation.
   */
  function truncate(str: string, max: number): string {
    if (!str || str.length <= max) return str || '';
    return str.slice(0, max).trimEnd() + '…';
  }

  // ─── Settings ──────────────────────────────────────────────────

  settingsBtn.addEventListener('click', () => {
    setView('settings');
    loadSettings();
  });

  settingsBackBtn.addEventListener('click', () => {
    setView('idle');
  });

  toggleKeyVisibility.addEventListener('click', () => {
    if (apiKeyInput.type === 'password') {
      apiKeyInput.type = 'text';
      toggleKeyVisibility.textContent = '🔒';
    } else {
      apiKeyInput.type = 'password';
      toggleKeyVisibility.textContent = '👁️';
    }
  });

  async function loadSettings() {
    try {
      const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
      if (geminiApiKey) {
        apiKeyInput.value = geminiApiKey;
      } else {
        apiKeyInput.value = '';
      }
    } catch (err) {
      console.error('[PersonPeek] Failed to load settings:', err);
    }
  }

  settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = apiKeyInput.value.trim();
    try {
      await chrome.storage.local.set({ geminiApiKey: key });
      showSettingsFeedback('Settings saved!');
    } catch (err) {
      console.error('[PersonPeek] Failed to save API key:', err);
      showSettingsFeedback('Failed to save settings.', true);
    }
  });

  let feedbackTimer: any = null;
  function showSettingsFeedback(message: string, isError = false) {
    clearTimeout(feedbackTimer);
    settingsFeedback.textContent = message;
    if (isError) {
      settingsFeedback.style.background = 'rgba(255, 107, 107, 0.08)';
      settingsFeedback.style.border = '1px solid rgba(255, 107, 107, 0.2)';
      settingsFeedback.style.color = 'var(--danger)';
    } else {
      settingsFeedback.style.background = 'rgba(0, 212, 170, 0.08)';
      settingsFeedback.style.border = '1px solid rgba(0, 212, 170, 0.2)';
      settingsFeedback.style.color = 'var(--secondary)';
    }
    settingsFeedback.classList.remove('hidden');
    feedbackTimer = setTimeout(() => {
      settingsFeedback.classList.add('hidden');
    }, 2000);
  }

  // ─── Initialization ──────────────────────────────────────────

  /**
   * Initialize the popup on open.
   * - Auto-focus search input
   * - Load recent lookups or trigger a pending context lookup
   */
  async function init() {
    // Auto-focus the search input for immediate typing
    searchInput.focus();

    // Load recent lookups (shows empty state if none)
    setView('idle');

    // Read initial active search if one is set (e.g. from context menu)
    try {
      const { activeLookupName, activeLookupContext } = await chrome.storage.local.get(['activeLookupName', 'activeLookupContext']);
      if (activeLookupName) {
        // Clear it from storage so it doesn't open again next time the user manually clicks the icon
        await chrome.storage.local.remove(['activeLookupName', 'activeLookupContext']);
        
        // Perform the search
        searchInput.value = activeLookupName as string;
        lookupPerson(activeLookupName as string, activeLookupContext as string);
      }
    } catch (err) {
      console.warn('[PersonPeek] Popup storage fetch failed:', err);
    }
  }

  // Run init when DOM is ready
  init();
})();
