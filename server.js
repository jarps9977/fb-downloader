const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '80mb' }));
app.use(express.static(path.join(__dirname, 'public')));

loadLocalEnv();

// Behind Render's load balancer; needed so req.ip is the client address.
app.set('trust proxy', 1);

const analyzeLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });
const parseLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });
const downloadLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
const mergeLimiter = createRateLimiter({ windowMs: 60_000, max: 5 });
const zipLimiter = createRateLimiter({ windowMs: 60_000, max: 5 });
// One media set loads up to 50 thumbnails, and video seeking issues extra range requests.
const previewLimiter = createRateLimiter({ windowMs: 60_000, max: 300 });
const fileLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
const sizesLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });
const shortcutLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

// In-memory fixed window per IP; fine for a single instance, resets on restart.
function createRateLimiter({ windowMs, max }) {
  const hits = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || 'unknown';
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    const resetSeconds = Math.ceil((entry.resetAt - now) / 1000);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    res.setHeader('RateLimit-Reset', String(resetSeconds));

    if (entry.count > max) {
      res.setHeader('Retry-After', String(resetSeconds));
      return res.status(429).json({ error: 'เรียกใช้งานถี่เกินไป กรุณารอสักครู่แล้วลองใหม่' });
    }
    next();
  };
}

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

// Stops at the first candidate host that yields media items or direct streams.
async function analyzeRemoteUrl(url, cookies) {
  const attempts = [];
  for (const candidateUrl of buildSourceCandidates(url)) {
    const fetched = await fetchRemoteSource(candidateUrl, cookies);
    const blocked = isLoginRedirect(fetched.finalUrl);
    const source = typeof fetched.source === 'string' ? fetched.source : JSON.stringify(fetched.source || '');
    const streams = blocked ? [] : await getStreamsFromSource(source);
    const media = blocked ? { items: [] } : await extractMediaFromSource(source);
    attempts.push({ url: candidateUrl, finalUrl: fetched.finalUrl, streamCount: streams.length, mediaCount: media.items.length });

    if (media.items.length > 0) return { media, streams, finalUrl: fetched.finalUrl, attempts };
    if (streams.length > 0) return { media: null, streams, finalUrl: fetched.finalUrl, attempts };
  }
  return { media: null, streams: null, finalUrl: null, attempts };
}

