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

// Registered sources ({ id, title, label, audio }) and the merged database.
let sources = [];
let sourceTracks = new Map();   // sourceId -> raw track array
let trackDatabase = [];         // merged + deduplicated
let trackDatabaseReady = null;

const TRACK_FOLDERS = {
  bonus:     { normal: "bonustracks",     loop: "bonustracksloop"     },
  alternate: { normal: "alternatetracks", loop: "alternatetracksloop" },
  standard:  { normal: "standardtracks",  loop: "standardtracksloop"  }
};

// Hardcoded tag list. If you want to derive this from the JSON at some point,
// this is the place to change it. Kept as a single source of truth rather than
// being inlined in prepareContext.
const TAG_CATEGORIES = [
  { category: "Mood",    tags: ["Brutal", "Creepy", "Dark", "Epic", "Ethereal", "Festive", "Fun", "Haunting", "Heroic", "Industrial", "Mystery", "Mystical", "Otherworldly", "Peaceful", "Positive", "Regal", "Rustic", "Sacred", "Sombre", "Wondrous"] },
  { category: "Timbre",  tags: ["Acoustic", "Choral", "Electronic", "Hybrid", "Orchestral"] },
  { category: "Setting", tags: ["Cyberpunk", "Fantasy", "Modern", "Science Fiction", "Steampunk"] },
  { category: "Scene",   tags: ["Airship", "Arctic", "Boss", "Camp", "City", "Desert", "Dungeon", "Forest", "Jungle", "Planar", "Road", "Ruins", "Skirmish", "Space", "Swamp", "Tavern", "Temple", "Town", "Underwater", "Voyage", "Wilds"] },
  { category: "Type",    tags: ["Atmosphere", "Suspense", "Combat", "Theme"] }
];

const FILTER_CATEGORY_ORDER = TAG_CATEGORIES.map(c => c.category);

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
      audio: cfg.audio
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
 * Merge all loaded sources into one database, deduplicating by trackKey.
 * When the same track is offered by multiple sources, the winner is chosen
 * by the "preferLocalAudio" world setting (downloaded pack files by default,
 * since they cost no bandwidth and work offline).
 */
function rebuildDatabase() {
  const preferLocal = game.settings.get(MODULE_ID, "preferLocalAudio");
  const merged = new Map();

  for (const source of sources) {
    for (const raw of (sourceTracks.get(source.id) ?? [])) {
      if (!raw?.title) continue;
      const track = {
        ...raw,
        trackType: raw.trackType ?? "standard",
        source,
        hasLoop: source.audio.layout === "typeFolders" ? true : Boolean(raw.loopFile)
      };
      const key = trackKey(raw);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, track);
        continue;
      }
      const existingLocal = existing.source.audio.type === "local";
      const incomingLocal = source.audio.type === "local";
      const incomingWins = preferLocal ? (incomingLocal && !existingLocal)
                                       : (!incomingLocal && existingLocal);
      if (incomingWins) merged.set(key, track);
    }
  }

  trackDatabase = [...merged.values()];
  console.log(`${MODULE_ID} | Database rebuilt: ${trackDatabase.length} tracks from ${sources.length} source(s)`);
}

