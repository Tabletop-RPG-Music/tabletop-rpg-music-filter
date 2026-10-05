// Tabletop RPG Music - Filter & Importer
//


(() => {
"use strict";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

// ---------------------------------------------------------------------------
// Module-level data
// ---------------------------------------------------------------------------

const MODULE_ID = "tabletop-rpg-music-filter";

// Content modules advertise themselves via a flag in their module.json,
// namespaced by this module's id:
//
//   "flags": {
//     "tabletop-rpg-music-filter": {
//       "schema": 1,
//       "label": "Patreon",                       // optional short badge label
//       "priority": 50,                           // optional; higher wins a tie
//       "tracks": "data/tracks.json",             // path within the module
//       "audio": {
//         "type": "remote" | "local",
//         "base": "<absolute URL>" | "<dir relative to module root>",
//         "layout": "typeFolders" | "explicit"
//       }
//     }
//   }
//
// "typeFolders" resolves paths from the track's trackType + normalised title
// (the streaming CDN convention). "explicit" reads `file` / `loopFile` from
// each track entry (the convention for downloadable packs).
const FLAG_SCOPE = MODULE_ID;
const SUPPORTED_SCHEMA = 1;

// Catalogue of every track in the library, with the pack each is sold in.
// Entries no installed source provides are shown as locked cards: previewable
// from the CDN, but not importable.
const CATALOGUE_PATH = `modules/${MODULE_ID}/data/catalogue.json`;
const SUPPORTED_CATALOGUE_SCHEMA = 1;

// The catalogue lists every track that exists, including packs the user has not
// installed, so it has to be able to grow without a module release. It is
// fetched from tabletoprpgmusic.com, cached locally, and falls back to the copy
// bundled with this module. Order of preference at startup: cache, then bundled, so the
// window opens immediately; the network copy is fetched in the background and
// applied when it arrives.
// Served from the site's data/ folder, which already sends Cache-Control:
// no-cache. It needs Access-Control-Allow-Origin, since the request comes from
// the GM's own Foundry host rather than from the site.
const REMOTE_CATALOGUE_URL   = "https://tabletoprpgmusic.com/data/catalogue.json";
const CATALOGUE_CACHE_KEY    = `${MODULE_ID}.catalogue`;
const CATALOGUE_FETCH_TIMEOUT = 8000;

const PATREON_MODULE_ID   = "tabletop-rpg-music-patreon";

// Download formats a pack can offer per track, keyed as in its tracks.json
// "downloads" object, in the order the download menu lists them.
const DOWNLOAD_FORMATS = [
  { key: "ogg",     label: "Ogg",                    icon: "fa-file-audio" },
  { key: "oggLoop", label: "Ogg, seamless loop",     icon: "fa-repeat" },
  { key: "wav",     label: "WAV",                    icon: "fa-wave-square" },
  { key: "mp3",     label: "MP3",                    icon: "fa-file-audio" },
  { key: "hour",    label: "One hour version",       icon: "fa-clock" }
];

const PATREON_PACKAGE_URL = `https://foundryvtt.com/packages/${PATREON_MODULE_ID}`;

// When several installed modules offer the same track, the one with the highest
// priority wins. Sources declare it in their flag; these are the fallbacks for
// modules that don't. Packs and Patreon carry the same Ogg audio, so their order
// is about delivery, and the audio setting can swap it; the free module ranks
// last because its MP3s have no looping versions:
//   100  downloadable pack (local ogg, served by the Foundry host)
//    50  Patreon module (the same ogg, streamed from the CDN)
//    10  free module (local mp3, no looping versions)
// A source that declares no priority sits between the CDN and the free module,
// so an unknown third-party source never silently outranks a paid pack.
const DEFAULT_PRIORITY = { local: 40, remote: 45 };
const STREAM_PREFERENCE_BONUS = 1000;

// Registered sources ({ id, title, label, audio }) and the merged database.
let sources = [];
let sourceTracks = new Map();   // sourceId -> raw track array
let trackDatabase = [];         // merged + deduplicated, owned only
let lockedTracks = [];          // catalogue entries no installed source provides
let catalogueTracks = [];       // raw catalogue entries
let catalogueByKey = new Map(); // trackKey -> catalogue entry, for provenance
let catalogueGenerated = "";    // "generated" date of the catalogue in use
let trackDatabaseReady = null;

const TRACK_FOLDERS = {
  bonus:     { normal: "bonustracks",     loop: "bonustracksloop"     },
  alternate: { normal: "alternatetracks", loop: "alternatetracksloop" },
  standard:  { normal: "standardtracks",  loop: "standardtracksloop"  }
};

// Hardcoded tag list. If you want to derive this from the JSON at some point,
// this is the place to change it. Kept as a single source of truth rather than
// being inlined in prepareContext.
// Broadest first, matching the website: which world, what the music is for,
// what it sounds like, where it happens, then how it feels. Tags within each
// category are alphabetical.
const TAG_CATEGORIES = [
  { category: "Setting", tags: ["Cyberpunk", "Fantasy", "Modern", "Science Fiction", "Steampunk"] },
  { category: "Type",    tags: ["Atmosphere", "Combat", "Suspense", "Theme"] },
  { category: "Timbre",  tags: ["Acoustic", "Choral", "Electronic", "Hybrid", "Orchestral"] },
  { category: "Scene",   tags: ["Airship", "Arctic", "Boss", "Camp", "City", "Desert", "Dungeon", "Forest", "Jungle", "Planar", "Road", "Ruins", "Skirmish", "Space", "Swamp", "Tavern", "Temple", "Town", "Underwater", "Voyage", "Wilds"] },
  { category: "Mood",    tags: ["Brutal", "Creepy", "Dark", "Epic", "Ethereal", "Festive", "Fun", "Haunting", "Heroic", "Industrial", "Mystery", "Mystical", "Otherworldly", "Peaceful", "Positive", "Regal", "Rustic", "Sacred", "Sombre", "Wondrous"] }
];

const FILTER_CATEGORY_ORDER = TAG_CATEGORIES.map(c => c.category);

// Track data stores tags lowercase ("science fiction") while filters key on the
// canonical name ("Science Fiction"), so a card's tag has to be mapped back
// before it can drive the same toggle the rail uses.
const CANONICAL_TAGS = new Map();
for (const { category, tags } of TAG_CATEGORIES) {
  for (const name of tags) CANONICAL_TAGS.set(`${category}:${name.toLowerCase()}`, name);
}

const DEFAULT_SOUND_VOLUME = 0.52;
const PREVIEW_BASE_VOLUME  = 0.52;

const AUDIO_EXTENSION_RE = /\.(ogg|mp3|webm|wav|flac|m4a)$/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stable identity for deduplication across sources. */
function trackKey(track) {
  return (track.trackId ?? track.title).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Resolve a source's base path/URL to a usable prefix. */
function audioBase(source) {
  const base = String(source.audio.base ?? "").replace(/\/+$/, "");
  if (source.audio.type === "remote") return base;
  return `modules/${source.id}/${base.replace(/^\/+/, "")}`;
}

/**
 * Compute the audio file URL for a track.
 *
 * typeFolders: trackType folder + whitelist-normalised title (alphanumerics
 * only - safer than blacklisting specific punctuation). Looping variants are
 * always assumed to exist on the CDN.
 *
 * explicit: `file` / `loopFile` from the track entry. When a looping variant
 * was requested but the pack didn't ship one, fall back to the normal file
 * (the import still sets repeat, so it loops - just not seamlessly).
 */
function getAudioFilePath(track, useLooping) {
  const source = track.source;
  if (source.audio.layout === "typeFolders") {
    const folders = TRACK_FOLDERS[track.trackType] ?? TRACK_FOLDERS.standard;
    const folder = useLooping ? folders.loop : folders.normal;
    const normalizedTitle = track.title.replace(/[^A-Za-z0-9]/g, "");
    return `${audioBase(source)}/${folder}/${normalizedTitle}.ogg`;
  }
  const file = useLooping ? (track.loopFile || track.file) : track.file;
  if (!file) return null;
  return `${audioBase(source)}/${file}`;
}

/** Short badge label for a source: explicit flag label, else a trimmed title. */
function sourceLabel(mod, cfg) {
  if (cfg.label) return String(cfg.label);
  return mod.title.replace(/^Tabletop RPG Music\s*[-:]\s*/i, "").trim() || mod.id;
}

// ---------------------------------------------------------------------------
// Source discovery and database merging
// ---------------------------------------------------------------------------

function discoverSources() {
  const found = [];
  for (const mod of game.modules) {
    if (!mod.active) continue;
    const cfg = mod.flags?.[FLAG_SCOPE];
    if (!cfg?.tracks || !cfg?.audio) continue;
    if ((cfg.schema ?? 1) > SUPPORTED_SCHEMA) {
      console.warn(`${MODULE_ID} | Skipping "${mod.id}": declares schema ${cfg.schema}, this version supports up to ${SUPPORTED_SCHEMA}. Update the filter module.`);
      continue;
    }
    found.push({
      id: mod.id,
      title: mod.title,
      label: sourceLabel(mod, cfg),
      tracks: cfg.tracks,
      audio: cfg.audio,
      priority: Number.isFinite(cfg.priority)
        ? cfg.priority
        : (DEFAULT_PRIORITY[cfg.audio.type] ?? DEFAULT_PRIORITY.local)
    });
  }
  return found;
}

async function loadSource(source) {
  try {
    const response = await fetch(`modules/${source.id}/${String(source.tracks).replace(/^\/+/, "")}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error("tracks.json is not an array");
    sourceTracks.set(source.id, data);
    console.log(`${MODULE_ID} | Loaded ${data.length} tracks from "${source.id}"`);
  } catch (err) {
    console.error(`${MODULE_ID} | Failed to load tracks from "${source.id}"`, err);
    sourceTracks.set(source.id, []);
  }
}

/**
 * The download links a pack ships for a track, keeping only https URLs. The
 * values come from a module's own data file, so this is less about trust than
 * about a typo or a placeholder turning into a broken or unsafe link.
 */
function safeDownloads(d) {
  if (!d || typeof d !== "object") return null;
  const ok = v => typeof v === "string" && /^https:\/\//i.test(v.trim());
  const out = {};
  for (const { key } of DOWNLOAD_FORMATS) if (ok(d[key])) out[key] = d[key].trim();
  return Object.keys(out).length ? out : null;
}

/** "3:04" from 184. */
function formatDuration(seconds) {
  const n = Math.round(Number(seconds));
  if (!Number.isFinite(n) || n <= 0) return "";
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}

/** Validate a parsed catalogue payload, returning its tracks or null. */
function readCatalogue(data, origin) {
  if (!data || typeof data !== "object") return null;
  if ((data.schema ?? 1) > SUPPORTED_CATALOGUE_SCHEMA) {
    console.warn(`${MODULE_ID} | ${origin} catalogue declares schema ${data.schema}; this version supports up to ${SUPPORTED_CATALOGUE_SCHEMA}. Ignoring it.`);
    return null;
  }
  if (!Array.isArray(data.tracks) || !data.tracks.length) return null;
  return data;
}

/** The cached copy of the last catalogue successfully fetched from the CDN. */
function readCachedCatalogue() {
  try {
    const raw = localStorage.getItem(CATALOGUE_CACHE_KEY);
    if (!raw) return null;
    return readCatalogue(JSON.parse(raw), "cached");
  } catch (err) {
    return null;
  }
}

function writeCachedCatalogue(data) {
  try {
    localStorage.setItem(CATALOGUE_CACHE_KEY, JSON.stringify(data));
  } catch (err) {
    // Quota or private browsing: the catalogue still works, it just refetches.
    console.warn(`${MODULE_ID} | Could not cache the catalogue locally.`, err);
  }
}

/** Load the bundled copy, or the cached one if it is newer. Never networks. */
async function loadCatalogue() {
  let chosen = null;
  let origin  = "none";

  try {
    const response = await fetch(CATALOGUE_PATH);
    if (response.ok) {
      chosen = readCatalogue(await response.json(), "bundled");
      origin = "bundled";
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | No usable bundled catalogue.`, err);
  }

  const cached = readCachedCatalogue();
  // "generated" is an ISO date written by the catalogue build; if it is missing
  // on either side, prefer whichever lists more tracks rather than guessing.
  if (cached && (!chosen
      || (cached.generated ?? "") > (chosen.generated ?? "")
      || (!cached.generated && !chosen.generated && cached.tracks.length > chosen.tracks.length))) {
    chosen = cached;
    origin = "cached";
  }

  catalogueTracks = chosen?.tracks ?? [];
  catalogueGenerated = chosen?.generated ?? "";
  console.log(`${MODULE_ID} | Catalogue (${origin}): ${catalogueTracks.length} tracks`);
}

/**
 * Fetch the catalogue from the CDN in the background. Applied only if it parses
 * and actually differs, so a failed or unchanged fetch costs nothing and a
 * GM who is offline never notices.
 */
async function refreshCatalogueFromRemote() {
  if (!game.settings.get(MODULE_ID, "updateCatalogue")) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CATALOGUE_FETCH_TIMEOUT);
  try {
    const response = await fetch(REMOTE_CATALOGUE_URL, {
      signal: controller.signal,
      cache: "no-cache"
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = readCatalogue(await response.json(), "remote");
    if (!data) return;

    // Almost always the site's copy matches the one already loaded; rebuilding
    // and redrawing for an identical catalogue would be wasted work, and a
    // visible flicker if the window is open.
    if (data.generated && data.generated === catalogueGenerated
        && data.tracks.length === catalogueTracks.length) {
      console.log(`${MODULE_ID} | Catalogue already current (${data.generated}).`);
      return;
    }

    writeCachedCatalogue(data);

    catalogueTracks = data.tracks;
    catalogueGenerated = data.generated ?? "";
    rebuildDatabase();
    MusicLibraryApp.instance?.render();
    console.log(`${MODULE_ID} | Catalogue updated from ${REMOTE_CATALOGUE_URL}: ${data.tracks.length} tracks`);
  } catch (err) {
    // Offline, blocked, or slow: the bundled or cached catalogue stands.
    console.log(`${MODULE_ID} | Catalogue not refreshed from the CDN.`, err?.message ?? err);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Effective priority for a source under the current audio preference.
 *
 * "downloaded" uses the declared priority as-is, so a local pack beats the CDN
 * beats the free module. "streaming" lifts every remote source above all local
 * ones, for GMs who would rather not spend the disk space. Either way the free
 * module's mp3s only win when nothing else offers the track.
 */
function effectivePriority(source, preference) {
  const base = source.priority ?? DEFAULT_PRIORITY.local;
  if (preference === "streaming" && source.audio.type === "remote") {
    return base + STREAM_PREFERENCE_BONUS;
  }
  return base;
}

/**
 * Merge all loaded sources into one database, deduplicating by trackKey.
 * When the same track is offered by several sources, highest priority wins;
 * ties fall to the source discovered first.
 */
function rebuildDatabase() {
  const preference = game.settings.get(MODULE_ID, "audioSource");
  const merged = new Map();

  for (const source of sources) {
    for (const raw of (sourceTracks.get(source.id) ?? [])) {
      if (!raw?.title) continue;
      const track = {
        ...raw,
        trackType: raw.trackType ?? "standard",
        source,
        // Every source that has this track, not just the one whose copy plays.
        // The Sources picker filters on this, so choosing a source shows all of
        // its tracks even where another source's copy won the priority check.
        providedBy: [source.id],
        hasLoop: source.audio.layout === "typeFolders" ? true : Boolean(raw.loopFile)
      };
      const key = trackKey(raw);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, track);
        continue;
      }
      const winner = effectivePriority(source, preference) > effectivePriority(existing.source, preference)
        ? track : existing;
      const loser  = winner === track ? existing : track;
      winner.providedBy = [...new Set([...existing.providedBy, source.id])];
      // Downloads belong to whoever bought the pack, not to whichever copy plays.
      // Someone who owns a pack and prefers streaming from Patreon still owns
      // the pack's WAVs, so they follow the track across the dedupe.
      if (!winner.downloads && loser.downloads) winner.downloads = loser.downloads;
      merged.set(key, winner);
    }
  }

  trackDatabase = [...merged.values()];

  // Anything in the catalogue that no installed source provides becomes a
  // locked card. The synthetic source keeps the rest of the pipeline (source
  // badges, visibility filtering) working without special-casing.
  catalogueByKey = new Map();
  for (const entry of catalogueTracks) {
    if (entry?.title) catalogueByKey.set(trackKey(entry), entry);
  }

  const seen = new Set();
  lockedTracks = [];
  for (const entry of catalogueTracks) {
    if (!entry?.title) continue;
    const key = trackKey(entry);
    if (merged.has(key) || seen.has(key)) continue;
    seen.add(key);
    // Tracks in no pack are only available through Patreon, so they group under
    // a source of their own rather than being left out of the catalogue.
    const source = entry.pack
      ? { id: `catalogue:${entry.pack.id}`, label: entry.pack.label, locked: true }
      : { id: `catalogue:${PATREON_MODULE_ID}`, label: "Patreon", locked: true };
    lockedTracks.push({
      ...entry,
      trackType: entry.trackType ?? "standard",
      locked:    true,
      // Every pack and Patreon track ships a looping version; what a locked card
      // lacks is a looping *preview*, which is a playback detail rather than a
      // property of the product. Marking these false would strike them through
      // in Seamless Loop mode and imply the pack has no loop for them.
      hasLoop:   true,
      source
    });
  }

  console.log(`${MODULE_ID} | Database rebuilt: ${trackDatabase.length} owned track(s) from ${sources.length} source(s), ${lockedTracks.length} locked`);
}

// ---------------------------------------------------------------------------
// Init: discover sources and load track databases
// ---------------------------------------------------------------------------

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "audioSource", {
    name: "Which copy of a track to use",
    hint: "Only makes a difference if you have both a Tabletop RPG Music pack and the Patreon module, since they include the same tracks. Local packs are sent to players by your Foundry server; the Patreon module streams from the Tabletop RPG Music CDN. (The free module's local copies are only used when no other module has the track, due to them using inferior mp3 format)",
    scope: "world",
    config: true,
    type: String,
    choices: {
      downloaded: "Local packs first",
      streaming:  "Patreon module streaming first"
    },
    default: "downloaded",
    onChange: () => {
      rebuildDatabase();
      MusicLibraryApp.instance?.render();
    }
  });

  game.settings.register(MODULE_ID, "updateCatalogue", {
    name: "Check for new music packs",
    hint: "Fetches the list of available Tabletop RPG Music packs from tabletoprpgmusic.com when the world loads, so newly released packs appear without updating this module. No data is sent. Disable to use only the list bundled with this module.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "railWidth", {
    scope: "client",
    config: false,
    type: Number,
    default: 230
  });

  sources = discoverSources();

  trackDatabaseReady = Promise.all([...sources.map(loadSource), loadCatalogue()]).then(() => {
    rebuildDatabase();
    // Deliberately not awaited: the window opens on the bundled or cached
    // catalogue, and updates itself if and when the CDN answers.
    refreshCatalogueFromRemote();
    return trackDatabase;
  });

  // Handlebars helpers
  Handlebars.registerHelper("eq",       (a, b)        => a === b);
  Handlebars.registerHelper("contains", (array, value) => Array.isArray(array) && array.includes(value));

  // Context menu extension. Use the namespaced class (v13+) and fall back to
  // the v12 class. v12 declares it as a top-level class in foundry.js, which
  // is reachable by its bare name but is not a property of globalThis, hence
  // the typeof check rather than globalThis.PlaylistDirectory. The ?? means
  // the bare name is never touched on v13+, where it is deprecated.
  // Note: in v13+ _getEntryContextOptions() takes no arguments, so `entry` is
  // only meaningful on v12.
  const PD = foundry.applications?.sidebar?.tabs?.PlaylistDirectory
          ?? (typeof PlaylistDirectory !== "undefined" ? PlaylistDirectory : undefined);
  if (!PD?.prototype?._getEntryContextOptions) {
    console.warn(`${MODULE_ID} | Playlist directory not found; the right-click import option is unavailable.`);
    return;
  }
  const proto = PD.prototype;
  const original = proto._getEntryContextOptions;
  proto._getEntryContextOptions = function (entry) {
    const options = original.call(this, entry);
    options.push({
      name: "Import Tabletop RPG Music Tracks",
      icon: '<i class="fas fa-music"></i>',
      condition: () => sources.length > 0,
      callback: element => MusicLibraryApp._onContextMenuImport(element)
    });
    return options;
  };
});

// Expose a small API for anything that wants to inspect the merged library.
Hooks.once("ready", () => {
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = {
    get sources() { return sources; },
    get tracks() { return trackDatabase; },
    open: () => (MusicLibraryApp.instance ?? new MusicLibraryApp()).render({ force: true })
  };

  if (!sources.length && game.user.isGM) {
    console.warn(`${MODULE_ID} | No Tabletop RPG Music content modules detected. Install and enable the Patreon module or a music pack.`);
  }
});

// ---------------------------------------------------------------------------
// MusicLibraryApp (ApplicationV2)
// ---------------------------------------------------------------------------

class MusicLibraryApp extends HandlebarsApplicationMixin(ApplicationV2) {

  /** Singleton-style reference to the currently open instance (or null). */
  static instance = null;

  constructor(options = {}) {
    super(options);

    this.filters = Object.fromEntries(
      FILTER_CATEGORY_ORDER.map(cat => [cat, { include: [], exclude: [] }])
    );

    this.extraControls = {
      showStandard: true,
      showBonus:    true,
      showAlternate: true,
      showOnlyNew:  false,
      showAll:      false   // overrides the source picker entirely when on
    };

    // Which sources the Sources picker has selected. Unowned packs are added
    // lazily by _selectableSources(), deselected.
    this.sourceVisibility = Object.fromEntries(sources.map(s => [s.id, true]));

    // Rail state. Pills wrap, so every category fits open without the rail
    // becoming a column of a hundred lines; collapsing is there for when a
    // category is in the way rather than as the default.
    this.collapsedCategories = new Set();
    this.tagFilterTerm    = "";

    this.playbackMode     = "standard"; // "standard" or "seamless"
    this.forceLoopImport  = false;
    this.importQueue      = [];

    this.currentlyPlayingTrackTitle = "";
    this.currentlyPlayingAudio      = null;

    this.sortAlphabetical = false;
    this.searchTerm       = "";
    this._searchDebounce  = null;
    this.playlistName     = "";

    MusicLibraryApp.instance = this;
  }

  // -------------------------------------------------------------------------
  // Application configuration
  // -------------------------------------------------------------------------

  static DEFAULT_OPTIONS = {
    id: "music-library-app",
    tag: "div",
    window: {
      title: "Tabletop RPG Music Importer",
      icon: "fas fa-music",
      resizable: true
    },
    position: {
      width:  880,
      height: 900
    },
    actions: {
      toggleSort:      MusicLibraryApp._onToggleSort,
      toggleCategory:  MusicLibraryApp._onToggleCategory,
      toggleTag:       MusicLibraryApp._onToggleTag,
      clearFilters:    MusicLibraryApp._onClearFilters,
      addAll:          MusicLibraryApp._onAddAll,
      queueTrack:      MusicLibraryApp._onQueueTrack,
      clearQueue:      MusicLibraryApp._onClearQueue,
      play:            MusicLibraryApp._onPlay,
      stop:            MusicLibraryApp._onStop,
      importNew:       MusicLibraryApp._onImportNew
    }
  };

  static PARTS = {
    main: {
      template: "modules/tabletop-rpg-music-filter/templates/music-filter.html",
      // ApplicationV2 automatically preserves scroll position on these
      // selectors across re-renders.
      scrollable: [".content", ".rail-scroll"]
    }
  };

  // Enforce a minimum width. _updatePosition is the "resolve a requested
  // position" hook; _onPosition fires after the DOM is already styled, so
  // clamping there was a no-op.
  _updatePosition(position) {
    if (typeof position.width === "number") position.width = Math.max(position.width, 500);
    return super._updatePosition(position);
  }

  // -------------------------------------------------------------------------
  // Caret preservation across re-renders
  //
  // The whole window is a single PART, so every this.render() replaces the
  // search box with a fresh element built from the template. ApplicationV2
  // restores focus to it but not the caret, and a newly parsed input that is
  // focused puts the caret at index 0 - so each debounced search render sent
  // the next keystroke to the front of the string. These two hooks carry the
  // selection across the swap for whichever text field is focused, which
  // covers the search box and the playlist name field alike.
  // -------------------------------------------------------------------------

  _preSyncPartState(partId, newElement, priorElement, state) {
    super._preSyncPartState(partId, newElement, priorElement, state);
    const focused = priorElement.querySelector(":focus");
    if (focused && typeof focused.selectionStart === "number") {
      state.trpgSelection = {
        start:     focused.selectionStart,
        end:       focused.selectionEnd,
        direction: focused.selectionDirection || "none"
      };
    }
  }

  _syncPartState(partId, newElement, priorElement, state) {
    super._syncPartState(partId, newElement, priorElement, state);
    const sel = state.trpgSelection;
    if (!sel) return;
    // super has just restored focus; only touch the field that actually has it.
    const active = document.activeElement;
    if (!active || !newElement.contains(active)) return;
    if (typeof active.setSelectionRange !== "function") return;
    const max = active.value?.length ?? 0;
    try {
      active.setSelectionRange(Math.min(sel.start, max), Math.min(sel.end, max), sel.direction);
    }
    catch (err) {
      // Some input types refuse selection ranges; nothing to recover here.
    }
  }

  async close(options = {}) {
    clearTimeout(this._searchDebounce);
    clearTimeout(this._tagFilterDebounce);
    this._stopPreview();
    if (MusicLibraryApp.instance === this) MusicLibraryApp.instance = null;
    return super.close(options);
  }

  // -------------------------------------------------------------------------
  // Context preparation
  // -------------------------------------------------------------------------

  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    // Wait for the track databases to finish loading before we render.
    // Fixes the race condition where the window opens faster than fetch().
    if (trackDatabaseReady) await trackDatabaseReady;

    const filtered = this._getFilteredTracks();

    // How many of the listed tracks carry each tag. A tag with no count, and
    // no include or exclude on it, can only produce zero results if added
    // (includes are AND'd), so it is marked dead and dimmed, as on the site.
    const counts = new Map();
    for (const track of filtered) {
      for (const [cat, tags] of Object.entries(track.tags || {})) {
        for (const t of tags) {
          const k = `${cat}:${String(t).toLowerCase()}`;
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
      }
    }

    const railTerm = this.tagFilterTerm.trim().toLowerCase();
    const tagCategories = TAG_CATEGORIES.map(({ category, tags }) => {
      const built = tags
        .filter(name => !railTerm || name.toLowerCase().includes(railTerm))
        .map(name => {
          const { include, exclude } = this.filters[category];
          let cssClass = "";
          if (include.includes(name)) cssClass = "include";
          else if (exclude.includes(name)) cssClass = "exclude";
          else if (!counts.has(`${category}:${name.toLowerCase()}`)) cssClass = "dead";
          return {
            name, cssClass,
            dead: cssClass === "dead",
            count: counts.get(`${category}:${name.toLowerCase()}`) ?? 0
          };
        });
      const active = this.filters[category].include.length + this.filters[category].exclude.length;
      return {
        category,
        tags: built,
        // A search in the rail expands everything, otherwise a match inside a
        // collapsed category would be invisible.
        collapsed: railTerm ? false : this.collapsedCategories.has(category),
        activeCount: active,
        totalCount: built.length
      };
    }).filter(c => c.tags.length > 0);

    // A source label on every card only means something when the grid mixes
    // sources; with one pack showing it would just repeat on every card.
    const mixedSources = new Set(filtered.map(t => t.source?.id)).size > 1;

    // Worked out once and reused below, rather than recomputed per use.
    const selectable = this._selectableSources();
    const skips      = this._queueSkips();
    const lockedShown = filtered.reduce((n, t) => n + (t.locked ? 1 : 0), 0);

    // Chips for what is currently filtered, so the state is readable without
    // scanning the rail for highlighted tags.
    const activeFilters = [];
    for (const { category } of TAG_CATEGORIES) {
      for (const name of this.filters[category].include) {
        activeFilters.push({ category, name, mode: "include" });
      }
      for (const name of this.filters[category].exclude) {
        activeFilters.push({ category, name, mode: "exclude" });
      }
    }

    return Object.assign(context, {
      noSources:         sources.length === 0,
      // The picker is worth showing whenever there is more than one thing to
      // choose between, which includes packs that aren't installed.
      multiSource:       selectable.length > 1,
      // "New" marks this month's Patreon releases, so the filter is meaningless
      // without that module.
      offerNewOnly:      sources.some(s => s.id === PATREON_MODULE_ID),
      noSourcesSelected: !this._showingAll()
        && selectable.every(s => this.sourceVisibility[s.id] !== true),
      sourcePickerDisabled: this._showingAll(),
      railWidth:         game.settings.get(MODULE_ID, "railWidth"),
      sources:           selectable.map(s => {
        const bare = s.id.replace(/^catalogue:/, "");
        return {
          id: s.id,
          label: s.label,
          installed: s.installed,
          buyUrl: bare === PATREON_MODULE_ID
            ? PATREON_PACKAGE_URL
            : `https://foundryvtt.com/packages/${bare}`,
          // The picker keeps showing its own selection even while Show all tracks
          // overrides it: the block is dimmed and disabled, so the chips read as
          // what will apply again once the override is off, and the rail does
          // not change height when the box is ticked.
          visible: this.sourceVisibility[s.id] === true
        };
      }),
      tagCategories,
      activeFilters,
      hasActiveFilters:  activeFilters.length > 0,
      tagFilterTerm:     this.tagFilterTerm,
      filters:           this.filters,
      extraControls:     this.extraControls,
      playbackMode:      this.playbackMode,
      // When seamless, forceLoopImport is always effectively true.
      forceLoopImport:   this.playbackMode === "seamless" ? true : this.forceLoopImport,
      forceLoopDisabled: this.playbackMode === "seamless",
      importQueue:       this.importQueue,
      queueSkipCount:    skips.length,
      queueSkipMessage:  skips.length === 0 ? ""
        : skips.length === 1
          ? "1 selected track has no seamless looping version and will be skipped. Switch to Normal format to include it."
          : `${skips.length} selected tracks have no seamless looping version and will be skipped. Switch to Normal format to include them.`,
      sortAlphabetical:  this.sortAlphabetical,
      searchTerm:        this.searchTerm,
      playlistName:      this.playlistName,
      // Shown as the name field's placeholder, so the auto-generated name is
      // visible before the playlist is created.
      suggestedPlaylistName: this.importQueue.length ? this._computeFallbackPlaylistTitle() : "",
      existingPlaylists: game.playlists
        .map(p => ({ _id: p.id, name: p.name, count: p.sounds?.size ?? 0 }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      totalTracks:       filtered.length,
      lockedShown,
      ownedShown:        filtered.length - lockedShown,
      showAll:           this._showingAll(),
      offerUnowned:      this._canOfferUnowned(),
      tracksToDisplay:   filtered.map(track => {
        const provs   = this._providersFor(track);
        const owned   = provs.find(p => p.owned);
        const pack    = provs.find(p => !p.owned && p.label !== "Patreon");
        const patreon = provs.find(p => !p.owned && p.label === "Patreon");
        // Pack and Patreon data carry no art or length, so owned tracks borrow
        // both from the catalogue entry for the same track.
        const entry   = catalogueByKey.get(trackKey(track));
        return {
          ...track,
          locked:        Boolean(track.locked),
          // On the art, beside ALT: the source it's installed from (only when
          // the grid mixes sources), and where to buy it if it isn't owned.
          ownedBadge:    owned && mixedSources ? owned : null,
          packLink:      pack ?? null,
          patreonLink:   patreon ?? null,
          // The lock on an unowned card links to its pack, or to Patreon if the
          // track isn't in a pack.
          buyUrl:        track.pack?.url ?? PATREON_PACKAGE_URL,
          buyLabel:      track.pack?.label ?? "the Patreon module",
          downloads:     track.locked ? null : safeDownloads(track.downloads),
          image:         track.image ?? entry?.image ?? "",
          duration:      formatDuration(track.duration ?? entry?.duration),
          isAlt:         track.trackType === "alternate",
          isBonus:       track.trackType === "bonus",
          isNew:         Boolean(track.isNew),
          playing:       this.currentlyPlayingTrackTitle === track.title,
          canPreview:    track.locked ? Boolean(track.preview) : true,
          // Seamless mode asks for a file some sources don't ship (the free
          // module has no looping versions). Mark those cards rather than
          // silently substituting the standard file.
          noLoop:        this.playbackMode === "seamless" && !track.hasLoop,
          // Every tag is drawn; _fitCardTags hides the ones that don't fit.
          flattenedTags: this._flattenTrackTags(track)
        };
      })
    });
  }

  /**
   * Sources offered in the picker: everything installed, then every pack you
   * don't own, and Patreon if it isn't installed. Selecting an unowned one
   * browses its tracks.
   */
  _selectableSources() {
    const list = sources.map(s => ({ id: s.id, label: s.label, installed: true }));
    // Seed visibility explicitly rather than relying on undefined: installed
    // sources start selected, packs you don't own start deselected, and every
    // read below can then test for exactly true.
    for (const s of list) {
      if (this.sourceVisibility[s.id] === undefined) this.sourceVisibility[s.id] = true;
    }
    // Packs you don't have are always offered, listed after the ones you do,
    // and are deselected by default so the picker isn't full of tags you never
    // asked for. Selecting one browses that pack.
    const seen = new Set(list.map(s => s.id));
    const unowned = [];
    for (const track of lockedTracks) {
      if (seen.has(track.source.id)) continue;
      seen.add(track.source.id);
      unowned.push({ id: track.source.id, label: track.source.label, installed: false });
    }
    unowned.sort((a, b) => a.label.localeCompare(b.label));
    for (const s of unowned) {
      if (this.sourceVisibility[s.id] === undefined) this.sourceVisibility[s.id] = false;
    }
    return list.concat(unowned);
  }

  /** Locked pack sources the user has chosen to browse. */
  _visibleLockedSourceIds() {
    return this._selectableSources()
      .filter(s => !s.installed && this.sourceVisibility[s.id] === true)
      .map(s => s.id);
  }

  /**
   * Every place this track can be had from: what you already have it in, plus
   * anywhere it can still be bought. Owned entries are plain labels, the rest
   * are links. Shown regardless of which sources are currently filtered in, so
   * narrowing to one source doesn't hide where else a track lives.
   */
  _providersFor(track) {
    const out = [];
    if (!track.locked) {
      out.push({ label: track.source.label, owned: true, noLoop: !track.hasLoop });
    }

    const entry = catalogueByKey.get(trackKey(track));
    if (entry?.pack && !sources.some(s => s.id === entry.pack.id)) {
      out.push({
        label: entry.pack.label,
        url: entry.pack.url,
        owned: false,
        tooltip: `Available in ${entry.pack.label} - click to view`
      });
    }

    // Patreon carries everything, so it is only worth offering when the user
    // has no looping copy of this track already.
    const patreonInstalled = sources.some(s => s.id === PATREON_MODULE_ID);
    const haveLoop = !track.locked && track.hasLoop;
    const alreadyListed = out.some(p => p.label === "Patreon");
    if (!haveLoop && !patreonInstalled && entry && !alreadyListed) {
      out.push({
        label: "Patreon",
        url: PATREON_PACKAGE_URL,
        owned: false,
        // Names the thing rather than the platform: a bare "Patreon" reads as a
        // link to the page, not a module you install.
        tooltip: "Available in the Patreon-exclusive module - click to view"
      });
    }
    return out;
  }

  /** Whether there are any unowned tracks to offer. */
  _canOfferUnowned() {
    return lockedTracks.length > 0;
  }

  /** True when the All tracks override is on. */
  _showingAll() {
    return this.extraControls.showAll && this._canOfferUnowned();
  }

  /** Look a track up across both owned and locked sets. */
  _findTrack(title) {
    return trackDatabase.find(t => t.title === title)
        ?? lockedTracks.find(t => t.title === title)
        ?? null;
  }

  _flattenTrackTags(track) {
    if (!track.tags) return [];
    const flat = [];
    // Walk the categories in rail order rather than the order the data happens
    // to store them, so a card reads Setting, Type, Timbre, Scene, Mood too.
    const ordered = [...FILTER_CATEGORY_ORDER, ...Object.keys(track.tags).filter(c => !FILTER_CATEGORY_ORDER.includes(c))];
    for (const cat of ordered) {
      if (!Array.isArray(track.tags[cat])) continue;
      for (const raw of track.tags[cat]) {
        const canonical = CANONICAL_TAGS.get(`${cat}:${String(raw).toLowerCase()}`);
        // A tag with no canonical match is still shown, just not clickable:
        // better than hiding data because the catalogue has drifted.
        if (!canonical) {
          flat.push({ label: raw, category: "", name: "", state: "", clickable: false });
          continue;
        }
        const { include, exclude } = this.filters[cat] ?? { include: [], exclude: [] };
        flat.push({
          label: raw,
          category: cat,
          name: canonical,
          state: include.includes(canonical) ? "include" : exclude.includes(canonical) ? "exclude" : "",
          clickable: true
        });
      }
    }
    return flat;
  }

  // -------------------------------------------------------------------------
  // Filtering
  // -------------------------------------------------------------------------

  _getFilteredTracks() {
    let tracks = trackDatabase;

    if (this._showingAll()) {
      // The override shows the whole catalogue and the picker is disabled, so
      // per-source visibility is skipped rather than fought with.
      tracks = tracks.concat(lockedTracks);
    } else {
      const browsing = new Set(this._visibleLockedSourceIds());
      if (browsing.size) tracks = tracks.concat(lockedTracks.filter(t => browsing.has(t.source.id)));
      // A track shows if any source that has it is selected. Locked tracks have
      // one stand-in source each, so they fall back to that.
      tracks = tracks.filter(t => (t.providedBy ?? [t.source.id]).some(id => this.sourceVisibility[id] === true));
    }

    if (!this.extraControls.showStandard) tracks = tracks.filter(t => t.trackType !== "standard");
    if (!this.extraControls.showBonus)    tracks = tracks.filter(t => t.trackType !== "bonus");
    if (!this.extraControls.showAlternate) tracks = tracks.filter(t => t.trackType !== "alternate");
    if (this.extraControls.showOnlyNew && sources.some(s => s.id === PATREON_MODULE_ID)) {
      tracks = tracks.filter(t => t.isNew);
    }

    tracks = tracks.filter(track => {
      for (const category of FILTER_CATEGORY_ORDER) {
        const includes = this.filters[category].include.map(t => t.toLowerCase());
        const excludes = this.filters[category].exclude.map(t => t.toLowerCase());
        const trackTags = (track.tags && track.tags[category])
          ? track.tags[category].map(t => t.toLowerCase())
          : [];

        // Require ALL include tags to be present.
        if (includes.length && !includes.every(tag => trackTags.includes(tag))) return false;
        // Exclude if ANY exclude tag is present.
        if (excludes.length && excludes.some(tag => trackTags.includes(tag))) return false;
      }
      return true;
    });

    const searchLower = this.searchTerm.trim().toLowerCase();
    if (searchLower) {
      tracks = tracks.filter(t => t.title.toLowerCase().includes(searchLower));
    }

    if (this.sortAlphabetical) {
      tracks.sort((a, b) => a.title.localeCompare(b.title));
    } else {
      tracks.sort((a, b) => (b.releaseOrder || 0) - (a.releaseOrder || 0));
    }

    return tracks;
  }

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------

  /**
   * Build PlaylistSound document data from the current selection.
   * Used by Create playlist, the split button's menu and the sidebar
   * right-click import, so the three paths can't drift apart.
   */
  _buildSoundsFromQueue() {
    return this.importQueue
      .map(title => {
        const track = trackDatabase.find(t => t.title === title);
        // Locked tracks never reach the queue, but the queue also survives a
        // module being disabled between sessions, so guard here as well.
        if (!track || track.locked) return null;
        // The queue survives a format switch, so re-check rather than quietly
        // importing the standard file in place of a loop that doesn't exist.
        if (this.playbackMode === "seamless" && !track.hasLoop) {
          console.warn(`${MODULE_ID} | Skipping "${track.title}": no looping version available.`);
          return null;
        }
        const path = getAudioFilePath(track, this.playbackMode === "seamless");
        if (!path || !AUDIO_EXTENSION_RE.test(path)) {
          console.error(`Invalid audio file path for track ${track.title}: ${path}`);
          return null;
        }
        return {
          name:    track.title,
          path,
          volume:  DEFAULT_SOUND_VOLUME,
          playing: false,
          repeat:  this.playbackMode === "seamless" || this.forceLoopImport
        };
      })
      .filter(Boolean);
  }

  /**
   * Join a list for display without letting it run away. With a handful of
   * packs the names are useful; with thirty they are noise, so cap and count.
   */
  static _summariseNames(names, max = 3) {
    const unique = [...new Set(names.filter(Boolean))];
    if (!unique.length) return "";
    if (unique.length <= max) return unique.join(", ");
    return `${unique.slice(0, max).join(", ")} and ${unique.length - max} more`;
  }

  /** Queued tracks that the current format can't actually import. */
  _queueSkips() {
    if (this.playbackMode !== "seamless") return [];
    return this.importQueue.filter(title => {
      const track = this._findTrack(title);
      return track && !track.hasLoop;
    });
  }

  /** Warn once, in the UI, about queued tracks that will be left behind. */
  _notifyQueueSkips() {
    const skips = this._queueSkips();
    if (!skips.length) return;
    ui.notifications.warn(
      `${skips.length} track${skips.length === 1 ? "" : "s"} skipped with no seamless looping version: ${MusicLibraryApp._summariseNames(skips)}.`
    );
  }

  _stopPreview() {
    if (!this.currentlyPlayingAudio) return;
    try { this.currentlyPlayingAudio.stop(); }
    catch (err) { console.error("Error stopping audio", err); }
    this.currentlyPlayingAudio      = null;
    this.currentlyPlayingTrackTitle = "";
  }

  /**
   * Suggest names for a playlist of the selected tracks. A port of
   * suggestPlaylistNames() from tabletoprpgmusic.com:
   *
   *   1. the active include filters, which say most directly what the GM was
   *      after, in Setting, Type, Scene, Mood, Timbre order;
   *   2. otherwise the tag in each category that most of the tracks share,
   *      counted only if at least 60% of them carry it;
   *   3. and "Session mix (N tracks)" as the fallback.
   *
   * Up to three suggestions, none of them a name an existing playlist uses.
   */
  _suggestPlaylistNames() {
    const cap = s => String(s).replace(/(^|\s)\S/g, c => c.toUpperCase());
    const groupOrder = ["Setting", "Type", "Scene", "Mood", "Timbre"];
    const tracks = this.importQueue.map(t => this._findTrack(t)).filter(Boolean);
    const n = tracks.length;

    // 1. Active include-filters, in a readable order
    const fromFilters = groupOrder.flatMap(g => this.filters[g]?.include ?? []);

    // 2. Tag coverage across the tracks being saved
    const counts = {};
    for (const t of tracks) {
      for (const [g, tags] of Object.entries(t.tags || {})) {
        for (const tag of tags) {
          const k = `${g}:${String(tag).toLowerCase()}`;
          counts[k] = (counts[k] || 0) + 1;
        }
      }
    }
    const bestPerGroup = g => {
      const entries = Object.entries(counts)
        .filter(([k]) => k.startsWith(g + ":"))
        .sort((a, b) => b[1] - a[1]);
      // only suggest a tag most of the tracks actually share
      return entries.length && entries[0][1] >= n * 0.6 ? entries[0][0].split(":")[1] : null;
    };
    const fromTags = groupOrder.map(bestPerGroup).filter(Boolean);

    const names = [];
    if (fromFilters.length) names.push(cap(fromFilters.slice(0, 3).join(" · ")));
    if (fromTags.length)    names.push(cap(fromTags.slice(0, 3).join(" · ")));
    if (fromTags.length > 1) names.push(cap(`${fromTags[0]} ${fromTags[1]}`));
    names.push(`Session mix (${n} track${n === 1 ? "" : "s"})`);

    // Never suggest a name an existing playlist already has.
    const taken = new Set(game.playlists.map(pl => pl.name));
    const unique = name => {
      if (!taken.has(name)) return name;
      for (let i = 2; ; i++) if (!taken.has(`${name} ${i}`)) return `${name} ${i}`;
    };
    return [...new Set(names)].slice(0, 3).map(unique);
  }

  /** The name used when the playlist name field is left blank. */
  _computeFallbackPlaylistTitle() {
    return this._suggestPlaylistNames()[0] ?? "Session mix";
  }

  // -------------------------------------------------------------------------
  // Non-action listeners (text inputs, selects, checkboxes with bound data)
  // -------------------------------------------------------------------------

  _onRender(context, options) {
    super._onRender?.(context, options);
    const root = this.element;

    // Track type checkboxes (showStandard / showBonus / etc.)
    root.querySelectorAll(".extra-control").forEach(el => {
      el.addEventListener("change", ev => {
        const control = ev.currentTarget.dataset.control;
        if (control in this.extraControls) {
          this.extraControls[control] = ev.currentTarget.checked;
          this.render();
        }
      });
    });

    // Rail width lives as a custom property on .music-library itself, not on the
    // application element: the stylesheet declares the property on that element,
    // and a declaration there always beats a value inherited from an ancestor.
    const library = root.matches(".music-library") ? root : root.querySelector(".music-library");
    library?.style.setProperty("--trpg-rail-width", `${context.railWidth}px`);

    const resizer = root.querySelector(".rail-resizer");
    if (resizer && library) {
      resizer.addEventListener("pointerdown", ev => {
        ev.preventDefault();
        const rail = library.querySelector(".filter-rail");
        if (!rail) return;
        const startX = ev.clientX;
        const startWidth = rail.getBoundingClientRect().width;
        try { resizer.setPointerCapture(ev.pointerId); } catch (err) { /* older browsers */ }
        library.classList.add("resizing-rail");

        const onMove = moveEv => {
          const next = Math.round(Math.min(460, Math.max(150, startWidth + moveEv.clientX - startX)));
          library.style.setProperty("--trpg-rail-width", `${next}px`);
        };
        const onUp = () => {
          resizer.removeEventListener("pointermove", onMove);
          resizer.removeEventListener("pointerup", onUp);
          resizer.removeEventListener("pointercancel", onUp);
          library.classList.remove("resizing-rail");
          const final = parseInt(library.style.getPropertyValue("--trpg-rail-width"), 10);
          if (Number.isFinite(final)) game.settings.set(MODULE_ID, "railWidth", final);
        };
        resizer.addEventListener("pointermove", onMove);
        resizer.addEventListener("pointerup", onUp);
        resizer.addEventListener("pointercancel", onUp);
      });
    }

    // Source multi-select. An empty selection shows nothing and says so, rather
    // than silently re-selecting everything.
    const sourceSelect = root.querySelector("multi-select.source-select");
    sourceSelect?.addEventListener("change", ev => {
      const chosen = Array.from(ev.currentTarget.value ?? []);
      for (const src of this._selectableSources()) {
        this.sourceVisibility[src.id] = chosen.includes(src.id);
      }
      this.render();
    });

    // Foundry renders each selected source as
    //   <div class="tag" data-key="VALUE"><span>Label</span><a class="remove">…</a></div>
    // inside div.tags. Unowned packs are matched by that key, and their label
    // becomes a link to buy them. Removal is bound to the .remove anchor, not
    // the chip, so the link can't trigger it. The markup is core's and
    // undocumented: if it changes, nothing matches and the picker still works.
    if (sourceSelect) {
      const unowned = new Map((context.sources ?? [])
        .filter(src => !src.installed)
        .map(src => [src.id, src]));

      requestAnimationFrame(() => {
        for (const chip of sourceSelect.querySelectorAll("div.tag[data-key]")) {
          const src = unowned.get(chip.dataset.key);
          if (!src) continue;
          const label = chip.querySelector("span");
          if (!label || label.querySelector("a.chip-buy")) continue;

          const link = document.createElement("a");
          link.className = "chip-buy";
          link.href = src.buyUrl;
          link.target = "_blank";
          link.rel = "noopener";
          link.dataset.tooltip = `Open the ${src.label} listing`;
          link.textContent = label.textContent;

          label.textContent = "";
          label.appendChild(link);
          chip.classList.add("chip-unowned");
        }
      });
    }

    // Tag rail search: narrows which tags are listed, not which tracks match.
    // Debounced for the same reason as the track search below.
    const tagFilterInput = root.querySelector(".tag-rail-search");
    if (tagFilterInput) {
      tagFilterInput.addEventListener("input", ev => {
        this.tagFilterTerm = ev.currentTarget.value;
        clearTimeout(this._tagFilterDebounce);
        this._tagFilterDebounce = setTimeout(() => this.render(), 200);
      });
    }

    // Search input: debounced re-render.
    const searchInput = root.querySelector(".tag-search");
    if (searchInput) {
      searchInput.addEventListener("input", ev => {
        this.searchTerm = ev.currentTarget.value;
        // The timer lives on the instance, not in this closure: a render
        // triggered by anything else replaces the element and with it the
        // closure, leaving an orphaned timer that nothing can cancel.
        clearTimeout(this._searchDebounce);
        this._searchDebounce = setTimeout(() => this.render(), 150);
      });
    }

    // Playlist name input (single source of truth is this.playlistName).
    // Bound on "input" rather than "change": a re-render triggered before the
    // field blurs repaints it from {{playlistName}}, so the state must stay
    // current on every keystroke or mid-typing renders wipe the name.
    const playlistNameInput = root.querySelector("#playlist-name-input");
    if (playlistNameInput) {
      playlistNameInput.addEventListener("input", ev => {
        this.playlistName = ev.currentTarget.value;
      });
    }

    // Split button menu: Foundry's own ContextMenu, opened on click, listing
    // playlists to add the selection to. Core component, so it takes the
    // theme's menu styling rather than a look invented here.
    const splitMenu = root.querySelector(".split-menu");
    if (splitMenu && !splitMenu.disabled) {
      // v13+ has the namespaced class, which takes a plain element. v12 only
      // has the older global, which expects the element wrapped in jQuery.
      const modern = foundry.applications?.ux?.ContextMenu;
      // v12's ContextMenu is a top-level class in foundry.js: reachable by its
      // bare name, but not a property of globalThis.
      const CM = modern?.implementation ?? modern
              ?? (typeof ContextMenu !== "undefined" ? ContextMenu : undefined);
      const entries = (context.existingPlaylists ?? []).map(pl => ({
        name: `${pl.name} (${pl.count})`,
        icon: '<i class="fas fa-file-import"></i>',
        callback: () => this._addQueueToPlaylist(pl._id)
      }));
      if (CM && entries.length) {
        try {
          const host = modern ? splitMenu.parentElement : $(splitMenu.parentElement);
          new CM(host, ".split-menu", entries, {
            eventName: "click",
            jQuery: false,
            fixed: true
          });
        } catch (err) {
          console.warn(`${MODULE_ID} | Could not build the playlist menu.`, err);
        }
      }
    }

    // Download menu: one Foundry ContextMenu for the whole grid, opened by any
    // card's download button. Each format's entry only appears for cards that
    // have that link, and opens it in a new tab, which starts the download.
    const grid = root.querySelector(".card-grid");
    if (grid && grid.querySelector(".card-download")) {
      const modern = foundry.applications?.ux?.ContextMenu;
      // v12's ContextMenu is a top-level class in foundry.js: reachable by its
      // bare name, but not a property of globalThis.
      const CM = modern?.implementation ?? modern
              ?? (typeof ContextMenu !== "undefined" ? ContextMenu : undefined);
      // v13+ hands the callback the button; v12 hands it wrapped in jQuery.
      const el = target => (target instanceof HTMLElement ? target : target?.[0]);
      const entries = DOWNLOAD_FORMATS.map(f => ({
        name: f.label,
        icon: `<i class="fas ${f.icon}"></i>`,
        condition: target => Boolean(el(target)?.dataset[f.key]),
        callback:  target => {
          const url = el(target)?.dataset[f.key];
          if (url) window.open(url, "_blank", "noopener");
        }
      }));
      if (CM) {
        try {
          new CM(modern ? grid : $(grid), ".card-download", entries, {
            eventName: "click",
            jQuery: false,
            fixed: true
          });
        } catch (err) {
          console.warn(`${MODULE_ID} | Could not build the download menu.`, err);
        }
      }
    }

    // Card tags depend on laid-out chip widths, so they are fitted after the
    // browser has laid the grid out, on every render.
    requestAnimationFrame(() => this._fitCardTags());

    // First open: fit the window to three card columns. Deferred a frame so
    // the grid has laid out before it is measured.
    if (options?.isFirstRender) {
      requestAnimationFrame(() => {
        this._fitToColumns(3);
        this._fitRailHeight();
      });
    }

    // Playback mode dropdown.
    const playbackSelect = root.querySelector(".playback-mode");
    if (playbackSelect) {
      playbackSelect.addEventListener("change", ev => {
        this.playbackMode = ev.currentTarget.value;
        if (this.playbackMode === "seamless") this.forceLoopImport = false;
        this.render();
      });
    }

    // "Set to Loop" checkbox
    const forceLoopCheckbox = root.querySelector(".force-loop-import");
    if (forceLoopCheckbox) {
      forceLoopCheckbox.addEventListener("change", ev => {
        this.forceLoopImport = ev.currentTarget.checked;
        this.render();
      });
    }
  }

  /**
   * Size the window so the grid holds exactly `columns` cards with no spare
   * width. Measured rather than computed from constants, so it stays right
   * whatever the rail width, the theme's padding or the scrollbar width.
   */
  _fitToColumns(columns = 3) {
    const grid    = this.element?.querySelector(".card-grid");
    const content = this.element?.querySelector(".content");
    if (!grid || !content) return;

    const cs     = getComputedStyle(grid);
    const card   = parseFloat(cs.getPropertyValue("--trpg-card-width")) || 190;
    const gap    = parseFloat(cs.columnGap) || 8;
    const pad    = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const needed = columns * card + (columns - 1) * gap + pad;
    // content.clientWidth excludes the reserved scrollbar gutter, which is the
    // width the grid actually has to lay out in.
    const delta  = Math.ceil(needed - content.clientWidth) + 2;
    if (Math.abs(delta) < 2) return;

    const width = Math.max(600, Math.min(window.innerWidth - 40, (this.position?.width ?? 880) + delta));
    this.setPosition({ width });
  }

  /**
   * Fit each card's tag box: the same method as tabletoprpgmusic.com.
   *
   * Title lines and tag rows share a 22px grid and always total four slots:
   * a 1-line title leaves 3 tag rows, 2 lines leave 2, 3 lines leave 1. Chips
   * past the last allowed row are hidden and counted into "+N"; if "+N" then
   * wraps onto a hidden row, tags are traded back from the end until it fits.
   *
   * The decisions are the site's, but the work is batched across every card:
   * all writes, then all reads, then all writes. Done card by card, each
   * card's reads force the browser to re-lay-out the whole window after the
   * previous card's writes, which with every track showing is hundreds of
   * full layouts in a row.
   */
  _fitCardTags() {
    const ROW = 22;
    const boxes = [...(this.element?.querySelectorAll(".card-tags") ?? [])];
    const jobs = [];

    // Write: reset every card to all chips visible, "+N" hidden.
    for (const box of boxes) {
      const chips = [...box.querySelectorAll(".card-tag:not(.more)")];
      const more  = box.querySelector(".card-tag.more");
      if (!chips.length || !more) continue;
      for (const c of chips) c.hidden = false;
      more.hidden = true;
      jobs.push({ box, chips, more });
    }

    // Read: title lines and every chip's row, in one layout.
    for (const job of jobs) {
      const first = job.chips[0];
      if (!first.offsetHeight) { job.skip = true; continue; }   // not laid out
      const title = job.box.parentElement.querySelector(".card-title");
      const titleLines = title ? Math.min(3, Math.max(1, Math.round(title.offsetHeight / ROW))) : 1;
      job.maxRows = 4 - titleLines;
      job.rowY = first.offsetTop;
      job.rowH = first.offsetHeight + 4;                         // + gap
      job.rowOf = c => Math.round((c.offsetTop - job.rowY) / job.rowH);
      job.hide = job.chips.map(c => job.rowOf(c) >= job.maxRows);
    }

    // Write: apply the hides and the "+N" counts.
    const live = jobs.filter(j => !j.skip);
    for (const job of live) {
      job.box.style.maxHeight = `${job.maxRows * ROW - 4}px`;
      job.chips.forEach((c, i) => { c.hidden = job.hide[i]; });
      job.hidden = job.hide.filter(Boolean).length;
      if (job.hidden) {
        job.more.hidden = false;
        job.more.textContent = `+${job.hidden}`;
      }
    }

    // Read then write, repeated: any "+N" that wrapped onto a hidden row gives
    // up the last visible tag. Only the affected cards go round again, and it
    // settles in a pass or two.
    let pending = live.filter(j => j.hidden);
    for (let pass = 0; pass < 8 && pending.length; pass++) {
      const wrapped = pending.filter(j => j.rowOf(j.more) >= j.maxRows);   // read
      for (const job of wrapped) {                                          // write
        const i = job.hide.lastIndexOf(false);
        if (i < 0) continue;
        job.hide[i] = true;
        job.chips[i].hidden = true;
        job.hidden += 1;
        job.more.textContent = `+${job.hidden}`;
      }
      pending = wrapped.filter(j => j.hide.includes(false));
    }

    // Name the hidden tags on hover. Not on the site, but the chips here are
    // also filters, so it helps to see what "+N" stands in for.
    for (const job of live) {
      if (!job.hidden) continue;
      job.more.dataset.tooltip = job.chips.filter((c, i) => job.hide[i])
        .map(c => c.textContent.trim()).join(", ");
    }
  }

  /**
   * Grow the window tall enough that the filter rail shows every section
   * without scrolling. Measured from the rail's own overflow, so it follows
   * whatever tags and sources are actually present. Never exceeds the screen.
   */
  _fitRailHeight() {
    const rail = this.element?.querySelector(".rail-scroll");
    if (!rail) return;
    const overflow = rail.scrollHeight - rail.clientHeight;
    if (overflow <= 1) return;
    const current = this.position?.height ?? 900;
    const height  = Math.min(window.innerHeight - 40, current + overflow + 4);
    if (height > current) this.setPosition({ height });
  }

  // -------------------------------------------------------------------------
  // Action handlers (data-action="xxx" in the template triggers these)
  // -------------------------------------------------------------------------

  static _onToggleSort(event, target) {
    this.sortAlphabetical = !this.sortAlphabetical;
    this.render();
  }

  static _onToggleTag(event, target) {
    const category = target.dataset.category;
    const tag      = target.dataset.tag;
    if (!category || !tag || !this.filters[category]) return;

    const { include, exclude } = this.filters[category];
    if (include.includes(tag)) {
      this.filters[category].include = include.filter(t => t !== tag);
      this.filters[category].exclude.push(tag);
    } else if (exclude.includes(tag)) {
      this.filters[category].exclude = exclude.filter(t => t !== tag);
    } else {
      this.filters[category].include.push(tag);
    }
    this.render();
  }

  static _onToggleCategory(event, target) {
    const category = target.dataset.category;
    if (!category) return;
    if (this.collapsedCategories.has(category)) this.collapsedCategories.delete(category);
    else this.collapsedCategories.add(category);
    this.render();
  }

  static _onClearFilters(event, target) {
    for (const category of FILTER_CATEGORY_ORDER) {
      this.filters[category].include = [];
      this.filters[category].exclude = [];
    }
    this.extraControls.showStandard  = true;
    this.extraControls.showBonus     = true;
    this.extraControls.showAlternate = true;
    this.extraControls.showOnlyNew   = false;
    this.extraControls.showAll       = false;
    // Back to owned-only: installed sources on, packs you don't own off.
    for (const s of sources) this.sourceVisibility[s.id] = true;
    for (const s of this._selectableSources()) {
      if (!s.installed) this.sourceVisibility[s.id] = false;
    }
    this.searchTerm = "";
    this.render();
  }

  static _onAddAll(event, target) {
    const seamless = this.playbackMode === "seamless";
    const filtered = this._getFilteredTracks();
    const lockedSkips = filtered.filter(t => t.locked);
    const loopSkips   = filtered.filter(t => !t.locked && seamless && !t.hasLoop);

    for (const track of filtered) {
      if (track.locked) continue;
      if (seamless && !track.hasLoop) continue;
      if (!this.importQueue.includes(track.title)) this.importQueue.push(track.title);
    }

    // Say so rather than silently adding fewer tracks than the list shows.
    const reasons = [];
    if (lockedSkips.length) {
      const packs = MusicLibraryApp._summariseNames(lockedSkips.map(t => t.pack?.label));
      reasons.push(`${lockedSkips.length} not installed${packs ? ` (${packs})` : ""}`);
    }
    if (loopSkips.length) reasons.push(`${loopSkips.length} with no looping version`);
    if (reasons.length) {
      const added = filtered.length - lockedSkips.length - loopSkips.length;
      ui.notifications.info(`${added} added, skipped: ${reasons.join(", ")}.`);
    }
    this.render();
  }

  static _onQueueTrack(event, target) {
    const title = target.dataset.trackTitle;
    if (!title) return;
    const track = this._findTrack(title);
    if (track?.locked) {
      ui.notifications.warn(`"${title}" is in ${track.pack?.label ?? "a pack"}, or the Patreon module. Neither is installed, so it can be previewed but not imported.`);
      return;
    }
    if (this.playbackMode === "seamless" && !track?.hasLoop && !this.importQueue.includes(title)) {
      ui.notifications.warn(`"${title}" has no seamless looping version in ${track?.source?.label ?? "this source"}. Switch to Normal format to import it.`);
      return;
    }
    if (this.importQueue.includes(title)) {
      this.importQueue = this.importQueue.filter(t => t !== title);
    } else {
      this.importQueue.push(title);
    }
    this.render();
  }

  static _onClearQueue(event, target) {
    this.importQueue = [];
    this.render();
  }

  static async _onPlay(event, target) {
    const title = target.dataset.trackTitle;
    if (!title) return;

    this._stopPreview();

    const track = this._findTrack(title);
    if (!track) return;

    const seamless = this.playbackMode === "seamless";
    // Locked tracks have no local file, so they play their 30 second preview
    // from the CDN, the same clip whichever format is selected.
    const src = track.locked
      ? (track.preview || track.previewLoop)
      : getAudioFilePath(track, seamless);
    if (!src) {
      ui.notifications.warn(`No preview available for "${title}".`);
      return;
    }

    try {
      // autoplay defaults to false (and play() returns nothing in that case),
      // and the default "interface" channel obeys the wrong volume slider.
      // The music channel applies the global playlist volume natively, so no
      // manual scaling by the core setting is needed.
      this.currentlyPlayingAudio = await foundry.audio.AudioHelper.play({
        src,
        volume:   PREVIEW_BASE_VOLUME,
        autoplay: true,
        channel:  "music"
      });
      this.currentlyPlayingTrackTitle = title;
      this.render();
    } catch (err) {
      console.error("Error playing audio", err);
      if (track.locked) {
        // Previews are the only network-dependent playback, so an offline GM
        // should be told that rather than left with a dead button.
        ui.notifications.warn("Preview unavailable. Previews of tracks you don't own need an internet connection.");
      }
    }
  }

  static _onStop(event, target) {
    const title = target.dataset.trackTitle;
    if (this.currentlyPlayingTrackTitle === title) {
      this._stopPreview();
      this.render();
    }
  }

  static async _onImportNew(event, target) {
    if (!this.importQueue.length) {
      ui.notifications.warn("No tracks in the import queue for import.");
      return;
    }

    const nameFromInput = this.playlistName.trim();
    const playlistTitle = nameFromInput || this._computeFallbackPlaylistTitle();

    const sounds = this._buildSoundsFromQueue();
    if (!sounds.length) {
      ui.notifications.warn("No valid tracks found to import.");
      return;
    }

    try {
      await Playlist.create({
        name:   playlistTitle,
        sounds,
        mode:   1,
        fade:   4000
      });
      ui.notifications.info(`Playlist imported with ${sounds.length} track${sounds.length === 1 ? "" : "s"}.`);
      this._notifyQueueSkips();
    } catch (err) {
      console.error("Failed to import playlist:", err);
      ui.notifications.error("Failed to import playlist. Check the console for details.");
    }
  }

  /** Add the current selection to a playlist by id. Used by the split menu. */
  async _addQueueToPlaylist(playlistId) {
    const playlist = game.playlists.get(playlistId);
    if (!playlist) {
      ui.notifications.error("Selected playlist not found.");
      return;
    }

    const sounds = this._buildSoundsFromQueue();
    if (!sounds.length) {
      ui.notifications.warn("No valid tracks found to add.");
      return;
    }

    await playlist.createEmbeddedDocuments("PlaylistSound", sounds);
    ui.notifications.info(`${sounds.length} track${sounds.length === 1 ? "" : "s"} added to "${playlist.name}".`);
    this._notifyQueueSkips();

    this.importQueue = [];
    this.render();
  }

  // -------------------------------------------------------------------------
  // Context menu handler (invoked from the PlaylistDirectory override)
  // -------------------------------------------------------------------------

  static _onContextMenuImport(element) {
    const $li        = $(element).closest("li.directory-item");
    const playlistId = $li.data("entryId") ?? $li.data("documentId"); // v13+ vs v12 markup
    const playlist   = game.playlists.get(playlistId);

    const lib = MusicLibraryApp.instance;
    if (!lib) {
      new MusicLibraryApp().render(true);
      return ui.notifications.info(
        "Select some tracks! You can then right-click the playlist again to import."
      );
    }

    if (!lib.importQueue.length) {
      return ui.notifications.warn("You have no tracks selected");
    }

    const sounds = lib._buildSoundsFromQueue();
    if (!sounds.length) {
      return ui.notifications.warn("No valid tracks found to import");
    }

    playlist.createEmbeddedDocuments("PlaylistSound", sounds)
      .then(() => {
        ui.notifications.info(`${sounds.length} track${sounds.length === 1 ? "" : "s"} imported`);
        lib._notifyQueueSkips();
      })
      .catch(err => ui.notifications.error(`Import failed: ${err.message}`));
  }
}

// ---------------------------------------------------------------------------
// Playlist directory: add the "Tabletop RPG Music" button
// ---------------------------------------------------------------------------

Hooks.on("renderPlaylistDirectory", (app, html) => {
  if (!sources.length) return;

  const $html = $(html);
  const $header = $html.find(".directory-header");
  if (!$header.length) return;
  if ($header.find(".music-library-btn").length) return;

  const $btn = $(`
    <button type="button" class="music-library-btn" title="Open Tabletop RPG Music" style="margin-left: 10px;">
      <i class="fas fa-music"></i> Tabletop RPG Music
    </button>
  `);

  $header.append($btn);
  // Reuse the open instance: a fresh `new` here would stack a second window
  // sharing the same DOM id and silently repoint the singleton reference.
  $btn.on("click", () => (MusicLibraryApp.instance ?? new MusicLibraryApp()).render({ force: true }));
});


// ---------------------------------------------------------------------------
// Keep the "add to existing playlist" menu current.
//
// The split button's menu is built from the playlist list at render time, so
// a playlist created, renamed or deleted while the window is open would not
// show until something else re-rendered it. Track counts in the menu go stale
// the same way. Debounced, because an import creates one PlaylistSound per
// track and each fires its own hook; this turns twenty into one render.
// ---------------------------------------------------------------------------

const refreshForPlaylistChange = foundry.utils.debounce(() => {
  const app = MusicLibraryApp.instance;
  if (app?.rendered) app.render();
}, 150);

for (const hook of ["createPlaylist", "deletePlaylist", "createPlaylistSound", "deletePlaylistSound"]) {
  Hooks.on(hook, refreshForPlaylistChange);
}
Hooks.on("updatePlaylist", (playlist, changes) => {
  // Only a rename changes what the menu shows; ignore play state, volume etc.
  if (changes && "name" in changes) refreshForPlaylistChange();
});

// ---------------------------------------------------------------------------
// Deliberate global exports.
//
// Assignment to `window` (unlike a top-level `const`) silently overwrites
// rather than throwing, so these can never break another module's script.
// `trackDatabase` and `sources` are re-assigned internally as sources load,
// so they are exposed as getters rather than copied by value.
// ---------------------------------------------------------------------------

window.getAudioFilePath = getAudioFilePath;
window.MusicLibraryApp   = MusicLibraryApp;
Object.defineProperty(window, "trackDatabase", { configurable: true, get: () => trackDatabase });
Object.defineProperty(window, "musicSources",  { configurable: true, get: () => sources });

})();
