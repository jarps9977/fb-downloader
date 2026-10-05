var currentStreams = [];
var currentMedia = null;
var pendingSourceUrl = '';

async function analyzeUrl(event) {
  event.preventDefault();

  var url = document.getElementById('url-input').value.trim();
  var errorEl = document.getElementById('error');
  var button = document.getElementById('analyze-btn');
  errorEl.textContent = '';
  hideSourceFallback();
  resetResults(false);

  if (!url) {
    errorEl.textContent = 'กรุณาใส่ URL';
    return;
  }

  if (!url.match(/^https?:\/\/([^/]+\.)?(facebook\.com|fb\.watch|instagram\.com)\//i)) {
    errorEl.textContent = 'URL ต้องเป็น Facebook, fb.watch หรือ Instagram เท่านั้น';
    return;
  }

  pendingSourceUrl = url;
  updateViewSourceLink(url);
  button.disabled = true;
  button.textContent = 'กำลังค้นหา...';
  showLoading('กำลังดึงข้อมูล...');

  try {
    var resp = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url })
    });

    var data = await resp.json();
    if (!resp.ok) {
      if (resp.status === 429) {
        errorEl.textContent = data.error;
        return;
      }
      errorEl.textContent = '';
      showSourceFallback(url);
      return;
    }

    if (data.kind === 'media') {
      renderMediaSet(data);
      return;
    }

    currentStreams = uniqueQualityStreams(data.streams || []);
    renderResults(currentStreams);
  } catch (err) {
    errorEl.textContent = 'เชื่อมต่อ server ไม่ได้ กรุณารัน npm start แล้วลองใหม่';
  } finally {
    hideLoading();
    button.disabled = false;
    button.textContent = 'ค้นหาวิดีโอ';
  }
}

function renderMediaSet(data) {
  var items = data.items || [];
  var resultsList = document.getElementById('results-list');
  currentStreams = uniqueQualityStreams(data.streams || []);
  currentMedia = data;
  resultsList.innerHTML = '';
  setResultsHeader('ไฟล์ทั้งหมด (' + items.length + ')', items.length > 0);

  var detailEls = [];
  items.forEach(function(item, index) {
    var isVideo = item.type === 'video';
    var size = item.quality
      ? ' · ' + item.quality + 'p (รวมภาพ+เสียง)'
      : (item.width && item.height ? ' · ' + item.width + '×' + item.height : '');
    var row = createResultItem(
      (isVideo ? 'วิดีโอ ' : 'รูป ') + (index + 1),
      isVideo ? 'badge-hd' : 'badge-fhd',
      (isVideo ? 'MP4' : 'JPG') + size,
      function(button) {
        button.disabled = true;
        downloadMediaFile(index, item.filename);
        markDownloadDone(button, item.quality ? 'กำลังรวมไฟล์ HD ที่ server อาจใช้เวลาสักครู่' : 'Download สำเร็จ');
      },
      {
        src: item.hasPreview ? mediaPreviewUrl(index, false) : null,
        isVideo: isVideo,
        onOpen: function() {
          openLightbox(index);
        }
      }
    );
    var detail = row.querySelector('.result-meta p');
    detail.textContent += ' · กำลังคำนวณขนาด...';
    detailEls.push({ el: detail, base: (isVideo ? 'MP4' : 'JPG') + size });
    resultsList.appendChild(row);
  });

  if (items.length > 0) loadMediaSizes(data.token, detailEls);

  // Video only available as DASH quality options; not part of the ZIP.
  currentStreams.forEach(function(stream, index) {
    resultsList.appendChild(createResultItem(
      stream.label || 'Video',
      getBadgeClass(stream.label),
      'วิดีโอ (ไม่รวมใน ZIP)',
      function(button) {
        downloadStream(index, button);
      }
    ));
  });

  document.getElementById('results-section').hidden = items.length === 0 && currentStreams.length === 0;
}

