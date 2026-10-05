const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.json({ limit: '80mb' }));
app.use(express.static(path.join(__dirname, 'public')));

loadLocalEnv();

const FB_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://www.facebook.com/',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'same-origin',
};

function loadLocalEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim().replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function validateSupportedUrl(url) {
  return /^https?:\/\/([^/]+\.)?(facebook\.com|fb\.watch|instagram\.com)\//i.test(url || '');
}

function buildSourceCandidates(url) {
  const candidates = [url];
  try {
    const parsed = new URL(url);
    if (/facebook\.com$/i.test(parsed.hostname)) {
      for (const host of ['www.facebook.com', 'm.facebook.com', 'mbasic.facebook.com']) {
        const clone = new URL(parsed.toString());
        clone.hostname = host;
        candidates.push(clone.toString());
      }
    } else if (/instagram\.com$/i.test(parsed.hostname)) {
      for (const host of ['www.instagram.com', 'm.instagram.com']) {
        const clone = new URL(parsed.toString());
        clone.hostname = host;
        candidates.push(clone.toString());
      }
    }
  } catch {}

  return [...new Set(candidates)];
}

function isLoginRedirect(finalUrl) {
  return /(facebook|instagram)\.com\/(login|accounts\/login)/i.test(finalUrl || '');
}

