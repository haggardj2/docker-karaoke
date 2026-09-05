// web/src/pages/Host.tsx
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { api, API_BASE, getWsUrl } from '../api'
import { useAuth } from '../auth-context'
import { parseBooleanSetting } from '../utils/settings'
import { clearStoredSessionToken, writeStoredSessionToken } from '../session-token'

type Row = {
  id: number
  track_id: number
  requested_by: string | null
  status: 'queued' | 'playing' | 'done'
  position: number
  title: string | null
  artist: string | null
  disc_id?: string | null
  kind: 'mp4' | 'cdgmp3' | 'zip' | 'mp3'
  duration_ms?: number | null
  key_adjustment?: number
}

// --- Nested queue state types ---
type QueueSong = {
  queueId: number
  trackId: number | null
  title: string | null
  artist: string | null
  discId?: string | null
  status: string
  position: number | null
  requestedAt: string | null
  startedAt: string | null
  completedAt: string | null
  keyAdjustment: number
  durationMs: number | null
  requestedBy: string | null
}

type QueueSinger = {
  singerId: string
  publicUuid?: string | null
  displayName: string
  status: string
  rotationPosition: number | null
  lastSangAt: string | null
  totalSongsSung: number
  nextSong: QueueSong | null
  queuedSongs: QueueSong[]
  completedSongs: QueueSong[]
  completedSongsCount: number
  queuedSongsCount: number
}

type ActiveRotation = {
  id: string | number
  type: string
  config: Record<string, unknown>
  currentRound: number
}

type QueueState = {
  activeRotation: ActiveRotation | null
  nowPlaying: QueueSong | null
  queueOrder: QueueSinger[]
  completedHistory: QueueSong[]
  flatQueue: QueueSong[]
}

type SingerHistorySong = {
  queueId: number
  trackId: number | null
  title: string | null
  artist: string | null
  discId?: string | null
  status: string
  position: number | null
  requestedAt: string | null
  startedAt: string | null
  completedAt: string | null
  keyAdjustment: number
  durationMs: number | null
}

type SingerHistory = {
  singer: {
    id: string
    displayName: string
    normalizedName: string
    status: string
    totalSongsSung: number
    lastSangAt: string | null
  }
  queuedSongs: SingerHistorySong[]
  completedSongs: SingerHistorySong[]
  skippedSongs: SingerHistorySong[]
  removedSongs: SingerHistorySong[]
  allSongs: SingerHistorySong[]
}

type SingerHistoryKdSinger = {
  singer?: {
    id?: string
    displayName?: string
    normalizedName?: string
  }
  songs?: unknown[]
}

type SingerHistoryKdFile = {
  format?: string
  version?: number
  exportedAt?: string
  singers?: SingerHistoryKdSinger[]
}

const LOCAL_SEARCH_DELAY_MS = 300
const KARAOKE_NERDS_SEARCH_DELAY_MS = 500

type OidcPublicConfig = {
  enabled: boolean
  buttonText: string
  buttonColor: string
  passwordLoginEnabled: boolean
}

function MaterialIcon({
  name,
  className = '',
  style,
}: {
  name: string
  className?: string
  style?: React.CSSProperties
}) {
  return (
    <span className={`material-symbols-rounded${className ? ` ${className}` : ''}`} aria-hidden="true" style={style}>
      {name}
    </span>
  )
}

function renderStatusMessage(message: string) {
  if (message.startsWith('⚠️')) {
    return (
      <>
        <MaterialIcon name="warning" style={{ fontSize: 18, verticalAlign: 'text-bottom', marginRight: 6 }} />
        {message.replace(/^⚠️\s*/, '')}
      </>
    )
  }
  if (message.startsWith('✔')) {
    return (
      <>
        <MaterialIcon name="check_circle" style={{ fontSize: 18, verticalAlign: 'text-bottom', marginRight: 6 }} />
        {message.replace(/^✔\s*/, '')}
      </>
    )
  }
  return message
}

type BreakTrack = {
  id: number
  title: string
  artist: string | null
  genre: string | null
  duration_ms: number | null
  file_path: string
}

type BreakPlaylist = {
  id: number
  name: string
}

type BreakColumnVisibility = {
  song: boolean
  artist: boolean
  genre: boolean
  length: boolean
  path: boolean
}

type BreakColumnKey = keyof BreakColumnVisibility

type BreakColumnWidths = Record<BreakColumnKey, number>
type BreakSortDirection = 'asc' | 'desc'
type BreakSortState = {
  column: BreakColumnKey
  direction: BreakSortDirection
}

const DEFAULT_BREAK_COLUMNS: BreakColumnVisibility = {
  song: true,
  artist: true,
  genre: true,
  length: true,
  path: true,
}

const BREAK_COLUMNS_STORAGE_KEY = 'host.breakMusicColumns'
const HOST_TOP_COLLAPSED_STORAGE_KEY = 'host.topCardCollapsed'
const HOST_CONTROL_BUTTON_COUNT = 6

function downloadJsonFile(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

function safeHistoryFilename(name: string): string {
  return `${name.trim().replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'singer-history'}.kd`
}

function getKdSingerDisplayName(singer: SingerHistoryKdSinger, index: number): string {
  return singer.singer?.displayName?.trim() || `Singer ${index + 1}`
}

function readJsonFile(file: File): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        resolve(JSON.parse(String(reader.result ?? '')))
      } catch (error) {
        reject(error)
      }
    }
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file'))
    reader.readAsText(file)
  })
}

function getInitialBreakColumns(): BreakColumnVisibility {
  if (typeof window === 'undefined') return DEFAULT_BREAK_COLUMNS
  try {
    const raw = window.localStorage.getItem(BREAK_COLUMNS_STORAGE_KEY)
    if (!raw) return DEFAULT_BREAK_COLUMNS
    const parsed = JSON.parse(raw)
    return {
      song: !!parsed?.song,
      artist: !!parsed?.artist,
      genre: !!parsed?.genre,
      length: !!parsed?.length,
      path: !!parsed?.path,
    }
  } catch {
    return DEFAULT_BREAK_COLUMNS
  }
}

function getInitialHostTopCollapsed(): boolean {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(HOST_TOP_COLLAPSED_STORAGE_KEY) === 'true'
}

