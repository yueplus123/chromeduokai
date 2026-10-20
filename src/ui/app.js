const $ = (s) => document.querySelector(s);
const PALETTE = ['#4f8cff', '#e5534b', '#3fb950', '#d29922', '#a371f7', '#db61a2', '#39c5cf', '#f0883e'];
let S = { profiles: [], tabs: [], currentId: null };
let editingId = null;

const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
};

function render() {
  // 侧边栏
  const list = $('#plist');
  list.replaceChildren(...S.profiles.map((p) => {
    const row = el('div', { className: 'p' + (p.id === S.currentId ? ' active' : ''), title: p.note || p.name });
    row.onclick = () => hub.openProfile(p.id);
    const dot = el('div', { className: 'dot', textContent: (p.name || '?').slice(0, 1) });
    dot.style.background = p.color;
    const info = el('div', { className: 'pname' }, p.name,
      el('div', { className: 'pmeta', textContent: p.proxy ? '代理: ' + p.proxy.replace(/^\w+:\/\//, '') : '直连' }));
    const btns = el('div', { className: 'pbtns' });
    const edit = el('button', { textContent: '✎', title: '编辑' });
    edit.onclick = (e) => { e.stopPropagation(); openForm(p); };
    const close = el('button', { textContent: '⏻', title: '关闭该分身所有标签页' });
    close.onclick = (e) => { e.stopPropagation(); hub.closeProfileTabs(p.id); };
    const del = el('button', { textContent: '🗑', title: '删除分身(清除其数据)' });
    del.onclick = (e) => {
      e.stopPropagation();
      if (confirm(`删除分身「${p.name}」?其 Cookie 和登录数据会被清除。`)) hub.deleteProfile(p.id);
    };
    btns.append(edit, close, del);
    row.append(dot, info);
    if (p.tabCount) row.append(el('span', { className: 'badge', textContent: p.tabCount }));
    row.append(btns);
    return row;
  }));

  // 标签栏
  const has = !!S.currentId;
  $('#empty').hidden = has;
  $('#toolbar').style.visibility = has ? 'visible' : 'hidden';
  const tabs = $('#tabs');
  const nodes = S.tabs.map((t) => {
    const n = el('div', { className: 'tab' + (t.id === S.activeId ? ' active' : ''), title: t.title });
    n.onclick = () => hub.activateTab(t.id);
    const x = el('button', { className: 'x', textContent: '×' });
    x.onclick = (e) => { e.stopPropagation(); hub.closeTab(t.id); };
    n.append(el('span', { textContent: (t.loading ? '⏳ ' : '') + t.title }), x);
    return n;
  });
  if (has) {
    const nt = el('button', { className: 'newtab', textContent: '+', title: '新标签页' });
    nt.onclick = () => hub.newTab();
    nodes.push(nt);
  }
  tabs.replaceChildren(...nodes);

  // 工具栏
  $('#back').disabled = !S.canGoBack;
  $('#fwd').disabled = !S.canGoForward;
  const active = S.tabs.find((t) => t.id === S.activeId);
  if (document.activeElement !== $('#url')) $('#url').value = active ? active.url : '';
}

function openForm(p) {
  editingId = p ? p.id : null;
  const f = $('#form');
  $('#formTitle').textContent = p ? '编辑分身' : '新建分身';
  const d = p || { color: PALETTE[S.profiles.length % PALETTE.length], lang: 'zh-CN,zh;q=0.9,en;q=0.8', timezone: 'Asia/Shanghai' };
  for (const k of ['name', 'color', 'home', 'ua', 'lang', 'timezone', 'proxy', 'proxyUser', 'proxyPass', 'note']) {
    f.elements[k].value = d[k] || '';
  }
  f.elements.ua.placeholder = S.defaultUA || '';
  $('#modal').hidden = false;
  hub.modal(true);
  f.elements.name.focus();
}
function closeForm() { $('#modal').hidden = true; hub.modal(false); }

$('#addBtn').onclick = () => openForm(null);
$('#cancel').onclick = closeForm;
$('#form').onsubmit = async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  if (editingId) data.id = editingId;
  await hub.saveProfile(data);
  closeForm();
  if (editingId && editingId === S.currentId) { /* 已打开的标签页需重新打开才应用新的 UA/代理 */ }
};

$('#back').onclick = () => hub.back();
$('#fwd').onclick = () => hub.forward();
$('#reload').onclick = () => hub.reload();
$('#url').onkeydown = (e) => { if (e.key === 'Enter') { hub.go(e.target.value); e.target.blur(); } };
$('#url').onfocus = (e) => e.target.select();
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal').hidden) closeForm();
  if (e.ctrlKey && e.key === 't') { e.preventDefault(); hub.newTab(); }
  if (e.ctrlKey && e.key === 'l') { e.preventDefault(); $('#url').focus(); }
});

hub.onState((s) => { S = s; render(); });
hub.state().then((s) => { S = s; render(); });