app.post('/api/analyze', analyzeLimiter, async (req, res) => {
  const { url } = req.body;
  const cookies = req.body.cookies || process.env.FB_COOKIE || '';
  if (!url) return res.status(400).json({ error: 'กรุณาใส่ URL' });
  if (!validateSupportedUrl(url)) {
    return res.status(400).json({ error: 'URL ต้องเป็น Facebook, fb.watch หรือ Instagram เท่านั้น' });
  }

  try {
    const { media, streams, finalUrl, attempts } = await analyzeRemoteUrl(url, cookies);
    if (media) return res.json({ ...buildMediaResponse(media, streams), finalUrl });
    if (streams) return res.json({ streams, finalUrl });

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

app.post('/api/parse', parseLimiter, async (req, res) => {
  const { source } = req.body;
  if (typeof source !== 'string' || !source) return res.status(400).json({ error: 'No source provided' });

  const streams = await getStreamsFromSource(source);
  const media = await extractMediaFromSource(source);
  if (media.items.length > 0) {
    return res.json(buildMediaResponse(media, streams));
  }

  if (streams.length === 0) {
    return res.status(404).json({
      error: 'ไม่พบ video URL ใน source นี้',
      diagnostics: analyzeSourceDiagnostics(source),
    });
  }

  res.json({ streams });
});

// iOS Shortcut entry point: always 200 so the Shortcut can branch on `files` or `message`.
app.post('/api/shortcut', shortcutLimiter, async (req, res) => {
  const { url, source } = req.body || {};
  const hasSource = typeof source === 'string' && source.length > 0;
  const hasUrl = typeof url === 'string' && validateSupportedUrl(url);
  if (!hasSource && !hasUrl) {
    return res.json({ message: 'แชร์ลิงก์ Facebook / Instagram หรือรันจาก Safari' });
  }

  let media = null;
  try {
    if (hasSource) {
      const extracted = await extractMediaFromSource(source);
      if (extracted.items.length > 0) media = extracted;
    } else {
      media = (await analyzeRemoteUrl(url, process.env.FB_COOKIE || '')).media;
    }
  } catch (err) {
    console.error('Shortcut analyze error:', err.message);
  }

  if (!media) {
    if (hasSource) return res.json({ message: 'ไม่พบรูปหรือวิดีโอในหน้านี้ ตรวจว่า login ใน Safari แล้ว' });
    // x-safari-https (iOS 17+) opens Safari directly and skips the app's universal link.
    const target = new URL(url);
    target.protocol = 'https:';
    return res.json({
      message: 'ต้อง login: รอ Safari โหลดเสร็จ แล้วกด ≡ > Share > Shortcut นี้อีกครั้ง',
      safariUrl: `x-safari-${target.href}`,
      fallbackUrl: `${req.protocol}://${req.get('host')}/go.html#${encodeURIComponent(target.href)}`,
    });
  }

  const token = storeMediaSet(media);
  const base = `${req.protocol}://${req.get('host')}/api/media/file?ios=1&token=${token}&index=`;
  res.json({
    files: media.items.map((_, index) => base + index),
    summary: `บันทึกแล้ว ${media.items.map(item => describeMediaQuality(forIos(item))).join(', ')}`,
  });
});

function describeMediaQuality(item) {
  if (item.type === 'video') {
    const shortSide = item.dash?.quality || item.progressiveQuality;
    return shortSide ? `วิดีโอ ${shortSide}p` : 'วิดีโอ';
  }
  return item.width && item.height ? `รูป ${item.width}×${item.height}` : 'รูป';
}

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
        const codecs = rep?.$?.codecs || set?.$?.codecs || '';
        const quality = parseInt((qualityLabel.match(/\d+/) || [])[0] || Math.min(width || height, height || width) || '0', 10);
        const baseUrls = rep?.BaseURL || [];

        for (const baseUrl of baseUrls) {
          const url = normalizeVideoUrl(typeof baseUrl === 'string' ? baseUrl : (baseUrl?._ || String(baseUrl)));
          if (!url || !url.startsWith('http')) continue;

          if (mimeType.includes('audio') || setType.includes('audio')) {
            audios.push({ url, bandwidth });
          } else if (mimeType.includes('video') || setType.includes('video')) {
            videos.push({ url, height, width, bandwidth, qualityLabel, quality, codecs });
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
    bandwidth: video.bandwidth || 0,
    codecs: video.codecs || '',
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
    const codecs = getAttr('codecs');
    const width = parseInt(getAttr('width') || '0', 10);
    const height = parseInt(getAttr('height') || '0', 10);
    const quality = parseInt((qualityLabel.match(/\d+/) || [])[0] || Math.min(width || height, height || width) || '0', 10);

    if (mimeType.includes('audio')) {
      audios.push({ url, bandwidth });
    } else if (mimeType.includes('video')) {
      videos.push({ url, bandwidth, qualityLabel, quality, codecs });
    }
  }

  audios.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
  const bestAudio = audios[0]?.url || null;

  return videos.map(video => ({
    url: video.url,
    audioUrl: bestAudio,
    label: video.qualityLabel || (video.quality ? `${video.quality}p` : `${Math.round((video.bandwidth || 0) / 1000)}kbps`),
    quality: video.quality || Math.round((video.bandwidth || 0) / 1000),
    bandwidth: video.bandwidth || 0,
    codecs: video.codecs || '',
    isDash: true,
  }));
}

const MEDIA_SHORTCODE_PATTERN = /^[A-Za-z0-9_-]{5,40}$/;
const MEDIA_TOKEN_PATTERN = /^[a-f0-9]{32}$/;
const MEDIA_MAX_ITEMS = 50;
const MEDIA_STORE_TTL_MS = 10 * 60_000;
const MEDIA_STORE_MAX = 100;
// Parsed media sets keyed by random token so the ZIP endpoint never takes media URLs from the client.
const mediaStore = new Map();

const FB_VIDEO_URL_KEYS = ['browser_native_hd_url', 'playable_url_quality_hd', 'browser_native_sd_url', 'playable_url'];
const FB_PHOTO_IMAGE_KEYS = ['image', 'photo_image', 'viewer_image'];

// Accepts a raw JSON/NDJSON response or an HTML page with <script type="application/json"> payloads.
function parseJsonBlobs(source) {
  const blobs = [];
  const trimmed = source.trim();

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      blobs.push(JSON.parse(trimmed));
    } catch {
      for (const line of trimmed.split(/\r?\n/)) {
        try {
          blobs.push(JSON.parse(line));
        } catch {}
      }
    }
  }

  const scriptPattern = /<script\b[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptPattern.exec(source)) !== null) {
    try {
      blobs.push(JSON.parse(match[1]));
    } catch {}
  }

  return blobs;
}

