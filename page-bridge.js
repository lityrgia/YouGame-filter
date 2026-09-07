(() => {
  function extractForumId(html) {
    const page = new DOMParser().parseFromString(html, 'text/html');
    const containerKey = page.documentElement.dataset.containerKey || '';
    return containerKey.match(/^node-(\d+)$/)?.[1]
      || [...page.querySelectorAll('.p-breadcrumbs a[href*="/forums/"], .breadcrumbs a[href*="/forums/"]')]
        .map((link) => link.getAttribute('href')?.match(/\/forums\/(\d+)/)?.[1])
        .find(Boolean)
      || null;
  }

  window.addEventListener('ygff:resolve-thread', async (event) => {
    const { requestId, threadId } = event.detail || {};
    if (!requestId || !/^\d+$/.test(String(threadId))) return;
    let resolvedForumId = null;
    try {
      // Main world: запрос выглядит для сайта так же, как обычный запрос страницы.
      const response = await fetch(`/threads/${threadId}/`, { credentials: 'same-origin' });
      if (response.ok) resolvedForumId = extractForumId(await response.text());
    } catch { /* content script использует свои запасные варианты */ }
    window.dispatchEvent(new CustomEvent('ygff:thread-resolved', { detail: { requestId, forumId: resolvedForumId } }));
  });
})();
