const express = require('express');
const axios   = require('axios');
const xml2js  = require('xml2js');
const { execFile } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Common Facebook headers ────────────────────────────────────────────────────
const FB_HEADERS = {
  'User-Agent'      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept'          : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language' : 'th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding' : 'gzip, deflate, br',
  'Referer'         : 'https://www.facebook.com/',
  'sec-fetch-dest'  : 'document',
  'sec-fetch-mode'  : 'navigate',
  'sec-fetch-site'  : 'same-origin',
};

// ── Fetch page source from Facebook URL (server-side, ใช้ cookies จาก client) ──
app.post('/api/fetch-source', async (req, res) => {
  const { url, cookies } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  // Validate: must be facebook URL
  const fbPattern = /^https?:\/\/(www\.)?(facebook\.com|fb\.watch)\//i;
  if (!fbPattern.test(url)) {
    return res.status(400).json({ error: 'URL ต้องเป็น Facebook เท่านั้น' });
  }

  try {
    const headers = { ...FB_HEADERS };
    if (cookies) headers['Cookie'] = cookies;

    const resp = await axios.get(url, {
      headers,
      timeout: 20000,
      maxRedirects: 5,
      decompress: true,
    });

    res.json({ source: resp.data, status: resp.status });
  } catch (err) {
    const status = err.response?.status;
    if (status === 302 || status === 303) {
      return res.status(401).json({ error: 'Facebook redirect — วิดีโอนี้ต้อง login หรือ private เกินไป กรุณาใช้โหมด Paste Source แทน' });
    }
    res.status(500).json({ error: 'fetch ไม่สำเร็จ: ' + (err.message || status) });
  }
});

