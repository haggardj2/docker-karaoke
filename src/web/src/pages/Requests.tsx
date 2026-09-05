import React, {
  useEffect,
  useState,
  useRef,
  useCallback,
  useLayoutEffect,
  useMemo,
} from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { useAuth } from "../auth-context";
import "./Requests.css";

const MIN_KEY_ADJUSTMENT = -6;
const MAX_KEY_ADJUSTMENT = 6;
const MOBILE_BREAKPOINT = 640;
const BROWSE_LETTERS = ["#", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")];
const SINGER_UUID_STORAGE_KEY = "karaoke-singer-uuid";

type SearchRow = {
  id: number;
  title: string | null;
  artist: string | null;
  disc_id: string | null;
  kind: "mp4" | "cdgmp3" | "zip" | "mp3";
};

type KaraokeNerdsTrack = {
  title: string;
  artist: string;
  url: string;
  brand?: string;
  source: "karaoke-nerds";
};

type MyQueueItem = {
  id: number;
  title: string | null;
  artist: string | null;
  status: string;
};

type BrowseCategory = "artist" | "title";

type BrowseArtistRow = {
  artist: string;
  songCount?: number;
  versionCount?: number;
};

type CombinedSearchTrack =
  | {
      type: "local";
      key: string;
      title: string;
      artist: string;
      discId: string | null;
      kind: string | null;
      track: SearchRow;
    }
  | {
      type: "online";
      key: string;
      title: string;
      artist: string;
      brand: string | null;
      track: KaraokeNerdsTrack;
    };

type CombinedSearchGroup = {
  key: string;
  title: string;
  artist: string;
  versions: CombinedSearchTrack[];
};

function normalizeMyQueueItems(items: unknown): MyQueueItem[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as {
        id?: unknown;
        title?: unknown;
        artist?: unknown;
        status?: unknown;
      };
      const id = Number(row.id);
      if (!Number.isFinite(id)) return null;
      return {
        id,
        title: typeof row.title === "string" ? row.title : null,
        artist: typeof row.artist === "string" ? row.artist : null,
        status: typeof row.status === "string" ? row.status : "",
      };
    })
    .filter((item): item is MyQueueItem => item !== null);
}

function reorderQueuedItems(
  items: MyQueueItem[],
  draggedId: number,
  targetId: number,
): { items: MyQueueItem[]; queuedIds: number[] } | null {
  if (draggedId === targetId) return null;
  const queued = items.filter((item) => item.status === "queued");
  const fromIdx = queued.findIndex((item) => item.id === draggedId);
  const toIdx = queued.findIndex((item) => item.id === targetId);
  if (fromIdx === -1 || toIdx === -1) return null;

  const reordered = [...queued];
  reordered.splice(toIdx, 0, reordered.splice(fromIdx, 1)[0]);
  const queuedIds = reordered.map((item) => item.id);
  const nextQueued = [...reordered];
  const nextItems = items.map((item) =>
    item.status === "queued" ? nextQueued.shift()! : item,
  );
  return { items: nextItems, queuedIds };
}

function shouldHandleEnterKey(
  event: React.KeyboardEvent<HTMLInputElement>,
): boolean {
  const nativeEvent = event.nativeEvent as KeyboardEvent & {
    isComposing?: boolean;
  };
  return event.key === "Enter" && !nativeEvent.isComposing;
}

/**
 * Normalize an artist name for grouping:
 * - Lowercase
 * - Invert "Artist, The" / "Artist, A" / "Artist, An" → "the artist" etc.
 */
function normalizeArtistForGroup(artist: string): string {
  const trimmed = artist.trim();
  const inverted = trimmed.replace(
    /^(.+),\s*(a|an|the)$/i,
    (_, name, article) => `${article} ${name}`.toLowerCase(),
  );
  return inverted.toLowerCase();
}

function groupKey(title: string, artist: string): string {
  return `${title.toLowerCase().trim()}|${normalizeArtistForGroup(artist)}`;
}

function downloadJsonFile(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function safeHistoryFilename(name: string): string {
  return `${name.trim().replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "singer-history"}.kd`;
}

function splitNameForFields(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] ?? "",
    lastName: parts.slice(1).join(" "),
  };
}

function createSingerUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (char) =>
    (
      Number(char) ^
      (Math.random() * 16) >> (Number(char) / 4)
    ).toString(16),
  );
}

function getOrCreateSingerUuid(): string {
  const existing = localStorage.getItem(SINGER_UUID_STORAGE_KEY);
  if (existing) return existing;
  const next = createSingerUuid();
  localStorage.setItem(SINGER_UUID_STORAGE_KEY, next);
  return next;
}

function readJsonFile(file: File): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(JSON.parse(String(reader.result ?? "")));
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file"));
    reader.readAsText(file);
  });
}

