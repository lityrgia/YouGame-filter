(() => {
  const FORUM_URL = /^\/forums\/(\d+)(?:\/|$)/;
  const CREATE_THREAD_URL = /^\/forums\/(\d+)\/(?:create-thread|post-thread)(?:\/|$)/;
  const THREAD_URL = /\/threads\/(\d+)(?:\/|$)/;
  const CACHE_TTL = 1000 * 60 * 60 * 12;
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
  const resolving = new Set();
  let refreshTimer;
  let bridgeAvailable = false;

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
    const forumLink = [...breadcrumbLinks, ...page.querySelectorAll('a[href*="/forums/"]')]
      .find((link) => forumIdFromPath(pathOf(link)));
    return containerKey.match(/^node-(\d+)$/)?.[1]
      || (forumLink && forumIdFromPath(pathOf(forumLink)))
      || html.match(/(?:\\)?\/forums(?:\\)?\/(\d{1,6})/i)?.[1]
      || html.match(/["'](?:forum|node)[_-]?id["']\s*[:=]\s*["']?(\d{1,6})/i)?.[1]
      || null;
  }

  function resolveThroughPage(threadId) {
    return new Promise((resolve) => {
      const requestId = `${threadId}-${crypto.randomUUID()}`;
      const onResolved = (event) => {
        if (event.detail?.requestId !== requestId) return;
        window.removeEventListener('ygff:thread-resolved', onResolved);
        resolve(event.detail.forumId || null);
      };
      window.addEventListener('ygff:thread-resolved', onResolved);
      window.dispatchEvent(new CustomEvent('ygff:resolve-thread', { detail: { requestId, threadId } }));
      setTimeout(() => {
        window.removeEventListener('ygff:thread-resolved', onResolved);
        resolve(null);
      }, 2500);
    });
  }

  async function resolveThreadForum(threadId, previewUrl) {
    const cached = threadForums[threadId];
    if (cached && Date.now() - cached.savedAt < CACHE_TTL) return cached.forumId;
    if (resolving.has(threadId)) return null;
    resolving.add(threadId);
    try {
      let forumId = bridgeAvailable ? await resolveThroughPage(threadId) : null;
      if (forumId) {
        threadForums[threadId] = { forumId, savedAt: Date.now() };
        await chrome.storage.local.set({ threadForums });
        return forumId;
      }
      // Content scripts работают в изолированном мире. `include` гарантирует,
      // что YouGame получит те же сессионные и anti-bot cookie, что и вкладка.
      const response = await fetch(`/threads/${threadId}/`, { credentials: 'include' });
      forumId = response.ok ? findForumIdInHtml(await response.text()) : null;
      // Такой же endpoint использует всплывающее превью при наведении на тему.
      // Ответ может быть HTML или JSON с HTML, поэтому разбираем текст целиком.
      if (!forumId && previewUrl) {
        const preview = await fetch(previewUrl, {
          credentials: 'include',
          headers: { 'X-Requested-With': 'XMLHttpRequest' }
        });
        if (preview.ok) forumId = findForumIdInHtml(await preview.text());
      }
      if (!forumId) return null;
      threadForums[threadId] = { forumId, savedAt: Date.now() };
      await chrome.storage.local.set({ threadForums });
      return forumId;
    } catch {
      return null;
    } finally {
      resolving.delete(threadId);
    }
  }

  async function filterThreads() {
    if (!isFilteredPage()) return;
    const items = document.querySelectorAll('.item--thread, .structItem--thread, [data-thread-id], .threadItem');
    for (const item of items) {
      const threadId = threadIdFromItem(item);
      if (!threadId) continue;
      const previewUrl = item.querySelector('[data-preview-url]')?.getAttribute('data-preview-url');
      const forumId = await resolveThreadForum(threadId, previewUrl);
      item.classList.toggle('ygff-hidden-thread', Boolean(forumId && ignoredForumIds.has(forumId)));
    }
    recalculateMosaic();
  }

  function recalculateMosaic() {
    let visibleIndex = 0;
    document.querySelectorAll('.fsp .tabGroup.tabGroup--threads .tabGroup-content .item--thread').forEach((item) => {
      if (item.classList.contains('ygff-hidden-thread')) return;
      visibleIndex += 1;
      item.style.setProperty('background', visibleIndex % 2 === 1 ? '#2E3B42' : 'transparent', 'important');
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
      // У YouGame для сфокусированной .button используется белый стиль.
      // Убираем только фокус, а не состояние игнорирования.
      button.blur();
      const ignoredForums = await getIgnoredForums();
      const next = new Map(ignoredForums.map((forum) => [String(forum.id), forum]));
      if (next.has(forumId)) {
        next.delete(forumId);
      } else {
        next.set(forumId, currentForum());
      }
      await chrome.storage.local.set({ ignoredForums: [...next.values()] });
      await refresh();
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

  async function refresh() {
    // page-bridge.js загружается из manifest в MAIN world ещё на document_start.
    bridgeAvailable = true;
    const ignoredForums = await getIgnoredForums();
    const cache = await chrome.storage.local.get(['threadForums', 'threadForumCacheVersion']);
    const cachedThreads = cache.threadForumCacheVersion === THREAD_CACHE_VERSION ? (cache.threadForums || {}) : {};
    if (cache.threadForumCacheVersion !== THREAD_CACHE_VERSION) {
      await chrome.storage.local.set({ threadForums: {}, threadForumCacheVersion: THREAD_CACHE_VERSION });
    }
    ignoredForumIds = new Set(ignoredForums.map((forum) => String(forum.id)));
    threadForums = cachedThreads;
    await filterThreads();
    // Ранний фильтр нужен только до загрузки; далее список обновляет основной скрипт.
    document.getElementById('ygff-early-filter')?.remove();
    addForumButton();
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 80);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.ignoredForums) refresh();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'ygff-current-forum') sendResponse(currentForum());
  });

  new MutationObserver(scheduleRefresh).observe(document.documentElement, { childList: true, subtree: true });
  refresh();
})();
