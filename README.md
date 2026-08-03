# Tabletop RPG Music - Filter & Importer

The shared search, filter, preview, and playlist import tool for Tabletop RPG Music content modules. This module contains no music itself. It automatically detects installed and enabled content modules (the Patreon module, Marketplace packs) and presents their combined track library in one window.

## How content modules register themselves

There is no registration API and content modules need no scripts. A content module declares itself by adding a flag to its `module.json`, namespaced by this module's id:

```json
"flags": {
  "tabletop-rpg-music-filter": {
    "schema": 1,
    "label": "Patreon",
    "tracks": "data/tracks.json",
    "audio": {
      "type": "remote",
      "base": "https://cdn.tabletoprpgmusic.com/music",
      "layout": "typeFolders"
    }
  }
}
```

On world load, the filter scans `game.modules` for active modules carrying this flag, fetches each declared `tracks` file, and merges the results.

### Flag fields

| Field | Meaning |
|---|---|
| `schema` | Tracks-format version this source uses. The filter skips sources declaring a newer schema than it supports (currently `1`) and logs a console warning telling the user to update. |
| `label` | Optional short name used for the source badge and visibility checkbox. Defaults to the module title with any "Tabletop RPG Music -" prefix stripped. |
| `tracks` | Path to the track database JSON, relative to the module root. |
| `audio.type` | `remote` (absolute URL base, streamed) or `local` (directory relative to the module root, downloaded files). |
| `audio.base` | The URL or directory that audio paths are resolved against. |
| `audio.layout` | `typeFolders` or `explicit`, see below. |

### Audio layouts

**`typeFolders`** - the streaming CDN convention. Paths are built from the track's `trackType` and its title with all non-alphanumerics stripped: `<base>/<folder>/<NormalisedTitle>.ogg`, where the folder is `standardtracks` / `bonustracks` / `alternatetracks`, with a `...loop` suffix for seamless variants. Looping variants are assumed to always exist.

**`explicit`** - the convention for downloadable packs. Each track entry names its own files:

```json
{
  "title": "A Strange World",
  "trackType": "standard",
  "file": "AStrangeWorld.ogg",
  "loopFile": "AStrangeWorldLoop.ogg",
  "tags": { "Mood": ["otherworldly"] },
  "releaseOrder": 1,
  "isNew": false
}
```

`loopFile` is optional; if absent and the user imports in Seamless Loop mode, the standard file is used with repeat enabled instead.

## Duplicate tracks across sources

Tracks are deduplicated by normalised title (or by an optional `trackId` field if present, which wins over the title). When the same track is offered by more than one enabled source, the world setting **Prefer downloaded pack audio** (default on) decides which copy is used for previews and imports: pack files by default, since they cost no bandwidth and work offline.

With two or more sources enabled, the window shows a per-source visibility row and a small source badge on each track.

## API

`game.modules.get("tabletop-rpg-music-filter").api` exposes `sources`, `tracks` (the merged database), and `open()`.

## Publishing checklist for a new pack

1. `module.json` with the flag above (`audio.type: "local"`, `layout: "explicit"`), plus `relationships.requires` on `tabletop-rpg-music-filter`.
2. `data/tracks.json` with `file` and `loopFile` per track, exported from the master catalogue.
3. Audio files in the directory named by `audio.base`.
4. No scripts needed.
