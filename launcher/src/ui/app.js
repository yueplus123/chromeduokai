const $ = (s) => document.querySelector(s);
const PALETTE = ['#0B6E4F', '#1F4FD8', '#B4532A', '#7A3FA0', '#2F6F8F', '#5B6159', '#A3261E', '#8A6D1C'];
let S = { profiles: [], cards: [], chromeOk: true };
let view = 'profiles';
let editingId = null;
let editingCardId = null;
let formExts = [];

const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
};

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, 2600);
}

const CARD_BTNS = [['number', '卡号'], ['exp', '期限'], ['cvv', 'CVV'], ['holder', '持卡人']];
const svg = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };
const ICON = {
  grip: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/><circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/></svg>',
  stop: '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
  edit: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  more: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  card: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>',
  trash: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
};

// 一张卡的复制按钮(分身卡片和卡库页共用),缺的字段按钮置灰
function copyButtons(c) {
  return CARD_BTNS.map(([field, label]) => {
    const missing = (field === 'cvv' && !c.hasCvv) || (field === 'exp' && !c.exp) || (field === 'holder' && !c.holder);
    const b = el('button', { textContent: label, disabled: missing || c.broken, title: missing ? '这张卡没有录入' + label : '复制' + label });
    b.onclick = async (e) => {
      e.stopPropagation();
      const r = await launcher.copyCard(c.id, field);
      toast(r.error || `已复制${label},${r.seconds} 秒后自动清除剪贴板`);
    };
    return b;
  });
}

// 头像文字:GPT-01 → G1,Claude 3 → C3,中文名取第一个字
function initials(name) {
  const m = /^([A-Za-z])[A-Za-z]*[\s_-]*0*(\d{1,2})/.exec(name || '');
  if (m) return (m[1].toUpperCase() + m[2]).slice(0, 3);
  return (name || '?').trim().slice(0, /^[A-Za-z]/.test(name || '') ? 2 : 1);
}

// 分配了多张卡的分身:记住当前显示第几张
const cardPick = new Map();

function cardBox(p) {
  const cards = p.cardIds.map((id) => S.cards.find((c) => c.id === id)).filter(Boolean);
  if (!cards.length) {
    return el('div', { className: 'cardbox empty' },
      el('div', { className: 'line' }, svg(ICON.card), el('span', { className: 'lbl', textContent: '未分配卡(在卡库里分配)' })));
  }
  const i = (cardPick.get(p.id) || 0) % cards.length;
  const c = cards[i];
  const line = el('div', { className: 'line' }, svg(ICON.card),
    el('span', { className: 'lbl', textContent: c.broken ? `${c.label}:无法解密,请重新录入` : `${c.label} ••${c.last4}`, title: c.label }));
  if (cards.length > 1) {
    const sw = el('button', { className: 'swap', textContent: `${i + 1}/${cards.length} 换`, title: '切换到这个分身的下一张卡' });
    sw.onclick = (e) => { e.stopPropagation(); cardPick.set(p.id, i + 1); render(); };
    line.append(sw);
  }
  return el('div', { className: 'cardbox' }, line, el('div', { className: 'copies' }, ...copyButtons(c)));
}

// ---------- ⋯ 更多操作菜单 ----------
function openMenu(anchor, items) {
  const m = $('#menu');
  m.replaceChildren(...items.map(([label, fn, cls]) => {
    const b = el('button', { textContent: label, className: cls || '' });
    b.onclick = () => { closeMenu(); fn(); };
    return b;
  }));
  m.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.min(r.right - w, innerWidth - w - 8) + 'px';
  m.style.top = (r.bottom + 4 + h > innerHeight ? r.top - h - 4 : r.bottom + 4) + 'px';
}
function closeMenu() { $('#menu').hidden = true; }
document.addEventListener('mousedown', (e) => { if (!$('#menu').hidden && !$('#menu').contains(e.target)) closeMenu(); });

