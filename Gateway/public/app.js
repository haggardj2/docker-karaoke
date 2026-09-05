const singerNameInput = document.querySelector('#singerName');
const topActions = document.querySelector('.top-actions');
const profileButton = document.querySelector('#profileButton');
const profileButtonName = document.querySelector('#profileButtonName');
const profileMenu = document.querySelector('#profileMenu');
const editNameButton = document.querySelector('#editNameButton');
const logoutButton = document.querySelector('#logoutButton');
const searchInput = document.querySelector('#searchInput');
const searchButton = document.querySelector('#searchButton');
const clearSearchButton = document.querySelector('#clearSearchButton');
const resultsEl = document.querySelector('#results');
const pageTabs = [...document.querySelectorAll('.page-tab')];
const pagePanels = [...document.querySelectorAll('.page-panel')];
const closedPage = document.querySelector('#closedPage');
const artistInitials = document.querySelector('#artistInitials');
const artistList = document.querySelector('#artistList');
const artistSongsHeader = document.querySelector('#artistSongsHeader');
const artistSongsTitle = document.querySelector('#artistSongsTitle');
const artistSongs = document.querySelector('#artistSongs');
const backToArtistsButton = document.querySelector('#backToArtistsButton');
const songInitials = document.querySelector('#songInitials');
const songResults = document.querySelector('#songResults');
const queueEl = document.querySelector('#queue');
const messageEl = document.querySelector('#message');
const queueFooter = document.querySelector('#queueFooter');
const queueFooterSummary = document.querySelector('#queueFooterSummary');
const queueDialog = document.querySelector('#queueDialog');
const closeQueueDialog = document.querySelector('#closeQueueDialog');
const openHistoryDialogButton = document.querySelector('#openHistoryDialog');
const historyDialog = document.querySelector('#historyDialog');
const closeHistoryDialog = document.querySelector('#closeHistoryDialog');
const historyList = document.querySelector('#historyList');
const versionDialog = document.querySelector('#versionDialog');
const versionDialogTitle = document.querySelector('#versionDialogTitle');
const versionList = document.querySelector('#versionList');
const closeVersionDialog = document.querySelector('#closeVersionDialog');
const versionLyricsButton = document.querySelector('#versionLyricsButton');
const nameDialog = document.querySelector('#nameDialog');
const nameDialogInput = document.querySelector('#nameDialogInput');
const nameDialogError = document.querySelector('#nameDialogError');
const nameDialogSave = document.querySelector('#nameDialogSave');
const lyricsDialog = document.querySelector('#lyricsDialog');
const lyricsDialogTitle = document.querySelector('#lyricsDialogTitle');
const lyricsContent = document.querySelector('#lyricsContent');
const closeLyricsDialog = document.querySelector('#closeLyricsDialog');
const optionsDialog = document.querySelector('#optionsDialog');
const optionsDialogTitle = document.querySelector('#optionsDialogTitle');
const optionsDialogBody = document.querySelector('#optionsDialogBody');
const closeOptionsDialog = document.querySelector('#closeOptionsDialog');
const exportHistoryButton = document.querySelector('#exportHistoryButton');
const importHistoryButton = document.querySelector('#importHistoryButton');
const historyImportInput = document.querySelector('#historyImportInput');

const singerUuidKey = 'karaokedock.gateway.singerUuid';
const singerNameKey = 'karaokedock.gateway.singerName';
let lastQueueItems = [];
let keyAdjustments = new Map();
let recentlyAdded = new Set();
let draggedQueueId = null;
let toastTimer = null;
let currentArtistPrefix = '#';
let currentSongPrefix = '#';
let artistListScrollY = 0;
let activeVersionLyricsTrack = null;
let publicSettings = {
  localEnabled: true,
  externalEnabled: true,
  requestAcceptance: 'local',
  localBrowseEnabled: true,
  stationConnected: false,
};

function normalizePublicSettings(settings = {}) {
  return {
    ...publicSettings,
    ...settings,
    requestAcceptance: settings.requestAcceptance === 'disabled' || settings.requestAcceptance === 'external'
      ? settings.requestAcceptance
      : 'local',
    localEnabled: settings.localEnabled !== false,
    externalEnabled: settings.externalEnabled !== false,
    localBrowseEnabled: settings.localBrowseEnabled !== false,
    stationConnected: settings.stationConnected === true,
  };
}

function requestsAreClosed() {
  return publicSettings.requestAcceptance === 'disabled' ||
    (!publicSettings.localEnabled && !publicSettings.externalEnabled) ||
    !publicSettings.stationConnected;
}

function getSingerUuid() {
  let value = localStorage.getItem(singerUuidKey);
  if (!value) {
    value = crypto.randomUUID();
    localStorage.setItem(singerUuidKey, value);
  }
  return value;
}

function setMessage(text, isError = false) {
  messageEl.textContent = text;
  messageEl.classList.toggle('error', isError);
}

