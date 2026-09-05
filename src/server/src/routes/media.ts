import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const yauzl = require('yauzl');

const AUDIO_MIME: Record<string, string> = {
  '.mp3':  'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav':  'audio/wav',
  '.opus': 'audio/ogg; codecs=opus',
  '.ogg':  'audio/ogg',
  '.oga':  'audio/ogg',
  '.aac':  'audio/aac',
  '.m4a':  'audio/mp4',
  '.alac': 'audio/mp4',
};

// Helper function to add CORS headers to media responses
function addCorsHeaders(res: express.Response, req: express.Request) {
  const allowedOrigins = process.env.ORIGIN?.split(',').map(origin => origin.trim()) || ['*'];
  const requestOrigin = req.get('origin') || '';
  
  // Determine if we should allow this origin
  const allowOrigin = allowedOrigins.includes('*') || allowedOrigins.includes(requestOrigin);
  
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigins.includes('*') ? '*' : requestOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, X-Requested-With');
  }
}

function getPitchParams(req: express.Request) {
  const pitchSemitones = Number(req.query.pitch || 0);
  const hasPitch = Number.isFinite(pitchSemitones) && pitchSemitones !== 0;
  const pitchRatio = hasPitch ? Math.pow(2, pitchSemitones / 12) : 1;
  return { hasPitch, pitchRatio, pitchSemitones };
}

function buildPitchFilter(pitchRatio: number, pitchSemitones: number): string {
  // rubberband pitch is a SCALE FACTOR (ratio), not semitones
  // e.g. -2 semitones => 2^(-2/12) ~= 0.8908987
  if (!Number.isFinite(pitchRatio) || Math.abs(pitchRatio - 1) < 1e-6) return '';

  // Keep it stable/short for logs
  const ratio = pitchRatio.toFixed(6);
  return `rubberband=pitch=${ratio}`;
}


// Fallback filter for systems without rubberband (kept for reference)
// This can be used if rubberband filter is not available in the FFmpeg build
// To use: replace buildPitchFilter() call with buildPitchFilterFallback()
// Uses asetrate to shift pitch, then atempo to restore original tempo
function buildPitchFilterFallback(pitchRatio: number): string {
  if (pitchRatio === 1) return '';
  
  // asetrate changes pitch AND tempo, so we need to compensate with atempo
  // pitchRatio > 1 means higher pitch (faster), so we need to slow down with atempo < 1
  // pitchRatio < 1 means lower pitch (slower), so we need to speed up with atempo > 1
  const tempoCorrection = 1 / pitchRatio;
  
  // atempo filter has range [0.5, 2.0], so we may need to chain multiple filters
  const atempoFilters: string[] = [];
  let remainingTempo = tempoCorrection;
  
  // Chain atempo filters to handle values outside [0.5, 2.0] range
  while (remainingTempo > 2.0) {
    atempoFilters.push('atempo=2.0');
    remainingTempo /= 2.0;
  }
  while (remainingTempo < 0.5) {
    atempoFilters.push('atempo=0.5');
    remainingTempo /= 0.5;
  }
  
  // Add the final atempo adjustment
  atempoFilters.push(`atempo=${remainingTempo.toFixed(6)}`);
  
  // Build the complete filter: asetrate to shift pitch, then atempo(s) to restore tempo
  return `asetrate=44100*${pitchRatio.toFixed(6)},${atempoFilters.join(',')},aresample=44100`;
}

function isSupportedExternalVideoUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    return (
      parsed.protocol === 'https:' &&
      (
        host === 'youtu.be' ||
        host === 'youtube.com' ||
        host.endsWith('.youtube.com') ||
        host === 'youtube-nocookie.com' ||
        host.endsWith('.youtube-nocookie.com')
      )
    );
  } catch {
    return false;
  }
}

export const mediaRouter = express.Router();

// Handle CORS preflight requests for all media endpoints (Express 5 compatible wildcard)
mediaRouter.options('/{*path}', (req, res) => {
  addCorsHeaders(res, req);
  res.status(204).end();
});

function getResolvedMediaRoot() {
  const configuredRoot = process.env.MEDIA_ROOT || '/media';
  try {
    return fs.realpathSync.native(configuredRoot);
  } catch {
    return path.resolve(configuredRoot);
  }
}

