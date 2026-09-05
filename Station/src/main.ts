import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, session, shell } from 'electron';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

type StationConfig = {
  port?: number;
  bindHost?: string;
  databaseUrl?: string;
  managedDatabase?: boolean;
  postgresPort?: number;
  databaseName?: string;
  databaseUser?: string;
  mediaRoot?: string;
  allowedOrigins?: string[] | string;
  allowedNetworks?: string[] | string;
  runMigrations?: boolean;
};

type RuntimePaths = {
  dataDir: string;
  configPath: string;
  logPath: string;
  repoRoot: string | null;
  serverDir: string;
  webDistDir: string;
  ffmpegDir: string;
  postgresDir: string;
  postgresDataDir: string;
  postgresRunDir: string;
  downloadsDir: string;
  playlistsDir: string;
  bootstrapCredentialsPath: string;
};

const DEFAULT_PORT = 5174;
const DEFAULT_POSTGRES_PORT = 55432;
const DEFAULT_DATABASE_NAME = 'karaokedock';
const DEFAULT_DATABASE_USER = 'karaokedock';
const HEALTH_TIMEOUT_MS = 30_000;
const POSTGRES_TIMEOUT_MS = 30_000;
const STATION_USER_AGENT = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
const DEFAULT_STATION_CONFIG: Required<StationConfig> = {
  port: DEFAULT_PORT,
  bindHost: '0.0.0.0',
  managedDatabase: true,
  postgresPort: DEFAULT_POSTGRES_PORT,
  databaseName: DEFAULT_DATABASE_NAME,
  databaseUser: DEFAULT_DATABASE_USER,
  databaseUrl: '',
  mediaRoot: '/',
  allowedOrigins: [],
  allowedNetworks: [],
  runMigrations: false,
};

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.userAgentFallback = STATION_USER_AGENT;

let mainWindow: BrowserWindow | null = null;
let playerWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;
let postgresProcess: ChildProcess | null = null;
let runtimePaths: RuntimePaths | null = null;
let stationUrl = '';
let isQuitting = false;
let startupWarning: string | null = null;
let youtubeEmbedHeadersConfigured = false;

function resolveAppIconPath() {
  const candidate = app.isPackaged
    ? path.join(process.resourcesPath, 'icons', 'icon.png')
    : path.resolve(__dirname, '..', '..', 'docs', 'images', 'icon.png');
  return fs.existsSync(candidate) ? candidate : undefined;
}

