(() => {
  const $ = (id) => document.getElementById(id);
  let worker = null;
  let files = [];
  let busy = false;
  let lastResult = null; // {demo, preview, depth, frames, ...}
  let view = 'image';
  let demoCount = 0;
  let wakeLock = null;
  let timer = null;
  let exportId = 0;
  const pending = new Map();

  // Heavy work runs in a Web Worker. Where workers are unavailable (some in-app browsers),
  // fall back to running the same code on the page itself.
  let workerAlive = false, usingFallback = false, lastRunMsg = null;
  function useFallback(reason) {
    if (usingFallback) return;
    usingFallback = true;
    console.warn('worker unavailable, running on page:', reason);
    try { if (worker && worker.terminate) worker.terminate(); } catch (e) {}
    const core = coreFactory();
    const fake = {
      onmessage: null,
      postMessage(msg) { setTimeout(() => core.handleMessage(msg, (m) => fake.onmessage && fake.onmessage({ data: m })), 0); },
      terminate() {},
    };
    fake.onmessage = onMessage;
    worker = fake;
    if (busy && lastRunMsg) worker.postMessage(lastRunMsg);
    if (files.length) worker.postMessage({ type: 'info', id: ++exportId, file: files[0] });
  }
  function makeWorker() {
    try {
      const src = coreFactory.toString() + '\n;const __core = coreFactory();\nself.onmessage = (e) => __core.handleMessage(e.data, (m, t) => self.postMessage(m, t || []));\n';
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const w = new Worker(url);
      w.onmessage = (e) => { workerAlive = true; onMessage(e); };
      w.onerror = (e) => {
        if (!workerAlive) { useFallback(e.message || 'error event'); return; }
        showError('処理中にエラーが発生しました: ' + (e.message || '不明なエラー')); finishRun();
      };
      w.postMessage({ type: 'ping' });
      setTimeout(() => { if (!workerAlive) useFallback('no response'); }, 2500);
      return w;
    } catch (e) {
      setTimeout(() => useFallback(e.message), 0);
      return { postMessage() {}, terminate() {} };
    }
  }
  worker = makeWorker();

  // ---- downloads: artifact capability when hosted on claude.ai, plain links elsewhere ----
  let downloadsCap = null;
  const capReady = (async () => {
    try {
      if (window.claude && typeof window.claude.use === 'function') downloadsCap = await window.claude.use('downloads');
    } catch (e) { downloadsCap = null; }
  })();

  const naturalSort = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  const fmtMB = (n) => (n / 1048576).toFixed(n > 1048576 * 100 ? 0 : 1) + ' MB';

  function setFiles(list) {
    files = Array.from(list).filter((f) => f.size > 0).sort(naturalSort);
    const other = files.filter((f) => !/\.dng$/i.test(f.name));
    if (other.length) showError(`DNG以外のファイル(${other.slice(0, 3).map((f) => f.name).join(', ')}${other.length > 3 ? ' など' : ''})が含まれています。合成にはDNGのみ使えます`); else hideError();
    files = files.filter((f) => /\.dng$/i.test(f.name) || !/\.(jpe?g|heic|png|mov|mp4)$/i.test(f.name));
    renderFiles();
    if (files.length) {
      const id = ++exportId;
      worker.postMessage({ type: 'info', id, file: files[0] });
    }
  }

  function renderFiles() {
    const ol = $('fileList');
    ol.innerHTML = '';
    files.forEach((f, i) => {
      const li = document.createElement('li');
      const n = document.createElement('span'); n.className = 'n'; n.textContent = String(i + 1);
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = f.name;
      const sz = document.createElement('span'); sz.className = 'sz'; sz.textContent = fmtMB(f.size);
      li.append(n, nm, sz);
      ol.appendChild(li);
    });
    ol.hidden = $('filebar').hidden = files.length === 0;
    const total = files.reduce((s, f) => s + f.size, 0);
    $('fileMeta').textContent = files.length ? `${files.length}枚・合計 ${fmtMB(total)}` : '';
    $('run').disabled = busy || files.length < 2;
    $('run').textContent = files.length === 1 ? 'あと1枚以上選んでください' : '深度合成を開始';
  }

  $('file').addEventListener('change', (e) => { setFiles(e.target.files); e.target.value = ''; });
  const drop = $('drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files.length) setFiles(e.dataTransfer.files); });
  $('reverse').addEventListener('click', () => { files.reverse(); renderFiles(); });
  $('clear').addEventListener('click', () => { files = []; renderFiles(); });

  for (const [id, out] of [['detail', 'detailOut'], ['smooth', 'smoothOut']]) {
    $(id).addEventListener('input', () => { $(out).textContent = $(id).value; });
  }
  $('align').addEventListener('change', () => { $('rotate').disabled = !$('align').checked; });

  function options() {
    return {
      half: $('sizeHalf').checked,
      align: $('align').checked,
      noRotation: !$('rotate').checked,
      detail: +$('detail').value,
      smooth: +$('smooth').value,
    };
  }

  function previewSize() {
    const w = $('resultSec').clientWidth || 700;
    return Math.min(2000, Math.max(900, Math.round(w * (window.devicePixelRatio || 1))));
  }

  async function startRun(demo) {
    if (busy) return;
    busy = true;
    hideError();
    $('run').disabled = true; $('demo').disabled = true;
    $('progress').hidden = false;
    $('barFill').style.width = '0%';
    $('pText').textContent = '準備中';
    const t0 = Date.now();
    clearInterval(timer);
    timer = setInterval(() => { $('pTime').textContent = Math.round((Date.now() - t0) / 1000) + 's'; }, 500);
    try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { wakeLock = null; }
    demoCount += demo ? 1 : 0;
    lastRunMsg = { type: 'run', demo, seed: demo ? (demoCount === 1 ? 11 : Math.floor(Math.random() * 1e9)) : 0, files: demo ? null : files, opts: options(), exposure: +$('exposure').value, previewSize: previewSize() };
    worker.postMessage(lastRunMsg);
  }

  function finishRun() {
    busy = false;
    clearInterval(timer);
    $('demo').disabled = false;
    renderFiles();
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }

  $('run').addEventListener('click', () => startRun(false));
  $('demo').addEventListener('click', () => startRun(true));

  function onMessage(e) {
    const m = e.data;
    if (m.type === 'pong') return;
    if (m.type === 'progress') {
      // Pass 1 (decode/align/measure) ~ 60%, pass 2 (blend) ~ 40%.
      let pct = 0;
      if (m.phase === 1) pct = ((m.frame + 0.5) / m.total) * 60;
      else if (m.phase === 2) pct = 60 + ((m.frame + 0.5) / m.total) * 40;
      $('barFill').style.width = pct.toFixed(1) + '%';
      $('pText').textContent = m.text;
    } else if (m.type === 'info') {
      const i = m.info;
      const comp = { 1: '非圧縮', 7: 'ロスレス圧縮', 8: 'Deflate圧縮', 34892: '非可逆圧縮', 52546: 'JPEG XL圧縮' }[i.compression] || ('圧縮' + i.compression);
      const mp = (i.width * i.height / 1e6).toFixed(1);
      $('fileMeta').textContent = `${files.length}枚・${[i.make, i.model].filter(Boolean).join(' ')}・${i.width}×${i.height}（${mp}MP）・${i.cfa ? 'ベイヤー' : 'LinearRaw'}・${comp}`;
      if (i.width * i.height > 30e6) {
        $('sizeHalf').checked = true;
        $('sizeHint').textContent = `${mp}MPの大きなRAWなので1/2を選びました。メモリに余裕のある端末ならフル解像度も試せます。`;
      }
    } else if (m.type === 'done') {
      $('barFill').style.width = '100%';
      $('pText').textContent = `完了（${m.seconds.toFixed(1)}秒）`;
      lastResult = m;
      const userRun = !!lastRunMsg && !(m.demo && demoCount === 1);
      try {
        showResult(m);
        if (userRun) {
          $('resultSec').scrollIntoView({ behavior: 'smooth', block: 'start' });
          const v = $('viewer'); v.classList.remove('flash'); void v.offsetWidth; v.classList.add('flash');
        }
      } catch (err) { showError('結果の表示に失敗しました: ' + err.message); }
      finishRun();
    } else if (m.type === 'preview') {
      if (lastResult) { lastResult.preview = m.preview; if (m.first) lastResult.first = m.first; drawView(); }
    } else if (m.type === 'zoom') {
      const c = $('zoom');
      c.width = m.preview.w; c.height = m.preview.h;
      c.getContext('2d').putImageData(new ImageData(m.preview.data, m.preview.w, m.preview.h), 0, 0);
      $('zoombox').hidden = false;
    } else if (m.type === 'export') {
      const cb = pending.get(m.id); pending.delete(m.id);
      if (cb) cb.resolve(m);
    } else if (m.type === 'error') {
      const cb = m.id != null ? pending.get(m.id) : null;
      if (cb) { pending.delete(m.id); cb.reject(new Error(m.message)); return; }
      if (busy) { showError(m.message); finishRun(); $('progress').hidden = true; }
      else if (files.length) $('fileMeta').textContent = `${files.length}枚・${m.message}`;
    }
  }

  function showError(t) { $('error').textContent = t; $('error').hidden = false; }
  function hideError() { $('error').hidden = true; }

  function showResult(m) {
    $('resultEmpty').hidden = true;
    $('resultBody').hidden = false;
    $('demoBadge').hidden = !m.demo;
    const now = new Date();
    $('demoBadge').textContent = `サンプル #${demoCount}・${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')} 合成`;
    $('tabFirst').hidden = !m.first;
    $('zoombox').hidden = true;
    drawView();
    $('stSize').textContent = (m.orientation >= 5 ? `${m.height}×${m.width}` : `${m.width}×${m.height}`);
    const used = m.frames.filter((f) => f.share > 0).length;
    $('stFrames').textContent = `${used} / ${m.frames.length}`;
    $('stTime').textContent = m.seconds.toFixed(1) + ' 秒';
    $('legendEnd').textContent = `${m.frames.length}枚目（奥）`;
    // Contribution rail
    const rail = $('rail');
    rail.innerHTML = '';
    const head = document.createElement('div'); head.className = 'rail-row rail-head';
    head.innerHTML = '<span></span><span>フレームごとの採用率（色は深度マップと対応）</span><span style="text-align:right">採用</span><span style="text-align:right">画角補正</span>';
    rail.appendChild(head);
    const maxShare = Math.max(...m.frames.map((f) => f.share), 0.0001);
    const cols = [[38, 70, 83], [42, 157, 143], [138, 177, 125], [233, 196, 106], [244, 162, 97], [231, 111, 81], [190, 60, 90]];
    const colorAt = (t) => { const p = t * 6, i = Math.min(5, Math.floor(p)), f = p - i; const a = cols[i], b = cols[i + 1]; return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(',')})`; };
    m.frames.forEach((f, i) => {
      const row = document.createElement('div'); row.className = 'rail-row';
      row.title = f.name;
      const idx = document.createElement('span'); idx.className = 'i'; idx.textContent = i + 1;
      const tr = document.createElement('span'); tr.className = 'track';
      const bar = document.createElement('i'); bar.style.width = (f.share / maxShare * 100).toFixed(1) + '%'; bar.style.background = colorAt(m.frames.length > 1 ? i / (m.frames.length - 1) : 0);
      tr.appendChild(bar);
      const v = document.createElement('span'); v.className = 'v'; v.textContent = (f.share * 100).toFixed(1) + '%';
      const s = document.createElement('span'); s.className = 's'; const pct = (f.scale - 1) * 100; s.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
      row.append(idx, tr, v, s);
      rail.appendChild(row);
    });
    const w = $('warn');
    if (m.warnings && m.warnings.length) {
      w.innerHTML = '';
      const ul = document.createElement('ul');
      m.warnings.forEach((t) => { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
      w.appendChild(ul); w.hidden = false;
    } else w.hidden = true;
    $('saved').textContent = '';
  }

  function drawView() {
    if (!lastResult) return;
    if (view === 'first' && !lastResult.first) view = 'image';
    const src = view === 'image' ? lastResult.preview : view === 'first' ? lastResult.first : lastResult.depth;
    const c = $('view');
    c.width = src.w; c.height = src.h;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(src.data), src.w, src.h), 0, 0);
    $('viewTag').textContent = view === 'image' ? '合成結果' : view === 'first' ? '合成前（1枚目のみ）' : '深度マップ（どのフレームを使ったか）';
    for (const [id, v] of [['tabImage', 'image'], ['tabFirst', 'first'], ['tabDepth', 'depth']]) $(id).setAttribute('aria-pressed', String(view === v));
    $('legend').hidden = view !== 'depth';
  }

  for (const [id, v] of [['tabImage', 'image'], ['tabFirst', 'first'], ['tabDepth', 'depth']]) $(id).addEventListener('click', () => { view = v; drawView(); });

  $('view').addEventListener('click', (e) => {
    if (!lastResult || busy) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    const size = Math.round(Math.min(900, Math.max(320, ($('resultSec').clientWidth || 600) * Math.min(2, window.devicePixelRatio || 1))));
    worker.postMessage({ type: 'zoom', x, y, size, exposure: +$('exposure').value });
  });
  $('zoomClose').addEventListener('click', () => { $('zoombox').hidden = true; });

  let expTimer = null;
  $('exposure').addEventListener('input', () => {
    const v = +$('exposure').value;
    $('expOut').textContent = (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(1) + ' EV';
    clearTimeout(expTimer);
    expTimer = setTimeout(() => { if (lastResult && !busy) worker.postMessage({ type: 'preview', exposure: v, previewSize: previewSize() }); }, 120);
  });

  function requestExport(format, zip) {
    const id = ++exportId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ type: 'export', id, format, zip, exposure: +$('exposure').value, demo: !!(lastResult && lastResult.demo) });
    });
  }

  async function rgbaToJpegBlob(r) {
    const c = document.createElement('canvas'); c.width = r.w; c.height = r.h;
    c.getContext('2d').putImageData(new ImageData(r.data, r.w, r.h), 0, 0);
    return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.93));
  }

  document.querySelectorAll('.exports button').forEach((btn) => btn.addEventListener('click', async () => {
    if (!lastResult || busy) return;
    const fmt = btn.dataset.fmt;
    const label = { dng: 'DNG', tiff: 'TIFF', jpeg: 'JPEG' }[fmt];
    const buttons = document.querySelectorAll('.exports button');
    buttons.forEach((b) => (b.disabled = true));
    $('saved').textContent = `${label}を書き出しています…`;
    try {
      await capReady;
      const useCap = !!downloadsCap;
      const m = await requestExport(fmt, useCap);
      let blob, name = m.name;
      if (m.rgba) blob = await rgbaToJpegBlob(m.rgba);
      else if (m.zip) { blob = m.zip; name = m.name.replace(/\.[^.]+$/, '') + '.zip'; }
      else blob = new Blob([m.bytes], { type: fmt === 'jpeg' ? 'image/jpeg' : fmt === 'dng' ? 'image/x-adobe-dng' : 'image/tiff' });
      const size = fmtMB(blob.size);
      if (useCap) {
        try {
          await downloadsCap.save({ filename: name, data: blob });
          $('saved').textContent = m.zip ? `${name}（${size}）を保存しました。ZIPを展開すると ${m.name} が入っています。` : `${name}（${size}）を保存しました。`;
        } catch (err) {
          const code = err && err.code;
          $('saved').textContent = code === 'declined' ? '保存をキャンセルしました。' : code === 'rate_limited' ? '保存の確認画面がすでに開いています。少し待ってからもう一度押してください。' : '保存できませんでした: ' + (err.message || code);
        }
      } else {
        const file = new File([blob], name, { type: blob.type });
        if (navigator.canShare && navigator.canShare({ files: [file] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
          try { await navigator.share({ files: [file] }); $('saved').textContent = `${name}（${size}）を共有メニューに渡しました。`; return; }
          catch (err) { if (err && err.name === 'AbortError') { $('saved').textContent = '保存をキャンセルしました。'; return; } }
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        $('saved').textContent = `${name}（${size}）をダウンロードしました。`;
      }
    } catch (err) {
      $('saved').textContent = '書き出せませんでした: ' + err.message;
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  }));

  renderFiles();
  // Open in a working state: run the small built-in sample once.
  setTimeout(() => startRun(true), 300);
})();