function isPathWithinRoot(rootPath: string, candidatePath: string) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function getSearchableMediaRoots(rootPath: string): string[] {
  const roots = [rootPath];
  try {
    for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const childPath = path.join(rootPath, entry.name);
      try {
        roots.push(fs.realpathSync.native(childPath));
      } catch {
        roots.push(path.resolve(childPath));
      }
    }
  } catch {}
  return [...new Set(roots)];
}

export function remapMediaPathCandidate(candidatePath: string, mediaRoots: string[]): string | null {
  if (!candidatePath) return null;

  const normalizedCandidate = path.resolve(candidatePath);
  const segments = normalizedCandidate.split(path.sep).filter(Boolean);

  for (const mediaRoot of mediaRoots) {
    for (let start = 0; start < segments.length; start++) {
      const remappedPath = path.join(mediaRoot, ...segments.slice(start));
      try {
        const resolvedPath = fs.realpathSync.native(remappedPath);
        if (isPathWithinRoot(mediaRoot, resolvedPath)) {
          return resolvedPath;
        }
      } catch {
        continue;
      }
    }
  }

  return null;
}

export function resolveExistingMediaPath(candidatePath: string): string | null {
  if (!candidatePath) return null;
  const resolvedRoot = getResolvedMediaRoot();
  const mediaRoots = getSearchableMediaRoots(resolvedRoot);

  try {
    const resolvedPath = fs.realpathSync.native(candidatePath);
    return isPathWithinRoot(resolvedRoot, resolvedPath) ? resolvedPath : null;
  } catch {
    return remapMediaPathCandidate(candidatePath, mediaRoots);
  }
}

mediaRouter.get('/file', (req, res) => {
  const requestedPath = (req.query.path as string) || '';
  const safePath = resolveExistingMediaPath(requestedPath);
  if (!safePath) return res.status(400).send('Invalid path');
  const stat = fs.statSync(safePath);
  const range = req.headers.range;
  
  // Add CORS headers for cross-origin media access
  addCorsHeaders(res, req);

  const ext = path.extname(safePath).toLowerCase();
  const mimeType = AUDIO_MIME[ext];
  if (mimeType) res.setHeader('Content-Type', mimeType);

  res.setHeader('Accept-Ranges','bytes');
  if (range) {
    const [s,e] = range.replace(/bytes=/,'').split('-').map(x=>parseInt(x,10));
    const start = isNaN(s)?0:s;
    const end = isNaN(e)?(stat.size-1):e;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    fs.createReadStream(safePath, { start, end }).pipe(res);
  } else {
    res.setHeader('Content-Length', String(stat.size));
    fs.createReadStream(safePath).pipe(res);
  }
});

mediaRouter.get('/youtube-stream', (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!url || !isSupportedExternalVideoUrl(url)) {
    return res.status(400).send('Invalid YouTube URL');
  }

  addCorsHeaders(res, req);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-cache, no-store');

  const args = [
    '--format',
    'best[ext=mp4][vcodec!=none][acodec!=none][height<=1080]/best[ext=mp4][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none][height<=1080]/best[vcodec!=none][acodec!=none]',
    '--no-playlist',
    '--no-part',
    '--quiet',
    '--no-warnings',
    '--output',
    '-',
    url,
  ];

  const ytdlp = spawn('yt-dlp', args);
  let errorOutput = '';
  let responseStarted = false;

  ytdlp.stdout.once('data', (chunk) => {
    responseStarted = true;
    res.write(chunk);
    ytdlp.stdout.pipe(res);
  });

  ytdlp.stderr.on('data', (chunk) => {
    errorOutput += chunk.toString();
  });

  ytdlp.on('error', (error) => {
    if (!res.headersSent) {
      res.status(500).send(error.message);
    } else {
      res.destroy(error);
    }
  });

  ytdlp.on('close', (code) => {
    if (code !== 0) {
      console.error(`[youtube-stream] yt-dlp exited with code ${code}: ${errorOutput.trim()}`);
      if (!responseStarted && !res.headersSent) {
        res.status(502).send(errorOutput.trim() || `yt-dlp exited with code ${code}`);
      }
    }
    if (!res.writableEnded) res.end();
  });

  req.on('close', () => {
    if (!ytdlp.killed) {
      try { ytdlp.kill('SIGKILL'); } catch {}
    }
  });
});