function resolveRuntimePaths(): RuntimePaths {
  const dataDir = process.env.KARAOKEDOCK_STATION_DATA_DIR || app.getPath('userData');
  fs.mkdirSync(dataDir, { recursive: true });

  const logsDir = path.join(dataDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  if (app.isPackaged) {
    return {
      dataDir,
      configPath: path.join(dataDir, 'station.config.json'),
      logPath: path.join(logsDir, 'station.log'),
      repoRoot: null,
      serverDir: path.join(process.resourcesPath, 'server'),
      webDistDir: path.join(process.resourcesPath, 'web-dist'),
      ffmpegDir: path.join(process.resourcesPath, 'ffmpeg'),
      postgresDir: path.join(process.resourcesPath, 'postgres'),
      postgresDataDir: path.join(dataDir, 'postgres-data'),
      postgresRunDir: path.join(dataDir, 'postgres-run'),
      downloadsDir: path.join(dataDir, 'downloads'),
      playlistsDir: path.join(dataDir, 'playlists'),
      bootstrapCredentialsPath: path.join(dataDir, 'bootstrap-admin.json'),
    };
  }

  const repoRoot = path.resolve(__dirname, '..', '..');
  const stationWebDistDir = path.join(repoRoot, 'Station', '.build', 'web-dist');
  const stationFfmpegDir = path.join(repoRoot, 'Station', '.build', 'ffmpeg');
  const stationPostgresDir = path.join(repoRoot, 'Station', '.build', 'postgres');
  return {
    dataDir,
    configPath: path.join(dataDir, 'station.config.json'),
    logPath: path.join(logsDir, 'station.log'),
    repoRoot,
    serverDir: path.join(repoRoot, 'src', 'server'),
    webDistDir: fs.existsSync(stationWebDistDir)
      ? stationWebDistDir
      : path.join(repoRoot, 'src', 'web', 'dist'),
    ffmpegDir: process.env.KARAOKEDOCK_FFMPEG_DIR || stationFfmpegDir,
    postgresDir: process.env.KARAOKEDOCK_POSTGRES_DIR || stationPostgresDir,
    postgresDataDir: path.join(dataDir, 'postgres-data'),
    postgresRunDir: path.join(dataDir, 'postgres-run'),
    downloadsDir: path.join(dataDir, 'downloads'),
    playlistsDir: path.join(dataDir, 'playlists'),
    bootstrapCredentialsPath: path.join(dataDir, 'bootstrap-admin.json'),
  };
}

function createDefaultConfig(configPath: string) {
  if (fs.existsSync(configPath)) return;

  fs.writeFileSync(configPath, `${JSON.stringify(DEFAULT_STATION_CONFIG, null, 2)}\n`, 'utf8');
}

function mergeStationConfig(config: StationConfig): StationConfig {
  return { ...DEFAULT_STATION_CONFIG, ...config };
}

function persistStationConfigIfMissingKeys(configPath: string, parsed: StationConfig, merged: StationConfig) {
  const missingDefaultKeys = Object.keys(DEFAULT_STATION_CONFIG).some((key) => !(key in parsed));
  if (missingDefaultKeys) {
    fs.writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  }
}

function backupInvalidConfig(configPath: string) {
  const backupPath = `${configPath}.invalid-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.renameSync(configPath, backupPath);
  return backupPath;
}

function readStationConfig(paths: RuntimePaths): StationConfig {
  createDefaultConfig(paths.configPath);

  try {
    const parsed = JSON.parse(fs.readFileSync(paths.configPath, 'utf8')) as StationConfig;
    const config = parsed && typeof parsed === 'object' ? parsed : {};
    const merged = mergeStationConfig(config);
    persistStationConfigIfMissingKeys(paths.configPath, config, merged);
    return merged;
  } catch (error) {
    const backupPath = backupInvalidConfig(paths.configPath);
    createDefaultConfig(paths.configPath);
    startupWarning =
      `Station could not read station.config.json, so it backed up the invalid file and recreated defaults.\n\n` +
      `Backup: ${backupPath}\n\n` +
      `Original error: ${String(error)}`;
    return mergeStationConfig(JSON.parse(fs.readFileSync(paths.configPath, 'utf8')) as StationConfig);
  }
}

function appendLog(paths: RuntimePaths, line: string) {
  fs.appendFile(paths.logPath, line, (error) => {
    if (error) console.error('Failed to write Station log:', error);
  });
}

function normalizePort(value: unknown): number {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT;
}

function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function cidrToIpv4Origins(cidr: string, port: number): string[] {
  const match = cidr.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!match) return [];

  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return [];
  if (!Number.isInteger(prefix) || prefix < 24 || prefix > 32) return [];

  const ipNumber = ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
  const hostBits = 32 - prefix;
  const count = 2 ** hostBits;
  const mask = hostBits === 0 ? 0xffffffff : (0xffffffff << hostBits) >>> 0;
  const network = ipNumber & mask;
  const origins: string[] = [];
  const start = count > 2 ? 1 : 0;
  const end = count > 2 ? count - 1 : count;

  for (let offset = start; offset < end; offset++) {
    const current = (network + offset) >>> 0;
    const ip = [
      (current >>> 24) & 255,
      (current >>> 16) & 255,
      (current >>> 8) & 255,
      current & 255,
    ].join('.');
    origins.push(`http://${ip}:${port}`);
  }

  return origins;
}

function getAllowedOrigins(config: StationConfig, port: number) {
  const explicitOrigins = parseStringList(config.allowedOrigins);
  const networkOrigins = parseStringList(config.allowedNetworks).flatMap((network) => cidrToIpv4Origins(network, port));
  return [...new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...explicitOrigins, ...networkOrigins])];
}

function normalizeBindHost(value: unknown) {
  const host = String(value || '').trim();
  return host || DEFAULT_STATION_CONFIG.bindHost;
}

