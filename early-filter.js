(() => {
  const THREAD_CACHE_VERSION = 6;
  const styleId = 'ygff-early-filter';

  document.documentElement.classList.add('ygff-mosaic-preparing');

  function recalculateMosaic(hiddenThreadIds) {
    let visibleIndex = 0;
    document.querySelectorAll('.fsp .tabGroup.tabGroup--threads .tabGroup-content .item--thread').forEach((item) => {
      const threadId = item.className.match(/(?:^|\s)thread--(\d+)(?:\s|$)/)?.[1];
      if (threadId && hiddenThreadIds.has(threadId)) return;
      visibleIndex += 1;
      item.style.setProperty('background', visibleIndex % 2 === 1 ? '#2E3B42' : 'transparent', 'important');
    });
  }

  async function applyEarlyFilter() {
    const data = await chrome.storage.local.get(['ignoredForums', 'threadForums', 'threadForumCacheVersion']);
    try {
      const ignored = new Set((data.ignoredForums || []).map((forum) => String(forum.id)));
      const threadIds = data.threadForumCacheVersion === THREAD_CACHE_VERSION
        ? Object.entries(data.threadForums || [])
          .filter(([, entry]) => ignored.has(String(entry?.forumId)))
          .map(([threadId]) => threadId)
          .filter((threadId) => /^\d+$/.test(threadId))
        : [];
      const hiddenThreadIds = new Set(threadIds);
      if (threadIds.length) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = threadIds.map((threadId) => `.thread--${threadId}`).join(',') + '{display:none!important}';
        (document.head || document.documentElement).append(style);
      }

      let scheduled = false;
      let initialMosaicApplied = false;
      const scheduleMosaic = () => {
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(() => {
          scheduled = false;
          recalculateMosaic(hiddenThreadIds);
          if (!initialMosaicApplied) {
            initialMosaicApplied = true;
            document.documentElement.classList.remove('ygff-mosaic-preparing');
          }
        });
      };
      const observer = new MutationObserver(scheduleMosaic);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      window.addEventListener('load', () => observer.disconnect(), { once: true });
      scheduleMosaic();
    } catch {
      document.documentElement.classList.remove('ygff-mosaic-preparing');
    }
  }

  applyEarlyFilter();
})();