// ---------- 拖动排序 ----------
let dragId = null;
function bindDrag(card, p) {
  card.draggable = true;
  card.addEventListener('dragstart', (e) => {
    dragId = p.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', p.id);
    requestAnimationFrame(() => card.classList.add('dragging'));
  });
  card.addEventListener('dragend', () => {
    dragId = null;
    document.querySelectorAll('.card.over, .card.dragging').forEach((n) => n.classList.remove('over', 'dragging'));
  });
  card.addEventListener('dragover', (e) => {
    if (!dragId || dragId === p.id) return;
    e.preventDefault();
    card.classList.add('over');
  });
  card.addEventListener('dragleave', () => card.classList.remove('over'));
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    card.classList.remove('over');
    if (!dragId || dragId === p.id) return;
    // 把拖动的分身放到目标位置(往后拖放在目标之后,往前拖放在目标之前)
    const ids = S.profiles.map((x) => x.id);
    const from = ids.indexOf(dragId), to = ids.indexOf(p.id);
    ids.splice(from, 1);
    ids.splice(to, 0, dragId);
    S.profiles = ids.map((id) => S.profiles.find((x) => x.id === id));
    render();
    launcher.reorder(ids);
  });
}

function renderProfiles() {
  const q = $('#search').value.trim().toLowerCase();
  const list = S.profiles.filter((p) => !q || [p.name, p.note, p.dir].join('\n').toLowerCase().includes(q));
  $('#empty').hidden = S.profiles.length > 0;
  $('#grid').hidden = S.profiles.length === 0;
  $('#dragHint').hidden = S.profiles.length < 2;

  $('#chromeBtn').classList.toggle('bad', !S.chromeOk);
  $('#chromeBtn').title = S.chromeOk ? `${S.chromePath}\n点击更改 Chrome 路径` : '没有找到 chrome.exe,点击手动选择';
  const warn = $('#warn');
  warn.hidden = S.chromeOk;
  warn.textContent = '没有找到 chrome.exe,请点右上角「Chrome」按钮手动选择。';

  $('#grid').replaceChildren(...list.map((p) => {
    const on = !!p.pid;
    const card = el('div', { className: 'card' + (on ? ' on' : '') });

    const av = el('div', { className: 'avatar', textContent: initials(p.name) });
    av.style.background = p.color || '#0B6E4F';
    card.append(el('div', { className: 'head' }, av,
      el('div', { className: 'who' },
        el('span', { className: 'pname', textContent: p.name, title: `${p.name}\n${p.dir}` }),
        el('span', { className: 'status' }, el('i'), on ? '运行中' : '未运行')),
      el('span', { className: 'grip', title: '拖动排序' }, svg(ICON.grip))));

    const tags = el('div', { className: 'tags' });
    tags.append(p.mode === 'incognito' ? el('span', { className: 'tag inc', textContent: '无痕' }) : el('span', { className: 'tag normal', textContent: '普通' }));
    if (p.extensions.length) tags.append(el('span', { className: 'tag', textContent: `插件 ${p.extensions.length}`, title: p.extensions.join('\n') }));
    if (p.home) tags.append(el('span', { className: 'tag', textContent: '起始页', title: p.home }));
    if (p.extraArgs) tags.append(el('span', { className: 'tag', textContent: '参数', title: p.extraArgs }));
    if (!p.dirExists) tags.append(el('span', { className: 'tag bad', textContent: '新文件夹', title: '数据文件夹不存在,首次启动时会新建\n' + p.dir }));
    card.append(tags);

    card.append(el('div', { className: 'note' + (p.note ? '' : ' empty'), textContent: p.note || '无备注', title: p.note || '' }));
    card.append(cardBox(p));

    const open = el('button', { className: 'main' + (on ? '' : ' primary'), textContent: on ? '新窗口' : '启动', disabled: !S.chromeOk });
    open.onclick = async () => { const r = await launcher.launch(p.id); if (r && r.error) toast(r.error); };
    const btns = el('div', { className: 'btns' }, open);
    if (on) {
      const close = el('button', { className: 'sq', title: '关闭(等同点窗口关闭按钮)', ariaLabel: '关闭' }, svg(ICON.stop));
      close.onclick = () => launcher.close(p.id, false);
      btns.append(close);
    }
    const edit = el('button', { className: 'sq', title: '编辑(插件、窗口类型等)', ariaLabel: '编辑' }, svg(ICON.edit));
    edit.onclick = () => openForm(p);
    const more = el('button', { className: 'sq', title: '更多操作', ariaLabel: '更多操作' }, svg(ICON.more));
    more.onclick = () => openMenu(more, [
      ['打开数据文件夹', async () => { const r = await launcher.openDir(p.id); if (r && r.error) toast(r.error); }],
      ...(on ? [['强制关闭(卡死时用)', () => launcher.close(p.id, true)]] : []),
      ['从列表移除', () => {
        if (on) return toast('请先关闭该分身再移除');
        if (confirm(`从列表中移除「${p.name}」?\n\n只移除这条记录;磁盘上的数据文件夹和卡库里的卡都不会被删除。`)) launcher.remove(p.id);
      }, 'danger'],
    ]);
    btns.append(edit, more);
    card.append(btns);
    bindDrag(card, p);
    return card;
  }));
}

