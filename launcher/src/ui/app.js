const $ = (s) => document.querySelector(s);
const PALETTE = ['#00754A', '#cba258', '#c82014', '#1E3932', '#2b5148', '#008248', '#b8860b', '#8c3b2a'];
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

const CARD_BTNS = [['number', '卡号'], ['exp', '有效期'], ['cvv', 'CVV'], ['holder', '持卡人']];

// 一张卡的复制按钮组(分身卡片和卡库页共用)
function copyButtons(c) {
  const box = el('div', { className: 'cardrow' });
  for (const [field, label] of CARD_BTNS) {
    if (field === 'cvv' && !c.hasCvv) continue;
    if (field === 'exp' && !c.exp) continue;
    if (field === 'holder' && !c.holder) continue;
    const b = el('button', { textContent: label });
    b.onclick = async () => {
      const r = await launcher.copyCard(c.id, field);
      toast(r.error || `已复制${label},${r.seconds} 秒后自动清除剪贴板`);
    };
    box.append(b);
  }
  return box;
}

// 分身卡片上:该分身用到的每张卡一行
function profileCardRows(p) {
  return p.cardIds.map((id) => S.cards.find((c) => c.id === id)).filter(Boolean).map((c) => {
    const row = el('div', { className: 'cardrow' });
    if (c.broken) {
      row.append(`💳 ${c.label}:无法解密(可能是从别的电脑复制来的),请到卡库重新录入`);
      return row;
    }
    row.append(el('span', { className: 'lbl', textContent: `💳 ${c.label} ••${c.last4}` }));
    row.append(...copyButtons(c).childNodes);
    return row;
  });
}

function renderProfiles() {
  const q = $('#search').value.trim().toLowerCase();
  const list = S.profiles.filter((p) => !q || [p.name, p.note, p.dir].join('\n').toLowerCase().includes(q));
  $('#empty').hidden = view !== 'profiles' || S.profiles.length > 0;
  $('#grid').hidden = view !== 'profiles' || S.profiles.length === 0;

  $('#chromeBtn').textContent = S.chromeOk ? 'Chrome 路径' : '⚠ 设置 Chrome 路径';
  $('#chromeBtn').title = S.chromePath || '未找到 Chrome';
  const warn = $('#warn');
  warn.hidden = S.chromeOk;
  warn.textContent = '没有找到 chrome.exe,请点右上角「设置 Chrome 路径」手动选择。';

  $('#grid').replaceChildren(...list.map((p) => {
    const on = !!p.pid;
    const card = el('div', { className: 'card' + (on ? ' on' : '') });
    const status = el('div', { className: 'status' }, el('i'), on ? '运行中' : '未运行');
    card.append(el('div', { className: 'top' }, el('div', { className: 'pname', textContent: p.name, title: p.name }), status));

    // 路径不在卡片上显示(点编辑可查看);只有文件夹不存在时才给一行提醒
    if (!p.dirExists) card.append(el('div', { className: 'meta bad', textContent: '数据文件夹不存在,首次启动时会新建', title: p.dir }));
    const tags = el('div', { className: 'meta' });
    if (p.mode === 'incognito') tags.append(el('span', { className: 'tag inc', textContent: '无痕' }));
    if (p.extensions.length) tags.append(el('span', { className: 'tag', textContent: `插件 ${p.extensions.length}` }));
    if (p.home) tags.append(el('span', { className: 'tag', textContent: '起始页' }));
    if (p.note) tags.append(p.note);
    if (tags.childNodes.length) card.append(tags);
    card.append(...profileCardRows(p));

    const open = el('button', { className: 'grow primary', textContent: on ? '再开一个窗口' : '启动', disabled: !S.chromeOk });
    open.onclick = async () => { const r = await launcher.launch(p.id); if (r && r.error) toast(r.error); };
    const btns = el('div', { className: 'btns' }, open);
    if (on) {
      const close = el('button', { textContent: '关闭', title: '正常关闭(等同点窗口关闭按钮)' });
      close.onclick = () => launcher.close(p.id, false);
      btns.append(close);
    }
    const edit = el('button', { className: 'icon', textContent: '✎', title: '编辑(插件、窗口类型等)' });
    edit.onclick = () => openForm(p);
    const del = el('button', { className: 'icon danger', textContent: '🗑', title: '从列表移除(不会删除磁盘上的数据和卡库里的卡)' });
    del.onclick = () => {
      if (on) return toast('请先关闭该分身再移除');
      if (confirm(`从列表中移除「${p.name}」?\n\n只移除这条记录;磁盘上的数据文件夹和卡库里的卡都不会被删除。`)) launcher.remove(p.id);
    };
    btns.append(edit, del);
    card.append(btns);
    return card;
  }));
}