function buildServerEnv(paths: RuntimePaths, config: StationConfig, port: number): NodeJS.ProcessEnv {
  const allowedOrigins = getAllowedOrigins(config, port);
  const mediaRoot = String(config.mediaRoot || '').trim() || '/';

  fs.mkdirSync(mediaRoot, { recursive: true });
  fs.mkdirSync(paths.downloadsDir, { recursive: true });
  fs.mkdirSync(paths.playlistsDir, { recursive: true });
  const ffmpegBinDir = path.join(paths.ffmpegDir, 'bin');
  const ffmpegLibDir = path.join(paths.ffmpegDir, 'lib');

  return {
    ...process.env,
    PORT: String(port),
    WEB_DIST_DIR: paths.webDistDir,
    WEB_APP_URL: `http://127.0.0.1:${port}`,
    WEB_RUNTIME_API_BASE: '',
    STATION_MODE: 'true',
    BIND_HOST: normalizeBindHost(config.bindHost),
    MEDIA_ROOT: mediaRoot,
    YTDLP_DOWNLOAD_LOCATION: paths.downloadsDir,
    BREAK_MUSIC_PLAYLISTS_FOLDER: paths.playlistsDir,
    ORIGIN: allowedOrigins.join(','),
    TRUST_PROXY: process.env.TRUST_PROXY || 'false',
    BOOTSTRAP_CREDENTIALS_FILE: paths.bootstrapCredentialsPath,
    PATH: `${ffmpegBinDir}${path.delimiter}${process.env.PATH || ''}`,
    LD_LIBRARY_PATH: [ffmpegLibDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter),
  };
}

function getFfmpegBinary(paths: RuntimePaths, binary: string) {
  return path.join(paths.ffmpegDir, 'bin', binary);
}

function validateFfmpegRuntime(paths: RuntimePaths, env: NodeJS.ProcessEnv) {
  const ffmpeg = getFfmpegBinary(paths, 'ffmpeg');
  const ffprobe = getFfmpegBinary(paths, 'ffprobe');
  const missing = [ffmpeg, ffprobe].filter((binary) => !fs.existsSync(binary));
  if (missing.length > 0) {
    if (!app.isPackaged) return;
    throw new Error(
      `Station FFmpeg runtime is missing (${missing.map((binary) => path.basename(binary)).join(', ')}). ` +
      'Run "npm run stage:ffmpeg" before development builds or rebuild the AppImage.',
    );
  }

  const filters = spawnSync(ffmpeg, ['-hide_banner', '-filters'], {
    env,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (filters.status !== 0 || !/(^|\s)rubberband(\s|$)/m.test(`${filters.stdout}\n${filters.stderr}`)) {
    throw new Error('Station FFmpeg runtime does not include the rubberband filter required for pitch control.');
  }

  const probe = spawnSync(ffprobe, ['-hide_banner', '-version'], { env, encoding: 'utf8' });
  if (probe.status !== 0) {
    throw new Error('Station ffprobe runtime failed to start.');
  }
}

function getPostgresBinary(paths: RuntimePaths, binary: string) {
  return path.join(paths.postgresDir, 'bin', binary);
}

function getPostgresEnv(paths: RuntimePaths, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const libPaths = [
    path.join(paths.postgresDir, 'lib'),
    path.join(paths.postgresDir, 'lib', 'pgsql'),
    path.join(paths.postgresDir, 'lib64'),
    path.join(paths.postgresDir, 'lib64', 'pgsql'),
    env.LD_LIBRARY_PATH,
  ].filter(Boolean);

  return {
    ...env,
    PATH: `${path.join(paths.postgresDir, 'bin')}${path.delimiter}${env.PATH || ''}`,
    LD_LIBRARY_PATH: libPaths.join(path.delimiter),
  };
}

function validatePostgresRuntime(paths: RuntimePaths) {
  const required = ['postgres', 'initdb', 'createdb', 'psql', 'pg_isready'];
  const missing = required.filter((binary) => !fs.existsSync(getPostgresBinary(paths, binary)));
  if (missing.length > 0) {
    throw new Error(
      `Station PostgreSQL runtime is missing (${missing.join(', ')}). ` +
      'Run "npm run stage:postgres" before development builds or rebuild the AppImage.',
    );
  }
}

function normalizePostgresPort(value: unknown): number {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_POSTGRES_PORT;
}

function normalizeDatabaseIdentifier(value: unknown, fallback: string) {
  const text = String(value || '').trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(text) ? text : fallback;
}

function getManagedDatabaseSettings(config: StationConfig) {
  return {
    port: normalizePostgresPort(process.env.KARAOKEDOCK_POSTGRES_PORT || config.postgresPort),
    databaseName: normalizeDatabaseIdentifier(config.databaseName, DEFAULT_DATABASE_NAME),
    databaseUser: normalizeDatabaseIdentifier(config.databaseUser, DEFAULT_DATABASE_USER),
  };
}

function getManagedDatabaseUrl(settings: ReturnType<typeof getManagedDatabaseSettings>) {
  const url = new URL(`postgres://127.0.0.1:${settings.port}/${settings.databaseName}`);
  url.username = settings.databaseUser;
  return url.toString();
}

function runCommand(
  paths: RuntimePaths,
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; label: string },
) {
  appendLog(paths, `[${new Date().toISOString()}] ${options.label}: ${command} ${args.join(' ')}\n`);

  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      appendLog(paths, text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      appendLog(paths, text);
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(
        `${options.label} exited with code ${code ?? 'null'}${signal ? ` and signal ${signal}` : ''}\n${stderr}`,
      );
      reject(Object.assign(error, { stdout, stderr, code, signal }));
    });
  });
}