function showToast(text) {
  let toast = document.querySelector('#toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    document.body.append(toast);
  }
  toast.textContent = text;
  toast.classList.add('visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3600);
}

function closeRequestPopups() {
  if (optionsDialog.open) optionsDialog.close();
  if (versionDialog.open) versionDialog.close();
}

function singerName() {
  return singerNameInput.value.trim();
}

function requireSingerName() {
  const name = singerName();
  if (validateSingerName(name).valid) return name;
  openNameDialog();
  return '';
}

function validateSingerName(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    return { valid: false, message: 'Enter your first name and at least a last initial.' };
  }
  if (!/[A-Za-z]/.test(parts[0]) || !/[A-Za-z]/.test(parts[1])) {
    return { valid: false, message: 'Use letters for your first name and last initial or last name.' };
  }
  return { valid: true, message: '' };
}

function saveSingerName(name) {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  const validation = validateSingerName(trimmed);
  nameDialogError.textContent = validation.message;
  if (!validation.valid) return false;
  singerNameInput.value = trimmed;
  localStorage.setItem(singerNameKey, trimmed);
  updateProfileButton();
  refreshQueue().catch(() => {});
  return true;
}

function updateProfileButton() {
  profileButtonName.textContent = singerName() || 'Profile';
}

function openNameDialog() {
  nameDialogInput.value = singerName();
  nameDialogError.textContent = '';
  if (!nameDialog.open) nameDialog.showModal();
  setTimeout(() => nameDialogInput.focus(), 50);
}

function renderEmpty(target, text) {
  target.replaceChildren();
  const empty = document.createElement('p');
  empty.className = 'empty';
  empty.textContent = text;
  target.append(empty);
}

function initialOptions() {
  return ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
}

function renderInitialSelector(target, activeValue, onSelect) {
  target.replaceChildren();
  if (target.tagName === 'SELECT') {
    target.className = 'initial-selector browse-letter-select';
    for (const value of initialOptions()) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      target.append(option);
    }
    target.value = activeValue;
    target.onchange = () => onSelect(target.value);
    return;
  }
  for (const value of initialOptions()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `initial-button ${value === activeValue ? 'active' : ''}`;
    button.textContent = value;
    button.setAttribute('aria-pressed', String(value === activeValue));
    button.addEventListener('click', () => onSelect(value));
    target.append(button);
  }
}