export default function Host() {
  const auth = useAuth()
  const [queue, setQueue] = useState<Row[]>([])
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const [oidcConfig, setOidcConfig] = useState<OidcPublicConfig | null>(null)
  const [banner, setBanner] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [autoPlay, setAutoPlay] = useState(false)
  const [autoPlayDelay, setAutoPlayDelay] = useState(5)
  const [currentTime, setCurrentTime] = useState(0)
  const [actualDuration, setActualDuration] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [replacingId, setReplacingId] = useState<number | null>(null)
  const [replaceSearchMode, setReplaceSearchMode] = useState<'local' | 'karaoke-nerds' | 'url'>('local')
  const [replaceUrl, setReplaceUrl] = useState('')
  const [replaceTitle, setReplaceTitle] = useState('')
  const [replaceArtist, setReplaceArtist] = useState('')
  const [replaceDiscId, setReplaceDiscId] = useState('')
  const [draggedItem, setDraggedItem] = useState<Row | null>(null)
  const [dragOverPosition, setDragOverPosition] = useState<number | null>(null)
  const [overlayVisible, setOverlayVisible] = useState(true)
  const [overlayHeight, setOverlayHeight] = useState(90)
  const [qrSize, setQrSize] = useState(60)
  const [customMessage, setCustomMessage] = useState('')
  const [showRoller, setShowRoller] = useState(true)
  const [showQrCode, setShowQrCode] = useState(true)
  const [hideSingerQueue, setHideSingerQueue] = useState(false)
  const [keepRotationScrollerSingers, setKeepRotationScrollerSingers] = useState(false)
  const [showRequestsUrl, setShowRequestsUrl] = useState(true)
  const [showPlayerWindowControl, setShowPlayerWindowControl] = useState(false)
  const [showAccountManagement, setShowAccountManagement] = useState(false)
  const [hostTopCollapsed, setHostTopCollapsed] = useState(() => getInitialHostTopCollapsed())
  const [changingPassword, setChangingPassword] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [changingUsername, setChangingUsername] = useState(false)
  const [newUsername, setNewUsername] = useState('')
  const [usernamePassword, setUsernamePassword] = useState('')
  const [usernameError, setUsernameError] = useState('')

  // Manual request modal state
  const [showManualRequest, setShowManualRequest] = useState(false)
  const [manualRequestMode, setManualRequestMode] = useState<'local' | 'external' | 'url'>('local')
  const [manualRequestQuery, setManualRequestQuery] = useState('')
  const [manualRequestResults, setManualRequestResults] = useState<any[]>([])
  const [manualRequestName, setManualRequestName] = useState('')
  const [manualRequestUrl, setManualRequestUrl] = useState('')
  const [manualRequestTitle, setManualRequestTitle] = useState('')
  const [manualRequestArtist, setManualRequestArtist] = useState('')
  const [manualRequestDiscId, setManualRequestDiscId] = useState('')
  const [showManualSingerSuggestions, setShowManualSingerSuggestions] = useState(false)
  const [manualSingerHighlightIndex, setManualSingerHighlightIndex] = useState(0)

  // Library availability settings
  const [localLibraryEnabled, setLocalLibraryEnabled] = useState(true)
  const [externalLibraryEnabled, setExternalLibraryEnabled] = useState(true)

  // Download settings
  const [allowDownloads, setAllowDownloads] = useState(true)
  const [downloadingTrack, setDownloadingTrack] = useState<string | null>(null)
  const [breakMusicPaused, setBreakMusicPaused] = useState(false)
  const [breakMusicTrack, setBreakMusicTrack] = useState<BreakTrack | null>(null)
  const [breakMusicRemainingSec, setBreakMusicRemainingSec] = useState<number | null>(null)
  const [breakMusicCrossfadeSec, setBreakMusicCrossfadeSec] = useState(3)
  const [breakMusicVolumePercent, setBreakMusicVolumePercent] = useState(100)
  const [breakMusicResumeDelay, setBreakMusicResumeDelay] = useState(2)
  const [showBreakPlaylistModal, setShowBreakPlaylistModal] = useState(false)
  const [breakSearchQuery, setBreakSearchQuery] = useState('')
  const [breakLibraryTracks, setBreakLibraryTracks] = useState<BreakTrack[]>([])
  const [breakPlaylistTracks, setBreakPlaylistTracks] = useState<BreakTrack[]>([])
  const [breakPlaylistTrackIds, setBreakPlaylistTrackIds] = useState<number[]>([])
  const [breakDraggedTrackId, setBreakDraggedTrackId] = useState<number | null>(null)
  const [breakDraggedPlaylistIndex, setBreakDraggedPlaylistIndex] = useState<number | null>(null)
  const [breakColumns, setBreakColumns] = useState<BreakColumnVisibility>(() => getInitialBreakColumns())
  const [breakColumnWidths, setBreakColumnWidths] = useState<BreakColumnWidths>({
    song: 220,
    artist: 180,
    genre: 140,
    length: 96,
    path: 320,
  })
  const [breakPlaylists, setBreakPlaylists] = useState<BreakPlaylist[]>([])
  const [activeBreakPlaylistId, setActiveBreakPlaylistId] = useState<number | null>(null)
  const [selectedBreakPlaylistId, setSelectedBreakPlaylistId] = useState('')
  const [breakPlaylistIndex, setBreakPlaylistIndex] = useState(0)
  const [breakSort, setBreakSort] = useState<BreakSortState>({ column: 'artist', direction: 'asc' })
  const [showBreakColumnMenu, setShowBreakColumnMenu] = useState(false)
  const [breakLibraryPanePercent, setBreakLibraryPanePercent] = useState(62)

  // Rotation settings
  const [activeRotationId, setActiveRotationId] = useState<string | null>(null)
  const [rotationType, setRotationType] = useState<string>('strict_round_robin')
  const [savingRotationType, setSavingRotationType] = useState(false)
  const [showRotationInfo, setShowRotationInfo] = useState(false)

  // Nested singer queue state
  const [queueState, setQueueState] = useState<QueueState | null>(null)
  const [selectedSingerId, setSelectedSingerId] = useState<string | null>(null)
  const [selectedSingerHistory, setSelectedSingerHistory] = useState<SingerHistory | null>(null)
  const [singerModalOpen, setSingerModalOpen] = useState(false)
  const [singerModalLoading, setSingerModalLoading] = useState(false)
  const [renameSingerDialogOpen, setRenameSingerDialogOpen] = useState(false)
  const [editingSingerName, setEditingSingerName] = useState('')
  const [savingSingerName, setSavingSingerName] = useState(false)
  const [singerDraggedId, setSingerDraggedId] = useState<string | null>(null)
  const [singerDragOverId, setSingerDragOverId] = useState<string | null>(null)
  const [modalSongDraggedId, setModalSongDraggedId] = useState<number | null>(null)
  const [modalSongDragOverId, setModalSongDragOverId] = useState<number | null>(null)
  const [historyManagerOpen, setHistoryManagerOpen] = useState(false)
  const [historyManagerMode, setHistoryManagerMode] = useState<'menu' | 'export' | 'import'>('menu')
  const [historyExportSelectedSingerIds, setHistoryExportSelectedSingerIds] = useState<Set<string>>(new Set())
  const [pendingHistoryImportData, setPendingHistoryImportData] = useState<SingerHistoryKdFile | null>(null)
  const [historyImportSelectedIndexes, setHistoryImportSelectedIndexes] = useState<Set<number>>(new Set())
  // Merge singer state
  const [mergeSingerDialogOpen, setMergeSingerDialogOpen] = useState(false)
  const [mergeSingerQuery, setMergeSingerQuery] = useState('')
  const [mergeSingerError, setMergeSingerError] = useState('')
  const [mergingSinger, setMergingSinger] = useState(false)
  // Add song to queue from singer modal — delegates to showManualRequest with singer pre-filled
  const [manualRequestForSingerId, setManualRequestForSingerId] = useState<string | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const autoPlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const songTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const manualRequestSearchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoPlayDelayRef = useRef<number>(autoPlayDelay)
  const autoPlayEnabledRef = useRef<boolean>(autoPlay)
  const lastWebSocketUpdateRef = useRef<number>(0)
  const explicitStopRef = useRef<boolean>(false)
  const autoPlayScheduledRef = useRef<boolean>(false)
  const wsHeartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const durationSetForSongRef = useRef<boolean>(false)
  const breakPlaylistTracksRef = useRef<BreakTrack[]>([])
  const breakColumnMenuRef = useRef<HTMLDivElement | null>(null)
  const breakManagerLayoutRef = useRef<HTMLDivElement | null>(null)
  const breakPlaylistSyncRequestRef = useRef(0)
  const breakVolumeSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hostHistoryImportInputRef = useRef<HTMLInputElement | null>(null)

  const headers = useMemo(() => ({ 'x-session-token': auth.sessionToken, 'Content-Type': 'application/json' }), [auth.sessionToken])
  const manualSingerSuggestions = useMemo(() => {
    const normalizedQuery = manualRequestName.trim().toLocaleLowerCase()
    const seen = new Set<string>()

    return (queueState?.queueOrder ?? [])
      .map((singer) => ({
        singerId: singer.singerId,
        publicUuid: singer.publicUuid ?? null,
        displayName: singer.displayName.trim(),
      }))
      .filter((singer) => {
        const name = singer.displayName
        if (!name) return false
        const normalizedName = name.toLocaleLowerCase()
        if (seen.has(normalizedName)) return false
        seen.add(normalizedName)
        return !normalizedQuery || normalizedName.includes(normalizedQuery)
      })
      .sort((a, b) => {
        const aStarts = a.displayName.toLocaleLowerCase().startsWith(normalizedQuery)
        const bStarts = b.displayName.toLocaleLowerCase().startsWith(normalizedQuery)
        if (aStarts !== bStarts) return aStarts ? -1 : 1
        return a.displayName.localeCompare(b.displayName)
      })
      .slice(0, 8)
  }, [manualRequestName, queueState])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const oidcCode = params.get('oidc_code')
    const oidcError = params.get('oidc_error')

    if (oidcCode) {
      api('/api/auth/oidc/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: oidcCode })
      })
        .then((result) => {
          auth.setSessionToken(result.sessionToken)
          writeStoredSessionToken(result.sessionToken)
          auth.setIsLoggedIn(true)
          auth.setRole(result.role || 'user')
          auth.setProfile({
            username: result.username || '',
            displayName: result.displayName || '',
            picture: result.picture || ''
          })
          window.history.replaceState({}, '', window.location.pathname)
        })
        .catch((err) => {
          setLoginError(`SSO login failed: ${String(err?.message || 'Unable to complete login')}`)
          window.history.replaceState({}, '', window.location.pathname)
        })
    } else if (oidcError) {
      setLoginError(`SSO login failed: ${decodeURIComponent(oidcError)}`)
      window.history.replaceState({}, '', window.location.pathname)
    }

    document. documentElement.style.cssText = `
      --color-bg-primary: #0a0a0f;
      --color-bg-secondary: #16161d;
      --color-bg-card: #1d1d27;
      --color-bg-hover: #252533;
      --color-accent: #6366f1;
      --color-accent-hover: #7c7ff3;
      --color-success: #10b981;
      --color-warning: #f59e0b;
      --color-danger: #ef4444;
      --color-text-primary: #ffffff;
      --color-text-secondary: #a1a1aa;
      --color-text-muted: #71717a;
      --color-border: rgba(255, 255, 255, 0.08);
      --color-border-focus: rgba(99, 102, 241, 0.5);
    `;

    document.body.style.cssText = `
      background: linear-gradient(135deg, #0a0a0f 0%, #16161d 100%);
      color: #ffffff;
      margin: 0;
      padding: 0;
      min-height: 100vh;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    `;

    refreshQueue()
    refreshQueueState()
    api('/api/auth/oidc/config')
      .then((cfg) => setOidcConfig(cfg))
      .catch(() => {})

    return () => {
      document.documentElement.style.cssText = ''
      document.body.style.cssText = ''
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current)
      if (manualRequestSearchTimeoutRef.current) clearTimeout(manualRequestSearchTimeoutRef.current)
      if (breakVolumeSaveTimeoutRef.current) clearTimeout(breakVolumeSaveTimeoutRef.current)
    }
  }, [])

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoginError('')
    setBusy(true)

    try {
      const result = await api('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: loginUsername, password: loginPassword })
      })

      if (result.ok && result.sessionToken) {
        auth.setSessionToken(result.sessionToken)
        writeStoredSessionToken(result.sessionToken)
        auth.setIsLoggedIn(true)
        auth.setRole(result.role || 'user')
        setLoginPassword('')
        auth.setIsDefaultPassword(result.isDefaultPassword || false)
        auth.setProfile({
          username: result.username || '',
          displayName: result.displayName || '',
          picture: result.picture || ''
        })

        if (result.isDefaultPassword) {
          setBanner('⚠️ You are using the default password. Please change it in Account Settings.')
        }
      } else {
        setLoginError('Invalid password')
      }
    } catch (err) {
      setLoginError('Login failed.  Please try again.')
    } finally {
      setBusy(false)
    }
  }

  // Validate session on mount
  useEffect(() => {
    async function validateSession() {
      if (!auth.sessionToken) {
        auth.setIsLoggedIn(false)
        return
      }

      try {
        const result = await api('/api/auth/validate', {
          headers: { 'x-session-token': auth.sessionToken }
        })

        if (result.valid) {
          auth.setIsLoggedIn(true)
          auth.setRole(result.role || 'user')
          auth.setProfile({
            username: result.username || '',
            displayName: result.displayName || '',
            picture: result.picture || ''
          })
        } else {
          auth.setIsLoggedIn(false)
          auth.setSessionToken('')
          auth.clearProfile()
          clearStoredSessionToken()
        }
      } catch (err) {
        auth.setIsLoggedIn(false)
        auth.setSessionToken('')
        auth.clearProfile()
        clearStoredSessionToken()
      }
    }

    validateSession()
  }, [auth.sessionToken])

  useEffect(() => {
    const handleShowAccountManagement = () => {
      setShowAccountManagement(true)
    }
    window.addEventListener('showAccountManagement', handleShowAccountManagement)
    return () => {
      window.removeEventListener('showAccountManagement', handleShowAccountManagement)
    }
  }, [])

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault()
    setPasswordError('')

    if (newPassword !== confirmPassword) {
      setPasswordError('Passwords do not match')
      return
    }

    if (newPassword.length < 8) {
      setPasswordError('Password must be at least 8 characters long')
      return
    }

    setBusy(true)
    try {
      await api('/api/auth/change-password', {
        method: 'POST',
        headers,
        body: JSON.stringify({ currentPassword, newPassword })
      })

      setBanner('Password changed successfully')
      setChangingPassword(false)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setPasswordError('')
      auth.setIsDefaultPassword(false)
    } catch (err: any) {
      setPasswordError(err?.message || 'Failed to change password')
    } finally {
      setBusy(false)
    }
  }

  async function handleChangeUsername(e: React.FormEvent) {
    e.preventDefault()
    setUsernameError('')

    if (!newUsername.trim() || newUsername.trim().length < 3) {
      setUsernameError('Username must be at least 3 characters long')
      return
    }

    if (!usernamePassword) {
      setUsernameError('Please enter your current password to confirm')
      return
    }

    const trimmedUsername = newUsername.trim()

    setBusy(true)
    try {
      await api('/api/auth/change-username', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          newUsername: trimmedUsername,
          currentPassword: usernamePassword
        }),
      })

      setBanner('Username changed successfully')
      setChangingUsername(false)
      setNewUsername('')
      setUsernamePassword('')
      setUsernameError('')
      auth.setProfile({ username: trimmedUsername, displayName: trimmedUsername })
    } catch (err: any) {
      setUsernameError(err?.message || 'Failed to change username')
    } finally {
      setBusy(false)
    }
  }

  // Load library availability settings
  useEffect(() => {
    async function loadSettings() {
      // Only load settings if authenticated
      if (!auth.sessionToken || !auth.isLoggedIn) {
        return;
      }

      try {
        const settings = await api('/api/admin/settings', { headers });
        const localEnabled = parseBooleanSetting(settings['libraries.local_enabled']);
        const externalEnabled = parseBooleanSetting(settings['libraries.external_enabled']);
        const downloadsAllowed = parseBooleanSetting(settings['ytdlp.allow_downloads']);

        setLocalLibraryEnabled(localEnabled);
        setExternalLibraryEnabled(externalEnabled);
        setAllowDownloads(downloadsAllowed);

        // Switch to an enabled mode, preferring local
        if (localEnabled) {
          setReplaceSearchMode('local');
        } else if (externalEnabled) {
          setReplaceSearchMode('karaoke-nerds');
        }
        // If both are disabled, leave current mode (it won't be used anyway)
      } catch (err) {
        console.error('Failed to load settings:', err);
      }
    }

    loadSettings();
    loadBreakMusicState();
  }, [auth.sessionToken, auth.isLoggedIn, headers])

  async function loadBreakMusicState() {
    try {
      const state = await api('/api/break-music/state')
      const nextPlaylistIndex = Number(state.playlistIndex)
      setBreakMusicPaused(!!state.paused)
      setBreakMusicTrack(state.currentTrack || null)
      setBreakMusicRemainingSec(typeof state.remainingSec === 'number' ? state.remainingSec : null)
      setBreakPlaylistTrackIds(Array.isArray(state.playlistTrackIds) ? state.playlistTrackIds : [])
      setBreakPlaylistIndex(Number.isFinite(nextPlaylistIndex) ? nextPlaylistIndex : 0)
      if (typeof state.crossfadeSeconds === 'number') {
        setBreakMusicCrossfadeSec(state.crossfadeSeconds)
      }
      if (typeof state.volumePercent === 'number') {
        setBreakMusicVolumePercent(Math.max(0, Math.min(100, Math.round(state.volumePercent))))
      }
      if (typeof state.resumeDelaySec === 'number') {
        setBreakMusicResumeDelay(Math.max(0, Math.min(30, Math.round(state.resumeDelaySec))))
      }
      setBreakPlaylists(state.playlists || [])
      const nextActivePlaylistId = Number.isFinite(Number(state.activePlaylistId)) ? Number(state.activePlaylistId) : null
      setActiveBreakPlaylistId(nextActivePlaylistId)
      setSelectedBreakPlaylistId(nextActivePlaylistId != null ? String(nextActivePlaylistId) : '')
    } catch (err) {
      console.error('Failed to load break music state:', err)
    }
  }

  async function updateBreakCrossfade(seconds: number) {
    if (!auth.sessionToken || !auth.isLoggedIn) return
    await api('/api/break-music/settings', {
      method: 'POST',
      headers,
      body: JSON.stringify({ crossfadeSeconds: seconds }),
    })
  }

  async function updateBreakVolume(volumePercent: number) {
    if (!auth.sessionToken || !auth.isLoggedIn) return
    await api('/api/break-music/settings', {
      method: 'POST',
      headers,
      body: JSON.stringify({ volumePercent }),
    })
  }

  async function updateBreakResumeDelay(resumeDelaySec: number) {
    if (!auth.sessionToken || !auth.isLoggedIn) return
    await api('/api/break-music/settings', {
      method: 'POST',
      headers,
      body: JSON.stringify({ resumeDelaySec }),
    })
  }

  function scheduleBreakVolumeUpdate(volumePercent: number) {
    if (breakVolumeSaveTimeoutRef.current) {
      clearTimeout(breakVolumeSaveTimeoutRef.current)
    }
    breakVolumeSaveTimeoutRef.current = setTimeout(() => {
      void updateBreakVolume(volumePercent)
      breakVolumeSaveTimeoutRef.current = null
    }, 160)
  }

  async function controlBreakMusic(action: 'pause' | 'resume' | 'skip' | 'previous') {
    if (!auth.sessionToken || !auth.isLoggedIn) return
    await api('/api/break-music/control', {
      method: 'POST',
      headers,
      body: JSON.stringify({ action }),
    })
    await loadBreakMusicState()
  }

  async function loadBreakMusicLibrary(query: string = '') {
    if (!auth.sessionToken || !auth.isLoggedIn) {
      console.warn('Cannot load break music library without authentication')
      return [] as BreakTrack[]
    }
    try {
      const result = await api(`/api/break-music/search?q=${encodeURIComponent(query)}`, { headers })
      const tracks = Array.isArray(result) ? result : []
      setBreakLibraryTracks(tracks)
      return tracks
    } catch {
      setBreakLibraryTracks([])
      return []
    }
  }

  async function openBreakMusicManager() {
    setShowBreakPlaylistModal(true)
    const tracks = await loadBreakMusicLibrary('')
    const byId = new Map<number, BreakTrack>(tracks.map((t: BreakTrack) => [t.id, t]))
    const next = breakPlaylistTrackIds
      .map((id) => byId.get(id))
      .filter((v): v is BreakTrack => !!v)
    setBreakPlaylistTracks(next)
    breakPlaylistTracksRef.current = next
  }

  async function refreshBreakMusicManager() {
    const tracks = await loadBreakMusicLibrary('')
    const byId = new Map<number, BreakTrack>(tracks.map((t: BreakTrack) => [t.id, t]))
    const next = breakPlaylistTracksRef.current.map((t) => byId.get(t.id) || t)
    setBreakPlaylistTracks(next)
    breakPlaylistTracksRef.current = next
  }

  async function saveBreakPlaylist() {
    if (!auth.sessionToken || !auth.isLoggedIn) return
    if (breakPlaylistTracks.length === 0) return
    const existingName = breakPlaylists.find((playlist) => String(playlist.id) === selectedBreakPlaylistId)?.name || ''
    const enteredName = window.prompt('Save playlist as:', existingName)
    if (enteredName === null) return
    const name = enteredName.trim()
    if (!name) {
      window.alert('Playlist name is required.')
      return
    }
    const result = await api('/api/break-music/playlists', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name,
        trackIds: breakPlaylistTracks.map((t) => t.id),
      }),
    })
    await loadBreakMusicState()
    if (result?.playlistId) {
      setSelectedBreakPlaylistId(String(result.playlistId))
    }
  }

  async function loadBreakPlaylist(playlistId: number) {
    if (!auth.sessionToken || !auth.isLoggedIn) return
    await api('/api/break-music/playlists/load', {
      method: 'POST',
      headers,
      body: JSON.stringify({ playlistId }),
    })
    setSelectedBreakPlaylistId(String(playlistId))
    await loadBreakMusicState()
    await refreshBreakMusicManager()
  }

  async function syncBreakActivePlaylist(nextTracks: BreakTrack[]) {
    if (!auth.sessionToken || !auth.isLoggedIn) return
    const requestId = ++breakPlaylistSyncRequestRef.current
    try {
      const result = await api('/api/break-music/playlist/active', {
        method: 'POST',
        headers,
        body: JSON.stringify({ trackIds: nextTracks.map((t) => t.id) }),
      })
      if (requestId !== breakPlaylistSyncRequestRef.current) return
      const nextPlaylistIndex = Number(result?.playlistIndex)
      setBreakPlaylistTrackIds(Array.isArray(result?.trackIds) ? result.trackIds : [])
      setBreakPlaylistIndex(Number.isFinite(nextPlaylistIndex) ? nextPlaylistIndex : 0)
      setBreakMusicTrack(result?.currentTrack || null)
      await loadBreakMusicState()
    } catch (err) {
      console.error('Failed to sync active break playlist:', err)
      if (requestId === breakPlaylistSyncRequestRef.current) {
        setBanner('⚠️ Failed to update active break playlist')
        setTimeout(() => setBanner(''), 4000)
      }
    }
  }

  function setBreakPlaylistTracksAndSync(nextTracks: BreakTrack[]) {
    setBreakPlaylistTracks(nextTracks)
    breakPlaylistTracksRef.current = nextTracks
    void syncBreakActivePlaylist(nextTracks)
  }

  function addBreakTrackToPlaylist(track: BreakTrack) {
    const playlist = breakPlaylistTracksRef.current
    const hasIndexedCurrentTrack =
      breakMusicTrack != null &&
      breakPlaylistIndex >= 0 &&
      breakPlaylistIndex < playlist.length &&
      playlist[breakPlaylistIndex]?.id === breakMusicTrack.id
    const insertAt = hasIndexedCurrentTrack ? breakPlaylistIndex + 1 : playlist.length
    const next = [...playlist]
    next.splice(insertAt, 0, track)
    setBreakPlaylistTracksAndSync(next)
  }

  function removeBreakTrackFromPlaylist(index: number) {
    const playlist = breakPlaylistTracksRef.current
    if (index < 0 || index >= playlist.length) return
    const next = playlist.filter((_, i) => i !== index)
    setBreakPlaylistTracksAndSync(next)
  }

  function clearBreakPlaylist() {
    setBreakPlaylistTracksAndSync([])
  }

  function addAllBreakTracksToPlaylist() {
    const toAdd = sortedFilteredBreakLibraryTracks
    if (toAdd.length === 0) return
    const playlist = breakPlaylistTracksRef.current
    const existingIds = new Set(playlist.map((t) => t.id))
    const newTracks = toAdd.filter((t) => !existingIds.has(t.id))
    if (newTracks.length === 0) return
    const hasIndexedCurrentTrack =
      breakMusicTrack != null &&
      breakPlaylistIndex >= 0 &&
      breakPlaylistIndex < playlist.length &&
      playlist[breakPlaylistIndex]?.id === breakMusicTrack.id
    const insertAt = hasIndexedCurrentTrack ? breakPlaylistIndex + 1 : playlist.length
    const next = [...playlist]
    next.splice(insertAt, 0, ...newTracks)
    setBreakPlaylistTracksAndSync(next)
  }

  function shuffleBreakPlaylist() {
    const playlist = [...breakPlaylistTracksRef.current]
    if (playlist.length < 2) return
    for (let i = playlist.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [playlist[i], playlist[j]] = [playlist[j], playlist[i]]
    }
    // Pin the currently playing track at position 0 so that after it finishes,
    // playback continues through the full new shuffled order from the beginning.
    if (breakMusicTrack) {
      const currentIdx = playlist.findIndex((t) => t.id === breakMusicTrack.id)
      if (currentIdx > 0) {
        const [current] = playlist.splice(currentIdx, 1)
        playlist.unshift(current)
      }
    }
    setBreakPlaylistTracksAndSync(playlist)
  }

  function moveBreakTrackInPlaylist(index: number, direction: -1 | 1) {
    const playlist = breakPlaylistTracksRef.current
    const target = index + direction
    if (target < 0 || target >= playlist.length) return
    const next = [...playlist]
    const [item] = next.splice(index, 1)
    next.splice(target, 0, item)
    setBreakPlaylistTracksAndSync(next)
  }

  function moveBreakTrackToPlaylistIndex(fromIndex: number, targetIndex: number) {
    const playlist = breakPlaylistTracksRef.current
    if (
      fromIndex < 0 ||
      fromIndex >= playlist.length ||
      targetIndex < 0 ||
      targetIndex >= playlist.length ||
      fromIndex === targetIndex
    ) {
      return
    }
    const next = [...playlist]
    const [item] = next.splice(fromIndex, 1)
    next.splice(targetIndex, 0, item)
    setBreakPlaylistTracksAndSync(next)
  }

  const filteredBreakLibraryTracks = useMemo(() => {
    const q = breakSearchQuery.trim().toLowerCase()
    if (!q) return breakLibraryTracks
    return breakLibraryTracks.filter((track) => {
      const hay = [
        track.title || '',
        track.artist || '',
        track.genre || '',
        track.file_path || '',
      ].join(' ').toLowerCase()
      return hay.includes(q)
    })
  }, [breakLibraryTracks, breakSearchQuery])

  const breakPlaylistDurationMs = useMemo(
    () => breakPlaylistTracks.reduce((acc, t) => acc + (t.duration_ms || 0), 0),
    [breakPlaylistTracks]
  )

  const currentBreakPlaylistRowIndex = useMemo(() => {
    if (!breakMusicTrack) return -1
    const indexedTrackId = breakPlaylistTracks[breakPlaylistIndex]?.id
    if (indexedTrackId === breakMusicTrack.id) return breakPlaylistIndex
    return breakPlaylistTracks.findIndex((item) => item.id === breakMusicTrack.id)
  }, [breakMusicTrack, breakPlaylistTracks, breakPlaylistIndex])

  const activeBreakPlaylistName = useMemo(() => {
    if (activeBreakPlaylistId == null) return ''
    return breakPlaylists.find((playlist) => playlist.id === activeBreakPlaylistId)?.name || ''
  }, [activeBreakPlaylistId, breakPlaylists])

  useEffect(() => {
    if (!showBreakPlaylistModal || breakLibraryTracks.length === 0) return
    const byId = new Map<number, BreakTrack>(breakLibraryTracks.map((t) => [t.id, t]))
    const next = breakPlaylistTrackIds
      .map((id) => byId.get(id))
      .filter((v): v is BreakTrack => !!v)
    setBreakPlaylistTracks(next)
    breakPlaylistTracksRef.current = next
  }, [showBreakPlaylistModal, breakPlaylistTrackIds, breakLibraryTracks])

  useEffect(() => {
    if (!showBreakColumnMenu) return
    const onPointerDown = (event: MouseEvent) => {
      if (!breakColumnMenuRef.current?.contains(event.target as Node)) {
        setShowBreakColumnMenu(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [showBreakColumnMenu])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(BREAK_COLUMNS_STORAGE_KEY, JSON.stringify(breakColumns))
  }, [breakColumns])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(HOST_TOP_COLLAPSED_STORAGE_KEY, String(hostTopCollapsed))
  }, [hostTopCollapsed])

  function formatDurationMs(ms: number | null | undefined) {
    if (!ms || ms <= 0) return '—'
    return formatTime(Math.floor(ms / 1000))
  }

  function toggleBreakColumn(column: BreakColumnKey) {
    setBreakColumns((prev) => ({ ...prev, [column]: !prev[column] }))
  }

  function breakColumnEnabled(column: BreakColumnKey) {
    return !!breakColumns[column]
  }

  function updateBreakColumnWidth(column: BreakColumnKey, width: number) {
    setBreakColumnWidths((prev) => ({ ...prev, [column]: width }))
  }

  function getBreakColumnLimits(column: BreakColumnKey) {
    if (column === 'length') return { min: 72, max: 180 }
    if (column === 'path') return { min: 180, max: 640 }
    return { min: 100, max: 420 }
  }

  function startBreakColumnResize(column: BreakColumnKey, event: React.MouseEvent<HTMLDivElement>) {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startWidth = breakColumnWidths[column]
    const { min, max } = getBreakColumnLimits(column)
    const onMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX
      const width = Math.min(max, Math.max(min, startWidth + delta))
      updateBreakColumnWidth(column, width)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function toggleBreakSort(column: BreakColumnKey) {
    setBreakSort((prev) => {
      if (prev.column === column) {
        return { column, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
      }
      return { column, direction: 'asc' }
    })
  }

  const sortedFilteredBreakLibraryTracks = useMemo(() => {
    const tracks = [...filteredBreakLibraryTracks]
    const directionMultiplier = breakSort.direction === 'asc' ? 1 : -1
    const compareText = (a: string | null | undefined, b: string | null | undefined) =>
      (a || '').localeCompare(b || '', undefined, { sensitivity: 'base' })
    tracks.sort((a, b) => {
      let result = 0
      if (breakSort.column === 'song') result = compareText(a.title, b.title)
      else if (breakSort.column === 'artist') result = compareText(a.artist, b.artist) || compareText(a.title, b.title)
      else if (breakSort.column === 'genre') result = compareText(a.genre, b.genre) || compareText(a.title, b.title)
      else if (breakSort.column === 'length') result = (a.duration_ms || 0) - (b.duration_ms || 0)
      else if (breakSort.column === 'path') result = compareText(a.file_path, b.file_path)
      return result * directionMultiplier
    })
    return tracks
  }, [filteredBreakLibraryTracks, breakSort])

  function buildBreakGridTemplate() {
    const cols: string[] = []
    cols.push('48px')
    if (breakColumnEnabled('song')) cols.push(`minmax(140px, ${breakColumnWidths.song}px)`)
    if (breakColumnEnabled('artist')) cols.push(`minmax(120px, ${breakColumnWidths.artist}px)`)
    if (breakColumnEnabled('genre')) cols.push(`minmax(100px, ${breakColumnWidths.genre}px)`)
    if (breakColumnEnabled('length')) cols.push(`${breakColumnWidths.length}px`)
    if (breakColumnEnabled('path')) cols.push(`minmax(180px, ${breakColumnWidths.path}px)`)
    return cols.join(' ')
  }

  function canDropOnBreakPlaylist(ev: React.DragEvent<HTMLDivElement>) {
    return ev.dataTransfer.types?.includes('text/plain') || breakDraggedTrackId !== null || breakDraggedPlaylistIndex !== null
  }

  function getBreakDraggedTrackId(ev: React.DragEvent<HTMLDivElement>) {
    const raw = ev.dataTransfer.getData('text/plain')
    const parsed = Number(raw)
    if (Number.isFinite(parsed)) return parsed
    return breakDraggedTrackId
  }

  function startBreakPaneResize(event: React.MouseEvent<HTMLDivElement>) {
    event.preventDefault()
    const layout = breakManagerLayoutRef.current
    if (!layout) return
    const bounds = layout.getBoundingClientRect()
    const onMove = (moveEvent: MouseEvent) => {
      const relative = ((moveEvent.clientX - bounds.left) / bounds.width) * 100
      const clamped = Math.max(35, Math.min(80, relative))
      setBreakLibraryPanePercent(clamped)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function closeBreakMusicManager() {
    setShowBreakColumnMenu(false)
    setShowBreakPlaylistModal(false)
  }

  // Update refs when state changes
  useEffect(() => {
    autoPlayDelayRef.current = autoPlayDelay
  }, [autoPlayDelay])

  useEffect(() => {
    autoPlayEnabledRef.current = autoPlay
    if (autoPlay) {
      explicitStopRef.current = false
    }
  }, [autoPlay])

  async function updateAutoPlaySettings(enabled: boolean, delay: number) {
    if (! auth.sessionToken || ! auth.isLoggedIn) return
    try {
      await api('/api/autoplay/settings', {
        method: 'POST',
        headers,
        body: JSON.stringify({ enabled, delay })
      })
    } catch (err) {
      console.error('Failed to update autoplay settings:', err)
    }
  }

  async function refreshQueue() {
    const q = await api('/api/queue')
    setQueue(q || [])
  }

  async function refreshQueueState() {
    try {
      const state = await api('/api/queue/state')
      setQueueState(state || null)
    } catch (err) {
      console.error('Failed to load queue state:', err)
    }
  }

  async function openSingerModal(singerId: string) {
    setSelectedSingerId(singerId)
    setSingerModalOpen(true)
    setSingerModalLoading(true)
    setSelectedSingerHistory(null)
    try {
      const history = await api(`/api/singers/${singerId}/history`, { headers })
      setSelectedSingerHistory(history || null)
      setEditingSingerName(history?.singer?.displayName || '')
    } catch (err) {
      console.error('Failed to load singer history:', err)
    } finally {
      setSingerModalLoading(false)
    }
  }

  function closeSingerModal() {
    setSingerModalOpen(false)
    setRenameSingerDialogOpen(false)
    setSelectedSingerId(null)
    setSelectedSingerHistory(null)
    setEditingSingerName('')
  }

  function openHistoryManager() {
    setHistoryManagerOpen(true)
    setHistoryManagerMode('menu')
    setHistoryExportSelectedSingerIds(new Set((queueState?.queueOrder ?? []).map((singer) => singer.singerId)))
    setPendingHistoryImportData(null)
    setHistoryImportSelectedIndexes(new Set())
  }

  function closeHistoryManager() {
    setHistoryManagerOpen(false)
    setHistoryManagerMode('menu')
    setPendingHistoryImportData(null)
    setHistoryImportSelectedIndexes(new Set())
    if (hostHistoryImportInputRef.current) hostHistoryImportInputRef.current.value = ''
  }

  async function exportAllSingerHistory() {
    if (!auth.sessionToken || !auth.isLoggedIn) return
    try {
      const data = await api('/api/history/export-all', { headers })
      downloadJsonFile(`karaokedock-singer-history-${new Date().toISOString().slice(0, 10)}.kd`, data)
      setBanner('✔ All singer history exported')
      setTimeout(() => setBanner(''), 4000)
      closeHistoryManager()
    } catch (err) {
      console.error('Failed to export all singer history:', err)
      setBanner('⚠️ Could not export singer history')
      setTimeout(() => setBanner(''), 5000)
    }
  }

  async function exportSelectedSingerHistory() {
    if (!auth.sessionToken || !auth.isLoggedIn) return
    const singerIds = Array.from(historyExportSelectedSingerIds)
    if (singerIds.length === 0) {
      setBanner('⚠️ Select at least one singer to export')
      setTimeout(() => setBanner(''), 4000)
      return
    }
    try {
      const data = await api('/api/history/export', {
        method: 'POST',
        headers,
        body: JSON.stringify({ singerIds }),
      })
      const filename = singerIds.length === 1
        ? safeHistoryFilename((queueState?.queueOrder ?? []).find((singer) => singer.singerId === singerIds[0])?.displayName || 'singer-history')
        : `karaokedock-selected-singer-history-${new Date().toISOString().slice(0, 10)}.kd`
      downloadJsonFile(filename, data)
      setBanner(`✔ Exported ${singerIds.length} singer${singerIds.length === 1 ? '' : 's'}`)
      setTimeout(() => setBanner(''), 4000)
      closeHistoryManager()
    } catch (err) {
      console.error('Failed to export singer history:', err)
      setBanner('⚠️ Could not export singer history')
      setTimeout(() => setBanner(''), 5000)
    }
  }

  async function loadHistoryImportFile(file: File | null | undefined) {
    if (!file) return
    try {
      const data = await readJsonFile(file) as SingerHistoryKdFile
      const singers = Array.isArray(data?.singers) ? data.singers : []
      setPendingHistoryImportData(data)
      setHistoryImportSelectedIndexes(new Set(singers.map((_: unknown, index: number) => index)))
    } catch (err) {
      console.error('Failed to read singer history file:', err)
      setBanner('⚠️ Could not read .kd file')
      setTimeout(() => setBanner(''), 5000)
      if (hostHistoryImportInputRef.current) hostHistoryImportInputRef.current.value = ''
    }
  }

  async function importPendingHostSingerHistory(importAll: boolean) {
    if (!auth.sessionToken || !auth.isLoggedIn || !pendingHistoryImportData) return
    const sourceSingers = Array.isArray(pendingHistoryImportData.singers) ? pendingHistoryImportData.singers : []
    const selectedSingers = sourceSingers.filter((_: unknown, index: number) => historyImportSelectedIndexes.has(index))
    const data = importAll
      ? pendingHistoryImportData
      : { ...pendingHistoryImportData, singers: selectedSingers }
    if (!importAll && selectedSingers.length === 0) {
      setBanner('⚠️ Select at least one singer to import')
      setTimeout(() => setBanner(''), 4000)
      return
    }
    try {
      const result = await api('/api/history/import', {
        method: 'POST',
        headers,
        body: JSON.stringify({ data }),
      })
      await refreshQueueState()
      if (selectedSingerId) {
        const history = await api(`/api/singers/${selectedSingerId}/history`, { headers })
        setSelectedSingerHistory(history || null)
      }
      setBanner(`✔ Imported ${Number(result.imported ?? 0)} history song${Number(result.imported ?? 0) === 1 ? '' : 's'}`)
      setTimeout(() => setBanner(''), 4000)
      closeHistoryManager()
    } catch (err) {
      console.error('Failed to import singer history:', err)
      setBanner('⚠️ Could not import singer history')
      setTimeout(() => setBanner(''), 5000)
    } finally {
      if (hostHistoryImportInputRef.current) hostHistoryImportInputRef.current.value = ''
    }
  }

  function openRenameSingerDialog() {
    if (!selectedSingerHistory) return
    setEditingSingerName(selectedSingerHistory.singer.displayName)
    setRenameSingerDialogOpen(true)
  }

  function closeRenameSingerDialog() {
    setRenameSingerDialogOpen(false)
    setEditingSingerName(selectedSingerHistory?.singer.displayName ?? '')
  }

  async function renameSingerFromModal() {
    if (!auth.sessionToken || !auth.isLoggedIn || !selectedSingerId) return
    const nextName = editingSingerName.trim()
    if (!nextName) {
      setBanner('⚠️ Singer name is required')
      setTimeout(() => setBanner(''), 4000)
      return
    }
    setSavingSingerName(true)
    try {
      await api(`/api/singers/${selectedSingerId}/rename`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ displayName: nextName }),
      })
      await refreshQueueState()
      const history = await api(`/api/singers/${selectedSingerId}/history`, { headers })
      setSelectedSingerHistory(history || null)
      setEditingSingerName(history?.singer?.displayName || nextName)
      setRenameSingerDialogOpen(false)
      setBanner(`✔ Singer renamed to ${nextName}`)
      setTimeout(() => setBanner(''), 4000)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to rename singer'
      setBanner(`⚠️ ${message}`)
      setTimeout(() => setBanner(''), 5000)
    } finally {
      setSavingSingerName(false)
    }
  }

  async function handleModalSongDrop(targetQueueId: number) {
    setModalSongDragOverId(null)
    if (!modalSongDraggedId || modalSongDraggedId === targetQueueId || !selectedSingerId) {
      setModalSongDraggedId(null)
      return
    }
    if (!auth.sessionToken || !auth.isLoggedIn || !selectedSingerHistory) {
      setModalSongDraggedId(null)
      return
    }
    const songs = selectedSingerHistory.queuedSongs.filter(s => s.status === 'queued')
    const fromIdx = songs.findIndex(s => s.queueId === modalSongDraggedId)
    const toIdx = songs.findIndex(s => s.queueId === targetQueueId)
    if (fromIdx < 0 || toIdx < 0) { setModalSongDraggedId(null); return }
    const reordered = [...songs]
    const [moved] = reordered.splice(fromIdx, 1)
    reordered.splice(toIdx, 0, moved)
    try {
      await api(`/api/singers/${selectedSingerId}/song-order`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ queueIds: reordered.map(s => s.queueId) }),
      })
      await refreshQueueState()
      const history = await api(`/api/singers/${selectedSingerId}/history`, { headers })
      setSelectedSingerHistory(history || null)
    } catch (err) {
      console.error('Failed to reorder singer queue:', err)
    } finally {
      setModalSongDraggedId(null)
    }
  }

  async function handleModalSongMoveInQueue(queueId: number, direction: 'up' | 'down') {
    if (!selectedSingerHistory || !selectedSingerId) return
    if (!auth.sessionToken || !auth.isLoggedIn) return
    const songs = selectedSingerHistory.queuedSongs.filter(s => s.status === 'queued')
    const idx = songs.findIndex(s => s.queueId === queueId)
    if (idx < 0) return
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1
    if (targetIdx < 0 || targetIdx >= songs.length) return
    const reordered = [...songs]
    ;[reordered[idx], reordered[targetIdx]] = [reordered[targetIdx], reordered[idx]]
    try {
      await api(`/api/singers/${selectedSingerId}/song-order`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ queueIds: reordered.map(s => s.queueId) }),
      })
      await refreshQueueState()
      const history = await api(`/api/singers/${selectedSingerId}/history`, { headers })
      setSelectedSingerHistory(history || null)
    } catch (err) {
      console.error('Failed to reorder singer queue:', err)
    }
  }

  async function restoreSongToQueue(queueId: number) {
    if (!auth.sessionToken || !auth.isLoggedIn) return
    setBusy(true)
    try {
      await api(`/api/queue/${queueId}/status`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ status: 'queued' }),
      })
      await refreshQueueState()
      // Reload singer history if a modal is open
      if (selectedSingerId) {
        const history = await api(`/api/singers/${selectedSingerId}/history`, { headers })
        setSelectedSingerHistory(history || null)
      }
    } catch (err) {
      console.error('Failed to restore song to queue:', err)
    } finally {
      setBusy(false)
    }
  }

  async function removeSongFromQueue(queueId: number) {
    if (!auth.sessionToken || !auth.isLoggedIn) return
    setBusy(true)
    try {
      await api(`/api/queue/${queueId}/status`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ status: 'removed' }),
      })
      await refreshQueueState()
      // Reload singer history if a modal is open
      if (selectedSingerId) {
        const history = await api(`/api/singers/${selectedSingerId}/history`, { headers })
        setSelectedSingerHistory(history || null)
      }
    } catch (err) {
      console.error('Failed to remove song from queue:', err)
    } finally {
      setBusy(false)
    }
  }

  async function deleteSongFromHistory(queueId: number) {
    if (!auth.sessionToken || !auth.isLoggedIn) return
    if (!confirm('Remove this track from singer history?')) return
    setBusy(true)
    try {
      await api('/api/queue/delete', {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: queueId }),
      })
      await refreshQueueState()
      if (selectedSingerId) {
        const history = await api(`/api/singers/${selectedSingerId}/history`, { headers })
        setSelectedSingerHistory(history || null)
      }
    } catch (err) {
      console.error('Failed to delete history song:', err)
    } finally {
      setBusy(false)
    }
  }

  async function mergeSingerIntoTarget() {
    if (!auth.sessionToken || !auth.isLoggedIn || !selectedSingerId) return
    const sourceName = mergeSingerQuery.trim()
    if (!sourceName) { setMergeSingerError('Enter a singer name to merge'); return }
    // Find singer id by name
    const allSingers = queueState?.queueOrder ?? []
    const matchedSinger =
      allSingers.find(s => s.displayName.toLowerCase() === sourceName.toLowerCase() && s.singerId !== selectedSingerId) ??
      allSingers.find(s => s.displayName.toLowerCase() === sourceName.toLowerCase())
    if (!matchedSinger) { setMergeSingerError(`Singer "${sourceName}" not found`); return }
    if (matchedSinger.singerId === selectedSingerId) { setMergeSingerError('Cannot merge a singer with themselves'); return }
    setMergingSinger(true)
    setMergeSingerError('')
    try {
      await api(`/api/singers/${selectedSingerId}/merge`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ sourceId: Number(matchedSinger.singerId) }),
      })
      setMergeSingerDialogOpen(false)
      setMergeSingerQuery('')
      await refreshQueueState()
      const history = await api(`/api/singers/${selectedSingerId}/history`, { headers })
      setSelectedSingerHistory(history || null)
      setBanner(`✔ Merged "${sourceName}" into this singer`)
      setTimeout(() => setBanner(''), 4000)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Merge failed'
      setMergeSingerError(msg)
    } finally {
      setMergingSinger(false)
    }
  }

  async function searchSongsForSinger(q: string) {
    // No longer used — singer add-song uses the manual request modal
  }

  async function addSongForSinger(_trackId: number) {
    // No longer used
  }

  async function moveSinger(singerId: string, direction: 'up' | 'down') {
    if (!auth.sessionToken || !auth.isLoggedIn || !queueState?.activeRotation) return
    const rotationId = queueState.activeRotation.id
    const singers = queueState.queueOrder
    const idx = singers.findIndex(s => s.singerId === singerId)
    if (idx < 0) return
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1
    if (targetIdx < 0 || targetIdx >= singers.length) return
    // Swap positions
    const currentPos = singers[idx].rotationPosition ?? idx + 1
    const targetPos = singers[targetIdx].rotationPosition ?? targetIdx + 1
    try {
      await api(`/api/rotations/${rotationId}/singers/${singerId}/position`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ position: targetPos }),
      })
      await api(`/api/rotations/${rotationId}/singers/${singers[targetIdx].singerId}/position`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ position: currentPos }),
      })
      await refreshQueueState()
    } catch (err) {
      console.error('Failed to move singer:', err)
    }
  }

  function handleSingerDragStart(singerId: string) {
    setSingerDraggedId(singerId)
  }

  function handleSingerDragEnd() {
    setSingerDraggedId(null)
    setSingerDragOverId(null)
  }

  function handleSingerDragOver(e: React.DragEvent, singerId: string) {
    e.preventDefault()
    setSingerDragOverId(singerId)
  }

  async function handleSingerDrop(e: React.DragEvent, targetSingerId: string) {
    e.preventDefault()
    setSingerDragOverId(null)
    if (!singerDraggedId || singerDraggedId === targetSingerId) {
      setSingerDraggedId(null)
      return
    }
    if (!auth.sessionToken || !auth.isLoggedIn || !queueState?.activeRotation) {
      setSingerDraggedId(null)
      return
    }
    const rotationId = queueState.activeRotation.id
    const singers = [...queueState.queueOrder].sort((a, b) => {
      const aIsSinging = a.queuedSongs.some(q => q.status === 'playing')
      const bIsSinging = b.queuedSongs.some(q => q.status === 'playing')
      if (aIsSinging && !bIsSinging) return -1
      if (!aIsSinging && bIsSinging) return 1
      return 0
    })
    const fromIdx = singers.findIndex(s => s.singerId === singerDraggedId)
    const toIdx = singers.findIndex(s => s.singerId === targetSingerId)
    if (fromIdx < 0 || toIdx < 0) {
      setSingerDraggedId(null)
      return
    }
    // Build new order
    const reordered = [...singers]
    const [moved] = reordered.splice(fromIdx, 1)
    reordered.splice(toIdx, 0, moved)
    try {
      await api(`/api/rotations/${rotationId}/singers/reorder`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ orderedSingerIds: reordered.map(s => s.singerId) }),
      })
      await refreshQueueState()
    } catch (err) {
      console.error('Failed to reorder singers:', err)
    } finally {
      setSingerDraggedId(null)
    }
  }

  function formatTimeAgo(dateStr: string | null): string {
    if (!dateStr) return 'Never'
    const d = new Date(dateStr)
    const diff = Date.now() - d.getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return 'Just now'
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return d.toLocaleDateString()
  }

  function formatRequestedAt(dateStr: string | null | undefined): string | null {
    if (!dateStr) return null
    const d = new Date(dateStr)
    if (Number.isNaN(d.getTime())) return null
    const time = d
      .toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      })
      .replace(/\s+/g, '')
      .toLowerCase()
    const date = d.toLocaleDateString(undefined, {
      month: 'numeric',
      day: 'numeric',
      year: '2-digit',
    })
    return `${time} ${date}`
  }

  function renderDiscIdTag(discId: string | null | undefined) {
    if (!discId) return null
    return (
      <span style={{
        marginLeft: 8,
        fontSize: 11,
        padding: '1px 6px',
        background: 'var(--color-bg-primary)',
        border: '1px solid var(--color-border)',
        borderRadius: 4,
        color: 'var(--color-text-secondary)',
        whiteSpace: 'nowrap',
      }}>
        {discId}
      </span>
    )
  }

  function closeReplaceModal() {
    setReplacingId(null)
    setSearchQuery('')
    setSearchResults([])
    setReplaceUrl('')
    setReplaceTitle('')
    setReplaceArtist('')
    setReplaceDiscId('')
    setReplaceSearchMode('local')
  }

  function openReplaceSong(song: { queueId?: number; id?: number; title?: string | null; artist?: string | null }) {
    const queueId = song.queueId ?? song.id
    if (queueId == null) return
    setReplacingId(queueId)
    setSearchQuery(song.title || '')
    setSearchResults([])
    setReplaceUrl('')
    setReplaceTitle(song.title || '')
    setReplaceArtist(song.artist || '')
    setReplaceDiscId('')
    setReplaceSearchMode('local')
  }

  function renderReplaceButton(song: { queueId?: number; id?: number; title?: string | null; artist?: string | null }, label = 'Replace song') {
    return (
      <button
        className="control-btn"
        type="button"
        title={label}
        aria-label={label}
        disabled={busy}
        onClick={() => openReplaceSong(song)}
        style={{ padding: '6px 10px', fontSize: 13, lineHeight: 1 }}
      >
        <span className="material-symbols-rounded" style={{ fontSize: 18, display: 'block' }}>
          contract_edit
        </span>
      </button>
    )
  }

  function canReplaceQueueSong(song: { status?: string | null }) {
    return song.status === 'queued' || song.status === 'playing'
  }

  async function refreshQueueViews() {
    await refreshQueue()
    await refreshQueueState()
    if (selectedSingerId) {
      try {
        const history = await api(`/api/singers/${selectedSingerId}/history`, { headers })
        setSelectedSingerHistory(history || null)
      } catch (err) {
        console.error('Failed to reload singer history:', err)
      }
    }
  }


  useEffect(() => {
    api('/api/autoplay/settings')
      .then((settings: { enabled: boolean; delay: number }) => {
        setAutoPlay(settings.enabled)
        setAutoPlayDelay(settings.delay)
      })
      .catch(() => {})
  }, [])

  // Fetch initial overlay settings
  useEffect(() => {
    api('/api/overlay/settings')
      .then((settings: { visible: boolean; height: number; qrSize: number; customMessage: string; showRoller: boolean; showQrCode: boolean; hideSingerQueue: boolean; keepRotationScrollerSingers: boolean; showRequestsUrl: boolean }) => {
        setOverlayVisible(settings.visible)
        setOverlayHeight(settings.height)
        setQrSize(settings.qrSize)
        setCustomMessage(settings.customMessage || '')
        setShowRoller(settings.showRoller ?? true)
        setShowQrCode(settings.showQrCode ?? true)
        setHideSingerQueue(settings.hideSingerQueue ?? false)
        setKeepRotationScrollerSingers(settings.keepRotationScrollerSingers ?? false)
        setShowRequestsUrl(settings.showRequestsUrl ?? true)
      })
      .catch(() => {})
  }, [])

  async function updateOverlaySettings(
    visible: boolean,
    height: number,
    qrSizeVal: number,
    message?: string,
    rollerVal?: boolean,
    qrCodeVal?: boolean,
    hideSingerQueueVal?: boolean,
    keepRotationScrollerSingersVal?: boolean,
    showRequestsUrlVal?: boolean,
  ) {
    if (!auth.sessionToken || !auth.isLoggedIn) return
    try {
      await api('/api/overlay/settings', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          visible,
          height,
          qrSize: qrSizeVal,
          customMessage: message ?? customMessage,
          showRoller: rollerVal ?? showRoller,
          showQrCode: qrCodeVal ?? showQrCode,
          hideSingerQueue: hideSingerQueueVal ?? hideSingerQueue,
          keepRotationScrollerSingers: keepRotationScrollerSingersVal ?? keepRotationScrollerSingers,
          showRequestsUrl: showRequestsUrlVal ?? showRequestsUrl,
        })
      })
    } catch (err) {
      console.error('Failed to update overlay settings:', err)
    }
  }

  // Fetch active rotation settings
  useEffect(() => {
    if (!auth.sessionToken || !auth.isLoggedIn) return
    api('/api/rotations', { headers })
      .then((rotations: { id: string | number; status: string; type?: string; config?: { type?: string } }[]) => {
        if (rotations && rotations.length > 0) {
          const active = rotations.find(r => r.status === 'active') || rotations[0]
          setActiveRotationId(String(active.id))
          setRotationType(active.config?.type || active.type || 'strict_round_robin')
        }
      })
      .catch((err) => { console.error('Failed to load rotation settings:', err) })
  }, [auth.sessionToken, auth.isLoggedIn, headers])

  async function updateRotationType(newType: string) {
    if (!auth.sessionToken || !auth.isLoggedIn) return
    setSavingRotationType(true)
    try {
      let rotId = activeRotationId
      if (!rotId) {
        // Auto-create a default rotation if none exists
        const created = await api('/api/rotations', {
          method: 'POST',
          headers,
          body: JSON.stringify({ name: 'Default Rotation', config: { type: newType } }),
        })
        rotId = String(created.id)
        setActiveRotationId(rotId)
      } else {
        await api(`/api/rotations/${rotId}/config`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ type: newType }),
        })
      }
      setRotationType(newType)
      await refreshQueue()
      await refreshQueueState()
    } catch (err) {
      console.error('Failed to update rotation type:', err)
    } finally {
      setSavingRotationType(false)
    }
  }

  // WebSocket for real-time updates - FIXED to auto-refresh queue
  useEffect(() => {
    function connectWs() {
      try {
        wsRef.current = new WebSocket(getWsUrl(auth.sessionToken || undefined))

        wsRef.current.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data)
            if (msg.type === 'queue.updated' ||
                msg.type === 'player.updated' ||
                msg.type === 'player.play' ||
                msg.type === 'player.next' ||
                msg.type === 'player.stop') {
              refreshQueue() // Auto-refresh queue on updates
              refreshQueueState()
            } else if (msg.type === 'break_music.updated') {
              loadBreakMusicState()
            } else if (msg.type === 'player.youtube_fallback') {
              const fallbackMessage =
                typeof msg.message === 'string' && msg.message.trim()
                  ? msg.message
                  : 'YouTube fallback status updated.'
              setBanner(fallbackMessage)
              if (msg.status !== 'downloading') {
                setTimeout(() => setBanner(''), 5000)
              }
            } else if (msg.type === 'player.timing') {
              if (typeof msg.currentTime === 'number') {
                setCurrentTime(msg.currentTime)
                lastWebSocketUpdateRef.current = Date.now()
              }
              // Handle duration updates - allow updating if:
              // 1. Duration hasn't been set yet, OR
              // 2. New duration is significantly different (>10% change)
              // This allows correcting initial incorrect durations (e.g., fragmented CDG streams)
              // while preventing small fluctuations from causing updates
              if (typeof msg.duration === 'number' &&
                  !isNaN(msg.duration) && isFinite(msg.duration) && msg.duration > 0) {

                if (!durationSetForSongRef.current) {
                  // First duration update for this song
                  durationSetForSongRef.current = true
                  setActualDuration(msg.duration)
                } else {
                  // Duration already set - only update if significantly different
                  setActualDuration((prevDuration) => {
                    if (prevDuration === null || prevDuration === 0) {
                      return msg.duration
                    }

                    // Calculate percentage difference
                    const percentDiff = Math.abs(msg.duration - prevDuration) / prevDuration

                    // Update if difference is > 10% (allows correcting wrong initial durations)
                    if (percentDiff > 0.1) {
                      console.log(`Duration updated from ${prevDuration}s to ${msg.duration}s (${(percentDiff * 100).toFixed(1)}% change)`)
                      return msg.duration
                    }

                    return prevDuration
                  })
                }
              }
            } else if (msg.type === 'autoplay.settings') {
              if (typeof msg.enabled === 'boolean') {
                setAutoPlay(msg.enabled)
              }
              if (typeof msg.delay === 'number') {
                setAutoPlayDelay(msg.delay)
              }
            }
          } catch {}
        }

        wsRef.current.onclose = () => {
          console.log('WebSocket closed, reconnecting...')
          wsRef.current = null
          // Clear heartbeat timer
          if (wsHeartbeatRef.current) {
            clearInterval(wsHeartbeatRef.current)
            wsHeartbeatRef.current = null
          }
          setTimeout(connectWs, 1000)
        }

        wsRef.current.onerror = (err) => {
          console.error('WebSocket error:', err)
        }

        wsRef.current.onopen = () => {
          console.log('WebSocket connected')
          // Start heartbeat - send a message every 45 seconds to keep connection alive
          // This is in addition to server's ping/pong mechanism
          wsHeartbeatRef.current = setInterval(() => {
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
              // Send a lightweight heartbeat message
              wsRef.current.send(JSON.stringify({ type: 'heartbeat' }))
            }
          }, 45000)
        }
      } catch {
        setTimeout(connectWs, 1500)
      }
    }

    connectWs()
    return () => {
      if (wsHeartbeatRef.current) {
        clearInterval(wsHeartbeatRef.current)
      }
      wsRef.current?.close()
    }
  }, [auth.sessionToken])

  const currentPlaying = useMemo(() => {
    return queue.find(r => r.status === 'playing')
  }, [queue])

  const playNextSong = useCallback(async () => {
    if (! auth.sessionToken || !auth.isLoggedIn) return

    const nextQueued = queue.find(r => r.status === 'queued')
    if (! nextQueued) return

    console.log('Autoplay: Playing next song:', nextQueued. title)

    setBusy(true)
    try {
      await api('/api/player/play', {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: nextQueued.id })
      })
    } catch (err) {
      console.error('Autoplay failed:', err)
    } finally {
      setBusy(false)
      await refreshQueue()
    }
  }, [auth.sessionToken, headers, queue, auth.isLoggedIn])

  // Song timer management - DISABLED: Server now handles autoplay via /player/timing endpoint
  // This ensures autoplay works even when Host page is not open
  // The Host page now serves as a monitor and manual control interface only
  useEffect(() => {
    // Reset state whenever the currently playing song ID changes (including when it goes to null)
    // This effect only triggers when currentPlaying?.id changes, not on every re-render
    setCurrentTime(0)
    setActualDuration(null)
    durationSetForSongRef.current = false  // Reset the ref so duration can be set for new song
    lastWebSocketUpdateRef.current = 0

    if (currentPlaying) {
      console.log('Now playing:', currentPlaying.title)
    }
  }, [currentPlaying?.id, currentPlaying?.track_id])

  useEffect(() => {
    return () => {
      if (autoPlayTimerRef.current) {
        clearTimeout(autoPlayTimerRef.current)
      }
      if (songTimerRef.current) {
        clearInterval(songTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (breakMusicPaused || breakMusicRemainingSec == null || breakMusicRemainingSec <= 0) return
    const timer = setInterval(() => {
      setBreakMusicRemainingSec((prev) => (prev == null ? prev : Math.max(0, prev - 1)))
    }, 1000)
    return () => clearInterval(timer)
  }, [breakMusicPaused, breakMusicRemainingSec])

  // Search for replacement songs - FIXED to handle both local and karaoke-nerds
  async function searchSongs(query: string) {
    if (!query.trim()) {
      setSearchResults([])
      return
    }

    try {
      if (replaceSearchMode === 'local') {
        const results = await api(`/api/search?q=${encodeURIComponent(query)}`)
        setSearchResults(results || [])
      } else {
        const results = await api(`/api/karaoke-nerds/search?q=${encodeURIComponent(query)}`)
        setSearchResults(results || [])
      }
    } catch {
      setSearchResults([])
    }
  }

  useEffect(() => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current)
    }

    const searchDelay = replaceSearchMode === 'local' ? LOCAL_SEARCH_DELAY_MS : KARAOKE_NERDS_SEARCH_DELAY_MS
    searchTimeoutRef.current = setTimeout(() => searchSongs(searchQuery), searchDelay)

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current)
      }
    }
  }, [searchQuery, replaceSearchMode])

  // Auto-fetch video title when URL is entered in replace mode
  useEffect(() => {
    if (replaceSearchMode === 'url' && replaceUrl.trim() && !replaceTitle) {
      const timer = setTimeout(async () => {
        const title = await fetchVideoTitle(replaceUrl)
        setReplaceTitle(title)
      }, 500)
      return () => clearTimeout(timer)
    }
  }, [replaceUrl, replaceSearchMode, replaceTitle])

  // Auto-fetch video title when URL is entered in manual request mode
  useEffect(() => {
    if (manualRequestMode === 'url' && manualRequestUrl.trim() && !manualRequestTitle) {
      const timer = setTimeout(async () => {
        const title = await fetchVideoTitle(manualRequestUrl)
        setManualRequestTitle(title)
      }, 500)
      return () => clearTimeout(timer)
    }
  }, [manualRequestUrl, manualRequestMode, manualRequestTitle])

  async function replaceSong(queueId: number, newTrackId: number) {
    if (!auth.sessionToken || !auth.isLoggedIn) return

    setBusy(true)
    try {
      const result = await api('/api/queue/replace', {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: queueId, trackId: newTrackId })
      })

      if (result.wasPlaying) setCurrentTime(0)
      closeReplaceModal()
    } finally {
      setBusy(false)
      await refreshQueueViews()
    }
  }

  async function replaceSongWithKaraokeNerds(queueId: number, track: { title: string; artist: string; url: string; brand?: string }) {
    if (! auth.sessionToken || !auth.isLoggedIn) return

    setBusy(true)
    try {
      const result = await api('/api/queue/replace', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: queueId,
          external: {
            title: track.title,
            artist: track.artist,
            url: track.url,
            source: 'karaoke-nerds',
            brand: track.brand || null,
          },
        })
      })

      if (result.wasPlaying) setCurrentTime(0)
      closeReplaceModal()
    } finally {
      setBusy(false)
      await refreshQueueViews()
    }
  }

  function formatTime(seconds: number): string {
    if (! seconds || ! isFinite(seconds)) return '0:00'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  // Manual request search functionality
  async function searchManualRequest(query: string) {
    if (!query.trim()) {
      setManualRequestResults([])
      return
    }

    try {
      if (manualRequestMode === 'local') {
        const results = await api(`/api/search?q=${encodeURIComponent(query)}`)
        setManualRequestResults(results || [])
      } else if (manualRequestMode === 'external') {
        const results = await api(`/api/karaoke-nerds/search?q=${encodeURIComponent(query)}`)
        setManualRequestResults(results || [])
      }
    } catch {
      setManualRequestResults([])
    }
  }

  // Effect to handle manual request search with debouncing
  useEffect(() => {
    if (manualRequestMode === 'url') {
      setManualRequestResults([])
      return
    }

    if (manualRequestSearchTimeoutRef.current) {
      clearTimeout(manualRequestSearchTimeoutRef.current)
    }

    const searchDelay = manualRequestMode === 'local' ? LOCAL_SEARCH_DELAY_MS : KARAOKE_NERDS_SEARCH_DELAY_MS
    manualRequestSearchTimeoutRef.current = setTimeout(() => searchManualRequest(manualRequestQuery), searchDelay)

    return () => {
      if (manualRequestSearchTimeoutRef.current) {
        clearTimeout(manualRequestSearchTimeoutRef.current)
      }
    }
  }, [manualRequestQuery, manualRequestMode])

  function resetManualRequestModal() {
    setShowManualRequest(false)
    setManualRequestQuery('')
    setManualRequestResults([])
    setManualRequestName('')
    setManualRequestUrl('')
    setManualRequestTitle('')
    setManualRequestArtist('')
    setManualRequestDiscId('')
    setManualRequestMode('local')
    setShowManualSingerSuggestions(false)
    setManualSingerHighlightIndex(0)
    setManualRequestForSingerId(null)
  }

  function selectManualRequestSinger(singer: { displayName: string }) {
    setManualRequestName(singer.displayName)
    setShowManualSingerSuggestions(false)
    setManualSingerHighlightIndex(0)
  }

  function getManualRequestSingerUuid(): string | null {
    const normalizedName = manualRequestName.trim().toLocaleLowerCase()
    if (!normalizedName) return null

    const selectedById = manualRequestForSingerId
      ? (queueState?.queueOrder ?? []).find((singer) => singer.singerId === manualRequestForSingerId)
      : null
    if (selectedById?.publicUuid) return selectedById.publicUuid

    const selectedByName = (queueState?.queueOrder ?? []).find(
      (singer) => singer.displayName.trim().toLocaleLowerCase() === normalizedName && singer.publicUuid,
    )
    return selectedByName?.publicUuid ?? null
  }

  // Add manual request to queue - Local track
  async function addManualRequestLocal(trackId: number) {
    if (!auth.sessionToken || !auth.isLoggedIn) return

    setBusy(true)
    try {
      await api('/api/queue', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          trackId,
          requestedBy: manualRequestName || null,
          singerUuid: getManualRequestSingerUuid(),
        })
      })

      resetManualRequestModal()
    } finally {
      setBusy(false)
      await refreshQueue()
    }
  }

  // Add manual request to queue - External (Karaoke Nerds) track
  async function addManualRequestExternal(track: { title: string; artist: string; url: string; brand?: string }) {
    if (!auth.sessionToken || !auth.isLoggedIn) return

    setBusy(true)
    try {
      await api('/api/karaoke-nerds/add', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: track.title,
          artist: track.artist,
          url: track.url,
          brand: track.brand || null,
          requestedBy: manualRequestName || null,
          singerUuid: getManualRequestSingerUuid(),
        })
      })

      resetManualRequestModal()
    } finally {
      setBusy(false)
      await refreshQueue()
    }
  }

  // Fetch video title from URL
  async function fetchVideoTitle(url: string): Promise<string> {
    try {
      const response = await api(`/api/video-metadata?url=${encodeURIComponent(url)}`)
      return response.title || url.split('/').pop()?.split('?')[0] || 'Video'
    } catch (err) {
      console.error('Failed to fetch video title:', err)
      return url.split('/').pop()?.split('?')[0] || 'Video'
    }
  }

  // Replace song with custom URL
  async function replaceSongWithUrl(queueId: number, url: string, title: string, artist: string) {
    if (!auth.sessionToken || !auth.isLoggedIn) return

    setBusy(true)
    try {
      const result = await api('/api/queue/replace', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: queueId,
          external: {
            title: title || 'Video',
            artist: artist || 'Unknown',
            url,
            source: 'url',
          },
        })
      })

      if (result.wasPlaying) setCurrentTime(0)
      closeReplaceModal()
    } finally {
      setBusy(false)
      await refreshQueueViews()
    }
  }

  // Add manual request to queue - Manual URL
  async function addManualRequestUrl() {
    if (!auth.sessionToken || !auth.isLoggedIn) return
    if (!manualRequestUrl.trim()) return

    setBusy(true)
    try {
      await api('/api/karaoke-nerds/add', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: manualRequestTitle || 'Video',
          artist: manualRequestArtist || 'Unknown',
          url: manualRequestUrl,
          requestedBy: manualRequestName || null,
          discId: manualRequestDiscId || null,
          singerUuid: getManualRequestSingerUuid(),
        })
      })

      resetManualRequestModal()
    } finally {
      setBusy(false)
      await refreshQueue()
    }
  }

  // Download video from external source
  async function downloadVideo(url: string, title: string, artist: string, brand?: string, discId?: string) {
    if (!auth.sessionToken || !auth.isLoggedIn) return
    if (!allowDownloads) {
      alert('Downloads are disabled')
      return
    }

    const trackKey = `${url}`
    setDownloadingTrack(trackKey)
    setBusy(true)

    try {
      const response = await api('/api/admin/ytdlp/download', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          url,
          title,
          artist,
          brand: brand || null,
          discId: discId || null
        })
      })

      if (response.ok) {
        setBanner(`✔ Downloaded: ${artist} - ${title}`)
        setTimeout(() => setBanner(''), 5000)
      } else {
        setBanner(`⚠️ Download failed: ${response.error || 'Unknown error'}`)
        setTimeout(() => setBanner(''), 5000)
      }
    } catch (err: any) {
      console.error('Download failed:', err)
      setBanner(`⚠️ Download failed: ${err.message || 'Unknown error'}`)
      setTimeout(() => setBanner(''), 5000)
    } finally {
      setBusy(false)
      setDownloadingTrack(null)
    }
  }

