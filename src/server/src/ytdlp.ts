// server/src/ytdlp.ts
import { spawn } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import { getSetting } from './db';
import { logger } from './logger.js';

// Video format preference: best quality MP4 with audio, max 1080p
// Format selection priority:
// 1. Best video (MP4, max 1080p) + best audio (m4a) - separate streams merged
// 2. Best combined MP4 (max 1080p) - single file with video+audio
// 3. Best available (max 1080p) - fallback for any format
// The [height<=1080] filter ensures we don't download 4K/8K videos
const DEFAULT_VIDEO_FORMAT = 'bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4][height<=1080]/best[height<=1080]';
const DEFAULT_DOWNLOAD_LOCATION = process.env.YTDLP_DOWNLOAD_LOCATION || '/media/downloads';

// Characters that are invalid in filenames across operating systems
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*]/g;

// Title parsing patterns
// Format: "DISCID - Artist - Title" (e.g., "SC123 - Taylor Swift - Shake It Off")
const TITLE_PATTERN_WITH_DISCID = /^([A-Z0-9]+)\s*-\s*(.+?)\s*-\s*(.+)$/i;

// Format: "Artist - Title" (e.g., "Taylor Swift - Shake It Off")
const TITLE_PATTERN_SIMPLE = /^(.+?)\s*-\s*(.+)$/;

export class DownloadScanAlreadyInProgressError extends Error {
  constructor() {
    super('download scan already in progress');
    this.name = 'DownloadScanAlreadyInProgressError';
  }
}

let downloadScanInFlight: Promise<{
  success: boolean;
  added: number;
  removed: number;
  skipped: number;
  message?: string;
}> | null = null;

/**
 * Check if yt-dlp is installed and get version
 */
export async function getYtDlpVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('yt-dlp', ['--version']);
    let output = '';
    
    proc.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    proc.on('close', (code) => {
      if (code === 0 && output.trim()) {
        resolve(output.trim());
      } else {
        resolve(null);
      }
    });
    
    proc.on('error', () => {
      resolve(null);
    });
  });
}

/**
 * Update yt-dlp to the latest version
 */
export async function updateYtDlp(): Promise<{ success: boolean; message: string; version?: string }> {
  return new Promise((resolve) => {
    const proc = spawn('pip3', ['install', '--upgrade', '--break-system-packages', 'yt-dlp']);
    let output = '';
    let errorOutput = '';
    
    proc.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    proc.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });
    
    proc.on('close', async (code) => {
      if (code === 0) {
        const version = await getYtDlpVersion();
        resolve({ 
          success: true, 
          message: 'yt-dlp updated successfully', 
          version: version || undefined 
        });
      } else {
        resolve({ 
          success: false, 
          message: `Failed to update yt-dlp: ${errorOutput || output}` 
        });
      }
    });
    
    proc.on('error', (err) => {
      resolve({ 
        success: false, 
        message: `Error updating yt-dlp: ${err.message}` 
      });
    });
  });
}

/**
 * Extract video information using yt-dlp
 */
export async function getVideoInfo(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', [
      '--dump-json',
      '--no-playlist',
      url
    ]);
    
    let output = '';
    let errorOutput = '';
    
    proc.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    proc.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });
    
    proc.on('close', (code) => {
      if (code === 0 && output) {
        try {
          const info = JSON.parse(output);
          resolve(info);
        } catch (err) {
          reject(new Error('Failed to parse video info'));
        }
      } else {
        reject(new Error(errorOutput || 'Failed to get video info'));
      }
    });
    
    proc.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Parse video title into disc_id, artist, and title
 * Expected formats:
 * - "discID - Artist - Title"
 * - "Artist - Title"
 */
function parseVideoTitle(title: string): { disc_id: string | null; artist: string; title: string } {
  // Try format: "discID - Artist - Title"
  const match1 = title.match(TITLE_PATTERN_WITH_DISCID);
  if (match1) {
    return {
      disc_id: match1[1].trim(),
      artist: match1[2].trim(),
      title: match1[3].trim()
    };
  }
  
  // Try format: "Artist - Title"
  const match2 = title.match(TITLE_PATTERN_SIMPLE);
  if (match2) {
    return {
      disc_id: null,
      artist: match2[1].trim(),
      title: match2[2].trim()
    };
  }
  
  // Default: use entire title
  return {
    disc_id: null,
    artist: 'Unknown Artist',
    title: title
  };
}