async function initializeManagedPostgres(paths: RuntimePaths, env: NodeJS.ProcessEnv, databaseUser: string) {
  if (fs.existsSync(path.join(paths.postgresDataDir, 'PG_VERSION'))) return;

  fs.mkdirSync(paths.postgresDataDir, { recursive: true });
  fs.chmodSync(paths.postgresDataDir, 0o700);

  await runCommand(
    paths,
    getPostgresBinary(paths, 'initdb'),
    [
      '-D', paths.postgresDataDir,
      '-U', databaseUser,
      '-A', 'trust',
      '--encoding=UTF8',
      '--locale=C',
      '-L', path.join(paths.postgresDir, 'share', 'pgsql'),
      '-c', `dynamic_library_path=${path.join(paths.postgresDir, 'lib', 'pgsql')}`,
    ],
    { cwd: paths.dataDir, env, label: 'postgres-initdb' },
  );
}

function startManagedPostgres(paths: RuntimePaths, env: NodeJS.ProcessEnv, port: number) {
  fs.mkdirSync(paths.postgresRunDir, { recursive: true });

  postgresProcess = spawnProcess(
    paths,
    getPostgresBinary(paths, 'postgres'),
    [
      '-D', paths.postgresDataDir,
      '-h', '127.0.0.1',
      '-p', String(port),
      '-k', paths.postgresRunDir,
      '-c', 'listen_addresses=127.0.0.1',
      '-c', `dynamic_library_path=${path.join(paths.postgresDir, 'lib', 'pgsql')}`,
    ],
    { cwd: paths.dataDir, env, label: 'postgres' },
  );

  postgresProcess.once('exit', (code, signal) => {
    if (!isQuitting) {
      dialog.showErrorBox(
        'KaraokeDock Station database stopped',
        `The managed PostgreSQL server exited with code ${code ?? 'null'}${signal ? ` and signal ${signal}` : ''}.`,
      );
    }
  });
}

async function waitForManagedPostgres(
  paths: RuntimePaths,
  env: NodeJS.ProcessEnv,
  settings: ReturnType<typeof getManagedDatabaseSettings>,
) {
  const deadline = Date.now() + POSTGRES_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      await runCommand(
        paths,
        getPostgresBinary(paths, 'pg_isready'),
        ['-h', '127.0.0.1', '-p', String(settings.port), '-U', settings.databaseUser, '-d', 'postgres'],
        { cwd: paths.dataDir, env, label: 'postgres-ready' },
      );
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw new Error(`Managed PostgreSQL did not become ready within ${POSTGRES_TIMEOUT_MS / 1000}s`);
}

async function ensureManagedDatabase(
  paths: RuntimePaths,
  env: NodeJS.ProcessEnv,
  settings: ReturnType<typeof getManagedDatabaseSettings>,
) {
  try {
    await runCommand(
      paths,
      getPostgresBinary(paths, 'createdb'),
      ['-h', '127.0.0.1', '-p', String(settings.port), '-U', settings.databaseUser, settings.databaseName],
      { cwd: paths.dataDir, env, label: 'postgres-createdb' },
    );
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr || '');
    if (!stderr.includes('already exists')) throw error;
  }
}

function sqlTextLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

async function applyStationDatabaseDefaults(paths: RuntimePaths, env: NodeJS.ProcessEnv) {
  const downloadsDir = sqlTextLiteral(paths.downloadsDir);
  const playlistsDir = sqlTextLiteral(paths.playlistsDir);

  await runCommand(
    paths,
    getPostgresBinary(paths, 'psql'),
    [
      process.env.DATABASE_URL || env.DATABASE_URL || '',
      '-v', 'ON_ERROR_STOP=1',
      '-c',
      `
      INSERT INTO settings (key, value)
      VALUES
        ('ytdlp.download_location', to_jsonb(${downloadsDir}::text)),
        ('break_music.playlists_folder', to_jsonb(${playlistsDir}::text))
      ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value
      WHERE settings.value IN ('"/media/downloads"'::jsonb, '"/media/playlists"'::jsonb, '""'::jsonb, 'null'::jsonb);
      `,
    ],
    { cwd: paths.dataDir, env, label: 'station-db-defaults' },
  );
}

async function prepareDatabase(paths: RuntimePaths, config: StationConfig, env: NodeJS.ProcessEnv) {
  const externalDatabaseUrl = config.databaseUrl?.trim() || process.env.DATABASE_URL?.trim();
  if (externalDatabaseUrl) {
    return {
      env: { ...env, DATABASE_URL: externalDatabaseUrl },
      shouldRunMigrations: config.runMigrations === true,
    };
  }

  if (config.managedDatabase === false) {
    throw new Error('Station config has managedDatabase=false but no databaseUrl was provided.');
  }

  validatePostgresRuntime(paths);
  const settings = getManagedDatabaseSettings(config);
  const postgresEnv = getPostgresEnv(paths, env);

  await initializeManagedPostgres(paths, postgresEnv, settings.databaseUser);
  startManagedPostgres(paths, postgresEnv, settings.port);
  await waitForManagedPostgres(paths, postgresEnv, settings);
  await ensureManagedDatabase(paths, postgresEnv, settings);

  return {
    env: {
      ...postgresEnv,
      DATABASE_URL: getManagedDatabaseUrl(settings),
      PGHOST: '127.0.0.1',
      PGPORT: String(settings.port),
      PGUSER: settings.databaseUser,
      PGDATABASE: settings.databaseName,
    },
    shouldRunMigrations: true,
  };
}

function getPackagedTsxPath(serverDir: string) {
  return path.join(serverDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
}

function spawnProcess(
  paths: RuntimePaths,
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; label: string },
) {
  appendLog(paths, `[${new Date().toISOString()}] ${options.label}: ${command} ${args.join(' ')}\n`);
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    appendLog(paths, text);
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    process.stderr.write(text);
    appendLog(paths, text);
  });

  return child;
}

