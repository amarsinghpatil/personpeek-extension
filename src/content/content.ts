/**
 * PersonPeek — Content Script (TypeScript)
 * ========================================
 * Injected into every page. Detects person-name selection via double-click or
 * manual highlight, then shows a premium glassmorphic info card powered by
 * Wikipedia + Wikidata data fetched through the background service worker.
 *
 * All UI lives inside a **closed** Shadow DOM so host-page styles can't leak in
 * and our styles can't leak out.
 */

'use strict';

/* ================================================================== */
/*  Guard — only inject once per page                                  */
/* ================================================================== */

if ((window as any).__personPeekInjected) {
  // Already running in this frame.
} else {
  (window as any).__personPeekInjected = true;

  /* ---------------------------------------------------------------- */
  /*  Shadow DOM host setup                                            */
  /* ---------------------------------------------------------------- */

  const hostEl = document.createElement('div');
  hostEl.id = 'personpeek-host';
  hostEl.style.cssText = 'all:initial; position:fixed; z-index:2147483647; top:0; left:0; width:0; height:0; pointer-events:none;';
  document.documentElement.appendChild(hostEl);

  const shadow = hostEl.attachShadow({ mode: 'closed' });

  /** Load our stylesheet into the shadow root */
  (function injectStyles() {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('content/content.css');
    shadow.appendChild(link);
  })();

  /* ---------------------------------------------------------------- */
  /*  Configuration & State                                            */
  /* ---------------------------------------------------------------- */

  const USE_SIDE_PANEL = false;  // Toggle to switch between side panel (Option 1) and inline card

  let isDoubleClick = false;    // flag to prevent mouseup from also firing
  let activeCard: HTMLElement | null = null;        // reference to the currently-open card element
  let activeBtn: HTMLButtonElement | null = null;         // reference to the floating lookup button
  let scrollDismissTimer: any = null;
  let lastDraggedPosition: { left: number; top: number } | null = null; // Tracks the last user-dragged position of the card

  /**
   * Helper to check if the side panel is open, catching context invalidation errors.
   */
  function checkSidePanelOpen(callback: (isOpen: boolean) => void) {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
      callback(false);
      return;
    }
    try {
      chrome.runtime.sendMessage({ action: 'pingSidePanel' }, (response) => {
        if (chrome.runtime.lastError) {
          callback(false);
        } else {
          callback(response && response.alive);
        }
      });
    } catch (err) {
      console.warn('[PersonPeek] Extension context invalidated. Please reload the webpage.', err);
      callback(false);
    }
  }

  /**
   * Helper to safely update storage for the side panel, catching invalidation errors.
   */
  function safeSetLookupName(text: string, context = '') {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.runtime?.id) {
      return;
    }
    try {
      chrome.storage.local.set({ activeLookupName: text, activeLookupContext: context });
    } catch (err) {
      console.warn('[PersonPeek] Failed to update lookup name:', err);
    }
  }

  /**
   * Extract surrounding context around the selection.
   * We get the text of the common ancestor container (or parent element if text node).
   * We find the index of the selected text within that context and take up to 150 chars
   * before and 150 chars after, making sure to clamp properly.
   * @param sel The selection object.
   */
  function getSelectionContext(sel: Selection | null): string {
    if (!sel || sel.rangeCount === 0) return '';
    try {
      const range = sel.getRangeAt(0);
      let container: Node | null = range.commonAncestorContainer;
      if (container.nodeType === Node.TEXT_NODE) {
        container = container.parentElement;
      }
      if (!container) return '';
      
      const fullText = container.textContent || '';
      const selectedText = sel.toString();
      if (!selectedText) return '';
      
      const index = fullText.indexOf(selectedText);
      if (index === -1) {
        return fullText.slice(0, 300).trim();
      }
      
      const start = Math.max(0, index - 150);
      const end = Math.min(fullText.length, index + selectedText.length + 150);
      return fullText.slice(start, end).trim();
    } catch (e) {
      console.warn('[PersonPeek] Failed to get selection context:', e);
      return '';
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Utilities                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Validate that the selected text looks like a person's name.
   * Rules: 1-5 words, 2-60 characters, only letters/hyphens/apostrophes/spaces/dots.
   * @param text Selected name text.
   * @param isDoubleClick Whether the event was a double-click.
   */
  function isValidName(text: string, isDoubleClick = false): boolean {
    if (!text) return false;
    const trimmed = text.trim();
    if (trimmed.length < 2 || trimmed.length > 60) return false;
    const words = trimmed.split(/\s+/);
    if (words.length < 1 || words.length > 5) return false;

    // Loose check — allow unicode letters, hyphens, apostrophes, dots
    const hasAllowedChars = /^[\p{L}\s'.·\-]+$/u.test(trimmed);
    if (!hasAllowedChars) return false;

    // Enforce capitalization and stop words check on double-click events to prevent dictionary tooltip overlap
    if (isDoubleClick) {
      // Set of common English words (stop words, common verbs, prepositions) to prevent dictionary overlap.
      const stopWords = new Set([
        // Articles & Pronouns
        'i', 'me', 'my', 'myself', 'we', 'us', 'our', 'ours', 'ourselves', 'you', 'your', 'yours', 'yourself', 'yourselves',
        'he', 'him', 'his', 'himself', 'she', 'her', 'hers', 'herself', 'it', 'its', 'itself', 'they', 'them', 'their', 'theirs', 'themselves',
        'who', 'whom', 'whose', 'which', 'what', 'that', 'this', 'these', 'those', 'each', 'every', 'either', 'neither', 'some', 'any', 'no', 'none',
        'both', 'all', 'any', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
        // Prepositions & Conjunctions
        'about', 'above', 'across', 'after', 'against', 'along', 'amid', 'among', 'around', 'at', 'before', 'behind', 'below', 'beneath',
        'beside', 'besides', 'between', 'beyond', 'by', 'concerning', 'considering', 'despite', 'down', 'during', 'except', 'for', 'from',
        'in', 'inside', 'into', 'like', 'near', 'of', 'off', 'on', 'onto', 'out', 'outside', 'over', 'past', 'regarding', 'round', 'since',
        'through', 'throughout', 'till', 'to', 'toward', 'towards', 'under', 'underneath', 'until', 'up', 'upon', 'with', 'within', 'without',
        'and', 'but', 'or', 'nor', 'for', 'yet', 'so', 'although', 'because', 'since', 'unless', 'until', 'while', 'whereas', 'as', 'if', 'though',
        'the', 'a', 'an',
        // Verbs & Auxiliaries
        'is', 'was', 'were', 'are', 'been', 'being', 'am', 'be', 'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing',
        'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must', 'go', 'goes', 'went', 'gone', 'going',
        'get', 'gets', 'got', 'getting', 'make', 'makes', 'made', 'making', 'take', 'takes', 'took', 'taken', 'taking',
        'come', 'comes', 'came', 'coming', 'see', 'sees', 'saw', 'seen', 'seeing', 'know', 'knows', 'knew', 'known', 'knowing',
        'think', 'thinks', 'thought', 'thinking', 'want', 'wants', 'wanted', 'wanting', 'use', 'uses', 'used', 'using',
        'find', 'finds', 'found', 'finding', 'give', 'gives', 'gave', 'given', 'giving', 'tell', 'tells', 'told', 'telling',
        'work', 'works', 'worked', 'working', 'call', 'calls', 'called', 'calling', 'try', 'tries', 'tried', 'trying',
        'ask', 'asks', 'asked', 'asking', 'need', 'needs', 'needed', 'needing', 'feel', 'feels', 'felt', 'feeling',
        'become', 'becomes', 'became', 'becoming', 'leave', 'leaves', 'left', 'leaving', 'put', 'puts', 'putting',
        'mean', 'means', 'meant', 'meaning', 'keep', 'keeps', 'kept', 'keeping', 'let', 'lets', 'letting',
        'seem', 'seems', 'seemed', 'seeming', 'help', 'helps', 'helped', 'helping', 'talk', 'talks', 'talked', 'talking',
        'turn', 'turns', 'turned', 'turning', 'start', 'starts', 'started', 'starting', 'show', 'shows', 'showed', 'shown', 'showing',
        'hear', 'hears', 'heard', 'hearing', 'play', 'plays', 'played', 'playing', 'run', 'runs', 'ran', 'running',
        'move', 'moves', 'moved', 'moving', 'like', 'likes', 'liked', 'liking', 'live', 'lives', 'lived', 'living',
        'believe', 'believes', 'believed', 'believing', 'write', 'writes', 'wrote', 'written', 'writing', 'say', 'says', 'said', 'saying',
        'read', 'reads', 'readed', 'reading',
        // Adverbs & Common words
        'only', 'also', 'even', 'just', 'then', 'now', 'here', 'there', 'when', 'why', 'how', 'where', 'very', 'more', 'most',
        'other', 'another', 'again', 'still', 'too', 'never', 'always', 'often', 'today', 'yesterday', 'tomorrow',
        'example', 'similar', 'case', 'new', 'old', 'good', 'bad', 'great', 'small', 'big', 'high', 'low', 'first', 'last',
        'newspaper', 'newspapers', 'news', 'paper', 'papers', 'write-up', 'article', 'articles', 'report', 'reports',
        'dr', 'mr', 'ms', 'mrs', 'prof', 'president', 'pm', 'governor', 'senator', 'mayor', 'minister'
      ]);

      if (words.length === 1) {
        const word = words[0].toLowerCase();
        // Reject if it is a common stop word
        return !stopWords.has(word);
      } else {
        // Multi-word name: check that at least one of the words is NOT a stop word
        const ignoreList = new Set(['de', 'da', 'di', 'do', 'von', 'van', 'the', 'of', 'and', 'la', 'le', 'del', 'du']);
        return words.some((w) => {
          const lower = w.toLowerCase();
          if (ignoreList.has(lower) || stopWords.has(lower)) return false;
          return true;
        });
      }
    }

    return true;
  }

  /** Remove the floating lookup button from shadow DOM */
  function removeLookupBtn() {
    if (activeBtn) {
      activeBtn.remove();
      activeBtn = null;
    }
  }

  /** Remove the info card from shadow DOM */
  function removeCard() {
    if (activeCard) {
      activeCard.remove();
      activeCard = null;
    }
  }

  /** Dismiss everything */
  function dismissAll() {
    removeLookupBtn();
    removeCard();
  }

  /**
   * Clamp a coordinate to keep the element within the viewport.
   * @param pos   desired position
   * @param size  element dimension
   * @param max   viewport dimension
   * @param margin
   */
  function clamp(pos: number, size: number, max: number, margin = 12): number {
    return Math.max(margin, Math.min(pos, max - size - margin));
  }

  /**
   * Make the info card draggable using clientX/clientY.
   * @param card The card element container.
   */
  function makeCardDraggable(card: HTMLElement) {
    let offsetX = 0;
    let offsetY = 0;
    let isDragging = false;

    const onMouseDown = (e: MouseEvent) => {
      // Don't drag if clicking buttons, links, tabs, input fields, scrollbars, or text areas
      const target = e.target as HTMLElement | null;
      if (!target) return;

      if (
        target.closest('button') || 
        target.closest('a') || 
        target.closest('input') || 
        target.closest('.pp-card-bio') ||
        target.closest('.pp-card-tabs') ||
        target.closest('.pp-tab-content-news') ||
        target.closest('.pp-tab-content-socials') ||
        target.closest('.pp-card-facts')
      ) {
        return;
      }

      isDragging = true;
      card.classList.add('pp-dragging');

      const rect = card.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);

      e.preventDefault();
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;

      let left = e.clientX - offsetX;
      let top = e.clientY - offsetY;

      // Clamp to viewport
      const cardWidth = card.offsetWidth;
      const cardHeight = card.offsetHeight;
      const maxX = window.innerWidth - cardWidth;
      const maxY = window.innerHeight - cardHeight;

      left = Math.max(0, Math.min(left, maxX));
      top = Math.max(0, Math.min(top, maxY));

      card.style.left = `${left}px`;
      card.style.top = `${top}px`;
      card.style.bottom = 'auto';
      card.style.right = 'auto';

      lastDraggedPosition = { left, top };
    };

    const onMouseUp = () => {
      if (isDragging) {
        isDragging = false;
        card.classList.remove('pp-dragging');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      }
    };

    card.addEventListener('mousedown', onMouseDown);
  }

  /* ---------------------------------------------------------------- */
  /*  Lookup button                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Show a small floating 🔍 button near the text selection.
   * @param rect — bounding rect of the selection
   * @param text  — the selected text
   * @param context — surrounding text context
   */
  function showLookupBtn(rect: DOMRect, text: string, context = '') {
    removeLookupBtn();
    removeCard();

    const btn = document.createElement('button');
    btn.className = 'pp-lookup-btn';
    btn.textContent = '🔍';
    btn.title = `Look up "${text}"`;
    btn.style.pointerEvents = 'auto';

    // Position just above the selection, centered horizontally
    const left = clamp(rect.left + rect.width / 2 - 20, 40, window.innerWidth);
    const top = rect.top - 50;
    btn.style.left = `${left}px`;
    btn.style.top = `${Math.max(8, top)}px`;

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeLookupBtn();
      if (USE_SIDE_PANEL) {
        checkSidePanelOpen((isSidePanelOpen) => {
          if (isSidePanelOpen) {
            safeSetLookupName(text, context);
          } else {
            showInfoCard(rect, text, context);
          }
        });
      } else {
        showInfoCard(rect, text, context);
      }
    });

    shadow.appendChild(btn);
    activeBtn = btn as HTMLButtonElement;
  }

  /* ---------------------------------------------------------------- */
  /*  Info Card                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Show the info card near the selection rect.
   * Immediately shows a loading state, then fetches data from the background
   * service worker and renders the full card.
   * @param rect Bounding client rect of selection.
   * @param name Selected lookup phrase.
   * @param context Surrounding context text.
   */
  function showInfoCard(rect: DOMRect, name: string, context = '') {
    removeCard();
    removeLookupBtn();

    const card = document.createElement('div');
    card.className = 'pp-card';
    card.style.pointerEvents = 'auto';

    // --- Position card at last dragged position or default to top-right empty space ---
    const cardWidth = 340;
    const estimatedHeight = 320;

    let left, top;
    if (lastDraggedPosition) {
      left = clamp(lastDraggedPosition.left, cardWidth, window.innerWidth);
      top = clamp(lastDraggedPosition.top, estimatedHeight, window.innerHeight);
    } else {
      // Default to the top-right corner (typically empty margin space on websites)
      left = window.innerWidth - cardWidth - 24;
      top = 24;

      left = clamp(left, cardWidth, window.innerWidth);
      top = clamp(top, estimatedHeight, window.innerHeight);
    }

    card.style.left = `${left}px`;
    card.style.top = `${top}px`;

    // --- Loading state ---
    const inner = document.createElement('div');
    inner.className = 'pp-card-inner';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'pp-card-close';
    closeBtn.title = 'Close';
    closeBtn.textContent = '×';
    inner.appendChild(closeBtn);

    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'pp-loading';

    const spinner = document.createElement('div');
    spinner.className = 'pp-loading-spinner';
    loadingDiv.appendChild(spinner);

    const loadingText = document.createElement('div');
    loadingText.className = 'pp-loading-text';
    loadingText.textContent = `Looking up ${name}…`;
    loadingDiv.appendChild(loadingText);

    inner.appendChild(loadingDiv);
    card.appendChild(inner);

    // Close button
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissAll();
    });

    shadow.appendChild(card);
    activeCard = card;
    makeCardDraggable(card);

    // --- Fetch data ---
    try {
      chrome.runtime.sendMessage({ action: 'lookupPerson', name: name.trim(), context: context }, (response: any) => {
        // Card may have been dismissed while waiting
        if (!activeCard || activeCard !== card) return;

        if (chrome.runtime.lastError) {
          renderError(card, 'Connection to extension lost. Try reloading the page.');
          return;
        }

        if (!response || response.error) {
          renderError(card, response?.error || 'Something went wrong.');
          return;
        }

        renderResult(card, response);
      });
    } catch (err) {
      console.warn('[PersonPeek] Extension context invalidated. Please reload the webpage.', err);
      renderError(card, 'Extension context invalidated. Please reload the webpage.');
    }
  }

  /**
   * Render a "not found" / error state into the card.
   * @param card Card container.
   * @param message Error details display.
   */
  function renderError(card: HTMLElement, message: string) {
    const inner = card.querySelector('.pp-card-inner');
    if (!inner) return;

    inner.replaceChildren();

    const closeBtn = document.createElement('button');
    closeBtn.className = 'pp-card-close';
    closeBtn.title = 'Close';
    closeBtn.textContent = '×';
    inner.appendChild(closeBtn);

    const errorDiv = document.createElement('div');
    errorDiv.className = 'pp-error';

    const errorIcon = document.createElement('div');
    errorIcon.className = 'pp-error-icon';
    errorIcon.textContent = '🤷';
    errorDiv.appendChild(errorIcon);

    const errorTitle = document.createElement('div');
    errorTitle.className = 'pp-error-title';
    errorTitle.textContent = 'No information found';
    errorDiv.appendChild(errorTitle);

    const errorMessage = document.createElement('div');
    errorMessage.className = 'pp-error-message';
    errorMessage.textContent = message;
    errorDiv.appendChild(errorMessage);

    inner.appendChild(errorDiv);

    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissAll();
    });
  }

  /**
   * Render the full result into the card.
   * @param card Card container.
   * @param data Result structure returned by service worker.
   */
  function renderResult(card: HTMLElement, data: any) {
    const inner = card.querySelector('.pp-card-inner');
    if (!inner) return;

    inner.replaceChildren();

    const facts = data.wikidataFacts || {};

    const closeBtn = document.createElement('button');
    closeBtn.className = 'pp-card-close';
    closeBtn.title = 'Close';
    closeBtn.textContent = '×';
    inner.appendChild(closeBtn);

    // --- Header ---
    const header = document.createElement('div');
    header.className = 'pp-card-header';

    // --- Photo ---
    if (data.thumbnail) {
      const img = document.createElement('img');
      img.className = 'pp-card-photo';
      img.src = data.thumbnail;
      img.alt = data.title || '';
      header.appendChild(img);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'pp-card-photo-placeholder';
      placeholder.textContent = '👤';
      header.appendChild(placeholder);
    }

    const headerText = document.createElement('div');
    headerText.className = 'pp-card-header-text';

    const nameDiv = document.createElement('div');
    nameDiv.className = 'pp-card-name';
    nameDiv.textContent = data.title || '';
    headerText.appendChild(nameDiv);

    if (data.description) {
      const descDiv = document.createElement('div');
      descDiv.className = 'pp-card-desc';
      descDiv.textContent = data.description;
      headerText.appendChild(descDiv);
    }

    header.appendChild(headerText);
    inner.appendChild(header);

    // --- Tabs Row ---
    const tabsRow = document.createElement('div');
    tabsRow.className = 'pp-card-tabs';
    inner.appendChild(tabsRow);

    // --- Tab Contents Containers ---
    const bioContainer = document.createElement('div');
    bioContainer.className = 'pp-tab-content-bio';
    inner.appendChild(bioContainer);

    const socialsContainer = document.createElement('div');
    socialsContainer.className = 'pp-tab-content-socials pp-hidden';
    inner.appendChild(socialsContainer);

    const newsContainer = document.createElement('div');
    newsContainer.className = 'pp-tab-content-news pp-hidden';
    inner.appendChild(newsContainer);

    // --- Switch Tab helper ---
    const switchTab = (tabName: 'bio' | 'socials' | 'news') => {
      const buttons = tabsRow.querySelectorAll('.pp-tab-btn');
      buttons.forEach((btnNode) => {
        const btn = btnNode as HTMLButtonElement;
        if (btn.dataset.tab === tabName) {
          btn.classList.add('pp-active');
        } else {
          btn.classList.remove('pp-active');
        }
      });

      if (tabName === 'bio') {
        bioContainer.classList.remove('pp-hidden');
        socialsContainer.classList.add('pp-hidden');
        newsContainer.classList.add('pp-hidden');
      } else if (tabName === 'socials') {
        bioContainer.classList.add('pp-hidden');
        socialsContainer.classList.remove('pp-hidden');
        newsContainer.classList.add('pp-hidden');
      } else if (tabName === 'news') {
        bioContainer.classList.add('pp-hidden');
        socialsContainer.classList.add('pp-hidden');
        newsContainer.classList.remove('pp-hidden');
      }
    };

    // --- Tab Buttons ---
    const bioBtn = document.createElement('button');
    bioBtn.className = 'pp-tab-btn pp-active';
    bioBtn.dataset.tab = 'bio';
    bioBtn.textContent = 'Bio';
    bioBtn.addEventListener('click', () => switchTab('bio'));
    tabsRow.appendChild(bioBtn);

    const socialsBtn = document.createElement('button');
    socialsBtn.className = 'pp-tab-btn';
    socialsBtn.dataset.tab = 'socials';
    socialsBtn.textContent = 'Socials';
    socialsBtn.addEventListener('click', () => switchTab('socials'));
    tabsRow.appendChild(socialsBtn);

    const newsBtn = document.createElement('button');
    newsBtn.className = 'pp-tab-btn';
    newsBtn.dataset.tab = 'news';
    newsBtn.textContent = 'News';
    newsBtn.addEventListener('click', () => switchTab('news'));
    tabsRow.appendChild(newsBtn);

    // --- Populate Bio Container ---
    // Facts chips
    const factItems: { icon: string; value: string }[] = [];
    if (facts.birthDate) {
      let dateLabel = facts.birthDate;
      if (facts.deathDate) dateLabel += ` — ${facts.deathDate}`;
      factItems.push({ icon: '📅', value: dateLabel });
    }
    if (facts.nationality) {
      factItems.push({ icon: '🌍', value: facts.nationality });
    }
    if (facts.occupation) {
      factItems.push({ icon: '💼', value: facts.occupation });
    }
    if (facts.placeOfBirth) {
      factItems.push({ icon: '📍', value: facts.placeOfBirth });
    }

    if (factItems.length) {
      const divider = document.createElement('hr');
      divider.className = 'pp-card-divider';
      bioContainer.appendChild(divider);

      const factsContainer = document.createElement('div');
      factsContainer.className = 'pp-card-facts';

      factItems.forEach((item) => {
        const factDiv = document.createElement('div');
        factDiv.className = 'pp-card-fact';

        const iconSpan = document.createElement('span');
        iconSpan.className = 'pp-card-fact-icon';
        iconSpan.textContent = item.icon;
        factDiv.appendChild(iconSpan);

        const valSpan = document.createElement('span');
        valSpan.className = 'pp-card-fact-value';
        valSpan.textContent = item.value;
        factDiv.appendChild(valSpan);

        factsContainer.appendChild(factDiv);
      });
      bioContainer.appendChild(factsContainer);
    }

    // Bio Text
    if (data.extract) {
      const divider = document.createElement('hr');
      divider.className = 'pp-card-divider';
      bioContainer.appendChild(divider);

      // Limit to ~3 sentences for brevity
      const sentences = data.extract.match(/[^.!?]*[.!?]+/g) || [data.extract];
      const shortBio = sentences.slice(0, 3).join(' ');

      const bioDiv = document.createElement('div');
      bioDiv.className = 'pp-card-bio';
      bioDiv.textContent = shortBio;
      bioContainer.appendChild(bioDiv);
    }

    // Footer
    const footer = document.createElement('div');
    footer.className = 'pp-card-footer';

    const link = document.createElement('a');
    link.className = 'pp-card-link';
    link.href = data.pageUrl || '#';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Read more on Wikipedia';

    const arrowSpan = document.createElement('span');
    arrowSpan.className = 'pp-card-link-arrow';
    arrowSpan.textContent = ' →';
    link.appendChild(arrowSpan);

    footer.appendChild(link);

    const sourceSpan = document.createElement('span');
    sourceSpan.className = 'pp-card-source';
    sourceSpan.textContent = 'via Wikipedia';
    footer.appendChild(sourceSpan);

    bioContainer.appendChild(footer);

    // --- Populate Socials Container ---
    const socials = data.socials || {};
    const socialEntries = Object.entries(socials).filter(([_, url]) => url);

    if (socialEntries.length === 0) {
      const noSocials = document.createElement('div');
      noSocials.className = 'pp-no-results';
      noSocials.textContent = 'No social media profiles found on Wikidata.';
      socialsContainer.appendChild(noSocials);
    } else {
      const socialsGrid = document.createElement('div');
      socialsGrid.className = 'pp-socials-grid';

      const socialLabels = new Map<string, { name: string; icon: string; color: string }>([
        ['twitter', { name: 'X / Twitter', icon: '𝕏', color: '#1da1f2' }],
        ['instagram', { name: 'Instagram', icon: '📸', color: '#e1306c' }],
        ['linkedin', { name: 'LinkedIn', icon: '💼', color: '#0077b5' }],
        ['youtube', { name: 'YouTube', icon: '📺', color: '#ff0000' }],
        ['facebook', { name: 'Facebook', icon: '👥', color: '#1877f2' }]
      ]);

      socialEntries.forEach(([key, url]) => {
        const info = socialLabels.has(key) ? socialLabels.get(key)! : { name: key, icon: '🔗', color: 'var(--primary)' };
        
        const socialLink = document.createElement('a');
        socialLink.className = 'pp-social-chip';
        socialLink.href = url as string;
        socialLink.target = '_blank';
        socialLink.rel = 'noopener noreferrer';
        socialLink.style.setProperty('--chip-color', info.color);

        const iconSpan = document.createElement('span');
        iconSpan.className = 'pp-social-chip-icon';
        iconSpan.textContent = info.icon;
        socialLink.appendChild(iconSpan);

        const labelSpan = document.createElement('span');
        labelSpan.className = 'pp-social-chip-label';
        labelSpan.textContent = info.name;
        socialLink.appendChild(labelSpan);

        socialsGrid.appendChild(socialLink);
      });

      socialsContainer.appendChild(socialsGrid);
    }

    // --- Populate News Container ---
    const newsList = data.news || [];

    if (newsList.length === 0) {
      const noNews = document.createElement('div');
      noNews.className = 'pp-no-results';
      noNews.textContent = 'No recent news stories found.';
      newsContainer.appendChild(noNews);
    } else {
      const listContainer = document.createElement('div');
      listContainer.className = 'pp-news-list';

      newsList.forEach((story: any) => {
        const item = document.createElement('a');
        item.className = 'pp-news-item';
        item.href = story.link;
        item.target = '_blank';
        item.rel = 'noopener noreferrer';

        const title = document.createElement('div');
        title.className = 'pp-news-item-title';
        title.textContent = story.title;
        item.appendChild(title);

        const meta = document.createElement('div');
        meta.className = 'pp-news-item-meta';

        const source = document.createElement('span');
        source.className = 'pp-news-item-source';
        source.textContent = story.source || 'News';
        meta.appendChild(source);

        const date = document.createElement('span');
        date.className = 'pp-news-item-date';
        date.textContent = story.pubDate || '';
        meta.appendChild(date);

        item.appendChild(meta);
        listContainer.appendChild(item);
      });

      newsContainer.appendChild(listContainer);
    }

    // Default to Bio tab
    switchTab('bio');

    // Re-bind close button
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissAll();
    });

    // Prevent clicks inside the card from dismissing it
    card.addEventListener('click', (e) => e.stopPropagation());
  }

  /* ---------------------------------------------------------------- */
  /*  Event Listeners                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * DOUBLE-CLICK — directly show the info card (skip the lookup button).
   */
  document.addEventListener('dblclick', (e) => {
    // Ignore clicks on input/textarea/contenteditable
    if (isInteractiveElement(e.target)) return;

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    const text = sel.toString().trim();
    if (!text || !isValidName(text, true)) return;
    // Extra check: 2-50 chars, 1-5 words
    if (text.length < 2 || text.length > 50 || text.split(/\s+/).length > 5) return;

    // Set flag so mouseup doesn't also fire
    isDoubleClick = true;
    setTimeout(() => { isDoubleClick = false; }, 300);

    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const context = getSelectionContext(sel);

    if (USE_SIDE_PANEL) {
      checkSidePanelOpen((isSidePanelOpen) => {
        if (isSidePanelOpen) {
          safeSetLookupName(text, context);
        } else {
          showInfoCard(rect, text, context);
        }
      });
    } else {
      showInfoCard(rect, text, context);
    }
  }, true);

  /**
   * MOUSEUP — show the floating lookup button when text is selected.
   */
  document.addEventListener('mouseup', (e) => {
    // Skip if this is part of a double-click
    if (isDoubleClick) return;

    // Don't trigger on right-click
    if (e.button !== 0) return;

    // Ignore clicks on our own UI
    if (e.target === hostEl || hostEl.contains(e.target as Node)) return;

    // Ignore interactive elements
    if (isInteractiveElement(e.target)) return;

    // Capture selection INSTANTLY before website scripts can clear/override it
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    const text = sel.toString().trim();
    if (!text || !isValidName(text, false)) return;
    if (text.length < 2 || text.length > 60 || text.split(/\s+/).length > 5) return;

    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const context = getSelectionContext(sel);

    // Trigger details card or side panel directly inside next execution frame
    setTimeout(() => {
      if (USE_SIDE_PANEL) {
        checkSidePanelOpen((isSidePanelOpen) => {
          if (isSidePanelOpen) {
            safeSetLookupName(text, context);
          } else {
            showInfoCard(rect, text, context);
          }
        });
      } else {
        showInfoCard(rect, text, context);
      }
    }, 0);
  }, true);

  /**
   * Check if an element is an interactive input where we shouldn't intercept.
   * @param el The event target.
   */
  function isInteractiveElement(el: EventTarget | null): boolean {
    if (!el) return false;
    const htmlEl = el as HTMLElement;
    const tag = htmlEl.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (htmlEl.isContentEditable) return true;
    if (htmlEl.closest?.('[contenteditable="true"]')) return true;
    return false;
  }

  /**
   * CLICK outside — dismiss the card and button.
   */
  document.addEventListener('mousedown', (e) => {
    // Don't dismiss if clicking our own shadow host
    if (e.target === hostEl) return;

    // Dismiss lookup button if clicked outside, but keep the card active
    if (activeBtn) {
      setTimeout(() => {
        removeLookupBtn();
      }, 0);
    }
  }, true);

  /**
   * ESCAPE — dismiss everything.
   */
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      dismissAll();
    }
  }, true);

  /**
   * SCROLL — dismiss lookup button with debounce.
   */
  window.addEventListener('scroll', () => {
    if (!activeBtn) return;
    clearTimeout(scrollDismissTimer);
    scrollDismissTimer = setTimeout(() => {
      removeLookupBtn();
    }, 150);
  }, { passive: true });

  /* ---------------------------------------------------------------- */
  /*  Startup log                                                      */
  /* ---------------------------------------------------------------- */

  console.log('[PersonPeek] Content script loaded.');
}