async function loadMediaSizes(token, detailEls) {
  var sizes = [];
  try {
    var resp = await fetch('/api/media/sizes?token=' + encodeURIComponent(token));
    if (resp.ok) sizes = (await resp.json()).sizes || [];
  } catch (err) {}

  // Results may have been replaced while sizes were loading.
  if (!currentMedia || currentMedia.token !== token) return;

  var total = 0;
  detailEls.forEach(function(entry, index) {
    var bytes = sizes[index];
    if (bytes) total += bytes;
    entry.el.textContent = entry.base + (bytes ? ' · ' + formatBytes(bytes) : '');
  });

  var title = document.getElementById('results-title');
  if (total > 0) title.textContent = 'ไฟล์ทั้งหมด (' + detailEls.length + ') · ' + formatBytes(total);
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

function mediaPreviewUrl(index, full) {
  return '/api/media/preview?token=' + encodeURIComponent(currentMedia.token) + '&index=' + index + (full ? '&full=1' : '');
}

function openLightbox(index) {
  if (!currentMedia || !currentMedia.items[index]) return;

  var item = currentMedia.items[index];
  var body = document.getElementById('lightbox-body');
  body.innerHTML = '';

  var el = document.createElement(item.type === 'video' ? 'video' : 'img');
  el.src = mediaPreviewUrl(index, true);
  if (item.type === 'video') {
    el.controls = true;
    el.autoplay = true;
    el.playsInline = true;
  } else {
    el.alt = item.filename || '';
  }
  body.appendChild(el);
  document.getElementById('lightbox').hidden = false;
}

function closeLightbox(event) {
  var lightbox = document.getElementById('lightbox');
  if (event && event.target !== lightbox && !event.target.classList.contains('lightbox-close')) return;

  // Clearing the node stops video playback and its range requests.
  document.getElementById('lightbox-body').innerHTML = '';
  lightbox.hidden = true;
}

document.addEventListener('keydown', function(event) {
  if (event.key === 'Escape' && !document.getElementById('lightbox').hidden) {
    document.getElementById('lightbox-body').innerHTML = '';
    document.getElementById('lightbox').hidden = true;
  }
});

function downloadMediaFile(index, filename) {
  var anchor = document.createElement('a');
  anchor.href = '/api/media/file?token=' + encodeURIComponent(currentMedia.token) + '&index=' + index;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

function downloadMediaZip() {
  if (!currentMedia) return;

  var anchor = document.createElement('a');
  anchor.href = '/api/media/zip?token=' + encodeURIComponent(currentMedia.token);
  anchor.download = currentMedia.prefix + '.zip';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

function setResultsHeader(title, showZip) {
  document.getElementById('results-title').textContent = title;
  document.getElementById('zip-btn').hidden = !showZip;

  var photosBtn = document.getElementById('photos-btn');
  photosBtn.hidden = !showZip || !canShareFiles();
  photosBtn.textContent = 'บันทึกลง Photos';
  preparedShareFiles = null;
}

var preparedShareFiles = null;

function canShareFiles() {
  try {
    return !!(navigator.canShare && navigator.canShare({ files: [new File([''], 'x.jpg', { type: 'image/jpeg' })] }));
  } catch (err) {
    return false;
  }
}

// Safari drops the user gesture during long fetches, so prepare on the first tap and share on the second.
async function saveMediaToPhotos(button) {
  if (!currentMedia) return;

  if (preparedShareFiles && preparedShareFiles.token === currentMedia.token) {
    try {
      await navigator.share({ files: preparedShareFiles.files });
    } catch (err) {
      if (err.name !== 'AbortError') alert('บันทึกไม่สำเร็จ: ' + err.message);
    }
    return;
  }

  var token = currentMedia.token;
  var items = currentMedia.items;
  var files = [];
  button.disabled = true;
  try {
    for (var i = 0; i < items.length; i++) {
      button.textContent = 'กำลังเตรียมไฟล์ ' + (i + 1) + '/' + items.length;
      var resp = await fetch('/api/media/file?token=' + encodeURIComponent(token) + '&index=' + i);
      if (!resp.ok) throw new Error(await resp.text());
      var blob = await resp.blob();
      var type = blob.type || (items[i].type === 'video' ? 'video/mp4' : 'image/jpeg');
      files.push(new File([blob], items[i].filename, { type: type }));
    }
    if (!currentMedia || currentMedia.token !== token) return;
    preparedShareFiles = { token: token, files: files };
    button.textContent = 'แตะอีกครั้งเพื่อบันทึก';
  } catch (err) {
    button.textContent = 'บันทึกลง Photos';
    alert('เตรียมไฟล์ไม่สำเร็จ: ' + err.message);
  } finally {
    button.disabled = false;
  }
}

function showSourceFallback(url) {
  pendingSourceUrl = url;
  updateViewSourceLink(url);
  var panel = document.getElementById('source-fallback');
  document.getElementById('source-input').value = '';
  panel.hidden = false;
  document.getElementById('source-status').textContent = 'URL นี้ต้อง login: กด Copy Link แล้วเปิดใน browser ที่ login อยู่ copy source ทั้งหน้ามาวางด้านล่าง แล้วกด Show Download';
}

function hideSourceFallback() {
  document.getElementById('source-status').textContent = '';
}

function updateViewSourceLinkFromInput() {
  updateViewSourceLink(document.getElementById('url-input').value.trim());
}

function updateViewSourceLink(url) {
  var link = document.getElementById('view-source-link');
  if (!link) return;

  if (!url) {
    link.href = '#';
    link.textContent = 'วาง URL ด้านบนเพื่อสร้าง View Source link';
    pendingSourceUrl = '';
    return;
  }

  var viewSourceUrl = 'view-source:' + url;
  link.href = viewSourceUrl;
  link.textContent = viewSourceUrl;
  pendingSourceUrl = url;
}

async function importSourceFromClipboard() {
  var statusEl = document.getElementById('source-status');
  statusEl.textContent = '';
  showLoading('กำลังอ่าน source จาก clipboard...');

  try {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      statusEl.textContent = 'Browser นี้ยังไม่อนุญาตให้อ่าน clipboard จากหน้าเว็บ';
      return;
    }

    var source = await navigator.clipboard.readText();
    if (!source || source.length < 1000) {
      statusEl.textContent = 'ยังไม่พบ source ที่ถูกต้องใน clipboard';
      return;
    }

    document.getElementById('source-input').value = source;
    await parseSourceInBackground(source, statusEl);
  } catch (err) {
    statusEl.textContent = 'อ่าน clipboard ไม่สำเร็จ กรุณาอนุญาตสิทธิ์ clipboard แล้วลองใหม่';
  } finally {
    hideLoading();
  }
}

async function copyViewSourceUrl() {
  var statusEl = document.getElementById('source-status');
  var link = document.getElementById('view-source-link').href;
  statusEl.textContent = '';

  try {
    await navigator.clipboard.writeText(link);
    statusEl.textContent = 'Copy link แล้ว เปิดแท็บใหม่แล้ววาง URL นี้ได้เลย';
  } catch (err) {
    statusEl.textContent = 'Copy link อัตโนมัติไม่สำเร็จ ให้เลือก link แล้ว copy เอง';
  }
}

async function parseSourceFromTextarea() {
  var statusEl = document.getElementById('source-status');
  var source = document.getElementById('source-input').value.trim();
  statusEl.textContent = '';

  if (!source || source.length < 1000) {
    statusEl.textContent = 'กรุณาวาง source จากหน้า View Source ก่อน';
    return;
  }

  showLoading('กำลังค้นหาวิดีโอจาก source...');
  try {
    await parseSourceInBackground(source, statusEl);
  } finally {
    hideLoading();
  }
}

async function parseSourceInBackground(source, statusEl) {
  var resp = await fetch('/api/parse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: source })
  });

  var data = await resp.json();
  if (!resp.ok) {
    statusEl.textContent = formatParseError(data);
    return;
  }

  hideSourceFallback();
  if (data.kind === 'media') {
    renderMediaSet(data);
    return;
  }

  currentStreams = uniqueQualityStreams(data.streams || []);
  renderResults(currentStreams);
}

function formatParseError(data) {
  if (!data || !data.diagnostics) return data?.error || 'source นี้ยังไม่พบวิดีโอ';

  var counts = data.diagnostics.counts || {};
  var important = [
    'manifest_xml: ' + (counts.manifest_xml || 0),
    'dash_manifest: ' + (counts.dash_manifest || 0),
    '.mp4: ' + (counts['.mp4'] || 0),
    'playable_url: ' + (counts.playable_url || 0)
  ].join(', ');

  return (data.error || 'source นี้ยังไม่พบวิดีโอ') + ' | ' + data.diagnostics.hint + ' | ' + important;
}

function uniqueQualityStreams(streams) {
  var wanted = [2160, 1440, 1080, 720, 480, 360];
  var byQuality = {};

  streams.forEach(function(stream) {
    var quality = Number(stream.quality || 0);
    if (!wanted.includes(quality)) return;

    var existing = byQuality[quality];
    if (!existing) {
      byQuality[quality] = stream;
      return;
    }

    if (!existing.isDash && stream.isDash) return;
    if ((stream.audioUrl && !existing.audioUrl) || (stream.url && !existing.url)) {
      byQuality[quality] = stream;
    }
  });

  return wanted.filter(function(quality) {
    return byQuality[quality];
  }).map(function(quality) {
    return byQuality[quality];
  });
}

function renderResults(streams) {
  var resultsSection = document.getElementById('results-section');
  var resultsList = document.getElementById('results-list');
  resultsList.innerHTML = '';
  currentMedia = null;
  setResultsHeader('เลือกความคมชัด', false);

  streams.forEach(function(stream, index) {
    resultsList.appendChild(createResultItem(
      stream.label || 'Video',
      getBadgeClass(stream.label),
      stream.isDash ? 'รวมภาพ+เสียง (ไม่ลดคุณภาพ)' : 'ไฟล์ MP4 พร้อมดาวน์โหลด',
      function(button) {
        downloadStream(index, button);
      }
    ));
  });

  resultsSection.hidden = streams.length === 0;
}

function createResultItem(badgeText, badgeClass, detailText, onDownload, preview) {
  var item = document.createElement('article');
  item.className = 'result-item';

  var meta = document.createElement('div');
  meta.className = 'result-meta';

  if (preview) {
    var thumb = document.createElement('button');
    thumb.type = 'button';
    thumb.className = 'thumb' + (preview.isVideo ? ' is-video' : '');
    thumb.setAttribute('aria-label', 'Preview ' + badgeText);
    thumb.onclick = preview.onOpen;

    if (preview.src) {
      var img = document.createElement('img');
      img.src = preview.src;
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = function() {
        img.remove();
      };
      thumb.appendChild(img);
    }
    meta.appendChild(thumb);
  }

  var badge = document.createElement('span');
  badge.className = 'quality-badge ' + badgeClass;
  badge.textContent = badgeText;

  var detail = document.createElement('p');
  detail.textContent = detailText;

  meta.appendChild(badge);
  meta.appendChild(detail);

  var button = document.createElement('button');
  button.className = 'btn-download';
  button.type = 'button';
  button.textContent = 'Download';
  button.onclick = function() {
    onDownload(button);
  };

  item.appendChild(meta);
  item.appendChild(button);
  return item;
}

function getBadgeClass(label) {
  var value = String(label || '').toLowerCase();
  if (value.includes('2160') || value.includes('4k')) return 'badge-4k';
  if (value.includes('1080')) return 'badge-fhd';
  if (value.includes('720') || value.includes('hd')) return 'badge-hd';
  return 'badge-sd';
}

function downloadStream(index, button) {
  var stream = currentStreams[index];
  if (!stream) return;

  if (stream.isDash) {
    downloadDash(stream, button);
    return;
  }

  button.disabled = true;
  button.textContent = 'Downloading...';
  var filename = 'fb_video_' + safeName(stream.label || 'video') + '.mp4';
  downloadDirectUrl(stream.url, filename);
  markDownloadDone(button, 'Download สำเร็จ');
}

async function downloadDash(stream, button) {
  button.disabled = true;
  button.textContent = 'Merging...';
  showLoading('กำลังรวมไฟล์วิดีโอความคมชัดสูง...');

  try {
    var resp = await fetch('/api/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoUrl: stream.url,
        audioUrl: stream.audioUrl || null,
        quality: stream.label || 'video'
      })
    });

    if (!resp.ok) {
      var err = await resp.json();
      if (err.canDownloadVideoOnly && err.fallbackUrl) {
        downloadDirectUrl(err.fallbackUrl, 'fb_video_' + safeName((err.fallbackLabel || stream.label || 'video') + '_video_only') + '.mp4');
        markDownloadDone(button, 'Download สำเร็จ');
        return;
      }
      markDownloadDone(button, err.error || 'Download ไม่สำเร็จ', true);
      return;
    }

    var blob = await resp.blob();
    var objectUrl = URL.createObjectURL(blob);
    var anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = 'fb_video_' + safeName(stream.label || 'video') + '.mp4';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(objectUrl);
  } catch (err) {
    markDownloadDone(button, 'Download ไม่สำเร็จ: ' + err.message, true);
  } finally {
    hideLoading();
  }
}

