import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { API_BASE, api, getWsUrl } from "../api";
import type { OverlaySettings } from "../components/QueueOverlay";
import { parseZipMediaRef } from "../zipMediaRef";

type QItem = {
  id: number | string;
  track_id?: number | string;
  artist?: string;
  title?: string;
  requested_by?: string | null;
  status?: "queued" | "playing" | "finished" | string;
  kind?: "mp4" | "cdgmp3" | string;
  file_mp4?: string;
  file_mp3?: string;
  file_cdg?: string;
  path?: string;
  external_url?: string;
  source?: string;
  duration_ms?: number | null;
  key_adjustment?: number;
};

type BreakMusicState = {
  paused: boolean;
  crossfadeSeconds: number;
  volumePercent: number;
  elapsedSec: number;
  currentTrack: {
    id: number;
    title: string;
    artist: string | null;
    duration_ms: number | null;
    file_path: string;
  } | null;
};

type RotationScrollerSinger = {
  displayName: string;
  position: number;
  hasQueuedSong: boolean;
};

function getDefaultRequestsUrl(): string {
  if (typeof window === "undefined" || !window.location?.origin) {
    return "/requests";
  }
  return new URL("/requests", window.location.origin).toString();
}

function formatRequestsUrlForDisplay(value: string): string {
  try {
    const parsed = new URL(
      value,
      typeof window !== "undefined" && window.location?.origin
        ? window.location.origin
        : "http://localhost",
    );
    const trimmedPath = parsed.pathname
      .replace(/\/requests\/?$/i, "")
      .replace(/\/$/, "");
    return `${parsed.host}${trimmedPath}`;
  } catch {
    return value
      .replace(/^https?:\/\//i, "")
      .replace(/\/requests\/?$/i, "")
      .replace(/\/$/, "");
  }
}

// Helper function to extract YouTube video ID from URL
function getYouTubeVideoId(url: string): string | null {
  if (!url) return null;

  const normalizedUrl = url.trim();
  const directIdMatch = normalizedUrl.match(/^([a-zA-Z0-9_-]{11})$/);
  if (directIdMatch?.[1]) {
    return directIdMatch[1];
  }

  const normalizeVideoId = (candidate: string | null | undefined) =>
    candidate && /^[a-zA-Z0-9_-]{11}$/.test(candidate) ? candidate : null;

  try {
    const parsedUrl = new URL(normalizedUrl);
    const hostname = parsedUrl.hostname.toLowerCase().replace(/^www\./, "");
    const segments = parsedUrl.pathname.split("/").filter(Boolean);

    if (hostname === "youtu.be") {
      return normalizeVideoId(segments[0]);
    }

    if (
      hostname.endsWith("youtube.com") ||
      hostname.endsWith("youtube-nocookie.com")
    ) {
      const queryVideoId = normalizeVideoId(parsedUrl.searchParams.get("v"));
      if (queryVideoId) return queryVideoId;

      if (
        segments[0] === "embed" ||
        segments[0] === "shorts" ||
        segments[0] === "live"
      ) {
        return normalizeVideoId(segments[1]);
      }
    }

  } catch {
    return null;
  }

  return null;
}

function describeYouTubeIframeError(code: unknown): string {
  switch (Number(code)) {
    case 2:
      return "The YouTube video id or request parameters are invalid.";
    case 5:
      return "The video cannot be played by the HTML5 YouTube player.";
    case 100:
      return "The YouTube video was not found or is private.";
    case 101:
    case 150:
      return "The video owner does not allow embedded playback.";
    case 153:
      return "YouTube rejected the embedded player configuration, usually because the request did not include an acceptable HTTP Referer.";
    default:
      return "The YouTube iframe player reported an unknown playback error.";
  }
}

// Helper function to validate duration values
function isValidDuration(duration: number | null | undefined): boolean {
  return (
    duration != null && !isNaN(duration) && isFinite(duration) && duration > 0
  );
}

/**
 * Format a singer's display name.
 * If short=true and the name has a first + last component, return "First L."
 */
function formatSingerName(
  name: string | null | undefined,
  short = false,
): string {
  if (!name) return "Anonymous";
  if (!short) return name;
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

const AUTOPLAY_UNMUTE_DELAY_MS = 100; // Delay before unmuting video after autoplay starts
const DEFAULT_OVERLAY_SETTINGS: OverlaySettings = {
  visible: true,
  height: 90,
  qrSize: 60,
  customMessage: "",
  showRoller: true,
  showQrCode: true,
  hideSingerQueue: false,
  keepRotationScrollerSingers: false,
  showRequestsUrl: true,
};

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return fallback;
}

function normalizeOverlaySettings(value: unknown): OverlaySettings {
  if (!value || typeof value !== "object") {
    return DEFAULT_OVERLAY_SETTINGS;
  }
  const settings = value as Partial<OverlaySettings>;
  return {
    visible: parseBoolean(settings.visible, DEFAULT_OVERLAY_SETTINGS.visible),
    height:
      typeof settings.height === "number"
        ? settings.height
        : DEFAULT_OVERLAY_SETTINGS.height,
    qrSize:
      typeof settings.qrSize === "number"
        ? settings.qrSize
        : DEFAULT_OVERLAY_SETTINGS.qrSize,
    customMessage:
      typeof settings.customMessage === "string"
        ? settings.customMessage
        : DEFAULT_OVERLAY_SETTINGS.customMessage,
    showRoller: parseBoolean(
      settings.showRoller,
      DEFAULT_OVERLAY_SETTINGS.showRoller,
    ),
    showQrCode: parseBoolean(
      settings.showQrCode,
      DEFAULT_OVERLAY_SETTINGS.showQrCode,
    ),
    hideSingerQueue: parseBoolean(
      settings.hideSingerQueue,
      DEFAULT_OVERLAY_SETTINGS.hideSingerQueue,
    ),
    keepRotationScrollerSingers: parseBoolean(
      settings.keepRotationScrollerSingers,
      DEFAULT_OVERLAY_SETTINGS.keepRotationScrollerSingers,
    ),
    showRequestsUrl: parseBoolean(
      settings.showRequestsUrl,
      DEFAULT_OVERLAY_SETTINGS.showRequestsUrl,
    ),
  };
}

export default function Player() {
  const [queue, setQueue] = useState<QItem[]>([]);
  const [now, setNow] = useState<QItem | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const [needsUserInteraction, setNeedsUserInteraction] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isYouTube, setIsYouTube] = useState(false);
  const [youtubeVideoId, setYoutubeVideoId] = useState<string | null>(null);
  const [overlaySettings, setOverlaySettings] = useState<OverlaySettings>(
    DEFAULT_OVERLAY_SETTINGS,
  );
  const [requestsUrl, setRequestsUrl] = useState(getDefaultRequestsUrl);
  const [rotationScrollerSingers, setRotationScrollerSingers] = useState<
    RotationScrollerSinger[]
  >([]);
  const [autoPlay, setAutoPlay] = useState(false);
  const [autoPlayDelay, setAutoPlayDelay] = useState(5);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [manualStop, setManualStop] = useState(false);
  const [breakMusicState, setBreakMusicState] = useState<BreakMusicState>({
    paused: false,
    crossfadeSeconds: 3,
    volumePercent: 100,
    elapsedSec: 0,
    currentTrack: null,
  });
  const videoRef = useRef<HTMLVideoElement>(null);
  const breakAudioRef = useRef<HTMLAudioElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const hideControlsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const youtubePlayerRef = useRef<YT.Player | null>(null);
  const youtubeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const youtubeFallbackInFlightRef = useRef(false);
  const youtubeFallbackAttemptedRef = useRef<Set<string>>(new Set());
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wsHeartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const breakTimingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const breakFadeRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const breakShouldPlayRef = useRef(false);
  const breakTrackIdRef = useRef<number | null>(null);
  const breakTrackSrcRef = useRef<string>("");
  const hideSingerQueueEnabled = overlaySettings.hideSingerQueue;
  const keepRotationScrollerSingersEnabled =
    hideSingerQueueEnabled && overlaySettings.keepRotationScrollerSingers;
  const splashRequestsUrl = useMemo(
    () => formatRequestsUrlForDisplay(requestsUrl),
    [requestsUrl],
  );

  // Force dark theme
  useEffect(() => {
    const prevBg = document.body.style.background;
    const prevColor = document.body.style.color;
    const prevScheme = document.documentElement.style.colorScheme;
    document.documentElement.style.colorScheme = "dark";
    document.body.style.background = "#000";
    document.body.style.color = "#e5e7eb";
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";

    const els: HTMLElement[] = Array.from(
      document.querySelectorAll("nav, header, .top-shortcuts"),
    ) as HTMLElement[];
    els.forEach((e) => (e.style.display = "none"));

    if (!(window as any).YT) {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      const firstScriptTag = document.getElementsByTagName("script")[0];
      firstScriptTag.parentNode?.insertBefore(tag, firstScriptTag);
    }

    return () => {
      document.documentElement.style.colorScheme = prevScheme;
      document.body.style.background = prevBg;
      document.body.style.color = prevColor;
      document.body.style.margin = "";
      document.body.style.overflow = "";
      els.forEach((e) => (e.style.display = ""));
    };
  }, []);

  // Handle mouse movement for controls visibility
  const handleMouseMove = () => {
    setShowControls(true);
    if (hideControlsTimer.current) {
      clearTimeout(hideControlsTimer.current);
    }
    hideControlsTimer.current = setTimeout(() => {
      setShowControls(false);
    }, 3000);
  };

  useEffect(() => {
    return () => {
      if (hideControlsTimer.current) {
        clearTimeout(hideControlsTimer.current);
      }
      if (breakTimingRef.current) {
        clearInterval(breakTimingRef.current);
      }
      if (breakFadeRef.current) {
        clearInterval(breakFadeRef.current);
      }
    };
  }, []);

  // Fullscreen handling
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);

    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener(
        "webkitfullscreenchange",
        handleFullscreenChange,
      );
    };
  }, []);

  const toggleFullscreen = async () => {
    if (!document.fullscreenElement) {
      await containerRef.current?.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  };

  // Handle play button click
  const handlePlayClick = async () => {
    const v = videoRef.current;
    if (!v) return;

    try {
      await v.play();
      setNeedsUserInteraction(false);
      setIsPlaying(true);
    } catch (err) {
      console.error("Play failed:", err);
    }
  };

  // Fetch queue + determine current
  const refresh = useCallback(async () => {
    const [q, rotationSingers] = await Promise.all([
      api("/api/queue") as Promise<QItem[]>,
      api("/api/overlay/rotation-singers")
        .then((rows: RotationScrollerSinger[]) => rows)
        .catch(() => [] as RotationScrollerSinger[]),
    ]);
    setQueue(q);
    setRotationScrollerSingers(rotationSingers);
    const cur = q.find((x) => x.status === "playing") || null;
    setNow((prev) => {
      // No change: nothing was playing, nothing is playing now
      if (!prev && !cur) return null;
      // Song started: nothing was playing, now something is playing
      if (!prev && cur) return cur;
      // Song stopped: something was playing, now nothing is playing
      if (prev && !cur) return null;
      // Song changed: different song is now playing
      if (prev && cur && String(prev.id) !== String(cur.id)) return cur;
      // Same queue entry was replaced with another track; reload playback.
      if (prev && cur && String(prev.track_id) !== String(cur.track_id))
        return cur;
      // Same song is still playing - don't update to avoid triggering re-renders
      // that could restart the video
      return prev;
    });
  }, []);

  const refreshBreakMusicState = useCallback(async () => {
    try {
      const state = await api("/api/break-music/state");
      setBreakMusicState({
        paused: !!state.paused,
        crossfadeSeconds:
          typeof state.crossfadeSeconds === "number"
            ? state.crossfadeSeconds
            : 3,
        volumePercent:
          typeof state.volumePercent === "number"
            ? Math.max(0, Math.min(100, Math.round(state.volumePercent)))
            : 100,
        elapsedSec: typeof state.elapsedSec === "number" ? state.elapsedSec : 0,
        currentTrack: state.currentTrack || null,
      });
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    refresh();
    refreshBreakMusicState();
    // Fetch player state to initialize manualStop (handles page reload after stop was selected)
    api("/api/player/state")
      .then((state: { manualStop: boolean }) => {
        setManualStop(state.manualStop);
      })
      .catch(() => {
        // Use default (false) on error
      });
  }, []);

  // Fetch initial overlay settings
  useEffect(() => {
    api("/api/overlay/settings")
      .then((settings: OverlaySettings) => {
        setOverlaySettings(normalizeOverlaySettings(settings));
      })
      .catch(() => {
        // Use defaults on error
      });
  }, []);

  useEffect(() => {
    api("/api/settings/public")
      .then((settings: { "requests.url"?: string }) => {
        if (
          typeof settings["requests.url"] === "string" &&
          settings["requests.url"].trim()
        ) {
          setRequestsUrl(settings["requests.url"]);
        }
      })
      .catch(() => {
        // Keep the client-derived fallback URL on error
      });
  }, []);

  // Fetch initial autoplay settings
  useEffect(() => {
    api("/api/autoplay/settings")
      .then((settings: { enabled: boolean; delay: number }) => {
        setAutoPlay(settings.enabled);
        // Only update delay if it's different from current value
        setAutoPlayDelay((prevDelay) => {
          if (prevDelay !== settings.delay) {
            return settings.delay;
          }
          return prevDelay;
        });
      })
      .catch(() => {
        // Use defaults on error
      });
  }, []);

  // WebSocket live updates
  useEffect(() => {
    function connect() {
      try {
        wsRef.current = new WebSocket(getWsUrl());
        wsRef.current.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            if (
              msg.type === "library.scanned" ||
              msg.type === "queue.updated" ||
              msg.type === "player.updated" ||
              msg.type === "player.play" ||
              msg.type === "player.next" ||
              msg.type === "player.stop"
            ) {
              refresh();
              if (msg.type === "player.stop") {
                setManualStop(true);
              } else if (
                msg.type === "player.play" ||
                msg.type === "player.next"
              ) {
                setManualStop(false);
              }
            }
            if (msg.type === "break_music.updated") {
              refreshBreakMusicState();
            }
            // Handle overlay settings updates
            if (msg.type === "overlay.settings") {
              const settings = normalizeOverlaySettings(msg);
              setOverlaySettings(settings);
              if (!settings.keepRotationScrollerSingers) {
                setRotationScrollerSingers([]);
              } else {
                refresh();
              }
            }
            // Handle autoplay settings updates
            if (msg.type === "autoplay.settings") {
              if (typeof msg.enabled === "boolean") {
                setAutoPlay(msg.enabled);
              }
              if (typeof msg.delay === "number") {
                // Only update delay if it actually changed to avoid resetting countdown
                setAutoPlayDelay((prevDelay) => {
                  if (prevDelay !== msg.delay) {
                    return msg.delay;
                  }
                  return prevDelay;
                });
              }
            }
          } catch {
            /* ignore */
          }
        };
        wsRef.current.onclose = () => {
          console.log("WebSocket closed, reconnecting...");
          wsRef.current = null;
          // Clear heartbeat timer
          if (wsHeartbeatRef.current) {
            clearInterval(wsHeartbeatRef.current);
            wsHeartbeatRef.current = null;
          }
          setTimeout(connect, 1000);
        };
        wsRef.current.onerror = (err) => {
          console.error("WebSocket error:", err);
        };
        wsRef.current.onopen = () => {
          console.log("WebSocket connected");
          // Re-fetch player state on reconnect to restore manualStop
          // (handles WS disconnect that occurred while stop was selected)
          api("/api/player/state")
            .then((state: { manualStop: boolean }) => {
              setManualStop(state.manualStop);
            })
            .catch(() => {});
          // Start heartbeat - send a message every 45 seconds to keep connection alive
          // This is in addition to server's ping/pong mechanism
          wsHeartbeatRef.current = setInterval(() => {
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
              // Send a lightweight heartbeat message
              wsRef.current.send(JSON.stringify({ type: "heartbeat" }));
            }
          }, 45000);
        };
      } catch {
        setTimeout(connect, 1500);
      }
    }
    connect();
    return () => {
      if (wsHeartbeatRef.current) {
        clearInterval(wsHeartbeatRef.current);
      }
      wsRef.current?.close();
    };
  }, [refresh, refreshBreakMusicState]);

  useEffect(() => {
    if (!now) {
      setIsYouTube(false);
      setYoutubeVideoId(null);
      if (youtubePlayerRef.current) {
        try {
          youtubePlayerRef.current.stopVideo();
        } catch (err) {
          console.warn("Failed to stop YouTube player:", err);
        }
        youtubePlayerRef.current = null;
      }
      if (youtubeTimerRef.current) {
        clearInterval(youtubeTimerRef.current);
        youtubeTimerRef.current = null;
      }
      return;
    }

    const videoId = now.external_url ? getYouTubeVideoId(now.external_url) : null;
    setIsYouTube(Boolean(videoId));
    setYoutubeVideoId(videoId);
  }, [now?.id, now?.external_url]);

  // Build the media URL - pure computation, no side effects
  const mediaSrc = useMemo(() => {
    if (!now) return "";
    const keyAdjustment = now.key_adjustment ?? 0;

    // Handle external URLs (e.g., from Karaoke Nerds)
    if (now.external_url) {
      const videoId = getYouTubeVideoId(now.external_url);
      if (videoId) {
        return "";
      }
      // For non-YouTube external URLs, use video element
      return now.external_url;
    }

    // Handle MP4 files
    if (now.kind === "mp4" && now.file_mp4) {
      const params = new URLSearchParams();
      params.set("path", now.file_mp4);
      if (keyAdjustment) {
        params.set("pitch", String(keyAdjustment));
      }
      return `${API_BASE}/media/mp4stream?${params.toString()}`;
    }

    // Handle CDG+MP3 files
    if (now.kind === "cdgmp3" && now.file_cdg && now.file_mp3) {
      const isFromZip =
        now.file_cdg.startsWith("zip://") || now.file_mp3.startsWith("zip://");

      const params = new URLSearchParams();

      if (isFromZip) {
        const parsedCdg = parseZipMediaRef(now.file_cdg);
        const parsedMp3 = parseZipMediaRef(now.file_mp3);
        const zipFile = parsedCdg?.zipPath || parsedMp3?.zipPath || "";
        const cdgEntry = parsedCdg?.entryName || "";
        const mp3Entry = parsedMp3?.entryName || "";

        params.set("file", zipFile);
        params.set("cdg", cdgEntry || "");
        params.set("mp3", mp3Entry || "");
      } else {
        params.set("cdg", now.file_cdg);
        params.set("mp3", now.file_mp3);
      }
      if (keyAdjustment) {
        params.set("pitch", String(keyAdjustment));
      }

      return `${API_BASE}/media/cdgmp4?${params.toString()}`;
    }

    return "";
  }, [
    now?.id,
    now?.track_id,
    now?.external_url,
    now?.kind,
    now?.file_mp4,
    now?.file_cdg,
    now?.file_mp3,
    now?.key_adjustment,
  ]);

  // Load video when mediaSrc changes or YouTube video changes
  useEffect(() => {
    // Reset states when source changes
    setNeedsUserInteraction(false);
    setIsPlaying(false);

    if (isYouTube && youtubeVideoId) {
      setIsPlaying(true);
      return;
    }

    // Handle regular video element
    const v = videoRef.current;
    if (!v || !mediaSrc) return;

    v.src = mediaSrc;
    v.load();

    // Try to play automatically
    const playVideo = async () => {
      try {
        // Try with muted first (usually works)
        v.muted = true;
        await v.play();
        setIsPlaying(true);

        // Wait for video to actually start playing before unmuting
        // This prevents browsers from blocking autoplay after unmute
        await new Promise((resolve) =>
          setTimeout(resolve, AUTOPLAY_UNMUTE_DELAY_MS),
        );

        v.muted = false;
      } catch (err) {
        // If even muted play fails, we need user interaction
        v.muted = false;
        setNeedsUserInteraction(true);
      }
    };

    playVideo();
  }, [mediaSrc, isYouTube, youtubeVideoId]);

  // Helper function to send timing updates
  const sendTimingUpdate = useCallback(
    (currentTime: number, duration: number, queueId: number | string) => {
      if (isValidDuration(duration)) {
        api("/api/player/timing", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            currentTime,
            duration,
            queueId,
          }),
        }).catch((err) => {
          console.error("Failed to send timing update:", err);
        });
      }
    },
    [],
  );

  const fallbackYouTubeToDownloadedTrack = useCallback(
    async (errorCode?: number | string) => {
      if (!now?.id || !now.external_url || !getYouTubeVideoId(now.external_url))
        return;
      const attemptKey = `${now.id}:${now.external_url}`;
      if (
        youtubeFallbackInFlightRef.current ||
        youtubeFallbackAttemptedRef.current.has(attemptKey)
      )
        return;

      youtubeFallbackInFlightRef.current = true;
      youtubeFallbackAttemptedRef.current.add(attemptKey);
      try {
        await api("/api/player/youtube-fallback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: now.id, errorCode }),
        });
        await refresh();
      } catch (err) {
        console.error("YouTube fallback download failed:", err);
      } finally {
        youtubeFallbackInFlightRef.current = false;
      }
    },
    [now?.id, now?.external_url, refresh],
  );

  const fadeBreakAudioTo = useCallback(
    (
      targetVolume: number,
      durationSeconds: number,
      onComplete?: () => void,
    ) => {
      const audio = breakAudioRef.current;
      if (!audio) return;

      if (breakFadeRef.current) {
        clearInterval(breakFadeRef.current);
        breakFadeRef.current = null;
      }

      const start = audio.volume;
      const clampedTarget = Math.max(0, Math.min(1, targetVolume));
      if (durationSeconds <= 0) {
        audio.volume = clampedTarget;
        onComplete?.();
        return;
      }

      const steps = Math.max(1, Math.floor((durationSeconds * 1000) / 100));
      let currentStep = 0;
      breakFadeRef.current = setInterval(() => {
        currentStep += 1;
        const t = Math.min(1, currentStep / steps);
        audio.volume = start + (clampedTarget - start) * t;
        if (t >= 1) {
          if (breakFadeRef.current) {
            clearInterval(breakFadeRef.current);
            breakFadeRef.current = null;
          }
          onComplete?.();
        }
      }, 100);
    },
    [],
  );

  // Monitor video play/pause state and handle video end
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !now) return;

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleEnded = () => {
      setIsPlaying(false);

      // Send final timing update when video ends
      // Prioritize database duration when:
      // 1. It's a CDG file (fragmented MP4 streams may report incorrect durations), OR
      // 2. Pitch adjustment is applied (re-encoding creates fragmented streams)
      let duration: number | undefined;
      const hasPitchAdjustment =
        now.key_adjustment !== undefined && now.key_adjustment !== 0;

      if (
        (now.kind === "cdgmp3" || hasPitchAdjustment) &&
        now.duration_ms &&
        now.duration_ms > 0
      ) {
        // For CDG files or pitch-shifted tracks, always use database duration
        duration = now.duration_ms / 1000;
      } else {
        // For regular MP4 files without pitch adjustment, try video element first
        duration = v.duration;
        if (!isValidDuration(duration)) {
          if (now.duration_ms) {
            duration = now.duration_ms / 1000;
          }
        }
      }

      // Send currentTime = duration to ensure Host detects song completion
      if (isValidDuration(duration)) {
        console.log("Video ended, sending final timing update:", duration);
        sendTimingUpdate(duration, duration, now.id);
      } else {
        // No valid duration available — send a sentinel value so the server
        // still marks the song as finished and advances to the next song.
        console.warn(
          "Video ended but no valid duration available; sending sentinel timing update",
        );
        sendTimingUpdate(1, 1, now.id);
      }
    };

    v.addEventListener("play", handlePlay);
    v.addEventListener("pause", handlePause);
    v.addEventListener("ended", handleEnded);

    return () => {
      v.removeEventListener("play", handlePlay);
      v.removeEventListener("pause", handlePause);
      v.removeEventListener("ended", handleEnded);
    };
  }, [now, sendTimingUpdate]);

  // Report timing updates to server for Host page
  useEffect(() => {
    if (!now) return;

    if (isYouTube) return;

    const v = videoRef.current;
    if (!v) return;

    // Send timing updates every 1 second
    const intervalId = setInterval(() => {
      const currentTime = v.currentTime || 0;

      // Prioritize database duration over video element duration when:
      // 1. It's a CDG file (fragmented MP4 streams may report incorrect durations), OR
      // 2. Pitch adjustment is applied (re-encoding creates fragmented streams)
      let duration: number | undefined;
      const hasPitchAdjustment =
        now.key_adjustment !== undefined && now.key_adjustment !== 0;

      if (
        (now.kind === "cdgmp3" || hasPitchAdjustment) &&
        now.duration_ms &&
        now.duration_ms > 0
      ) {
        // For CDG files or pitch-shifted tracks, always use database duration if available
        // because re-encoded streams produce fragmented MP4s with unreliable duration
        duration = now.duration_ms / 1000; // Convert ms to seconds
      } else {
        // For regular MP4 files without pitch adjustment, try video element first
        duration = v.duration;

        // Fall back to database duration if video element can't provide it
        if (!isValidDuration(duration)) {
          if (now.duration_ms && now.duration_ms > 0) {
            duration = now.duration_ms / 1000; // Convert ms to seconds
          }
        }
      }

      // Send timing update - only if we have a valid duration
      if (isValidDuration(duration)) {
        sendTimingUpdate(currentTime, duration, now.id);
      } else {
        // Log when we can't get duration (for debugging)
        console.warn(
          `Cannot send timing update for song ${now.id}: duration not available (video.duration=${v.duration}, db.duration_ms=${now.duration_ms})`,
        );
      }
    }, 1000);

    return () => clearInterval(intervalId);
  }, [now, isYouTube, sendTimingUpdate]);

  // Report YouTube timing updates using the IFrame API. YouTube is attempted
  // through the iframe first; fallback download only starts after an iframe API
  // error such as embedding disabled (101/150).
  useEffect(() => {
    if (!now || !isYouTube || !youtubeVideoId) return;

    const playerId = "youtube-player-" + youtubeVideoId;
    const initPlayer = () => {
      const YT = (window as any).YT;
      if (!YT?.Player) {
        setTimeout(initPlayer, 100);
        return;
      }

      if (youtubeTimerRef.current) {
        clearInterval(youtubeTimerRef.current);
      }

      try {
        youtubePlayerRef.current = new YT.Player(playerId, {
          events: {
            onReady: (event: any) => {
              try {
                event.target.playVideo();
                event.target.unMute();
                event.target.setVolume(100);
              } catch (err) {
                console.error("Error starting YouTube iframe playback:", err);
              }

              youtubeTimerRef.current = setInterval(() => {
                try {
                  const currentTime = event.target.getCurrentTime();
                  const duration = event.target.getDuration();
                  if (isValidDuration(duration)) {
                    sendTimingUpdate(currentTime || 0, duration, now.id);
                  }
                } catch (err) {
                  console.error("Error getting YouTube iframe timing:", err);
                }
              }, 1000);
            },
            onStateChange: (event: any) => {
              if (event.data === 1) {
                try {
                  if (event.target.isMuted()) {
                    event.target.unMute();
                    event.target.setVolume(100);
                  }
                } catch (err) {
                  console.error("Error unmuting YouTube iframe:", err);
                }
              }
              if (event.data === 0) {
                try {
                  const duration = event.target.getDuration();
                  sendTimingUpdate(
                    isValidDuration(duration) ? duration : 1,
                    isValidDuration(duration) ? duration : 1,
                    now.id,
                  );
                } catch (err) {
                  console.error("Error sending final YouTube iframe timing:", err);
                  sendTimingUpdate(1, 1, now.id);
                }
              }
            },
            onError: (event: any) => {
              console.error("YouTube iframe error:", {
                code: event.data,
                message: describeYouTubeIframeError(event.data),
                videoId: youtubeVideoId,
                url: now.external_url,
                origin: window.location.origin,
                referrer: document.referrer,
                userAgent: navigator.userAgent,
              });
              void fallbackYouTubeToDownloadedTrack(event.data);
            },
          },
        });
      } catch (err) {
        console.error("Failed to initialize YouTube iframe player:", err);
      }
    };

    const initTimer = setTimeout(initPlayer, 500);

    return () => {
      clearTimeout(initTimer);
      if (youtubeTimerRef.current) {
        clearInterval(youtubeTimerRef.current);
        youtubeTimerRef.current = null;
      }
      if (youtubePlayerRef.current) {
        try {
          youtubePlayerRef.current.stopVideo();
        } catch (err) {
          console.warn("Failed to stop YouTube iframe player:", err);
        }
        youtubePlayerRef.current = null;
      }
    };
  }, [
    now,
    isYouTube,
    youtubeVideoId,
    sendTimingUpdate,
    fallbackYouTubeToDownloadedTrack,
  ]);

  useEffect(() => {
    const audio = breakAudioRef.current;
    if (!audio) return;

    const track = breakMusicState.currentTrack;
    const shouldPlayBreak =
      !now && !breakMusicState.paused && !!track?.file_path;
    const fadeDuration = Math.max(0, breakMusicState.crossfadeSeconds || 0);
    const targetVolume = Math.max(
      0,
      Math.min(1, (breakMusicState.volumePercent ?? 100) / 100),
    );
    const trackId = track?.id ?? null;

    if (!shouldPlayBreak) {
      breakShouldPlayRef.current = false;
      breakTrackIdRef.current = trackId;
      // Reset the src reference so the next resume always calls audio.load() before
      // audio.play(). Without this, browsers that suspend idle media elements would
      // silently fail to produce audio on resume even though play() appears to succeed.
      breakTrackSrcRef.current = "";
      const pauseTrackId = trackId;
      fadeBreakAudioTo(0, fadeDuration, () => {
        if (
          !breakShouldPlayRef.current &&
          breakTrackIdRef.current === pauseTrackId
        ) {
          audio.pause();
        }
      });
      return;
    }

    const src = `${API_BASE}/media/file?path=${encodeURIComponent(track.file_path)}`;
    const elementSrc = audio.getAttribute("src") || "";
    const srcChanged = breakTrackSrcRef.current !== src || elementSrc !== src;
    if (srcChanged) {
      audio.src = src;
      audio.load();
      breakTrackSrcRef.current = src;
    }
    if (
      breakMusicState.elapsedSec > 0 &&
      (srcChanged ||
        Math.abs((audio.currentTime || 0) - breakMusicState.elapsedSec) > 2)
    ) {
      audio.currentTime = breakMusicState.elapsedSec;
    }

    const run = async () => {
      try {
        const shouldRestartPlayback =
          srcChanged ||
          audio.paused ||
          !breakShouldPlayRef.current ||
          breakTrackIdRef.current !== trackId;

        if (shouldRestartPlayback) {
          audio.volume = 0;
          audio.muted = true;
          await audio.play();
          audio.muted = false;
          fadeBreakAudioTo(targetVolume, fadeDuration);
        } else if (Math.abs(audio.volume - targetVolume) > 0.01) {
          fadeBreakAudioTo(targetVolume, Math.min(1, fadeDuration || 0.5));
        }
      } catch {
        audio.muted = false;
        // ignore autoplay block for break audio
      }
    };
    breakShouldPlayRef.current = true;
    breakTrackIdRef.current = trackId;
    run();
  }, [
    now,
    breakMusicState.paused,
    breakMusicState.crossfadeSeconds,
    breakMusicState.volumePercent,
    breakMusicState.elapsedSec,
    breakMusicState.currentTrack?.id,
    breakMusicState.currentTrack?.file_path,
    fadeBreakAudioTo,
  ]);

  useEffect(() => {
    if (breakTimingRef.current) {
      clearInterval(breakTimingRef.current);
      breakTimingRef.current = null;
    }
    if (now || breakMusicState.paused || !breakMusicState.currentTrack?.id)
      return;

    breakTimingRef.current = setInterval(() => {
      refreshBreakMusicState().catch(() => {});
    }, 1000);

    return () => {
      if (breakTimingRef.current) {
        clearInterval(breakTimingRef.current);
        breakTimingRef.current = null;
      }
    };
  }, [breakMusicState.currentTrack?.id, breakMusicState.paused, now]);

  // Get next up singers
  const upNext = queue
    .filter((q) => q.status === "queued")
    .sort((a, b) => queue.indexOf(a) - queue.indexOf(b));

  // Memoize the queue count to avoid unnecessary effect re-runs
  const queuedCount = useMemo(() => upNext.length, [queue]);

  // Countdown timer for autoplay when no song is playing but queue has items
  useEffect(() => {
    // Clear existing countdown timer
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }

    // Only show countdown if:
    // 1. No song is currently playing
    // 2. Autoplay is enabled
    // 3. There are songs in the queue
    // 4. Host has not manually stopped playback
    if (!now && autoPlay && queuedCount > 0 && !manualStop) {
      // Capture the current autoplay delay value to use for this countdown
      // This ensures the countdown uses a consistent value even if settings change mid-countdown
      const delayToUse = autoPlayDelay;

      // Initialize countdown to autoplay delay
      setCountdown(delayToUse);

      // Start countdown timer
      countdownTimerRef.current = setInterval(() => {
        setCountdown((prev) => {
          if (prev === null || prev <= 0) {
            // Keep showing 0 until song starts (server controls actual autoplay)
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } else {
      setCountdown(null);
    }

    return () => {
      if (countdownTimerRef.current) {
        clearInterval(countdownTimerRef.current);
      }
    };
    // Note: We DO include autoPlayDelay so that when a new countdown starts, it uses the current setting
    // But this won't affect an already-running countdown since we capture the value in a local variable
  }, [now, autoPlay, queuedCount, autoPlayDelay, manualStop]);

  // Build ticker text with current singer and queue
  const tickerText = useMemo(() => {
    const rotationText = rotationScrollerSingers
      .slice(0, 8)
      .map((singer, idx) =>
        singer.hasQueuedSong
          ? `${idx + 1}. ${singer.displayName}`
          : `${idx + 1}. ${singer.displayName} (waiting)`,
      )
      .join(" • ");

    // If nothing is playing
    if (!now) {
      if (upNext.length === 0 && !rotationText) {
        // Show custom message at end if set, otherwise waiting message
        if (overlaySettings.customMessage) {
          return `🎵 Waiting for singers... Add your song from the request page! 📢 ${overlaySettings.customMessage}     🎵     🎵 Waiting for singers... Add your song from the request page! 📢 ${overlaySettings.customMessage}     🎵     `;
        }
        return "🎵 Waiting for singers... Add your song from the request page! 🎵     🎵 Waiting for singers... Add your song from the request page! 🎵     ";
      }

      // Show upcoming queue when nothing is playing
      const queueText =
        keepRotationScrollerSingersEnabled && rotationText
          ? rotationText
          : upNext
              .slice(0, 5)
              .map((item, idx) => {
                const singer = formatSingerName(item.requested_by, true);
                return `${idx + 1}. ${singer}`;
              })
              .join(" • ");

      // Add countdown info if autoplay is enabled and not manually stopped
      const countdownInfo =
        autoPlay && countdown !== null && !manualStop
          ? `⏱️ Starting in ${countdown}s... `
          : "";

      // Add custom message at the end if set
      const fullText = overlaySettings.customMessage
        ? `${countdownInfo}🎤 QUEUE: ${queueText} 📢 ${overlaySettings.customMessage}`
        : `${countdownInfo}🎤 QUEUE: ${queueText}`;
      return `${fullText}     🎵     ${fullText}     🎵     `;
    }

    // Current singer is playing - always show who is singing
    const current = hideSingerQueueEnabled
      ? now.requested_by
        ? `🎤 NOW SINGING: ${formatSingerName(now.requested_by)}`
        : `🎤 NOW PLAYING`
      : now.requested_by
        ? `🎤 NOW SINGING: ${formatSingerName(now.requested_by)}: ${now.artist || "Unknown"} — ${now.title || "Unknown"}`
        : `🎤 NOW PLAYING: ${now.artist || "Unknown"} — ${now.title || "Unknown"}`;

    // Build queue list
    const queueText =
      keepRotationScrollerSingersEnabled && rotationText
        ? rotationText
        : upNext
            .slice(0, 5)
            .map((item, idx) => {
              const singer = formatSingerName(item.requested_by, true);
              return `${idx + 1}. ${singer}`;
            })
            .join(" • ");

    // Combine with proper spacing, adding custom message at the end if set
    let fullText = queueText ? `${current} ⭐ UP NEXT: ${queueText}` : current;

    // Add custom message at the end if set
    if (overlaySettings.customMessage) {
      fullText += ` 📢 ${overlaySettings.customMessage}`;
    }

    // Repeat for smooth scrolling with divider
    return `${fullText}     🎵     ${fullText}     🎵     `;
  }, [
    now,
    upNext,
    overlaySettings.customMessage,
    hideSingerQueueEnabled,
    keepRotationScrollerSingersEnabled,
    rotationScrollerSingers,
    autoPlay,
    countdown,
    manualStop,
  ]);

  // Render the overlay (shown always, unless visibility is false)
  const renderOverlay = () => {
    if (!overlaySettings.visible) {
      return null;
    }

    // Calculate scale factor based on height (default 90px = 1.0 scale)
    const scaleFactor = overlaySettings.height / 90;
    const tickerHeight = Math.round(40 * scaleFactor);
    const tickerFontSize = Math.round(16 * scaleFactor);
    const padding = Math.round(15 * scaleFactor);
    const gap = Math.round(15 * scaleFactor);
    const borderRadius = Math.round(8 * scaleFactor);

    // QR size is controlled separately
    const qrSizeValue = overlaySettings.qrSize;
    const qrPadding = Math.max(4, Math.round(qrSizeValue / 12));
    const qrBorderRadius = Math.max(8, Math.round(qrSizeValue / 8));
    const qrBlockSize = qrSizeValue + qrPadding * 2;
    const qrOffset = 15;
    const leftInset = overlaySettings.showQrCode
      ? Math.max(padding, qrOffset + qrBlockSize + gap)
      : padding;

    return (
      <div
        className="controls-overlay"
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          background: "transparent",
          zIndex: 10,
          opacity: 1,
        }}
      >
        {/* QR Code */}
        {overlaySettings.showQrCode && (
          <div
            style={{
              position: "absolute",
              left: `${qrOffset}px`,
              bottom: `${qrOffset}px`,
              width: `${qrSizeValue}px`,
              height: `${qrSizeValue}px`,
              background: "white",
              borderRadius: `${qrBorderRadius}px`,
              padding: `${qrPadding}px`,
              boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
            }}
          >
            <img
              src={`${API_BASE}/api/qr`}
              alt="QR"
              style={{
                width: "100%",
                height: "100%",
                imageRendering: "crisp-edges",
              }}
              onError={(e) => {
                const target = e.currentTarget as HTMLImageElement;
                target.style.display = "none";
              }}
            />
          </div>
        )}

        <div
          style={{
            height: `${overlaySettings.height}px`,
            display: "flex",
            alignItems: "flex-end",
            padding: `${padding}px`,
            paddingLeft: `${leftInset}px`,
            gap: `${gap}px`,
          }}
        >
          {/* Ticker container - takes full remaining width */}
          {overlaySettings.showRoller && (
            <div
              style={{
                flex: 1,
                height: `${tickerHeight}px`,
                overflow: "hidden",
                position: "relative",
                backgroundColor: "transparent",
                borderRadius: `${borderRadius}px`,
                display: "flex",
                alignItems: "center",
                paddingLeft: `${padding}px`,
                paddingRight: `${padding}px`,
              }}
            >
              <div
                className="ticker-text"
                style={{
                  fontSize: `${tickerFontSize}px`,
                  fontWeight: 600,
                  color: "#fff",
                  textShadow: "2px 2px 4px rgba(0,0,0,0.9)",
                  letterSpacing: "0.5px",
                }}
              >
                {tickerText}
              </div>
            </div>
          )}

          {/* Fullscreen button - only rendered when controls are shown to avoid gap */}
          {showControls && (
            <button
              onClick={toggleFullscreen}
              style={{
                flexShrink: 0,
                padding: `${Math.round(10 * scaleFactor)}px ${Math.round(20 * scaleFactor)}px`,
                background: "rgba(255,255,255,0.15)",
                border: "1px solid rgba(255,255,255,0.3)",
                borderRadius: `${borderRadius}px`,
                color: "white",
                cursor: "pointer",
                fontSize: `${Math.round(14 * scaleFactor)}px`,
                fontWeight: 500,
                transition: "all 0.3s ease",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "rgba(255,255,255,0.25)";
                e.currentTarget.style.transform = "scale(1.05)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "rgba(255,255,255,0.15)";
                e.currentTarget.style.transform = "scale(1)";
              }}
            >
              {isFullscreen ? "⊗ Exit Fullscreen" : "⛶ Fullscreen"}
            </button>
          )}
        </div>
      </div>
    );
  };

  // When nothing is playing, show waiting screen with ticker
  if (!now) {
    return (
      <>
        <style>{`
          @keyframes ticker-scroll {
            0% { transform: translateX(0); }
            100% { transform: translateX(-50%); }
          }

          .ticker-text {
            display: inline-block;
            white-space: nowrap;
            animation: ticker-scroll 30s linear infinite;
          }

          .controls-overlay {
            transition: opacity 0.3s ease-in-out;
          }
        `}</style>

        <div
          ref={containerRef}
          onMouseMove={handleMouseMove}
          onMouseEnter={() => setShowControls(true)}
          style={{
            position: "relative",
            height: "100vh",
            width: "100vw",
            background: "#000",
            color: "#e5e7eb",
            display: "grid",
            placeItems: "center",
            fontFamily: "system-ui, -apple-system, sans-serif",
            cursor: showControls ? "default" : "none",
          }}
        >
          <audio
            ref={breakAudioRef}
            preload="auto"
            style={{ display: "none" }}
          />
          {/* Show waiting screen - queue is displayed in the roller overlay */}
          {upNext.length > 0 ? (
            <div
              style={{
                textAlign: "center",
                padding: "20px",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "24px",
                animation: "fadeInUp 0.6s ease",
              }}
            >
              {/* Countdown timer when autoplay is enabled and not manually stopped */}
              {autoPlay && countdown !== null && !manualStop && (
                <div
                  style={{
                    fontSize: "clamp(24px, 4vw, 40px)",
                    background: "linear-gradient(135deg, #10b981, #34d399)",
                    WebkitBackgroundClip: "text",
                    WebkitTextFillColor: "transparent",
                    backgroundClip: "text",
                    fontWeight: 700,
                    animation: "pulse 2s ease infinite",
                  }}
                >
                  ⏱️ Starting in {countdown}s...
                </div>
              )}

              {/* Up next heading */}
              <h2
                style={{
                  fontSize: "clamp(32px, 5vw, 56px)",
                  margin: 0,
                  fontWeight: 700,
                  background: "linear-gradient(135deg, #6366f1, #a855f7)",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                  backgroundClip: "text",
                  letterSpacing: "-0.02em",
                }}
              >
                🎤 Up Next
              </h2>

              {/* Show only the first singer */}
              <div style={{ textAlign: "center" }}>
                <div
                  style={{
                    fontSize: "clamp(24px, 4vw, 48px)",
                    fontWeight: 700,
                    color: "#ffffff",
                    marginBottom: "8px",
                  }}
                >
                  {formatSingerName(upNext[0].requested_by) || "Anonymous"}
                </div>
                {!hideSingerQueueEnabled && (
                  <div
                    style={{
                      fontSize: "clamp(14px, 2vw, 20px)",
                      color: "rgba(161, 161, 170, 1)",
                    }}
                  >
                    {upNext[0].title || "Unknown"} •{" "}
                    {upNext[0].artist || "Unknown"}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div
              style={{ textAlign: "center", animation: "fadeInUp 0.6s ease" }}
            >
              <h1
                style={{
                  fontSize: "clamp(32px, 6vw, 64px)",
                  fontWeight: 700,
                  margin: "0 0 16px 0",
                  background: "linear-gradient(135deg, #6366f1, #a855f7)",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                  backgroundClip: "text",
                  letterSpacing: "-0.02em",
                }}
              >
                🎤 Waiting for singers...
              </h1>
              <p
                style={{
                  fontSize: "clamp(16px, 2. 5vw, 20px)",
                  color: "rgba(161, 161, 170, 1)",
                  margin: 0,
                }}
              >
                Add your song from the request page!
              </p>
              {overlaySettings.showRequestsUrl && (
                <p
                  style={{
                    fontSize: "clamp(16px, 2.1vw, 24px)",
                    color: "rgba(226, 232, 240, 0.95)",
                    margin: "16px 0 0 0",
                    fontFamily:
                      '"Inter", "Segoe UI", ui-sans-serif, system-ui, sans-serif',
                    fontWeight: 700,
                    letterSpacing: "0.04em",
                    textTransform: "lowercase",
                    wordBreak: "break-word",
                    padding: "12px 20px",
                    borderRadius: 999,
                    background: "rgba(15, 23, 42, 0.72)",
                    border: "1px solid rgba(148, 163, 184, 0.28)",
                    boxShadow: "0 10px 30px rgba(15, 23, 42, 0.25)",
                  }}
                >
                  {splashRequestsUrl}
                </p>
              )}
            </div>
          )}

          {/* Always show the overlay with ticker */}
          {renderOverlay()}
        </div>
      </>
    );
  }

  // Playing screen
  return (
    <>
      <style>{`
        @keyframes ticker-scroll {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }

        @keyframes fadeInUp {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes pulse {
          0%, 100% {
            opacity: 1;
          }
          50% {
            opacity: 0.7;
          }
        }

        .ticker-text {
          display: inline-block;
          white-space: nowrap;
          animation: ticker-scroll 30s linear infinite;
        }

        .controls-overlay {
          transition: opacity 0.3s ease-in-out;
        }

        .play-button-overlay {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          z-index: 100;
          background: rgba(0,0,0,0.7);
          border-radius: 50%;
          width: 100px;
          height: 100px;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: transform 0.2s, background 0.2s;
        }

        .play-button-overlay:hover {
          transform: translate(-50%, -50%) scale(1.1);
          background: rgba(0,0,0,0.8);
        }

        .play-icon {
          width: 0;
          height: 0;
          border-left: 40px solid white;
          border-top: 25px solid transparent;
          border-bottom: 25px solid transparent;
          margin-left: 10px;
        }
      `}</style>

      <div
        ref={containerRef}
        onMouseMove={handleMouseMove}
        onMouseEnter={() => setShowControls(true)}
        style={{
          position: "relative",
          height: "100vh",
          width: "100vw",
          background: "#000",
          color: "#e5e7eb",
          overflow: "hidden",
          cursor: showControls ? "default" : "none",
        }}
      >
        <audio ref={breakAudioRef} preload="auto" style={{ display: "none" }} />
        {isYouTube && youtubeVideoId ? (
          <iframe
            key={youtubeVideoId}
            id={`youtube-player-${youtubeVideoId}`}
            ref={iframeRef}
            src={`https://www.youtube.com/embed/${youtubeVideoId}?autoplay=1&mute=1&controls=0&showinfo=0&rel=0&modestbranding=1&fs=1&playsinline=1&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}&widget_referrer=${encodeURIComponent(window.location.href)}`}
            referrerPolicy="strict-origin-when-cross-origin"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              border: "none",
              zIndex: 1,
            }}
          />
        ) : (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            onError={() => {
              if (now?.external_url && getYouTubeVideoId(now.external_url)) {
                void fallbackYouTubeToDownloadedTrack("stream");
              }
            }}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              objectFit: "contain",
              zIndex: 1,
            }}
          />
        )}

        {/* Play button overlay when autoplay is blocked (only for video element) */}
        {needsUserInteraction && !isPlaying && (
          <div className="play-button-overlay" onClick={handlePlayClick}>
            <div className="play-icon" />
          </div>
        )}

        {/* Always show the overlay with ticker */}
        {renderOverlay()}
      </div>
    </>
  );
}