const FACE_COLORS = ['#123A2E', '#2A3550', '#4A2E3E', '#3A3424', '#1F3F4A', '#3B2A52'];

function renderCards() {
  const q = $('#search').value.trim().toLowerCase();
  const nameOf = (id) => (S.profiles.find((p) => p.id === id) || {}).name;
  const list = S.cards.filter((c) => !q || [c.label, c.note, c.holder, c.last4, ...c.profileIds.map(nameOf)].join('\n').toLowerCase().includes(q));
  $('#cardEmpty').hidden = S.cards.length > 0;
  $('#cardGrid').hidden = S.cards.length === 0;

  $('#cardGrid').replaceChildren(...list.map((c, i) => {
    const face = el('div', { className: 'face' + (c.broken ? ' broken' : '') },
      el('span', { className: 'name', textContent: c.label, title: c.label }),
      el('span', { className: 'num', textContent: c.broken ? '无法解密' : `•••• ${c.last4}` }),
      el('span', { className: 'sub', textContent: c.broken ? '可能是从别的电脑复制来的,请编辑并重新录入' : [c.holder, c.exp && `有效期 ${c.exp}`].filter(Boolean).join(' · ') || '—' }));
    if (!c.broken) face.style.background = FACE_COLORS[i % FACE_COLORS.length];
    const body = el('div', { className: 'body' });
    if (!c.broken) body.append(el('div', { className: 'copies' }, ...copyButtons(c)));
    if (c.note) body.append(el('div', { className: 'cnote', textContent: c.note }));
    const names = c.profileIds.map(nameOf).filter(Boolean);
    body.append(names.length
      ? el('div', { className: 'used', textContent: `用于 ${names.length} 个分身` })
      : el('div', { className: 'used none', textContent: '还没有分配给任何分身' }));
    if (names.length) body.append(el('div', { className: 'usedtags' }, ...names.map((n) => el('span', { textContent: n }))));
    const edit = el('button', { className: 'main', textContent: '编辑 / 分配分身' });
    edit.onclick = () => openCardForm(c);
    const del = el('button', { className: 'sq danger', title: '删除这张卡', ariaLabel: '删除这张卡' }, svg(ICON.trash));
    del.onclick = () => { if (confirm(`删除「${c.label}」?\n\n会从所有分身上移除,且无法恢复。`)) launcher.deleteCard(c.id); };
    body.append(el('div', { className: 'btns' }, edit, del));
    return el('div', { className: 'ccard' }, face, body);
  }));
}

function render() {
  const runningCount = S.profiles.filter((p) => p.pid).length;
  $('#count').textContent = S.profiles.length;
  $('#cardCount').textContent = S.cards.length;
  $('#runInfo').textContent = `${runningCount} 个运行中`;
  const onCards = view === 'cards';
  $('#runInfo').hidden = onCards || !runningCount;
  $('#tabProfiles').classList.toggle('on', !onCards);
  $('#tabCards').classList.toggle('on', onCards);
  $('#cardsPage').hidden = !onCards;
  $('#profilesPage').hidden = onCards;
  $('#profileTools').hidden = onCards;
  $('#add').textContent = onCards ? '＋ 添加卡片' : '＋ 新建分身';
  if (onCards) renderCards(); else renderProfiles();
}

function setView(v) { view = v; render(); }

function renderExts() {
  $('#extList').replaceChildren(...formExts.map((dir, i) => {
    const rm = el('button', { type: 'button', textContent: '×', title: '移除' });
    rm.onclick = () => { formExts.splice(i, 1); renderExts(); };
    return el('div', { className: 'ext' }, el('span', { textContent: dir, title: dir }), rm);
  }));
}

function openForm(p) {
  editingId = p ? p.id : null;
  const f = $('#form');
  $('#formTitle').textContent = p ? '编辑分身' : '新建分身';
  const d = p || { color: PALETTE[S.profiles.length % PALETTE.length], mode: 'normal' };
  for (const k of ['dir', 'name', 'color', 'mode', 'home', 'extraArgs', 'note']) f.elements[k].value = d[k] || '';
  formExts = [...((p && p.extensions) || [])];
  renderExts();
  $('#storeInput').value = '';
  $('#formErr').hidden = true;
  $('#modal').hidden = false;
  f.elements[p ? 'name' : 'dir'].focus();
}
const closeForm = () => { $('#modal').hidden = true; };