/**
 * Download video using yt-dlp
 * Returns the path to the downloaded file
 */
export async function downloadVideo(
  url: string, 
  options: {
    format?: string;
    outputTemplate?: string;
    title?: string;
    artist?: string;
    brand?: string;
    discId?: string;
  } = {}
): Promise<{ success: boolean; filePath?: string; message?: string; parsed?: any }> {
  try {
    // Get download location from settings
    const downloadLocationSetting = await getSetting('ytdlp.download_location');
    const downloadLocation = downloadLocationSetting || DEFAULT_DOWNLOAD_LOCATION;
    
    // Ensure download directory exists
    await fs.mkdir(downloadLocation, { recursive: true });
    
    // Get video info first to extract title if not provided
    const info = await getVideoInfo(url);
    const videoTitle = options.title || info.title || 'Unknown';
    
    // Parse the title or use provided metadata
    let parsed: { disc_id: string | null; artist: string; title: string };
    if (options.title && options.artist) {
      // Use provided metadata (e.g., from Karaoke Nerds or manual URL entry)
      // Priority: discId > brand > null
      // When downloading from Karaoke Nerds, brand should be used as disc_id
      parsed = {
        disc_id: options.discId || options.brand || null,
        artist: options.artist,
        title: options.title
      };
    } else {
      // Parse from video title
      parsed = parseVideoTitle(videoTitle);
    }
    
    // Build filename: "discid - artist - title.mp4" or "artist - title.mp4"
    let filename: string;
    if (parsed.disc_id) {
      filename = `${parsed.disc_id} - ${parsed.artist} - ${parsed.title}.mp4`;
    } else {
      filename = `${parsed.artist} - ${parsed.title}.mp4`;
    }
    
    // Sanitize filename (remove invalid characters)
    filename = filename.replace(INVALID_FILENAME_CHARS, '_');
    
    const outputPath = path.join(downloadLocation, filename);
    const outputTemplate = options.outputTemplate || outputPath;
    
    return new Promise((resolve) => {
      const args = [
        '--format', options.format || DEFAULT_VIDEO_FORMAT,
        '--merge-output-format', 'mp4',
        '--output', outputTemplate,
        '--no-playlist',
        url
      ];
      
      const proc = spawn('yt-dlp', args);
      let output = '';
      let errorOutput = '';
      
      proc.stdout.on('data', (data) => {
        output += data.toString();
        console.log('[yt-dlp]', data.toString().trim());
      });
      
      proc.stderr.on('data', (data) => {
        errorOutput += data.toString();
        console.error('[yt-dlp error]', data.toString().trim());
      });
      
      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ 
            success: true, 
            filePath: outputPath,
            parsed: parsed,
            message: 'Video downloaded successfully' 
          });
        } else {
          resolve({ 
            success: false, 
            message: `Failed to download video: ${errorOutput || output}` 
          });
        }
      });
      
      proc.on('error', (err) => {
        resolve({ 
          success: false, 
          message: `Error downloading video: ${err.message}` 
        });
      });
    });
  } catch (err: any) {
    return { 
      success: false, 
      message: `Error: ${err.message}` 
    };
  }
}

/**
 * Add downloaded file to the database
 * Scans the file and adds it to the tracks table
 * Returns early if the file doesn't exist
 */