function findValueByKey(root, key) {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (!Array.isArray(node) && Object.prototype.hasOwnProperty.call(node, key)) return node[key];
    for (const value of Object.values(node)) stack.push(value);
  }
  return undefined;
}

function pickLargest(list, urlKey) {
  const valid = (Array.isArray(list) ? list : []).filter(entry => entry && typeof entry[urlKey] === 'string');
  if (valid.length === 0) return null;
  return valid.sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)))[0];
}

// Smallest rendition that still looks sharp as a list thumbnail.
function pickPreview(list, urlKey, minWidth = 320) {
  const valid = (Array.isArray(list) ? list : []).filter(entry => entry && typeof entry[urlKey] === 'string');
  if (valid.length === 0) return null;
  const sorted = valid.sort((a, b) => (a.width || 0) - (b.width || 0));
  return sorted.find(entry => (entry.width || 0) >= minWidth) || sorted[sorted.length - 1];
}

function getMediaChildren(node) {
  if (Array.isArray(node.carousel_media) && node.carousel_media.length > 0) return node.carousel_media;
  const edges = node.edge_sidecar_to_children?.edges;
  if (Array.isArray(edges) && edges.length > 0) return edges.map(edge => edge?.node).filter(Boolean);
  return null;
}

function asManifest(value) {
  return typeof value === 'string' && value.includes('<MPD') ? value : null;
}

// Highest resolution first; on ties prefer H.264, which plays everywhere (VP9/AV1 in MP4 does not).
function pickBestDashVideo(streams) {
  const videos = streams.filter(stream => stream.isDash && stream.url);
  if (videos.length === 0) return null;
  return videos.sort((a, b) =>
    (b.quality || 0) - (a.quality || 0)
    || Number(/^avc1/i.test(b.codecs)) - Number(/^avc1/i.test(a.codecs))
    || (b.bandwidth || 0) - (a.bandwidth || 0))[0];
}

// Progressive files usually cap around 720p; upgrade to the DASH rendition when it is sharper.
// iOS Photos rejects VP9/AV1 even inside MP4.
const IOS_VIDEO_CODEC_PATTERN = /^(avc1|avc3|hvc1|hev1)/i;

// Returns the best overall upgrade and the best one iOS Photos can import.
async function resolveDashUpgrades(item, manifest) {
  const toUpgrade = streams => {
    const best = pickBestDashVideo(streams);
    if (!best || !best.audioUrl) return null;
    if (!isAllowedMediaUrl(best.url) || !isAllowedMediaUrl(best.audioUrl)) return null;

    // Equal resolution keeps the progressive file: it already has audio and is usually H.264.
    if ((best.quality || 0) <= (item.progressiveQuality || 0)) return null;
    return { videoUrl: best.url, audioUrl: best.audioUrl, quality: best.quality };
  };

  try {
    const streams = await parseDash(manifest);
    return {
      dash: toUpgrade(streams),
      dashIos: toUpgrade(streams.filter(stream => IOS_VIDEO_CODEC_PATTERN.test(stream.codecs || ''))),
    };
  } catch (err) {
    console.error('DASH manifest parse error:', err.message);
    return { dash: null, dashIos: null };
  }
}