// ---------------------------------------------------------------------------
// Init: discover sources and load track databases
// ---------------------------------------------------------------------------

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "preferLocalAudio", {
    name: "Prefer downloaded pack audio",
    hint: "When the same track is available from both a downloaded music pack and a streaming module, use the downloaded copy for previews and imports. Disable to prefer the streaming version.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => {
      rebuildDatabase();
      MusicLibraryApp.instance?.render();
    }
  });

  sources = discoverSources();

  trackDatabaseReady = Promise.all(sources.map(loadSource)).then(() => {
    rebuildDatabase();
    return trackDatabase;
  });

  // Handlebars helpers
  Handlebars.registerHelper("eq",       (a, b)        => a === b);
  Handlebars.registerHelper("contains", (array, value) => Array.isArray(array) && array.includes(value));
  Handlebars.registerHelper("length",   (array)        => (array ? array.length : 0));

  // Context menu extension. Use the namespaced class (v13+) and fall back to
  // the deprecated global on v12. Note: in v13+ _getEntryContextOptions()
  // takes no arguments, so `entry` is only meaningful on v12.
  const PD = foundry.applications?.sidebar?.tabs?.PlaylistDirectory ?? globalThis.PlaylistDirectory;
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
      showOnlyNew:  false
    };

    // Per-source visibility (only surfaced in the UI with 2+ sources).
    this.sourceVisibility = Object.fromEntries(sources.map(s => [s.id, true]));

    this.playbackMode     = "standard"; // "standard" or "seamless"
    this.forceLoopImport  = false;
    this.importQueue      = [];

    this.currentlyPlayingTrackTitle = "";
    this.currentlyPlayingAudio      = null;

    this.sortAlphabetical = false;
    this.searchTerm       = "";
    this.selectedPlaylist = "";
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
      width:  500,
      height: 1000
    },
    actions: {
      toggleSort:      MusicLibraryApp._onToggleSort,
      toggleTag:       MusicLibraryApp._onToggleTag,
      clearFilters:    MusicLibraryApp._onClearFilters,
      addAll:          MusicLibraryApp._onAddAll,
      queueTrack:      MusicLibraryApp._onQueueTrack,
      removeFromQueue: MusicLibraryApp._onRemoveFromQueue,
      clearQueue:      MusicLibraryApp._onClearQueue,
      play:            MusicLibraryApp._onPlay,
      stop:            MusicLibraryApp._onStop,
      importNew:       MusicLibraryApp._onImportNew,
      addToExisting:   MusicLibraryApp._onAddToExisting
    }
  };

  static PARTS = {
    main: {
      template: "modules/tabletop-rpg-music-filter/templates/music-filter.html",
      // ApplicationV2 automatically preserves scroll position on these
      // selectors across re-renders.
      scrollable: [".content"]
    }
  };

  // Enforce a minimum width. _updatePosition is the "resolve a requested
  // position" hook; _onPosition fires after the DOM is already styled, so
  // clamping there was a no-op.
  _updatePosition(position) {
    if (typeof position.width === "number") position.width = Math.max(position.width, 500);
    return super._updatePosition(position);
  }

  async close(options = {}) {
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

    // Dead-end detection, mirroring the site: collect every Category:tag pair
    // present in the current results; an unselected tag not in that set can
    // only produce zero results if added (includes are AND'd), so dim it.
    const present = new Set();
    for (const track of filtered) {
      for (const [cat, tags] of Object.entries(track.tags || {})) {
        for (const t of tags) present.add(`${cat}:${String(t).toLowerCase()}`);
      }
    }
    const tagCategories = TAG_CATEGORIES.map(({ category, tags }) => ({
      category,
      tags: tags.map(name => {
        const { include, exclude } = this.filters[category];
        let cssClass = "";
        if (include.includes(name)) cssClass = "include";
        else if (exclude.includes(name)) cssClass = "exclude";
        else if (!present.has(`${category}:${name.toLowerCase()}`)) cssClass = "dead";
        return { name, cssClass, dead: cssClass === "dead" };
      })
    }));

    return Object.assign(context, {
      noSources:         sources.length === 0,
      multiSource:       sources.length > 1,
      sources:           sources.map(s => ({
        id: s.id,
        label: s.label,
        visible: this.sourceVisibility[s.id] !== false
      })),
      tagCategories,
      filters:           this.filters,
      extraControls:     this.extraControls,
      playbackMode:      this.playbackMode,
      // When seamless, forceLoopImport is always effectively true.
      forceLoopImport:   this.playbackMode === "seamless" ? true : this.forceLoopImport,
      forceLoopDisabled: this.playbackMode === "seamless",
      importQueue:       this.importQueue,
      currentlyPlaying:  this.currentlyPlayingTrackTitle,
      sortAlphabetical:  this.sortAlphabetical,
      searchTerm:        this.searchTerm,
      selectedPlaylist:  this.selectedPlaylist,
      playlistName:      this.playlistName,
      existingPlaylists: game.playlists
        .map(p => ({ _id: p.id, name: p.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      totalTracks:       filtered.length,
      tracksToDisplay:   filtered.map(track => ({
        ...track,
        sourceLabel:   track.source.label,
        flattenedTags: this._flattenTrackTags(track)
      }))
    });
  }

  _flattenTrackTags(track) {
    if (!track.tags) return [];
    const flat = [];
    for (const cat in track.tags) {
      if (Array.isArray(track.tags[cat])) flat.push(...track.tags[cat]);
    }
    return flat;
  }

  // -------------------------------------------------------------------------
  // Filtering
  // -------------------------------------------------------------------------

  _getFilteredTracks() {
    let tracks = trackDatabase;

    tracks = tracks.filter(t => this.sourceVisibility[t.source.id] !== false);

    if (!this.extraControls.showStandard) tracks = tracks.filter(t => t.trackType !== "standard");
    if (!this.extraControls.showBonus)    tracks = tracks.filter(t => t.trackType !== "bonus");
    if (!this.extraControls.showAlternate) tracks = tracks.filter(t => t.trackType !== "alternate");
    if (this.extraControls.showOnlyNew)   tracks = tracks.filter(t => t.isNew);

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
   * Build PlaylistSound document data from the current import queue.
   * Used by both "Import New Playlist" and "Add to Existing Playlist" and
   * the playlist context menu, so the three paths don't drift.
   */
  _buildSoundsFromQueue() {
    return this.importQueue
      .map(title => {
        const track = trackDatabase.find(t => t.title === title);
        if (!track) return null;
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

  _stopPreview() {
    if (!this.currentlyPlayingAudio) return;
    try { this.currentlyPlayingAudio.stop(); }
    catch (err) { console.error("Error stopping audio", err); }
    this.currentlyPlayingAudio      = null;
    this.currentlyPlayingTrackTitle = "";
  }

  /**
   * Build a fallback playlist name from currently-included filter tags,
   * falling back to the current date/time if no filters are set.
   */
  _computeFallbackPlaylistTitle() {
    const parts = [];
    for (const cat of FILTER_CATEGORY_ORDER) {
      const inc = this.filters[cat]?.include;
      if (inc?.length) parts.push(inc.join(" "));
    }
    return parts.join(" ").trim() || new Date().toLocaleString();
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

    // Per-source visibility checkboxes (only rendered with 2+ sources)
    root.querySelectorAll(".source-control").forEach(el => {
      el.addEventListener("change", ev => {
        const sourceId = ev.currentTarget.dataset.source;
        if (sourceId) {
          this.sourceVisibility[sourceId] = ev.currentTarget.checked;
          this.render();
        }
      });
    });

    // Search input: debounced re-render.
    const searchInput = root.querySelector(".tag-search");
    if (searchInput) {
      let debounce;
      searchInput.addEventListener("input", ev => {
        this.searchTerm = ev.currentTarget.value;
        clearTimeout(debounce);
        debounce = setTimeout(() => this.render(), 150);
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

    // Existing playlist dropdown
    const existingSelect = root.querySelector("#existing-playlist");
    if (existingSelect) {
      existingSelect.addEventListener("change", ev => {
        this.selectedPlaylist = ev.currentTarget.value;
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

  static _onClearFilters(event, target) {
    for (const category of FILTER_CATEGORY_ORDER) {
      this.filters[category].include = [];
      this.filters[category].exclude = [];
    }
    this.extraControls.showStandard  = true;
    this.extraControls.showBonus     = true;
    this.extraControls.showAlternate = true;
    this.extraControls.showOnlyNew   = false;
    for (const s of sources) this.sourceVisibility[s.id] = true;
    this.searchTerm = "";
    this.render();
  }

  static _onAddAll(event, target) {
    const titles = this._getFilteredTracks().map(t => t.title);
    for (const title of titles) {
      if (!this.importQueue.includes(title)) this.importQueue.push(title);
    }
    this.render();
  }

  static _onQueueTrack(event, target) {
    const title = target.dataset.trackTitle;
    if (!title) return;
    if (this.importQueue.includes(title)) {
      this.importQueue = this.importQueue.filter(t => t !== title);
    } else {
      this.importQueue.push(title);
    }
    this.render();
  }

  static _onRemoveFromQueue(event, target) {
    const title = target.dataset.trackTitle ?? target.textContent.trim();
    this.importQueue = this.importQueue.filter(t => t !== title);
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

    const track = trackDatabase.find(t => t.title === title);
    if (!track) return;

    const src = getAudioFilePath(track, this.playbackMode === "seamless");
    if (!src) return;

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
      ui.notifications.info("Playlist imported successfully.");
    } catch (err) {
      console.error("Failed to import playlist:", err);
      ui.notifications.error("Failed to import playlist. Check the console for details.");
    }
  }

  static async _onAddToExisting(event, target) {
    const selectedId = this.element.querySelector("#existing-playlist")?.value;
    if (!selectedId) {
      ui.notifications.warn("Please select an existing playlist first.");
      return;
    }
    const playlist = game.playlists.get(selectedId);
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
    ui.notifications.info("Tracks added to the existing playlist successfully.");

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
      .then(() => ui.notifications.info("Tracks imported"))
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