mediaRouter.get('/zip', async (req, res) => {
  const requestedZipPath = (req.query.zip as string) || '';
  const entryName = (req.query.file as string) || '';
  const zipPath = resolveExistingMediaPath(requestedZipPath);
  
  if (!zipPath || !entryName) {
    return res.status(400).send('Invalid zip request');
  }

  // Add CORS headers for cross-origin media access
  addCorsHeaders(res, req);

  yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err: any, zip: any) => {
    if (err || !zip) return res.status(404).send('Unable to open zip');
    let found = false;
    zip.readEntry();
    zip.on('entry', (e: any) => {
      if (e.fileName === entryName) {
        found = true;
        zip.openReadStream(e, (err2: any, stream: any) => {
          if (err2 || !stream) {
            res.status(500).send('Stream error'); 
            try { zip.close(); } catch {}; 
            return;
          }
          res.setHeader('Cache-Control','no-cache');
          stream.on('end', ()=> { try { zip.close(); } catch {} });
          stream.pipe(res);
        });
      } else {
        zip.readEntry();
      }
    });
    zip.on('end', ()=> {
      if (!found) res.status(404).send('Entry not found in zip: ' + entryName);
    });
    zip.on('error', ()=> res.status(500).send('Zip error'));
  });
});

// Optimized CDG to MP4 transcoding - fixed for smoother playback
mediaRouter.get('/cdgmp4', async (req, res) => {
  const file = (req.query.file as string) || '';
  const cdg = (req.query.cdg as string) || '';
  const mp3 = (req.query.mp3 as string) || '';
  const { hasPitch, pitchRatio, pitchSemitones } = getPitchParams(req);

  if (!cdg || !mp3) return res.status(400).send('cdg and mp3 are required');

  // Add CORS headers for cross-origin video access
  addCorsHeaders(res, req);

  const tmpDir = os.tmpdir();
  const tmpCdg = path.join(tmpDir, `kara_${Date.now()}_${Math.random().toString(36).slice(2)}.cdg`);
  const tmpMp3 = path.join(tmpDir, `kara_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`);

  const cleanup = () => {
    try { if (fs.existsSync(tmpCdg)) fs.unlinkSync(tmpCdg); } catch {}
    try { if (fs.existsSync(tmpMp3)) fs.unlinkSync(tmpMp3); } catch {}
  };

  try {
    // Extract files from ZIP or copy loose files
    if (file) {
      const safeZipPath = resolveExistingMediaPath(file);
      if (!safeZipPath) return res.status(400).send('Invalid zip path');
      await new Promise<void>((resolve, reject) => {
        yauzl.open(safeZipPath, { lazyEntries: true, autoClose: true }, (err: any, zip: any) => {
          if (err || !zip) return reject(err || new Error('Unable to open zip'));
          let gotCdg = false, gotMp3 = false;
          zip.readEntry();
          zip.on('entry', (e: any) => {
            if (e.fileName === cdg || e.fileName === mp3) {
              zip.openReadStream(e, (err2: any, stream: any) => {
                if (err2 || !stream) return reject(err2 || new Error('stream open failed'));
                const out = fs.createWriteStream(e.fileName === cdg ? tmpCdg : tmpMp3);
                stream.pipe(out);
                out.on('finish', () => {
                  if (e.fileName === cdg) gotCdg = true;
                  else gotMp3 = true;
                  if (gotCdg && gotMp3) { 
                    try { zip.close(); } catch {}
                    resolve(); 
                  } else {
                    zip.readEntry();
                  }
                });
                out.on('error', reject);
              });
            } else {
              zip.readEntry();
            }
          });
          zip.on('error', reject);
          zip.on('end', () => { 
            if (!(gotCdg && gotMp3)) reject(new Error('entries not found')); 
          });
        });
      });
    } else {
      const safeCdgPath = resolveExistingMediaPath(cdg);
      const safeMp3Path = resolveExistingMediaPath(mp3);
      if (!safeCdgPath || !safeMp3Path) return res.status(400).send('Invalid media path');
      await fs.promises.copyFile(safeCdgPath, tmpCdg);
      await fs.promises.copyFile(safeMp3Path, tmpMp3);
    }

    // Optimized FFmpeg settings for smooth CDG playback
    // Use tpad filter to hold last frame if CDG is shorter than audio (prevents looping)
    const args = [
      '-loglevel', 'error',
      '-y',
      '-i', tmpCdg, 
      '-i', tmpMp3,
      // Video processing with proper frame rate, scaling, and padding to hold last frame
      // tpad=stop=-1:stop_mode=clone extends video by cloning last frame until audio ends
      '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30,tpad=stop=-1:stop_mode=clone',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      // Video codec options (must come after -c:v)
      '-preset', 'veryfast',       // Balance between speed and quality
      '-tune', 'animation',         // Better for CDG graphics
      '-profile:v', 'main',         
      '-level', '3.1',
      '-crf', '25',                 // Better quality than 30
      '-g', '60',                   // Keyframe every 2 seconds at 30fps
      '-keyint_min', '30',          // Minimum keyframe interval
      '-sc_threshold', '0',         // Disable scene change detection
      '-bf', '2',                   // B-frames for better compression
      '-b_strategy', '1',
      // Audio settings
      '-c:a', 'aac',
      ...(hasPitch ? ['-af', buildPitchFilter(pitchRatio, pitchSemitones)] : []),
      '-b:a', '128k',
      '-ar', '44100',
      '-shortest',                  // Stop when shortest stream ends (audio controls duration)
      // Streaming optimizations
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof+faststart',
      '-frag_duration', '1000000',   // 1 second fragments
      '-f', 'mp4',
      'pipe:1'
    ];

    console.log('[mp4stream] pitchSemitones=', pitchSemitones, 'pitchRatio=', pitchRatio, 'af=', buildPitchFilter(pitchRatio, pitchSemitones));
    
    const ff = spawn('ffmpeg', args);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    
    ff.stdout.pipe(res);
    
    ff.stderr.on('data', (data) => {
      console.error(`FFmpeg error: ${data}`);
    });
    
    ff.on('close', (code) => { 
      if (code !== 0) {
        console.error(`FFmpeg exited with code ${code}`);
      }
      cleanup(); 
    });
    
    req.on('close', () => { 
      try { ff.kill('SIGKILL'); } catch {}
      cleanup(); 
    });
  } catch (e:any) {
    cleanup();
    console.error('CDG transcoding error:', e);
    res.status(500).send(String(e?.message || e));
  }
});

