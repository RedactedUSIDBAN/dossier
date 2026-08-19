# Dossier

Public Roblox player lookup. Search a username or user ID and open a dossier.

**Live:** [https://redactedusidban.github.io/dossier/](https://redactedusidban.github.io/dossier/)

Static site on GitHub Pages. The browser calls Roblox APIs through roproxy (rotunnel + corsproxy fallbacks). No Render host.

## Use

- Search users, including terminated accounts by exact name or ID
- Profile, presence, friends, groups, outfits, RAP, compare, export JSON
- Bookmarkable `?u=shedletsky` links

## Local

Serve the repo root (any static server). Example:

```bash
python3 -m http.server 4173
```

Then open the local URL and search `shedletsky`.

## Limits

- Roblox does not publish first-game-ever-played. The timeline uses the oldest published experience.
- Terminated accounts often have avatar, outfits, and history wiped.
- Follower / following **lists** are hidden; counts still show.
