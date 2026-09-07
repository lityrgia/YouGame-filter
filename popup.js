const forumPath = /^\/forums\/(\d+)(?:\/|$)/;
let currentForum = null;
const INITIAL_IGNORED_FORUMS = [
  { id: '1178', title: 'Майнкрафт' },
  { id: '1444', title: 'ИИ' }
];

async function settings() {
  const data = await chrome.storage.local.get(['ignoredForums', 'initialIgnoredForumsAdded']);
  if (data.initialIgnoredForumsAdded) return data.ignoredForums || [];
  const ignoredForums = [...new Map([...(data.ignoredForums || []), ...INITIAL_IGNORED_FORUMS]
    .map((forum) => [String(forum.id), forum])).values()];
  await chrome.storage.local.set({ ignoredForums, initialIgnoredForumsAdded: true });
  return ignoredForums;
}

async function render() {
  const ignored = await settings();
  document.querySelector('#count').textContent = ignored.length;
  document.querySelector('#empty').hidden = ignored.length > 0;
  document.querySelector('#ignored-list').replaceChildren(...ignored.map((forum) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${escapeHtml(forum.title || `Раздел ${forum.id}`)}</span>`;
    const remove = document.createElement('button');
    remove.className = 'icon-button'; remove.textContent = '×'; remove.title = 'Убрать из игнора';
    remove.onclick = () => save(ignored.filter((entry) => String(entry.id) !== String(forum.id)));
    li.append(remove); return li;
  }));

  const toggle = document.querySelector('#toggle-current');
  if (currentForum) {
    const isIgnored = ignored.some((forum) => String(forum.id) === currentForum.id);
    toggle.hidden = false;
    toggle.textContent = isIgnored ? 'Игнорируется' : 'Игнорировать раздел';
  }
}

function escapeHtml(value) { const el = document.createElement('span'); el.textContent = value; return el.innerHTML; }
async function save(ignoredForums) { await chrome.storage.local.set({ ignoredForums }); await render(); }

document.querySelector('#toggle-current').onclick = async () => {
  const ignored = await settings();
  const found = ignored.some((forum) => String(forum.id) === currentForum.id);
  await save(found ? ignored.filter((forum) => String(forum.id) !== currentForum.id) : [...ignored, currentForum]);
};
document.querySelector('#export').onclick = async () => {
  const ignoredForums = await settings();
  const data = JSON.stringify({ format: 'yougame-forum-filter', version: 1, ignoredForums }, null, 2);
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: 'yougame-forum-filter.json' });
  link.click(); URL.revokeObjectURL(url);
  document.querySelector('#status').textContent = 'Экспортировано.';
};
document.querySelector('#import').onchange = async (event) => {
  try {
    const file = event.target.files[0]; if (!file) return;
    const data = JSON.parse(await file.text());
    if (data.format !== 'yougame-forum-filter' || data.version !== 1 || !Array.isArray(data.ignoredForums)) throw new Error();
    const forums = [...new Map(data.ignoredForums.filter((forum) => /^\d+$/.test(String(forum?.id))).map((forum) => [String(forum.id), { id: String(forum.id), title: String(forum.title || `Раздел ${forum.id}`) }])).values()];
    await save(forums); document.querySelector('#status').textContent = 'Импортировано.';
  } catch { document.querySelector('#status').textContent = 'Неверный файл настроек.'; }
  event.target.value = '';
};
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.ignoredForums) render(); });

chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => {
  try {
    const url = new URL(tab.url);
    const id = url.pathname.match(forumPath)?.[1];
    if (id && /(^|\.)yougame\.biz$/i.test(url.hostname)) {
      currentForum = { id, title: `Раздел ${id}` };
      chrome.tabs.sendMessage(tab.id, { type: 'ygff-current-forum' })
        .then(async (forum) => {
          if (!forum?.id) return;
          currentForum = forum;
          // Обновляем старую запись, если раздел был добавлен до получения названия.
          const ignored = await settings();
          const matching = ignored.find((entry) => String(entry.id) === forum.id);
          if (matching && matching.title !== forum.title) {
            await chrome.storage.local.set({ ignoredForums: ignored.map((entry) => String(entry.id) === forum.id ? forum : entry) });
          }
          render();
        })
        .catch(() => {});
    }
  } catch { /* non-web browser page */ }
  render();
});