// Simple MP4 serving without re-encoding
mediaRouter.get('/mp4stream', (req, res) => {
  const requestedMp4Path = (req.query.path as string) || '';
  const mp4Path = resolveExistingMediaPath(requestedMp4Path);
  const { hasPitch, pitchRatio, pitchSemitones } = getPitchParams(req);
  
  if (!mp4Path) {
    return res.status(400).send('Invalid path');
  }

  // Add CORS headers for cross-origin video access
  addCorsHeaders(res, req);

  // If pitch shifting requested, re-encode audio with pitch adjustment
  if (hasPitch) {
    const args = [
      '-loglevel', 'error',
      '-y',
      '-i', mp4Path,
      '-map', '0:v?',
      '-map', '0:a?',
      '-c:v', 'copy',
      '-af', buildPitchFilter(pitchRatio, pitchSemitones),
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof+faststart',
      '-f', 'mp4',
      'pipe:1'
    ];

    const ff = spawn('ffmpeg', args);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    ff.stdout.pipe(res);
    ff.stderr.on('data', (data) => console.error(`FFmpeg error: ${data}`));
    ff.on('close', (code) => {
      if (code !== 0) console.error(`FFmpeg exited with code ${code}`);
    });
    req.on('close', () => {
      try { ff.kill('SIGKILL'); } catch {}
    });
    return;
  }

  const stat = fs.statSync(mp4Path);
  const range = req.headers.range;
  
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const chunksize = (end - start) + 1;
    
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', String(chunksize));
    
    fs.createReadStream(mp4Path, { start, end }).pipe(res);
  } else {
    res.setHeader('Content-Length', String(stat.size));
    fs.createReadStream(mp4Path).pipe(res);
  }
});