// ── Parse source HTML → extract streams ───────────────────────────────────────
app.post('/api/parse', async (req, res) => {
  const { source } = req.body;
  if (!source) return res.status(400).json({ error: 'No source provided' });

  const results = [];
  const seen    = new Set();

  const addUrl = (url, label, quality, isDash) => {
    const clean = url
      .replace(/\\\//g,   '/')
      .replace(/\\u0025/g,'%')
      .replace(/\\u0026/g,'&')
      .replace(/&amp;/g,  '&')
      .replace(/\\"/g,    '')
      .trim();
    if (clean && clean.startsWith('http') && !seen.has(clean)) {
      seen.add(clean);
      results.push({ url: clean, label, quality, isDash: !!isDash });
    }
  };

  const extract = (key, label, quality) => {
    const rxList = [
      new RegExp(`"${key}"\\s*:\\s*"(https?:\\\\/\\\\/[^"]{10,})"`, 'g'),
      new RegExp(`"${key}"\\s*:\\s*"(https?:\\/\\/[^"]{10,})"`,     'g'),
    ];
    for (const rx of rxList) {
      let m;
      while ((m = rx.exec(source)) !== null) addUrl(m[1], label, quality);
    }
  };

  extract('playable_url_quality_hd', 'HD (720p)', 720);
  extract('browser_native_hd_url',   'HD (720p)', 720);
  extract('playable_url',            'SD (480p)', 480);
  extract('browser_native_sd_url',   'SD (480p)', 480);

  // DASH manifest → 1080p / 4K
  const dashRx    = /"dash_manifest"\s*:\s*"([^"]{50,})"/;
  const dashMatch = source.match(dashRx);
  if (dashMatch) {
    const rawXml = dashMatch[1]
      .replace(/\\\//g, '/')
      .replace(/\\n/g,  '\n')
      .replace(/\\"/g,  '"')
      .replace(/&amp;/g,'&');
    try {
      const streams = await parseDash(rawXml);
      streams.forEach(s => results.push(s));
    } catch (e) {
      console.error('DASH parse error:', e.message);
    }
  }

  if (results.length === 0) {
    return res.status(404).json({
      error: 'ไม่พบ video URL — ลองเปิดหน้าวิดีโอโดยตรง (ไม่ใช่หน้า feed) หรือใช้โหมด Paste Source พร้อม Cookie'
    });
  }

  results.sort((a, b) => (b.quality || 0) - (a.quality || 0));
  res.json({ streams: results });
});

// ── Parse DASH XML ─────────────────────────────────────────────────────────────
async function parseDash(xml) {
  const parsed  = await xml2js.parseStringPromise(xml, { explicitArray: true });
  const streams = [];
  const seen    = new Set();

  const periods = parsed?.MPD?.Period || [];
  for (const period of periods) {
    const sets = period?.AdaptationSet || [];
    for (const set of sets) {
      const mimeType = set?.$?.mimeType || '';
      if (!mimeType.includes('video')) continue;
      const reps = set?.Representation || [];
      for (const rep of reps) {
        const height    = parseInt(rep?.$?.height    || '0');
        const bandwidth = parseInt(rep?.$?.bandwidth || '0');
        const baseUrls  = rep?.BaseURL || [];
        for (const bu of baseUrls) {
          const url = typeof bu === 'string' ? bu : (bu?._ || String(bu));
          if (url && url.startsWith('http') && !seen.has(url)) {
            seen.add(url);
            const label = height ? `${height}p` : `${Math.round(bandwidth/1000)}kbps`;
            streams.push({ url, label, quality: height || Math.round(bandwidth/1000), isDash: true });
          }
        }
      }
    }
  }
  return streams;
}

// ── ffmpeg merge (for DASH 1080p/4K) ─────────────────────────────────────────
app.post('/api/merge', async (req, res) => {
  const { videoUrl, audioUrl, quality } = req.body;
  if (!videoUrl) return res.status(400).json({ error: 'videoUrl required' });

  const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'fbdl-'));
  const videoPath = path.join(tmpDir, 'video.mp4');
  const audioPath = path.join(tmpDir, 'audio.mp4');
  const outPath   = path.join(tmpDir, `out_${quality || 'hd'}.mp4`);

  try {
    await downloadFile(videoUrl, videoPath);
    let args;
    if (audioUrl) {
      await downloadFile(audioUrl, audioPath);
      args = ['-i', videoPath, '-i', audioPath, '-c:v', 'copy', '-c:a', 'aac', '-y', outPath];
    } else {
      args = ['-i', videoPath, '-c', 'copy', '-y', outPath];
    }
    await runFfmpeg(args);

    const filename = `fb_video_${(quality||'hd').replace(/[^a-z0-9]/gi,'_')}.mp4`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'video/mp4');
    const stream = fs.createReadStream(outPath);
    stream.pipe(res);
    stream.on('end',   () => cleanup(tmpDir));
    stream.on('error', () => cleanup(tmpDir));
  } catch (err) {
    cleanup(tmpDir);
    res.status(500).json({ error: 'ffmpeg merge failed: ' + err.message });
  }
});

// ── Proxy download (SD/HD direct mp4) ─────────────────────────────────────────
app.get('/api/download', async (req, res) => {
  const { url, filename } = req.query;
  if (!url) return res.status(400).send('url required');
  try {
    const resp = await axios({
      method: 'GET',
      url: decodeURIComponent(url),
      responseType: 'stream',
      timeout: 120000,
      headers: { ...FB_HEADERS },
    });
    const name = filename || 'fb_video.mp4';
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Content-Type', resp.headers['content-type'] || 'video/mp4');
    if (resp.headers['content-length']) res.setHeader('Content-Length', resp.headers['content-length']);
    resp.data.pipe(res);
  } catch (err) {
    res.status(500).send('Download failed: ' + err.message);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function downloadFile(url, dest) {
  return new Promise(async (resolve, reject) => {
    try {
      const resp = await axios({ method:'GET', url, responseType:'stream', timeout:90000, headers: FB_HEADERS });
      const w = fs.createWriteStream(dest);
      resp.data.pipe(w);
      w.on('finish', resolve);
      w.on('error',  reject);
    } catch(e) { reject(e); }
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
  try { fs.rmSync(dir, { recursive:true, force:true }); } catch {}
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FB Downloader Pro → http://localhost:${PORT}`));