// Progressive files are H.264, so dropping a non-iOS DASH upgrade is always importable.
function forIos(item) {
  return { ...item, dash: item.dashIos || null };
}

// Maps one JSON node in the IG v1, IG GraphQL or FB GraphQL shape to a media item.
function mediaFromNode(node) {
  if (Array.isArray(node.video_versions) || Array.isArray(node.image_versions2?.candidates)) {
    const video = pickLargest(node.video_versions, 'url');
    const image = pickLargest(node.image_versions2?.candidates, 'url');
    const chosen = video || image;
    if (chosen) {
      return {
        type: video ? 'video' : 'image',
        url: chosen.url,
        width: chosen.width || node.original_width || null,
        height: chosen.height || node.original_height || null,
        previewUrl: pickPreview(node.image_versions2?.candidates, 'url')?.url || null,
        progressiveQuality: video ? Math.min(video.width || 0, video.height || 0) : 0,
        dashManifest: video ? asManifest(node.video_dash_manifest) : null,
        code: node.code,
      };
    }
  }

  if (typeof node.display_url === 'string' && /^(XDT)?Graph/.test(node.__typename || '')) {
    const isVideo = !!(node.is_video && typeof node.video_url === 'string');
    const resources = Array.isArray(node.display_resources)
      ? node.display_resources.map(r => ({ url: r?.src, width: r?.config_width, height: r?.config_height }))
      : [];
    return {
      type: isVideo ? 'video' : 'image',
      url: isVideo ? node.video_url : (pickLargest(resources, 'url')?.url || node.display_url),
      width: node.dimensions?.width || null,
      height: node.dimensions?.height || null,
      previewUrl: pickPreview(resources, 'url')?.url || node.display_url,
      // dimensions describe the original upload, not the video_url rendition.
      progressiveQuality: 0,
      dashManifest: isVideo ? asManifest(node.dash_info?.video_dash_manifest) : null,
      code: node.shortcode,
    };
  }

  const videoKey = FB_VIDEO_URL_KEYS.find(key => typeof node[key] === 'string' && node[key]);
  if (videoKey) {
    // Current FB payloads keep HD/SD and DASH under videoDeliveryResponseFragment; playable_url is SD.
    const delivery = node.videoDeliveryResponseFragment?.videoDeliveryResponseResult || {};
    const legacy = node.videoDeliveryLegacyFields || {};
    const progressive = Array.isArray(delivery.progressive_urls) ? delivery.progressive_urls : [];
    const hdUrl = progressive.find(p => p?.metadata?.quality === 'HD' && typeof p.progressive_url === 'string')?.progressive_url
      || [legacy.browser_native_hd_url, node.browser_native_hd_url, node.playable_url_quality_hd].find(url => typeof url === 'string' && url);
    const shortSide = Math.min(node.original_width || node.width || 0, node.original_height || node.height || 0);

    return {
      type: 'video',
      url: hdUrl || node[videoKey],
      width: hdUrl ? node.original_width || node.width || null : null,
      height: hdUrl ? node.original_height || node.height || null : null,
      // SD resolution is not exposed, so any DASH rendition with audio beats it.
      progressiveQuality: hdUrl ? shortSide : 0,
      previewUrl: node.preferred_thumbnail?.image?.uri || node.thumbnailImage?.uri || node.previewImage?.uri || null,
      dashManifest: asManifest(delivery.dash_manifests?.[0]?.manifest_xml)
        || asManifest(node.dash_manifest)
        || asManifest(node.manifest_xml)
        || asManifest(node.dash_manifests?.[0]?.manifest_xml),
    };
  }

  if (node.__typename === 'Photo') {
    const images = FB_PHOTO_IMAGE_KEYS.map(key => node[key]);
    const image = pickLargest(images, 'uri');
    if (image) {
      return {
        type: 'image',
        url: image.uri,
        width: image.width || null,
        height: image.height || null,
        previewUrl: pickPreview(images, 'uri')?.uri || null,
      };
    }
  }

  return null;
}