export async function addDownloadedFileToDatabase(filePath: string): Promise<{ success: boolean; trackId?: number; message?: string }> {
  try {
    // Check if file exists before proceeding
    try {
      await fs.access(filePath);
    } catch (err) {
      return {
        success: false,
        message: `File not found: ${filePath}`
      };
    }

    const { upsertArtist, upsertTrack } = await import('./db');
    const { getMediaDuration } = await import('./scanner');
    const { parseFromFilename } = await import('./parsing');
    
    // Get file info
    const basename = path.basename(filePath);
    const directory = path.dirname(filePath);
    
    // Parse filename to extract metadata using centralized parsing logic
    // Expected format: "discid - artist - title.mp4" or "artist - title.mp4"
    // parseFromFilename handles removing the extension internally
    const parsed = parseFromFilename(basename);
    
    // Get duration
    let duration_ms: number | null = null;
    try {
      const durationSeconds = await getMediaDuration(filePath);
      if (durationSeconds && durationSeconds > 0) {
        duration_ms = Math.round(durationSeconds * 1000);
      }
    } catch (err) {
      console.warn('Failed to get duration for downloaded file:', err);
    }
    
    // Upsert artist
    const artistId = await upsertArtist(parsed.artist || 'Unknown Artist');
    
    // Upsert track
    // Note: library_id is set to null for downloads as they are not associated with a specific library
    // The database schema allows null for library_id (nullable foreign key)
    const track = await upsertTrack({
      artist_id: artistId,
      disc_id: parsed.discId, // parseFromFilename returns discId (camelCase)
      title: parsed.title || 'Unknown Title',
      kind: 'mp4',
      duration_ms,
      file_mp4: filePath,
      file_cdg: null,
      file_mp3: null,
      path: directory,
      basename: basename,
      library_id: null
    });
    
    return {
      success: true,
      trackId: track.id,
      message: `Added "${parsed.artist || 'Unknown Artist'} - ${parsed.title || 'Unknown Title'}" to database`
    };
  } catch (err: any) {
    console.error('Error adding downloaded file to database:', err);
    return {
      success: false,
      message: `Error adding to database: ${err.message}`
    };
  }
}

/**
 * Scan download location folder and add all MP4 files to the database
 * Also removes tracks from database if their files no longer exist
 */
export async function scanDownloadLocation(): Promise<{ 
  success: boolean; 
  added: number; 
  removed: number; 
  skipped: number; 
  message?: string 
}> {
  if (downloadScanInFlight) {
    throw new DownloadScanAlreadyInProgressError();
  }

  downloadScanInFlight = (async () => {
    try {
      const { query } = await import('./db');
      
      const downloadLocationSetting = await getSetting('ytdlp.download_location');
      const downloadLocation = downloadLocationSetting || DEFAULT_DOWNLOAD_LOCATION;
      
      try {
        await fs.access(downloadLocation);
      } catch (err) {
        return {
          success: false,
          added: 0,
          removed: 0,
          skipped: 0,
          message: `Download location does not exist: ${downloadLocation}`
        };
      }
      
      let addedCount = 0;
      let skippedCount = 0;
      let removedCount = 0;
      
      const files = await fs.readdir(downloadLocation);
      const mp4Files = files.filter(f => f.toLowerCase().endsWith('.mp4'));
      
      logger.verbose(`[ytdlp] Scanning ${downloadLocation}: found ${mp4Files.length} MP4 files`);
      
      for (const file of mp4Files) {
        const filePath = path.join(downloadLocation, file);
        const existing = await query(
          `SELECT id
             FROM tracks
            WHERE library_id IS NULL
              AND kind = 'mp4'
              AND file_mp4 = $1
            LIMIT 1`,
          [filePath]
        );
        if (existing.rows.length > 0) {
          continue;
        }

        const result = await addDownloadedFileToDatabase(filePath);
        
        if (result.success) {
          addedCount++;
          logger.info(`[ytdlp] Added downloaded track: ${file}`);
        } else {
          skippedCount++;
          logger.info(`[ytdlp] Skipped downloaded track ${file}: ${result.message}`);
        }
      }
      
      const tracksResult = await query(
        `SELECT id, file_mp4, basename FROM tracks WHERE path = $1 AND library_id IS NULL AND file_mp4 IS NOT NULL`,
        [downloadLocation]
      );
      
      for (const track of tracksResult.rows) {
        const filePath = track.file_mp4;
        
        try {
          await fs.access(filePath);
        } catch (err) {
          logger.info(`[ytdlp] Removing missing downloaded track from DB: ${track.basename}`);
          await query(`DELETE FROM tracks WHERE id = $1`, [track.id]);
          removedCount++;
        }
      }
      
      return {
        success: true,
        added: addedCount,
        removed: removedCount,
        skipped: skippedCount,
        message: `Scan complete: ${addedCount} added, ${removedCount} removed, ${skippedCount} skipped`
      };
    } catch (err: any) {
      console.error('Error scanning download location:', err);
      return {
        success: false,
        added: 0,
        removed: 0,
        skipped: 0,
        message: `Error scanning: ${err.message}`
      };
    }
  })();

  try {
    return await downloadScanInFlight;
  } finally {
    downloadScanInFlight = null;
  }
}
