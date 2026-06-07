/**
 * PersonPeek — Content Script
 * ============================
 * Injected into every page.  Detects person-name selection via double-click or
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

if (window.__personPeekInjected) {
  // Already running in this frame.
} else {
  window.__personPeekInjected = true;

  /* ---------------------------------------------------------------- */
  /*  Shadow DOM host setup                                            */
  /* ---------------------------------------------------------------- */

  const hostEl = document.createElement('div');
  hostEl.id = 'personpeek-host';
  hostEl.style.cssText = 'all:initial; position:fixed; z-index:2147483647; top:0; left:0; width:0; height:0; pointer-events:none;';
  document.documentElement.appendChild(hostEl);

  const shadow = hostEl.attachShadow({ mode: 'closed' });

  /** Load our stylesheet into the shadow root */
  (async function injectStyles() {
    try {
      const cssUrl = chrome.runtime.getURL('content/content.css');
      const res = await fetch(cssUrl);
      const cssText = await res.text();
      const style = document.createElement('style');
      style.textContent = cssText;
      shadow.appendChild(style);
    } catch (err) {
      console.warn('[PersonPeek] Failed to load styles:', err);
    }
  })();

  /* ---------------------------------------------------------------- */
  /*  State                                                            */
  /* ---------------------------------------------------------------- */

  let isDoubleClick = false;    // flag to prevent mouseup from also firing
  let activeCard = null;        // reference to the currently-open card element
  let activeBtn = null;         // reference to the floating lookup button
  let scrollDismissTimer = null;

  /* ---------------------------------------------------------------- */
  /*  Utilities                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Validate that the selected text looks like a person's name.
   * Rules: 1-5 words, 2-50 characters, only letters/hyphens/apostrophes/spaces/dots.
   * @param {string} text
   * @returns {boolean}
   */
  function isValidName(text) {
    if (!text) return false;
    const trimmed = text.trim();
    if (trimmed.length < 2 || trimmed.length > 60) return false;
    const words = trimmed.split(/\s+/);
    if (words.length < 1 || words.length > 5) return false;
    // Loose check — allow unicode letters, hyphens, apostrophes, dots
    return /^[\p{L}\s'.·\-]+$/u.test(trimmed);
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
   * @param {number} pos   desired position
   * @param {number} size  element dimension
   * @param {number} max   viewport dimension
   * @param {number} margin
   * @returns {number}
   */
  function clamp(pos, size, max, margin = 12) {
    return Math.max(margin, Math.min(pos, max - size - margin));
  }

  /* ---------------------------------------------------------------- */
  /*  Lookup button                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Show a small floating 🔍 button near the text selection.
   * @param {DOMRect} rect — bounding rect of the selection
   * @param {string} text  — the selected text
   */
  function showLookupBtn(rect, text) {
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
      showInfoCard(rect, text);
    });

    shadow.appendChild(btn);
    activeBtn = btn;
  }

  /* ---------------------------------------------------------------- */
  /*  Info Card                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Show the info card near the selection rect.
   * Immediately shows a loading state, then fetches data from the background
   * service worker and renders the full card.
   * @param {DOMRect} rect
   * @param {string} name
   */
  function showInfoCard(rect, name) {
    removeCard();
    removeLookupBtn();

    const card = document.createElement('div');
    card.className = 'pp-card';
    card.style.pointerEvents = 'auto';

    // --- Position card near the selection ---
    const cardWidth = 400;
    const estimatedHeight = 320;

    let left = clamp(rect.left + rect.width / 2 - cardWidth / 2, cardWidth, window.innerWidth);

    // Show below selection if there's room, otherwise above
    let top;
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceBelow >= estimatedHeight + 16) {
      top = rect.bottom + 12;
    } else if (rect.top >= estimatedHeight + 16) {
      top = rect.top - estimatedHeight - 12;
    } else {
      top = Math.max(12, (window.innerHeight - estimatedHeight) / 2);
    }

    card.style.left = `${left}px`;
    card.style.top = `${Math.max(8, top)}px`;

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

    // --- Fetch data ---
    chrome.runtime.sendMessage({ action: 'lookupPerson', name: name.trim() }, (response) => {
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
  }

  /**
   * Render a "not found" / error state into the card.
   * @param {HTMLElement} card
   * @param {string} message
   */
  function renderError(card, message) {
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
   * @param {HTMLElement} card
   * @param {object} data
   */
  function renderResult(card, data) {
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

    // --- Facts chips ---
    const factItems = [];
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
      inner.appendChild(divider);

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
      inner.appendChild(factsContainer);
    }

    // --- Bio ---
    if (data.extract) {
      const divider = document.createElement('hr');
      divider.className = 'pp-card-divider';
      inner.appendChild(divider);

      // Limit to ~3 sentences for brevity
      const sentences = data.extract.match(/[^.!?]*[.!?]+/g) || [data.extract];
      const shortBio = sentences.slice(0, 3).join(' ');

      const bioDiv = document.createElement('div');
      bioDiv.className = 'pp-card-bio';
      bioDiv.textContent = shortBio;
      inner.appendChild(bioDiv);
    }

    // --- Footer ---
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

    inner.appendChild(footer);

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
    const text = sel?.toString().trim();

    if (!text || !isValidName(text)) return;
    // Extra check: 2-50 chars, 1-5 words
    if (text.length < 2 || text.length > 50 || text.split(/\s+/).length > 5) return;

    // Set flag so mouseup doesn't also fire
    isDoubleClick = true;
    setTimeout(() => { isDoubleClick = false; }, 300);

    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    showInfoCard(rect, text);
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
    if (e.target === hostEl || hostEl.contains(e.target)) return;

    // Ignore interactive elements
    if (isInteractiveElement(e.target)) return;

    // Small delay to let selection finalize
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel?.toString().trim();

      if (!text || !isValidName(text)) {
        // No valid selection — dismiss button if visible (but keep card)
        removeLookupBtn();
        return;
      }

      if (text.length < 2 || text.length > 60 || text.split(/\s+/).length > 5) {
        removeLookupBtn();
        return;
      }

      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      showLookupBtn(rect, text);
    }, 10);
  }, true);

  /**
   * Check if an element is an interactive input where we shouldn't intercept.
   * @param {Element} el
   * @returns {boolean}
   */
  function isInteractiveElement(el) {
    if (!el) return false;
    const tag = el.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (el.isContentEditable) return true;
    if (el.closest?.('[contenteditable="true"]')) return true;
    return false;
  }

  /**
   * CLICK outside — dismiss the card and button.
   */
  document.addEventListener('mousedown', (e) => {
    // Don't dismiss if clicking our own shadow host
    if (e.target === hostEl) return;

    // Check if any card or button is active
    if (activeCard || activeBtn) {
      // Small delay to let the click propagate into shadow DOM first
      setTimeout(() => {
        // If click was NOT inside our shadow elements, dismiss
        // (shadow DOM click handlers call stopPropagation, so if we reach here it's outside)
        dismissAll();
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
   * SCROLL — dismiss with debounce.
   */
  window.addEventListener('scroll', () => {
    if (!activeCard && !activeBtn) return;
    clearTimeout(scrollDismissTimer);
    scrollDismissTimer = setTimeout(() => {
      dismissAll();
    }, 150);
  }, { passive: true });

  /* ---------------------------------------------------------------- */
  /*  Startup log                                                      */
  /* ---------------------------------------------------------------- */

  console.log('[PersonPeek] Content script loaded.');
}
