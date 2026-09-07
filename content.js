(() => {
  const FORUM_URL = /^\/forums\/(\d+)(?:\/|$)/;
  const CREATE_THREAD_URL = /^\/forums\/(\d+)\/(?:create-thread|post-thread)(?:\/|$)/;
  const THREAD_URL = /\/threads\/(\d+)(?:\/|$)/;
  const CACHE_TTL = 1000 * 60 * 60 * 24 * 7;
  const FAILURE_CACHE_TTL = 1000 * 60 * 5;
  const THREAD_CACHE_VERSION = 6;
  const DEFAULT_IGNORED_FORUMS = [
    { id: '853', title: 'Исходники читов Minecraft' },
    { id: '860', title: 'Бесплатные читы Роблокс (ПК&телефон)' },
    { id: '1179', title: 'Маркетплейс Minecraft' }
  ];
  const DEFAULTS_VERSION = 2;
  const PREVIOUS_DEFAULT_IDS = new Set(['1178', '1444']);
  let ignoredForumIds = new Set();
  let threadForums = {};
  const pendingResolutions = new Map();
  let refreshTimer;
  let refreshRunning = false;
  let refreshRequested = false;
  let feedRevision = 0;
  let cacheDirty = false;

  function pathOf(link) {
    try { return new URL(link.href, location.origin).pathname; } catch { return ''; }
  }

  function forumIdFromPath(pathname = location.pathname) {
    return pathname.match(FORUM_URL)?.[1] ?? null;
  }

  function currentForum() {
    const id = forumIdFromPath();
    if (!id) return null;
    const title = document.querySelector('h1.p-title-value, h1')?.textContent?.trim();
    return { id, title: title || `Раздел ${id}` };
  }

  async function getIgnoredForums() {
    const data = await chrome.storage.local.get(['ignoredForums', 'defaultIgnoredForumsVersion']);
    if (data.defaultIgnoredForumsVersion >= DEFAULTS_VERSION) return data.ignoredForums || [];
    const previousForums = (data.ignoredForums || []).filter(
      (forum) => !PREVIOUS_DEFAULT_IDS.has(String(forum.id))
    );
    const forums = [...new Map([...previousForums, ...DEFAULT_IGNORED_FORUMS]
      .map((forum) => [String(forum.id), forum])).values()];
    await chrome.storage.local.set({ ignoredForums: forums, defaultIgnoredForumsVersion: DEFAULTS_VERSION });
    return forums;
  }

  function isFilteredPage() {
    const path = location.pathname;
    return path === '/' || path === '/featured/' || /^\/whats-new\/(?:$|posts(?:\/\d+)?\/?$|latest-activity\/?$)/.test(path);
  }

  function threadIdFromItem(item) {
    const classMatch = item.className.match(/(?:^|\s)thread--(\d+)(?:\s|$)/);
    if (classMatch) return classMatch[1];
    const link = item.querySelector('a[href*="/threads/"]');
    return link ? pathOf(link).match(THREAD_URL)?.[1] : null;
  }

  function findForumIdInHtml(html) {
    const page = new DOMParser().parseFromString(html, 'text/html');
    const containerKey = page.documentElement.dataset.containerKey || '';
    const breadcrumbLinks = page.querySelectorAll('.p-breadcrumbs a[href*="/forums/"], .breadcrumbs a[href*="/forums/"]');
    const forumLink = [...breadcrumbLinks].find((link) => forumIdFromPath(pathOf(link)));
    return containerKey.match(/^node-(\d+)$/)?.[1]
      || (forumLink && forumIdFromPath(pathOf(forumLink)))
      || html.match(/data-container-key=(?:\\?["'])node-(\d+)(?:\\?["'])/i)?.[1]
      || null;
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function fetchForumId(url, options, timeoutMs) {
    try {
      const response = await fetchWithTimeout(url, options, timeoutMs);
      return response.ok ? findForumIdInHtml(await response.text()) : null;
    } catch {
      return null;
    }
  }

  function resolveThreadForum(threadId, previewUrl) {
    const cached = getCachedForum(threadId);
    if (cached.found) return Promise.resolve(cached.forumId);
    if (pendingResolutions.has(threadId)) return pendingResolutions.get(threadId);

    const resolution = (async () => {
      try {
        // Content script работает отдельно от JavaScript YouGame, поэтому эти
        // запросы не включают индикатор загрузки и не блокируют вкладки сайта.
        let forumId = await fetchForumId(
          `/threads/${threadId}/`,
          { credentials: 'include' },
          4000
        );
        if (!forumId && previewUrl) {
          forumId = await fetchForumId(previewUrl, {
            credentials: 'include',
            headers: { 'X-Requested-With': 'XMLHttpRequest' }
          }, 3000);
        }
        if (!forumId) {
          threadForums[threadId] = { forumId: null, savedAt: Date.now() };
          cacheDirty = true;
          return null;
        }
        threadForums[threadId] = { forumId: String(forumId), savedAt: Date.now() };
        cacheDirty = true;
        return String(forumId);
      } catch {
        threadForums[threadId] = { forumId: null, savedAt: Date.now() };
        cacheDirty = true;
        return null;
      } finally {
        pendingResolutions.delete(threadId);
      }
    })();
    pendingResolutions.set(threadId, resolution);
    return resolution;
  }

  function getCachedForum(threadId) {
    const cached = threadForums[threadId];
    if (!cached) return { found: false, forumId: null };
    const ttl = cached.forumId ? CACHE_TTL : FAILURE_CACHE_TTL;
    if (Date.now() - cached.savedAt >= ttl) return { found: false, forumId: null };
    return { found: true, forumId: cached.forumId ? String(cached.forumId) : null };
  }

  function setThreadVisibility(item, forumId) {
    item.classList.toggle('ygff-hidden-thread', Boolean(forumId && ignoredForumIds.has(forumId)));
  }

  function applyCachedThreads() {
    if (!isFilteredPage()) return;
    document.querySelectorAll('.item--thread, .structItem--thread, [data-thread-id], .threadItem').forEach((item) => {
      const threadId = threadIdFromItem(item);
      if (!threadId) return;
      const cached = getCachedForum(threadId);
      if (cached.found) {
        setThreadVisibility(item, cached.forumId);
      } else {
        item.classList.remove('ygff-hidden-thread');
      }
    });
    recalculateMosaic();
  }

  async function filterThreads(revision) {
    if (!isFilteredPage()) return true;
    const items = [...document.querySelectorAll('.item--thread, .structItem--thread, [data-thread-id], .threadItem')];
    const unresolved = [];

    // Всё известное применяем сразу. Для AJAX-вкладок этот код вызывается из
    // MutationObserver до следующего кадра, поэтому кэш не вызывает скачка.
    for (const item of items) {
      const threadId = threadIdFromItem(item);
      if (!threadId) continue;
      const cached = getCachedForum(threadId);
      if (cached.found) {
        setThreadVisibility(item, cached.forumId);
      } else {
        item.classList.remove('ygff-hidden-thread');
        unresolved.push({
          item,
          threadId,
          previewUrl: item.querySelector('[data-preview-url]')?.getAttribute('data-preview-url')
        });
      }
    }
    recalculateMosaic();

    const resolved = [];
    let nextItem = 0;
    const filterItem = async () => {
      const entry = unresolved[nextItem++];
      if (!entry || revision !== feedRevision) return;
      const forumId = await resolveThreadForum(entry.threadId, entry.previewUrl);
      resolved.push({ ...entry, forumId });
    };
    // Фоновая проверка не должна забивать соединения самого YouGame.
    await Promise.all(Array.from({ length: Math.min(3, unresolved.length) }, async () => {
      while (nextItem < unresolved.length && revision === feedRevision) await filterItem();
    }));
    if (revision !== feedRevision) return false;

    // Не скрываем элементы по одному: фильтр и новая мозаика попадают в один
    // кадр, поэтому список меняется только один раз.
    for (const { item, forumId } of resolved) {
      if (item.isConnected) setThreadVisibility(item, forumId);
    }
    recalculateMosaic();
    return true;
  }

  function recalculateMosaic() {
    let visibleIndex = 0;
    document.querySelectorAll('.fsp .tabGroup.tabGroup--threads .tabGroup-content .item--thread').forEach((item) => {
      item.classList.remove('ygff-row-light', 'ygff-row-dark');
      item.style.removeProperty('background');
      if (item.classList.contains('ygff-hidden-thread')) return;
      visibleIndex += 1;
      item.classList.add(visibleIndex % 2 === 1 ? 'ygff-row-light' : 'ygff-row-dark');
    });
  }

  function addForumButton() {
    const forumId = forumIdFromPath();
    if (!forumId) return;
    const existing = document.querySelector('.ygff-ignore-button');
    if (existing) {
      renderForumButton(existing, forumId);
      return;
    }

    const createButton = [...document.querySelectorAll('a[href]')].find(
      (link) => CREATE_THREAD_URL.test(pathOf(link)) || /создать\s*(тему|обсуждение)|create\s*thread/i.test(link.textContent)
    );
    if (!createButton) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = `${createButton.className} ygff-ignore-button`;

    button.addEventListener('click', async () => {
      if (button.disabled) return;
      button.disabled = true;
      // У YouGame для сфокусированной .button используется белый стиль.
      // Убираем только фокус, а не состояние игнорирования.
      button.blur();
      try {
        const ignoredForums = await getIgnoredForums();
        const next = new Map(ignoredForums.map((forum) => [String(forum.id), forum]));
        if (next.has(forumId)) {
          next.delete(forumId);
        } else {
          next.set(forumId, currentForum());
        }
        await chrome.storage.local.set({ ignoredForums: [...next.values()] });
      } finally {
        button.disabled = false;
      }
    });

    createButton.before(button);
    renderForumButton(button, forumId);
  }

  function renderForumButton(button, forumId) {
    const isIgnored = ignoredForumIds.has(forumId);
    button.textContent = isIgnored ? 'Игнорируется' : 'Игнорировать раздел';
    button.title = isIgnored
      ? 'Нажмите, чтобы отменить игнорирование'
      : 'Скрывать темы этого раздела в лентах';
    button.setAttribute('aria-pressed', String(isIgnored));
  }

  async function refreshOnce(revision) {
    const ignoredForums = await getIgnoredForums();
    const cache = await chrome.storage.local.get(['threadForums', 'threadForumCacheVersion']);
    const cachedThreads = cache.threadForumCacheVersion === THREAD_CACHE_VERSION ? (cache.threadForums || {}) : {};
    if (cache.threadForumCacheVersion !== THREAD_CACHE_VERSION) {
      await chrome.storage.local.set({ threadForums: {}, threadForumCacheVersion: THREAD_CACHE_VERSION });
    }
    ignoredForumIds = new Set(ignoredForums.map((forum) => String(forum.id)));
    // Не затираем результат запросов, которые уже завершились в текущей вкладке.
    threadForums = { ...cachedThreads, ...threadForums };
    const completed = await filterThreads(revision);
    if (cacheDirty) {
      cacheDirty = false;
      const latest = await chrome.storage.local.get('threadForums');
      threadForums = { ...(latest.threadForums || {}), ...threadForums };
      threadForums = Object.fromEntries(Object.entries(threadForums)
        .filter(([threadId, entry]) => /^\d+$/.test(threadId) && Number.isFinite(entry?.savedAt))
        .sort(([, left], [, right]) => right.savedAt - left.savedAt)
        .slice(0, 3000));
      await chrome.storage.local.set({ threadForums });
    }
    addForumButton();
    return completed;
  }

  async function runRefreshLoop() {
    if (refreshRunning) return;
    refreshRunning = true;
    try {
      while (refreshRequested) {
        refreshRequested = false;
        const revision = feedRevision;
        await refreshOnce(revision);
      }
    } catch {
      // Временная ошибка storage или сети не должна ломать интерфейс сайта.
      // Следующая DOM-мутация или смена настройки запустит новый проход.
    } finally {
      refreshRunning = false;
      if (refreshRequested) {
        scheduleRefresh(0);
      }
    }
  }

  function scheduleRefresh(delay = 35) {
    refreshRequested = true;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(runRefreshLoop, delay);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.ignoredForums) return;
    feedRevision += 1;
    scheduleRefresh(0);
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'ygff-current-forum') sendResponse(currentForum());
  });

  function mutationAffectsThreads(mutation) {
    if (!(mutation.target instanceof Element)) return false;
    const listSelector = '.fsp .tabGroup--threads .tabGroup-content, .structItemContainer, .threadItemList';
    const threadSelector = '.item--thread, .structItem--thread, [data-thread-id], .threadItem';
    const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
    if (mutation.target.closest(listSelector)) return nodes.some((node) => {
      if (!(node instanceof Element)) return false;
      return node.matches(`${threadSelector}, .content`) || Boolean(node.querySelector(threadSelector));
    });
    // YouGame может заменить целиком сам .tabGroup-content, а не его детей.
    return nodes.some((node) => node instanceof Element
      && (node.matches(listSelector) || Boolean(node.querySelector(listSelector)))
      && (node.matches(threadSelector) || Boolean(node.querySelector(threadSelector))));
  }

  new MutationObserver((mutations) => {
    if (!isFilteredPage() || !mutations.some(mutationAffectsThreads)) return;
    // Синхронно применяем уже известные записи до отрисовки новой AJAX-ленты.
    applyCachedThreads();
    feedRevision += 1;
    scheduleRefresh();
  }).observe(document.documentElement, { childList: true, subtree: true });
  scheduleRefresh(0);
})();