// Same asset shows up in several payloads with different signed query strings.
function mediaDedupeKey(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function collectMedia(root, ctx) {
  const stack = [root];
  while (stack.length > 0 && ctx.items.length < MEDIA_MAX_ITEMS) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;

    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
      continue;
    }

    const children = getMediaChildren(node);
    if (children) {
      if (!ctx.code) ctx.code = node.code || node.shortcode || null;
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
      continue;
    }

    const media = mediaFromNode(node);
    if (media) {
      const key = mediaDedupeKey(media.url);
      if (isAllowedMediaUrl(media.url) && !ctx.seen.has(key)) {
        ctx.seen.add(key);
        ctx.items.push({
          type: media.type,
          url: media.url,
          width: media.width,
          height: media.height,
          previewUrl: media.previewUrl && isAllowedMediaUrl(media.previewUrl) ? media.previewUrl : null,
          progressiveQuality: media.progressiveQuality || 0,
          dashManifest: media.type === 'video' ? media.dashManifest || null : null,
        });
        if (!ctx.code && media.code) ctx.code = media.code;
      }
      continue;
    }

    const values = Object.values(node);
    for (let i = values.length - 1; i >= 0; i--) stack.push(values[i]);
  }
}

async function extractMediaFromSource(source) {
  const ctx = { items: [], seen: new Set(), code: null };
  if (typeof source !== 'string' || !source) return { prefix: 'media', items: [] };

  const blobs = parseJsonBlobs(source);

  // A logged-in IG post page also embeds related posts; prefer the post's own payload.
  for (const blob of blobs) {
    const info = findValueByKey(blob, 'xdt_api__v1__media__shortcode__web_info');
    if (info) collectMedia(info, ctx);
  }
  if (ctx.items.length === 0) {
    for (const blob of blobs) collectMedia(blob, ctx);
  }

  for (const item of ctx.items) {
    if (item.dashManifest) Object.assign(item, await resolveDashUpgrades(item, item.dashManifest));
    delete item.dashManifest;
  }

  const prefix = ctx.code && MEDIA_SHORTCODE_PATTERN.test(ctx.code) ? ctx.code : 'media';
  return { prefix, items: ctx.items };
}

function storeMediaSet(set) {
  const now = Date.now();
  for (const [key, entry] of mediaStore) {
    if (entry.expiresAt <= now) mediaStore.delete(key);
  }
  if (mediaStore.size >= MEDIA_STORE_MAX) mediaStore.delete(mediaStore.keys().next().value);

  const token = crypto.randomBytes(16).toString('hex');
  mediaStore.set(token, { ...set, expiresAt: now + MEDIA_STORE_TTL_MS });
  return token;
}

function buildMediaFilename(prefix, item, index) {
  return `${prefix}_${String(index + 1).padStart(2, '0')}.${item.type === 'video' ? 'mp4' : 'jpg'}`;
}

function buildMediaResponse(set, streams) {
  const hasVideo = set.items.some(item => item.type === 'video');
  return {
    kind: 'media',
    token: storeMediaSet(set),
    prefix: set.prefix,
    items: set.items.map((item, index) => ({
      type: item.type,
      width: item.width,
      height: item.height,
      quality: item.dash ? item.dash.quality : null,
      filename: buildMediaFilename(set.prefix, item, index),
      hasPreview: !!item.previewUrl,
    })),
    // DASH-only videos are not in the JSON payloads; keep the quality list as a fallback.
    streams: hasVideo ? [] : streams,
  };
}