function downloadDirectUrl(url, filename) {
  var anchor = document.createElement('a');
  anchor.href = '/api/download?url=' + encodeURIComponent(url) + '&filename=' + encodeURIComponent(filename || 'fb_video.mp4');
  anchor.download = filename || 'fb_video.mp4';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

function markDownloadDone(button, message, isError) {
  button.disabled = false;
  button.textContent = isError ? 'Error' : 'Download';
  setStatusMessage(button, message, isError);
}

function setStatusMessage(button, message, isError) {
  var item = button.closest('.result-item');
  if (!item) return;

  var status = item.querySelector('.download-status');
  if (!status) {
    status = document.createElement('div');
    status.className = 'download-status';
    item.appendChild(status);
  }
  status.textContent = message;
  status.classList.toggle('is-error', !!isError);
}

function resetResults(clearInput) {
  currentStreams = [];
  currentMedia = null;
  setResultsHeader('เลือกความคมชัด', false);
  document.getElementById('results-list').innerHTML = '';
  document.getElementById('results-section').hidden = true;
  if (clearInput !== false) {
    document.getElementById('url-input').value = '';
    document.getElementById('error').textContent = '';
    document.getElementById('source-input').value = '';
    updateViewSourceLink('');
    hideSourceFallback();
  }
}

function safeName(value) {
  return String(value).replace(/[^a-z0-9]/gi, '_');
}

function showLoading(text) {
  document.getElementById('loading-text').textContent = text || 'กำลังประมวลผล...';
  document.getElementById('loading-overlay').hidden = false;
}

function hideLoading() {
  document.getElementById('loading-overlay').hidden = true;
}