function openCardForm(c) {
  editingCardId = c ? c.id : null;
  const f = $('#cardForm');
  $('#cardFormTitle').textContent = c ? '编辑卡片' : '添加卡片';
  f.elements.label.value = c ? c.label : '';
  f.elements.note.value = c ? c.note : '';
  // 已保存的卡号/CVV 不回显,留空表示沿用
  for (const k of ['holder', 'exp', 'number', 'cvv']) { f.elements[k].value = ''; f.elements[k].placeholder = ''; }
  const hint = $('#cardHint');
  hint.hidden = !c;
  if (c) {
    f.elements.holder.value = c.holder || '';
    f.elements.exp.value = c.exp || '';
    f.elements.number.placeholder = c.broken ? '请重新录入卡号' : `留空沿用 •••• ${c.last4}`;
    f.elements.cvv.placeholder = c.hasCvv ? '留空沿用' : '';
    hint.textContent = c.broken ? '这张卡无法解密,必须重新录入卡号。' : '卡号和 CVV 不会回显;不想改就留空。';
  }
  const used = new Set((c && c.profileIds) || []);
  $('#useList').replaceChildren(...(S.profiles.length ? S.profiles.map((p) => {
    const cb = el('input', { type: 'checkbox', value: p.id, checked: used.has(p.id) });
    return el('label', { className: 'use' }, cb, p.name);
  }) : [el('div', { className: 'meta', textContent: '还没有分身,可以先保存卡片,之后再分配。' })]));
  $('#cardErr').hidden = true;
  $('#cardModal').hidden = false;
  f.elements.label.focus();
}
const closeCardForm = () => { $('#cardModal').hidden = true; };

$('#tabProfiles').onclick = () => setView('profiles');
$('#tabCards').onclick = () => setView('cards');
$('#add').onclick = () => (view === 'cards' ? openCardForm(null) : openForm(null));
$('#cancel').onclick = closeForm;
$('#cardCancel').onclick = closeCardForm;
$('#pickDir').onclick = async () => {
  const d = await launcher.pickDir();
  if (d) $('#form').elements.dir.value = d;
};
$('#addExt').onclick = async () => {
  const r = await launcher.pickExtension();
  if (!r) return;
  if (r.error) return toast(r.error);
  if (!formExts.includes(r.dir)) { formExts.push(r.dir); renderExts(); }
};
$('#openStore').onclick = async () => {
  if (!editingId) return toast('请先保存分身,再从商店安装插件');
  const r = await launcher.openStore(editingId, $('#storeInput').value);
  toast(r.error || '已在该分身里打开商店页面,请在 Chrome 中点「添加到 Chrome」');
};
$('#form').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const data = {
    id: editingId || undefined,
    dir: f.dir.value, name: f.name.value, color: f.color.value, mode: f.mode.value,
    home: f.home.value, extraArgs: f.extraArgs.value, note: f.note.value,
    extensions: formExts,
  };
  const r = await launcher.save(data);
  if (r.error) { $('#formErr').textContent = r.error; $('#formErr').hidden = false; return; }
  closeForm();
};
$('#cardForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const data = {
    id: editingCardId || undefined,
    label: f.label.value, note: f.note.value,
    holder: f.holder.value, exp: f.exp.value, number: f.number.value, cvv: f.cvv.value,
    profileIds: [...document.querySelectorAll('#useList input:checked')].map((x) => x.value),
  };
  const r = await launcher.saveCard(data);
  if (r.error) { $('#cardErr').textContent = r.error; $('#cardErr').hidden = false; return; }
  closeCardForm();
};
$('#scan').onclick = async () => {
  const r = await launcher.scan();
  if (!r) return;
  toast(r.found === 0 ? '该文件夹下没有找到 Chrome 数据文件夹' : `找到 ${r.found} 个,新增 ${r.added} 个`);
};
$('#chromeBtn').onclick = () => launcher.pickChrome();
$('#reveal').onclick = () => launcher.revealData();
$('#search').oninput = render;
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#menu').hidden) closeMenu(); else if (!$('#cardModal').hidden) closeCardForm(); else if (!$('#modal').hidden) closeForm();
});

launcher.onState((s) => { S = s; render(); });
launcher.state().then((s) => { S = s; render(); });