function closeDetails(e: React.SyntheticEvent) {
  const el = e.currentTarget as HTMLElement
  const details = el.closest('details') as HTMLDetailsElement | null
  if (details) details.removeAttribute('open')
}
  const handleDragStart = (e: React.DragEvent, item: Row) => {
    setDraggedItem(item)
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleDragOver = (e: React.DragEvent, position: number) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverPosition(position)
  }

  const handleDragLeave = () => {
    setDragOverPosition(null)
  }

  const handleDrop = async (e: React.DragEvent, targetPosition: number) => {
    e.preventDefault()
    setDragOverPosition(null)

    if (!draggedItem || !auth.sessionToken || !auth.isLoggedIn || draggedItem.position === targetPosition) {
      setDraggedItem(null)
      return
    }

    setBusy(true)
    try {
      await api('/api/queue/reorder', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: draggedItem. id,
          newPosition: targetPosition
        })
      })
    } finally {
      setBusy(false)
      setDraggedItem(null)
      await refreshQueue()
    }
  }

  // FIXED: Play button to work properly - plays top of queue if nothing playing
  async function playTop() {
    if (!auth.sessionToken || !auth.isLoggedIn) return
    explicitStopRef.current = false
    setBusy(true)
    try {
      await api('/api/player/play', { method:'POST', headers })
    } finally {
      setBusy(false)
      await refreshQueue()
    }
  }

  async function playThis(id: number) {
    if (! auth.sessionToken || !auth.isLoggedIn) return
    explicitStopRef.current = false
    setBusy(true)
    try { await api('/api/player/play', { method:'POST', headers, body: JSON.stringify({ id }) }) }
    finally { setBusy(false); await refreshQueue() }
  }

  async function next() {
    if (!auth.sessionToken || !auth.isLoggedIn) return
    explicitStopRef. current = false
    setBusy(true)
    try {
      await api('/api/player/next', { method:'POST', headers })
    } finally {
      setBusy(false)
      await refreshQueue()
    }
  }

  async function stop() {
    if (!auth.sessionToken || !auth.isLoggedIn) return
    setBusy(true)

    try {
      explicitStopRef.current = true
      autoPlayScheduledRef.current = false

      if (autoPlayTimerRef.current) {
        clearTimeout(autoPlayTimerRef.current)
        autoPlayTimerRef.current = null
      }

      if (songTimerRef.current) {
        clearInterval(songTimerRef.current)
        songTimerRef.current = null
      }

      setCurrentTime(0)
      lastWebSocketUpdateRef.current = 0

      await api('/api/player/stop', { method: 'POST', headers })
    } finally {
      setBusy(false)
      await refreshQueue()
    }
  }

  async function rename(id: number, requestedBy: string) {
    if (!auth.sessionToken || !auth.isLoggedIn) return
    setBusy(true)
    try { await api('/api/queue/rename', { method:'POST', headers, body: JSON.stringify({ id, requestedBy }) }) }
    finally { setBusy(false); await refreshQueue() }
  }

  async function updateKey(id: number, keyAdjustment: number) {
    if (!auth.sessionToken || !auth.isLoggedIn) return
    setBusy(true)
    try { await api('/api/queue/update-key', { method:'POST', headers, body: JSON.stringify({ id, keyAdjustment }) }) }
    finally { setBusy(false); await refreshQueue() }
  }

  async function remove(id: number) {
    if (!auth.sessionToken || !auth.isLoggedIn) return
    setBusy(true)
    try { await api('/api/queue/delete', { method:'POST', headers, body: JSON.stringify({ id }) }) }
    finally { setBusy(false); await refreshQueue() }
  }

  async function clearAll() {
    if (!auth.sessionToken || !auth.isLoggedIn) return
    if (!confirm('⚠️ Clear ALL queues?\n\nThis will remove all songs from the queue AND remove all singers from the rotation. This cannot be undone.')) return
    setBusy(true)
    try {
      await api('/api/queue/clear', { method:'POST', headers })
      // Also remove all singers from the active rotation in parallel
      if (queueState?.activeRotation) {
        const rotationId = queueState.activeRotation.id
        await Promise.allSettled(
          queueState.queueOrder.map(singer =>
            api(`/api/rotations/${rotationId}/singers/${singer.singerId}`, { method: 'DELETE', headers })
              .catch((err: unknown) => console.error(`Failed to remove singer ${singer.singerId} from rotation:`, err))
          )
        )
      }
    } finally {
      setBusy(false)
      await refreshQueue()
      await refreshQueueState()
    }
  }

  async function removeSingerFromRotation(singerId: string) {
    if (!auth.sessionToken || !auth.isLoggedIn) return
    if (!confirm('Remove this singer from the rotation? This will also delete their sang history and cannot be undone.')) return
    setBusy(true)
    try {
      // Delete ALL queue entries for the singer (pending + history) and reset their stats
      await api(`/api/singers/${singerId}/history`, { method: 'DELETE', headers })
      // Remove from active rotation if one exists
      if (queueState?.activeRotation) {
        const rotationId = queueState.activeRotation.id
        await api(`/api/rotations/${rotationId}/singers/${singerId}`, { method: 'DELETE', headers })
          .catch((err: unknown) => console.error(`Failed to remove singer ${singerId} from rotation:`, err))
      }
      await refreshQueueState()
    } catch (err) {
      console.error('Failed to remove singer:', err)
    } finally {
      setBusy(false)
    }
  }

  const estimatedDuration = actualDuration
    ? actualDuration
    : (currentPlaying?.duration_ms
      ? currentPlaying.duration_ms / 1000
      : 210)

  return (
    <div className="host-page">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@24,400,0,0&display=swap');

        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }

        @keyframes slideIn {
          from { transform: translateX(-10px); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }

        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }

        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        @keyframes progressPulse {
          0% { opacity: 1; }
          50% { opacity: 0.7; }
          100% { opacity: 1; }
        }

        .host-page {
          min-height: 100vh;
          padding: 16px;
          padding-bottom: env(safe-area-inset-bottom, 16px);
          animation: fadeInUp 0.5s ease;
        }

        .material-symbols-rounded {
          font-family: 'Material Symbols Rounded';
          font-weight: normal;
          font-style: normal;
          line-height: 1;
          letter-spacing: normal;
          text-transform: none;
          display: inline-block;
          white-space: nowrap;
          word-wrap: normal;
          direction: ltr;
          -webkit-font-feature-settings: 'liga';
          -webkit-font-smoothing: antialiased;
        }

        .container {
          max-width: 1200px;
          margin: 0 auto;
        }

        .header {
          text-align: center;
          margin-bottom: 32px;
          animation: fadeInUp 0.6s ease;
        }

        .header-title {
          font-size: clamp(28px, 5vw, 40px);
          font-weight: 700;
          margin: 0 0 8px 0;
          background: linear-gradient(135deg, #6366f1 0%, #10b981 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
        }

        .card {
          background: var(--color-bg-card);
          border: 1px solid var(--color-border);
          border-radius: 20px;
          padding: 24px;
          margin-bottom: 20px;
          box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3);
          backdrop-filter: blur(10px);
          animation: fadeInUp 0.6s ease backwards;
          overflow: hidden;
        }

        .status-bar {
          background: linear-gradient(135deg, rgba(16, 185, 129, 0.1), rgba(99, 102, 241, 0.1));
          border: 1px solid rgba(16, 185, 129, 0.3);
        }

        .banner {
          background: linear-gradient(135deg, rgba(239, 68, 68, 0.15), rgba(245, 158, 11, 0.15));
          border: 1px solid rgba(239, 68, 68, 0.3);
          border-radius: 16px;
          padding: 14px 20px;
          margin-bottom: 20px;
          font-weight: 500;
          animation: slideIn 0.3s ease;
        }

        .now-playing {
          background: linear-gradient(135deg, rgba(16, 185, 129, 0.1), rgba(99, 102, 241, 0.1));
          border: 1px solid rgba(16, 185, 129, 0.3);
          position: relative;
          overflow: hidden;
          }

        .progress-bar {
          height: 8px;
          background: rgba(255, 255, 255, 0.1);
          border-radius: 100px;
          overflow: hidden;
          margin-top: 12px;
          position: relative;
        }

        .progress-fill {
          height: 100%;
          background: linear-gradient(90deg, #10b981, #6366f1);
          border-radius: 100px;
          transition: width 1s linear;
          position: relative;
          box-shadow: 0 0 10px rgba(16, 185, 129, 0.4);
        }

        .progress-fill::after {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent);
          animation: shimmer 2s ease infinite;
        }

        @keyframes shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }

        .controls-grid {
          display: grid;
          gap: 12px;
        }

        .host-top-card {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .host-top-card-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }

        .host-top-card-content {
          display: flex;
          flex-direction: row;
          gap: 16px;
          align-items: stretch;
        }

        .host-top-section {
          flex: 1 1 0;
          min-width: 0;
        }

        .host-section-divider {
          width: 1px;
          align-self: stretch;
          background: var(--color-border);
          margin: 0 2px;
          flex: 0 0 auto;
        }

        .host-controls-card .control-btn {
          padding: 8px 10px;
          min-width: 40px;
          font-size: 16px;
          min-height: 36px;
        }

        .host-controls-card {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .host-control-buttons {
          display: flex;
          gap: 8px;
          flex-wrap: nowrap;
          align-items: center;
        }

        .host-control-buttons .control-btn {
          flex: 0 0 40px;
        }

        .now-playing-box {
          padding: 12px;
          border-radius: 14px;
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          overflow: visible;
          min-height: 98px;
          box-sizing: border-box;
        }

        .now-playing-box.now-playing {
          padding: 12px;
          border-radius: 14px;
          overflow: visible;
        }

        .control-btn {
          padding: 14px;
          background: var(--color-bg-secondary);
          border: 2px solid var(--color-border);
          border-radius: 14px;
          color: var(--color-text-primary);
          font-weight: 600;
          font-size: 14px;
          cursor: pointer;
          transition: all 0. 3s ease;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
        }

        .control-btn:hover:not(:disabled) {
          background: var(--color-bg-hover);
          border-color: var(--color-accent);
          transform: translateY(-2px);
          box-shadow: 0 6px 20px rgba(0, 0, 0, 0.3);
        }

        .control-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .control-btn. primary {
          background: linear-gradient(135deg, #6366f1, #8b5cf6);
          border: none;
          color: white;
        }

        .control-btn. danger {
          background: linear-gradient(135deg, #ef4444, #dc2626);
          border: none;
          color: white;
        }

        .control-btn.success {
          background: linear-gradient(135deg, #10b981, #059669);
          border: none;
          color: white;
        }

        .toggle-group {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .toggle {
          position: relative;
          width: 48px;
          height: 24px;
        }

        .toggle input {
          opacity: 0;
          width: 0;
          height: 0;
        }

        .toggle-slider {
          position: absolute;
          cursor: pointer;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: var(--color-bg-hover);
          transition: 0.4s;
          border-radius: 100px;
        }

        . toggle-slider::before {
          position: absolute;
          content: "";
          height: 16px;
          width: 16px;
          left: 4px;
          bottom: 4px;
          background: white;
          transition: 0.4s;
          border-radius: 50%;
        }

        . toggle input:checked + .toggle-slider {
          background: var(--color-success);
        }

        .toggle input:checked + .toggle-slider::before {
          transform: translateX(24px);
        }

        .queue-item {
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          border-radius: 16px;
          padding: 16px;
          margin-bottom: 12px;
          transition: all 0.3s ease;
          cursor: move;
        }

        .queue-item:hover {
          background: var(--color-bg-hover);
          border-color: var(--color-accent);
          transform: translateX(4px);
        }

        . queue-item.playing {
          background: linear-gradient(135deg, rgba(16, 185, 129, 0.1), rgba(99, 102, 241, 0.1));
          border-color: rgba(16, 185, 129, 0.3);
        }

        .queue-item. drag-over {
          background: rgba(99, 102, 241, 0.2);
          border-color: var(--color-accent);
        }

        .queue-item-singer,
        .queue-item-title,
        .queue-item-artist {
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }


        .modal-backdrop {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.8);
          backdrop-filter: blur(4px);
          z-index: 999;
        }

        /* Queue item actions: desktop buttons vs mobile context menu */
        .queue-item-row {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
        }

        .queue-item-actions {
          display: flex;
          align-items: center;
          gap: 8px;
          flex: 0 0 auto;
        }

        .queue-item-singer {
          font-size: 0.9rem;
          font-weight: 600;
          opacity: 0.95;
          margin-bottom: 2px;
        }

        .queue-item-title {
          font-size: 1.05rem;
          font-weight: 500;
          opacity: 0.9;
          line-height: 1.2;
        }

        .queue-item-artist {
          font-size: 0.85rem;
          font-weight: 400;
          opacity: 0.7;
          margin-top: 2px;
        }

        .queue-item.playing .queue-item-title {
          color: #a5b4fc;
          font-weight: 600;
        }


        .queue-item-actions.mobile {
          display: none;
        }

        .mobile-actions-menu {
          position: relative;
        }

        .mobile-actions-menu > summary {
          list-style: none;
        }
        .mobile-actions-menu > summary::-webkit-details-marker {
          display: none;
        }

        .mobile-actions-dropdown {
          position: absolute;
          right: 0;
          bottom: calc(100% + 12px);
          display: flex;
          gap: 8px;
          padding: 10px;
          border-radius: 14px;
          border: 1px solid var(--color-border);
          background: var(--color-bg-secondary);
          box-shadow: 0 10px 30px rgba(0,0,0,0.35);
          z-index: 50;
        }

        @media (max-width: 640px) {
          .queue-item-actions.desktop {
            display: none;
          }
          .queue-item-actions.mobile {
            display: flex;
            justify-content: flex-end;
          }
        }

        .modal {
          position: fixed;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          background: var(--color-bg-card);
          border: 1px solid var(--color-border);
          border-radius: 20px;
          padding: 24px;
          z-index: 1000;
          max-width: 600px;
          width: 90%;
          max-height: 85vh;
          overflow: hidden;
          box-shadow: 0 10px 50px rgba(0, 0, 0, 0.5);
          display: flex;
          flex-direction: column;
        }

        .break-manager-modal {
          width: min(96vw, 1180px);
          max-width: 1180px;
          max-height: 90vh;
          height: min(90vh, 860px);
        }

        .break-manager-body {
          min-height: 0;
          flex: 1;
          display: flex;
          flex-direction: column;
        }

        .break-manager-toolbar {
          display: flex;
          flex-direction: column;
          gap: 6px;
          margin-bottom: 16px;
        }

        .break-manager-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }

        .break-manager-layout {
          display: flex;
          min-height: 0;
          flex: 1;
          overflow: hidden;
        }

        .break-manager-panel {
          min-width: 0;
          display: flex;
          flex-direction: column;
          min-height: 0;
        }

        .break-manager-splitter {
          width: 10px;
          min-width: 10px;
          cursor: col-resize;
          border-radius: 8px;
          background: transparent;
          position: relative;
        }

        .break-manager-splitter::before {
          content: '';
          position: absolute;
          left: 4px;
          top: 0;
          bottom: 0;
          width: 2px;
          background: var(--color-border);
        }

        .break-manager-card {
          border: 1px solid var(--color-border);
          border-radius: 12px;
          background: var(--color-bg-secondary);
          min-height: 0;
        }

        .break-playlist-row {
          display: grid;
          grid-template-columns: 28px minmax(0, 1fr) auto;
          gap: 8px;
          padding: 8px 10px;
          align-items: center;
          border-bottom: 1px solid rgba(255,255,255,0.06);
          font-size: 13px;
        }

        .break-playlist-row.dragging {
          opacity: 0.55;
        }

        .break-playlist-row.current {
          background: rgba(99, 102, 241, 0.16);
        }

        .break-table-header-cell {
          position: relative;
          display: flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
        }

        .break-table-header-sort {
          border: none;
          background: transparent;
          color: inherit;
          font: inherit;
          font-weight: 600;
          text-align: left;
          cursor: pointer;
          padding: 0;
          margin: 0;
          min-width: 0;
        }

        .break-table-header-resizer {
          position: absolute;
          top: -6px;
          right: -6px;
          width: 12px;
          height: calc(100% + 12px);
          cursor: col-resize;
        }

        .break-columns-popover {
          position: absolute;
          top: calc(100% + 8px);
          right: 0;
          z-index: 10;
          border: 1px solid var(--color-border);
          border-radius: 12px;
          background: var(--color-bg-secondary);
          box-shadow: 0 10px 28px rgba(0,0,0,0.4);
          padding: 12px;
          min-width: 190px;
          display: grid;
          gap: 8px;
        }

        .modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
          flex-shrink: 0;
          min-width: 0;
        }

        .modal-header h3 {
          margin: 0;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          flex: 1;
        }

        .search-mode-toggle {
          display: flex;
          flex-direction: row;
          gap: 8px;
          background: transparent;
          padding: 0;
          margin-bottom: 20px;
        }

        .mode-button {
          flex: 1;
          padding: 12px 16px;
          border: none;
          border-radius: 12px;
          background: var(--color-bg-secondary);
          color: var(--color-text-secondary);
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.3s ease;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          border: 1px solid var(--color-border);
        }

        .mode-button.active {
          background: linear-gradient(135deg, #6366f1, #818cf8);
          color: white;
          border-color: transparent;
          box-shadow: 0 2px 8px rgba(99, 102, 241, 0.3);
        }

        .mode-button.active. karaoke-nerds {
          background: linear-gradient(135deg, #7c3aed, #a855f7);
          box-shadow: 0 2px 8px rgba(124, 58, 237, 0.3);
        }

        . mode-button:not(.active):hover {
          background: var(--color-bg-hover);
          color: var(--color-text-primary);
          border-color: var(--color-accent);
        }

        .search-input {
          width: 100%;
          padding: 12px 16px;
          background: var(--color-bg-secondary);
          border: 2px solid var(--color-border);
          border-radius: 12px;
          color: var(--color-text-primary);
          font-size: 15px;
          outline: none;
          margin-bottom: 16px;
          box-sizing: border-box;
        }

        .search-input:focus {
          border-color: var(--color-accent);
          box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.1);
        }

        .search-results {
          flex: 1;
          overflow-y: auto;
          border: 1px solid var(--color-border);
          border-radius: 12px;
          background: var(--color-bg-secondary);
          margin-bottom: 16px;
        }

        .search-result {
          padding: 12px 16px;
          border-bottom: 1px solid var(--color-border);
          cursor: pointer;
          transition: all 0.3s ease;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
        }

        .search-result:hover {
          background: var(--color-bg-hover);
        }

        .search-result:last-child {
          border-bottom: none;
        }

        .form-input {
          width: 100%;
          padding: 12px 16px;
          background: var(--color-bg-secondary);
          border: 2px solid var(--color-border);
          border-radius: 12px;
          color: var(--color-text-primary);
          font-size: 15px;
          outline: none;
          box-sizing: border-box;
        }

        .form-input:focus {
          border-color: var(--color-accent);
        }

        .form-group {
          margin-bottom: 20px;
        }

        .manual-singer-suggestions {
          position: absolute;
          top: calc(100% + 6px);
          left: 0;
          right: 0;
          z-index: 20;
          display: flex;
          flex-direction: column;
          border: 1px solid var(--color-border);
          border-radius: 12px;
          background: var(--color-bg-secondary);
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
          overflow: hidden;
        }

        .manual-singer-suggestion {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          width: 100%;
          padding: 10px 14px;
          border: none;
          border-bottom: 1px solid var(--color-border);
          background: transparent;
          color: var(--color-text-primary);
          text-align: left;
          cursor: pointer;
        }

        .manual-singer-suggestion:last-child {
          border-bottom: none;
        }

        .manual-singer-suggestion:hover,
        .manual-singer-suggestion.active {
          background: var(--color-bg-hover);
        }

        .manual-singer-suggestion-hint {
          font-size: 12px;
          color: var(--color-text-secondary);
          white-space: nowrap;
        }

        .form-label {
          display: block;
          font-size: 14px;
          font-weight: 500;
          color: var(--color-text-secondary);
          margin-bottom: 8px;
        }

        . settings-section {
          margin-bottom: 24px;
          padding-bottom: 24px;
          border-bottom: 1px solid var(--color-border);
        }

        .settings-section:last-child {
          border-bottom: none;
          margin-bottom: 0;
          padding-bottom: 0;
        }

        .settings-title {
          font-size: 16px;
          font-weight: 600;
          margin-bottom: 16px;
          color: var(--color-text-primary);
        }

        .slider-control {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        . slider {
          flex: 1;
          height: 6px;
          background: var(--color-bg-secondary);
          border-radius: 3px;
          outline: none;
          -webkit-appearance: none;
        }

        .slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 20px;
          height: 20px;
          background: var(--color-accent);
          cursor: pointer;
          border-radius: 50%;
        }

        .slider::-moz-range-thumb {
          width: 20px;
          height: 20px;
          background: var(--color-accent);
          cursor: pointer;
          border-radius: 50%;
          border: none;
        }

        .error-msg {
          background: rgba(239, 68, 68, 0.1);
          border: 1px solid rgba(239, 68, 68, 0.3);
          border-radius: 10px;
          padding: 12px 16px;
          color: #fca5a5;
          margin-bottom: 16px;
        }

        .loading-spinner {
          width: 20px;
          height: 20px;
          border: 2px solid var(--color-border);
          border-top-color: var(--color-accent);
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
          display: inline-block;
        }

        . stat-pill {
          padding: 6px 14px;
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          border-radius: 100px;
          font-size: 13px;
          font-weight: 500;
        }

        @media (max-width: 768px) {
          .host-top-card-content {
            flex-direction: column;
          }

          .host-top-section {
            flex: 0 1 auto;
          }

          .host-section-divider {
            width: 100%;
            height: 1px;
            margin: 2px 0;
          }

          .host-control-buttons {
            gap: 6px;
          }

          .host-control-buttons .control-btn {
            flex: 1 1 0;
            min-width: 0;
            height: 38px;
            min-height: 38px;
            padding: 0;
            border-radius: 10px;
          }

          .controls-grid {
            display: flex !important;
            flex-direction: row !important;
            gap: 6px !important;
            grid-template-columns: none !important;
            justify-content: space-between !important;
            align-items: center !important;
          }

          .controls-grid .control-btn {
            width: 44px !important;
            height: 44px !important;
            min-width: 0 !important;
            padding: 0 !important;
            flex: 1 1 0 !important;
            border-radius: 10px;

            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;

            line-height: 1 !important;
          }

          .controls-grid .control-btn > * {
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
          }

          .break-manager-modal {
            width: 95%;
            top: 0;
            transform: translate(-50%, 0);
            max-height: 100svh;
            height: 100svh;
            border-radius: 0 0 20px 20px;
          }

          .break-manager-modal .modal-header {
            position: sticky;
            top: 0;
            z-index: 10;
            background: var(--color-bg-card);
            padding-bottom: 4px;
          }

          .break-manager-layout {
            flex-direction: column;
          }

          .break-manager-layout .break-manager-panel {
            flex: 1 1 0 !important;
          }

          .break-manager-splitter {
            display: none;
          }
        }


        /* Even smaller screens */
        @media (max-width:  480px) {
          .controls-grid {
            gap:  4px !important;
          }

          .controls-grid .control-btn {
            min-width: 40px ! important;
            width: 40px !important;
            height:  40px !important;
          }

          .controls-grid .control-btn span {
            font-size: 18px !important;
          }

          .modal { width: 95%; padding: 20px; }
        }

        /* Very small screens */
        @media (max-width: 380px) {
          .controls-grid .control-btn {
            min-width: 38px !important;
            width: 38px !important;
            height: 38px !important;
          }

          .controls-grid .control-btn span {
            font-size:  16px !important;
          }
        }
        }
      `}</style>

      <div className="container">
        {banner && (
          <div className="banner">{renderStatusMessage(banner)}</div>
        )}

        {!auth.isLoggedIn ? (
          <div
            className="card"
            style={{ maxWidth: 400, margin: '100px auto', overflow: 'hidden' }}
          >
            <h1 style={{ textAlign: 'center', marginBottom: 32 }}>
              <MaterialIcon name="mic_external_on" style={{ fontSize: 30, verticalAlign: 'middle', marginRight: 8 }} />
              Host Login
            </h1>

            {oidcConfig?.passwordLoginEnabled !== false && (
              <form onSubmit={handleLogin}>
                <div className="form-group">
                  <label className="form-label">Username</label>
                  <input
                    className="form-input"
                    type="text"
                    value={loginUsername}
                    onChange={e => setLoginUsername(e.target.value)}
                    placeholder="Enter host username"
                    autoComplete="username"
                    required
                    style={{
                      width: '100%',
                      boxSizing: 'border-box'
                    }}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Password</label>
                  <input
                    className="form-input"
                    type="password"
                    value={loginPassword}
                    onChange={e => setLoginPassword(e.target.value)}
                    placeholder="Enter host password"
                    autoComplete="current-password"
                    required
                    autoFocus
                    style={{
                      width: '100%',
                      boxSizing: 'border-box'
                    }}
                  />
                </div>
                {loginError && <div className="error-msg">{loginError}</div>}
                <button
                  className="control-btn primary"
                  type="submit"
                  disabled={busy}
                  style={{
                    width: '100%',
                    boxSizing: 'border-box'
                  }}
                >
                  {busy ? (
                    <>
                      <span className="loading-spinner"></span> Logging in...
                    </>
                  ) : (
                    'Login'
                  )}
                </button>
              </form>
            )}
            {loginError && oidcConfig?.passwordLoginEnabled === false && (
              <div className="error-msg">{loginError}</div>
            )}
            {oidcConfig?.passwordLoginEnabled === false && !oidcConfig?.enabled && (
              <div className="error-msg" style={{ marginBottom: 16 }}>
                Username/password login is disabled and SSO is not enabled.
              </div>
            )}
            {oidcConfig?.enabled && (
              <>
                {oidcConfig?.passwordLoginEnabled !== false && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '20px 0' }}>
                    <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.1)' }} />
                    <span style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>or</span>
                    <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.1)' }} />
                  </div>
                )}
                <a
                  href={`${API_BASE}/api/auth/oidc/login?returnTo=%2Fhost`}
                  className="control-btn"
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    display: 'flex',
                    justifyContent: 'center',
                    textDecoration: 'none',
                    background: oidcConfig.buttonColor,
                    border: 'none'
                  }}
                >
                  {oidcConfig.buttonText}
                </a>
              </>
            )}
            <p
              style={{
                marginTop: 20,
                fontSize: 13,
                textAlign: 'center',
                color: 'var(--color-text-secondary)'
              }}
            >
              Use the credentials configured in Admin settings
            </p>
          </div>
        ) : (
          <>
            <div className="header">
              <h1 className="header-title">Host Panel</h1>
            </div>

            <div className="card host-top-card">
              <div className="host-top-card-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700 }}>
                  <MaterialIcon name="dashboard_customize" style={{ fontSize: 22 }} />
                  <span>Host Controls</span>
                </div>
                <button
                  className="control-btn"
                  type="button"
                  onClick={() => setHostTopCollapsed((collapsed) => !collapsed)}
                  aria-expanded={!hostTopCollapsed}
                  aria-controls="host-top-card-content"
                  title={hostTopCollapsed ? 'Show host controls' : 'Hide host controls'}
                  style={{ width: 40, height: 36, minHeight: 36, padding: 0 }}
                >
                  <MaterialIcon name={hostTopCollapsed ? 'expand_more' : 'expand_less'} />
                </button>
              </div>

              {!hostTopCollapsed && (
              <div id="host-top-card-content" className="host-top-card-content">
              <section className="host-top-section">
                <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 8}}>
                  <h2 style={{margin: 0}} title="Break Music" aria-label="Break Music">
                    <MaterialIcon name="music_note" style={{ fontSize: 24, verticalAlign: 'text-bottom' }} />
                  </h2>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'nowrap' }}>
                    <button
                      className="control-btn"
                      title="Manage break music library and playlist"
                      style={{ padding: '8px 10px', minWidth: 40 }}
                      onClick={openBreakMusicManager}
                      disabled={busy}
                    >
                      <MaterialIcon name="build" />
                    </button>
                    <button
                      className="control-btn"
                      title="Play previous break playlist track"
                      style={{ padding: '8px 10px', minWidth: 40 }}
                      onClick={() => controlBreakMusic('previous')}
                      disabled={busy || breakPlaylistTrackIds.length === 0}
                    >
                      <MaterialIcon name="skip_previous" />
                    </button>
                    <button
                      className="control-btn"
                      title={breakMusicPaused ? 'Resume break music' : 'Pause break music'}
                      style={{ padding: '8px 10px', minWidth: 40 }}
                      onClick={() => controlBreakMusic(breakMusicPaused ? 'resume' : 'pause')}
                      disabled={busy || !breakMusicTrack}
                    >
                      <MaterialIcon name={breakMusicPaused ? 'play_arrow' : 'pause'} />
                    </button>
                    <button
                      className="control-btn"
                      title="Skip to next break playlist track"
                      style={{ padding: '8px 10px', minWidth: 40 }}
                      onClick={() => controlBreakMusic('skip')}
                      disabled={busy || breakPlaylistTrackIds.length === 0}
                    >
                      <MaterialIcon name="skip_next" />
                    </button>
                  </div>
                </div>

                {breakMusicTrack ? (
                  <>
                    <div style={{ marginBottom: 8, fontSize: 15 }}>
                      <strong>{breakMusicTrack.title}</strong> by <strong>{breakMusicTrack.artist || 'Unknown Artist'}</strong>
                    </div>
                    <div style={{ marginBottom: 10, color: 'var(--color-text-secondary)', fontSize: 14 }}>
                      Time remaining: {breakMusicRemainingSec == null ? '—' : formatTime(breakMusicRemainingSec)}
                    </div>
                  </>
                ) : (
                  <div style={{ marginBottom: 10, color: 'var(--color-text-secondary)', fontSize: 14 }}>
                    No break track selected
                  </div>
                )}

                {activeBreakPlaylistName && (
                  <div
                    role="status"
                    aria-live="polite"
                    style={{ color: 'var(--color-text-secondary)', fontSize: 13, marginBottom: 4 }}
                  >
                    Loaded playlist: <strong style={{ color: 'var(--color-text-primary)' }}>{activeBreakPlaylistName}</strong>
                  </div>
                )}

                {breakPlaylistTrackIds.length > 0 && (
                  <div
                    role="status"
                    aria-live="polite"
                    style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}
                  >
                    Playlist tracks: {breakPlaylistTrackIds.length}
                  </div>
                )}
              </section>

              <div className="host-section-divider" />

              <section className="host-top-section host-controls-card">
                <div className="host-control-buttons">
                  <button className="control-btn success" onClick={playTop} disabled={busy} title="Play" aria-label="Play">
                    <MaterialIcon name="play_arrow" />
                  </button>
                  <button className="control-btn primary" onClick={next} disabled={busy} title="Next" aria-label="Next">
                    <MaterialIcon name="skip_next" />
                  </button>
                  <button className="control-btn danger" onClick={stop} disabled={busy} title="Stop" aria-label="Stop">
                    <MaterialIcon name="stop" />
                  </button>
                  <button className="control-btn" onClick={refreshQueue} disabled={busy} title="Refresh" aria-label="Refresh">
                    <MaterialIcon name="refresh" />
                  </button>
                  <button className="control-btn danger" onClick={clearAll} disabled={busy} title="Clear all" aria-label="Clear all">
                    <MaterialIcon name="delete" />
                  </button>
                  <button className="control-btn" onClick={() => setShowPlayerWindowControl(true)} title="Settings" aria-label="Settings">
                    <MaterialIcon name="tune" />
                  </button>
                </div>

                <div className={`now-playing-box${currentPlaying ? ' now-playing' : ''}`}>
                  {currentPlaying ? (
                    <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2, flexWrap: 'wrap' }}>
                      <div style={{ fontWeight: 700, fontSize: 16, color: '#10b981', minWidth: 0, flex: '1 1 180px', overflowWrap: 'anywhere' }}>
                        <MaterialIcon name="mic_external_on" style={{ fontSize: 18, verticalAlign: 'text-bottom', marginRight: 6 }} />
                        {currentPlaying.title || 'Unknown Title'}{renderDiscIdTag(currentPlaying.disc_id)}
                      </div>
                      {renderReplaceButton(currentPlaying, 'Replace current song')}
                    </div>
                    <div style={{ color: 'var(--color-text-secondary)', fontSize: 13, marginBottom: 4 }}>
                      {currentPlaying.artist || 'Unknown Artist'}
                      {currentPlaying.requested_by && <span style={{ marginLeft: 8 }}>· <strong style={{ color: 'var(--color-text-primary)' }}>{currentPlaying.requested_by}</strong></span>}
                    </div>
                    <div className="progress-bar" style={{ marginTop: 6 }}>
                      <div
                        className="progress-fill"
                        style={{ width: `${estimatedDuration > 0 ? Math.min(100, (currentTime / estimatedDuration) * 100) : 0}%` }}
                      />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 12, color: 'var(--color-text-secondary)' }}>
                      <span>{formatTime(currentTime)}</span>
                      <span>{formatTime(estimatedDuration)}</span>
                    </div>
                    {autoPlay && (
                      <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6, textAlign: 'center',
                                    padding: '4px 8px', background: 'rgba(16,185,129,0.1)',
                                    borderRadius: 6, border: '1px solid rgba(16,185,129,0.2)' }}>
                        <MaterialIcon name="sync" style={{ fontSize: 14, verticalAlign: 'text-bottom', marginRight: 4 }} />
                        Auto-play enabled · {autoPlayDelay}s delay
                      </div>
                    )}
                    </>
                  ) : (
                    <>
                      <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--color-text-secondary)', marginBottom: 4 }}>
                        <MaterialIcon name="music_off" style={{ fontSize: 18, verticalAlign: 'text-bottom', marginRight: 6 }} />
                        Nothing playing
                      </div>
                      <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>
                        Select Play to start the next queued song.
                      </div>
                    </>
                  )}
                </div>
              </section>
              </div>
              )}
            </div>

            <div className="card">
              <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, gap: 12}}>
                <h2 style={{margin: 0}} title="Queue Order" aria-label="Queue Order">
                  <MaterialIcon name="mic_external_on" style={{ fontSize: 24, verticalAlign: 'text-bottom' }} />
                </h2>
                <div style={{display: 'flex', gap: 12, alignItems: 'center'}}>
                  <span className="stat-pill" title="Singers" aria-label={`${queueState?.queueOrder.length ?? 0} singers`}>
                    <MaterialIcon name="group" style={{ fontSize: 15, verticalAlign: 'text-bottom', marginRight: 4 }} />
                    {queueState?.queueOrder.length ?? 0}
                  </span>
                  <span className="stat-pill" title="Queued songs" aria-label={`${queueState?.queueOrder.reduce((sum, s) => sum + s.queuedSongsCount, 0) ?? queue.filter(r => r.status === 'queued').length} queued songs`}>
                    <MaterialIcon name="queue_music" style={{ fontSize: 15, verticalAlign: 'text-bottom', marginRight: 4 }} />
                    {queueState?.queueOrder.reduce((sum, s) => sum + s.queuedSongsCount, 0) ?? queue.filter(r => r.status === 'queued').length}
                  </span>
                  <button
                    className="control-btn primary"
                    onClick={() => setShowManualRequest(true)}
                    disabled={busy}
                    title="Manually add a song to the queue"
                    style={{ padding: '8px 12px', fontSize: '16px', lineHeight: 1 }}
                  >
                    <MaterialIcon name="add" />
                  </button>
                  <button
                    className="control-btn"
                    onClick={openHistoryManager}
                    disabled={busy}
                    title="Manage singer history import/export"
                    aria-label="Manage singer history import/export"
                    style={{ padding: '8px 12px', lineHeight: 1 }}
                  >
                    <span
                      className="material-symbols-rounded"
                      style={{ fontSize: 22, display: 'block' }}
                    >
                      manage_history
                    </span>
                  </button>
                </div>
              </div>

              {/* Singer-based queue order */}
              {(!queueState || queueState.queueOrder.length === 0) ? (
                <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--color-text-secondary)' }}>
                  <MaterialIcon name="music_note" style={{ fontSize: 48, marginBottom: 16, opacity: 0.5 }} />
                  <div>No singers in queue</div>
                  <div style={{ fontSize: 14, marginTop: 8 }}>
                    Songs added from the Requests page will appear here automatically
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {(() => {
                    // Single-pass: tag each singer with isSinging, then sort current singer first
                    type TaggedSinger = typeof queueState.queueOrder[number] & { isSinging: boolean }
                    const tagged: TaggedSinger[] = queueState.queueOrder.map(s => ({
                      ...s,
                      isSinging: s.queuedSongs.some(q => q.status === 'playing'),
                    }))
                    const sorted = [...tagged].sort((a, b) => {
                      if (a.isSinging && !b.isSinging) return -1
                      if (!a.isSinging && b.isSinging) return 1
                      return 0
                    })
                    return sorted.map((singer, idx) => {
                      const { isSinging } = singer
                      return (
                    <div
                      key={singer.singerId}
                      draggable
                      onDragStart={() => handleSingerDragStart(singer.singerId)}
                      onDragEnd={handleSingerDragEnd}
                      onDragOver={e => handleSingerDragOver(e, singer.singerId)}
                      onDragLeave={() => setSingerDragOverId(null)}
                      onDrop={e => handleSingerDrop(e, singer.singerId)}
                      style={{
                        background: isSinging
                          ? 'rgba(16,185,129,0.12)'
                          : singerDragOverId === singer.singerId ? 'rgba(99,102,241,0.15)' : 'var(--color-bg-secondary)',
                        border: isSinging
                          ? '1.5px solid rgba(16,185,129,0.6)'
                          : singerDragOverId === singer.singerId
                          ? '1.5px solid var(--color-accent)'
                          : '1px solid var(--color-border)',
                        borderRadius: 12,
                        padding: '14px 16px',
                        opacity: singerDraggedId === singer.singerId ? 0.5 : 1,
                        cursor: 'grab',
                        transition: 'border-color 0.15s, background 0.15s',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                        {/* Position badge */}
                        <span style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          width: 32,
                          height: 32,
                          borderRadius: 8,
                          background: isSinging ? 'rgba(16,185,129,0.9)' : 'rgba(99, 102, 241, 0.9)',
                          color: 'white',
                          fontWeight: 700,
                          flex: '0 0 auto',
                          fontSize: 14,
                        }}>
                          {isSinging ? <MaterialIcon name="mic_external_on" style={{ fontSize: 18 }} /> : idx + 1}
                        </span>

                        {/* Singer info */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 16, color: isSinging ? 'rgba(16,185,129,1)' : 'var(--color-text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
                            {singer.displayName}
                            {isSinging && (
                              <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, background: 'rgba(16,185,129,0.2)', color: 'rgba(16,185,129,1)', letterSpacing: 0.5, textTransform: 'uppercase' }}>
                                Now Singing
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                            {singer.nextSong
                              ? <><strong style={{ color: 'var(--color-text-primary)' }}>{isSinging ? 'Singing:' : 'Next:'}</strong> {singer.nextSong.title || 'Unknown'} — {singer.nextSong.artist || 'Unknown'}{renderDiscIdTag(singer.nextSong.discId)}</>
                              : <span style={{ opacity: 0.6 }}>No queued song</span>
                            }
                          </div>
                          <div style={{ display: 'flex', gap: 16, marginTop: 4, fontSize: 12, color: 'var(--color-text-muted)' }}>
                            <span><MaterialIcon name="music_note" style={{ fontSize: 14, verticalAlign: 'text-bottom', marginRight: 3 }} />{singer.queuedSongsCount} queued</span>
                            <span><MaterialIcon name="check_circle" style={{ fontSize: 14, verticalAlign: 'text-bottom', marginRight: 3 }} />{singer.totalSongsSung} sang</span>
                            {singer.lastSangAt && <span><MaterialIcon name="schedule" style={{ fontSize: 14, verticalAlign: 'text-bottom', marginRight: 3 }} />{formatTimeAgo(singer.lastSangAt)}</span>}
                          </div>
                        </div>

                        {/* Actions */}
                        <div style={{ display: 'flex', gap: 6, flex: '0 0 auto' }}>
                          <button
                            className="control-btn"
                            title="View singer queue and history"
                            onClick={() => openSingerModal(singer.singerId)}
                            style={{ padding: '6px 10px', fontSize: 16, lineHeight: 1 }}
                          >
                            <MaterialIcon name="visibility" />
                          </button>
                          <button
                            className="control-btn danger"
                            title="Remove singer from rotation"
                            disabled={busy}
                            onClick={() => removeSingerFromRotation(singer.singerId)}
                            style={{ padding: '6px 10px', fontSize: 13 }}
                          >
                            <MaterialIcon name="close" />
                          </button>
                        </div>
                      </div>
                    </div>
                      )
                    })
                  })()}
                </div>
              )}

              {/* Flat queue fallback — shown when queueState is not available */}
              {!queueState && queue.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ color: 'var(--color-text-secondary)', fontSize: 13, marginBottom: 8 }}>
                    (Flat queue — singer grouping unavailable)
                  </div>
                  {queue.map(item => (
                    <div
                      key={item.id}
                      className={`queue-item ${item.status === 'playing' ? 'playing' : ''}`}
                    >
                      <span style={{ fontWeight: 600 }}>{item.requested_by}</span>
                      {' — '}
                      {item.title}{renderDiscIdTag(item.disc_id)} by {item.artist}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Singer History Manager Modal */}
            {historyManagerOpen && (
              <>
                <div className="modal-backdrop" onClick={closeHistoryManager} />
                <div className="modal" role="dialog" aria-modal="true" aria-labelledby="history-manager-title" style={{ maxWidth: 560 }}>
                  <div className="modal-header">
                    <h3 id="history-manager-title" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span className="material-symbols-rounded" aria-hidden="true">manage_history</span>
                      Singer History
                    </h3>
                    <button
                      className="control-btn"
                      style={{ width: 40, height: 40, padding: 0 }}
                      onClick={closeHistoryManager}
                      aria-label="Close singer history manager"
                    >
                      <MaterialIcon name="close" />
                    </button>
                  </div>

                  {historyManagerMode === 'menu' && (
                    <div style={{ display: 'grid', gap: 12 }}>
                      <button
                        className="control-btn primary"
                        type="button"
                        disabled={busy}
                        onClick={() => setHistoryManagerMode('export')}
                        style={{ justifyContent: 'center', padding: '14px 18px' }}
                      >
                        Export Singer History
                      </button>
                      <button
                        className="control-btn"
                        type="button"
                        disabled={busy}
                        onClick={() => setHistoryManagerMode('import')}
                        style={{ justifyContent: 'center', padding: '14px 18px' }}
                      >
                        Import Singer History
                      </button>
                    </div>
                  )}

                  {historyManagerMode === 'export' && (
                    <div style={{ display: 'grid', gap: 16 }}>
                      <div style={{ color: 'var(--color-text-secondary)', fontSize: 14 }}>
                        Choose active singers to export, or export all singer history.
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button
                          className="control-btn primary"
                          type="button"
                          disabled={busy}
                          onClick={() => void exportAllSingerHistory()}
                        >
                          Export All Singers
                        </button>
                        <button
                          className="control-btn"
                          type="button"
                          disabled={busy || historyExportSelectedSingerIds.size === 0}
                          onClick={() => void exportSelectedSingerHistory()}
                        >
                          Export Selected
                        </button>
                        <button
                          className="control-btn"
                          type="button"
                          disabled={busy}
                          onClick={() => setHistoryExportSelectedSingerIds(new Set((queueState?.queueOrder ?? []).map((singer) => singer.singerId)))}
                        >
                          Select All Active
                        </button>
                      </div>

                      {(queueState?.queueOrder.length ?? 0) === 0 ? (
                        <div style={{ color: 'var(--color-text-secondary)', padding: 16, textAlign: 'center' }}>
                          No active singers to choose from. Use Export All Singers to export stored history.
                        </div>
                      ) : (
                        <div style={{ display: 'grid', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
                          {(queueState?.queueOrder ?? []).map((singer) => (
                            <label
                              key={singer.singerId}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 10,
                                padding: 12,
                                borderRadius: 10,
                                border: '1px solid var(--color-border)',
                                background: 'var(--color-bg-secondary)',
                                cursor: 'pointer',
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={historyExportSelectedSingerIds.has(singer.singerId)}
                                onChange={(event) => {
                                  setHistoryExportSelectedSingerIds((prev) => {
                                    const next = new Set(prev)
                                    if (event.currentTarget.checked) next.add(singer.singerId)
                                    else next.delete(singer.singerId)
                                    return next
                                  })
                                }}
                              />
                              <span style={{ flex: 1, fontWeight: 600 }}>{singer.displayName}</span>
                              <span style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>
                                {singer.totalSongsSung} sang
                              </span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {historyManagerMode === 'import' && (
                    <div style={{ display: 'grid', gap: 16 }}>
                      <input
                        ref={hostHistoryImportInputRef}
                        type="file"
                        accept=".kd,application/json"
                        style={{ display: 'none' }}
                        onChange={(event) => void loadHistoryImportFile(event.currentTarget.files?.[0])}
                      />
                      <div style={{ color: 'var(--color-text-secondary)', fontSize: 14 }}>
                        Upload a KaraokeDock history file, then choose whether to import every singer or selected singers.
                      </div>
                      <button
                        className="control-btn primary"
                        type="button"
                        disabled={busy}
                        onClick={() => hostHistoryImportInputRef.current?.click()}
                        style={{ justifyContent: 'center', padding: '12px 16px' }}
                      >
                        Upload .kd File
                      </button>

                      {pendingHistoryImportData && (
                        <>
                          <div style={{ display: 'grid', gap: 8 }}>
                            <strong>Import all singers from this file?</strong>
                            <div style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>
                              Found {(pendingHistoryImportData.singers ?? []).length} singer{(pendingHistoryImportData.singers ?? []).length === 1 ? '' : 's'}.
                            </div>
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                              <button
                                className="control-btn primary"
                                type="button"
                                disabled={busy || (pendingHistoryImportData.singers ?? []).length === 0}
                                onClick={() => void importPendingHostSingerHistory(true)}
                              >
                                Yes, Import All
                              </button>
                              <button
                                className="control-btn"
                                type="button"
                                disabled={busy || historyImportSelectedIndexes.size === 0}
                                onClick={() => void importPendingHostSingerHistory(false)}
                              >
                                Import Selected
                              </button>
                            </div>
                          </div>

                          <div style={{ display: 'grid', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
                            {(pendingHistoryImportData.singers ?? []).map((singer, index) => (
                              <label
                                key={`${getKdSingerDisplayName(singer, index)}-${index}`}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 10,
                                  padding: 12,
                                  borderRadius: 10,
                                  border: '1px solid var(--color-border)',
                                  background: 'var(--color-bg-secondary)',
                                  cursor: 'pointer',
                                }}
                              >
                                <input
                                  type="checkbox"
                                  checked={historyImportSelectedIndexes.has(index)}
                                  onChange={(event) => {
                                    setHistoryImportSelectedIndexes((prev) => {
                                      const next = new Set(prev)
                                      if (event.currentTarget.checked) next.add(index)
                                      else next.delete(index)
                                      return next
                                    })
                                  }}
                                />
                                <span style={{ flex: 1, fontWeight: 600 }}>{getKdSingerDisplayName(singer, index)}</span>
                                <span style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>
                                  {singer.songs?.length ?? 0} songs
                                </span>
                              </label>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}

            {/* Singer Detail Modal */}
            {singerModalOpen && (
              <>
                <div className="modal-backdrop" onClick={closeSingerModal} />
                <div className="modal" style={{ maxWidth: 600 }}>
                  <div className="modal-header">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                      <h3 style={{ margin: 0 }}>
                        <MaterialIcon name="mic_external_on" style={{ fontSize: 22, verticalAlign: 'text-bottom', marginRight: 8 }} />
                        {selectedSingerHistory?.singer.displayName ?? (queueState?.queueOrder.find(s => s.singerId === selectedSingerId)?.displayName ?? 'Singer')} — Queue &amp; History
                      </h3>
                      {selectedSingerHistory && (
                        <button
                          className="control-btn"
                          type="button"
                          title="Edit singer name"
                          aria-label="Edit singer name"
                          style={{ width: 36, height: 36, padding: 0, flexShrink: 0 }}
                          onClick={openRenameSingerDialog}
                        >
                          <MaterialIcon name="edit" />
                        </button>
                      )}
                      {selectedSingerHistory && (
                        <button
                          className="control-btn"
                          type="button"
                          title="Merge another singer into this one"
                          aria-label="Merge singer"
                          style={{ width: 36, height: 36, padding: 0, flexShrink: 0 }}
                          onClick={() => { setMergeSingerDialogOpen(true); setMergeSingerError(''); setMergeSingerQuery('') }}
                        >
                          <MaterialIcon name="shuffle" />
                        </button>
                      )}
                      {selectedSingerHistory && (
                        <button
                          className="control-btn"
                          type="button"
                          title="Add a song to this singer's queue"
                          aria-label="Add song to queue"
                          style={{ width: 36, height: 36, padding: 0, flexShrink: 0 }}
                          onClick={() => {
                            setManualRequestForSingerId(selectedSingerId)
                            setManualRequestName(selectedSingerHistory.singer.displayName)
                            setManualRequestMode('local')
                            setManualRequestQuery('')
                            setManualRequestResults([])
                            setShowManualRequest(true)
                          }}
                        >
                          <MaterialIcon name="add" />
                        </button>
                      )}
                    </div>
                    <button
                      className="control-btn"
                      style={{ width: 40, height: 40, padding: 0 }}
                      onClick={closeSingerModal}
                    >
                      <MaterialIcon name="close" />
                    </button>
                  </div>

                  {singerModalLoading ? (
                    <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--color-text-secondary)' }}>
                      Loading…
                    </div>
                  ) : selectedSingerHistory ? (
                    <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
                      {/* Singer stats */}
                      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                        <span className="stat-pill"><MaterialIcon name="music_note" style={{ fontSize: 14, verticalAlign: 'text-bottom', marginRight: 3 }} />{selectedSingerHistory.singer.totalSongsSung} songs sung</span>
                        {selectedSingerHistory.singer.lastSangAt && (
                          <span className="stat-pill"><MaterialIcon name="schedule" style={{ fontSize: 14, verticalAlign: 'text-bottom', marginRight: 3 }} />Last: {formatTimeAgo(selectedSingerHistory.singer.lastSangAt)}</span>
                        )}
                        <span className="stat-pill" style={{ background: 'rgba(99,102,241,0.15)', color: 'var(--color-accent)' }}>
                          {selectedSingerHistory.singer.status}
                        </span>
                      </div>

                      {/* Queued Songs */}
                      <div>
                        <div style={{ fontWeight: 600, marginBottom: 8, color: 'var(--color-text-secondary)', textTransform: 'uppercase', fontSize: 11, letterSpacing: 1 }}>
                          Queue ({selectedSingerHistory.queuedSongs.length})
                          {selectedSingerHistory.queuedSongs.filter(s => s.status === 'queued').length > 1 && (
                            <span style={{ fontWeight: 400, fontSize: 10, marginLeft: 8, opacity: 0.7 }}>drag to reorder</span>
                          )}
                        </div>
                        {selectedSingerHistory.queuedSongs.length === 0 ? (
                          <div style={{ color: 'var(--color-text-muted)', fontSize: 13, padding: '8px 0', opacity: 0.7 }}>
                            No songs queued
                          </div>
                        ) : (
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                            <tbody>
                              {(() => {
                                const queuedOnly = selectedSingerHistory.queuedSongs.filter(s => s.status === 'queued')
                                const queuedIdxMap = new Map(queuedOnly.map((s, idx) => [s.queueId, idx]))
                                return selectedSingerHistory.queuedSongs.map((song, i) => {
                                const isDraggable = song.status === 'queued'
                                const queuedIdx = queuedIdxMap.get(song.queueId) ?? -1
                                return (
                                  <tr
                                    key={song.queueId}
                                    draggable={isDraggable}
                                    onDragStart={() => isDraggable && setModalSongDraggedId(song.queueId)}
                                    onDragEnd={() => setModalSongDraggedId(null)}
                                    onDragOver={e => { if (isDraggable) { e.preventDefault(); setModalSongDragOverId(song.queueId) } }}
                                    onDragLeave={() => setModalSongDragOverId(null)}
                                    onDrop={() => handleModalSongDrop(song.queueId)}
                                    style={{
                                      background: modalSongDragOverId === song.queueId ? 'rgba(99,102,241,0.15)' : 'var(--color-bg-secondary)',
                                      opacity: modalSongDraggedId === song.queueId ? 0.4 : 1,
                                      cursor: isDraggable ? 'grab' : 'default',
                                      transition: 'background 0.15s',
                                    }}
                                  >
                                    <td style={{ padding: '8px 10px', width: 32, textAlign: 'center', borderBottom: '1px solid var(--color-border)' }}>
                                      <span style={{
                                        background: 'rgba(99,102,241,0.9)',
                                        color: 'white',
                                        borderRadius: 6,
                                        width: 22,
                                        height: 22,
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        fontSize: 11,
                                        fontWeight: 700,
                                      }}>{i + 1}</span>
                                    </td>
                                    <td style={{ padding: '8px 6px', borderBottom: '1px solid var(--color-border)' }}>
                                      <div style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>{song.title || 'Unknown'}</div>
                                      <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                                        {song.artist || 'Unknown'}{renderDiscIdTag(song.discId)}
                                      </div>
                                      {song.requestedAt && (
                                        <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>
                                          Requested at: {formatRequestedAt(song.requestedAt)}
                                        </div>
                                      )}
                                    </td>
                                    <td style={{ padding: '8px 6px', textAlign: 'center', whiteSpace: 'nowrap', borderBottom: '1px solid var(--color-border)' }}>
                                      {song.keyAdjustment !== 0 && (
                                        <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }} title="Key adjustment">
                                          <MaterialIcon name="music_note" style={{ fontSize: 12, verticalAlign: 'text-bottom', marginRight: 2 }} />{song.keyAdjustment > 0 ? '+' : ''}{song.keyAdjustment}
                                        </span>
                                      )}
                                    </td>
                                    <td style={{ padding: '8px 6px', textAlign: 'center', borderBottom: '1px solid var(--color-border)' }}>
                                      <span style={{
                                        padding: '2px 8px',
                                        borderRadius: 100,
                                        fontSize: 11,
                                        background: song.status === 'playing' ? 'rgba(16,185,129,0.2)' : 'rgba(99,102,241,0.15)',
                                        color: song.status === 'playing' ? '#10b981' : 'var(--color-accent)',
                                      }} title={song.status === 'playing' ? 'Playing' : 'Queued'}>
                                        <MaterialIcon name={song.status === 'playing' ? 'play_arrow' : 'music_note'} style={{ fontSize: 14 }} />
                                      </span>
                                    </td>
                                    <td style={{ padding: '8px 6px', textAlign: 'center', width: 80, borderBottom: '1px solid var(--color-border)' }}>
                                      <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
                                        {canReplaceQueueSong(song) && renderReplaceButton(song)}
                                      {song.status === 'queued' && (
                                        <button
                                          onClick={() => removeSongFromQueue(song.queueId)}
                                          title="Remove song from queue"
                                          style={{
                                            background: 'rgba(239,68,68,0.15)',
                                            color: '#ef4444',
                                            border: '1px solid rgba(239,68,68,0.3)',
                                            borderRadius: 6,
                                            cursor: 'pointer',
                                            padding: '4px 8px',
                                            fontSize: 13,
                                            lineHeight: 1,
                                          }}>
                                          <MaterialIcon name="close" style={{ fontSize: 14 }} />
                                        </button>
                                      )}
                                      </div>
                                    </td>
                                  </tr>
                                )
                              })
                              })()}
                            </tbody>
                          </table>
                        )}
                      </div>

                      {/* Sang History */}
                      {selectedSingerHistory.completedSongs.length > 0 && (
                        <div>
                          <div style={{ fontWeight: 600, marginBottom: 8, color: 'var(--color-text-secondary)', textTransform: 'uppercase', fontSize: 11, letterSpacing: 1 }}>
                            Sang History ({selectedSingerHistory.completedSongs.length})
                          </div>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                            <tbody>
                              {selectedSingerHistory.completedSongs.map(song => (
                                <tr key={song.queueId} style={{
                                  background: 'var(--color-bg-secondary)',
                                }}>
                                  <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--color-border)' }}>
                                    <div style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>{song.title || 'Unknown'}</div>
                                    <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                                      {song.artist || 'Unknown'}{renderDiscIdTag(song.discId)}
                                    </div>
                                    {song.requestedAt && (
                                      <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>
                                        Requested at: {formatRequestedAt(song.requestedAt)}
                                      </div>
                                    )}
                                  </td>
                                  <td style={{ padding: '8px 6px', textAlign: 'center', whiteSpace: 'nowrap', borderBottom: '1px solid var(--color-border)' }}>
                                    {song.completedAt && (
                                      <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }} title={`Completed ${formatTimeAgo(song.completedAt)}`}>
                                        <MaterialIcon name="schedule" style={{ fontSize: 12, verticalAlign: 'text-bottom', marginRight: 2 }} />{formatTimeAgo(song.completedAt)}
                                      </span>
                                    )}
                                  </td>
                                  <td style={{ padding: '8px 6px', textAlign: 'center', width: 36, borderBottom: '1px solid var(--color-border)' }}>
                                    <span style={{
                                      padding: '2px 8px',
                                      borderRadius: 100,
                                      fontSize: 11,
                                      background: 'rgba(16,185,129,0.15)',
                                      color: '#10b981',
                                    }} title="Completed"><MaterialIcon name="check_circle" style={{ fontSize: 14 }} /></span>
                                  </td>
                                  <td style={{ padding: '8px 6px', textAlign: 'center', width: 80, borderBottom: '1px solid var(--color-border)' }}>
                                    <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
                                    <button
                                      className="control-btn"
                                      style={{ fontSize: 14, padding: '4px 8px', lineHeight: 1 }}
                                      disabled={busy}
                                      onClick={() => restoreSongToQueue(song.queueId)}
                                      title="Return this song to the queue"
                                    >
                                      <MaterialIcon name="keyboard_return" />
                                    </button>
                                    </div>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}

                      {/* Skipped / Removed Songs */}
                      {(selectedSingerHistory.skippedSongs.length > 0 || selectedSingerHistory.removedSongs.length > 0) && (
                        <div>
                          <div style={{ fontWeight: 600, marginBottom: 8, color: 'var(--color-text-secondary)', textTransform: 'uppercase', fontSize: 11, letterSpacing: 1 }}>
                            Skipped / Removed
                          </div>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, opacity: 0.7 }}>
                            <tbody>
                              {[...selectedSingerHistory.skippedSongs, ...selectedSingerHistory.removedSongs].map(song => (
                                <tr key={song.queueId} style={{
                                  background: 'var(--color-bg-secondary)',
                                }}>
                                  <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--color-border)' }}>
                                    <div style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>{song.title || 'Unknown'}</div>
                                    <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                                      {song.artist || 'Unknown'}{renderDiscIdTag(song.discId)}
                                    </div>
                                    {song.requestedAt && (
                                      <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>
                                        Requested at: {formatRequestedAt(song.requestedAt)}
                                      </div>
                                    )}
                                  </td>
                                  <td style={{ padding: '8px 6px', textAlign: 'center', width: 36, borderBottom: '1px solid var(--color-border)' }}>
                                    <span style={{
                                      padding: '2px 8px',
                                      borderRadius: 100,
                                      fontSize: 11,
                                      background: 'rgba(239,68,68,0.15)',
                                      color: '#ef4444',
                                    }} title={song.status === 'skipped' ? 'Skipped' : 'Removed'}>
                                      <MaterialIcon name={song.status === 'skipped' ? 'skip_next' : 'close'} style={{ fontSize: 14 }} />
                                    </span>
                                  </td>
                                  <td style={{ padding: '8px 6px', textAlign: 'center', width: 80, borderBottom: '1px solid var(--color-border)' }}>
                                    <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
                                    <button
                                      className="control-btn danger"
                                      style={{ fontSize: 13, padding: '4px 8px', lineHeight: 1 }}
                                      disabled={busy}
                                      onClick={() => deleteSongFromHistory(song.queueId)}
                                      title="Remove this track from singer history"
                                    >
                                      <MaterialIcon name="close" />
                                    </button>
                                    </div>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}

                      {selectedSingerHistory.completedSongs.length === 0 &&
                       selectedSingerHistory.skippedSongs.length === 0 &&
                       selectedSingerHistory.removedSongs.length === 0 && (
                        <div style={{ color: 'var(--color-text-secondary)', textAlign: 'center', padding: '10px 0' }}>
                          No sang history on record for this singer.
                        </div>
                      )}
                    </div>
                  ) : (
                    <div style={{ color: 'var(--color-text-secondary)', textAlign: 'center', padding: '20px 0' }}>
                      Could not load singer history.
                    </div>
                  )}
                </div>
                {renameSingerDialogOpen && selectedSingerHistory && (
                  <>
                    <div className="modal-backdrop" onClick={closeRenameSingerDialog} />
                    <div className="modal" style={{ maxWidth: 460, zIndex: 1001 }}>
                      <div className="modal-header">
                        <h3 style={{ margin: 0 }}><MaterialIcon name="edit" style={{ fontSize: 22, verticalAlign: 'text-bottom', marginRight: 8 }} />Edit Singer Name</h3>
                        <button
                          className="control-btn"
                          style={{ width: 40, height: 40, padding: 0 }}
                          onClick={closeRenameSingerDialog}
                        >
                          <MaterialIcon name="close" />
                        </button>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                        <div>
                          <label className="form-label" style={{ marginBottom: 6 }}>Singer Name</label>
                          <input
                            className="form-input"
                            value={editingSingerName}
                            onChange={e => setEditingSingerName(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                void renameSingerFromModal()
                              }
                            }}
                            placeholder="Enter singer name"
                            autoFocus
                            disabled={savingSingerName}
                          />
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                          <button
                            className="control-btn"
                            type="button"
                            onClick={closeRenameSingerDialog}
                            disabled={savingSingerName}
                          >
                            Cancel
                          </button>
                          <button
                            className="control-btn primary"
                            type="button"
                            onClick={() => void renameSingerFromModal()}
                            disabled={savingSingerName || editingSingerName.trim() === selectedSingerHistory.singer.displayName}
                          >
                            {savingSingerName ? 'Saving…' : 'Update Name'}
                          </button>
                        </div>
                      </div>
                    </div>
                  </>
                )}
                {mergeSingerDialogOpen && selectedSingerHistory && (
                  <>
                    <div className="modal-backdrop" onClick={() => setMergeSingerDialogOpen(false)} />
                    <div className="modal" style={{ maxWidth: 460, zIndex: 1001 }}>
                      <div className="modal-header">
                        <h3 style={{ margin: 0 }}><MaterialIcon name="shuffle" style={{ fontSize: 22, verticalAlign: 'text-bottom', marginRight: 8 }} />Merge Singer</h3>
                        <button className="control-btn" style={{ width: 40, height: 40, padding: 0 }} onClick={() => setMergeSingerDialogOpen(false)}><MaterialIcon name="close" /></button>
                      </div>
                      <p style={{ color: 'var(--color-text-secondary)', fontSize: 13, marginBottom: 12 }}>
                        Merge another singer's history and queue into <strong>{selectedSingerHistory.singer.displayName}</strong>. The other singer will be removed.
                      </p>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                        <div>
                          <label className="form-label" style={{ marginBottom: 6 }}>Singer to merge (source)</label>
                          <input
                            className="form-input"
                            list="merge-singer-list"
                            value={mergeSingerQuery}
                            onChange={e => { setMergeSingerQuery(e.target.value); setMergeSingerError('') }}
                            placeholder="Type singer name…"
                            autoFocus
                            disabled={mergingSinger}
                          />
                          <datalist id="merge-singer-list">
                            {(queueState?.queueOrder ?? []).filter(s => s.singerId !== selectedSingerId).map(s => (
                              <option key={s.singerId} value={s.displayName} />
                            ))}
                          </datalist>
                        </div>
                        {mergeSingerError && <div style={{ color: '#ef4444', fontSize: 13 }}>{mergeSingerError}</div>}
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                          <button className="control-btn" type="button" onClick={() => setMergeSingerDialogOpen(false)} disabled={mergingSinger}>Cancel</button>
                          <button className="control-btn primary" type="button" onClick={() => void mergeSingerIntoTarget()} disabled={mergingSinger || !mergeSingerQuery.trim()}>
                            {mergingSinger ? 'Merging…' : 'Merge'}
                          </button>
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </>
            )}

            {/* Account Management Modal */}
            {showAccountManagement && (
              <>
                <div className="modal-backdrop" onClick={() => setShowAccountManagement(false)} />
                <div className="modal" style={{ maxWidth: 560 }}>
                  <div className="modal-header">
                    <h3 style={{ margin: 0 }}><MaterialIcon name="lock" style={{ fontSize: 22, verticalAlign: 'text-bottom', marginRight: 8 }} />Account Settings</h3>
                    <button
                      className="control-btn"
                      style={{ width: 40, height: 40, padding: 0 }}
                      onClick={() => setShowAccountManagement(false)}
                    >
                      <MaterialIcon name="close" />
                    </button>
                  </div>

                  {auth.isDefaultPassword && (
                    <div className="banner" style={{ marginBottom: 16 }}>
                      <MaterialIcon name="warning" style={{ fontSize: 18, verticalAlign: 'text-bottom', marginRight: 6 }} />
                      You are using the default password. Please change it for security.
                    </div>
                  )}

                  <p style={{ color: 'var(--color-text-secondary)', marginBottom: 20, fontSize: 14 }}>
                    Change your username and password.
                  </p>

                  {!changingUsername && !changingPassword && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 20 }}>
                      <button
                        className="control-btn"
                        style={{ minWidth: 180, justifyContent: 'center', flex: 1 }}
                        onClick={() => setChangingUsername(true)}
                      >
                        <MaterialIcon name="person" /> Change Username
                      </button>
                      <button
                        className="control-btn"
                        style={{ minWidth: 180, justifyContent: 'center', flex: 1 }}
                        onClick={() => setChangingPassword(true)}
                      >
                        <MaterialIcon name="lock" /> Change Password
                      </button>
                    </div>
                  )}

                  {changingUsername && (
                    <form
                      onSubmit={handleChangeUsername}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 12,
                        background: 'var(--color-bg-secondary)',
                        padding: 16,
                        borderRadius: 12,
                        border: '1px solid var(--color-border)',
                        marginBottom: 20,
                      }}
                    >
                      <div className="form-group" style={{ marginBottom: 0 }}>
                        <label className="form-label">New Username</label>
                        <input
                          className="form-input"
                          type="text"
                          value={newUsername}
                          onChange={(e) => setNewUsername(e.target.value)}
                          placeholder="Enter new username (min 3 characters)"
                          autoComplete="username"
                          required
                          minLength={3}
                        />
                      </div>
                      <div className="form-group" style={{ marginBottom: 0 }}>
                        <label className="form-label">Current Password (to confirm)</label>
                        <input
                          className="form-input"
                          type="password"
                          value={usernamePassword}
                          onChange={(e) => setUsernamePassword(e.target.value)}
                          placeholder="Enter current password"
                          autoComplete="current-password"
                          required
                        />
                      </div>
                      {usernameError && <div className="error-msg" style={{ marginBottom: 0 }}>{usernameError}</div>}
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="control-btn success" type="submit" disabled={busy}>
                          <MaterialIcon name="check" /> Change Username
                        </button>
                        <button
                          type="button"
                          className="control-btn"
                          onClick={() => {
                            setChangingUsername(false)
                            setNewUsername('')
                            setUsernamePassword('')
                            setUsernameError('')
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}

                  {changingPassword && (
                    <form
                      onSubmit={handleChangePassword}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 12,
                        background: 'var(--color-bg-secondary)',
                        padding: 16,
                        borderRadius: 12,
                        border: '1px solid var(--color-border)',
                      }}
                    >
                      <div className="form-group" style={{ marginBottom: 0 }}>
                        <label className="form-label">Current Password</label>
                        <input
                          className="form-input"
                          type="password"
                          value={currentPassword}
                          onChange={(e) => setCurrentPassword(e.target.value)}
                          placeholder="Enter current password"
                          autoComplete="current-password"
                          required
                        />
                      </div>
                      <div className="form-group" style={{ marginBottom: 0 }}>
                        <label className="form-label">New Password</label>
                        <input
                          className="form-input"
                          type="password"
                          value={newPassword}
                          onChange={(e) => setNewPassword(e.target.value)}
                          placeholder="Enter new password (min 8 characters)"
                          autoComplete="new-password"
                          required
                          minLength={8}
                        />
                      </div>
                      <div className="form-group" style={{ marginBottom: 0 }}>
                        <label className="form-label">Confirm New Password</label>
                        <input
                          className="form-input"
                          type="password"
                          value={confirmPassword}
                          onChange={(e) => setConfirmPassword(e.target.value)}
                          placeholder="Confirm new password"
                          autoComplete="new-password"
                          required
                        />
                      </div>
                      {passwordError && <div className="error-msg" style={{ marginBottom: 0 }}>{passwordError}</div>}
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="control-btn success" type="submit" disabled={busy}>
                          <MaterialIcon name="check" /> Change Password
                        </button>
                        <button
                          type="button"
                          className="control-btn"
                          onClick={() => {
                            setChangingPassword(false)
                            setCurrentPassword('')
                            setNewPassword('')
                            setConfirmPassword('')
                            setPasswordError('')
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              </>
            )}

            {/* Player Settings Modal - FIXED WITH INLINE TOGGLE STYLES */}
            {showPlayerWindowControl && (
              <>
                <div className="modal-backdrop" onClick={() => setShowPlayerWindowControl(false)} />
                <div className="modal">
                  <div className="modal-header">
                    <h3 style={{ margin: 0 }}><MaterialIcon name="tune" style={{ fontSize: 22, verticalAlign: 'text-bottom', marginRight: 8 }} />Player Settings</h3>
                    <button
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--color-text-secondary)',
                        fontSize: 24,
                        cursor: 'pointer',
                        padding: '4px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '32px',
                        height: '32px',
                        borderRadius: '8px',
                        transition: 'all 0.3s ease'
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--color-bg-hover)'}
                      onMouseLeave={e => e.currentTarget. style.background = 'transparent'}
                      onClick={() => setShowPlayerWindowControl(false)}
                    >
                      <MaterialIcon name="close" />
                    </button>
                  </div>

                  <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
                  {/* Auto-play Settings */}
                  <div className="settings-section">
                    <div className="settings-title">Auto-play Settings</div>
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '12px 0',
                      marginBottom: autoPlay ? '16px' : '0'
                    }}>
                      <span style={{ fontSize: '15px', fontWeight: '500' }}>Auto-play</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        {/* Toggle Switch with Inline Styles */}
                        <label style={{
                          position: 'relative',
                          display: 'inline-block',
                          width: '48px',
                          height: '24px'
                        }}>
                          <input
                            type="checkbox"
                            checked={autoPlay}
                            onChange={e => {
                              const newEnabled = e.target.checked
                              setAutoPlay(newEnabled)
                              updateAutoPlaySettings(newEnabled, autoPlayDelay)
                            }}
                            style={{ opacity: 0, width: 0, height: 0 }}
                          />
                          <span style={{
                            position: 'absolute',
                            cursor: 'pointer',
                            top: 0,
                            left: 0,
                            right: 0,
                            bottom: 0,
                            backgroundColor: autoPlay ? '#10b981' : '#374151',
                            transition: '. 4s',
                            borderRadius: '34px'
                          }}>
                            <span style={{
                              position: 'absolute',
                              content: '',
                              height: '16px',
                              width: '16px',
                              left: autoPlay ? '28px' : '4px',
                              bottom: '4px',
                              backgroundColor: 'white',
                              transition: '.4s',
                              borderRadius: '50%'
                            }}></span>
                          </span>
                        </label>
                        <span style={{
                          color: autoPlay ? 'var(--color-success)' : 'var(--color-text-secondary)',
                          fontSize: '14px',
                          fontWeight: '500',
                          minWidth: '60px'
                        }}>
                          {autoPlay ? 'Enabled' : 'Disabled'}
                        </span>
                      </div>
                    </div>

                    {autoPlay && (
                      <div style={{
                        padding: '16px',
                        background: 'var(--color-bg-secondary)',
                        borderRadius: '12px',
                        border: '1px solid var(--color-border)'
                      }}>
                        <label className="form-label" style={{ marginBottom: '12px' }}>
                          Delay between songs: <strong>{autoPlayDelay}</strong> seconds
                        </label>
                        <div className="slider-control">
                          <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>0s</span>
                          <input
                            type="range"
                            className="slider"
                            value={autoPlayDelay}
                            onChange={e => {
                              const newDelay = parseInt(e. target.value)
                              setAutoPlayDelay(newDelay)
                            }}
                            onMouseUp={() => updateAutoPlaySettings(autoPlay, autoPlayDelay)}
                            onTouchEnd={() => updateAutoPlaySettings(autoPlay, autoPlayDelay)}
                            min="0"
                            max="60"
                            style={{ margin: '0 12px', flex: 1 }}
                          />
                          <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>60s</span>
                          <span style={{
                            minWidth: '50px',
                            textAlign: 'center',
                            padding: '4px 8px',
                            background: 'var(--color-bg-primary)',
                            borderRadius: '6px',
                            fontSize: '13px',
                            fontWeight: '600',
                            marginLeft: '12px'
                          }}>
                            {autoPlayDelay}s
                          </span>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="settings-section">
                    <div className="settings-title">Break Music Crossfade</div>
                    <div style={{
                      padding: '16px',
                      background: 'var(--color-bg-secondary)',
                      borderRadius: '12px',
                      border: '1px solid var(--color-border)'
                    }}>
                      <label className="form-label" style={{ marginBottom: '12px' }}>
                        Crossfade: <strong>{breakMusicCrossfadeSec}</strong> seconds
                      </label>
                      <div className="slider-control">
                        <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>0s</span>
                        <input
                          type="range"
                          className="slider"
                          value={breakMusicCrossfadeSec}
                          min="0"
                          max="15"
                          onChange={e => setBreakMusicCrossfadeSec(parseInt(e.target.value))}
                          onMouseUp={() => updateBreakCrossfade(breakMusicCrossfadeSec)}
                          onTouchEnd={() => updateBreakCrossfade(breakMusicCrossfadeSec)}
                          style={{ margin: '0 12px', flex: 1 }}
                        />
                        <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>15s</span>
                        <span style={{
                          minWidth: '50px',
                          textAlign: 'center',
                          padding: '4px 8px',
                          background: 'var(--color-bg-primary)',
                          borderRadius: '6px',
                          fontSize: '13px',
                          fontWeight: '600',
                          marginLeft: '12px'
                        }}>
                          {breakMusicCrossfadeSec}s
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="settings-section">
                    <div className="settings-title">Break Music Volume</div>
                    <div style={{
                      padding: '16px',
                      background: 'var(--color-bg-secondary)',
                      borderRadius: '12px',
                      border: '1px solid var(--color-border)'
                    }}>
                      <label className="form-label" style={{ marginBottom: '12px' }}>
                        Volume: <strong>{breakMusicVolumePercent}%</strong>
                      </label>
                      <div className="slider-control">
                        <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>0%</span>
                        <input
                          type="range"
                          className="slider"
                          value={breakMusicVolumePercent}
                          min="0"
                          max="100"
                          onChange={e => {
                            const nextVolume = parseInt(e.target.value)
                            setBreakMusicVolumePercent(nextVolume)
                            scheduleBreakVolumeUpdate(nextVolume)
                          }}
                          style={{ margin: '0 12px', flex: 1 }}
                        />
                        <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>100%</span>
                        <span style={{
                          minWidth: '50px',
                          textAlign: 'center',
                          padding: '4px 8px',
                          background: 'var(--color-bg-primary)',
                          borderRadius: '6px',
                          fontSize: '13px',
                          fontWeight: '600',
                          marginLeft: '12px'
                        }}>
                          {breakMusicVolumePercent}%
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="settings-section">
                    <div className="settings-title">Break Music Resume Delay</div>
                    <div style={{
                      padding: '16px',
                      background: 'var(--color-bg-secondary)',
                      borderRadius: '12px',
                      border: '1px solid var(--color-border)'
                    }}>
                      <label className="form-label" style={{ marginBottom: '12px' }}>
                        Delay after karaoke ends before resuming break music: <strong>{breakMusicResumeDelay}</strong> seconds
                      </label>
                      <div className="slider-control">
                        <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>0s</span>
                        <input
                          type="range"
                          className="slider"
                          value={breakMusicResumeDelay}
                          min="0"
                          max="30"
                          onChange={e => setBreakMusicResumeDelay(parseInt(e.target.value))}
                          onMouseUp={() => updateBreakResumeDelay(breakMusicResumeDelay)}
                          onTouchEnd={() => updateBreakResumeDelay(breakMusicResumeDelay)}
                          style={{ margin: '0 12px', flex: 1 }}
                        />
                        <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>30s</span>
                        <span style={{
                          minWidth: '50px',
                          textAlign: 'center',
                          padding: '4px 8px',
                          background: 'var(--color-bg-primary)',
                          borderRadius: '6px',
                          fontSize: '13px',
                          fontWeight: '600',
                          marginLeft: '12px'
                        }}>
                          {breakMusicResumeDelay}s
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Overlay Settings */}
                  <div className="settings-section">
                    <div className="settings-title">Overlay Settings</div>
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '12px 0',
                      marginBottom: overlayVisible ? '16px' : '0'
                    }}>
                      <span style={{ fontSize: '15px', fontWeight: '500' }}>Show Overlay</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        {/* Toggle Switch with Inline Styles */}
                        <label style={{
                          position: 'relative',
                          display: 'inline-block',
                          width: '48px',
                          height: '24px'
                        }}>
                          <input
                            type="checkbox"
                            checked={overlayVisible}
                            onChange={e => {
                              const newVisible = e.target.checked
                              setOverlayVisible(newVisible)
                              updateOverlaySettings(newVisible, overlayHeight, qrSize)
                            }}
                            style={{ opacity: 0, width: 0, height: 0 }}
                          />
                          <span style={{
                            position: 'absolute',
                            cursor: 'pointer',
                            top: 0,
                            left: 0,
                            right: 0,
                            bottom: 0,
                            backgroundColor: overlayVisible ? '#10b981' : '#374151',
                            transition: '.4s',
                            borderRadius: '34px'
                          }}>
                            <span style={{
                              position: 'absolute',
                              content: '',
                              height: '16px',
                              width: '16px',
                              left: overlayVisible ? '28px' : '4px',
                              bottom: '4px',
                              backgroundColor: 'white',
                              transition: '.4s',
                              borderRadius: '50%'
                            }}></span>
                          </span>
                        </label>
                        <span style={{
                          color: overlayVisible ? 'var(--color-success)' : 'var(--color-text-secondary)',
                          fontSize: '14px',
                          fontWeight: '500',
                          minWidth: '60px'
                        }}>
                          {overlayVisible ? 'Visible' : 'Hidden'}
                        </span>
                      </div>
                    </div>

                    {overlayVisible && (
                      <div style={{
                        padding: '16px',
                        background: 'var(--color-bg-secondary)',
                        borderRadius: '12px',
                        border: '1px solid var(--color-border)'
                      }}>
                        <div style={{ marginBottom: '20px' }}>
                          <label className="form-label" style={{ marginBottom: '12px' }}>
                            Scroller Height: <strong>{overlayHeight}px</strong>
                          </label>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                            <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>40px</span>
                            <input
                              type="range"
                              value={overlayHeight}
                              onChange={e => setOverlayHeight(parseInt(e. target.value))}
                              onMouseUp={() => updateOverlaySettings(overlayVisible, overlayHeight, qrSize)}
                              onTouchEnd={() => updateOverlaySettings(overlayVisible, overlayHeight, qrSize)}
                              min="40"
                              max="150"
                              style={{
                                flex: 1,
                                height: '6px',
                                background: 'var(--color-bg-primary)',
                                borderRadius: '3px',
                                outline: 'none',
                                WebkitAppearance: 'none'
                              }}
                            />
                            <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>150px</span>
                            <span style={{
                              minWidth: '50px',
                              textAlign: 'center',
                              padding: '4px 8px',
                              background: 'var(--color-bg-primary)',
                              borderRadius: '6px',
                              fontSize: '13px',
                              fontWeight: '600'
                            }}>
                              {overlayHeight}px
                            </span>
                          </div>
                        </div>

                        <div>
                          <label className="form-label" style={{ marginBottom: '12px' }}>
                            QR Code Size: <strong>{qrSize}px</strong>
                          </label>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                            <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>40px</span>
                            <input
                              type="range"
                              value={qrSize}
                              onChange={e => setQrSize(parseInt(e.target.value))}
                              onMouseUp={() => updateOverlaySettings(overlayVisible, overlayHeight, qrSize)}
                              onTouchEnd={() => updateOverlaySettings(overlayVisible, overlayHeight, qrSize)}
                              min="40"
                              max="150"
                              style={{
                                flex: 1,
                                height: '6px',
                                background: 'var(--color-bg-primary)',
                                borderRadius: '3px',
                                outline: 'none',
                                WebkitAppearance: 'none'
                              }}
                            />
                            <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>150px</span>
                            <span style={{
                              minWidth: '50px',
                              textAlign: 'center',
                              padding: '4px 8px',
                              background: 'var(--color-bg-primary)',
                              borderRadius: '6px',
                              fontSize: '13px',
                              fontWeight: '600'
                            }}>
                              {qrSize}px
                            </span>
                          </div>
                        </div>

                        <div style={{ marginTop: '20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                          {/* Show Roller toggle */}
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <span style={{ fontSize: '14px', fontWeight: '500' }}>Show Roller</span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                              <label style={{ position: 'relative', display: 'inline-block', width: '48px', height: '24px' }}>
                                <input
                                  type="checkbox"
                                  checked={showRoller}
                                  onChange={e => {
                                    const val = e.target.checked
                                    setShowRoller(val)
                                    updateOverlaySettings(overlayVisible, overlayHeight, qrSize, undefined, val, showQrCode)
                                  }}
                                  style={{ opacity: 0, width: 0, height: 0 }}
                                />
                                <span style={{
                                  position: 'absolute', cursor: 'pointer', top: 0, left: 0, right: 0, bottom: 0,
                                  backgroundColor: showRoller ? '#10b981' : '#374151',
                                  transition: '.4s', borderRadius: '34px'
                                }}>
                                  <span style={{
                                    position: 'absolute', height: '16px', width: '16px',
                                    left: showRoller ? '28px' : '4px', bottom: '4px',
                                    backgroundColor: 'white', transition: '.4s', borderRadius: '50%'
                                  }}></span>
                                </span>
                              </label>
                              <span style={{
                                color: showRoller ? 'var(--color-success)' : 'var(--color-text-secondary)',
                                fontSize: '14px', fontWeight: '500', minWidth: '60px'
                              }}>
                                {showRoller ? 'Visible' : 'Hidden'}
                              </span>
                            </div>
                          </div>

                          {/* Show QR Code toggle */}
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <span style={{ fontSize: '14px', fontWeight: '500' }}>Show QR Code</span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                              <label style={{ position: 'relative', display: 'inline-block', width: '48px', height: '24px' }}>
                                <input
                                  type="checkbox"
                                  checked={showQrCode}
                                  onChange={e => {
                                    const val = e.target.checked
                                    setShowQrCode(val)
                                    updateOverlaySettings(overlayVisible, overlayHeight, qrSize, undefined, showRoller, val)
                                  }}
                                  style={{ opacity: 0, width: 0, height: 0 }}
                                />
                                <span style={{
                                  position: 'absolute', cursor: 'pointer', top: 0, left: 0, right: 0, bottom: 0,
                                  backgroundColor: showQrCode ? '#10b981' : '#374151',
                                  transition: '.4s', borderRadius: '34px'
                                }}>
                                  <span style={{
                                    position: 'absolute', height: '16px', width: '16px',
                                    left: showQrCode ? '28px' : '4px', bottom: '4px',
                                    backgroundColor: 'white', transition: '.4s', borderRadius: '50%'
                                  }}></span>
                                </span>
                              </label>
                              <span style={{
                                color: showQrCode ? 'var(--color-success)' : 'var(--color-text-secondary)',
                                fontSize: '14px', fontWeight: '500', minWidth: '60px'
                              }}>
                                {showQrCode ? 'Visible' : 'Hidden'}
                              </span>
                            </div>
                          </div>

                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <span style={{ fontSize: '14px', fontWeight: '500' }}>Show Request URL</span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                              <label style={{ position: 'relative', display: 'inline-block', width: '48px', height: '24px' }}>
                                <input
                                  type="checkbox"
                                  checked={showRequestsUrl}
                                  onChange={e => {
                                    const val = e.target.checked
                                    setShowRequestsUrl(val)
                                    updateOverlaySettings(overlayVisible, overlayHeight, qrSize, undefined, showRoller, showQrCode, hideSingerQueue, keepRotationScrollerSingers, val)
                                  }}
                                  style={{ opacity: 0, width: 0, height: 0 }}
                                />
                                <span style={{
                                  position: 'absolute', cursor: 'pointer', top: 0, left: 0, right: 0, bottom: 0,
                                  backgroundColor: showRequestsUrl ? '#10b981' : '#374151',
                                  transition: '.4s', borderRadius: '34px'
                                }}>
                                  <span style={{
                                    position: 'absolute', height: '16px', width: '16px',
                                    left: showRequestsUrl ? '28px' : '4px', bottom: '4px',
                                    backgroundColor: 'white', transition: '.4s', borderRadius: '50%'
                                  }}></span>
                                </span>
                              </label>
                              <span style={{
                                color: showRequestsUrl ? 'var(--color-success)' : 'var(--color-text-secondary)',
                                fontSize: '14px', fontWeight: '500', minWidth: '60px'
                              }}>
                                {showRequestsUrl ? 'Visible' : 'Hidden'}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Custom Message */}
                  {overlayVisible && (
                    <div className="settings-section">
                      <div className="settings-title">Custom Message</div>
                      <input
                        type="text"
                        className="form-input"
                        placeholder="Enter custom message for overlay..."
                        value={customMessage}
                        onChange={e => setCustomMessage(e.target.value)}
                        onBlur={() => updateOverlaySettings(overlayVisible, overlayHeight, qrSize, customMessage)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            updateOverlaySettings(overlayVisible, overlayHeight, qrSize, customMessage)
                          }
                        }}
                        style={{ marginBottom: customMessage ? '12px' : '0' }}
                      />
                      {customMessage && (
                        <button
                          className="control-btn"
                          style={{
                            background: 'transparent',
                            border: '1px solid var(--color-border)',
                            padding: '8px 16px',
                            fontSize: '13px'
                          }}
                          onClick={() => {
                            setCustomMessage('')
                            updateOverlaySettings(overlayVisible, overlayHeight, qrSize, '')
                          }}
                        >
                          Clear Message
                        </button>
                      )}
                    </div>
                  )}

                  {/* Queue Display Settings */}
                  <div className="settings-section">
                    <div className="settings-title">Queue Display</div>
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '12px 0'
                    }}>
                      <div>
                        <span style={{ fontSize: '15px', fontWeight: '500' }}>Hide Singer's Queued Songs</span>
                        <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginTop: '2px' }}>
                          Show the singer's name but hide the song titles they've queued
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0, marginLeft: '16px' }}>
                        <label style={{
                          position: 'relative',
                          display: 'inline-block',
                          width: '48px',
                          height: '24px'
                        }}>
                          <input
                            type="checkbox"
                            checked={hideSingerQueue}
                            onChange={e => {
                              const val = e.target.checked
                              setHideSingerQueue(val)
                              updateOverlaySettings(overlayVisible, overlayHeight, qrSize, undefined, showRoller, showQrCode, val)
                            }}
                            style={{ opacity: 0, width: 0, height: 0 }}
                          />
                          <span style={{
                            position: 'absolute', cursor: 'pointer', top: 0, left: 0, right: 0, bottom: 0,
                            backgroundColor: hideSingerQueue ? '#10b981' : '#374151',
                            transition: '.4s', borderRadius: '34px'
                          }}>
                            <span style={{
                              position: 'absolute', height: '16px', width: '16px',
                              left: hideSingerQueue ? '28px' : '4px', bottom: '4px',
                              backgroundColor: 'white', transition: '.4s', borderRadius: '50%'
                            }}></span>
                          </span>
                        </label>
                        <span style={{
                          color: hideSingerQueue ? 'var(--color-success)' : 'var(--color-text-secondary)',
                          fontSize: '14px', fontWeight: '500', minWidth: '60px'
                        }}>
                          {hideSingerQueue ? 'Hidden' : 'Visible'}
                        </span>
                      </div>
                    </div>
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '12px 0',
                      borderTop: '1px solid var(--color-border)'
                    }}>
                      <div>
                        <span style={{ fontSize: '15px', fontWeight: '500' }}>Keep Rotation Singers Visible</span>
                        <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginTop: '2px' }}>
                          When singer-only queue mode is enabled, keep rotation singers in the scroller even without queued songs
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0, marginLeft: '16px' }}>
                        <label style={{
                          position: 'relative',
                          display: 'inline-block',
                          width: '48px',
                          height: '24px',
                          opacity: hideSingerQueue ? 1 : 0.5
                        }}>
                          <input
                            type="checkbox"
                            checked={keepRotationScrollerSingers}
                            disabled={!hideSingerQueue}
                            onChange={e => {
                              const val = e.target.checked
                              setKeepRotationScrollerSingers(val)
                              updateOverlaySettings(overlayVisible, overlayHeight, qrSize, undefined, showRoller, showQrCode, hideSingerQueue, val)
                            }}
                            style={{ opacity: 0, width: 0, height: 0 }}
                          />
                          <span style={{
                            position: 'absolute', cursor: hideSingerQueue ? 'pointer' : 'not-allowed', top: 0, left: 0, right: 0, bottom: 0,
                            backgroundColor: keepRotationScrollerSingers ? '#10b981' : '#374151',
                            transition: '.4s', borderRadius: '34px'
                          }}>
                            <span style={{
                              position: 'absolute', height: '16px', width: '16px',
                              left: keepRotationScrollerSingers ? '28px' : '4px', bottom: '4px',
                              backgroundColor: 'white', transition: '.4s', borderRadius: '50%'
                            }}></span>
                          </span>
                        </label>
                        <span style={{
                          color: keepRotationScrollerSingers ? 'var(--color-success)' : 'var(--color-text-secondary)',
                          fontSize: '14px', fontWeight: '500', minWidth: '60px'
                        }}>
                          {keepRotationScrollerSingers ? 'Shown' : 'Hidden'}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Rotation Settings */}
                  <div className="settings-section">
                    <div className="settings-title">Rotation Settings</div>
                    <div style={{
                      padding: '16px',
                      background: 'var(--color-bg-secondary)',
                      borderRadius: '12px',
                      border: '1px solid var(--color-border)'
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                        <label className="form-label" style={{ marginBottom: 0, flex: 1 }}>
                          Rotation Type
                        </label>
                        <button
                          title="Learn about rotation types"
                          onClick={() => setShowRotationInfo(v => !v)}
                          style={{
                            background: 'transparent',
                            border: '1px solid var(--color-border)',
                            borderRadius: '50%',
                            width: '22px',
                            height: '22px',
                            cursor: 'pointer',
                            color: 'var(--color-text-secondary)',
                            fontSize: '12px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0,
                          }}
                        >
                          ℹ
                        </button>
                      </div>
                      {showRotationInfo && (
                        <div style={{
                          marginBottom: '14px',
                          padding: '12px',
                          background: 'var(--color-bg-primary)',
                          borderRadius: '8px',
                          border: '1px solid var(--color-border)',
                          fontSize: '13px',
                          color: 'var(--color-text-secondary)',
                          lineHeight: '1.6',
                        }}>
                          <ul style={{ margin: 0, paddingLeft: '16px' }}>
                            <li style={{ marginBottom: '6px' }}><strong style={{ color: 'var(--color-text-primary)' }}>Strict Round Robin</strong> — Each singer gets exactly one turn per round, cycling through in position order.</li>
                            <li style={{ marginBottom: '6px' }}><strong style={{ color: 'var(--color-text-primary)' }}>Least Recently Sung</strong> — The singer who has waited the longest since their last song goes next.</li>
                            <li style={{ marginBottom: '6px' }}><strong style={{ color: 'var(--color-text-primary)' }}>Signup Order</strong> — Singers perform in the order they joined the rotation list.</li>
                            <li style={{ marginBottom: '6px' }}><strong style={{ color: 'var(--color-text-primary)' }}>Song Queue Only</strong> — Songs play in the order they were requested, ignoring singer fairness.</li>
                            <li style={{ marginBottom: '6px' }}><strong style={{ color: 'var(--color-text-primary)' }}>Manual</strong> — You (the host) pick who goes next each time.</li>
                            <li><strong style={{ color: 'var(--color-text-primary)' }}>Hybrid</strong> — Round-robin base with host override priority support.</li>
                          </ul>
                        </div>
                      )}
                      <select
                        className="form-input"
                        value={rotationType}
                        disabled={savingRotationType}
                        onChange={e => updateRotationType(e.target.value)}
                        style={{ marginBottom: 0 }}
                      >
                        <option value="strict_round_robin">Strict Round Robin</option>
                        <option value="least_recently_sung">Least Recently Sung</option>
                        <option value="signup_order">Signup Order</option>
                        <option value="song_queue_only">Song Queue Only</option>
                        <option value="manual">Manual</option>
                        <option value="hybrid">Hybrid</option>
                      </select>
                      {savingRotationType && (
                        <p style={{ margin: '8px 0 0', fontSize: '13px', color: 'var(--color-text-secondary)' }}>
                          Saving…
                        </p>
                      )}
                    </div>
                  </div>
                  </div>{/* end scrollable body */}

                  <button
                    className="control-btn primary"
                    style={{ width: '100%', marginTop: '8px', flexShrink: 0 }}
                    onClick={() => setShowPlayerWindowControl(false)}
                  >
                    Done
                  </button>
                </div>
              </>
            )}

            {showBreakPlaylistModal && (
              <>
                <div className="modal-backdrop" onClick={closeBreakMusicManager} />
                <div className="modal break-manager-modal">
                  <div className="modal-header">
                    <h3 style={{ margin: 0 }}><MaterialIcon name="music_note" style={{ fontSize: 22, verticalAlign: 'text-bottom', marginRight: 8 }} />Manage Break Music</h3>
                    <button
                      title="Close"
                      style={{
                        border: 'none',
                        background: 'transparent',
                        color: 'var(--color-text-secondary)',
                        cursor: 'pointer',
                        fontSize: 20,
                        width: 36,
                        height: 36,
                        borderRadius: 8,
                        flexShrink: 0,
                      }}
                      onClick={closeBreakMusicManager}
                    >
                      <MaterialIcon name="close" />
                    </button>
                  </div>

                  <div className="break-manager-body">
                    <div className="break-manager-toolbar">
                      <label className="form-label" style={{ marginBottom: 6 }}>Saved Playlists</label>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <select
                          className="form-input"
                          value={selectedBreakPlaylistId}
                          onChange={(e) => setSelectedBreakPlaylistId(e.target.value)}
                          style={{ flex: 1, minWidth: 0, marginBottom: 0, padding: '10px 12px', fontSize: 13 }}
                        >
                          <option value="">Select a playlist</option>
                          {breakPlaylists.map((playlist) => (
                            <option key={playlist.id} value={playlist.id}>
                              {playlist.name}
                            </option>
                          ))}
                        </select>
                        <button
                          className="control-btn"
                          type="button"
                          title="Load selected playlist for break playback"
                          onClick={() => selectedBreakPlaylistId && loadBreakPlaylist(Number(selectedBreakPlaylistId))}
                          disabled={!selectedBreakPlaylistId}
                          style={{ padding: '10px 12px', minWidth: 44, flexShrink: 0 }}
                        >
                          <MaterialIcon name="download" />
                        </button>
                        <button
                          className="control-btn"
                          type="button"
                          title="Save playlist"
                          disabled={breakPlaylistTracks.length === 0}
                          onClick={saveBreakPlaylist}
                          style={{ padding: '10px 12px', flexShrink: 0 }}
                        >
                          <MaterialIcon name="save" />
                        </button>
                        <button
                          className="control-btn"
                          type="button"
                          title="Shuffle playlist"
                          disabled={breakPlaylistTracks.length < 2}
                          onClick={shuffleBreakPlaylist}
                          style={{ padding: '10px 12px', flexShrink: 0 }}
                        >
                          <MaterialIcon name="shuffle" />
                        </button>
                        <button
                          className="control-btn"
                          type="button"
                          title="Clear playlist"
                          disabled={breakPlaylistTracks.length === 0}
                          onClick={clearBreakPlaylist}
                          style={{ padding: '10px 12px', flexShrink: 0 }}
                        >
                          <MaterialIcon name="delete" />
                        </button>
                      </div>
                    </div>

                    <div className="break-manager-layout" ref={breakManagerLayoutRef}>
                      <div className="break-manager-panel" style={{ flex: `0 0 ${breakLibraryPanePercent}%` }}>
                        <div className="form-group" style={{ marginBottom: 12 }}>
                          <label className="form-label">Search Break Music</label>
                          <input
                            className="search-input"
                            placeholder="Search break tracks..."
                            value={breakSearchQuery}
                            onChange={(e) => setBreakSearchQuery(e.target.value)}
                            style={{ marginBottom: 0 }}
                          />
                        </div>

                        <div className="form-group" style={{ marginTop: 0, marginBottom: 12 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                            <label className="form-label" style={{ marginBottom: 0 }}>Search Table</label>
                            <div style={{ position: 'relative' }} ref={breakColumnMenuRef}>
                              <button
                                className="control-btn"
                                type="button"
                                onClick={() => setShowBreakColumnMenu((prev) => !prev)}
                                style={{ padding: '8px 10px', fontSize: 12 }}
                              >
                                <MaterialIcon name="view_column" style={{ fontSize: 16, verticalAlign: 'text-bottom', marginRight: 4 }} />Columns
                              </button>
                              {showBreakColumnMenu && (
                                <div className="break-columns-popover">
                                  {(['song', 'artist', 'genre', 'length', 'path'] as BreakColumnKey[]).map((column) => (
                                    <label key={column} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                                      <input
                                        type="checkbox"
                                        checked={breakColumns[column]}
                                        onChange={() => toggleBreakColumn(column)}
                                      />
                                      {column[0].toUpperCase() + column.slice(1)}
                                    </label>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="break-manager-card" style={{ flex: 1, overflow: 'auto' }}>
                          <div
                            style={{
                              display: 'grid',
                              gridTemplateColumns: buildBreakGridTemplate(),
                              gap: 8,
                              padding: '8px 10px',
                              fontSize: 12,
                              borderBottom: '1px solid var(--color-border)',
                              color: 'var(--color-text-secondary)',
                              fontWeight: 600
                            }}
                          >
                            <span style={{ textAlign: 'center' }}>
                              <button
                                title="Add all visible tracks to playlist"
                                onClick={addAllBreakTracksToPlaylist}
                                disabled={sortedFilteredBreakLibraryTracks.length === 0}
                                style={{ border: 'none', background: 'transparent', color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 14, padding: 0 }}
                              >
                                <MaterialIcon name="playlist_add" style={{ fontSize: 15, verticalAlign: 'text-bottom', marginRight: 3 }} />All
                              </button>
                            </span>
                            {breakColumnEnabled('song') && (
                              <div className="break-table-header-cell">
                                <button className="break-table-header-sort" onClick={() => toggleBreakSort('song')}>
                                  Song{breakSort.column === 'song' && <MaterialIcon name={breakSort.direction === 'asc' ? 'arrow_drop_up' : 'arrow_drop_down'} style={{ fontSize: 18, verticalAlign: 'text-bottom' }} />}
                                </button>
                                <div className="break-table-header-resizer" onMouseDown={(event) => startBreakColumnResize('song', event)} />
                              </div>
                            )}
                            {breakColumnEnabled('artist') && (
                              <div className="break-table-header-cell">
                                <button className="break-table-header-sort" onClick={() => toggleBreakSort('artist')}>
                                  Artist{breakSort.column === 'artist' && <MaterialIcon name={breakSort.direction === 'asc' ? 'arrow_drop_up' : 'arrow_drop_down'} style={{ fontSize: 18, verticalAlign: 'text-bottom' }} />}
                                </button>
                                <div className="break-table-header-resizer" onMouseDown={(event) => startBreakColumnResize('artist', event)} />
                              </div>
                            )}
                            {breakColumnEnabled('genre') && (
                              <div className="break-table-header-cell">
                                <button className="break-table-header-sort" onClick={() => toggleBreakSort('genre')}>
                                  Genre{breakSort.column === 'genre' && <MaterialIcon name={breakSort.direction === 'asc' ? 'arrow_drop_up' : 'arrow_drop_down'} style={{ fontSize: 18, verticalAlign: 'text-bottom' }} />}
                                </button>
                                <div className="break-table-header-resizer" onMouseDown={(event) => startBreakColumnResize('genre', event)} />
                              </div>
                            )}
                            {breakColumnEnabled('length') && (
                              <div className="break-table-header-cell">
                                <button className="break-table-header-sort" onClick={() => toggleBreakSort('length')}>
                                  Length{breakSort.column === 'length' && <MaterialIcon name={breakSort.direction === 'asc' ? 'arrow_drop_up' : 'arrow_drop_down'} style={{ fontSize: 18, verticalAlign: 'text-bottom' }} />}
                                </button>
                                <div className="break-table-header-resizer" onMouseDown={(event) => startBreakColumnResize('length', event)} />
                              </div>
                            )}
                            {breakColumnEnabled('path') && (
                              <div className="break-table-header-cell">
                                <button className="break-table-header-sort" onClick={() => toggleBreakSort('path')}>
                                  Path{breakSort.column === 'path' && <MaterialIcon name={breakSort.direction === 'asc' ? 'arrow_drop_up' : 'arrow_drop_down'} style={{ fontSize: 18, verticalAlign: 'text-bottom' }} />}
                                </button>
                                <div className="break-table-header-resizer" onMouseDown={(event) => startBreakColumnResize('path', event)} />
                              </div>
                            )}
                          </div>
                          {sortedFilteredBreakLibraryTracks.map((track) => (
                            <div
                              key={track.id}
                              draggable
                              onDragStart={(ev) => {
                                ev.dataTransfer.setData('text/plain', String(track.id))
                                setBreakDraggedPlaylistIndex(null)
                                setBreakDraggedTrackId(track.id)
                              }}
                              onDragEnd={() => setBreakDraggedTrackId(null)}
                              style={{
                                display: 'grid',
                                gridTemplateColumns: buildBreakGridTemplate(),
                                gap: 8,
                                padding: '8px 10px',
                                fontSize: 13,
                                borderBottom: '1px solid rgba(255,255,255,0.06)',
                                alignItems: 'center',
                                cursor: 'grab'
                              }}
                            >
                              <button
                                title="Add to playlist"
                                onClick={() => addBreakTrackToPlaylist(track)}
                                style={{ border: 'none', background: 'transparent', color: 'var(--color-text-primary)', cursor: 'pointer', fontSize: 16 }}
                              >
                                <MaterialIcon name="add" style={{ fontSize: 18 }} />
                              </button>
                              {breakColumnEnabled('song') && <span>{track.title}</span>}
                              {breakColumnEnabled('artist') && <span>{track.artist || '—'}</span>}
                              {breakColumnEnabled('genre') && <span>{track.genre || '—'}</span>}
                              {breakColumnEnabled('length') && <span>{formatDurationMs(track.duration_ms)}</span>}
                              {breakColumnEnabled('path') && (
                                <span title={track.file_path} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {track.file_path}
                                </span>
                              )}
                            </div>
                          ))}
                          {sortedFilteredBreakLibraryTracks.length === 0 && (
                            <div style={{ padding: 16, color: 'var(--color-text-secondary)' }}>No tracks found</div>
                          )}
                        </div>
                      </div>

                      <div className="break-manager-splitter" onMouseDown={startBreakPaneResize} />

                      <div className="break-manager-panel" style={{ flex: `1 1 ${100 - breakLibraryPanePercent}%` }}>
                        <div
                          className="break-manager-card"
                          onDragOver={(ev) => {
                            if (!canDropOnBreakPlaylist(ev)) return
                            ev.preventDefault()
                          }}
                          onDrop={(ev) => {
                            ev.preventDefault()
                            if (breakDraggedPlaylistIndex !== null) {
                              const playlist = breakPlaylistTracksRef.current
                              if (breakDraggedPlaylistIndex < 0 || breakDraggedPlaylistIndex >= playlist.length) return
                              const next = [...playlist]
                              const [item] = next.splice(breakDraggedPlaylistIndex, 1)
                              next.push(item)
                              setBreakPlaylistTracksAndSync(next)
                              setBreakDraggedPlaylistIndex(null)
                              return
                            }
                            const trackId = getBreakDraggedTrackId(ev)
                            if (!trackId) return
                            const track = breakLibraryTracks.find((t) => t.id === trackId)
                            if (track) addBreakTrackToPlaylist(track)
                            setBreakDraggedTrackId(null)
                          }}
                          style={{ flex: 1, overflow: 'auto' }}
                        >
                          {activeBreakPlaylistName && (
                            <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--color-border)', fontSize: 12, color: 'var(--color-text-secondary)' }}>
                              Loaded playlist: <strong style={{ color: 'var(--color-text-primary)' }}>{activeBreakPlaylistName}</strong>
                            </div>
                          )}
                          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--color-border)', fontSize: 13, color: 'var(--color-text-secondary)', display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                            <span>Playlist Tracks ({breakPlaylistTracks.length})</span>
                            <span>Total {formatDurationMs(breakPlaylistDurationMs)}</span>
                          </div>
                          {breakPlaylistTracks.map((track, index) => {
                            const isCurrent = currentBreakPlaylistRowIndex >= 0 && index === currentBreakPlaylistRowIndex
                            return (
                              <div
                                key={`${track.id}-${index}`}
                                className={`break-playlist-row ${breakDraggedPlaylistIndex === index ? 'dragging' : ''} ${isCurrent ? 'current' : ''}`}
                                draggable
                                onDragStart={() => {
                                  setBreakDraggedTrackId(null)
                                  setBreakDraggedPlaylistIndex(index)
                                }}
                                onDragEnd={() => setBreakDraggedPlaylistIndex(null)}
                                onDragOver={(ev) => {
                                  if (breakDraggedPlaylistIndex === null) return
                                  ev.preventDefault()
                                }}
                                onDrop={(ev) => {
                                  ev.preventDefault()
                                  if (breakDraggedPlaylistIndex !== null) {
                                    moveBreakTrackToPlaylistIndex(breakDraggedPlaylistIndex, index)
                                    setBreakDraggedPlaylistIndex(null)
                                    return
                                  }
                                  const trackId = getBreakDraggedTrackId(ev)
                                  if (!trackId) return
                                  const draggedTrack = breakLibraryTracks.find((t) => t.id === trackId)
                                  if (!draggedTrack) return
                                  const next = [...breakPlaylistTracksRef.current]
                                  next.splice(index, 0, draggedTrack)
                                  setBreakPlaylistTracksAndSync(next)
                                  setBreakDraggedTrackId(null)
                                }}
                              >
                                <span
                                  title="Drag to reorder playlist"
                                  style={{ color: 'var(--color-text-secondary)', cursor: 'grab', fontSize: 16, textAlign: 'center' }}
                                >
                                  <MaterialIcon name="drag_indicator" style={{ fontSize: 18 }} />
                                </span>
                                <div style={{ minWidth: 0 }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{track.title}</div>
                                    {isCurrent && (
                                      <span style={{ fontSize: 11, border: '1px solid var(--color-border-focus)', borderRadius: 999, padding: '1px 8px', color: 'var(--color-accent-hover)' }}>
                                        Now Playing
                                      </span>
                                    )}
                                  </div>
                                  <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                                    {track.artist || 'Unknown Artist'} • {formatDurationMs(track.duration_ms)}
                                  </div>
                                </div>
                                <div style={{ display: 'flex', gap: 4 }}>
                                  <button title="Move up" disabled={index === 0} onClick={() => moveBreakTrackInPlaylist(index, -1)} style={{ border: 'none', background: 'transparent', color: 'var(--color-text-primary)', cursor: 'pointer' }}><MaterialIcon name="keyboard_arrow_up" style={{ fontSize: 18 }} /></button>
                                  <button title="Move down" disabled={index === breakPlaylistTracks.length - 1} onClick={() => moveBreakTrackInPlaylist(index, 1)} style={{ border: 'none', background: 'transparent', color: 'var(--color-text-primary)', cursor: 'pointer' }}><MaterialIcon name="keyboard_arrow_down" style={{ fontSize: 18 }} /></button>
                                  <button title="Remove from playlist" onClick={() => removeBreakTrackFromPlaylist(index)} style={{ border: 'none', background: 'transparent', color: 'var(--color-danger)', cursor: 'pointer' }}><MaterialIcon name="delete" style={{ fontSize: 18 }} /></button>
                                </div>
                              </div>
                            )
                          })}
                          {breakPlaylistTracks.length === 0 && (
                            <div style={{ padding: 14, color: 'var(--color-text-secondary)' }}>
                              Drag tracks from the library table here.
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* Replace Song Modal - CLEANED UP */}
            {replacingId !== null && (
              <>
                <div className="modal-backdrop" onClick={closeReplaceModal} />
                <div className="modal">
                  <div className="modal-header">
                    <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="material-symbols-rounded" style={{ fontSize: 24 }}>contract_edit</span>
                      Replace Song
                    </h3>
                    <button
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--color-text-secondary)',
                        fontSize: 24,
                        cursor: 'pointer',
                        padding: '4px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '32px',
                        height: '32px',
                        borderRadius: '8px',
                        transition: 'all 0.3s ease'
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--color-bg-hover)'}
                      onMouseLeave={e => e.currentTarget. style.background = 'transparent'}
                      onClick={closeReplaceModal}
                    >
                      <MaterialIcon name="close" />
                    </button>
                  </div>

                  {/* Search Mode Toggle - Updated to not clear search */}
                  <div className="search-mode-toggle">
                    {localLibraryEnabled && (
                      <button
                        className={`mode-button ${replaceSearchMode === 'local' ? 'active' : ''}`}
                        onClick={() => setReplaceSearchMode('local')}
                      >
                        <MaterialIcon name="library_music" className="mode-icon" style={{ fontSize: 20, marginRight: 6 }} />
                        Local Library
                      </button>
                    )}

                    {externalLibraryEnabled && (
                      <button
                        className={`mode-button ${replaceSearchMode === 'karaoke-nerds' ? 'active karaoke-nerds' : ''}`}
                        onClick={() => setReplaceSearchMode('karaoke-nerds')}
                      >
                        <img
                          src="https://karaokenerds.com/Content/Icons/favicon.ico"
                          alt="Karaoke Nerds"
                          className="mode-icon"
                          style={{ width: "20px", height: "20px", marginRight: "6px" }}
                        />
                        Karaoke Nerds
                      </button>
                    )}

                    <button
                      className={`mode-button ${replaceSearchMode === 'url' ? 'active' : ''}`}
                      onClick={() => setReplaceSearchMode('url')}
                    >
                      <MaterialIcon name="link" style={{ fontSize: 18, marginRight: 6 }} /> URL
                    </button>
                  </div>

                  {/* Search or URL Input */}
                  {replaceSearchMode === 'url' ? (
                    <>
                      <div className="form-group">
                        <label className="form-label">Video URL</label>
                        <input
                          className="form-input"
                          placeholder="Enter YouTube or video URL..."
                          value={replaceUrl}
                          onChange={e => setReplaceUrl(e.target.value)}
                          autoFocus
                          style={{
                            width: '100%',
                            boxSizing: 'border-box',
                            marginBottom: '16px'
                          }}
                        />
                      </div>

                      <div className="form-group">
                        <label className="form-label">Song Title</label>
                        <input
                          className="form-input"
                          placeholder="Title (auto-filled from URL)"
                          value={replaceTitle}
                          onChange={e => setReplaceTitle(e.target.value)}
                          style={{
                            width: '100%',
                            boxSizing: 'border-box',
                            marginBottom: '16px'
                          }}
                        />
                      </div>

                      <div className="form-group">
                        <label className="form-label">Artist Name</label>
                        <input
                          className="form-input"
                          placeholder="Enter artist name..."
                          value={replaceArtist}
                          onChange={e => setReplaceArtist(e.target.value)}
                          style={{
                            width: '100%',
                            boxSizing: 'border-box',
                            marginBottom: '16px'
                          }}
                        />
                      </div>

                      <div className="form-group">
                        <label className="form-label">Disc ID (Optional)</label>
                        <input
                          className="form-input"
                          placeholder="Enter disc ID (e.g., SC123)..."
                          value={replaceDiscId}
                          onChange={e => setReplaceDiscId(e.target.value)}
                          style={{
                            width: '100%',
                            boxSizing: 'border-box',
                            marginBottom: '16px'
                          }}
                        />
                      </div>

                      <button
                        className="control-btn primary"
                        style={{ width: '100%', marginBottom: '16px' }}
                        onClick={() => replaceSongWithUrl(replacingId, replaceUrl, replaceTitle, replaceArtist)}
                        disabled={busy || !replaceUrl.trim() || !replaceTitle.trim()}
                      >
                        {busy ? (
                          <>
                            <span className="loading-spinner"></span> Replacing...
                          </>
                        ) : (
                          'Replace with URL'
                        )}
                      </button>

                      {allowDownloads && (
                        <button
                          className="control-btn success"
                          style={{ width: '100%', marginBottom: '16px' }}
                          onClick={() => downloadVideo(replaceUrl, replaceTitle, replaceArtist, undefined, replaceDiscId)} // brand=undefined, discId from user input
                          disabled={busy || !replaceUrl.trim() || !replaceTitle.trim() || downloadingTrack === replaceUrl}
                        >
                          {downloadingTrack === replaceUrl ? (
                            <>
                              <span className="loading-spinner"></span> Downloading...
                            </>
                          ) : (
                            <><MaterialIcon name="download" style={{ fontSize: 18, verticalAlign: 'text-bottom', marginRight: 6 }} /> Download to Library</>
                          )}
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <input
                        className="search-input"
                        placeholder={replaceSearchMode === 'local' ? "Search local library..." : "Search Karaoke Nerds..."}
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        autoFocus
                        style={{
                          width: '100%',
                          boxSizing: 'border-box'
                        }}
                      />

                      <div className="search-results" style={{
                        minHeight: '200px',
                        maxHeight: '400px',
                        marginBottom: '16px'
                      }}>
                        {searchResults.length === 0 ?  (
                          <div style={{
                            padding: '40px 20px',
                            textAlign: 'center',
                            color: 'var(--color-text-secondary)',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            minHeight: '200px'
                          }}>
                            {searchQuery ? (
                              <>
                                <MaterialIcon name="search" style={{ fontSize: 24, marginBottom: 12, opacity: 0.5 }} />
                                <div style={{ fontSize: '14px' }}>
                                  {replaceSearchMode === 'local' ? 'No local results found' : 'No Karaoke Nerds results found'}
                                </div>
                                <div style={{ fontSize: '12px', marginTop: '4px', opacity: 0.7 }}>
                                  Try a different search term
                                </div>
                              </>
                            ) : (
                              <>
                                <MaterialIcon name="music_note" style={{ fontSize: 32, marginBottom: 12, opacity: 0.3 }} />
                            <div style={{ fontSize: '14px' }}>
                              Start typing to search {replaceSearchMode === 'local' ? 'local library' : 'Karaoke Nerds'}
                            </div>
                          </>
                        )}
                      </div>
                    ) : (
                      <>
                        {replaceSearchMode === 'local' ? (
                          // Local library results
                          searchResults. map((track: any) => (
                            <div
                              key={track.id}
                              className="search-result"
                              onClick={() => replaceSong(replacingId, track. id)}
                            >
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {track. title || 'Unknown'}
                                </div>
                                <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {track.artist || 'Unknown'}
                                  {track.disc_id && (
                                    <span style={{
                                      marginLeft: 8,
                                      fontSize: 11,
                                      padding: '1px 6px',
                                      background: 'var(--color-bg-primary)',
                                      borderRadius: '4px',
                                      opacity: 0.8
                                    }}>
                                      {track.disc_id}
                                    </span>
                                  )}
                                </div>
                              </div>
                              <button
                                className="control-btn primary"
                                style={{
                                  padding: '6px 14px',
                                  fontSize: '13px',
                                  minWidth: '70px'
                                }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  replaceSong(replacingId, track.id);
                                }}
                              >
                                Select
                              </button>
                            </div>
                          ))
                        ) : (
                          // KaraokeNerds results
                          searchResults.map((track: any, idx: number) => (
                            <div
                              key={track.url || idx}
                              className="search-result"
                              onClick={() => replaceSongWithKaraokeNerds(replacingId, track)}
                            >
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {track.title || 'Unknown'}
                                </div>
                                <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {track.artist || 'Unknown'}
                                  {track.brand && (
                                    <span style={{
                                      marginLeft: 8,
                                      fontSize: 11,
                                      padding: '1px 6px',
                                      background: 'linear-gradient(135deg, rgba(124, 58, 237, 0.2), rgba(168, 85, 247, 0.2))',
                                      borderRadius: '4px',
                                      color: '#a855f7'
                                    }}>
                                      {track.brand}
                                    </span>
                                  )}
                                </div>
                              </div>
                              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                                {allowDownloads && (
                                  <button
                                    className="control-btn"
                                    style={{
                                      padding: '6px 14px',
                                      fontSize: '13px',
                                      minWidth: '70px',
                                      background: downloadingTrack === track.url ? 'var(--color-bg-secondary)' : 'linear-gradient(135deg, #10b981, #059669)',
                                      color: 'white'
                                    }}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      downloadVideo(track.url, track.title, track.artist, track.brand);
                                    }}
                                    disabled={busy || downloadingTrack === track.url}
                                    title="Download to local library"
                                  >
                                    {downloadingTrack === track.url ? <MaterialIcon name="hourglass_top" style={{ fontSize: 16, verticalAlign: 'text-bottom', marginRight: 4 }} /> : <MaterialIcon name="download" style={{ fontSize: 16, verticalAlign: 'text-bottom', marginRight: 4 }} />} Download
                                  </button>
                                )}
                                <button
                                  className="control-btn"
                                  style={{
                                    padding: '6px 14px',
                                    fontSize: '13px',
                                    minWidth: '70px',
                                    background: 'linear-gradient(135deg, #7c3aed, #a855f7)'
                                  }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    replaceSongWithKaraokeNerds(replacingId, track);
                                  }}
                                >
                                  Select
                                </button>
                              </div>
                            </div>
                          ))
                        )}
                      </>
                    )}
                  </div>
                    </>
                  )}

                  <button
                    className="control-btn"
                    style={{
                      width: '100%',
                      background: 'transparent',
                      border: '2px solid var(--color-border)'
                    }}
                    onClick={closeReplaceModal}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}

            {/* Manual Request Modal */}
            {showManualRequest && (
              <>
                <div className="modal-backdrop" onClick={resetManualRequestModal} />
                <div className="modal">
                  <div className="modal-header">
                    <h3 style={{ margin: 0 }}><MaterialIcon name="add" style={{ fontSize: 22, verticalAlign: 'text-bottom', marginRight: 8 }} />Add to Queue</h3>
                    <button
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--color-text-secondary)',
                        fontSize: 24,
                        cursor: 'pointer',
                        padding: '4px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '32px',
                        height: '32px',
                        borderRadius: '8px',
                        transition: 'all 0.3s ease'
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--color-bg-hover)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                      onClick={resetManualRequestModal}
                    >
                      <MaterialIcon name="close" />
                    </button>
                  </div>

                  {/* Singer Name Field — hidden when opened from singer modal */}
                  {manualRequestForSingerId ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'rgba(99,102,241,0.1)', borderRadius: 8, border: '1px solid rgba(99,102,241,0.2)' }}>
                      <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>Adding for:</span>
                      <strong style={{ fontSize: 13 }}><MaterialIcon name="mic_external_on" style={{ fontSize: 15, verticalAlign: 'text-bottom', marginRight: 3 }} />{manualRequestName}</strong>
                    </div>
                  ) : (
                  <div className="form-group" style={{ position: 'relative' }}>
                    <label className="form-label">Singer Name (Optional)</label>
                    <input
                      className="form-input"
                      placeholder="Enter singer name..."
                      value={manualRequestName}
                      autoComplete="off"
                      onChange={e => {
                        setManualRequestName(e.target.value)
                        setShowManualSingerSuggestions(true)
                        setManualSingerHighlightIndex(0)
                      }}
                      onFocus={() => {
                        setShowManualSingerSuggestions(true)
                        setManualSingerHighlightIndex(0)
                      }}
                      onBlur={() => {
                        window.setTimeout(() => setShowManualSingerSuggestions(false), 120)
                      }}
                      onKeyDown={e => {
                        if (!showManualSingerSuggestions || manualSingerSuggestions.length === 0) {
                          if (e.key === 'Escape') setShowManualSingerSuggestions(false)
                          return
                        }

                        if (e.key === 'ArrowDown') {
                          e.preventDefault()
                          setManualSingerHighlightIndex((idx) => (idx + 1) % manualSingerSuggestions.length)
                          return
                        }

                        if (e.key === 'ArrowUp') {
                          e.preventDefault()
                          setManualSingerHighlightIndex((idx) => (idx - 1 + manualSingerSuggestions.length) % manualSingerSuggestions.length)
                          return
                        }

                        if (e.key === 'Enter') {
                          e.preventDefault()
                          selectManualRequestSinger(manualSingerSuggestions[manualSingerHighlightIndex] ?? manualSingerSuggestions[0])
                          return
                        }

                        if (e.key === 'Escape') {
                          setShowManualSingerSuggestions(false)
                        }
                      }}
                      style={{
                        width: '100%',
                        boxSizing: 'border-box'
                      }}
                    />
                    {showManualSingerSuggestions && manualSingerSuggestions.length > 0 && (
                      <div className="manual-singer-suggestions">
                        {manualSingerSuggestions.map((singer, index) => (
                          <button
                            key={singer.publicUuid || singer.singerId || singer.displayName}
                            type="button"
                            className={`manual-singer-suggestion${index === manualSingerHighlightIndex ? ' active' : ''}`}
                            onMouseDown={(e) => {
                              e.preventDefault()
                              selectManualRequestSinger(singer)
                            }}
                          >
                            <span>{singer.displayName}</span>
                            <span className="manual-singer-suggestion-hint">Use existing singer</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  )}

                  {/* Mode Toggle */}
                  <div className="search-mode-toggle">
                    {localLibraryEnabled && (
                      <button
                        className={`mode-button ${manualRequestMode === 'local' ? 'active' : ''}`}
                        onClick={() => setManualRequestMode('local')}
                      >
                        <MaterialIcon name="library_music" className="mode-icon" style={{ fontSize: 20, marginRight: 6 }} />
                        Local
                      </button>
                    )}

                    {externalLibraryEnabled && (
                      <button
                        className={`mode-button ${manualRequestMode === 'external' ? 'active karaoke-nerds' : ''}`}
                        onClick={() => setManualRequestMode('external')}
                      >
                        <img
                          src="https://karaokenerds.com/Content/Icons/favicon.ico"
                          alt="Karaoke Nerds"
                          className="mode-icon"
                          style={{ width: "20px", height: "20px", marginRight: "6px" }}
                        />
                        External
                      </button>
                    )}

                    <button
                      className={`mode-button ${manualRequestMode === 'url' ? 'active' : ''}`}
                      onClick={() => setManualRequestMode('url')}
                    >
                      <MaterialIcon name="link" style={{ fontSize: 18, marginRight: 6 }} /> URL
                    </button>
                  </div>

                  {/* Search or URL Input */}
                  {manualRequestMode === 'url' ? (
                    <>
                      <div className="form-group">
                        <label className="form-label">Video URL</label>
                        <input
                          className="form-input"
                          placeholder="Enter YouTube or video URL..."
                          value={manualRequestUrl}
                          onChange={e => setManualRequestUrl(e.target.value)}
                          autoFocus
                          style={{
                            width: '100%',
                            boxSizing: 'border-box',
                            marginBottom: '16px'
                          }}
                        />
                      </div>

                      <div className="form-group">
                        <label className="form-label">Song Title</label>
                        <input
                          className="form-input"
                          placeholder="Title (auto-filled from URL)"
                          value={manualRequestTitle}
                          onChange={e => setManualRequestTitle(e.target.value)}
                          style={{
                            width: '100%',
                            boxSizing: 'border-box',
                            marginBottom: '16px'
                          }}
                        />
                      </div>

                      <div className="form-group">
                        <label className="form-label">Artist Name</label>
                        <input
                          className="form-input"
                          placeholder="Enter artist name..."
                          value={manualRequestArtist}
                          onChange={e => setManualRequestArtist(e.target.value)}
                          style={{
                            width: '100%',
                            boxSizing: 'border-box',
                            marginBottom: '16px'
                          }}
                        />
                      </div>

                      <div className="form-group">
                        <label className="form-label">Disc ID (Optional)</label>
                        <input
                          className="form-input"
                          placeholder="Enter disc ID (e.g., SC123)..."
                          value={manualRequestDiscId}
                          onChange={e => setManualRequestDiscId(e.target.value)}
                          style={{
                            width: '100%',
                            boxSizing: 'border-box',
                            marginBottom: '16px'
                          }}
                        />
                      </div>

                      <button
                        className="control-btn primary"
                        style={{ width: '100%', marginBottom: '16px' }}
                        onClick={addManualRequestUrl}
                        disabled={busy || !manualRequestUrl.trim() || !manualRequestTitle.trim()}
                      >
                        {busy ? (
                          <>
                            <span className="loading-spinner"></span> Adding...
                          </>
                        ) : (
                          'Add to Queue'
                        )}
                      </button>

                      {allowDownloads && (
                        <button
                          className="control-btn success"
                          style={{ width: '100%', marginBottom: '16px' }}
                          onClick={() => downloadVideo(manualRequestUrl, manualRequestTitle, manualRequestArtist, undefined, manualRequestDiscId)} // brand=undefined, discId from user input
                          disabled={busy || !manualRequestUrl.trim() || !manualRequestTitle.trim() || downloadingTrack === manualRequestUrl}
                        >
                          {downloadingTrack === manualRequestUrl ? (
                            <>
                              <span className="loading-spinner"></span> Downloading...
                            </>
                          ) : (
                            <><MaterialIcon name="download" style={{ fontSize: 18, verticalAlign: 'text-bottom', marginRight: 6 }} /> Download to Library</>
                          )}
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <input
                        className="search-input"
                        placeholder={manualRequestMode === 'local' ? "Search local library..." : "Search Karaoke Nerds..."}
                        value={manualRequestQuery}
                        onChange={e => setManualRequestQuery(e.target.value)}
                        autoFocus
                        style={{
                          width: '100%',
                          boxSizing: 'border-box'
                        }}
                      />

                      <div className="search-results" style={{
                        minHeight: '200px',
                        maxHeight: '400px',
                        marginBottom: '16px'
                      }}>
                        {manualRequestResults.length === 0 ? (
                          <div style={{
                            padding: '40px 20px',
                            textAlign: 'center',
                            color: 'var(--color-text-secondary)',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            minHeight: '200px'
                          }}>
                            {manualRequestQuery ? (
                              <>
                                <MaterialIcon name="search" style={{ fontSize: 24, marginBottom: 12, opacity: 0.5 }} />
                                <div style={{ fontSize: '14px' }}>
                                  {manualRequestMode === 'local' ? 'No local results found' : 'No external results found'}
                                </div>
                                <div style={{ fontSize: '12px', marginTop: '4px', opacity: 0.7 }}>
                                  Try a different search term
                                </div>
                              </>
                            ) : (
                              <>
                                <MaterialIcon name="music_note" style={{ fontSize: 32, marginBottom: 12, opacity: 0.3 }} />
                                <div style={{ fontSize: '14px' }}>
                                  Start typing to search {manualRequestMode === 'local' ? 'local library' : 'external library'}
                                </div>
                              </>
                            )}
                          </div>
                        ) : (
                          <>
                            {manualRequestMode === 'local' ? (
                              // Local library results
                              manualRequestResults.map((track: any) => (
                                <div
                                  key={track.id}
                                  className="search-result"
                                  onClick={() => addManualRequestLocal(track.id)}
                                >
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                      {track.title || 'Unknown'}
                                    </div>
                                    <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                      {track.artist || 'Unknown'}
                                      {track.disc_id && (
                                        <span style={{
                                          marginLeft: 8,
                                          fontSize: 11,
                                          padding: '1px 6px',
                                          background: 'var(--color-bg-primary)',
                                          borderRadius: '4px',
                                          opacity: 0.8
                                        }}>
                                          {track.disc_id}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                  <button
                                    className="control-btn primary"
                                    style={{
                                      padding: '6px 10px',
                                      fontSize: '13px',
                                      minWidth: '40px'
                                    }}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      addManualRequestLocal(track.id);
                                    }}
                                    disabled={busy}
                                    aria-label="Add to queue"
                                    title="Add to queue"
                                  >
                                    {busy ? '…' : <MaterialIcon name="add" style={{ fontSize: 16 }} />}
                                  </button>
                                </div>
                              ))
                            ) : (
                              // External results
                              manualRequestResults.map((track: any, idx: number) => (
                                <div
                                  key={track.url || idx}
                                  className="search-result"
                                  onClick={() => addManualRequestExternal(track)}
                                >
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                      {track.title || 'Unknown'}
                                    </div>
                                    <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                      {track.artist || 'Unknown'}
                                      {track.brand && (
                                        <span style={{
                                          marginLeft: 8,
                                          fontSize: 11,
                                          padding: '1px 6px',
                                          background: 'linear-gradient(135deg, rgba(124, 58, 237, 0.2), rgba(168, 85, 247, 0.2))',
                                          borderRadius: '4px',
                                          color: '#a855f7'
                                        }}>
                                          {track.brand}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                  <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                                    {allowDownloads && (
                                      <button
                                        className="control-btn"
                                        style={{
                                          padding: '6px 10px',
                                          fontSize: '13px',
                                          minWidth: '40px',
                                          background: downloadingTrack === track.url ? 'var(--color-bg-secondary)' : 'linear-gradient(135deg, #10b981, #059669)',
                                          color: 'white'
                                        }}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          downloadVideo(track.url, track.title, track.artist, track.brand);
                                        }}
                                        disabled={busy || downloadingTrack === track.url}
                                        aria-label={downloadingTrack === track.url ? 'Downloading to local library' : 'Download to local library'}
                                        title="Download to local library"
                                      >
                                        <MaterialIcon name={downloadingTrack === track.url ? 'hourglass_top' : 'download'} style={{ fontSize: 16 }} />
                                      </button>
                                    )}
                                    <button
                                      className="control-btn"
                                      style={{
                                        padding: '6px 10px',
                                        fontSize: '13px',
                                        minWidth: '40px',
                                        background: 'linear-gradient(135deg, #7c3aed, #a855f7)'
                                      }}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        addManualRequestExternal(track);
                                      }}
                                      disabled={busy}
                                      aria-label="Add to queue"
                                      title="Add to queue"
                                    >
                                      {busy ? '…' : <MaterialIcon name="add" style={{ fontSize: 16 }} />}
                                    </button>
                                  </div>
                                </div>
                              ))
                            )}
                          </>
                        )}
                      </div>
                    </>
                  )}

                  <button
                    className="control-btn"
                    style={{
                      width: '100%',
                      background: 'transparent',
                      border: '2px solid var(--color-border)'
                    }}
                    onClick={resetManualRequestModal}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// Inline Edit Helper Component
function InlineEdit({ value, onSave, disabled }: { value: string; onSave: (v: string) => void; disabled?: boolean }) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(value)

  useEffect(() => setVal(value), [value])

  if (! editing) {
    return (
      <span
        onClick={() => !disabled && setEditing(true)}
        style={{
          cursor: disabled ? 'default' : 'pointer',
          borderRadius: 4,
          textDecoration: 'underline',
          textDecorationStyle: 'dotted',
          textDecorationColor: 'var(--color-text-secondary)',
          display: 'inline-block'
        }}
      >
        {value || <span style={{ opacity: 0.6 }}>Click to set</span>}
      </span>
    )
  }

  return (
    <input
      autoFocus
      value={val}
      onChange={e => setVal(e.target.value)}
      onBlur={() => {
        setEditing(false);
        if (val !== value) onSave(val)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          (e.target as HTMLInputElement). blur()
        } else if (e.key === 'Escape') {
          setVal(value)
          setEditing(false)
        }
      }}
      style={{
        padding: '2px 6px',
        background: 'var(--color-bg-primary)',
        border: '1px solid var(--color-accent)',
        borderRadius: 4,
        color: 'var(--color-text-primary)',
        fontSize: 'inherit',
        fontFamily: 'inherit',
        minWidth: 100
      }}
      disabled={disabled}
    />
  )
}