function setPage(page, options = {}) {
  const { reload = true } = options;
  if (requestsAreClosed()) {
    pageTabs.forEach((tab) => {
      tab.classList.remove('active');
      tab.setAttribute('aria-selected', 'false');
    });
    pagePanels.forEach((panel) => {
      panel.hidden = panel !== closedPage;
    });
    setMessage('');
    return;
  }

  const browseAvailable = publicSettings.localEnabled && publicSettings.localBrowseEnabled;
  const nextPage = browseAvailable ? page : 'search';
  pageTabs.forEach((tab) => {
    const active = tab.dataset.page === nextPage;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  pagePanels.forEach((panel) => {
    panel.hidden = panel.id !== `${nextPage === 'search' ? 'search' : nextPage === 'artists' ? 'artist' : 'song'}Page`;
  });
  setMessage('');
  if (reload && nextPage === 'artists') loadArtists(currentArtistPrefix).catch((err) => setMessage(err.message, true));
  if (reload && nextPage === 'songs') loadSongs(currentSongPrefix).catch((err) => setMessage(err.message, true));
}

function getActivePage() {
  return pageTabs.find((tab) => tab.classList.contains('active'))?.dataset.page || 'search';
}

function trackLabel(track) {
  return [track.artist, track.title].filter(Boolean).join(' - ') || track.title || 'Untitled';
}

function groupTracks(tracks) {
  const groups = new Map();
  for (const track of tracks) {
    const key = normalizedGroupKey(track);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(track);
  }
  return [...groups.values()].sort((a, b) => compareTracks(a[0], b[0]));
}

function compareText(a, b) {
  return String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base', numeric: true });
}

function compareTracks(a, b) {
  return (
    compareText(a.artist || '', b.artist || '') ||
    compareText(a.title || '', b.title || '') ||
    compareText(versionLabel(a), versionLabel(b)) ||
    compareText(a.id, b.id)
  );
}

function normalizedGroupKey(track) {
  return `${track.artist || ''}///${track.title || ''}`.toLowerCase().replace(/\s+/g, ' ').trim();
}

function isExternalTrack(track) {
  return Boolean(track.externalUrl) || track.source === 'karaoke-nerds' || String(track.id || '').startsWith('external:');
}

function trackKey(track) {
  return `${isExternalTrack(track) ? 'external' : 'local'}-${track.id}`;
}

function dedupeTracks(tracks) {
  const seen = new Set();
  return tracks.filter((track) => {
    const key = isExternalTrack(track)
      ? `external:${String(track.externalUrl || track.id || '').trim().toLowerCase().replace(/\/+$/, '')}`
      : `local:${track.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function versionLabel(track) {
  return track.discId || track.brand || '';
}

function sourceIcon(track) {
  return isExternalTrack(track) ? '🌐' : '';
}

function sourceLabel(track) {
  return isExternalTrack(track) ? 'Online' : '';
}

function displayVersionLabel(track) {
  return versionLabel(track) || 'Version';
}

function isActiveStatus(status) {
  return ['playing', 'queued', 'pending', 'delivered'].includes(String(status || '').toLowerCase());
}

function isCompletedHistorySong(song) {
  return !isActiveStatus(song.status);
}

function canRecallHistorySong(song) {
  return isCompletedHistorySong(song) && Boolean(song.track?.trackId || song.track?.url);
}

async function externalTrackIdForUrl(url) {
  const bytes = new TextEncoder().encode(url);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `external:knerds:${hex.slice(0, 24)}`;
}

function logoutProfile() {
  localStorage.removeItem(singerNameKey);
  localStorage.removeItem(singerUuidKey);
  singerNameInput.value = '';
  lastQueueItems = [];
  updateProfileButton();
  renderQueue();
  updateQueueFooter();
  setMessage('Logged out.');
  openNameDialog();
}

function safeHistoryFilename(name) {
  return `${name.trim().replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'singer-history'}.kd`;
}

function downloadJsonFile(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function loadPublicConfig() {
  const response = await fetch('/api/public/config', { cache: 'no-store' });
  if (!response.ok) return;
  const config = await response.json();
  if (config.settings) publicSettings = normalizePublicSettings(config.settings);
  updateRequestPageVisibility();
}

async function applyRequestClosedResponse(response) {
  if (response.status !== 403 && response.status !== 503) return false;
  let body = null;
  try {
    body = await response.clone().json();
  } catch {
    body = null;
  }
  const closed = body?.code === 'REQUESTS_DISABLED' || body?.code === 'STATION_UNAVAILABLE' ||
    String(body?.error || '').toLowerCase().includes('requests are currently disabled') ||
    String(body?.error || '').toLowerCase().includes('station is not connected');
  if (!closed) return false;
  publicSettings = normalizePublicSettings({
    ...(body?.settings || {}),
    requestAcceptance: body?.code === 'REQUESTS_DISABLED' ? 'disabled' : body?.settings?.requestAcceptance,
    stationConnected: body?.code === 'STATION_UNAVAILABLE' ? false : body?.settings?.stationConnected,
  });
  updateRequestPageVisibility();
  return true;
}

function updateRequestPageVisibility() {
  const requestsClosed = requestsAreClosed();
  const showBrowse = publicSettings.localEnabled && publicSettings.localBrowseEnabled && !requestsClosed;
  document.body.classList.toggle('requests-closed', requestsClosed);
  topActions.hidden = requestsClosed;
  queueFooter.hidden = requestsClosed;
  if (requestsClosed) {
    profileMenu.hidden = true;
    if (queueDialog.open) queueDialog.close();
    if (historyDialog.open) historyDialog.close();
    if (nameDialog.open) nameDialog.close();
    closeRequestPopups();
    document.querySelector('.page-tabs').hidden = true;
    pageTabs.forEach((tab) => {
      tab.hidden = true;
      tab.classList.remove('active');
      tab.setAttribute('aria-selected', 'false');
    });
    pagePanels.forEach((panel) => {
      panel.hidden = panel !== closedPage;
    });
    setMessage('');
    return;
  }

  document.querySelector('.page-tabs').hidden = false;
  closedPage.hidden = false;
  pageTabs.forEach((tab) => {
    if (tab.dataset.page === 'artists' || tab.dataset.page === 'songs') {
      tab.hidden = !showBrowse;
    } else {
      tab.hidden = false;
    }
  });
  setPage(showBrowse ? getActivePage() : 'search', { reload: false });
}

async function search() {
  if (requestsAreClosed()) {
    setPage('search');
    return;
  }
  const q = searchInput.value.trim();
  if (!q) {
    renderEmpty(resultsEl, 'Enter a search term.');
    return;
  }
  setMessage('Searching...');
  const response = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  if (await applyRequestClosedResponse(response)) return;
  if (!response.ok) throw new Error(await response.text());
  const tracks = dedupeTracks(await response.json()).sort(compareTracks);
  resultsEl.replaceChildren();
  if (tracks.length === 0) {
    const unavailable = !publicSettings.localEnabled && !publicSettings.externalEnabled
      ? 'Song requests are currently disabled.'
      : 'No songs found.';
    renderEmpty(resultsEl, unavailable);
    setMessage('');
    return;
  }

  const groups = groupTracks(tracks);
  for (const group of groups) {
    group.sort(compareTracks);
    resultsEl.append(renderResultGroup(group));
  }
  setMessage(`${tracks.length} result${tracks.length === 1 ? '' : 's'} in ${groups.length} song group${groups.length === 1 ? '' : 's'}`);
}

function updateClearSearchVisibility() {
  clearSearchButton.hidden = searchInput.value.trim().length === 0;
}

function renderTrackGroups(target, tracks, emptyText) {
  target.replaceChildren();
  const deduped = dedupeTracks(tracks).sort(compareTracks);
  if (deduped.length === 0) {
    renderEmpty(target, emptyText);
    return { tracks: 0, groups: 0 };
  }
  const groups = groupTracks(deduped);
  for (const group of groups) {
    group.sort(compareTracks);
    target.append(renderResultGroup(group));
  }
  return { tracks: deduped.length, groups: groups.length };
}

async function loadArtists(prefix = currentArtistPrefix) {
  if (requestsAreClosed()) {
    setPage('search');
    return;
  }
  currentArtistPrefix = prefix;
  renderInitialSelector(artistInitials, currentArtistPrefix, (next) => loadArtists(next).catch((err) => setMessage(err.message, true)));
  artistSongsHeader.hidden = true;
  artistSongs.hidden = true;
  artistSongs.replaceChildren();
  artistList.hidden = false;
  renderEmpty(artistList, 'Loading artists…');
  const response = await fetch(`/api/browse/artists?prefix=${encodeURIComponent(prefix)}`);
  if (await applyRequestClosedResponse(response)) return;
  if (!response.ok) throw new Error(await response.text());
  const artists = await response.json();
  artistList.replaceChildren();
  if (artists.length === 0) {
    renderEmpty(artistList, 'No artists found.');
    return;
  }
  for (const artist of artists) {
    const row = document.createElement('article');
    row.className = 'result-card artist-card';
    const top = document.createElement('div');
    top.className = 'result-main';
    const info = document.createElement('div');
    info.className = 'result-info';
    const title = document.createElement('h3');
    title.textContent = artist.artist || 'Unknown Artist';
    const meta = document.createElement('p');
    const songCount = Number(artist.songCount || 0);
    meta.textContent = `${songCount} song${songCount === 1 ? '' : 's'}`;
    info.append(title, meta);
    const button = document.createElement('button');
    button.className = 'icon-action-button';
    button.type = 'button';
    button.textContent = '›';
    button.title = `View songs by ${artist.artist || 'Unknown Artist'}`;
    button.setAttribute('aria-label', button.title);
    button.addEventListener('click', () => {
      artistListScrollY = window.scrollY || document.documentElement.scrollTop || 0;
      loadArtistSongs(artist.artist || 'Unknown Artist').catch((err) => setMessage(err.message, true));
    });
    top.append(info, button);
    row.addEventListener('click', (event) => {
      if (event.target !== button) button.click();
    });
    row.append(top);
    artistList.append(row);
  }
}

async function loadArtistSongs(artist) {
  if (requestsAreClosed()) {
    setPage('search');
    return;
  }
  artistList.hidden = true;
  artistSongsHeader.hidden = false;
  artistSongs.hidden = false;
  artistSongsTitle.textContent = artist;
  renderEmpty(artistSongs, 'Loading songs…');
  const response = await fetch(`/api/browse/artist-songs?artist=${encodeURIComponent(artist)}`);
  if (await applyRequestClosedResponse(response)) return;
  if (!response.ok) throw new Error(await response.text());
  const tracks = await response.json();
  const stats = renderTrackGroups(artistSongs, tracks, 'No songs found for this artist.');
  setMessage(`${stats.tracks} version${stats.tracks === 1 ? '' : 's'} in ${stats.groups} song${stats.groups === 1 ? '' : 's'}`);
}

async function loadSongs(prefix = currentSongPrefix) {
  if (requestsAreClosed()) {
    setPage('search');
    return;
  }
  currentSongPrefix = prefix;
  renderInitialSelector(songInitials, currentSongPrefix, (next) => loadSongs(next).catch((err) => setMessage(err.message, true)));
  renderEmpty(songResults, 'Loading songs…');
  const response = await fetch(`/api/browse/songs?prefix=${encodeURIComponent(prefix)}`);
  if (await applyRequestClosedResponse(response)) return;
  if (!response.ok) throw new Error(await response.text());
  const tracks = await response.json();
  const stats = renderTrackGroups(songResults, tracks, 'No songs found.');
  setMessage(`${stats.tracks} version${stats.tracks === 1 ? '' : 's'} in ${stats.groups} song${stats.groups === 1 ? '' : 's'}`);
}

function renderResultGroup(group) {
  const first = group[0];
  const row = document.createElement('article');
  row.className = 'result-card';

  const top = document.createElement('div');
  top.className = 'result-main';

  const info = document.createElement('div');
  info.className = 'result-info';
  const title = document.createElement('h3');
  title.textContent = first.title || 'Untitled';
  const artist = document.createElement('p');
  artist.textContent = first.artist || 'Unknown Artist';
  const meta = document.createElement('div');
  meta.className = 'meta-tags';
  const hasExternal = group.some(isExternalTrack);
  if (group.length > 1 || hasExternal) {
    const sourceTag = document.createElement('span');
    sourceTag.className = `meta-tag ${hasExternal ? 'brand' : ''}`;
    sourceTag.textContent = group.length > 1
      ? `${hasExternal ? '🌐 ' : ''}${group.length} versions`
      : `${sourceIcon(first)} ${sourceLabel(first)}`;
    meta.append(sourceTag);
  }
  if (group.length === 1 && versionLabel(first)) {
    const discTag = document.createElement('span');
    discTag.className = 'meta-tag';
    discTag.textContent = versionLabel(first);
    meta.append(discTag);
  }
  info.append(title, artist, meta);

  const button = document.createElement('button');
  button.className = 'icon-action-button';
  button.type = 'button';
  button.textContent = group.length > 1 ? '☰' : '⋯';
  button.title = group.length > 1 ? 'Choose version' : 'Options';
  button.setAttribute('aria-label', group.length > 1 ? 'Choose version' : 'Options');
  button.addEventListener('click', () => {
    if (group.length > 1) {
      openVersionDialog(group);
    } else {
      openOptionsDialog(first);
    }
  });

  top.append(info, button);
  row.append(top);
  return row;
}

function renderTrackOptions(track) {
  const key = trackKey(track);
  const options = document.createElement('div');
  options.className = 'result-options expanded';

  if (!isExternalTrack(track)) {
    const keyControls = document.createElement('div');
    keyControls.className = 'key-controls';
    const keyLabel = document.createElement('span');
    keyLabel.textContent = `Key: ${formatKeyAdjustment(keyAdjustments.get(key) || 0)}`;
    const down = document.createElement('button');
    down.className = 'secondary compact';
    down.textContent = '−';
    down.addEventListener('click', () => {
      const next = Math.max(-6, (keyAdjustments.get(key) || 0) - 1);
      keyAdjustments.set(key, next);
      keyLabel.textContent = `Key: ${formatKeyAdjustment(next)}`;
    });
    const up = document.createElement('button');
    up.className = 'secondary compact';
    up.textContent = '+';
    up.addEventListener('click', () => {
      const next = Math.min(6, (keyAdjustments.get(key) || 0) + 1);
      keyAdjustments.set(key, next);
      keyLabel.textContent = `Key: ${formatKeyAdjustment(next)}`;
    });
    keyControls.append(keyLabel, down, up);
    options.append(keyControls);
  }

  const actions = document.createElement('div');
  actions.className = 'option-actions';

  const add = document.createElement('button');
  add.className = `icon-action-button option-icon-button ${recentlyAdded.has(key) ? 'success' : 'primary'}`;
  add.textContent = recentlyAdded.has(key) ? '✓' : '+';
  add.title = recentlyAdded.has(key) ? 'Added' : 'Add to queue';
  add.setAttribute('aria-label', recentlyAdded.has(key) ? 'Added' : 'Add to queue');
  add.disabled = recentlyAdded.has(key);
  add.addEventListener('click', () => requestTrack(track, add));

  const lyrics = document.createElement('button');
  lyrics.className = 'icon-action-button option-icon-button secondary';
  lyrics.textContent = '♪';
  lyrics.title = 'View lyrics';
  lyrics.setAttribute('aria-label', 'View lyrics');
  lyrics.addEventListener('click', () => openLyrics(track));

  actions.append(add, lyrics);
  options.append(actions);
  return options;
}

function openOptionsDialog(track) {
  optionsDialogTitle.textContent = `${track.title || 'Untitled'} Options`;
  optionsDialogBody.replaceChildren();
  const meta = document.createElement('p');
  meta.className = 'muted';
  meta.textContent = [
    track.artist || 'Unknown Artist',
    isExternalTrack(track) ? `${sourceIcon(track)} ${sourceLabel(track)}` : '',
    versionLabel(track),
  ].filter(Boolean).join(' · ');
  optionsDialogBody.append(meta, renderTrackOptions(track));
  optionsDialog.showModal();
}

function formatKeyAdjustment(value) {
  return value > 0 ? `+${value}` : String(value);
}

function openVersionDialog(group) {
  activeVersionLyricsTrack = group[0] || null;
  versionDialogTitle.textContent = trackLabel(group[0]);
  versionList.replaceChildren();
  for (const track of group) {
    const row = document.createElement('article');
    row.className = 'version-row';

    const info = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = displayVersionLabel(track);
    const meta = document.createElement('span');
    meta.textContent = [
      isExternalTrack(track) ? `${sourceIcon(track)} ${sourceLabel(track)}` : '',
      versionLabel(track) && versionLabel(track) !== title.textContent ? versionLabel(track) : '',
    ].filter(Boolean).join(' · ');
    info.append(title, meta);

    const optionsButton = document.createElement('button');
    optionsButton.className = 'icon-action-button';
    optionsButton.type = 'button';
    optionsButton.textContent = '⋯';
    optionsButton.title = 'Options';
    optionsButton.setAttribute('aria-label', 'Options');
    optionsButton.addEventListener('click', () => openOptionsDialog(track));

    row.append(info, optionsButton);
    versionList.append(row);
  }
  versionDialog.showModal();
}

function requestBodyForTrack(track, requestedBy) {
  const body = {
    trackId: track.id,
    requestedBy,
    singerUuid: getSingerUuid(),
    keyAdjustment: isExternalTrack(track) ? 0 : keyAdjustments.get(trackKey(track)) || 0,
  };
  if (isExternalTrack(track)) {
    body.external = {
      title: track.title,
      artist: track.artist,
      url: track.externalUrl,
      brand: track.brand || track.discId,
      source: track.source || 'karaoke-nerds',
    };
  }
  return body;
}

async function requestTrack(track, button) {
  const requestedBy = requireSingerName();
  if (!requestedBy) return;

  button.disabled = true;
  button.textContent = '…';
  const response = await fetch('/api/requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBodyForTrack(track, requestedBy)),
  });

  if (await applyRequestClosedResponse(response)) {
    button.disabled = false;
    button.textContent = '+';
    return;
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    button.disabled = false;
    button.textContent = '+';
    setMessage(error.error || 'Request failed', true);
    return;
  }

  const key = trackKey(track);
  recentlyAdded.add(key);
  button.textContent = '✓';
  button.className = 'icon-action-button option-icon-button success';
  const toastText = `Added "${trackLabel(track)}" to ${requestedBy}'s queue.`;
  setMessage(toastText);
  closeRequestPopups();
  showToast(toastText);
  setTimeout(() => recentlyAdded.delete(key), 3000);
  await refreshQueue();
}

async function openLyrics(track) {
  lyricsDialogTitle.textContent = `${track.title || 'Untitled'} Lyrics`;
  lyricsContent.textContent = 'Loading…';
  lyricsDialog.showModal();
  try {
    const response = await fetch(`https://api.lyrics.ovh/v1/${encodeURIComponent(track.artist || '')}/${encodeURIComponent(track.title || '')}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('Lyrics not found');
    const data = await response.json();
    lyricsContent.textContent = data.lyrics || 'No lyrics available';
  } catch {
    lyricsContent.textContent = 'Lyrics not found';
  }
}

async function refreshQueue() {
  const name = singerName();
  const uuid = getSingerUuid();
  if (!name && !uuid) {
    renderEmpty(queueEl, 'Enter your name to see your queue.');
    updateQueueFooter();
    return;
  }
  const params = new URLSearchParams({ singerUuid: uuid });
  if (name) params.set('name', name);
  const response = await fetch(`/api/my-queue?${params.toString()}`);
  if (!response.ok) throw new Error(await response.text());
  lastQueueItems = await response.json();
  renderQueue();
  updateQueueFooter();
}

function updateQueueFooter() {
  const nextSong = lastQueueItems.find((item) => item.status === 'playing') || lastQueueItems.find((item) => item.status === 'queued');
  queueFooterSummary.textContent = nextSong
    ? `${nextSong.status === 'playing' ? '▶ Now Playing' : '⏳ Up Next'}: ${trackLabel(nextSong)}`
    : 'No songs in queue yet — tap to view';
}

function renderQueue() {
  queueEl.replaceChildren();
  if (lastQueueItems.length === 0) {
    renderEmpty(queueEl, 'No queued songs yet. New requests appear here after Station syncs.');
    return;
  }
  lastQueueItems.forEach((item, index) => {
    const row = document.createElement('article');
    row.className = 'queue-item';
    row.dataset.queueId = String(item.id);
    row.draggable = item.status === 'queued';
    if (row.draggable) {
      row.title = 'Drag to reorder';
      row.addEventListener('dragstart', (event) => {
        draggedQueueId = item.id;
        row.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', String(item.id));
      });
      row.addEventListener('dragend', () => {
        draggedQueueId = null;
        row.classList.remove('dragging');
      });
      row.addEventListener('dragover', (event) => {
        event.preventDefault();
        if (draggedQueueId && draggedQueueId !== item.id && item.status === 'queued') {
          row.classList.add('drop-target');
        }
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
      row.addEventListener('drop', (event) => {
        event.preventDefault();
        row.classList.remove('drop-target');
        const sourceId = draggedQueueId || event.dataTransfer.getData('text/plain');
        if (sourceId && sourceId !== item.id) {
          reorderQueueByDrag(String(sourceId), String(item.id));
        }
      });
    }

    const info = document.createElement('div');
    info.className = 'queue-info';
    const dragHandle = document.createElement('span');
    dragHandle.className = 'drag-handle';
    dragHandle.textContent = item.status === 'queued' ? '☰' : '';
    const title = document.createElement('strong');
    title.textContent = trackLabel(item);
    const meta = document.createElement('span');
    meta.textContent = `${item.status} · position ${item.position}`;
    info.append(dragHandle, title, meta);

    const controls = document.createElement('div');
    controls.className = 'queue-controls';

    const remove = document.createElement('button');
    remove.className = 'danger';
    remove.textContent = 'Remove';
    remove.disabled = item.status !== 'queued';
    remove.addEventListener('click', () => removeQueueItem(item.id));

    controls.append(remove);
    row.append(info, controls);
    queueEl.append(row);
  });
}

async function reorderQueueByDrag(sourceId, targetId) {
  const queued = lastQueueItems.filter((item) => item.status === 'queued');
  const fromIndex = queued.findIndex((item) => String(item.id) === String(sourceId));
  const toIndex = queued.findIndex((item) => String(item.id) === String(targetId));
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;

  const reorderedQueued = [...queued];
  reorderedQueued.splice(toIndex, 0, reorderedQueued.splice(fromIndex, 1)[0]);
  const queueIds = reorderedQueued.map((item) => item.id);
  const nextQueued = [...reorderedQueued];
  lastQueueItems = lastQueueItems.map((item) => item.status === 'queued' ? nextQueued.shift() : item);
  renderQueue();
  updateQueueFooter();
  await sendQueueReorder(queueIds);
}

async function sendQueueReorder(queueIds) {
  await fetch('/api/my-queue/reorder', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: singerName(),
      singerUuid: getSingerUuid(),
      queueIds,
    }),
  }).then(async (response) => {
    if (!response.ok) throw new Error((await response.json()).error || 'Reorder failed');
    setMessage('Queue order update sent to Station.');
  }).catch((err) => {
    setMessage(err.message, true);
    refreshQueue().catch(() => {});
  });
}

async function removeQueueItem(queueId) {
  const params = new URLSearchParams({ singerUuid: getSingerUuid() });
  if (singerName()) params.set('name', singerName());
  const response = await fetch(`/api/my-queue/${encodeURIComponent(queueId)}?${params.toString()}`, { method: 'DELETE' });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Remove failed' }));
    setMessage(error.error || 'Remove failed', true);
    return;
  }
  setMessage('Remove request sent to Station.');
  await refreshQueue();
}

async function openHistory() {
  const name = requireSingerName();
  if (!name) return;
  historyList.replaceChildren();
  renderEmpty(historyList, 'Loading history…');
  historyDialog.showModal();
  await refreshHistory();
}

async function refreshHistory() {
  const params = new URLSearchParams({ name: singerName(), singerUuid: getSingerUuid() });
  const response = await fetch(`/api/history/self?${params.toString()}`);
  if (!response.ok) {
    renderEmpty(historyList, 'Could not load history.');
    return;
  }
  const data = await response.json();
  const songs = Array.isArray(data.songs) ? data.songs.filter(isCompletedHistorySong) : [];
  renderHistory(songs);
}

function renderHistory(songs) {
  historyList.replaceChildren();
  if (songs.length === 0) {
    renderEmpty(historyList, 'No completed songs in history yet.');
    return;
  }
  for (const song of songs) {
    const row = document.createElement('article');
    row.className = 'version-row';

    const info = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = [song.artist, song.title].filter(Boolean).join(' - ') || song.title || 'Untitled';
    const meta = document.createElement('span');
    const completedAt = song.completedAt || song.requestedAt;
    meta.textContent = [song.status || 'completed', completedAt ? new Date(completedAt).toLocaleString() : ''].filter(Boolean).join(' · ');
    info.append(title, meta);

    const recall = document.createElement('button');
    recall.className = 'action-menu-button';
    recall.textContent = 'Recall';
    recall.disabled = !canRecallHistorySong(song);
    recall.title = recall.disabled ? 'This history item cannot be recalled because it is missing track details.' : 'Add this song to your queue again';
    recall.addEventListener('click', () => recallHistorySong(song, recall));

    row.append(info, recall);
    historyList.append(row);
  }
}

async function recallHistorySong(song, button) {
  const requestedBy = requireSingerName();
  if (!requestedBy || !canRecallHistorySong(song)) return;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = 'Adding…';
  try {
    const isExternal = Boolean(song.track?.url);
    const trackId = isExternal ? await externalTrackIdForUrl(song.track.url) : song.track.trackId;
    const body = {
      trackId,
      requestedBy,
      singerUuid: getSingerUuid(),
      keyAdjustment: isExternal ? 0 : Number(song.keyAdjustment || 0),
    };
    if (isExternal) {
      body.external = {
        title: song.title,
        artist: song.artist,
        url: song.track.url,
        source: song.track.source || 'karaoke-nerds',
      };
    }
    const response = await fetch('/api/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (await applyRequestClosedResponse(response)) return;
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Could not recall song' }));
      throw new Error(error.error || 'Could not recall song');
    }
    button.textContent = 'Added';
    setMessage(`Recalled "${[song.artist, song.title].filter(Boolean).join(' - ') || song.title}" to ${requestedBy}'s queue.`);
    await refreshQueue();
  } catch (error) {
    button.disabled = false;
    button.textContent = originalText;
    setMessage(error.message || 'Could not recall song', true);
  }
}

async function exportHistory() {
  const name = requireSingerName();
  if (!name) return;
  const params = new URLSearchParams({ name, singerUuid: getSingerUuid() });
  const response = await fetch(`/api/history/self/export?${params.toString()}`);
  if (!response.ok) {
    setMessage('Could not export singer history.', true);
    return;
  }
  downloadJsonFile(safeHistoryFilename(name), await response.json());
  setMessage('Singer history exported.');
}

function readJsonFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(JSON.parse(String(reader.result || '')));
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => reject(reader.error || new Error('Could not read file'));
    reader.readAsText(file);
  });
}

async function importHistory(file) {
  const name = requireSingerName();
  if (!name || !file) return;
  try {
    const data = await readJsonFile(file);
    const response = await fetch('/api/history/self/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, singerUuid: getSingerUuid(), data }),
    });
    if (!response.ok) throw new Error('Import failed');
    const result = await response.json();
    setMessage(`Imported ${Number(result.imported || 0)} history song${Number(result.imported || 0) === 1 ? '' : 's'}.`);
  } catch {
    setMessage('Could not import singer history.', true);
  } finally {
    historyImportInput.value = '';
  }
}

searchButton.addEventListener('click', () => {
  searchInput.blur();
  search().catch((err) => setMessage(err.message, true));
});
searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    searchInput.blur();
    search().catch((err) => setMessage(err.message, true));
  }
});
searchInput.addEventListener('input', updateClearSearchVisibility);
clearSearchButton.addEventListener('click', () => {
  searchInput.value = '';
  updateClearSearchVisibility();
  renderEmpty(resultsEl, 'Search for a song to get started.');
  setMessage('');
  searchInput.focus();
});
pageTabs.forEach((tab) => {
  tab.addEventListener('click', () => setPage(tab.dataset.page || 'search'));
});
backToArtistsButton.addEventListener('click', () => {
  artistSongsHeader.hidden = true;
  artistSongs.hidden = true;
  artistList.hidden = false;
  setMessage('');
  requestAnimationFrame(() => {
    window.scrollTo({ top: artistListScrollY, behavior: 'auto' });
  });
});
profileButton.addEventListener('click', (event) => {
  event.stopPropagation();
  profileMenu.hidden = !profileMenu.hidden;
});
editNameButton.addEventListener('click', () => {
  profileMenu.hidden = true;
  openNameDialog();
});
logoutButton.addEventListener('click', () => {
  profileMenu.hidden = true;
  logoutProfile();
});
document.addEventListener('click', (event) => {
  if (!profileMenu.hidden && !profileMenu.contains(event.target) && !profileButton.contains(event.target)) {
    profileMenu.hidden = true;
  }
});
queueFooter.addEventListener('click', () => {
  renderQueue();
  queueDialog.showModal();
});
openHistoryDialogButton.addEventListener('click', () => {
  openHistory().catch((err) => setMessage(err.message, true));
});
closeQueueDialog.addEventListener('click', () => queueDialog.close());
closeHistoryDialog.addEventListener('click', () => historyDialog.close());
closeVersionDialog.addEventListener('click', () => versionDialog.close());
versionLyricsButton.addEventListener('click', () => {
  if (!activeVersionLyricsTrack) return;
  versionDialog.close();
  openLyrics(activeVersionLyricsTrack).catch((err) => setMessage(err.message, true));
});
closeLyricsDialog.addEventListener('click', () => lyricsDialog.close());
closeOptionsDialog.addEventListener('click', () => optionsDialog.close());
nameDialogSave.addEventListener('click', () => {
  if (saveSingerName(nameDialogInput.value)) nameDialog.close();
});
nameDialogInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && saveSingerName(nameDialogInput.value)) nameDialog.close();
});
nameDialogInput.addEventListener('input', () => {
  nameDialogError.textContent = '';
});
nameDialog.addEventListener('cancel', (event) => {
  if (!requestsAreClosed() && !validateSingerName(singerName()).valid) event.preventDefault();
});
nameDialog.addEventListener('close', () => {
  if (!requestsAreClosed() && !validateSingerName(singerName()).valid) {
    setTimeout(() => openNameDialog(), 0);
  }
});
exportHistoryButton.addEventListener('click', () => {
  profileMenu.hidden = true;
  exportHistory();
});
importHistoryButton.addEventListener('click', () => {
  profileMenu.hidden = true;
  historyImportInput.click();
});
historyImportInput.addEventListener('change', () => importHistory(historyImportInput.files?.[0]));

singerNameInput.value = localStorage.getItem(singerNameKey) || '';
updateProfileButton();
updateClearSearchVisibility();
renderEmpty(resultsEl, 'Search for a song to get started.');
updateRequestPageVisibility();
await loadPublicConfig();
renderInitialSelector(artistInitials, currentArtistPrefix, (next) => loadArtists(next).catch((err) => setMessage(err.message, true)));
renderInitialSelector(songInitials, currentSongPrefix, (next) => loadSongs(next).catch((err) => setMessage(err.message, true)));
if (!requestsAreClosed()) {
  await refreshQueue().catch(() => renderEmpty(queueEl, 'Queue is not available yet.'));
}
if (!requestsAreClosed() && !validateSingerName(singerName()).valid) openNameDialog();
setInterval(() => {
  loadPublicConfig()
    .then(() => {
      if (!requestsAreClosed()) refreshQueue().catch(() => {});
    })
    .catch(() => {});
}, 5000);