function waitForExit(child: ChildProcess, label: string) {
  return new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${label} exited with code ${code ?? 'null'}${signal ? ` and signal ${signal}` : ''}`));
    });
  });
}

async function runMigrations(paths: RuntimePaths, env: NodeJS.ProcessEnv) {
  if (app.isPackaged) {
    const child = spawnProcess(paths, 'sh', [path.join(paths.serverDir, 'scripts', 'migrate.sh')], {
      cwd: paths.serverDir,
      env,
      label: 'migrate',
    });
    await waitForExit(child, 'migrations');
    return;
  }

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const child = spawnProcess(paths, npmCommand, ['run', 'migrate'], {
    cwd: paths.serverDir,
    env,
    label: 'migrate',
  });
  await waitForExit(child, 'migrations');
}

function startServerProcess(paths: RuntimePaths, env: NodeJS.ProcessEnv) {
  if (app.isPackaged) {
    const tsxPath = getPackagedTsxPath(paths.serverDir);
    return spawnProcess(paths, process.execPath, [tsxPath, path.join(paths.serverDir, 'src', 'index.ts')], {
      cwd: paths.serverDir,
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      label: 'server',
    });
  }

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return spawnProcess(paths, npmCommand, ['run', 'start'], {
    cwd: paths.serverDir,
    env,
    label: 'server',
  });
}

function waitForHealth(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;

  return new Promise<void>((resolve, reject) => {
    const attempt = () => {
      const req = http.get(`${url}/health`, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
          return;
        }
        retry();
      });
      req.setTimeout(1000, () => {
        req.destroy();
        retry();
      });
      req.on('error', retry);
    };

    const retry = () => {
      if (Date.now() >= deadline) {
        reject(new Error(`KaraokeDock server did not become healthy within ${timeoutMs / 1000}s`));
        return;
      }
      setTimeout(attempt, 500);
    };

    attempt();
  });
}

async function startKaraokeDockServer(paths: RuntimePaths, config: StationConfig) {
  const port = normalizePort(process.env.PORT || config.port);
  stationUrl = `http://127.0.0.1:${port}`;
  const baseEnv = buildServerEnv(paths, config, port);
  validateFfmpegRuntime(paths, baseEnv);
  const database = await prepareDatabase(paths, config, baseEnv);
  const env = database.env;

  if (database.shouldRunMigrations) {
    await runMigrations(paths, env);
  }

  await applyStationDatabaseDefaults(paths, env);

  const child = startServerProcess(paths, env);
  serverProcess = child;
  child.once('exit', (code, signal) => {
    if (!isQuitting) {
      dialog.showErrorBox(
        'KaraokeDock Station server stopped',
        `The local KaraokeDock server exited with code ${code ?? 'null'}${signal ? ` and signal ${signal}` : ''}.`,
      );
    }
  });

  await waitForHealth(stationUrl, HEALTH_TIMEOUT_MS);
}

function configureYouTubeEmbedHeaders() {
  if (youtubeEmbedHeadersConfigured || !stationUrl) return;
  youtubeEmbedHeadersConfigured = true;

  const stationOrigin = new URL(stationUrl).origin;
  const playerReferrer = `${stationOrigin}/player`;

  session.defaultSession.webRequest.onBeforeSendHeaders(
    {
      urls: [
        '*://*.youtube.com/*',
        '*://youtube.com/*',
        '*://*.youtube-nocookie.com/*',
        '*://youtube-nocookie.com/*',
      ],
    },
    (details, callback) => {
      callback({
        requestHeaders: {
          ...details.requestHeaders,
          Referer:
            details.requestHeaders.Referer ||
            details.requestHeaders.referer ||
            playerReferrer,
          Origin:
            details.requestHeaders.Origin ||
            details.requestHeaders.origin ||
            stationOrigin,
        },
      });
    },
  );
}

type BootstrapCredentialsFile = {
  username?: string;
  password?: string;
  generatedAt?: string;
  message?: string;
};

function readBootstrapCredentials(paths: RuntimePaths): BootstrapCredentialsFile | null {
  if (!fs.existsSync(paths.bootstrapCredentialsPath)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(paths.bootstrapCredentialsPath, 'utf8')) as BootstrapCredentialsFile;
    if (!parsed.username || !parsed.password) return null;
    return parsed;
  } catch {
    return null;
  }
}

function showStationMessageBox(options: Electron.MessageBoxOptions) {
  return mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options);
}

async function showBootstrapCredentials(options: { automatic?: boolean } = {}) {
  if (!runtimePaths) return;
  const credentials = readBootstrapCredentials(runtimePaths);

  if (!credentials) {
    if (!options.automatic) {
      await showStationMessageBox({
        type: 'info',
        message: 'No generated admin credentials were found.',
        detail: 'If you already changed the admin password, use that password to sign in.',
      });
    }
    return;
  }

  const response = await showStationMessageBox({
    type: 'warning',
    buttons: ['Copy Password', 'Open Admin', 'OK'],
    defaultId: 0,
    cancelId: 2,
    message: 'Generated KaraokeDock admin credentials',
    detail: [
      `Username: ${credentials.username}`,
      `Password: ${credentials.password}`,
      credentials.generatedAt ? `Generated: ${credentials.generatedAt}` : null,
      '',
      credentials.message || 'Change this password immediately after first login.',
      `Credentials file: ${runtimePaths.bootstrapCredentialsPath}`,
    ].filter(Boolean).join('\n'),
  });

  if (response.response === 0 && credentials.password) {
    clipboard.writeText(credentials.password);
  } else if (response.response === 1) {
    await showAppPath('/admin');
  }
}