function getMediaItemFromQuery(req, res) {
  const { token, index } = req.query;
  if (typeof token !== 'string' || !MEDIA_TOKEN_PATTERN.test(token) || typeof index !== 'string' || !/^\d{1,3}$/.test(index)) {
    res.status(400).send('Invalid request');
    return null;
  }

  const set = mediaStore.get(token);
  if (!set || set.expiresAt <= Date.now()) {
    res.status(404).send('ลิงก์หมดอายุ กรุณากด Show Download ใหม่');
    return null;
  }

  const item = set.items[Number(index)];
  if (!item) {
    res.status(404).send('Not found');
    return null;
  }
  return { set, item, index: Number(index) };
}

// Returns a readable for the best rendition; DASH items are merged and fall back to the progressive file.
async function openMediaItem(item, signal) {
  if (item.dash) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbdl-'));
    try {
      const outPath = await mergeDashToFile(item.dash.videoUrl, item.dash.audioUrl, tmpDir);
      return { stream: fs.createReadStream(outPath), tmpDir, contentType: 'video/mp4' };
    } catch (err) {
      cleanup(tmpDir);
      console.error('DASH merge failed, using progressive file:', err.message);
    }
  }

  const resp = await axios({
    method: 'GET',
    url: item.url,
    responseType: 'stream',
    timeout: 90000,
    headers: FB_HEADERS,
    proxy: false,
    maxRedirects: 5,
    beforeRedirect: assertAllowedRedirect,
    signal,
  });
  const upstreamType = String(resp.headers['content-type'] || '');
  return {
    stream: resp.data,
    tmpDir: null,
    contentType: /^(image|video)\//i.test(upstreamType) ? upstreamType : (item.type === 'video' ? 'video/mp4' : 'image/jpeg'),
  };
}

// Prefers HEAD; some CDN edges omit Content-Length there, so fall back to a 1-byte range GET.
async function probeContentLength(url) {
  const base = {
    url,
    timeout: 15000,
    headers: { ...FB_HEADERS, 'Accept-Encoding': 'identity' },
    proxy: false,
    maxRedirects: 5,
    beforeRedirect: assertAllowedRedirect,
  };

  try {
    const head = await axios({ ...base, method: 'HEAD' });
    const length = parseInt(head.headers['content-length'] || '', 10);
    if (length > 0) return length;
  } catch {}

  try {
    const ranged = await axios({
      ...base,
      method: 'GET',
      headers: { ...base.headers, Range: 'bytes=0-0' },
      responseType: 'stream',
      validateStatus: status => status === 200 || status === 206,
    });
    ranged.data.destroy();
    const total = parseInt((String(ranged.headers['content-range'] || '').match(/\/(\d+)$/) || [])[1] || '', 10);
    return total > 0 ? total : null;
  } catch {
    return null;
  }
}

// Merged DASH size is the sum of both tracks; container overhead is negligible.
async function getMediaItemSize(item) {
  if (item.size !== undefined) return item.size;

  let size;
  if (item.dash) {
    const [video, audio] = await Promise.all([probeContentLength(item.dash.videoUrl), probeContentLength(item.dash.audioUrl)]);
    size = video && audio ? video + audio : null;
  }
  if (!size) size = await probeContentLength(item.url);

  item.size = size || null;
  return item.size;
}

app.get('/api/media/sizes', sizesLimiter, async (req, res) => {
  const { token } = req.query;
  if (typeof token !== 'string' || !MEDIA_TOKEN_PATTERN.test(token)) return res.status(400).json({ error: 'Invalid token' });

  const set = mediaStore.get(token);
  if (!set || set.expiresAt <= Date.now()) return res.status(404).json({ error: 'Expired' });

  const sizes = new Array(set.items.length).fill(null);
  let next = 0;
  // Bounded concurrency so a 50-item set does not open 100 CDN connections at once.
  const worker = async () => {
    while (next < set.items.length) {
      const index = next++;
      sizes[index] = await getMediaItemSize(set.items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, set.items.length) }, worker));

  res.json({ sizes });
});