function renderCards() {
  const q = $('#search').value.trim().toLowerCase();
  const nameOf = (id) => (S.profiles.find((p) => p.id === id) || {}).name;
  const list = S.cards.filter((c) => !q || [c.label, c.note, c.holder, c.last4, ...c.profileIds.map(nameOf)].join('\n').toLowerCase().includes(q));
  $('#cardEmpty').hidden = S.cards.length > 0;
  $('#cardGrid').hidden = S.cards.length === 0;

  $('#cardGrid').replaceChildren(...list.map((c) => {
    const box = el('div', { className: 'ccard' });
    const top = el('div', { className: 'top' }, el('div', { className: 'name', textContent: c.label, title: c.label }));
    box.append(top);
    if (c.broken) {
      box.append(el('div', { className: 'meta bad', textContent: '无法解密(可能是从别的电脑复制来的),请编辑并重新录入' }));
    } else {
      box.append(el('div', { className: 'num', textContent: `•••• •••• •••• ${c.last4}` }));
      box.append(el('div', { className: 'meta', textContent: [c.holder, c.exp && `有效期 ${c.exp}`].filter(Boolean).join('  ·  ') || '—' }));
      box.append(copyButtons(c));
    }
    if (c.note) box.append(el('div', { className: 'meta', textContent: c.note }));

    const names = c.profileIds.map(nameOf).filter(Boolean);
    if (names.length) {
      box.append(el('div', { className: 'used' }, '用于:', el('div', { className: 'usedtags' }, ...names.map((n) => el('span', { className: 'tag', textContent: n })))));
    } else {
      box.append(el('div', { className: 'used none', textContent: '还没有分配给任何分身' }));
    }

    const edit = el('button', { className: 'grow', textContent: '编辑 / 分配分身' });
    edit.onclick = () => openCardForm(c);
    const del = el('button', { className: 'icon danger', textContent: '🗑', title: '删除这张卡' });
    del.onclick = () => {
      if (confirm(`删除「${c.label}」?\n\n会从所有分身上移除,且无法恢复。`)) launcher.deleteCard(c.id);
    };
    box.append(el('div', { className: 'btns' }, edit, del));
    return box;
  }));
}

function render() {
  $('#count').textContent = `${S.profiles.length}(运行 ${S.profiles.filter((p) => p.pid).length})`;
  $('#cardCount').textContent = S.cards.length;
  const onCards = view === 'cards';
  $('#tabProfiles').classList.toggle('on', !onCards);
  $('#tabCards').classList.toggle('on', onCards);
  $('#cardsPage').hidden = !onCards;
  $('#profileTools').hidden = onCards;
  $('#add').textContent = onCards ? '＋ 添加卡片' : '＋ 新建分身';
  if (!onCards) { $('#cardEmpty').hidden = true; }
  if (onCards) { $('#empty').hidden = true; $('#grid').hidden = true; renderCards(); } else { renderProfiles(); }
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
  if (!$('#cardModal').hidden) closeCardForm(); else if (!$('#modal').hidden) closeForm();
});

launcher.onState((s) => { S = s; render(); });
launcher.state().then((s) => { S = s; render(); });
