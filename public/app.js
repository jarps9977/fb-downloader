// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.getElementById('tab-url').style.display   = tab === 'url'   ? '' : 'none';
  document.getElementById('tab-paste').style.display = tab === 'paste' ? '' : 'none';
  document.querySelectorAll('.tab-btn').forEach(function(b, i) {
    b.classList.toggle('active', (tab === 'url' && i === 0) || (tab === 'paste' && i === 1));
  });
  document.getElementById('results-section').style.display = 'none';
  document.getElementById('results-list').innerHTML = '';
  clearErrors();
}

function clearErrors() {
  ['url-error','paste-error'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.textContent = '';
  });
}

// ── Tab 1: Fetch from URL ─────────────────────────────────────────────────────
async function fetchFromUrl() {
  var url = document.getElementById('url-input').value.trim();
  var errEl = document.getElementById('url-error');
  var btn   = document.getElementById('url-btn');
  errEl.textContent = '';

  if (!url) { errEl.textContent = 'กรุณาใส่ URL'; return; }
  if (!url.match(/^https?:\/\/(www\.)?(facebook\.com|fb\.watch)\//i)) {
    errEl.textContent = 'URL ต้องเป็น Facebook เท่านั้น';
    return;
  }

  btn.disabled    = true;
  btn.textContent = 'กำลังดึงข้อมูล...';
  showLoading('กำลัง fetch page source จาก Facebook...');

  try {
    // Step 1: fetch source
    var fetchResp = await fetch('/api/fetch-source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url })
    });
    var fetchData = await fetchResp.json();
    if (!fetchResp.ok) {
      errEl.textContent = fetchData.error || 'fetch ไม่สำเร็จ';
      return;
    }

    // Step 2: parse
    hideLoading();
    showLoading('กำลังวิเคราะห์หา video URL...');
    await parseAndRender(fetchData.source, errEl);

  } catch (e) {
    errEl.textContent = 'เชื่อมต่อ server ไม่ได้ — กรุณารัน: node server.js แล้วเปิด http://localhost:3000';
  } finally {
    hideLoading();
    btn.disabled    = false;
    btn.textContent = 'ดึงข้อมูลวิดีโอ';
  }
}

// ── Tab 2: Parse from pasted source ──────────────────────────────────────────
async function parseFromSource() {
  var src   = document.getElementById('source-input').value.trim();
  var errEl = document.getElementById('paste-error');
  var btn   = document.getElementById('parse-btn');
  errEl.textContent = '';

  if (!src) { errEl.textContent = 'กรุณา paste source code ก่อน'; return; }

  btn.disabled    = true;
  btn.textContent = 'กำลังค้นหา...';
  showLoading('กำลังวิเคราะห์หา video URL...');

  try {
    await parseAndRender(src, errEl);
  } catch (e) {
    errEl.textContent = 'เชื่อมต่อ server ไม่ได้ — กรุณารัน: node server.js แล้วเปิด http://localhost:3000';
  } finally {
    hideLoading();
    btn.disabled    = false;
    btn.textContent = 'ค้นหาวิดีโอ';
  }
}

// ── Core: send source to /api/parse and render results ────────────────────────
async function parseAndRender(source, errEl) {
  var resp = await fetch('/api/parse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: source })
  });
  var data = await resp.json();

  if (!resp.ok) {
    errEl.textContent = data.error || 'ไม่พบ video URL';
    return;
  }

  renderResults(data.streams);
}

// ── Render result list ────────────────────────────────────────────────────────
function getBadgeClass(label) {
  var l = label.toLowerCase();
  if (l.includes('2160') || l.includes('4k'))  return 'badge-4k';
  if (l.includes('1080'))                       return 'badge-fhd';
  if (l.includes('720')  || l.includes('hd'))  return 'badge-hd';
  return 'badge-sd';
}

function renderResults(streams) {
  var resList    = document.getElementById('results-list');
  var resSection = document.getElementById('results-section');
  resList.innerHTML = '';

  streams.forEach(function(item) {
    var div    = document.createElement('div');
    div.className = 'result-item';

    var badge  = document.createElement('span');
    badge.className = 'quality-badge ' + getBadgeClass(item.label);
    badge.textContent = item.label;

    var preview = document.createElement('span');
    preview.className   = 'url-preview';
    preview.textContent = item.url.substring(0, 65) + '...';
    preview.title       = item.url;

    var btn = document.createElement('button');
    btn.className   = 'btn-download';
    btn.textContent = 'Download';

    if (item.isDash) {
      btn.onclick = (function(u, l, b) {
        return function() { downloadDash(u, null, l, b); };
      })(item.url, item.label, btn);
    } else {
      btn.onclick = (function(u, l, b) {
        return function() { downloadProxy(u, l, b); };
      })(item.url, item.label, btn);
    }

    div.appendChild(badge);
    div.appendChild(preview);
    div.appendChild(btn);
    resList.appendChild(div);
  });

  resSection.style.display = 'block';
}

// ── Download: proxy (SD/HD) ───────────────────────────────────────────────────
function downloadProxy(url, label, btn) {
  btn.disabled    = true;
  btn.textContent = 'กำลัง download...';
  var filename = 'fb_video_' + label.replace(/[^a-z0-9]/gi,'_') + '.mp4';
  var a = document.createElement('a');
  a.href     = '/api/download?url=' + encodeURIComponent(url) + '&filename=' + encodeURIComponent(filename);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function() {
    btn.disabled    = false;
    btn.textContent = 'Download';
  }, 3000);
}

// ── Download: DASH merge via ffmpeg ──────────────────────────────────────────
async function downloadDash(videoUrl, audioUrl, label, btn) {
  btn.disabled    = true;
  btn.textContent = 'กำลัง merge...';
  showLoading('กำลัง merge ' + label + ' ด้วย ffmpeg...');
  try {
    var resp = await fetch('/api/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoUrl: videoUrl, audioUrl: audioUrl, quality: label })
    });
    if (!resp.ok) {
      var err = await resp.json();
      alert('Merge ไม่สำเร็จ: ' + (err.error || resp.status));
      return;
    }
    var blob   = await resp.blob();
    var objUrl = URL.createObjectURL(blob);
    var a      = document.createElement('a');
    a.href     = objUrl;
    a.download = 'fb_video_' + label.replace(/[^a-z0-9]/gi,'_') + '.mp4';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(objUrl);
  } catch (e) {
    alert('เกิดข้อผิดพลาด: ' + e.message);
  } finally {
    hideLoading();
    btn.disabled    = false;
    btn.textContent = 'Download';
  }
}

function clearAll() {
  document.getElementById('source-input').value = '';
  clearErrors();
  document.getElementById('results-section').style.display = 'none';
  document.getElementById('results-list').innerHTML = '';
}

function showLoading(text) {
  document.getElementById('loading-text').textContent = text || 'กำลังประมวลผล...';
  document.getElementById('loading-overlay').style.display = 'flex';
}

function hideLoading() {
  document.getElementById('loading-overlay').style.display = 'none';
}
