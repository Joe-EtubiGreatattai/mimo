/* Mimo for Windows — window UI. Talks to the engine through window.mimo (preload bridge). */
(() => {
  const $ = (id) => document.getElementById(id);
  const icon = (n) => `<svg class="i"><use href="#i-${n}"/></svg>`;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (b) => { if (!b) return 'Zero KB'; const u = ['bytes', 'KB', 'MB', 'GB', 'TB']; let i = 0, n = b; while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; } return (n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i]; };
  const ago = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); if (s < 10) return 'just now'; if (s < 60) return s + ' sec ago'; if (s < 3600) return Math.round(s / 60) + ' min ago'; if (s < 86400) return Math.round(s / 3600) + ' h ago'; return Math.round(s / 86400) + ' days ago'; };
  const time = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const placeIcon = (ic) => ({ clock: 'clock', globe: 'globe', message: 'message', music: 'music', alert: 'alert', box: 'box', download: 'download', trash: 'trash', code: 'code', folder: 'folder', disk: 'disk' }[ic] || 'folder');

  let S = null, tab = 'overview', selected = new Set(), touched = false, prevFree = null, prevFreed = null, qrFor = null, qrData = null;

  // ---------- notices & sheets ----------
  function note(title, text = '', kind = 'info', ic) {
    const n = document.createElement('div');
    n.className = 'note ' + kind;
    n.innerHTML = `<span class="badge">${icon(ic || (kind === 'good' ? 'check' : kind === 'bad' ? 'alert' : 'paw'))}</span><div><b>${esc(title)}</b>${text ? `<span>${esc(text)}</span>` : ''}</div>`;
    $('notes').prepend(n);
    while ($('notes').children.length > 3) $('notes').lastElementChild.remove();
    const close = () => { n.classList.add('out'); setTimeout(() => n.remove(), 300); };
    n.onclick = close; setTimeout(close, kind === 'bad' ? 5000 : 3200);
  }
  let sheetDone = null;
  function sheet(html) {
    $('sheet').innerHTML = html;
    $('scrim').hidden = false; $('sheet').hidden = false;
    requestAnimationFrame(() => { $('scrim').classList.add('on'); $('sheet').classList.add('on'); });
    return new Promise((r) => {
      sheetDone = r;
      $('sheet').querySelectorAll('[data-v]').forEach((b) => b.onclick = () => closeSheet(b.dataset.v));
      const first = $('sheet').querySelector('.primary, .danger, .choice'); if (first) setTimeout(() => first.focus(), 300);
    });
  }
  function closeSheet(v) {
    $('scrim').classList.remove('on'); $('sheet').classList.remove('on');
    setTimeout(() => { $('scrim').hidden = true; $('sheet').hidden = true; }, 350);
    if (sheetDone) { sheetDone(v); sheetDone = null; }
  }
  $('scrim').onclick = () => closeSheet(null);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheetDone) closeSheet(null); });
  const confirmSheet = ({ title, text, list = '', ok, okIcon, danger }) => sheet(`
    <h3>${esc(title)}</h3><p>${esc(text)}</p>${list ? `<div class="list">${list}</div>` : ''}
    <div class="btns"><button class="btn ghost" data-v="">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-v="ok">${okIcon ? icon(okIcon) : ''}<span>${esc(ok)}</span></button></div>`).then((v) => v === 'ok');

  // ---------- actions with loading state ----------
  async function act(btn, name, args, success) {
    if (btn) btn.classList.add('loading');
    try {
      const r = await window.mimo.action(name, args);
      if (r === false) note('Couldn’t do that', '', 'bad'); else if (success) note(success, '', 'good');
      return r;
    } catch (e) { note('Something went wrong', e.message || '', 'bad'); }
    finally { if (btn) btn.classList.remove('loading'); }
  }

  // ---------- header ----------
  function countTo(el, to) {
    const from = prevFree == null ? 0 : prevFree; prevFree = to;
    if (from === to) { el.textContent = to; return; }
    const t0 = performance.now();
    const step = (t) => { const p = Math.min(1, (t - t0) / 700), e = 1 - Math.pow(1 - p, 3); el.textContent = Math.round(from + (to - from) * e); if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  function header() {
    const used = Math.max(0, S.total - S.free);
    countTo($('free'), S.free);
    $('arc').style.strokeDashoffset = 263.9 * (1 - used / Math.max(1, S.total));
    $('mood').textContent = `${S.mood.text} ${S.mood.emoji}`;
    $('used').textContent = `${used} of ${S.total} GB used`;
    $('rule').textContent = `${S.settings.askFirst ? 'Asks first' : 'Auto-cleans'} below ${S.settings.cleanBelowGB} GB`;
    $('checked').textContent = 'Checked ' + ago(S.lastCheck);
    document.querySelector('[data-tab="review"]').innerHTML = 'Review' + (S.pendingReview ? '<span class="pip"></span>' : '');
  }

  // ---------- tabs ----------
  document.querySelectorAll('.tab').forEach((b) => b.onclick = () => setTab(b.dataset.tab));
  function setTab(t) {
    tab = t;
    document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === t ? 'true' : 'false'));
    const pane = $('pane'); pane.classList.remove('enter'); void pane.offsetWidth; pane.classList.add('enter'); pane.scrollTop = 0;
    render(true);
  }

  const busyNotice = () => {
    const t = S.isMapping ? `Mapping your PC… ${S.mapProgress.folders.toLocaleString()} folders` : S.isCleaning ? (S.cleaningStep || 'Cleaning…') : S.isScanning ? 'Looking for things to clean…' : '';
    return t ? `<div class="notice work"><span class="spin"></span><div class="grow">${esc(t)}<div class="progress"><i></i></div></div></div>` : '';
  };

  // ---------- overview ----------
  function overview() {
    const enabled = S.places.filter((p) => p.on);
    const found = (id) => S.findings.find((f) => f.id === id);
    return `
      ${busyNotice()}
      ${S.pendingReview ? `<div class="notice ask">${icon('hand')}<div class="grow">${fmt(S.findings.reduce((t, f) => t + f.bytes, 0))} is waiting for your OK</div><button class="btn sm primary" data-go="review">Review</button></div>` : ''}
      <section class="card">
        <h2>${icon('sparkles')}Ready to clean now<span class="right"><button class="btn sm ghost" data-go="places">Change</button></span></h2>
        ${enabled.length ? enabled.map((p) => `<div class="row"><span class="badge">${icon(placeIcon(p.icon))}</span><div class="grow"><div class="name">${esc(p.name)}</div></div><span class="size">${S.isScanning && !found(p.id) ? '…' : fmt(found(p.id) ? found(p.id).bytes : 0)}</span></div>`).join('')
          : '<p class="empty">I’m not looking after any places yet. Pick some in Places.</p>'}
      </section>
      <div class="btns">
        <button class="btn primary" id="cleanNow" ${S.isCleaning || S.isScanning ? 'disabled' : ''}>${icon(S.settings.askFirst ? 'search' : 'sparkles')}<span>${S.settings.askFirst ? 'Find things to clean' : 'Clean now'}</span></button>
        <button class="btn" id="checkNow">${icon('refresh')}<span>Check now</span></button>
      </div>
      <section class="card feed">
        <h2>${icon('clock')}What I’ve been doing</h2>
        ${S.activity.slice(0, 12).map((a) => `<div class="it"><span class="badge">${icon(a.icon === 'phone' ? 'phone' : a.icon === 'sparkles' ? 'sparkles' : a.icon === 'alert' ? 'alert' : a.icon === 'map' ? 'map' : a.icon === 'bell' ? 'bell' : a.icon === 'search' ? 'search' : 'paw')}</span><div class="grow">${esc(a.text)}<time>${time(a.time)}</time></div></div>`).join('') || '<p class="empty">Nothing yet.</p>'}
      </section>`;
  }

  // ---------- review ----------
  function review() {
    if (S.isScanning) return `${busyNotice()}`;
    if (!S.findings.length) return `
      <section class="card"><h2>${icon('hand')}Nothing waiting for review</h2>
      <p class="muted">When space runs low I’ll gather everything I want to remove here, so you can choose what goes.</p>
      <div style="margin-top:12px"><button class="btn primary" id="scanReview">${icon('search')}<span>Look for things to clean</span></button></div></section>`;
    if (!touched) selected = new Set(S.findings.map((f) => f.id));
    else selected = new Set([...selected].filter((id) => S.findings.some((f) => f.id === id)));
    const sum = S.findings.filter((f) => selected.has(f.id)).reduce((t, f) => t + f.bytes, 0);
    return `
      ${busyNotice()}
      <p class="muted">${S.pendingReview ? 'I’d like to clean these. Untick anything you want to keep.' : 'Here’s what I can clean right now. Tick what should go.'}</p>
      ${S.findings.map((f) => `
        <section class="card">
          <label class="row pick">
            <input type="checkbox" data-sel="${esc(f.id)}" ${selected.has(f.id) ? 'checked' : ''}><span class="box">${icon('check')}</span>
            <div class="grow"><div class="name">${esc(f.name)}</div><div class="sub ${f.permanent ? 'perm' : ''}">${f.count.toLocaleString()} item${f.count === 1 ? '' : 's'} · ${f.permanent ? 'deleted permanently' : 'moved to the Recycle Bin'}</div></div>
            <span class="size">${fmt(f.bytes)}</span>
          </label>
          <details class="folder"><summary class="sub" style="display:flex;align-items:center;gap:4px"><span class="chev">${icon('chev')}</span>Biggest items</summary>
            <div class="kids">${f.top.map((t) => `<div class="kid"><span class="grow" title="${esc(t.path)}">${esc(t.label)}</span><span class="sub">${fmt(t.bytes)}</span>${t.path && t.path !== '$Recycle.Bin' ? `<button class="iconbtn" title="Show in Explorer" data-reveal="${esc(t.path)}">${icon('eye')}</button>` : ''}</div>`).join('')}
            ${f.count > f.top.length ? `<div class="sub">and ${(f.count - f.top.length).toLocaleString()} more</div>` : ''}</div>
          </details>
        </section>`).join('')}
      <section class="card" style="position:sticky;bottom:0">
        <div class="row" style="min-height:0"><div class="grow"><div class="sub">${selected.size} of ${S.findings.length}</div><div class="sub">selected</div></div>
          <button class="btn ghost" id="notNow">${icon('x')}<span>Not now</span></button>
          <button class="btn primary" id="approve" ${selected.size && !S.isCleaning ? '' : 'disabled'}>${icon('sparkles')}<span>Clean ${fmt(sum)}</span></button></div>
      </section>`;
  }

  // ---------- places ----------
  function placeRow(p) {
    return `<div class="row">
      <span class="badge">${icon(placeIcon(p.icon))}</span>
      <div class="grow"><div class="name">${esc(p.name)}</div><div class="sub one ${p.permanent && (p.custom || p.id === 'bin') ? 'perm' : ''}" title="${esc(p.detail)}">${esc(p.detail)}</div>
        ${p.count ? `<div class="sub">Found in ${p.count} project${p.count === 1 ? '' : 's'}</div>` : ''}
        ${p.usesDays && p.on ? `<div class="stepper" style="margin-top:6px"><button data-days="${esc(p.id)}" data-d="-7" aria-label="Fewer days">${icon('minus')}</button><output>${p.days} days</output><button data-days="${esc(p.id)}" data-d="7" aria-label="More days">${icon('plus')}</button></div>` : ''}
      </div>
      ${p.bytes != null ? `<span class="size sub">${fmt(p.bytes)}</span>` : ''}
      ${p.custom ? `<button class="iconbtn" title="Remove this place" data-remove="${esc(p.id)}">${icon('x')}</button>` : ''}
      <span class="switch"><input type="checkbox" aria-label="Let Mimo clean ${esc(p.name)}" data-place="${esc(p.id)}" ${p.on ? 'checked' : ''}><span class="track"></span><span class="knob"></span></span>
    </div>`;
  }
  function places() {
    const home = S.home;
    const rec = S.places.filter((p) => !p.custom).sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
    const mine = S.places.filter((p) => p.custom);
    const covered = (dir) => S.places.find((p) => !p.custom && p.path === dir);
    const mapCard = S.isMapping
      ? `<div class="notice work"><span class="spin"></span><div class="grow">Mapping your PC… <span class="sub">${S.mapProgress.folders.toLocaleString()} folders · ${fmt(S.mapProgress.bytes)}</span><div class="sub one">${esc(S.mapProgress.current)}</div><div class="progress"><i></i></div></div></div>`
      : S.map ? `<section class="card"><div class="row" style="min-height:0"><span class="badge">${icon('map')}</span><div class="grow"><div class="name">I’ve mapped ${S.map.folders.toLocaleString()} folders</div><div class="sub">${fmt(S.map.totalBytes)} in your user folder · updated ${ago(S.map.date)}</div></div><button class="btn sm" id="remap">${icon('refresh')}<span>Map again</span></button></div></section>`
      : `<section class="card"><h2>${icon('map')}Let me map your PC</h2><p class="muted">I’ll look through your user folder to learn where your space goes. Nothing is deleted.</p><div style="margin-top:10px"><button class="btn primary" id="remap">${icon('map')}<span>Start mapping</span></button></div></section>`;
    const tree = S.map && S.map.tree.length ? `
      <section class="card"><h2>${icon('folder')}Where your space goes</h2>
        ${S.map.tree.map((n) => `
          <details class="folder"><summary><div class="row" style="min-height:0;padding:0"><span class="chev">${icon('chev')}</span><div class="grow"><div class="name">${esc(n.folder.path.slice(home.length + 1) || n.folder.path)}</div><div class="fbar"><i style="width:${Math.max(1, n.folder.bytes / S.map.totalBytes * 100)}%"></i></div></div><span class="size">${fmt(n.folder.bytes)}</span></div></summary>
            <div class="kids">${n.children.map((c) => {
              const cov = covered(c.path), mineAlready = S.places.some((p) => p.custom && p.path === c.path);
              return `<div class="kid"><span class="grow" title="${esc(c.path)}">${esc(c.path.slice(home.length + 1))}</span><span class="sub">${fmt(c.bytes)}</span>
                ${cov ? `<span class="covered">${esc(cov.name)}</span>` : mineAlready ? `<span class="covered">Yours</span>` : `<button class="iconbtn" title="Add as a cleaning place" data-add="${esc(c.path)}">${icon('plus')}</button>`}
                <button class="iconbtn" title="Show in Explorer" data-reveal="${esc(c.path)}">${icon('eye')}</button></div>`;
            }).join('')}</div>
          </details>`).join('')}
      </section>` : '';
    return `${mapCard}
      <section class="card"><h2>${icon('sparkles')}Places I recognise</h2>${rec.map(placeRow).join('') || '<p class="empty">Nothing found yet.</p>'}</section>
      ${mine.length ? `<section class="card"><h2>${icon('folder')}Your places</h2>${mine.map(placeRow).join('')}</section>` : ''}
      ${tree}`;
  }

  // ---------- settings ----------
  function settings() {
    const st = S.settings, ph = S.phone;
    let phone;
    if (ph.code) {
      phone = `<div class="qr">${qrData ? `<img src="${qrData}" alt="QR code to pair your phone">` : '<span class="spin"></span>'}
        <div class="grow"><div class="name">Scan with your phone’s camera</div><div class="sub">Or open mimo.techtree.lifestyle/app and enter:</div>
        <div class="code" style="margin:8px 0">${esc(ph.code)}</div><div class="sub">Expires in ${Math.max(1, Math.round((ph.expires - Date.now()) / 60000))} min</div>
        <div style="margin-top:8px"><button class="btn sm ghost" id="cancelPair">Cancel</button></div></div></div>`;
    } else {
      phone = `<div class="row" style="min-height:0"><span class="badge">${icon('phone')}</span><div class="grow"><div class="name">Control Mimo from your phone</div><div class="sub">${ph.paired ? `${ph.paired} phone${ph.paired === 1 ? '' : 's'} paired` : 'See your storage and approve cleaning from anywhere.'}</div></div>
        <button class="btn sm primary" id="pair">${icon('phone')}<span>${ph.paired ? 'Pair another' : 'Pair a phone'}</span></button></div>
        ${ph.paired ? `<div style="margin-top:8px"><button class="btn sm ghost" id="unpair">Unpair all phones</button></div>` : ''}`;
    }
    return `
      <section class="card"><h2>${icon('gauge')}When to step in</h2>
        <div class="row" style="min-height:0"><div class="grow"><div class="name">Clean when free space drops below</div><div class="sub">I’ll send a heads-up at ${st.cleanBelowGB + 10} GB.</div></div>
          <div class="stepper"><button id="limDown" ${st.cleanBelowGB <= 5 ? 'disabled' : ''} aria-label="Lower by 5 GB">${icon('minus')}</button><output>${st.cleanBelowGB} GB</output><button id="limUp" ${st.cleanBelowGB >= 500 ? 'disabled' : ''} aria-label="Raise by 5 GB">${icon('plus')}</button></div></div>
      </section>
      <section class="card"><h2>${icon('hand')}Before deleting</h2>
        <label class="radio"><input type="radio" name="ask" value="1" ${st.askFirst ? 'checked' : ''}>Ask me first — gather everything for review</label>
        <label class="radio"><input type="radio" name="ask" value="0" ${!st.askFirst ? 'checked' : ''}>Clean automatically</label>
      </section>
      <section class="card"><h2>${icon('bell')}Notifications</h2>
        <div class="row" style="min-height:0"><div class="grow name">Check in with me every</div>
          <select id="every">${[[15, '15 min'], [30, '30 min'], [60, '1 hour'], [180, '3 hours']].map(([v, l]) => `<option value="${v}" ${st.reportMinutes === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="row" style="min-height:0;border:0;margin-top:6px"><button class="btn sm" id="testNote">${icon('bell')}<span>Send a test notification</span></button><span class="sub grow" style="text-align:right">Next in ${Math.max(1, Math.round((S.nextReport - Date.now()) / 60000))} min</span></div>
      </section>
      <section class="card"><h2>${icon('phone')}Phone</h2>${phone}
        ${ph.error ? `<p class="sub perm" style="margin-top:8px">${esc(ph.error)}</p>` : ''}
        <p class="sub" style="margin:10px 0 0">Paired phones see your storage totals, what I found by category and my activity. File names never leave your PC.</p>
      </section>
      <section class="card"><h2>${icon('lock')}Privacy &amp; startup</h2>
        <div class="row"><div class="grow"><div class="name">Count my install</div><div class="sub">One anonymous ping when Mimo is first installed: a random ID, app version, Windows version and chip type. Nothing about your files.</div></div>
          <span class="switch"><input type="checkbox" id="countInstall" aria-label="Count my install" ${st.countInstall ? 'checked' : ''}><span class="track"></span><span class="knob"></span></span></div>
        <div class="row"><div class="grow"><div class="name">Start Mimo when I sign in</div><div class="sub">He waits quietly in the system tray.</div></div>
          <span class="switch"><input type="checkbox" id="startAtLogin" aria-label="Start Mimo when I sign in" ${st.startAtLogin ? 'checked' : ''}><span class="track"></span><span class="knob"></span></span></div>
      </section>
      <div class="btns"><button class="btn ghost" id="openLog">${icon('clock')}<span>Open log</span></button><button class="btn ghost" id="quit">${icon('power')}<span>Quit Mimo</span></button></div>
      <p class="sub" style="text-align:center;margin:4px 0 0">Mimo ${esc(S.version)}</p>`;
  }

  // ---------- render & wire ----------
  let lastKey = '';
  function render(force) {
    if (!S) return;
    header();
    // avoid rebuilding while the user is interacting with a sheet
    if (sheetDone && !force) return;
    const html = tab === 'overview' ? overview() : tab === 'review' ? review() : tab === 'places' ? places() : settings();
    if (!force && html === lastKey) return;
    // keep <details> open state across re-renders
    const open = new Set([...document.querySelectorAll('details[open]')].map((d, i) => i));
    const scroll = $('pane').scrollTop;
    lastKey = html; $('pane').innerHTML = html;
    document.querySelectorAll('details').forEach((d, i) => { if (open.has(i)) d.open = true; });
    $('pane').scrollTop = scroll;
    wire();
  }

  function wire() {
    const on = (id, fn) => { const el = $(id); if (el) el.onclick = (e) => fn(e.currentTarget); };
    document.querySelectorAll('[data-go]').forEach((b) => b.onclick = () => setTab(b.dataset.go));
    on('cleanNow', (b) => act(b, 'cleanNow'));
    on('checkNow', (b) => act(b, 'check', {}, 'Checked your storage'));
    on('scanReview', (b) => act(b, 'scanReview'));
    on('remap', (b) => act(b, 'remap'));
    on('notNow', async (b) => { if (await confirmSheet({ title: 'Skip for now?', text: 'I’ll ask again if your PC stays low on space.', ok: 'Skip', okIcon: 'x' })) { await act(b, 'dismiss'); setTab('overview'); } });
    on('approve', async (b) => {
      const f = S.findings.filter((x) => selected.has(x.id));
      const sum = f.reduce((t, x) => t + x.bytes, 0);
      const list = f.map((x) => `<div class="row"><span class="badge">${icon(x.permanent ? 'trash' : 'folder')}</span><div class="grow"><div class="name">${esc(x.name)}</div><div class="sub ${x.permanent ? 'perm' : ''}">${x.permanent ? 'Deleted permanently' : 'Moved to the Recycle Bin'}</div></div><span class="size">${fmt(x.bytes)}</span></div>`).join('');
      if (await confirmSheet({ title: `Clean ${fmt(sum)}?`, text: f.some((x) => x.permanent) ? 'Some of this is deleted permanently. Caches rebuild themselves.' : 'Everything goes to the Recycle Bin, so you can restore it.', list, ok: `Clean ${fmt(sum)}`, okIcon: 'sparkles' })) {
        touched = false; await act(b, 'approve', { ids: [...selected] });
      }
    });
    document.querySelectorAll('[data-sel]').forEach((cb) => cb.onchange = () => { touched = true; cb.checked ? selected.add(cb.dataset.sel) : selected.delete(cb.dataset.sel); render(true); });
    document.querySelectorAll('[data-reveal]').forEach((b) => b.onclick = (e) => { e.preventDefault(); window.mimo.action('reveal', { path: b.dataset.reveal }); });
    document.querySelectorAll('[data-place]').forEach((cb) => cb.onchange = () => act(null, 'setPlace', { id: cb.dataset.place, on: cb.checked }));
    document.querySelectorAll('[data-days]').forEach((b) => b.onclick = () => { const p = S.places.find((x) => x.id === b.dataset.days); act(b, 'setDays', { id: p.id, days: p.days + Number(b.dataset.d) }); });
    document.querySelectorAll('[data-remove]').forEach((b) => b.onclick = async () => { const p = S.places.find((x) => x.id === b.dataset.remove); if (await confirmSheet({ title: `Stop cleaning ${p.name}?`, text: 'I won’t touch this folder anymore. Nothing is deleted.', ok: 'Remove', okIcon: 'x' })) act(null, 'removePlace', { id: p.id }, 'Removed'); });
    document.querySelectorAll('[data-add]').forEach((b) => b.onclick = async (e) => {
      e.preventDefault();
      const dir = b.dataset.add;
      const v = await sheet(`<h3>Add ${esc(dir.split(/[\\/]/).pop())}</h3><p>How should I clean this folder?</p>
        <div class="choices">
          <button class="choice" data-v="older">${icon('trash')}<div><div class="name">Move old files to the Recycle Bin</div><div class="sub">Files older than 30 days. You can restore them.</div></div></button>
          <button class="choice" data-v="all">${icon('alert')}<div><div class="name">Delete everything inside</div><div class="sub perm">Permanent. Only for folders that rebuild themselves.</div></div></button>
        </div><div class="btns" style="grid-template-columns:1fr"><button class="btn ghost" data-v="">Cancel</button></div>`);
      if (v) act(b, 'addPlace', { path: dir, clearEverything: v === 'all' }, 'Added to your places');
    });
    on('limDown', (b) => act(b, 'setting', { key: 'cleanBelowGB', value: Math.max(5, S.settings.cleanBelowGB - 5) }));
    on('limUp', (b) => act(b, 'setting', { key: 'cleanBelowGB', value: Math.min(500, S.settings.cleanBelowGB + 5) }));
    document.querySelectorAll('input[name="ask"]').forEach((r) => r.onchange = () => act(null, 'setting', { key: 'askFirst', value: r.value === '1' }));
    const every = $('every'); if (every) every.onchange = () => act(null, 'setting', { key: 'reportMinutes', value: Number(every.value) });
    ['countInstall', 'startAtLogin'].forEach((k) => { const el = $(k); if (el) el.onchange = () => act(null, 'setting', { key: k, value: el.checked }); });
    on('testNote', (b) => act(b, 'testNotification', {}, 'Notification sent'));
    on('pair', (b) => act(b, 'pair'));
    on('cancelPair', (b) => act(b, 'cancelPair'));
    on('unpair', async (b) => { if (await confirmSheet({ title: 'Unpair all phones?', text: 'Your phones will stop seeing and controlling Mimo.', ok: 'Unpair', danger: true })) act(b, 'unpairAll', {}, 'Phones unpaired'); });
    on('openLog', () => window.mimo.action('openLog'));
    on('quit', async (b) => { if (await confirmSheet({ title: 'Quit Mimo?', text: 'I’ll stop watching your storage until you open me again.', ok: 'Quit', danger: true })) act(b, 'quit'); });
  }

  async function update(s) {
    const first = !S;
    S = s;
    if (prevFreed !== null && S.totalFreed > prevFreed) note(`Freed ${S.totalFreed - prevFreed} GB`, `You now have ${S.free} GB free.`, 'good', 'sparkles');
    prevFreed = S.totalFreed;
    if (S.phone.code && S.phone.code !== qrFor) { qrFor = S.phone.code; qrData = null; window.mimo.qr(S.phone.url).then((d) => { qrData = d; render(true); }); }
    render(first);
  }

  window.mimo.onState(update);
  window.mimo.onTab((t) => setTab(t));
  window.mimo.state().then(update);
  setInterval(() => S && header(), 15000);
})();
