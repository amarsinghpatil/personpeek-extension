/**
 * PersonPeek — Popup Script
 * 
 * Handles search functionality, result rendering, recent lookups,
 * and all UI state transitions for the extension popup.
 * 
 * Communicates with the service worker (background.js) via
 * chrome.runtime.sendMessage for data fetching and storage.
 */

'use strict';

// ─── DOM References ───────────────────────────────────────────
const searchForm       = document.getElementById('searchForm');
const searchInput      = document.getElementById('searchInput');
const searchBtn        = document.getElementById('searchBtn');
const loadingState     = document.getElementById('loadingState');
const errorState       = document.getElementById('errorState');
const errorMessage     = document.getElementById('errorMessage');
const resultState      = document.getElementById('resultState');
const recentState      = document.getElementById('recentState');
const emptyState       = document.getElementById('emptyState');
const backBtn          = document.getElementById('backBtn');
const clearHistoryBtn  = document.getElementById('clearHistoryBtn');
const recentList       = document.getElementById('recentList');

// Result card elements
const resultPhoto = document.getElementById('resultPhoto');
const resultName  = document.getElementById('resultName');
const resultDesc  = document.getElementById('resultDesc');
const resultFacts = document.getElementById('resultFacts');
const resultBio   = document.getElementById('resultBio');
const resultLink  = document.getElementById('resultLink');

// ─── State ────────────────────────────────────────────────────
/** @type {'idle'|'loading'|'result'|'error'} */
let currentView = 'idle';

// ─── Utility: Show / Hide Sections ───────────────────────────
/**
 * Transition the popup to a specific view state.
 * Only one of loading / error / result is shown at a time.
 * Recent and empty states are toggled separately.
 * @param {'idle'|'loading'|'result'|'error'} view
 */
function setView(view) {
  currentView = view;

  // Hide all dynamic sections first
  loadingState.classList.add('hidden');
  errorState.classList.add('hidden');
  resultState.classList.add('hidden');

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
 * @param {string} name — The person's name to search for.
 */
async function lookupPerson(name) {
  if (!name?.trim()) return;

  const query = name.trim();
  setView('loading');

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'lookupPerson',
      name: query,
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
 * @param {string} msg
 */
function showError(msg) {
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
 * @param {Object} data — Person data from the service worker.
 * @param {string} data.title
 * @param {string} [data.description]
 * @param {string} [data.thumbnail]
 * @param {string} [data.extract]
 * @param {string} [data.pageUrl]
 * @param {Object} [data.wikidataFacts]
 */
function renderResult(data) {
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
    const factEntries = [];
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
 * @param {Array} lookups — Array of person data objects.
 */
function renderRecentList(lookups) {
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
 * @param {string} str
 * @param {number} max
 * @returns {string}
 */
function truncate(str, max) {
  if (!str || str.length <= max) return str || '';
  return str.slice(0, max).trimEnd() + '…';
}

// ─── Initialization ──────────────────────────────────────────

/**
 * Initialize the popup on open.
 * - Auto-focus search input
 * - Load recent lookups
 */
function init() {
  // Auto-focus the search input for immediate typing
  searchInput.focus();

  // Load recent lookups (shows empty state if none)
  setView('idle');
}

// Run init when DOM is ready (it already is since script is at bottom)
init();