function decodeFacebookValue(value) {
  return String(value || '')
    .replace(/\\\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\//g, '/')
    .replace(/\\\\\//g, '/')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\\n/g, '\n')
    .replace(/\\\\"/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .trim();
}

function normalizeVideoUrl(url) {
  return decodeFacebookValue(url)
    .replace(/\\u0025/g, '%')
    .replace(/\\u0026/g, '&')
    .replace(/\s/g, '');
}

const ALLOWED_MEDIA_HOST_SUFFIXES = ['fbcdn.net', 'cdninstagram.com'];

function isAllowedMediaUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.port && parsed.port !== '443') return false;

  const host = parsed.hostname.toLowerCase();
  return ALLOWED_MEDIA_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
}

// Re-check every redirect hop so an allowed CDN URL cannot bounce to an internal host.
function assertAllowedRedirect(options) {
  const port = options.port ? `:${options.port}` : '';
  const target = `${options.protocol}//${options.hostname}${port}${options.path || '/'}`;
  if (!isAllowedMediaUrl(target)) {
    throw new Error('Redirect target not allowed');
  }
}

async function fetchRemoteSource(url, cookies) {
  const headers = { ...FB_HEADERS };
  if (/instagram\.com/i.test(url)) {
    headers.Referer = 'https://www.instagram.com/';
  }
  if (cookies) headers.Cookie = cookies;

  const resp = await axios.get(url, {
    headers,
    timeout: 25000,
    maxRedirects: 5,
    decompress: true,
    proxy: false,
    validateStatus: status => status >= 200 && status < 400,
  });

  return { source: resp.data, status: resp.status, finalUrl: resp.request?.res?.responseUrl || url };
}

async function getStreamsFromSource(source) {
  const results = [];
  const seen = new Set();

  const addUrl = (url, label, quality, isDash, audioUrl) => {
    const clean = normalizeVideoUrl(url);
    if (!clean || !clean.startsWith('http') || seen.has(clean)) return;
    seen.add(clean);
    results.push({ url: clean, label, quality, isDash: !!isDash, audioUrl: audioUrl || null });
  };

  const extractByKey = (key, label, quality) => {
    const patterns = [
      new RegExp(`"${key}"\\s*:\\s*"(https?:\\\\/\\\\/[^"]{10,})"`, 'g'),
      new RegExp(`"${key}"\\s*:\\s*"(https?:\\/\\/[^"]{10,})"`, 'g'),
      new RegExp(`${key}\\\\?":\\\\?"(https?:[^"\\\\]{10,})`, 'g'),
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(source)) !== null) {
        addUrl(match[1], label, quality, false);
      }
    }
  };

  extractByKey('playable_url_quality_hd', 'HD 720p', 720);
  extractByKey('browser_native_hd_url', 'HD 720p', 720);
  extractByKey('playable_url', 'SD 480p', 480);
  extractByKey('browser_native_sd_url', 'SD 480p', 480);
  extractByKey('video_url', 'Video', 720);
  extractByKey('video_dash_manifest', 'Video', 720);

  const instagramVideoPatterns = [
    /"video_url"\s*:\s*"((?:\\.|[^"\\]){10,})"/g,
    /\\"video_url\\"\s*:\s*\\"((?:\\.|[^"\\]){10,})\\"/g,
    /"src"\s*:\s*"((?:\\.|[^"\\]){10,}\.mp4(?:\\.|[^"\\])*)"/g,
  ];

  for (const pattern of instagramVideoPatterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      addUrl(match[1], 'Instagram Video', 720, false);
    }
  }

  const dashPatterns = [
    /"manifest_xml"\s*:\s*"((?:\\.|[^"\\]){50,})"/g,
    /\\"manifest_xml\\"\s*:\s*\\"((?:\\.|[^"\\]){50,})\\"/g,
    /\\+"manifest_xml\\+"\s*:\s*\\+"((?:\\.|[^"\\]){50,})\\+"/g,
    /\\?"dash_manifest\\?"\s*:\s*\\?"((?:\\.|[^"\\]){50,})\\?"/,
    /"dash_manifest"\s*:\s*"((?:\\.|[^"\\]){50,})"/,
    /dash_manifest\\?":\\?"((?:\\.|[^"\\]){50,})"/,
  ];

  for (const pattern of dashPatterns) {
    const matches = pattern.global ? [...source.matchAll(pattern)] : [source.match(pattern)].filter(Boolean);
    if (matches.length === 0) continue;

    try {
      for (const match of matches) {
        const manifestXml = decodeFacebookValue(match[1]);
        const dashStreams = await parseDash(manifestXml);
        dashStreams.forEach(stream => addUrl(stream.url, stream.label, stream.quality, true, stream.audioUrl));
      }
    } catch (err) {
      console.error('DASH parse error:', err.message);
    }
  }

  const mp4Pattern = /(https?:\\?\/\\?\/[^"'<>\\\s]+?\.mp4[^"'<>\\\s]*)/g;
  let mp4Match;
  while ((mp4Match = mp4Pattern.exec(source)) !== null) {
    const url = normalizeVideoUrl(mp4Match[1]);
    if (/fbcdn|facebook|instagram|cdninstagram|video/i.test(url)) {
      addUrl(url, 'Auto MP4', 360, false);
    }
  }

  return results.sort((a, b) => (b.quality || 0) - (a.quality || 0));
}

app.post('/api/analyze', async (req, res) => {
  const { url } = req.body;
  const cookies = req.body.cookies || process.env.FB_COOKIE || '';
  if (!url) return res.status(400).json({ error: 'กรุณาใส่ URL' });
  if (!validateSupportedUrl(url)) {
    return res.status(400).json({ error: 'URL ต้องเป็น Facebook, fb.watch หรือ Instagram เท่านั้น' });
  }

  const attempts = [];

  try {
    for (const candidateUrl of buildSourceCandidates(url)) {
      const fetched = await fetchRemoteSource(candidateUrl, cookies);
      const streams = isLoginRedirect(fetched.finalUrl) ? [] : await getStreamsFromSource(fetched.source);
      attempts.push({ url: candidateUrl, finalUrl: fetched.finalUrl, streamCount: streams.length });

      if (streams.length > 0) {
        return res.json({ streams, finalUrl: fetched.finalUrl });
      }
    }

    return res.status(404).json({
      error: cookies
        ? 'ยังไม่พบไฟล์วิดีโอจาก URL นี้ แม้ใช้ session แล้ว อาจเป็น story หมดอายุหรือหน้าเว็บเปลี่ยนโครงสร้าง'
        : 'ต้องใช้ Page Source จาก browser ที่ login',
      attempts,
    });
  } catch (err) {
    const status = err.response?.status;
    res.status(500).json({
      error: `ดึงข้อมูลไม่สำเร็จ${status ? ` (${status})` : ''}: ${err.message}`,
    });
  }
});

app.post('/api/parse', async (req, res) => {
  const { source } = req.body;
  if (!source) return res.status(400).json({ error: 'No source provided' });

  const streams = await getStreamsFromSource(source);
  if (streams.length === 0) {
    return res.status(404).json({
      error: 'ไม่พบ video URL ใน source นี้',
      diagnostics: analyzeSourceDiagnostics(source),
    });
  }

  res.json({ streams });
});

function analyzeSourceDiagnostics(source) {
  const terms = [
    'manifest_xml',
    'dash_manifests',
    'dash_manifest',
    'FBQualityLabel',
    'BaseURL',
    'playable_url',
    'browser_native',
    '.mp4',
    'video',
  ];

  const counts = {};
  for (const term of terms) {
    counts[term] = (source.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) || []).length;
  }

  return {
    length: source.length,
    counts,
    hint: counts.manifest_xml || counts.dash_manifest || counts['.mp4']
      ? 'source มีคำเกี่ยวกับวิดีโอ แต่ parser ยังอ่านรูปแบบนี้ไม่ออก'
      : 'source นี้น่าจะเป็น DOM shell จาก iOS Shortcut ยังไม่มี payload วิดีโอ ให้ลอง copy จาก Network response ที่มี manifest_xml หรือ .mp4',
  };
}

async function parseDash(xml) {
  const regexStreams = parseDashWithRegex(xml);
  if (regexStreams.length > 0) return regexStreams;

  const parsed = await xml2js.parseStringPromise(xml, { explicitArray: true });
  const videos = [];
  const audios = [];

  const periods = parsed?.MPD?.Period || [];
  for (const period of periods) {
    const sets = period?.AdaptationSet || [];
    for (const set of sets) {
      const setType = set?.$?.mimeType || set?.$?.contentType || '';
      const reps = set?.Representation || [];

      for (const rep of reps) {
        const mimeType = rep?.$?.mimeType || setType;
        const height = parseInt(rep?.$?.height || '0', 10);
        const width = parseInt(rep?.$?.width || '0', 10);
        const bandwidth = parseInt(rep?.$?.bandwidth || '0', 10);
        const qualityLabel = rep?.$?.FBQualityLabel || '';
        const quality = parseInt((qualityLabel.match(/\d+/) || [])[0] || Math.min(width || height, height || width) || '0', 10);
        const baseUrls = rep?.BaseURL || [];

        for (const baseUrl of baseUrls) {
          const url = normalizeVideoUrl(typeof baseUrl === 'string' ? baseUrl : (baseUrl?._ || String(baseUrl)));
          if (!url || !url.startsWith('http')) continue;

          if (mimeType.includes('audio') || setType.includes('audio')) {
            audios.push({ url, bandwidth });
          } else if (mimeType.includes('video') || setType.includes('video')) {
            videos.push({ url, height, width, bandwidth, qualityLabel, quality });
          }
        }
      }
    }
  }

  audios.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
  const bestAudio = audios[0]?.url || null;

  return videos.map(video => ({
    url: video.url,
    audioUrl: bestAudio,
    label: video.qualityLabel || (video.quality ? `${video.quality}p` : `${Math.round((video.bandwidth || 0) / 1000)}kbps`),
    quality: video.quality || Math.round((video.bandwidth || 0) / 1000),
    isDash: true,
  }));
}

function parseDashWithRegex(xml) {
  const videos = [];
  const audios = [];
  const repRegex = /<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/g;

  let match;
  while ((match = repRegex.exec(xml)) !== null) {
    const attrs = match[1] || '';
    const body = match[2] || '';
    const baseUrlMatch = body.match(/<BaseURL>([\s\S]*?)<\/BaseURL>/);
    const url = normalizeVideoUrl(baseUrlMatch?.[1] || '');
    if (!url || !url.startsWith('http')) continue;

    const getAttr = name => (attrs.match(new RegExp(`${name}="([^"]*)"`)) || [])[1] || '';
    const mimeType = getAttr('mimeType');
    const bandwidth = parseInt(getAttr('bandwidth') || '0', 10);
    const qualityLabel = getAttr('FBQualityLabel');
    const width = parseInt(getAttr('width') || '0', 10);
    const height = parseInt(getAttr('height') || '0', 10);
    const quality = parseInt((qualityLabel.match(/\d+/) || [])[0] || Math.min(width || height, height || width) || '0', 10);

    if (mimeType.includes('audio')) {
      audios.push({ url, bandwidth });
    } else if (mimeType.includes('video')) {
      videos.push({ url, bandwidth, qualityLabel, quality });
    }
  }

  audios.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
  const bestAudio = audios[0]?.url || null;

  return videos.map(video => ({
    url: video.url,
    audioUrl: bestAudio,
    label: video.qualityLabel || (video.quality ? `${video.quality}p` : `${Math.round((video.bandwidth || 0) / 1000)}kbps`),
    quality: video.quality || Math.round((video.bandwidth || 0) / 1000),
    isDash: true,
  }));
}

app.post('/api/merge', async (req, res) => {
  const { videoUrl, audioUrl, quality } = req.body;
  if (!videoUrl) return res.status(400).json({ error: 'videoUrl required' });
  if (typeof videoUrl !== 'string' || !isAllowedMediaUrl(videoUrl)) {
    return res.status(400).json({ error: 'videoUrl not allowed' });
  }
  if (audioUrl && (typeof audioUrl !== 'string' || !isAllowedMediaUrl(audioUrl))) {
    return res.status(400).json({ error: 'audioUrl not allowed' });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbdl-'));
  const videoPath = path.join(tmpDir, 'video.mp4');
  const audioPath = path.join(tmpDir, 'audio.mp4');
  const outPath = path.join(tmpDir, `out_${quality || 'video'}.mp4`);

  try {
    await downloadFile(videoUrl, videoPath);
    const args = audioUrl
      ? ['-i', videoPath, '-i', audioPath, '-c:v', 'copy', '-c:a', 'aac', '-shortest', '-y', outPath]
      : ['-i', videoPath, '-c', 'copy', '-y', outPath];

    if (audioUrl) await downloadFile(audioUrl, audioPath);
    await runFfmpeg(args);

    const filename = `fb_video_${String(quality || 'video').replace(/[^a-z0-9]/gi, '_')}.mp4`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'video/mp4');

    const stream = fs.createReadStream(outPath);
    stream.pipe(res);
    stream.on('close', () => cleanup(tmpDir));
    stream.on('error', () => cleanup(tmpDir));
  } catch (err) {
    cleanup(tmpDir);
    res.status(500).json({
      error: 'ffmpeg merge failed: ' + err.message,
      fallbackUrl: videoUrl,
      fallbackAudioUrl: audioUrl || null,
      fallbackLabel: quality || 'video',
      canDownloadVideoOnly: true,
    });
  }
});

app.get('/api/download', async (req, res) => {
  const { url, filename } = req.query;
  if (typeof url !== 'string' || !url) return res.status(400).send('url required');

  let targetUrl;
  try {
    targetUrl = decodeURIComponent(url);
  } catch {
    return res.status(400).send('Invalid url');
  }
  if (!isAllowedMediaUrl(targetUrl)) return res.status(400).send('URL not allowed');

  try {
    const resp = await axios({
      method: 'GET',
      url: targetUrl,
      responseType: 'stream',
      timeout: 120000,
      headers: { ...FB_HEADERS },
      proxy: false,
      maxRedirects: 5,
      beforeRedirect: assertAllowedRedirect,
    });

    res.setHeader('Content-Disposition', `attachment; filename="${filename || 'fb_video.mp4'}"`);
    res.setHeader('Content-Type', resp.headers['content-type'] || 'video/mp4');
    if (resp.headers['content-length']) res.setHeader('Content-Length', resp.headers['content-length']);
    resp.data.pipe(res);
  } catch (err) {
    res.status(500).send('Download failed: ' + err.message);
  }
});

function downloadFile(url, dest) {
  return new Promise(async (resolve, reject) => {
    try {
      const resp = await axios({ method: 'GET', url, responseType: 'stream', timeout: 90000, headers: FB_HEADERS, proxy: false, maxRedirects: 5, beforeRedirect: assertAllowedRedirect });
      const writer = fs.createWriteStream(dest);
      resp.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: 180000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve();
    });
  });
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FB Downloader Pro -> http://localhost:${PORT}`));