app.get('/api/media/file', fileLimiter, async (req, res) => {
  const found = getMediaItemFromQuery(req, res);
  if (!found) return;
  const { set, item, index } = found;

  let opened;
  try {
    opened = await openMediaItem(req.query.ios === '1' ? forIos(item) : item);
  } catch (err) {
    console.error('Media file error:', err.message);
    return res.status(502).send('ดาวน์โหลดไม่สำเร็จ กรุณาลองใหม่');
  }

  const release = () => {
    opened.stream.destroy();
    if (opened.tmpDir) cleanup(opened.tmpDir);
  };
  // Client may have left while the merge was running.
  if (res.destroyed || !res.socket || res.socket.destroyed) return release();

  res.setHeader('Content-Type', opened.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${buildMediaFilename(set.prefix, item, index)}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.on('close', release);
  opened.stream.on('error', () => res.destroy());
  opened.stream.pipe(res);
});

// Proxies CDN media by token/index; IG/FB CDNs block cross-origin <img> hotlinking.
app.get('/api/media/preview', previewLimiter, async (req, res) => {
  const found = getMediaItemFromQuery(req, res);
  if (!found) return;
  const { item } = found;

  const wantFull = req.query.full === '1';
  const url = wantFull ? item.url : item.previewUrl;
  if (!url) return res.status(404).send('No preview');

  const headers = { ...FB_HEADERS, 'Accept-Encoding': 'identity' };
  const range = req.headers.range;
  if (wantFull && typeof range === 'string' && /^bytes=\d*-\d*$/.test(range)) headers.Range = range;

  try {
    const resp = await axios({
      method: 'GET',
      url,
      responseType: 'stream',
      timeout: 60000,
      headers,
      proxy: false,
      maxRedirects: 5,
      beforeRedirect: assertAllowedRedirect,
      validateStatus: status => status === 200 || status === 206,
    });

    const contentType = String(resp.headers['content-type'] || '');
    if (!/^(image|video)\//i.test(contentType)) {
      resp.data.destroy();
      return res.status(502).send('Unexpected content type');
    }

    res.status(resp.status);
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=600');
    for (const name of ['content-length', 'content-range', 'accept-ranges']) {
      if (resp.headers[name]) res.setHeader(name, resp.headers[name]);
    }

    res.on('close', () => resp.data.destroy());
    resp.data.pipe(res);
  } catch (err) {
    console.error('Preview error:', err.message);
    if (!res.headersSent) res.status(502).send('Preview failed');
  }
});

app.get('/api/media/zip', zipLimiter, async (req, res) => {
  const { token } = req.query;
  if (typeof token !== 'string' || !MEDIA_TOKEN_PATTERN.test(token)) {
    return res.status(400).send('Invalid token');
  }

  const set = mediaStore.get(token);
  if (!set || set.expiresAt <= Date.now()) {
    return res.status(404).send('ลิงก์หมดอายุ กรุณากด Show Download ใหม่');
  }

  // Entries live under one folder so extracting the ZIP does not scatter files.
  const entries = set.items.map((item, index) => ({
    name: `${set.prefix}/${buildMediaFilename(set.prefix, item, index)}`,
    item,
  }));

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${set.prefix}.zip"`);

  try {
    await streamZip(res, entries);
    res.end();
  } catch (err) {
    console.error('ZIP stream error:', err.message);
    res.destroy();
  }
});

app.post('/api/merge', mergeLimiter, async (req, res) => {
  const { videoUrl, audioUrl, quality } = req.body;
  if (!videoUrl) return res.status(400).json({ error: 'videoUrl required' });
  if (typeof videoUrl !== 'string' || !isAllowedMediaUrl(videoUrl)) {
    return res.status(400).json({ error: 'videoUrl not allowed' });
  }
  if (audioUrl && (typeof audioUrl !== 'string' || !isAllowedMediaUrl(audioUrl))) {
    return res.status(400).json({ error: 'audioUrl not allowed' });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbdl-'));

  try {
    const outPath = await mergeDashToFile(videoUrl, audioUrl || null, tmpDir);

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

app.get('/api/download', downloadLimiter, async (req, res) => {
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

const MEDIA_MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;

function downloadFile(url, dest) {
  return new Promise(async (resolve, reject) => {
    try {
      const resp = await axios({ method: 'GET', url, responseType: 'stream', timeout: 90000, headers: FB_HEADERS, proxy: false, maxRedirects: 5, beforeRedirect: assertAllowedRedirect });
      const writer = fs.createWriteStream(dest);
      let size = 0;
      // axios does not enforce maxContentLength on streams.
      resp.data.on('data', chunk => {
        size += chunk.length;
        if (size > MEDIA_MAX_DOWNLOAD_BYTES) {
          resp.data.destroy();
          writer.destroy();
          reject(new Error('File size limit exceeded'));
        }
      });
      resp.data.on('error', reject);
      resp.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}

// Stream copy only: no re-encode, so output quality equals the source renditions.
async function mergeDashToFile(videoUrl, audioUrl, tmpDir) {
  const videoPath = path.join(tmpDir, 'video.mp4');
  const audioPath = path.join(tmpDir, 'audio.mp4');
  const outPath = path.join(tmpDir, 'merged.mp4');

  await Promise.all([
    downloadFile(videoUrl, videoPath),
    audioUrl ? downloadFile(audioUrl, audioPath) : null,
  ]);

  const inputs = audioUrl
    ? ['-i', videoPath, '-i', audioPath, '-map', '0:v:0', '-map', '1:a:0']
    : ['-i', videoPath];
  await runFfmpeg(['-hide_banner', '-loglevel', 'error', ...inputs, '-c', 'copy', '-movflags', '+faststart', '-y', outPath]);
  return outPath;
}

const ZIP_MAX_ENTRY_BYTES = 500 * 1024 * 1024;
// Keeps every offset inside 32-bit ZIP fields, so no ZIP64 is needed.
const ZIP_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const ZIP_FLAGS = 0x0808; // data descriptor + UTF-8 names

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(crc, buf) {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

// STORE-only streaming ZIP; media is already compressed, and sizes go in data descriptors.
async function streamZip(res, entries) {
  const controller = new AbortController();
  res.on('close', () => controller.abort());

  const write = chunk => new Promise((resolve, reject) => {
    if (res.destroyed) return reject(new Error('Client disconnected'));
    if (res.write(chunk)) return resolve();

    const detach = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
    };
    const onDrain = () => { detach(); resolve(); };
    const onClose = () => { detach(); reject(new Error('Client disconnected')); };
    res.once('drain', onDrain);
    res.once('close', onClose);
  });

  const { time, day } = toDosDateTime(new Date());
  const central = [];
  let offset = 0;
  let total = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(ZIP_FLAGS, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(day, 12);
    header.writeUInt16LE(name.length, 26);
    await write(Buffer.concat([header, name]));

    const opened = await openMediaItem(entry.item, controller.signal);

    let crc = 0;
    let size = 0;
    try {
      for await (const chunk of opened.stream) {
        size += chunk.length;
        total += chunk.length;
        if (size > ZIP_MAX_ENTRY_BYTES || total > ZIP_MAX_TOTAL_BYTES) {
          throw new Error('ZIP size limit exceeded');
        }
        crc = crc32(crc, chunk);
        await write(chunk);
      }
    } finally {
      opened.stream.destroy();
      if (opened.tmpDir) cleanup(opened.tmpDir);
    }

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(size, 8);
    descriptor.writeUInt32LE(size, 12);
    await write(descriptor);

    central.push({ name, crc, size, offset });
    offset += header.length + name.length + size + descriptor.length;
  }

  const centralStart = offset;
  for (const item of central) {
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(ZIP_FLAGS, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt16LE(time, 12);
    record.writeUInt16LE(day, 14);
    record.writeUInt32LE(item.crc, 16);
    record.writeUInt32LE(item.size, 20);
    record.writeUInt32LE(item.size, 24);
    record.writeUInt16LE(item.name.length, 28);
    record.writeUInt32LE(item.offset, 42);
    await write(Buffer.concat([record, item.name]));
    offset += record.length + item.name.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - centralStart, 12);
  end.writeUInt32LE(centralStart, 16);
  await write(end);
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