function createMainWindow() {
  if (mainWindow) return mainWindow;

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'KaraokeDock Station',
    icon: resolveAppIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.webContents.setUserAgent(STATION_USER_AGENT);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.origin === stationUrl && parsed.pathname === '/player') {
        void openPlayerWindow();
        return { action: 'deny' };
      }
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        void shell.openExternal(url);
        return { action: 'deny' };
      }
    } catch {}
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  void mainWindow.loadURL(`${stationUrl}/host`);
  return mainWindow;
}

async function openPlayerWindow() {
  if (playerWindow) {
    playerWindow.show();
    playerWindow.focus();
    return;
  }

  playerWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    title: 'KaraokeDock Player',
    backgroundColor: '#000000',
    icon: resolveAppIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  playerWindow.webContents.setUserAgent(STATION_USER_AGENT);

  playerWindow.on('closed', () => {
    playerWindow = null;
  });

  await playerWindow.loadURL(`${stationUrl}/player`);
}

function showAppPath(appPath: string) {
  const normalizedPath = appPath.startsWith('/') ? appPath : `/${appPath}`;
  const win = createMainWindow();
  win.show();
  win.focus();
  return win.loadURL(`${stationUrl}${normalizedPath}`);
}

function createApplicationMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'KaraokeDock',
      submenu: [
        { label: 'Host', click: () => void showAppPath('/host') },
        { label: 'Admin', click: () => void showAppPath('/admin') },
        { label: 'Requests', click: () => void showAppPath('/requests') },
        { type: 'separator' },
        { label: 'Open Player Window', accelerator: 'CommandOrControl+P', click: () => void openPlayerWindow() },
        {
          label: 'Toggle Player Full Screen',
          accelerator: 'F11',
          click: () => {
            if (playerWindow) playerWindow.setFullScreen(!playerWindow.isFullScreen());
          },
        },
        { type: 'separator' },
        {
          label: 'Open Station Config',
          click: () => {
            if (runtimePaths) void shell.openPath(runtimePaths.configPath);
          },
        },
        { label: 'Show Initial Admin Credentials', click: () => void showBootstrapCredentials() },
        { label: 'Quit', role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpcHandlers() {
  ipcMain.handle('station:open-player', async () => {
    await openPlayerWindow();
    return { ok: true };
  });

  ipcMain.handle('station:toggle-player-fullscreen', () => {
    if (!playerWindow) return { ok: false, error: 'Player window is not open' };
    playerWindow.setFullScreen(!playerWindow.isFullScreen());
    return { ok: true, fullScreen: playerWindow.isFullScreen() };
  });

  ipcMain.handle('station:show-window', async (_event, appPath: string) => {
    await showAppPath(String(appPath || '/host'));
    return { ok: true };
  });

  ipcMain.handle('station:get-info', () => ({
    stationUrl,
    dataDir: runtimePaths?.dataDir ?? null,
    configPath: runtimePaths?.configPath ?? null,
    packaged: app.isPackaged,
  }));
}

async function bootstrap() {
  runtimePaths = resolveRuntimePaths();
  const config = readStationConfig(runtimePaths);

  createApplicationMenu();
  registerIpcHandlers();

  try {
    await startKaraokeDockServer(runtimePaths, config);
  } catch (error) {
    dialog.showErrorBox('Unable to start KaraokeDock Station', String(error));
    app.exit(1);
    return;
  }

  configureYouTubeEmbedHeaders();
  createMainWindow();
  if (startupWarning) {
    setTimeout(() => {
      void showStationMessageBox({
        type: 'warning',
        message: 'Station config was reset',
        detail: startupWarning || undefined,
      });
    }, 500);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (stationUrl) {
      createMainWindow();
    }
  });

  app.on('before-quit', () => {
    isQuitting = true;
    if (serverProcess && !serverProcess.killed) serverProcess.kill();
    if (postgresProcess && !postgresProcess.killed) postgresProcess.kill();
  });

  app.whenReady().then(() => {
    void bootstrap();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && stationUrl) {
      createMainWindow();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