export default function Requests() {
  const auth = useAuth();
  const [q, setQ] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [singerUuid, setSingerUuid] = useState(() => getOrCreateSingerUuid());
  const requestedBy = [firstName.trim(), lastName.trim()]
    .filter(Boolean)
    .join(" ");
  const signedInRequestName = (
    auth.profile.displayName ||
    auth.profile.username ||
    ""
  ).trim();
  const isSignedInRequester =
    auth.isLoggedIn && Boolean(auth.sessionToken) && Boolean(signedInRequestName);
  const requestSingerUuid = isSignedInRequester ? undefined : singerUuid;
  const requesterHeaders = useMemo<Record<string, string>>(
    () => {
      const headers: Record<string, string> = {};
      if (isSignedInRequester) {
        headers["x-session-token"] = auth.sessionToken;
      }
      return headers;
    },
    [auth.sessionToken, isSignedInRequester],
  );
  const requesterJsonHeaders = useMemo<Record<string, string>>(
    () => ({ ...requesterHeaders, "Content-Type": "application/json" }),
    [requesterHeaders],
  );
  const buildRequesterParams = useCallback(() => {
    const params = new URLSearchParams({ name: requestedBy.trim() });
    if (requestSingerUuid) {
      params.set("singerUuid", requestSingerUuid);
    }
    return params;
  }, [requestedBy, requestSingerUuid]);
  const [keyAdjustments, setKeyAdjustments] = useState<Map<string, number>>(
    new Map(),
  );
  const [localViewMode, setLocalViewMode] = useState<"search" | "browse">(
    "search",
  );
  const [localRows, setLocalRows] = useState<SearchRow[]>([]);
  const [karaokeNerdsRows, setKaraokeNerdsRows] = useState<KaraokeNerdsTrack[]>(
    [],
  );
  const [busy, setBusy] = useState(false);
  const [knBusy, setKnBusy] = useState(false);
  const [browseBusy, setBrowseBusy] = useState(false);
  const [browseCategory, setBrowseCategory] =
    useState<BrowseCategory>("artist");
  const [browseLetters, setBrowseLetters] = useState<string[]>([]);
  const [selectedBrowseLetter, setSelectedBrowseLetter] = useState("");
  const [browseArtists, setBrowseArtists] = useState<BrowseArtistRow[]>([]);
  const [selectedBrowseArtist, setSelectedBrowseArtist] = useState("");
  const [browseSummary, setBrowseSummary] = useState("");
  const [addingLocal, setAddingLocal] = useState<number | null>(null);
  const [addingKaraokeNerds, setAddingKaraokeNerds] = useState<string | null>(
    null,
  );
  const [recentlyAdded, setRecentlyAdded] = useState<Set<string>>(new Set());
  const [showNamePrompt, setShowNamePrompt] = useState(false);
  const [kindFilter, setKindFilter] = useState<"all" | "mp4" | "cdgmp3">("all");
  const [searchFieldFilter, setSearchFieldFilter] = useState<
    "all" | "artist" | "title"
  >("all");
  const [showFilters, setShowFilters] = useState(false);
  const [actionMenuOpen, setActionMenuOpen] = useState<string | null>(null);
  const [actionMenuAnchor, setActionMenuAnchor] = useState<{
    top: number;
    left: number;
    right: number;
    bottom: number;
    width: number;
  } | null>(null);
  const [actionMenuPosition, setActionMenuPosition] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const [keyAdjustmentView, setKeyAdjustmentView] = useState<string | null>(
    null,
  );
  const [lyricsPopupOpen, setLyricsPopupOpen] = useState<string | null>(null);
  const [lyricsData, setLyricsData] = useState<{
    [key: string]: {
      loading: boolean;
      lyrics: string | null;
      error: string | null;
    };
  }>({});
  // Fuzzy suggestions (shown when main search returns no results)
  const [fuzzySuggestions, setFuzzySuggestions] = useState<SearchRow[]>([]);
  // Requester's own queue items
  const [myQueue, setMyQueue] = useState<MyQueueItem[]>([]);
  const [myQueueLoading, setMyQueueLoading] = useState(false);
  const [myQueueOpen, setMyQueueOpen] = useState(false);
  const [removingQueueId, setRemovingQueueId] = useState<number | null>(null);
  const [requeueingQueueId, setRequeueingQueueId] = useState<number | null>(
    null,
  );
  const [revealedRemoveQueueId, setRevealedRemoveQueueId] = useState<
    number | null
  >(null);
  const [dragOverQueueId, setDragOverQueueId] = useState<number | null>(null);
  const [draggingQueueId, setDraggingQueueId] = useState<number | null>(null);
  const myQueueRef = useRef<MyQueueItem[]>([]);
  const draggingQueueIdRef = useRef<number | null>(null);
  const historyImportInputRef = useRef<HTMLInputElement | null>(null);
  const completedLongClickRef = useRef<{
    id: number;
    startX: number;
    startY: number;
    timeout: ReturnType<typeof setTimeout>;
  } | null>(null);
  const pendingQueueOrderRef = useRef<number[] | null>(null);
  const queueDragChangedRef = useRef(false);
  // Collapsible result sections (collapsed by default)
  const [localExpanded, setLocalExpanded] = useState(false);
  const [knExpanded, setKnExpanded] = useState(false);
  // Source filter: 'all' | 'local' | 'online'
  const [sourceFilter, setSourceFilter] = useState<"all" | "local" | "online">(
    "all",
  );
  // Name confirmation flow
  const [nameConfirmed, setNameConfirmed] = useState(false);
  const [nameError, setNameError] = useState("");
  const [nameModalOpen, setNameModalOpen] = useState(false);
  const [nameEditOpen, setNameEditOpen] = useState(false);
  // Version picker for consolidated song results
  const [versionPicker, setVersionPicker] = useState<{
    title: string;
    artist: string;
    versions: SearchRow[];
  } | null>(null);
  const [knVersionPicker, setKnVersionPicker] = useState<{
    title: string;
    artist: string;
    versions: KaraokeNerdsTrack[];
  } | null>(null);
  const [combinedVersionPicker, setCombinedVersionPicker] = useState<{
    title: string;
    artist: string;
    versions: CombinedSearchTrack[];
  } | null>(null);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const actionMenuRef = useRef<HTMLDivElement | null>(null);
  const lyricsPopupRef = useRef<HTMLDivElement | null>(null);
  const browseArtistScrollYRef = useRef(0);

  // Request acceptance settings
  const [requestAcceptance, setRequestAcceptance] = useState<
    "local" | "external" | "disabled"
  >("local");
  const [localLibraryEnabled, setLocalLibraryEnabled] = useState(true);
  const [externalLibraryEnabled, setExternalLibraryEnabled] = useState(true);
  const [localBrowseEnabled, setLocalBrowseEnabled] = useState(true);

  useEffect(() => {
    // Close popup when clicking outside
    function handleDown(e: MouseEvent) {
      if (actionMenuOpen) {
        const el = actionMenuRef.current;
        if (el && !el.contains(e.target as Node)) {
          setActionMenuOpen(null);
          setActionMenuPosition(null);
          setKeyAdjustmentView(null);
        }
      }
      if (lyricsPopupOpen) {
        const el = lyricsPopupRef.current;
        if (el && !el.contains(e.target as Node)) {
          setLyricsPopupOpen(null);
        }
      }
    }
    document.addEventListener("mousedown", handleDown);
    return () => document.removeEventListener("mousedown", handleDown);
  }, [actionMenuOpen, lyricsPopupOpen]);

  useEffect(() => {
    // Modern dark theme
    document.documentElement.style.cssText = `
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

    // Hide navigation
    const nav = document.querySelector("nav");
    const prevNavDisplay = nav ? (nav as HTMLElement).style.display : "";
    if (nav) (nav as HTMLElement).style.display = "none";

    // Load saved name — only auto-confirm if both first and last name are present
    setSingerUuid(getOrCreateSingerUuid());
    const savedName = localStorage.getItem("karaoke-name");
    if (savedName) {
      const parts = savedName.trim().split(/\s+/);
      setFirstName(parts[0] ?? "");
      setLastName(parts.slice(1).join(" "));
      if (parts.length >= 2 && parts[0] && parts[1]) {
        setNameConfirmed(true);
      }
    }

    // Load settings for request acceptance
    async function loadSettings() {
      try {
        const settings = await api("/api/settings/public");
        const acceptance = settings["requests.acceptance"] || "local";
        const localEnabled = settings["libraries.local_enabled"] !== false;
        const externalEnabled =
          settings["libraries.external_enabled"] !== false;
        const browseEnabled =
          settings["requests.local_browse_enabled"] !== false;

        setRequestAcceptance(acceptance);
        setLocalLibraryEnabled(localEnabled);
        setExternalLibraryEnabled(externalEnabled);
        setLocalBrowseEnabled(browseEnabled);
      } catch (err) {
        console.error("Failed to load settings:", err);
        // Default to allowing everything if we can't load settings
      }
    }

    loadSettings();

    return () => {
      document.documentElement.style.cssText = "";
      document.body.style.cssText = "";
      if (nav) (nav as HTMLElement).style.display = prevNavDisplay;
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (!localBrowseEnabled && localViewMode === "browse") {
      setLocalViewMode("search");
    }
  }, [localBrowseEnabled, localViewMode]);

  useLayoutEffect(() => {
    if (!actionMenuOpen) return;
    if (window.innerWidth <= MOBILE_BREAKPOINT) return;
    if (!actionMenuAnchor) return;

    // Wait a frame so the portal'd menu is in the DOM and measurable
    requestAnimationFrame(() => {
      const menuEl = actionMenuRef.current;
      if (!menuEl) return;

      const gap = 8;
      const menuRect = menuEl.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // 1) Prefer below the button...
      let top = actionMenuAnchor.bottom + gap;

      // ...but if it overflows bottom, open above.
      if (top + menuRect.height + gap > vh) {
        top = actionMenuAnchor.top - menuRect.height - gap;
      }

      // Clamp vertically into viewport
      top = Math.max(gap, Math.min(top, vh - menuRect.height - gap));

      // 2) Open to the LEFT of the button:
      // align the menu's right edge with the button's right edge
      let left = actionMenuAnchor.right - menuRect.width;

      // Clamp horizontally into viewport
      left = Math.max(gap, Math.min(left, vw - menuRect.width - gap));

      setActionMenuPosition({
        top,
        left,
        width: actionMenuAnchor.width,
      });
    });
  }, [actionMenuOpen, actionMenuAnchor]);

  // Save name to localStorage
  useEffect(() => {
    if (requestedBy.trim()) {
      localStorage.setItem("karaoke-name", requestedBy.trim());
    }
  }, [requestedBy]);

  useEffect(() => {
    if (!signedInRequestName) return;

    const { firstName: signedInFirstName, lastName: signedInLastName } =
      splitNameForFields(signedInRequestName);
    setFirstName(signedInFirstName);
    setLastName(signedInLastName);
    setNameError("");
    setNameConfirmed(true);
    setNameModalOpen(false);
    setNameEditOpen(false);
    setShowNamePrompt(false);
    localStorage.setItem("karaoke-name", signedInRequestName);
  }, [signedInRequestName]);

  // Auto-open name modal on first load if name not yet confirmed.
  // Read localStorage directly — the nameConfirmed state hasn't been set yet
  // by the init effect when this runs, so we can't rely on it here.
  useEffect(() => {
    const saved = localStorage.getItem("karaoke-name");
    const parts = (saved ?? "").trim().split(/\s+/);
    const alreadyConfirmed = parts.length >= 2 && !!parts[0] && !!parts[1];
    if (!alreadyConfirmed) {
      setNameEditOpen(true);
      setNameModalOpen(true);
    }
  }, []);

  // Helper function to adjust key
  const adjustKey = useCallback((trackKey: string, delta: number) => {
    setKeyAdjustments((prev) => {
      const next = new Map(prev);
      const currentKey = next.get(trackKey) ?? 0;
      const newKey = currentKey + delta;
      if (newKey >= MIN_KEY_ADJUSTMENT && newKey <= MAX_KEY_ADJUSTMENT) {
        next.set(trackKey, newKey);
      }
      return next;
    });
  }, []);

  // Helper function to calculate and set action menu position
  const handleActionMenuToggle = useCallback(
    (e: React.MouseEvent, trackKey: string, currentlyOpen: string | null) => {
      e.stopPropagation();
      const wasOpen = currentlyOpen === trackKey;
      if (!wasOpen) {
        // Only calculate position for desktop
        if (window.innerWidth > MOBILE_BREAKPOINT) {
          const rect = e.currentTarget.getBoundingClientRect();

          setActionMenuAnchor({
            top: rect.top,
            left: rect.left,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
          });

          // Let useLayoutEffect measure the actual menu size and decide final placement
          setActionMenuPosition({
            top: rect.bottom + 8,
            left: rect.left,
            width: rect.width,
          });
        } else {
          setActionMenuAnchor(null);
          setActionMenuPosition(null);
        }
      }
      setActionMenuOpen((prev) => (prev === trackKey ? null : trackKey));
      if (wasOpen) setActionMenuAnchor(null);
    },
    [],
  );

  // Function to fetch lyrics
  const fetchLyrics = useCallback(
    async (trackKey: string, artist: string, title: string) => {
      // Set loading state
      setLyricsData((prev) => ({
        ...prev,
        [trackKey]: { loading: true, lyrics: null, error: null },
      }));

      try {
        // Create an AbortController for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

        const response = await fetch(
          `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`,
          {
            signal: controller.signal,
          },
        );

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error("Lyrics not found");
        }

        const data = await response.json();

        setLyricsData((prev) => ({
          ...prev,
          [trackKey]: {
            loading: false,
            lyrics: data.lyrics || "No lyrics available",
            error: null,
          },
        }));
      } catch (err) {
        const errorMessage =
          err instanceof Error && err.name === "AbortError"
            ? "Request timeout - please try again"
            : "Lyrics not found";

        setLyricsData((prev) => ({
          ...prev,
          [trackKey]: { loading: false, lyrics: null, error: errorMessage },
        }));
      }
    },
    [],
  );

  // Local library search
  const doLocalSearch = useCallback(async () => {
    if (!q.trim()) {
      setLocalRows([]);
      setFuzzySuggestions([]);
      return;
    }
    setBusy(true);
    try {
      let url = `/api/search?q=${encodeURIComponent(q.trim())}`;
      if (kindFilter !== "all") {
        url += `&kind=${kindFilter}`;
      }
      if (searchFieldFilter !== "all") {
        url += `&field=${searchFieldFilter}`;
      }
      const r = await api(url);
      const rows = Array.isArray(r) ? r : [];
      setLocalRows(rows);
      if (rows.length > 0) setLocalExpanded(true);
      if (rows.length === 0 && q.trim().length >= 2) {
        try {
          const suggestions = await api(
            `/api/search/suggestions?q=${encodeURIComponent(q.trim())}`,
          );
          setFuzzySuggestions(Array.isArray(suggestions) ? suggestions : []);
        } catch {
          setFuzzySuggestions([]);
        }
      } else {
        setFuzzySuggestions([]);
      }
    } catch (err) {
      console.error("Search error:", err);
      setLocalRows([]);
      setFuzzySuggestions([]);
    } finally {
      setBusy(false);
    }
  }, [q, kindFilter, searchFieldFilter]);

  // Karaoke Nerds search
  const doKaraokeNerdsSearch = useCallback(async () => {
    if (!q.trim()) {
      setKaraokeNerdsRows([]);
      return;
    }
    setKnBusy(true);
    try {
      const r = await api(
        `/api/karaoke-nerds/search?q=${encodeURIComponent(q.trim())}`,
      );
      const knRows = Array.isArray(r) ? r : [];
      setKaraokeNerdsRows(knRows);
      if (knRows.length > 0) setKnExpanded(true);
    } catch (err) {
      console.error("Karaoke Nerds search error:", err);
      setKaraokeNerdsRows([]);
    } finally {
      setKnBusy(false);
    }
  }, [q]);

  const loadBrowseLetters = useCallback(
    async (category: BrowseCategory) => {
      setBrowseBusy(true);
      try {
        const kindQuery = kindFilter !== "all" ? `&kind=${kindFilter}` : "";
        const result = await api(
          `/api/search/browse/letters?mode=${category}${kindQuery}`,
        );
        const letters = Array.isArray(result?.letters)
          ? result.letters.filter(
              (value: unknown): value is string => typeof value === "string",
            )
          : [];
        setBrowseLetters(letters);
        setSelectedBrowseLetter((current) => {
          if (letters.includes(current)) return current;
          if (letters.includes("#")) return "#";
          return letters[0] ?? "";
        });
      } catch (err) {
        console.error("Browse letters error:", err);
        setBrowseLetters([]);
        setSelectedBrowseLetter("");
      } finally {
        setBrowseBusy(false);
      }
    },
    [kindFilter],
  );

  const loadBrowseArtists = useCallback(
    async (letter: string) => {
      setBrowseBusy(true);
      setBrowseArtists([]);
      setLocalRows([]);
      setBrowseSummary(`Artists starting with "${letter}"`);
      try {
        const kindQuery = kindFilter !== "all" ? `&kind=${kindFilter}` : "";
        const result = await api(
          `/api/search/browse/artists?letter=${encodeURIComponent(letter)}${kindQuery}`,
        );
        const rawArtists: unknown[] = Array.isArray(result?.artists)
          ? result.artists
          : [];
        const artists = rawArtists
              .map((value: unknown): BrowseArtistRow | null => {
                if (typeof value === "string") {
                  const artist = value.trim();
                  return artist ? { artist } : null;
                }
                if (!value || typeof value !== "object") return null;
                const row = value as {
                  artist?: unknown;
                  songCount?: unknown;
                  versionCount?: unknown;
                };
                if (typeof row.artist !== "string" || !row.artist.trim()) {
                  return null;
                }
                const songCount = Number(row.songCount);
                const versionCount = Number(row.versionCount);
                return {
                  artist: row.artist.trim(),
                  songCount: Number.isFinite(songCount) ? songCount : undefined,
                  versionCount: Number.isFinite(versionCount)
                    ? versionCount
                    : undefined,
                };
              })
              .filter((value): value is BrowseArtistRow => value !== null);
        setBrowseArtists(artists);
      } catch (err) {
        console.error("Browse artists error:", err);
        setBrowseArtists([]);
      } finally {
        setBrowseBusy(false);
      }
    },
    [kindFilter],
  );

  const loadBrowseTitles = useCallback(
    async (letter: string) => {
      setBrowseBusy(true);
      setBrowseArtists([]);
      setLocalRows([]);
      setBrowseSummary(`Titles starting with "${letter}"`);
      try {
        const kindQuery = kindFilter !== "all" ? `&kind=${kindFilter}` : "";
        const result = await api(
          `/api/search/browse/titles?letter=${encodeURIComponent(letter)}${kindQuery}`,
        );
        setLocalRows(Array.isArray(result) ? result : []);
      } catch (err) {
        console.error("Browse titles error:", err);
        setLocalRows([]);
      } finally {
        setBrowseBusy(false);
      }
    },
    [kindFilter],
  );

  const loadBrowseArtistTracks = useCallback(
    async (artist: string) => {
      setBrowseBusy(true);
      setLocalRows([]);
      setBrowseSummary(`Songs by ${artist}`);
      try {
        const kindQuery = kindFilter !== "all" ? `&kind=${kindFilter}` : "";
        const result = await api(
          `/api/search/browse/artist-tracks?artist=${encodeURIComponent(artist)}${kindQuery}`,
        );
        setLocalRows(Array.isArray(result) ? result : []);
      } catch (err) {
        console.error("Browse artist tracks error:", err);
        setLocalRows([]);
      } finally {
        setBrowseBusy(false);
      }
    },
    [kindFilter],
  );

  // Debounced search — fires both local and KN simultaneously
  useEffect(() => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    if (localViewMode === "browse") {
      return;
    }

    searchTimeoutRef.current = setTimeout(() => {
      if (localLibraryEnabled) doLocalSearch();
      if (externalLibraryEnabled) doKaraokeNerdsSearch();
    }, 350);

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, [
    q,
    localViewMode,
    localLibraryEnabled,
    externalLibraryEnabled,
    doLocalSearch,
    doKaraokeNerdsSearch,
  ]);

  // Re-run searches when switching back from browse to search
  useEffect(() => {
    if (localViewMode === "browse") return;
    if (q.trim()) {
      if (localLibraryEnabled) doLocalSearch();
      if (externalLibraryEnabled) doKaraokeNerdsSearch();
    }
  }, [localViewMode]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (localViewMode !== "browse") return;

    setBrowseArtists([]);
    setSelectedBrowseArtist("");
    setLocalRows([]);
    setBrowseSummary("");
    loadBrowseLetters(browseCategory);
  }, [localViewMode, browseCategory, kindFilter, loadBrowseLetters]);

  useEffect(() => {
    if (localViewMode !== "browse") return;

    if (!selectedBrowseLetter) {
      setBrowseArtists([]);
      setSelectedBrowseArtist("");
      setLocalRows([]);
      setBrowseSummary("");
      return;
    }

    setSelectedBrowseArtist("");
    if (browseCategory === "artist") {
      loadBrowseArtists(selectedBrowseLetter);
    } else {
      loadBrowseTitles(selectedBrowseLetter);
    }
  }, [
    localViewMode,
    browseCategory,
    selectedBrowseLetter,
    loadBrowseArtists,
    loadBrowseTitles,
  ]);

  useEffect(() => {
    if (localViewMode !== "browse" || browseCategory !== "artist") return;

    if (!selectedBrowseArtist) {
      setLocalRows([]);
      return;
    }

    loadBrowseArtistTracks(selectedBrowseArtist);
  }, [
    localViewMode,
    browseCategory,
    selectedBrowseArtist,
    loadBrowseArtistTracks,
  ]);

  const showToast = (
    message: string,
    type: "success" | "error" = "success",
  ) => {
    const toast = document.createElement("div");
    toast.className = `toast-notification ${type}`;
    const icon = document.createElement("div");
    icon.className = "toast-icon";
    icon.textContent = type === "success" ? "✓" : "⚠";
    const text = document.createElement("div");
    text.className = "toast-message";
    text.textContent = message;
    toast.append(icon, text);
    document.body.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => {
      toast.classList.add("show");
    });

    toastTimeoutRef.current = setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => {
        if (document.body.contains(toast)) {
          document.body.removeChild(toast);
        }
      }, 300);
    }, 3000);
  };

  const isLocalBrowseMode = localViewMode === "browse";
  const showingBrowseArtistList =
    isLocalBrowseMode &&
    browseCategory === "artist" &&
    !!selectedBrowseLetter &&
    !selectedBrowseArtist;
  const showLocalResults = localLibraryEnabled && localRows.length > 0;
  const showKnResults = externalLibraryEnabled && karaokeNerdsRows.length > 0;
  const isLoading = busy || browseBusy;
  const isKnLoading = knBusy;
  const availableBrowseLetters = new Set(browseLetters);

  async function confirmName() {
    const fn = firstName.trim();
    const ln = lastName.trim();
    if (!fn) {
      setNameError("First name is required");
      return;
    }
    if (!ln) {
      setNameError("Last name (or initial) is required");
      return;
    }
    const name = [fn, ln].join(" ");
    try {
      const result = await api("/api/singers/self/name", {
        method: "POST",
        headers: requesterJsonHeaders,
        body: JSON.stringify({ name, singerUuid: requestSingerUuid }),
      });
      if (typeof result?.singer?.uuid === "string") {
        localStorage.setItem(SINGER_UUID_STORAGE_KEY, result.singer.uuid);
        setSingerUuid(result.singer.uuid);
      }
    } catch (err) {
      setNameError("Could not save name. Please try again.");
      console.error(err);
      return;
    }
    setNameError("");
    setNameConfirmed(true);
    setNameModalOpen(false);
    setNameEditOpen(false);
    setShowNamePrompt(false);
  }

  // Group local search results by normalised title + artist to deduplicate across disc IDs
  type GroupedResult = {
    key: string;
    title: string;
    artist: string;
    versions: SearchRow[];
    kind: string;
  };
  const groupedLocalRows = useMemo((): GroupedResult[] => {
    const map = new Map<string, GroupedResult>();
    for (const row of localRows) {
      const key = groupKey(row.title ?? "", row.artist ?? "");
      if (!map.has(key)) {
        map.set(key, {
          key,
          title: row.title ?? "",
          artist: row.artist ?? "",
          versions: [],
          kind: row.kind,
        });
      }
      map.get(key)!.versions.push(row);
    }
    return Array.from(map.values());
  }, [localRows]);

  // Group Karaoke Nerds results by normalised title + artist
  type GroupedKnResult = {
    key: string;
    title: string;
    artist: string;
    versions: KaraokeNerdsTrack[];
  };
  const groupedKnRows = useMemo((): GroupedKnResult[] => {
    const map = new Map<string, GroupedKnResult>();
    for (const track of karaokeNerdsRows) {
      const key = groupKey(track.title ?? "", track.artist ?? "");
      if (!map.has(key)) {
        map.set(key, {
          key,
          title: track.title ?? "",
          artist: track.artist ?? "",
          versions: [],
        });
      }
      map.get(key)!.versions.push(track);
    }
    return Array.from(map.values());
  }, [karaokeNerdsRows]);

  const combinedSearchGroups = useMemo((): CombinedSearchGroup[] => {
    const tracks: CombinedSearchTrack[] = [];
    if (localLibraryEnabled && sourceFilter !== "online") {
      for (const row of localRows) {
        tracks.push({
          type: "local",
          key: `local-${row.id}`,
          title: row.title ?? "",
          artist: row.artist ?? "",
          discId: row.disc_id,
          kind: row.kind,
          track: row,
        });
      }
    }
    if (externalLibraryEnabled && sourceFilter !== "local") {
      for (const track of karaokeNerdsRows) {
        tracks.push({
          type: "online",
          key: `kn-${track.url}`,
          title: track.title ?? "",
          artist: track.artist ?? "",
          brand: track.brand ?? null,
          track,
        });
      }
    }

    const deduped = new Map<string, CombinedSearchTrack>();
    for (const track of tracks) {
      const dedupeKey =
        track.type === "online"
          ? `online:${track.track.url.trim().toLowerCase().replace(/\/+$/, "")}`
          : `local:${track.track.id}`;
      if (!deduped.has(dedupeKey)) deduped.set(dedupeKey, track);
    }

    const groups = new Map<string, CombinedSearchGroup>();
    for (const track of deduped.values()) {
      const key = groupKey(track.title, track.artist);
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          title: track.title,
          artist: track.artist,
          versions: [],
        });
      }
      groups.get(key)!.versions.push(track);
    }

    return Array.from(groups.values())
      .map((group) => ({
        ...group,
        versions: group.versions.sort((a, b) => {
          const aVersion = a.type === "online" ? a.brand ?? "" : a.discId ?? "";
          const bVersion = b.type === "online" ? b.brand ?? "" : b.discId ?? "";
          return aVersion.localeCompare(bVersion, undefined, {
            sensitivity: "base",
            numeric: true,
          });
        }),
      }))
      .sort((a, b) => {
        const artistCompare = a.artist.localeCompare(b.artist, undefined, {
          sensitivity: "base",
          numeric: true,
        });
        if (artistCompare !== 0) return artistCompare;
        return a.title.localeCompare(b.title, undefined, {
          sensitivity: "base",
          numeric: true,
        });
      });
  }, [
    localRows,
    karaokeNerdsRows,
    localLibraryEnabled,
    externalLibraryEnabled,
    sourceFilter,
  ]);

  const loadMyQueue = useCallback(async () => {
    const name = requestedBy.trim();
    if (!name) {
      setMyQueue([]);
      return;
    }
    setMyQueueLoading(true);
    try {
      const items = await api(
        `/api/queue/by-requester?${buildRequesterParams().toString()}`,
        { headers: requesterHeaders },
      );
      setMyQueue(normalizeMyQueueItems(items));
    } catch {
      setMyQueue([]);
    } finally {
      setMyQueueLoading(false);
    }
  }, [buildRequesterParams, requestedBy, requesterHeaders]);

  useEffect(() => {
    void loadMyQueue();
  }, [loadMyQueue]);

  useEffect(() => {
    myQueueRef.current = myQueue;
  }, [myQueue]);

  const applyMyQueueReorder = useCallback(
    (draggedId: number, targetId: number) => {
      const result = reorderQueuedItems(
        myQueueRef.current,
        draggedId,
        targetId,
      );
      if (!result) return null;
      myQueueRef.current = result.items;
      pendingQueueOrderRef.current = result.queuedIds;
      queueDragChangedRef.current = true;
      setMyQueue(result.items);
      return result.queuedIds;
    },
    [],
  );

  const beginMyQueueDrag = useCallback(
    (event: React.PointerEvent<HTMLElement>, queueId: number) => {
      if (event.button !== 0) return;
      if ((event.target as HTMLElement).closest("button")) return;
      draggingQueueIdRef.current = queueId;
      pendingQueueOrderRef.current = myQueueRef.current
        .filter((queueItem) => queueItem.status === "queued")
        .map((queueItem) => queueItem.id);
      queueDragChangedRef.current = false;
      setDraggingQueueId(queueId);
      setDragOverQueueId(queueId);
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [],
  );

  const moveMyQueueDrag = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const draggedId = draggingQueueIdRef.current;
      if (!draggedId) return;
      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest("[data-my-queue-id]");
      const targetId = Number(target?.getAttribute("data-my-queue-id"));
      if (Number.isFinite(targetId) && targetId !== draggedId) {
        setDragOverQueueId(targetId);
        applyMyQueueReorder(draggedId, targetId);
      }
    },
    [applyMyQueueReorder],
  );

  const endMyQueueDrag = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      const orderedIds = pendingQueueOrderRef.current;
      const changed = queueDragChangedRef.current;
      draggingQueueIdRef.current = null;
      pendingQueueOrderRef.current = null;
      queueDragChangedRef.current = false;
      setDraggingQueueId(null);
      setDragOverQueueId(null);
      if (changed && orderedIds) void reorderMyQueue(orderedIds);
    },
    [reorderMyQueue],
  );

  const cancelMyQueueDrag = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      draggingQueueIdRef.current = null;
      pendingQueueOrderRef.current = null;
      queueDragChangedRef.current = false;
      setDraggingQueueId(null);
      setDragOverQueueId(null);
    },
    [],
  );

  const beginCompletedQueueLongClick = useCallback(
    (event: React.PointerEvent<HTMLElement>, queueId: number) => {
      if (event.button !== 0) return;
      if ((event.target as HTMLElement).closest("button")) return;
      const target = event.currentTarget;
      completedLongClickRef.current = {
        id: queueId,
        startX: event.clientX,
        startY: event.clientY,
        timeout: setTimeout(() => {
          setRevealedRemoveQueueId((current) =>
            current === queueId ? null : queueId,
          );
        }, 550),
      };
      target.setPointerCapture(event.pointerId);
    },
    [],
  );

  const moveCompletedQueueLongClick = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const longClick = completedLongClickRef.current;
      if (!longClick) return;
      const moved =
        Math.abs(event.clientX - longClick.startX) > 10 ||
        Math.abs(event.clientY - longClick.startY) > 10;
      if (moved) {
        clearTimeout(longClick.timeout);
        completedLongClickRef.current = null;
      }
    },
    [],
  );

  const endCompletedQueueLongClick = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (completedLongClickRef.current) {
        clearTimeout(completedLongClickRef.current.timeout);
      }
      completedLongClickRef.current = null;
    },
    [],
  );

  const cancelCompletedQueueLongClick = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (completedLongClickRef.current) {
        clearTimeout(completedLongClickRef.current.timeout);
      }
      completedLongClickRef.current = null;
    },
    [],
  );

  async function removeFromMyQueue(queueId: number) {
    const name = requestedBy.trim();
    if (!name) return;
    setRemovingQueueId(queueId);
    try {
      await api(
        `/api/queue/${queueId}/self-remove?${buildRequesterParams().toString()}`,
        { method: "DELETE", headers: requesterHeaders },
      );
      await loadMyQueue();
      setRevealedRemoveQueueId(null);
      showToast("Song removed from queue");
    } catch (err) {
      showToast("Could not remove song. Please try again.", "error");
      console.error(err);
    } finally {
      setRemovingQueueId(null);
    }
  }

  async function requeueFromMyQueue(queueId: number, songTitle: string | null) {
    const name = requestedBy.trim();
    if (!name) return;
    setRequeueingQueueId(queueId);
    try {
      await api(`/api/queue/${queueId}/self-requeue`, {
        method: "POST",
        headers: requesterJsonHeaders,
        body: JSON.stringify({ name, singerUuid: requestSingerUuid }),
      });
      await loadMyQueue();
      showToast(`Added "${songTitle || "Unknown"}" back to ${name}'s queue`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("409") || msg.toLowerCase().includes("already")) {
        showToast("You already have this song in the queue", "error");
      } else {
        showToast("Could not add song back. Please try again.", "error");
        console.error(err);
      }
    } finally {
      setRequeueingQueueId(null);
    }
  }

  async function exportMySingerHistory() {
    const name = requestedBy.trim();
    if (!name) return;
    try {
      const data = await api(
        `/api/history/self/export?${buildRequesterParams().toString()}`,
        { headers: requesterHeaders },
      );
      downloadJsonFile(safeHistoryFilename(name), data);
      showToast("Singer history exported");
    } catch (err) {
      showToast("Could not export singer history.", "error");
      console.error(err);
    }
  }

  async function importMySingerHistory(file: File | null | undefined) {
    const name = requestedBy.trim();
    if (!name || !file) return;
    try {
      const data = await readJsonFile(file);
      const result = await api("/api/history/self/import", {
        method: "POST",
        headers: requesterJsonHeaders,
        body: JSON.stringify({ name, singerUuid: requestSingerUuid, data }),
      });
      await loadMyQueue();
      showToast(
        `Imported ${Number(result.imported ?? 0)} history song${Number(result.imported ?? 0) === 1 ? "" : "s"}`,
      );
    } catch (err) {
      showToast("Could not import singer history.", "error");
      console.error(err);
    } finally {
      if (historyImportInputRef.current) {
        historyImportInputRef.current.value = "";
      }
    }
  }

  async function logOffSingerProfile() {
    if (requestedBy.trim() && window.confirm("Do you want to export your singer history before logging off?")) {
      await exportMySingerHistory();
    }
    localStorage.removeItem("karaoke-name");
    localStorage.removeItem(SINGER_UUID_STORAGE_KEY);
    const nextUuid = createSingerUuid();
    localStorage.setItem(SINGER_UUID_STORAGE_KEY, nextUuid);
    setSingerUuid(nextUuid);
    setFirstName("");
    setLastName("");
    setNameConfirmed(false);
    setNameEditOpen(true);
    setNameModalOpen(true);
    setMyQueue([]);
    setRevealedRemoveQueueId(null);
    setNameError("");
  }

  async function reorderMyQueue(orderedIds: number[]) {
    const name = requestedBy.trim();
    if (!name) return;
    try {
      await api("/api/queue/self-reorder", {
        method: "PATCH",
        headers: requesterJsonHeaders,
        body: JSON.stringify({ name, singerUuid: requestSingerUuid, queueIds: orderedIds }),
      });
      await loadMyQueue();
      showToast("Queue order updated");
    } catch (err) {
      showToast("Could not reorder queue. Please try again.", "error");
      console.error(err);
    }
  }

  async function enqueueLocal(id: number, songTitle: string) {
    const name = requestedBy.trim();
    if (!name) {
      setShowNamePrompt(true);
      setNameConfirmed(false);
      setNameEditOpen(true);
      setNameModalOpen(true);
      document.getElementById("singer-first-name-input")?.focus();
      return;
    }

    const trackKey = `local-${id}`;
    const keyAdjustment = keyAdjustments.get(trackKey) ?? 0;

    setAddingLocal(id);
    try {
      await api("/api/queue", {
        method: "POST",
        headers: requesterJsonHeaders,
        body: JSON.stringify({
          trackId: id,
          requestedBy: name,
          singerUuid: requestSingerUuid,
          keyAdjustment: keyAdjustment,
        }),
      });

      // Mark as recently added
      setRecentlyAdded((prev) => new Set(prev).add(trackKey));
      setTimeout(() => {
        setRecentlyAdded((prev) => {
          const next = new Set(prev);
          next.delete(trackKey);
          return next;
        });
      }, 3000);

      const keyText =
        keyAdjustment !== 0
          ? ` (Key: ${keyAdjustment > 0 ? "+" : ""}${keyAdjustment})`
          : "";
      showToast(
        `Added "${songTitle || "Unknown"}" to ${name}'s queue${keyText}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (
        msg.includes("409") ||
        msg.toLowerCase().includes("already requested")
      ) {
        showToast("⚠️ You already have this song in the queue", "error");
      } else {
        showToast("Failed to add song.  Please try again.", "error");
        console.error(err);
      }
    } finally {
      setAddingLocal(null);
    }
  }

  async function enqueueKaraokeNerds(track: KaraokeNerdsTrack) {
    const name = requestedBy.trim();
    if (!name) {
      setShowNamePrompt(true);
      setNameEditOpen(true);
      setNameModalOpen(true);
      return;
    }

    const trackKey = `kn-${track.url}`;
    const keyAdjustment = keyAdjustments.get(trackKey) ?? 0;

    setAddingKaraokeNerds(track.url);
    try {
      await api("/api/karaoke-nerds/add", {
        method: "POST",
        headers: requesterJsonHeaders,
        body: JSON.stringify({
          title: track.title,
          artist: track.artist,
          url: track.url,
          requestedBy: name,
          singerUuid: requestSingerUuid,
          keyAdjustment: keyAdjustment,
        }),
      });

      // Mark as recently added
      setRecentlyAdded((prev) => new Set(prev).add(trackKey));
      setTimeout(() => {
        setRecentlyAdded((prev) => {
          const next = new Set(prev);
          next.delete(trackKey);
          return next;
        });
      }, 3000);

      const keyText =
        keyAdjustment !== 0
          ? ` (Key: ${keyAdjustment > 0 ? "+" : ""}${keyAdjustment})`
          : "";
      showToast(
        `Added "${track.title || "Unknown"}" to ${name}'s queue${keyText}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (
        msg.includes("409") ||
        msg.toLowerCase().includes("already requested")
      ) {
        showToast("⚠️ You already have this song in the queue", "error");
      } else {
        showToast("Failed to add song. Please try again.", "error");
        console.error(err);
      }
    } finally {
      setAddingKaraokeNerds(null);
    }
  }

  return (
    <div className="requests-page request-page-gateway-theme">


      <div className="container">
        {/* Header */}
        <div className="top-actions">
          <button
            className="profile-button"
            onClick={() => {
              setNameEditOpen(!nameConfirmed);
              setNameModalOpen(true);
            }}
            title={
              nameConfirmed ? `Singing as ${requestedBy}` : "Enter your name"
            }
            type="button"
          >
            <span>👤</span>
            <span className="profile-name">
              {nameConfirmed ? firstName || "Profile" : "Set name"}
            </span>
          </button>
        </div>

        <div className="header">
          <img className="app-icon" src="/icon.png" alt="" />
          <h1 className="header-title">Karaoke Requests</h1>
          <p className="header-subtitle">
            Search the catalog, pick your version, and watch your queue.
          </p>
        </div>

        {/* Name modal — portal, auto-opens if no name confirmed */}
        {nameModalOpen &&
          createPortal(
            <>
              <div
                style={{
                  position: "fixed",
                  inset: 0,
                  zIndex: 1000,
                  background: "rgba(0,0,0,0.6)",
                }}
                onClick={() => {
                  if (nameConfirmed) {
                    setNameModalOpen(false);
                    setNameEditOpen(false);
                    setNameError("");
                  }
                }}
              />
              <div
                style={{
                  position: "fixed",
                  top: "50%",
                  left: "50%",
                  transform: "translate(-50%, -50%)",
                  zIndex: 1001,
                  background: "var(--color-bg-card)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 16,
                  boxShadow: "0 8px 40px rgba(0,0,0,0.8)",
                  width: "min(380px, 94vw)",
                  padding: "24px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 20,
                  }}
                >
                  <span style={{ fontWeight: 700, fontSize: 17 }}>
                    👤 {nameEditOpen || !nameConfirmed ? (nameConfirmed ? "Change Name" : "Enter Your Name") : "Profile"}
                  </span>
                  {nameConfirmed && (
                    <button
                      onClick={() => {
                        setNameModalOpen(false);
                        setNameEditOpen(false);
                        setNameError("");
                      }}
                      style={{
                        background: "none",
                        border: "none",
                        color: "var(--color-text-secondary)",
                        cursor: "pointer",
                        fontSize: 18,
                        padding: "2px 6px",
                      }}
                    >
                      ✕
                    </button>
                  )}
                </div>
                {(nameEditOpen || !nameConfirmed) && (
                  <>
                    {showNamePrompt && !requestedBy.trim() && (
                      <div
                        style={{
                          background: "rgba(239,68,68,0.1)",
                          border: "1px solid rgba(239,68,68,0.3)",
                          borderRadius: 10,
                          padding: "10px 14px",
                          marginBottom: 16,
                          fontSize: 13,
                          color: "#ef4444",
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
                        <span>⚠️</span>
                        <span>Enter your name to add songs to the queue</span>
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 10, marginBottom: 6 }}>
                      <div style={{ flex: 1 }}>
                        <label
                          style={{
                            display: "block",
                            fontSize: 12,
                            fontWeight: 500,
                            color: "var(--color-text-secondary)",
                            marginBottom: 6,
                          }}
                        >
                          First Name{" "}
                          <span style={{ color: "var(--color-danger)" }}>*</span>
                        </label>
                        <input
                          id="singer-first-name-input"
                          className="input-field"
                          type="text"
                          placeholder="First name…"
                          value={firstName}
                          onChange={(e) => {
                            setFirstName(e.target.value);
                            setNameError("");
                          }}
                          autoComplete="given-name"
                          autoCapitalize="words"
                          onKeyDown={(e) => {
                            if (shouldHandleEnterKey(e)) void confirmName();
                          }}
                          style={{ paddingLeft: 14 }}
                        />
                      </div>
                      <div style={{ flex: 1 }}>
                        <label
                          style={{
                            display: "block",
                            fontSize: 12,
                            fontWeight: 500,
                            color: "var(--color-text-secondary)",
                            marginBottom: 6,
                          }}
                        >
                          Last Name{" "}
                          <span style={{ color: "var(--color-danger)" }}>*</span>
                        </label>
                        <input
                          id="singer-last-name-input"
                          className="input-field"
                          type="text"
                          placeholder="Last name…"
                          value={lastName}
                          onChange={(e) => {
                            setLastName(e.target.value);
                            setNameError("");
                          }}
                          autoComplete="family-name"
                          autoCapitalize="words"
                          onKeyDown={(e) => {
                            if (shouldHandleEnterKey(e)) void confirmName();
                          }}
                          style={{ paddingLeft: 14 }}
                        />
                      </div>
                    </div>
                    {nameError && (
                      <div
                        style={{
                          color: "var(--color-danger)",
                          fontSize: 13,
                          marginBottom: 10,
                        }}
                      >
                        ⚠️ {nameError}
                      </div>
                    )}
                    <button
                      onClick={() => void confirmName()}
                      style={{
                        marginTop: 14,
                        width: "100%",
                        padding: "12px",
                        background: "var(--color-accent)",
                        color: "#fff",
                        border: "none",
                        borderRadius: 10,
                        fontWeight: 700,
                        fontSize: 15,
                        cursor: "pointer",
                      }}
                    >
                      {nameConfirmed ? "Save Changes" : "Let's go! 🎤"}
                    </button>
                  </>
                )}
                {nameConfirmed && (
                  <div
                    style={{
                      marginTop: 12,
                      paddingTop: 12,
                      borderTop: "1px solid var(--color-border)",
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 8,
                    }}
                  >
                    <input
                      ref={historyImportInputRef}
                      type="file"
                      accept=".kd,application/json"
                      style={{ display: "none" }}
                      onChange={(event) =>
                        void importMySingerHistory(event.currentTarget.files?.[0])
                      }
                    />
                    <button
                      onClick={() => {
                        setNameEditOpen(true);
                        requestAnimationFrame(() =>
                          document.getElementById("singer-first-name-input")?.focus(),
                        );
                      }}
                      style={{
                        flex: "1 1 45%",
                        padding: "10px",
                        background: "var(--color-bg-secondary)",
                        color: "var(--color-text-primary)",
                        border: "1px solid var(--color-border)",
                        borderRadius: 10,
                        fontWeight: 700,
                        cursor: "pointer",
                      }}
                    >
                      ✏️ Change Name
                    </button>
                    <button
                      onClick={() => void exportMySingerHistory()}
                      style={{
                        flex: "1 1 45%",
                        padding: "10px",
                        background: "rgba(99,102,241,0.15)",
                        color: "var(--color-accent)",
                        border: "1px solid rgba(99,102,241,0.3)",
                        borderRadius: 10,
                        fontWeight: 700,
                        cursor: "pointer",
                      }}
                    >
                      Export History
                    </button>
                    <button
                      onClick={() => historyImportInputRef.current?.click()}
                      style={{
                        flex: "1 1 45%",
                        padding: "10px",
                        background: "var(--color-bg-secondary)",
                        color: "var(--color-text-primary)",
                        border: "1px solid var(--color-border)",
                        borderRadius: 10,
                        fontWeight: 700,
                        cursor: "pointer",
                      }}
                    >
                      Import History
                    </button>
                    <button
                      onClick={() => void logOffSingerProfile()}
                      style={{
                        flex: "1 1 45%",
                        padding: "10px",
                        background: "rgba(239,68,68,0.12)",
                        color: "var(--color-danger)",
                        border: "1px solid rgba(239,68,68,0.3)",
                        borderRadius: 10,
                        fontWeight: 700,
                        cursor: "pointer",
                      }}
                    >
                      Log Off
                    </button>
                  </div>
                )}
              </div>
            </>,
            document.body,
          )}

        {/* Bottom footer bar — My Queue / next song */}
        {nameConfirmed &&
          createPortal(
            <>
              {myQueueOpen && (
                <>
                  <div
                    style={{ position: "fixed", inset: 0, zIndex: 999 }}
                    onClick={() => setMyQueueOpen(false)}
                  />
                  <div
                    style={{
                      position: "fixed",
                      left: 0,
                      right: 0,
                      bottom: 0,
                      zIndex: 1000,
                      background: "var(--color-bg-card)",
                      border: "1px solid var(--color-border)",
                      borderBottom: "none",
                      borderRadius: "18px 18px 0 0",
                      boxShadow: "0 -12px 42px rgba(0,0,0,0.7)",
                      width: "min(720px, 100vw)",
                      height: "min(78vh, 620px)",
                      margin: "0 auto",
                      paddingBottom: "env(safe-area-inset-bottom, 0px)",
                      display: "flex",
                      flexDirection: "column",
                      animation: "slideUpDrawer 0.22s ease-out",
                    }}
                  >
                    <div
                      style={{
                        padding: "12px 14px",
                        borderBottom: "1px solid var(--color-border)",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        flexShrink: 0,
                      }}
                    >
                      <span style={{ fontWeight: 700, fontSize: 14 }}>
                        📋 My Queue
                      </span>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          style={{
                            background: "none",
                            border: "none",
                            color: "var(--color-text-secondary)",
                            cursor: "pointer",
                            fontSize: 13,
                          }}
                          onClick={() => void loadMyQueue()}
                        >
                          ↻
                        </button>
                        <button
                          style={{
                            background: "none",
                            border: "none",
                            color: "var(--color-text-secondary)",
                            cursor: "pointer",
                            fontSize: 16,
                            padding: "0 2px",
                          }}
                          onClick={() => setMyQueueOpen(false)}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                    <div
                      style={{
                        overflowY: "auto",
                        padding: 12,
                        display: "flex",
                        flexDirection: "column",
                        gap: 6,
                      }}
                    >
                      {myQueueLoading ? (
                        <div
                          style={{
                            color: "var(--color-text-secondary)",
                            fontSize: 13,
                            padding: "8px 0",
                          }}
                        >
                          Loading…
                        </div>
                      ) : myQueue.length === 0 ? (
                        <div
                          style={{
                            color: "var(--color-text-muted)",
                            fontSize: 13,
                            padding: "8px 0",
                          }}
                        >
                          Nothing in queue yet.
                        </div>
                      ) : (
                        <>
                          {myQueue.some((i) => i.status === "queued") &&
                            myQueue.filter((i) => i.status === "queued")
                              .length > 1 && (
                              <div
                                style={{
                                  fontSize: 11,
                                  color: "var(--color-text-muted)",
                                  marginBottom: 2,
                                }}
                              >
                                ☰ Drag to reorder
                              </div>
                            )}
                          {myQueue.some(
                            (i) =>
                              i.status === "done" || i.status === "finished",
                          ) && (
                            <div
                              style={{
                                fontSize: 11,
                                color: "var(--color-text-muted)",
                                marginBottom: 2,
                              }}
                            >
                              Long-click played songs to remove
                            </div>
                          )}
                          {myQueue.map((item) => {
                            const isCompleted =
                              item.status === "done" ||
                              item.status === "finished";
                            const isQueued = item.status === "queued";
                            const isRemoveRevealed =
                              revealedRemoveQueueId === item.id;
                            return (
                              <div
                                key={item.id}
                                data-my-queue-id={item.id}
                                draggable={false}
                                onDragStart={(e) => {
                                  e.preventDefault();
                                }}
                              onPointerDown={
                                isQueued
                                  ? (e) => beginMyQueueDrag(e, item.id)
                                  : isCompleted
                                    ? (e) =>
                                        beginCompletedQueueLongClick(e, item.id)
                                    : undefined
                              }
                              onPointerMove={
                                isQueued
                                  ? moveMyQueueDrag
                                  : isCompleted
                                    ? moveCompletedQueueLongClick
                                    : undefined
                              }
                              onPointerUp={
                                isQueued
                                  ? endMyQueueDrag
                                  : isCompleted
                                    ? endCompletedQueueLongClick
                                    : undefined
                              }
                              onPointerCancel={
                                isQueued
                                  ? cancelMyQueueDrag
                                  : isCompleted
                                    ? cancelCompletedQueueLongClick
                                    : undefined
                              }
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                                padding: "8px 10px",
                                background:
                                  dragOverQueueId === item.id
                                    ? "rgba(99,102,241,0.15)"
                                    : "var(--color-bg-secondary)",
                                borderRadius: 8,
                                opacity:
                                  draggingQueueId === item.id
                                    ? 0.75
                                    : isCompleted || item.status === "skipped"
                                      ? 0.6
                                      : 1,
                                cursor: isQueued ? "grab" : "default",
                                border:
                                  dragOverQueueId === item.id
                                    ? "1px dashed rgba(99,102,241,0.5)"
                                    : "1px solid transparent",
                                touchAction: isQueued
                                  ? "none"
                                  : isCompleted
                                    ? "pan-y"
                                    : undefined,
                                userSelect: "none",
                                transition: "background 0.16s ease",
                              }}
                            >
                              {item.status === "queued" && (
                                <span
                                  style={{
                                    fontSize: 14,
                                    color: "var(--color-text-muted)",
                                    flexShrink: 0,
                                    cursor: "grab",
                                    padding: "4px 2px",
                                  }}
                                >
                                  ☰
                                </span>
                              )}
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div
                                  style={{
                                    fontWeight: 600,
                                    fontSize: 13,
                                    whiteSpace: "nowrap",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    textDecoration: isCompleted
                                      ? "line-through"
                                      : "none",
                                    color: isCompleted
                                      ? "var(--color-text-muted)"
                                      : "var(--color-text-primary)",
                                  }}
                                >
                                  {item.title || "Unknown"}
                                </div>
                                <div
                                  style={{
                                    fontSize: 11,
                                    color: "var(--color-text-secondary)",
                                    textDecoration: isCompleted
                                      ? "line-through"
                                      : "none",
                                  }}
                                >
                                  {item.artist || "Unknown"}
                                </div>
                              </div>
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 6,
                                  flexShrink: 0,
                                }}
                              >
                                <span
                                  style={{
                                    fontSize: 10,
                                    fontWeight: 700,
                                    padding: "2px 6px",
                                    borderRadius: 6,
                                    background:
                                      item.status === "playing"
                                        ? "rgba(16,185,129,0.2)"
                                            : isQueued
                                          ? "rgba(99,102,241,0.15)"
                                          : "rgba(113,113,122,0.15)",
                                    color:
                                      item.status === "playing"
                                        ? "#10b981"
                                            : isQueued
                                          ? "var(--color-accent)"
                                          : "var(--color-text-muted)",
                                  }}
                                >
                                  {item.status === "playing"
                                    ? "▶ NOW"
                                    : isQueued
                                      ? "⏳"
                                      : "✅ Done"}
                                </span>
                                {isQueued && (
                                  <button
                                    style={{
                                      background: "rgba(239,68,68,0.15)",
                                      color: "#ef4444",
                                      border: "1px solid rgba(239,68,68,0.3)",
                                      borderRadius: 6,
                                      cursor: "pointer",
                                      padding: "3px 8px",
                                      fontSize: 11,
                                    }}
                                    disabled={removingQueueId === item.id}
                                    onClick={() =>
                                      void removeFromMyQueue(item.id)
                                    }
                                  >
                                    {removingQueueId === item.id ? "…" : "✕"}
                                  </button>
                                )}
                                {isCompleted && (
                                  <button
                                    style={{
                                      background: "rgba(99,102,241,0.15)",
                                      color: "var(--color-accent)",
                                      border: "1px solid rgba(99,102,241,0.3)",
                                      borderRadius: 6,
                                      cursor: "pointer",
                                      padding: "3px 8px",
                                      fontSize: 11,
                                      fontWeight: 700,
                                      whiteSpace: "nowrap",
                                    }}
                                    disabled={requeueingQueueId === item.id}
                                    onClick={() =>
                                      void requeueFromMyQueue(
                                        item.id,
                                        item.title,
                                      )
                                    }
                                  >
                                    {requeueingQueueId === item.id
                                      ? "…"
                                      : "+ Add back"}
                                  </button>
                                )}
                                {isCompleted && isRemoveRevealed && (
                                  <>
                                    <button
                                      style={{
                                        background: "rgba(113,113,122,0.16)",
                                        color: "var(--color-text-secondary)",
                                        border: "1px solid rgba(113,113,122,0.28)",
                                        borderRadius: 6,
                                        cursor: "pointer",
                                        padding: "3px 8px",
                                        fontSize: 11,
                                        fontWeight: 700,
                                        whiteSpace: "nowrap",
                                      }}
                                      onClick={() =>
                                        setRevealedRemoveQueueId(null)
                                      }
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      style={{
                                        background: "rgba(239,68,68,0.18)",
                                        color: "#ef4444",
                                        border: "1px solid rgba(239,68,68,0.35)",
                                        borderRadius: 6,
                                        cursor: "pointer",
                                        padding: "3px 8px",
                                        fontSize: 11,
                                        fontWeight: 700,
                                        whiteSpace: "nowrap",
                                      }}
                                      disabled={removingQueueId === item.id}
                                      onClick={() =>
                                        void removeFromMyQueue(item.id)
                                      }
                                    >
                                      {removingQueueId === item.id
                                        ? "…"
                                        : "Remove"}
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                            );
                          })}
                        </>
                      )}
                    </div>
                  </div>
                </>
              )}
              {/* Static footer bar */}
              {(() => {
                const nextSong =
                  myQueue.find((i) => i.status === "playing") ??
                  myQueue.find((i) => i.status === "queued");
                const activeCount = myQueue.filter(
                  (i) => i.status === "queued" || i.status === "playing",
                ).length;
                return (
                  <div
                    className="queue-footer request-page-gateway-theme-portal"
                    onClick={() => {
                      setMyQueueOpen((o) => !o);
                      if (!myQueueOpen) void loadMyQueue();
                    }}
                    style={{
                      position: "fixed",
                      bottom: 0,
                      left: 0,
                      right: 0,
                      zIndex: 100,
                      background: "var(--color-bg-card)",
                      borderTop: "1px solid var(--color-border)",
                      boxShadow: "0 -4px 20px rgba(0,0,0,0.4)",
                      padding: `10px 16px calc(10px + env(safe-area-inset-bottom, 0px))`,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      userSelect: "none",
                    }}
                  >
                    <div
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 8,
                        flexShrink: 0,
                        background: "rgba(99,102,241,0.15)",
                        border: "1px solid rgba(99,102,241,0.3)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 18,
                        position: "relative",
                      }}
                    >
                      📋
                      {activeCount > 0 && (
                        <span
                          style={{
                            position: "absolute",
                            top: -6,
                            right: -6,
                            background: "var(--color-accent)",
                            color: "#fff",
                            borderRadius: "50%",
                            width: 16,
                            height: 16,
                            fontSize: 9,
                            fontWeight: 700,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          {activeCount}
                        </span>
                      )}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {nextSong ? (
                        <>
                          <div
                            style={{
                              fontSize: 11,
                              color: "var(--color-text-secondary)",
                              marginBottom: 1,
                            }}
                          >
                            {nextSong.status === "playing"
                              ? "▶ Now Playing"
                              : "⏳ Up Next"}
                          </div>
                          <div
                            style={{
                              fontWeight: 600,
                              fontSize: 14,
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              color: "#fff",
                            }}
                          >
                            {nextSong.title || "Unknown"}
                          </div>
                        </>
                      ) : (
                        <div
                          style={{
                            fontSize: 13,
                            color: "var(--color-text-muted)",
                          }}
                        >
                          No songs in queue yet — tap to view
                        </div>
                      )}
                    </div>
                    <span
                      style={{ fontSize: 12, color: "var(--color-text-muted)" }}
                    >
                      My Queue ›
                    </span>
                  </div>
                );
              })()}
            </>,
            document.body,
          )}

        {/* Search Card — only shown after name is confirmed */}
        {nameConfirmed && (
          <div className="card">
            {!localLibraryEnabled && !externalLibraryEnabled ? (
              <div
                style={{
                  padding: "40px",
                  textAlign: "center",
                  color: "var(--color-text-secondary)",
                }}
              >
                <div style={{ fontSize: "48px", marginBottom: "16px" }}>🎤</div>
                <div style={{ fontSize: "18px", fontWeight: 500 }}>
                  We are not accepting requests at this time.
                </div>
              </div>
            ) : (
              <>
                <nav className="page-tabs" aria-label="Request page views">
                  <button
                    className={`page-tab ${localViewMode === "search" ? "active" : ""}`}
                    onClick={() => setLocalViewMode("search")}
                    type="button"
                  >
                    Search
                  </button>
                  {localLibraryEnabled && localBrowseEnabled && (
                    <>
                      <button
                        className={`page-tab ${localViewMode === "browse" && browseCategory === "artist" ? "active" : ""}`}
                        onClick={() => {
                          setBrowseCategory("artist");
                          setLocalViewMode("browse");
                        }}
                        type="button"
                      >
                        Browse Artists
                      </button>
                      <button
                        className={`page-tab ${localViewMode === "browse" && browseCategory === "title" ? "active" : ""}`}
                        onClick={() => {
                          setBrowseCategory("title");
                          setLocalViewMode("browse");
                        }}
                        type="button"
                      >
                        Browse Songs
                      </button>
                    </>
                  )}
                </nav>

                {!isLocalBrowseMode && (
                  <div className="search-wrapper">
                    <input
                      className="search-input"
                      type="text"
                      placeholder={
                        localLibraryEnabled && externalLibraryEnabled
                          ? "Search local library & Online…"
                          : localLibraryEnabled
                            ? "Search local songs…"
                            : "Search Online…"
                      }
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      onKeyDown={(event) => {
                        if (!shouldHandleEnterKey(event)) return;
                        if (searchTimeoutRef.current) {
                          clearTimeout(searchTimeoutRef.current);
                        }
                        event.currentTarget.blur();
                        if (localLibraryEnabled) void doLocalSearch();
                        if (externalLibraryEnabled) void doKaraokeNerdsSearch();
                      }}
                      autoComplete="off"
                      autoCorrect="off"
                      spellCheck="false"
                    />
                    {q.trim() && (
                      <button
                        className="search-clear"
                        type="button"
                        aria-label="Clear search"
                        title="Clear search"
                        onClick={() => {
                          setQ("");
                          setLocalRows([]);
                          setKaraokeNerdsRows([]);
                          setFuzzySuggestions([]);
                        }}
                      >
                        ×
                      </button>
                    )}
                  </div>
                )}

                {/* Search Filters */}
                {localLibraryEnabled && (
                  <div className="search-filters">
                    <button
                      className="filter-toggle"
                      onClick={() => setShowFilters(!showFilters)}
                      aria-label="Toggle filters"
                    >
                      <span className="filter-icon">⚙️</span>
                      <span>Filters</span>
                      <span className="filter-chevron">
                        {showFilters ? "▼" : "▶"}
                      </span>
                    </button>

                    {showFilters && (
                      <div className="filter-options">
                        <div className="filter-group">
                          {localLibraryEnabled && externalLibraryEnabled && (
                            <>
                              <label className="filter-label">Source</label>
                              <div
                                className="filter-chips"
                                style={{ marginBottom: 14 }}
                              >
                                <button
                                  className={`filter-chip ${sourceFilter === "all" ? "active" : ""}`}
                                  onClick={() => setSourceFilter("all")}
                                >
                                  <span>All</span>
                                </button>
                                <button
                                  className={`filter-chip ${sourceFilter === "local" ? "active" : ""}`}
                                  onClick={() => setSourceFilter("local")}
                                >
                                  <span>📚 Local</span>
                                </button>
                                <button
                                  className={`filter-chip ${sourceFilter === "online" ? "active" : ""}`}
                                  onClick={() => setSourceFilter("online")}
                                >
                                  <span>🌐 Online</span>
                                </button>
                              </div>
                            </>
                          )}

                          <label className="filter-label">Search In</label>
                          <div
                            className="filter-chips"
                            style={{ marginBottom: 14 }}
                          >
                            <button
                              className={`filter-chip ${searchFieldFilter === "all" ? "active" : ""}`}
                              onClick={() => setSearchFieldFilter("all")}
                            >
                              <span>All</span>
                            </button>
                            <button
                              className={`filter-chip ${searchFieldFilter === "artist" ? "active" : ""}`}
                              onClick={() => setSearchFieldFilter("artist")}
                            >
                              <span>Artist</span>
                            </button>
                            <button
                              className={`filter-chip ${searchFieldFilter === "title" ? "active" : ""}`}
                              onClick={() => setSearchFieldFilter("title")}
                            >
                              <span>Song Title</span>
                            </button>
                          </div>

                          <label className="filter-label">Format</label>
                          <div className="filter-chips">
                            <button
                              className={`filter-chip ${kindFilter === "all" ? "active" : ""}`}
                              onClick={() => setKindFilter("all")}
                            >
                              <span>All Formats</span>
                            </button>
                            <button
                              className={`filter-chip ${kindFilter === "mp4" ? "active" : ""}`}
                              onClick={() => setKindFilter("mp4")}
                            >
                              <span>🎬 MP4 Video</span>
                            </button>
                            <button
                              className={`filter-chip ${kindFilter === "cdgmp3" ? "active" : ""}`}
                              onClick={() => setKindFilter("cdgmp3")}
                            >
                              <span>📀 CDG+MP3</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {isLocalBrowseMode && (
                  <div className="browse-panel">
                    <h2 className="section-title">
                      {browseCategory === "artist"
                        ? selectedBrowseArtist
                          ? selectedBrowseArtist
                          : "Browse by Artist"
                        : "Browse by Song"}
                    </h2>
                    <select
                      className="initial-selector browse-letter-select"
                      aria-label="Browse letters"
                      value={selectedBrowseLetter}
                      onChange={(event) => {
                        setSelectedBrowseLetter(event.currentTarget.value);
                        setSelectedBrowseArtist("");
                      }}
                    >
                      {BROWSE_LETTERS.map((letter) => (
                        <option
                          key={letter}
                          value={letter}
                          disabled={!availableBrowseLetters.has(letter)}
                        >
                          {letter}
                        </option>
                      ))}
                    </select>
                    {selectedBrowseArtist && (
                      <div className="browse-subheader">
                        <button
                          className="secondary compact"
                          type="button"
                          onClick={() => {
                            setSelectedBrowseArtist("");
                            setLocalRows([]);
                            setBrowseSummary(
                              `Artists starting with "${selectedBrowseLetter}"`,
                            );
                            requestAnimationFrame(() => {
                              window.scrollTo({
                                top: browseArtistScrollYRef.current,
                                behavior: "auto",
                              });
                            });
                          }}
                        >
                          ← Artists
                        </button>
                        <span className="active-filter-badge">
                          {selectedBrowseLetter}
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {/* Results */}
                {isLocalBrowseMode ? (
                  showingBrowseArtistList ? (
                    isLoading ? (
                      <div className="loading-container">
                        <div className="loading-spinner"></div>
                        <div className="loading-text">Loading artists...</div>
                      </div>
                    ) : browseArtists.length > 0 ? (
                      <div className="results-container">
                        {browseArtists.map((artist) => {
                          const songCount = artist.songCount ?? 0;
                          return (
                            <button
                              key={artist.artist}
                              className="result-card artist-card"
                              type="button"
                              onClick={() => {
                                browseArtistScrollYRef.current =
                                  window.scrollY ||
                                  document.documentElement.scrollTop ||
                                  0;
                                setSelectedBrowseArtist(artist.artist);
                              }}
                            >
                              <div className="result-info">
                                <div className="result-title">
                                  {artist.artist || "Unknown Artist"}
                                </div>
                                {artist.songCount !== undefined && (
                                  <div className="result-artist">
                                    {songCount}{" "}
                                    {songCount === 1 ? "song" : "songs"}
                                  </div>
                                )}
                              </div>
                              <span
                                className="icon-action-button"
                                aria-hidden="true"
                              >
                                ›
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="empty-state">
                        <div className="empty-icon">🎙️</div>
                        <div className="empty-title">No artists found</div>
                        <div className="empty-message">
                          No artists were found under "{selectedBrowseLetter}".
                        </div>
                      </div>
                    )
                  ) : isLoading ? (
                    <div className="loading-container">
                      <div className="loading-spinner"></div>
                      <div className="loading-text">
                        Loading library browse...
                      </div>
                    </div>
                  ) : showLocalResults ? (
                    <>
                      <div className="results-header">
                        <span className="results-count">
                          {groupedLocalRows.length}{" "}
                          {groupedLocalRows.length === 1 ? "song" : "songs"}{" "}
                          found
                          {groupedLocalRows.length < localRows.length && (
                            <span
                              style={{
                                marginLeft: 6,
                                fontSize: 11,
                                color: "var(--color-text-muted)",
                                fontWeight: 400,
                              }}
                            >
                              ({localRows.length} versions)
                            </span>
                          )}
                        </span>
                        {browseSummary && (
                          <span className="active-filter-badge">
                            {browseSummary}
                          </span>
                        )}
                        {kindFilter !== "all" && (
                          <span className="active-filter-badge">
                            {kindFilter === "mp4" ? "🎬 MP4" : "📀 CDG+MP3"}
                          </span>
                        )}
                      </div>
                      <div className="results-container">
                        {groupedLocalRows.map((group, idx) => {
                          const row = group.versions[0];
                          const trackKey = `local-${row.id}`;
                          const isRecentlyAdded =
                            recentlyAdded.has(trackKey) ||
                            group.versions.some((v) =>
                              recentlyAdded.has(`local-${v.id}`),
                            );
                          const isAdding = group.versions.some(
                            (v) => addingLocal === v.id,
                          );
                          const currentKey = keyAdjustments.get(trackKey) ?? 0;
                          const hasMultipleVersions = group.versions.length > 1;

                          return (
                            <div key={group.key} className="result-card">
                              <div className="result-number">{idx + 1}</div>
                              <div className="result-info">
                                <div className="result-title">
                                  {group.title || "Unknown Title"}
                                </div>
                                <div className="result-artist">
                                  {group.artist || "Unknown Artist"}
                                </div>
                                <div className="result-meta">
                                  {hasMultipleVersions ? (
                                    <span className="meta-tag">
                                      📀 {group.versions.length} versions
                                    </span>
                                  ) : (
                                    <>
                                      {row.disc_id && (
                                        <span className="meta-tag">
                                          📀 {row.disc_id}
                                        </span>
                                      )}
                                      {row.kind && (
                                        <span className="meta-tag">
                                          {row.kind.toUpperCase()}
                                        </span>
                                      )}
                                    </>
                                  )}
                                </div>
                              </div>
                              <div className="button-container">
                                {/* Single Action Menu Button */}
                                <div
                                  style={{
                                    position: "relative",
                                    width: "100%",
                                  }}
                                >
                                  <button
                                    className={`action-menu-button ${isRecentlyAdded ? "success" : ""}`}
                                    onClick={(e) => {
                                      if (isRecentlyAdded || isAdding) return;
                                      if (hasMultipleVersions) {
                                        setVersionPicker({
                                          title: group.title,
                                          artist: group.artist,
                                          versions: group.versions,
                                        });
                                      } else {
                                        handleActionMenuToggle(
                                          e,
                                          trackKey,
                                          actionMenuOpen,
                                        );
                                      }
                                    }}
                                    disabled={isAdding || isRecentlyAdded}
                                  >
                                    {isAdding ? (
                                      <>
                                        <div className="button-spinner"></div>
                                        <span>Adding</span>
                                      </>
                                    ) : isRecentlyAdded ? (
                                      <span>✓</span>
                                    ) : hasMultipleVersions ? (
                                      <span>☰</span>
                                    ) : (
                                      <span>⋯</span>
                                    )}
                                  </button>

                                  {/* Action Menu */}
                                  {actionMenuOpen === trackKey &&
                                    createPortal(
                                      <>
                                        {/* Mobile overlay */}
                                        <div
                                          className="action-menu-overlay"
                                          onClick={() =>
                                            setActionMenuOpen(null)
                                          }
                                        />

                                        <div
                                          className="action-menu"
                                          ref={actionMenuRef}
                                          onClick={(e) => e.stopPropagation()}
                                          style={
                                            actionMenuPosition
                                              ? {
                                                  top: `${actionMenuPosition.top}px`,
                                                  left: `${actionMenuPosition.left}px`,
                                                  width: "max-content",
                                                  minWidth: `${actionMenuPosition.width}px`,
                                                }
                                              : undefined
                                          }
                                        >
                                          <div className="action-menu-header">
                                            <h3 className="action-menu-title">
                                              {group.title || "Unknown Title"}{" "}
                                              Options
                                            </h3>
                                            <button
                                              className="action-menu-close"
                                              type="button"
                                              onClick={() =>
                                                setActionMenuOpen(null)
                                              }
                                            >
                                              Close
                                            </button>
                                          </div>

                                          {keyAdjustmentView === trackKey ? (
                                            // Key Adjustment View
                                            <div className="key-adjustment-view">
                                              <div className="key-adjustment-header">
                                                <button
                                                  className="key-adjustment-back"
                                                  onClick={() =>
                                                    setKeyAdjustmentView(null)
                                                  }
                                                >
                                                  <span>←</span>
                                                  <span>Back</span>
                                                </button>
                                                <span className="key-adjustment-title">
                                                  Adjust Key
                                                </span>
                                              </div>

                                              <div className="key-adjustment-controls">
                                                <button
                                                  className="key-adjustment-button"
                                                  onClick={() =>
                                                    adjustKey(trackKey, -1)
                                                  }
                                                  disabled={
                                                    (keyAdjustments.get(
                                                      trackKey,
                                                    ) ?? 0) <=
                                                    MIN_KEY_ADJUSTMENT
                                                  }
                                                  aria-label="Lower key"
                                                >
                                                  −
                                                </button>
                                                <div className="key-adjustment-display">
                                                  <div className="key-adjustment-value">
                                                    🎹{" "}
                                                    {currentKey > 0
                                                      ? `+${currentKey}`
                                                      : currentKey}
                                                  </div>
                                                  <div className="key-adjustment-label">
                                                    Semitones
                                                  </div>
                                                </div>
                                                <button
                                                  className="key-adjustment-button"
                                                  onClick={() =>
                                                    adjustKey(trackKey, 1)
                                                  }
                                                  disabled={
                                                    (keyAdjustments.get(
                                                      trackKey,
                                                    ) ?? 0) >=
                                                    MAX_KEY_ADJUSTMENT
                                                  }
                                                  aria-label="Raise key"
                                                >
                                                  +
                                                </button>
                                              </div>
                                            </div>
                                          ) : (
                                            // Main Menu Items
                                            <div className="action-menu-body">
                                              <p className="action-menu-meta">
                                                {[
                                                  group.artist ||
                                                    "Unknown Artist",
                                                  row.disc_id,
                                                  row.kind?.toUpperCase(),
                                                ]
                                                  .filter(Boolean)
                                                  .join(" · ")}
                                              </p>
                                              {!hasMultipleVersions && (
                                                <div className="key-controls">
                                                  <span>
                                                    Key:{" "}
                                                    {currentKey > 0
                                                      ? `+${currentKey}`
                                                      : currentKey}
                                                  </span>
                                                  <button
                                                    className="secondary compact"
                                                    type="button"
                                                    onClick={() =>
                                                      adjustKey(trackKey, -1)
                                                    }
                                                    disabled={
                                                      currentKey <=
                                                      MIN_KEY_ADJUSTMENT
                                                    }
                                                  >
                                                    −
                                                  </button>
                                                  <button
                                                    className="secondary compact"
                                                    type="button"
                                                    onClick={() =>
                                                      adjustKey(trackKey, 1)
                                                    }
                                                    disabled={
                                                      currentKey >=
                                                      MAX_KEY_ADJUSTMENT
                                                    }
                                                  >
                                                    +
                                                  </button>
                                                </div>
                                              )}
                                            <div className="action-menu-items">
                                              {/* Add to Queue - Primary action */}
                                              <button
                                                className="action-menu-item primary"
                                                onClick={() => {
                                                  setActionMenuOpen(null);
                                                  if (hasMultipleVersions) {
                                                    setVersionPicker({
                                                      title: group.title,
                                                      artist: group.artist,
                                                      versions: group.versions,
                                                    });
                                                  } else {
                                                    enqueueLocal(
                                                      row.id,
                                                      row.title || "Unknown",
                                                    );
                                                  }
                                                }}
                                              >
                                                <span className="action-menu-item-icon">
                                                  +
                                                </span>
                                                <div className="action-menu-item-content">
                                                  <span className="action-menu-item-label">
                                                    Add to Queue
                                                  </span>
                                                  <span className="action-menu-item-description">
                                                    {hasMultipleVersions
                                                      ? `Choose from ${group.versions.length} versions`
                                                      : "Request this song"}
                                                  </span>
                                                </div>
                                              </button>

                                              {/* Adjust Key (single-version only) */}
                                              {!hasMultipleVersions && (
                                                <button
                                                  hidden
                                                  className="action-menu-item"
                                                  onClick={(e) => {
                                                    e.stopPropagation();
                                                    setKeyAdjustmentView(
                                                      trackKey,
                                                    );
                                                  }}
                                                >
                                                  <span className="action-menu-item-icon">
                                                    🎹
                                                  </span>
                                                  <div className="action-menu-item-content">
                                                    <span className="action-menu-item-label">
                                                      Adjust Key
                                                    </span>
                                                    <span className="action-menu-item-description">
                                                      Change pitch
                                                    </span>
                                                  </div>
                                                  <span className="action-menu-item-value">
                                                    {currentKey > 0
                                                      ? `+${currentKey}`
                                                      : currentKey}
                                                  </span>
                                                </button>
                                              )}

                                              {/* View Lyrics */}
                                              <button
                                                className="action-menu-item"
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  const artist =
                                                    group.artist ||
                                                    "Unknown Artist";
                                                  const title =
                                                    group.title ||
                                                    "Unknown Title";
                                                  setActionMenuOpen(null);
                                                  setLyricsPopupOpen(trackKey);
                                                  if (!lyricsData[trackKey]) {
                                                    fetchLyrics(
                                                      trackKey,
                                                      artist,
                                                      title,
                                                    );
                                                  }
                                                }}
                                              >
                                                <span className="action-menu-item-icon">
                                                  ♪
                                                </span>
                                                <div className="action-menu-item-content">
                                                  <span className="action-menu-item-label">
                                                    View Lyrics
                                                  </span>
                                                  <span className="action-menu-item-description">
                                                    See song words
                                                  </span>
                                                </div>
                                              </button>
                                            </div>
                                            </div>
                                          )}
                                        </div>
                                      </>,
                                      document.body,
                                    )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  ) : (
                    <div className="empty-state">
                      <div className="empty-icon">🗂️</div>
                      <div className="empty-title">Browse the library</div>
                      <div className="empty-message">
                        Choose{" "}
                        {browseCategory === "artist" ? "Artist" : "Song Title"}{" "}
                        and then pick a letter
                        {browseCategory === "artist"
                          ? ", followed by an artist,"
                          : ""}{" "}
                        to browse the local library alphabetically.
                      </div>
                    </div>
                  )
                ) : (
                  /* Search mode — show local + KN results together */
                  <>
                    {q.trim() &&
                      (isLoading || isKnLoading ? (
                        <div className="loading-container">
                          <div className="loading-spinner"></div>
                          <div className="loading-text">Searching...</div>
                        </div>
                      ) : combinedSearchGroups.length > 0 ? (
                        <>
                          <div className="results-header">
                            <span className="results-count">
                              {combinedSearchGroups.reduce(
                                (total, group) => total + group.versions.length,
                                0,
                              )}{" "}
                              result
                              {combinedSearchGroups.reduce(
                                (total, group) => total + group.versions.length,
                                0,
                              ) === 1
                                ? ""
                                : "s"}{" "}
                              in {combinedSearchGroups.length} song group
                              {combinedSearchGroups.length === 1 ? "" : "s"}
                            </span>
                            {kindFilter !== "all" && (
                              <span className="active-filter-badge">
                                {kindFilter === "mp4"
                                  ? "🎬 MP4"
                                  : "📀 CDG+MP3"}
                              </span>
                            )}
                          </div>
                          <div className="results-container">
                            {combinedSearchGroups.map((group, idx) => {
                              const firstTrack = group.versions[0];
                              const hasMultipleVersions =
                                group.versions.length > 1;
                              const hasExternal = group.versions.some(
                                (track) => track.type === "online",
                              );
                              const isRecentlyAdded = group.versions.some(
                                (track) => recentlyAdded.has(track.key),
                              );
                              const isAdding = group.versions.some((track) =>
                                track.type === "local"
                                  ? addingLocal === track.track.id
                                  : addingKaraokeNerds === track.track.url,
                              );
                              const trackKey = firstTrack.key;
                              const currentKey =
                                keyAdjustments.get(trackKey) ?? 0;
                              const versionText =
                                firstTrack.type === "online"
                                  ? firstTrack.brand || "Karaoke Version"
                                  : firstTrack.discId || "";
                              const metaLine = [
                                group.artist || "Unknown Artist",
                                firstTrack.type === "online"
                                  ? "🌐 Online"
                                  : null,
                                versionText,
                              ]
                                .filter(Boolean)
                                .join(" · ");

                              return (
                                <div key={group.key} className="result-card">
                                  <div className="result-number">{idx + 1}</div>
                                  <div className="result-info">
                                    <div className="result-title">
                                      {group.title || "Unknown Title"}
                                    </div>
                                    <div className="result-artist">
                                      {group.artist || "Unknown Artist"}
                                    </div>
                                    <div className="result-meta">
                                      {hasMultipleVersions || hasExternal ? (
                                        <span
                                          className={`meta-tag ${hasExternal ? "brand" : ""}`}
                                        >
                                          {hasExternal ? "🌐 " : ""}
                                          {group.versions.length} versions
                                        </span>
                                      ) : (
                                        <>
                                          {firstTrack.type === "local" &&
                                            firstTrack.discId && (
                                              <span className="meta-tag">
                                                {firstTrack.discId}
                                              </span>
                                            )}
                                          {firstTrack.type === "online" &&
                                            firstTrack.brand && (
                                              <span className="meta-tag brand">
                                                {firstTrack.brand}
                                              </span>
                                            )}
                                        </>
                                      )}
                                    </div>
                                  </div>
                                  <div className="button-container">
                                    <button
                                      className={`action-menu-button ${firstTrack.type === "online" ? "karaoke-nerds" : ""} ${isRecentlyAdded ? "success" : ""}`}
                                      type="button"
                                      title={
                                        hasMultipleVersions
                                          ? "Choose version"
                                          : "Options"
                                      }
                                      aria-label={
                                        hasMultipleVersions
                                          ? "Choose version"
                                          : "Options"
                                      }
                                      onClick={(e) => {
                                        if (isRecentlyAdded || isAdding) return;
                                        if (hasMultipleVersions) {
                                          setCombinedVersionPicker({
                                            title: group.title,
                                            artist: group.artist,
                                            versions: group.versions,
                                          });
                                        } else {
                                          handleActionMenuToggle(
                                            e,
                                            trackKey,
                                            actionMenuOpen,
                                          );
                                        }
                                      }}
                                      disabled={isAdding || isRecentlyAdded}
                                    >
                                      {isAdding ? (
                                        <div className="button-spinner"></div>
                                      ) : isRecentlyAdded ? (
                                        <span>✓</span>
                                      ) : hasMultipleVersions ? (
                                        <span>☰</span>
                                      ) : (
                                        <span>⋯</span>
                                      )}
                                    </button>
                                    {actionMenuOpen === trackKey &&
                                      createPortal(
                                        <>
                                          <div
                                            className="action-menu-overlay"
                                            onClick={() =>
                                              setActionMenuOpen(null)
                                            }
                                          />
                                          <div
                                            className="action-menu"
                                            ref={actionMenuRef}
                                            onClick={(e) => e.stopPropagation()}
                                          >
                                            <div className="action-menu-header">
                                              <h3 className="action-menu-title">
                                                {group.title || "Unknown Title"}{" "}
                                                Options
                                              </h3>
                                              <button
                                                className="action-menu-close"
                                                type="button"
                                                onClick={() =>
                                                  setActionMenuOpen(null)
                                                }
                                              >
                                                Close
                                              </button>
                                            </div>
                                            <div className="action-menu-body">
                                              <p className="action-menu-meta">
                                                {metaLine}
                                              </p>
                                              {firstTrack.type === "local" && (
                                                <div className="key-controls">
                                                  <span>
                                                    Key:{" "}
                                                    {currentKey > 0
                                                      ? `+${currentKey}`
                                                      : currentKey}
                                                  </span>
                                                  <button
                                                    className="secondary compact"
                                                    type="button"
                                                    onClick={() =>
                                                      adjustKey(trackKey, -1)
                                                    }
                                                    disabled={
                                                      currentKey <=
                                                      MIN_KEY_ADJUSTMENT
                                                    }
                                                  >
                                                    −
                                                  </button>
                                                  <button
                                                    className="secondary compact"
                                                    type="button"
                                                    onClick={() =>
                                                      adjustKey(trackKey, 1)
                                                    }
                                                    disabled={
                                                      currentKey >=
                                                      MAX_KEY_ADJUSTMENT
                                                    }
                                                  >
                                                    +
                                                  </button>
                                                </div>
                                              )}
                                              <div className="action-menu-items">
                                                <button
                                                  className="action-menu-item primary"
                                                  type="button"
                                                  onClick={() => {
                                                    setActionMenuOpen(null);
                                                    if (
                                                      firstTrack.type ===
                                                      "local"
                                                    ) {
                                                      void enqueueLocal(
                                                        firstTrack.track.id,
                                                        firstTrack.title ||
                                                          "Unknown",
                                                      );
                                                    } else {
                                                      void enqueueKaraokeNerds(
                                                        firstTrack.track,
                                                      );
                                                    }
                                                  }}
                                                >
                                                  <span className="action-menu-item-icon">
                                                    +
                                                  </span>
                                                  <div className="action-menu-item-content">
                                                    <span className="action-menu-item-label">
                                                      Add to Queue
                                                    </span>
                                                    <span className="action-menu-item-description">
                                                      Request this song
                                                    </span>
                                                  </div>
                                                </button>
                                                <button
                                                  className="action-menu-item secondary"
                                                  type="button"
                                                  onClick={(e) => {
                                                    e.stopPropagation();
                                                    setActionMenuOpen(null);
                                                    setLyricsPopupOpen(trackKey);
                                                    if (!lyricsData[trackKey]) {
                                                      fetchLyrics(
                                                        trackKey,
                                                        group.artist ||
                                                          "Unknown Artist",
                                                        group.title ||
                                                          "Unknown Title",
                                                      );
                                                    }
                                                  }}
                                                >
                                                  <span className="action-menu-item-icon">
                                                    ♪
                                                  </span>
                                                  <div className="action-menu-item-content">
                                                    <span className="action-menu-item-label">
                                                      View Lyrics
                                                    </span>
                                                    <span className="action-menu-item-description">
                                                      See song words
                                                    </span>
                                                  </div>
                                                </button>
                                              </div>
                                            </div>
                                          </div>
                                        </>,
                                        document.body,
                                      )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </>
                      ) : (
                        <div className="empty-state">
                          <div className="empty-icon">🎵</div>
                          <div className="empty-title">
                            No results for "{q}"
                          </div>
                        </div>
                      ))}
                    {/* Local library results */}
                    {false &&
                      (sourceFilter === "all" || sourceFilter === "local") &&
                      localLibraryEnabled &&
                      (isLoading ? (
                        <div className="loading-container">
                          <div className="loading-spinner"></div>
                          <div className="loading-text">
                            Searching local library...
                          </div>
                        </div>
                      ) : showLocalResults ? (
                        <>
                          <div
                            className="results-header"
                            onClick={() => setLocalExpanded((e) => !e)}
                            style={{ cursor: "pointer", userSelect: "none" }}
                          >
                            <span className="results-count">
                              <img
                                src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/svg/1f4da.svg"
                                alt=""
                                style={{
                                  width: 14,
                                  height: 14,
                                  verticalAlign: "middle",
                                  marginRight: 5,
                                }}
                              />
                              Local — {groupedLocalRows.length}{" "}
                              {groupedLocalRows.length === 1 ? "song" : "songs"}
                              {groupedLocalRows.length < localRows.length && (
                                <span
                                  style={{
                                    marginLeft: 6,
                                    fontSize: 11,
                                    color: "var(--color-text-muted)",
                                    fontWeight: 400,
                                  }}
                                >
                                  ({localRows.length} versions)
                                </span>
                              )}
                            </span>
                            <div
                              style={{
                                display: "flex",
                                gap: 6,
                                alignItems: "center",
                              }}
                            >
                              {kindFilter !== "all" && (
                                <span className="active-filter-badge">
                                  {kindFilter === "mp4"
                                    ? "🎬 MP4"
                                    : "📀 CDG+MP3"}
                                </span>
                              )}
                              <span
                                style={{
                                  fontSize: 13,
                                  color: "var(--color-text-muted)",
                                }}
                              >
                                {localExpanded ? "▲" : "▼"}
                              </span>
                            </div>
                          </div>
                          {localExpanded && (
                            <div className="results-container">
                              {groupedLocalRows.map((group, idx) => {
                                const row = group.versions[0];
                                const trackKey = `local-${row.id}`;
                                const isRecentlyAdded =
                                  recentlyAdded.has(trackKey) ||
                                  group.versions.some((v) =>
                                    recentlyAdded.has(`local-${v.id}`),
                                  );
                                const isAdding = group.versions.some(
                                  (v) => addingLocal === v.id,
                                );
                                const currentKey =
                                  keyAdjustments.get(trackKey) ?? 0;
                                const hasMultipleVersions =
                                  group.versions.length > 1;
                                return (
                                  <div key={group.key} className="result-card">
                                    <div className="result-number">
                                      {idx + 1}
                                    </div>
                                    <div className="result-info">
                                      <div className="result-title">
                                        {group.title || "Unknown Title"}
                                      </div>
                                      <div className="result-artist">
                                        {group.artist || "Unknown Artist"}
                                      </div>
                                      <div className="result-meta">
                                        {hasMultipleVersions ? (
                                          <span className="meta-tag">
                                            📀 {group.versions.length} versions
                                          </span>
                                        ) : (
                                          <>
                                            {row.disc_id && (
                                              <span className="meta-tag">
                                                📀 {row.disc_id}
                                              </span>
                                            )}
                                            {row.kind && (
                                              <span className="meta-tag">
                                                {row.kind.toUpperCase()}
                                              </span>
                                            )}
                                          </>
                                        )}
                                      </div>
                                    </div>
                                    <div className="button-container">
                                      <div
                                        style={{
                                          position: "relative",
                                          width: "100%",
                                        }}
                                      >
                                        <button
                                          className={`action-menu-button ${isRecentlyAdded ? "success" : ""}`}
                                          onClick={(e) => {
                                            if (isRecentlyAdded || isAdding)
                                              return;
                                            if (hasMultipleVersions) {
                                              setVersionPicker({
                                                title: group.title ?? "",
                                                artist: group.artist ?? "",
                                                versions: group.versions,
                                              });
                                            } else {
                                              handleActionMenuToggle(
                                                e,
                                                trackKey,
                                                actionMenuOpen,
                                              );
                                            }
                                          }}
                                          disabled={isAdding || isRecentlyAdded}
                                        >
                                          {isAdding ? (
                                            <>
                                              <div className="button-spinner"></div>
                                              <span>Adding</span>
                                            </>
                                          ) : isRecentlyAdded ? (
                                            <span>✓</span>
                                          ) : hasMultipleVersions ? (
                                            <span>☰</span>
                                          ) : (
                                            <span>⋯</span>
                                          )}
                                        </button>
                                        {actionMenuOpen === trackKey &&
                                          createPortal(
                                            <>
                                              <div
                                                className="action-menu-overlay"
                                                onClick={() =>
                                                  setActionMenuOpen(null)
                                                }
                                              />
                                              <div
                                                className="action-menu"
                                                ref={actionMenuRef}
                                                onClick={(e) =>
                                                  e.stopPropagation()
                                                }
                                                style={
                                                  actionMenuPosition
                                                    ? {
                                                        top: `${actionMenuPosition.top}px`,
                                                        left: `${actionMenuPosition.left}px`,
                                                        width: "max-content",
                                                        minWidth: `${actionMenuPosition.width}px`,
                                                      }
                                                    : undefined
                                                }
                                              >
                                                <div className="action-menu-header">
                                                  <h3 className="action-menu-title">
                                                    {group.title ||
                                                      "Unknown Title"}{" "}
                                                    Options
                                                  </h3>
                                                  <button
                                                    className="action-menu-close"
                                                    type="button"
                                                    onClick={() =>
                                                      setActionMenuOpen(null)
                                                    }
                                                  >
                                                    Close
                                                  </button>
                                                </div>
                                                <div className="action-menu-body">
                                                  <p className="action-menu-meta">
                                                    {[
                                                      group.artist ||
                                                        "Unknown Artist",
                                                      row.disc_id,
                                                      row.kind?.toUpperCase(),
                                                    ]
                                                      .filter(Boolean)
                                                      .join(" · ")}
                                                  </p>
                                                  {!hasMultipleVersions && (
                                                    <div className="key-controls">
                                                      <span>
                                                        Key:{" "}
                                                        {currentKey > 0
                                                          ? `+${currentKey}`
                                                          : currentKey}
                                                      </span>
                                                      <button
                                                        className="secondary compact"
                                                        type="button"
                                                        onClick={() =>
                                                          adjustKey(trackKey, -1)
                                                        }
                                                        disabled={
                                                          currentKey <=
                                                          MIN_KEY_ADJUSTMENT
                                                        }
                                                      >
                                                        −
                                                      </button>
                                                      <button
                                                        className="secondary compact"
                                                        type="button"
                                                        onClick={() =>
                                                          adjustKey(trackKey, 1)
                                                        }
                                                        disabled={
                                                          currentKey >=
                                                          MAX_KEY_ADJUSTMENT
                                                        }
                                                      >
                                                        +
                                                      </button>
                                                    </div>
                                                  )}
                                                <div className="action-menu-items">
                                                  <button
                                                    className="action-menu-item primary"
                                                    onClick={() => {
                                                      setActionMenuOpen(null);
                                                      if (hasMultipleVersions) {
                                                        setVersionPicker({
                                                          title:
                                                            group.title ?? "",
                                                          artist:
                                                            group.artist ?? "",
                                                          versions:
                                                            group.versions,
                                                        });
                                                      } else {
                                                        void enqueueLocal(
                                                          row.id,
                                                          row.title || "",
                                                        );
                                                      }
                                                    }}
                                                  >
                                                    <span className="action-menu-item-icon">
                                                      +
                                                    </span>
                                                    <div className="action-menu-item-content">
                                                      <span className="action-menu-item-label">
                                                        Add to Queue
                                                      </span>
                                                      <span className="action-menu-item-description">
                                                        {hasMultipleVersions
                                                          ? `Choose from ${group.versions.length} versions`
                                                          : "Request this song"}
                                                      </span>
                                                    </div>
                                                  </button>
                                                  <button
                                                    className="action-menu-item"
                                                    onClick={(e) => {
                                                      e.stopPropagation();
                                                      setActionMenuOpen(null);
                                                      setLyricsPopupOpen(
                                                        trackKey,
                                                      );
                                                      if (
                                                        !lyricsData[trackKey]
                                                      ) {
                                                        fetchLyrics(
                                                          trackKey,
                                                          group.artist ||
                                                            "Unknown Artist",
                                                          group.title || "",
                                                        );
                                                      }
                                                    }}
                                                  >
                                                    <span className="action-menu-item-icon">
                                                      ♪
                                                    </span>
                                                    <div className="action-menu-item-content">
                                                      <span className="action-menu-item-label">
                                                        View Lyrics
                                                      </span>
                                                      <span className="action-menu-item-description">
                                                        See song words
                                                      </span>
                                                    </div>
                                                  </button>
                                                </div>
                                                </div>
                                              </div>
                                            </>,
                                            document.body,
                                          )}
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </>
                      ) : localLibraryEnabled && q.trim() && !isLoading ? (
                        <div className="empty-state">
                          <div className="empty-icon">🎵</div>
                          <div className="empty-title">
                            No local results for "{q}"
                          </div>
                          {fuzzySuggestions.length > 0 && (
                            <div style={{ marginTop: 12, textAlign: "left" }}>
                              <div
                                style={{
                                  color: "var(--color-text-secondary)",
                                  fontSize: 13,
                                  marginBottom: 8,
                                }}
                              >
                                Did you mean…?
                              </div>
                              {Array.from(
                                fuzzySuggestions
                                  .reduce((map, track) => {
                                    const key = groupKey(
                                      track.title ?? "",
                                      track.artist ?? "",
                                    );
                                    if (!map.has(key))
                                      map.set(key, { track, versions: [] });
                                    map.get(key)!.versions.push(track);
                                    return map;
                                  }, new Map<string, { track: SearchRow; versions: SearchRow[] }>())
                                  .values(),
                              ).map(({ track, versions }) => (
                                <div
                                  key={track.id}
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 10,
                                    padding: "8px 12px",
                                    background: "var(--color-bg-secondary)",
                                    borderRadius: 8,
                                    marginBottom: 6,
                                  }}
                                >
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <div
                                      style={{
                                        fontWeight: 600,
                                        fontSize: 14,
                                        whiteSpace: "nowrap",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                      }}
                                    >
                                      {track.title}
                                    </div>
                                    <div
                                      style={{
                                        fontSize: 12,
                                        color: "var(--color-text-secondary)",
                                      }}
                                    >
                                      {track.artist}
                                    </div>
                                    {versions.length > 1 && (
                                      <div
                                        style={{
                                          fontSize: 11,
                                          color: "var(--color-text-muted)",
                                          marginTop: 2,
                                        }}
                                      >
                                        📀 {versions.length} versions
                                      </div>
                                    )}
                                  </div>
                                  <button
                                    className="add-btn"
                                    disabled={versions.some(
                                      (v) => addingLocal === v.id,
                                    )}
                                    onClick={() => {
                                      if (versions.length > 1) {
                                        setVersionPicker({
                                          title: track.title ?? "",
                                          artist: track.artist ?? "",
                                          versions,
                                        });
                                      } else {
                                        void enqueueLocal(
                                          track.id,
                                          track.title || "",
                                        );
                                      }
                                    }}
                                    style={{ flexShrink: 0 }}
                                  >
                                    {versions.some((v) => addingLocal === v.id)
                                      ? "…"
                                      : "+ Add"}
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : null)}

                    {/* Karaoke Nerds results */}
                    {false &&
                      (sourceFilter === "all" || sourceFilter === "online") &&
                      externalLibraryEnabled &&
                      (isKnLoading ? (
                        <div className="loading-container">
                          <div className="loading-spinner"></div>
                          <div className="loading-text">
                            Searching Karaoke Nerds...
                          </div>
                        </div>
                      ) : showKnResults ? (
                        <>
                          <div
                            className="results-header"
                            onClick={() => setKnExpanded((e) => !e)}
                            style={{ cursor: "pointer", userSelect: "none" }}
                          >
                            <span className="results-count">
                              <img
                                src="https://karaokenerds.com/Content/Icons/favicon.ico"
                                alt=""
                                style={{
                                  width: 14,
                                  height: 14,
                                  verticalAlign: "middle",
                                  marginRight: 5,
                                }}
                              />
                              Online — {groupedKnRows.length}{" "}
                              {groupedKnRows.length === 1 ? "song" : "songs"}
                              {groupedKnRows.length <
                                karaokeNerdsRows.length && (
                                <span
                                  style={{
                                    marginLeft: 6,
                                    fontSize: 11,
                                    color: "var(--color-text-muted)",
                                    fontWeight: 400,
                                  }}
                                >
                                  ({karaokeNerdsRows.length} versions)
                                </span>
                              )}
                            </span>
                            <span
                              style={{
                                fontSize: 13,
                                color: "var(--color-text-muted)",
                              }}
                            >
                              {knExpanded ? "▲" : "▼"}
                            </span>
                          </div>
                          {knExpanded && (
                            <div className="results-container">
                              {groupedKnRows.map((group, idx) => {
                                const firstTrack = group.versions[0];
                                const trackKey = `kn-${firstTrack.url}`;
                                const isRecentlyAdded = group.versions.some(
                                  (v) => recentlyAdded.has(`kn-${v.url}`),
                                );
                                const isAdding = group.versions.some(
                                  (v) => addingKaraokeNerds === v.url,
                                );
                                const hasMultipleVersions =
                                  group.versions.length > 1;
                                return (
                                  <div key={group.key} className="result-card">
                                    <div className="result-number">
                                      {idx + 1}
                                    </div>
                                    <div className="result-info">
                                      <div className="result-title">
                                        {group.title}
                                      </div>
                                      <div className="result-artist">
                                        {group.artist || "Unknown Artist"}
                                      </div>
                                      <div className="result-meta">
                                        {hasMultipleVersions ? (
                                          <span className="meta-tag">
                                            🎵 {group.versions.length} versions
                                          </span>
                                        ) : firstTrack.brand ? (
                                          <span className="meta-tag brand">
                                            🎵 {firstTrack.brand}
                                          </span>
                                        ) : null}
                                        <span className="meta-tag">
                                          🌐 Online
                                        </span>
                                      </div>
                                    </div>
                                    <div className="button-container">
                                      <div
                                        style={{
                                          position: "relative",
                                          width: "100%",
                                        }}
                                      >
                                        <button
                                          className={`action-menu-button karaoke-nerds ${isRecentlyAdded ? "success" : ""}`}
                                          onClick={(e) => {
                                            if (isRecentlyAdded || isAdding)
                                              return;
                                            if (hasMultipleVersions) {
                                              setKnVersionPicker({
                                                title: group.title,
                                                artist: group.artist,
                                                versions: group.versions,
                                              });
                                            } else {
                                              handleActionMenuToggle(
                                                e,
                                                trackKey,
                                                actionMenuOpen,
                                              );
                                            }
                                          }}
                                          disabled={isAdding || isRecentlyAdded}
                                        >
                                          {isAdding ? (
                                            <>
                                              <div className="button-spinner"></div>
                                              <span>Adding</span>
                                            </>
                                          ) : isRecentlyAdded ? (
                                            <span>✓</span>
                                          ) : hasMultipleVersions ? (
                                            <span>☰</span>
                                          ) : (
                                            <span>⋯</span>
                                          )}
                                        </button>
                                        {actionMenuOpen === trackKey &&
                                          createPortal(
                                            <>
                                              <div
                                                className="action-menu-overlay"
                                                onClick={() =>
                                                  setActionMenuOpen(null)
                                                }
                                              />
                                              <div
                                                className="action-menu"
                                                ref={actionMenuRef}
                                                onClick={(e) =>
                                                  e.stopPropagation()
                                                }
                                                style={
                                                  actionMenuPosition
                                                    ? {
                                                        top: `${actionMenuPosition.top}px`,
                                                        left: `${actionMenuPosition.left}px`,
                                                        width: "max-content",
                                                        minWidth: `${actionMenuPosition.width}px`,
                                                      }
                                                    : undefined
                                                }
                                              >
                                                <div className="action-menu-header">
                                                  <h3 className="action-menu-title">
                                                    {group.title} Options
                                                  </h3>
                                                  <button
                                                    className="action-menu-close"
                                                    type="button"
                                                    onClick={() =>
                                                      setActionMenuOpen(null)
                                                    }
                                                  >
                                                    Close
                                                  </button>
                                                </div>
                                                <div className="action-menu-body">
                                                  <p className="action-menu-meta">
                                                    {[
                                                      group.artist ||
                                                        "Unknown Artist",
                                                      "🌐 Online",
                                                      firstTrack.brand ||
                                                        "Karaoke Version",
                                                    ]
                                                      .filter(Boolean)
                                                      .join(" · ")}
                                                  </p>
                                                <div className="action-menu-items">
                                                  <button
                                                    className="action-menu-item primary"
                                                    onClick={() => {
                                                      setActionMenuOpen(null);
                                                      if (hasMultipleVersions) {
                                                        setKnVersionPicker({
                                                          title: group.title,
                                                          artist: group.artist,
                                                          versions:
                                                            group.versions,
                                                        });
                                                      } else {
                                                        void enqueueKaraokeNerds(
                                                          firstTrack,
                                                        );
                                                      }
                                                    }}
                                                  >
                                                    <span className="action-menu-item-icon">
                                                      +
                                                    </span>
                                                    <div className="action-menu-item-content">
                                                      <span className="action-menu-item-label">
                                                        Add to Queue
                                                      </span>
                                                      <span className="action-menu-item-description">
                                                        {hasMultipleVersions
                                                          ? `Choose from ${group.versions.length} versions`
                                                          : "Request this song"}
                                                      </span>
                                                    </div>
                                                  </button>
                                                  <button
                                                    className="action-menu-item"
                                                    onClick={(e) => {
                                                      e.stopPropagation();
                                                      setActionMenuOpen(null);
                                                      setLyricsPopupOpen(
                                                        trackKey,
                                                      );
                                                      if (
                                                        !lyricsData[trackKey]
                                                      ) {
                                                        fetchLyrics(
                                                          trackKey,
                                                          group.artist ||
                                                            "Unknown Artist",
                                                          group.title,
                                                        );
                                                      }
                                                    }}
                                                  >
                                                    <span className="action-menu-item-icon">
                                                      ♪
                                                    </span>
                                                    <div className="action-menu-item-content">
                                                      <span className="action-menu-item-label">
                                                        View Lyrics
                                                      </span>
                                                      <span className="action-menu-item-description">
                                                        See song words
                                                      </span>
                                                    </div>
                                                  </button>
                                                </div>
                                                </div>
                                              </div>
                                            </>,
                                            document.body,
                                          )}
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </>
                      ) : q.trim() && !isKnLoading ? (
                        <div
                          className="empty-state"
                          style={{ marginTop: showLocalResults ? 8 : 0 }}
                        >
                          <div className="empty-icon">🌐</div>
                          <div className="empty-title">
                            No Karaoke Nerds results for "{q}"
                          </div>
                        </div>
                      ) : null)}

                    {/* Initial empty state — nothing searched yet */}
                    {!q.trim() &&
                      !showLocalResults &&
                      !showKnResults &&
                      !isLoading &&
                      !isKnLoading && (
                        <div className="empty-state">
                          <div className="empty-icon">🎤</div>
                          <div className="empty-title">Ready to search?</div>
                          <div className="empty-message">
                            {localLibraryEnabled && externalLibraryEnabled
                              ? "Search local library and Karaoke Nerds at once"
                              : localLibraryEnabled
                                ? "Search the local karaoke library"
                                : "Browse thousands of karaoke tracks online"}
                          </div>
                        </div>
                      )}
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Combined Version Picker Modal */}
      {combinedVersionPicker && (
        <>
          <div
            className="action-menu-overlay"
            onClick={() => setCombinedVersionPicker(null)}
          />
          <div className="action-menu version-dialog">
            <div className="action-menu-header">
              <h3 className="action-menu-title">
                {combinedVersionPicker.title || "Choose a version"}
              </h3>
              <div className="dialog-actions">
                <button
                  className="icon-action-button secondary"
                  type="button"
                  aria-label="View lyrics"
                  title="View lyrics"
                  onClick={() => {
                    const firstVersion = combinedVersionPicker.versions[0];
                    if (!firstVersion) return;
                    setCombinedVersionPicker(null);
                    setLyricsPopupOpen(firstVersion.key);
                    if (!lyricsData[firstVersion.key]) {
                      fetchLyrics(
                        firstVersion.key,
                        combinedVersionPicker.artist || "Unknown Artist",
                        combinedVersionPicker.title || "Unknown Title",
                      );
                    }
                  }}
                >
                  ♪
                </button>
                <button
                  className="action-menu-close"
                  type="button"
                  onClick={() => setCombinedVersionPicker(null)}
                >
                  Close
                </button>
              </div>
            </div>
            <div className="version-list">
              {combinedVersionPicker.versions.map((version) => {
                const isLocal = version.type === "local";
                const label = isLocal
                  ? version.discId || "Version"
                  : version.brand || "Karaoke Version";
                const meta = [
                  !isLocal ? "🌐 Online" : null,
                  isLocal ? version.kind?.toUpperCase() : null,
                ]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <article key={version.key} className="version-row">
                    <div>
                      <strong>{label}</strong>
                      {meta && <span>{meta}</span>}
                    </div>
                    <button
                      className="icon-action-button"
                      type="button"
                      aria-label="Add version"
                      title="Add version"
                      onClick={() => {
                        setCombinedVersionPicker(null);
                        if (version.type === "local") {
                          void enqueueLocal(
                            version.track.id,
                            version.title || "Unknown",
                          );
                        } else {
                          void enqueueKaraokeNerds(version.track);
                        }
                      }}
                    >
                      +
                    </button>
                  </article>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* Version Picker Modal */}
      {versionPicker && (
        <>
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.7)",
              zIndex: 200,
            }}
            onClick={() => setVersionPicker(null)}
          />
          <div
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: "translate(-50%,-50%)",
              zIndex: 201,
              background: "var(--color-bg-card)",
              borderRadius: 16,
              border: "1px solid var(--color-border)",
              boxShadow: "0 16px 64px rgba(0,0,0,0.6)",
              width: "min(420px, 92vw)",
              maxHeight: "80vh",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                padding: "16px 20px",
                borderBottom: "1px solid var(--color-border)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>
                  {versionPicker.title}
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: "var(--color-text-secondary)",
                    marginTop: 2,
                  }}
                >
                  {versionPicker.artist} — Pick a version
                </div>
              </div>
              <div className="dialog-actions">
                <button
                  className="icon-action-button secondary"
                  type="button"
                  aria-label="View lyrics"
                  title="View lyrics"
                  onClick={() => {
                    const firstVersion = versionPicker.versions[0];
                    if (!firstVersion) return;
                    const trackKey = `local-${firstVersion.id}`;
                    setVersionPicker(null);
                    setLyricsPopupOpen(trackKey);
                    if (!lyricsData[trackKey]) {
                      fetchLyrics(
                        trackKey,
                        versionPicker.artist || "Unknown Artist",
                        versionPicker.title || "Unknown Title",
                      );
                    }
                  }}
                >
                  ♪
                </button>
                <button
                  className="action-menu-close"
                  type="button"
                  onClick={() => setVersionPicker(null)}
                >
                  Close
                </button>
              </div>
            </div>
            <div
              style={{
                overflowY: "auto",
                padding: 12,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {versionPicker.versions.map((v) => (
                <button
                  key={v.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "12px 14px",
                    background: "var(--color-bg-secondary)",
                    borderRadius: 10,
                    border: "1px solid var(--color-border)",
                    cursor: "pointer",
                    textAlign: "left",
                    color: "var(--color-text-primary)",
                    width: "100%",
                  }}
                  disabled={addingLocal === v.id}
                  onClick={() => {
                    setVersionPicker(null);
                    void enqueueLocal(v.id, v.title || "Unknown");
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>
                      {v.disc_id || "Unknown disc"}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: "var(--color-text-secondary)",
                        marginTop: 2,
                      }}
                    >
                      {v.kind?.toUpperCase()}
                    </div>
                  </div>
                  {addingLocal === v.id ? (
                    <span
                      style={{
                        color: "var(--color-text-secondary)",
                        fontSize: 12,
                      }}
                    >
                      Adding…
                    </span>
                  ) : (
                    <span
                      style={{
                        fontSize: 13,
                        fontWeight: 700,
                        color: "var(--color-accent)",
                      }}
                    >
                      + Add
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* KN Version Picker Modal */}
      {knVersionPicker && (
        <>
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.7)",
              zIndex: 200,
            }}
            onClick={() => setKnVersionPicker(null)}
          />
          <div
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: "translate(-50%,-50%)",
              zIndex: 201,
              background: "var(--color-bg-card)",
              borderRadius: 16,
              border: "1px solid var(--color-border)",
              boxShadow: "0 16px 64px rgba(0,0,0,0.6)",
              width: "min(420px, 92vw)",
              maxHeight: "80vh",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                padding: "16px 20px",
                borderBottom: "1px solid var(--color-border)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>
                  {knVersionPicker.title}
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: "var(--color-text-secondary)",
                    marginTop: 2,
                  }}
                >
                  {knVersionPicker.artist} — Pick a version
                </div>
              </div>
              <div className="dialog-actions">
                <button
                  className="icon-action-button secondary"
                  type="button"
                  aria-label="View lyrics"
                  title="View lyrics"
                  onClick={() => {
                    const firstVersion = knVersionPicker.versions[0];
                    if (!firstVersion) return;
                    const trackKey = `kn-${firstVersion.url}`;
                    setKnVersionPicker(null);
                    setLyricsPopupOpen(trackKey);
                    if (!lyricsData[trackKey]) {
                      fetchLyrics(
                        trackKey,
                        knVersionPicker.artist || "Unknown Artist",
                        knVersionPicker.title || "Unknown Title",
                      );
                    }
                  }}
                >
                  ♪
                </button>
                <button
                  className="action-menu-close"
                  type="button"
                  onClick={() => setKnVersionPicker(null)}
                >
                  Close
                </button>
              </div>
            </div>
            <div
              style={{
                overflowY: "auto",
                padding: 12,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {knVersionPicker.versions.map((v) => (
                <button
                  key={v.url}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "12px 14px",
                    background: "var(--color-bg-secondary)",
                    borderRadius: 10,
                    border: "1px solid var(--color-border)",
                    cursor: "pointer",
                    textAlign: "left",
                    color: "var(--color-text-primary)",
                    width: "100%",
                  }}
                  disabled={addingKaraokeNerds === v.url}
                  onClick={() => {
                    setKnVersionPicker(null);
                    void enqueueKaraokeNerds(v);
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>
                      {v.brand || "Unknown brand"}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: "var(--color-text-secondary)",
                        marginTop: 2,
                      }}
                    >
                      🌐 Online
                    </div>
                  </div>
                  {addingKaraokeNerds === v.url ? (
                    <span
                      style={{
                        color: "var(--color-text-secondary)",
                        fontSize: 12,
                      }}
                    >
                      Adding…
                    </span>
                  ) : (
                    <span
                      style={{
                        fontSize: 13,
                        fontWeight: 700,
                        color: "var(--color-accent)",
                      }}
                    >
                      + Add
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Lyrics Popup Modal */}
      {lyricsPopupOpen &&
        (() => {
          // Find the track data for the popup
          let title = "Unknown Title";

          if (lyricsPopupOpen.startsWith("local-")) {
            const trackId = parseInt(lyricsPopupOpen.replace("local-", ""));
            const track = localRows.find((r) => r.id === trackId);
            if (track) {
              title = track.title || "Unknown Title";
            }
          } else if (lyricsPopupOpen.startsWith("kn-")) {
            const trackUrl = lyricsPopupOpen.replace("kn-", "");
            const track = karaokeNerdsRows.find((t) => t.url === trackUrl);
            if (track) {
              title = track.title;
            }
          }

          const data = lyricsData[lyricsPopupOpen];

          return (
            <div
              className="lyrics-popup-overlay"
              onClick={() => setLyricsPopupOpen(null)}
            >
              <div
                className="lyrics-popup"
                ref={lyricsPopupRef}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="lyrics-header">
                  <h2 className="lyrics-popup-title">{title} Lyrics</h2>
                  <button
                    className="action-menu-close"
                    type="button"
                    onClick={() => setLyricsPopupOpen(null)}
                  >
                    Close
                  </button>
                </div>

                {data?.loading ? (
                  <pre className="lyrics-content">Loading...</pre>
                ) : data?.error ? (
                  <pre className="lyrics-content">{data.error}</pre>
                ) : data?.lyrics ? (
                  <pre className="lyrics-content">{data.lyrics}</pre>
                ) : null}
              </div>
            </div>
          );
        })()}
    </div>
  );
}
