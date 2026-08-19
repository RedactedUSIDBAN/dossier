const HOST = {
  users: "https://users.roproxy.com",
  thumbnails: "https://thumbnails.roproxy.com",
  friends: "https://friends.roproxy.com",
  presence: "https://presence.roproxy.com",
  games: "https://games.roproxy.com",
  groups: "https://groups.roproxy.com",
  inventory: "https://inventory.roproxy.com",
  accountinformation: "https://accountinformation.roproxy.com",
  avatar: "https://avatar.roproxy.com",
};

const cache = new Map();
const CACHE_MS = 50_000;

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 280) cache.delete(cache.keys().next().value);
}

async function rbx(url, options = {}, tries = 2) {
  const timeout = options.timeout ?? 14000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: options.method || "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok && tries > 1 && (res.status === 429 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, 400));
      return rbx(url, options, tries - 1);
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    if (tries > 1) {
      await new Promise((r) => setTimeout(r, 400));
      return rbx(url, options, tries - 1);
    }
    return { ok: false, status: 0, data: null, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

function settled(value, fallback = null) {
  return value && value.ok ? value.data : fallback;
}

function accountAge(createdIso) {
  if (!createdIso) return { days: null, label: "Unknown" };
  const start = new Date(createdIso);
  if (Number.isNaN(start.getTime())) return { days: null, label: "Unknown" };
  const now = new Date();
  let years = now.getFullYear() - start.getFullYear();
  let months = now.getMonth() - start.getMonth();
  let days = now.getDate() - start.getDate();
  if (days < 0) {
    months -= 1;
    days += new Date(now.getFullYear(), now.getMonth(), 0).getDate();
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  const totalDays = Math.floor((now - start) / 86400000);
  const parts = [];
  if (years) parts.push(`${years} year${years === 1 ? "" : "s"}`);
  if (months) parts.push(`${months} month${months === 1 ? "" : "s"}`);
  if (!years && !months) parts.push(`${Math.max(days, 0)} day${days === 1 ? "" : "s"}`);
  return { days: totalDays, label: parts.join(", ") };
}

function presenceLabel(type) {
  if (type === 1) return "Website";
  if (type === 2) return "In-game";
  if (type === 3) return "Studio";
  return "Offline";
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function thumbnailMap(kind, ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  const map = {};
  if (!unique.length) return map;
  await Promise.all(
    chunk(unique, 100).map(async (batch) => {
      const joined = batch.join(",");
      const urls = {
        headshot: `${HOST.thumbnails}/v1/users/avatar-headshot?userIds=${joined}&size=150x150&format=Png&isCircular=false`,
        avatar: `${HOST.thumbnails}/v1/users/avatar?userIds=${joined}&size=720x720&format=Png`,
        bust: `${HOST.thumbnails}/v1/users/avatar-bust?userIds=${joined}&size=420x420&format=Png`,
        game: `${HOST.thumbnails}/v1/games/icons?universeIds=${joined}&size=512x512&format=Png`,
        group: `${HOST.thumbnails}/v1/groups/icons?groupIds=${joined}&size=150x150&format=Png`,
        asset: `${HOST.thumbnails}/v1/assets?assetIds=${joined}&size=150x150&format=Png`,
        badge: `${HOST.thumbnails}/v1/badges/icons?badgeIds=${joined}&size=150x150&format=Png`,
        outfit: `${HOST.thumbnails}/v1/users/outfits?userOutfitIds=${joined}&size=420x420&format=Png`,
      };
      const res = await rbx(urls[kind]);
      for (const item of (settled(res, { data: [] }).data || [])) {
        if (item.imageUrl) map[String(item.targetId)] = item.imageUrl;
      }
    })
  );
  return map;
}

async function presenceMap(userIds) {
  const map = {};
  const unique = [...new Set(userIds.filter(Boolean))];
  await Promise.all(
    chunk(unique, 50).map(async (batch) => {
      const res = await rbx(`${HOST.presence}/v1/presence/users`, {
        method: "POST",
        body: { userIds: batch },
      });
      for (const p of (settled(res, { userPresences: [] }).userPresences || [])) {
        map[String(p.userId)] = {
          type: p.userPresenceType || 0,
          label: presenceLabel(p.userPresenceType || 0),
          lastLocation: p.lastLocation || null,
          placeId: p.placeId || p.rootPlaceId || null,
          universeId: p.universeId || null,
        };
      }
    })
  );
  return map;
}

async function fetchOutfits(userId) {
  const outfits = [];
  for (let page = 1; page <= 4; page++) {
    const res = await rbx(
      `${HOST.avatar}/v1/users/${userId}/outfits?page=${page}&itemsPerPage=50&isEditable=true`
    );
    const data = settled(res, null);
    if (!data) break;
    const batch = data.data || [];
    outfits.push(...batch);
    if (!batch.length) break;
  }
  return { outfits, total: outfits.length };
}

async function resolveUser(query) {
  const trimmed = String(query || "").trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    const res = await rbx(`${HOST.users}/v1/users/${trimmed}`);
    if (res.ok && res.data && res.data.id) return res.data;
  }

  const exact = await rbx(`${HOST.users}/v1/usernames/users`, {
    method: "POST",
    body: { usernames: [trimmed], excludeBannedUsers: false },
  });
  const match = exact.data && Array.isArray(exact.data.data) ? exact.data.data[0] : null;
  if (match && match.id) {
    const full = await rbx(`${HOST.users}/v1/users/${match.id}`);
    if (full.ok && full.data) return full.data;
    return {
      id: match.id,
      name: match.name,
      displayName: match.displayName,
      hasVerifiedBadge: match.hasVerifiedBadge,
      description: "",
      created: null,
      isBanned: Boolean(match.isBanned),
    };
  }

  const search = await rbx(
    `${HOST.users}/v1/users/search?keyword=${encodeURIComponent(trimmed)}&limit=10`
  );
  const hit = ((search.data && search.data.data) || []).find(
    (u) => u.name && u.name.toLowerCase() === trimmed.toLowerCase()
  );
  if (hit) {
    const full = await rbx(`${HOST.users}/v1/users/${hit.id}`);
    if (full.ok && full.data) return full.data;
  }
  return null;
}

function mapGame(g, icons) {
  return {
    universeId: g.id,
    name: g.name,
    description: g.description || "",
    rootPlaceId: g.rootPlace && g.rootPlace.id,
    created: g.created,
    updated: g.updated,
    visits: g.placeVisits || 0,
    creator: g.creator || null,
    icon: icons[String(g.id)] || null,
    url: g.rootPlace && g.rootPlace.id ? `https://www.roblox.com/games/${g.rootPlace.id}` : null,
  };
}

function mapPerson(user, thumbs, presence) {
  const pres = presence[String(user.id)] || { type: 0, label: "Offline" };
  return {
    id: user.id,
    name: user.name,
    displayName: user.displayName || user.name,
    hasVerifiedBadge: Boolean(user.hasVerifiedBadge),
    headshot: thumbs[String(user.id)] || null,
    profileUrl: `https://www.roblox.com/users/${user.id}/profile`,
    presence: pres,
  };
}

async function hydrateUsers(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const map = {};
  await Promise.all(
    chunk(unique, 100).map(async (batch) => {
      const res = await rbx(`${HOST.users}/v1/users`, {
        method: "POST",
        body: { userIds: batch, excludeBannedUsers: false },
      });
      for (const u of (settled(res, { data: [] }).data || [])) {
        map[String(u.id)] = u;
      }
    })
  );
  return map;
}

async function buildCore(user) {
  const id = user.id;
  const [
    presenceRes,
    friendsCountRes,
    followersCountRes,
    followingsCountRes,
    inventoryRes,
    historyRes,
    badgesOfficialRes,
    avatarRes,
  ] = await Promise.all([
    rbx(`${HOST.presence}/v1/presence/users`, { method: "POST", body: { userIds: [id] } }),
    rbx(`${HOST.friends}/v1/users/${id}/friends/count`),
    rbx(`${HOST.friends}/v1/users/${id}/followers/count`),
    rbx(`${HOST.friends}/v1/users/${id}/followings/count`),
    rbx(`${HOST.inventory}/v1/users/${id}/can-view-inventory`),
    rbx(`${HOST.users}/v1/users/${id}/username-history?limit=50&sortOrder=Asc`),
    rbx(`${HOST.accountinformation}/v1/users/${id}/roblox-badges`),
    rbx(`${HOST.avatar}/v1/users/${id}/avatar`),
  ]);

  const presence = (settled(presenceRes, { userPresences: [] }).userPresences || [])[0] || {};
  const avatarRaw = settled(avatarRes, null);
  const wearIds = ((avatarRaw && avatarRaw.assets) || []).map((a) => a.id);
  const [headshots, avatars, busts, assetIcons] = await Promise.all([
    thumbnailMap("headshot", [id]),
    thumbnailMap("avatar", [id]),
    thumbnailMap("bust", [id]),
    thumbnailMap("asset", wearIds),
  ]);

  let currentGame = null;
  if (presence.userPresenceType === 2 && (presence.universeId || presence.lastLocation)) {
    if (presence.universeId) {
      const gameInfo = await rbx(`${HOST.games}/v1/games?universeIds=${presence.universeId}`);
      const g = (settled(gameInfo, { data: [] }).data || [])[0];
      if (g) {
        currentGame = {
          name: g.name,
          placeId: g.rootPlaceId || presence.rootPlaceId || presence.placeId,
          url: `https://www.roblox.com/games/${g.rootPlaceId || presence.rootPlaceId || presence.placeId}`,
        };
      }
    }
    if (!currentGame && presence.lastLocation) {
      currentGame = {
        name: presence.lastLocation,
        placeId: presence.rootPlaceId || presence.placeId,
        url:
          presence.rootPlaceId || presence.placeId
            ? `https://www.roblox.com/games/${presence.rootPlaceId || presence.placeId}`
            : null,
      };
    }
  }

  const age = accountAge(user.created);
  const officialBadges = Array.isArray(settled(badgesOfficialRes, []))
    ? settled(badgesOfficialRes, [])
    : [];

  return {
    user: {
      id: user.id,
      name: user.name,
      displayName: user.displayName,
      description: user.description || "",
      created: user.created,
      isBanned: Boolean(user.isBanned),
      hasVerifiedBadge: Boolean(user.hasVerifiedBadge),
      accountAgeDays: age.days,
      accountAgeLabel: age.label,
      profileUrl: `https://www.roblox.com/users/${user.id}/profile`,
    },
    presence: {
      type: user.isBanned ? -1 : presence.userPresenceType || 0,
      label: user.isBanned ? "Terminated" : presenceLabel(presence.userPresenceType || 0),
      lastLocation: presence.lastLocation || null,
      placeId: presence.placeId || presence.rootPlaceId || null,
      universeId: presence.universeId || null,
      game: currentGame,
    },
    counts: {
      friends: (settled(friendsCountRes, { count: 0 }) || {}).count || 0,
      followers: (settled(followersCountRes, { count: 0 }) || {}).count || 0,
      followings: (settled(followingsCountRes, { count: 0 }) || {}).count || 0,
      experiences: null,
      favorites: null,
      groups: null,
      badges: null,
      collectibles: null,
    },
    privacy: {
      canViewInventory: Boolean(settled(inventoryRes, { canView: false }).canView),
    },
    usernameHistory: ((settled(historyRes, { data: [] }) || {}).data || []).map((h) => h.name),
    officialBadges: officialBadges.map((b) => ({
      id: b.id,
      name: b.name,
      description: b.description || "",
      imageUrl: b.imageUrl || null,
    })),
    avatar: {
      headshot: headshots[String(id)] || null,
      fullBody: avatars[String(id)] || null,
      bust: busts[String(id)] || null,
      type: avatarRaw ? avatarRaw.playerAvatarType : null,
      scales: avatarRaw ? avatarRaw.scales : null,
      bodyColors: avatarRaw ? avatarRaw.bodyColor3s || avatarRaw.bodyColors : null,
      emotes: avatarRaw ? avatarRaw.emotes || [] : [],
      wearing: ((avatarRaw && avatarRaw.assets) || []).map((a) => ({
        id: a.id,
        name: a.name,
        type: (a.assetType && a.assetType.name) || "Asset",
        typeId: a.assetType && a.assetType.id,
        icon: assetIcons[String(a.id)] || null,
        url: `https://www.roblox.com/catalog/${a.id}`,
      })),
    },
    links: {
      roblox: `https://www.roblox.com/users/${id}/profile`,
      inventory: `https://www.roblox.com/users/${id}/inventory`,
      rolimons: `https://www.rolimons.com/player/${id}`,
      roliverse: `https://www.roliverse.com/players/${id}`,
    },
    ready: "core",
    fetchedAt: new Date().toISOString(),
  };
}

async function buildDetails(user, core) {
  const id = user.id;
  const canView = core.privacy.canViewInventory;

  const [
    friendsRes,
    followersRes,
    followingsRes,
    gamesRes,
    favoritesRes,
    groupsRes,
    collectiblesRes,
    hatsRes,
    gearRes,
    facesRes,
    outfitsPack,
  ] = await Promise.all([
    rbx(`${HOST.friends}/v1/users/${id}/friends`),
    rbx(`${HOST.friends}/v1/users/${id}/followers?limit=50&sortOrder=Desc`),
    rbx(`${HOST.friends}/v1/users/${id}/followings?limit=50&sortOrder=Desc`),
    rbx(`${HOST.games}/v2/users/${id}/games?accessFilter=2&limit=50&sortOrder=Asc`),
    rbx(`${HOST.games}/v2/users/${id}/favorite/games?limit=50&sortOrder=Desc`),
    rbx(`${HOST.groups}/v2/users/${id}/groups/roles`),
    canView
      ? rbx(`${HOST.inventory}/v1/users/${id}/assets/collectibles?limit=100&sortOrder=Desc`)
      : Promise.resolve({ ok: false, data: null }),
    canView
      ? rbx(`${HOST.inventory}/v2/users/${id}/inventory/8?limit=10&sortOrder=Asc`)
      : Promise.resolve({ ok: false, data: null }),
    canView
      ? rbx(`${HOST.inventory}/v2/users/${id}/inventory/19?limit=10&sortOrder=Asc`)
      : Promise.resolve({ ok: false, data: null }),
    canView
      ? rbx(`${HOST.inventory}/v2/users/${id}/inventory/18?limit=10&sortOrder=Asc`)
      : Promise.resolve({ ok: false, data: null }),
    user.isBanned ? Promise.resolve({ outfits: [], total: 0 }) : fetchOutfits(id),
  ]);

  const friendsAll = (settled(friendsRes, { data: [] }).data || []).slice(0, 120);
  const followers = (settled(followersRes, { data: [] }).data || []).slice(0, 36);
  const followings = (settled(followingsRes, { data: [] }).data || []).slice(0, 36);
  const gamesRaw = settled(gamesRes, { data: [] });
  const favoritesRaw = settled(favoritesRes, { data: [] });
  const groupsRaw = settled(groupsRes, { data: [] });
  const collectibles = canView ? (settled(collectiblesRes, { data: [] }).data || []) : null;

  const peopleIds = [
    ...friendsAll.map((f) => f.id),
    ...followers.map((f) => f.id),
    ...followings.map((f) => f.id),
  ];
  const universeIds = [
    ...((gamesRaw.data || []).map((g) => g.id)),
    ...((favoritesRaw.data || []).map((g) => g.id)),
  ];
  const groupIds = (groupsRaw.data || []).map((g) => g.group && g.group.id).filter(Boolean);
  const collectibleIds = (collectibles || []).map((c) => c.assetId);

  const inventoryBits = [];
  if (canView) {
    for (const [res, type] of [
      [hatsRes, "Hat"],
      [gearRes, "Gear"],
      [facesRes, "Face"],
    ]) {
      for (const item of (settled(res, { data: [] }).data || [])) {
        inventoryBits.push({
          assetId: item.assetId,
          name: item.assetName || item.name,
          type,
          created: item.created,
          url: `https://www.roblox.com/catalog/${item.assetId}`,
        });
      }
    }
  }
  inventoryBits.sort((a, b) => new Date(a.created || 0) - new Date(b.created || 0));
  const earliestItems = inventoryBits.slice(0, 10);
  const rawOutfits = (outfitsPack && outfitsPack.outfits) || [];

  const [headshots, presences, gameIcons, groupIcons, itemIcons, userInfo, outfitIcons] =
    await Promise.all([
      thumbnailMap("headshot", peopleIds),
      presenceMap(friendsAll.map((f) => f.id)),
      thumbnailMap("game", universeIds),
      thumbnailMap("group", groupIds),
      thumbnailMap("asset", [...collectibleIds, ...earliestItems.map((i) => i.assetId)]),
      hydrateUsers(peopleIds),
      thumbnailMap(
        "outfit",
        rawOutfits.map((o) => o.id)
      ),
    ]);

  const outfits = rawOutfits.map((o) => ({
    id: o.id,
    name: o.name || "Untitled outfit",
    isEditable: Boolean(o.isEditable),
    outfitType: o.outfitType || "Avatar",
    icon: outfitIcons[String(o.id)] || null,
  }));

  const named = (list) =>
    list.map((f) => {
      const info = userInfo[String(f.id)] || f;
      return {
        ...f,
        name: info.name || f.name,
        displayName: info.displayName || info.name || f.displayName,
        hasVerifiedBadge: Boolean(info.hasVerifiedBadge),
      };
    });
  const friendsNamed = named(friendsAll);
  const followersNamed = named(followers);
  const followingsNamed = named(followings);

  const experiences = (gamesRaw.data || [])
    .map((g) => mapGame(g, gameIcons))
    .sort((a, b) => new Date(a.created || 0) - new Date(b.created || 0));
  const favorites = (favoritesRaw.data || []).map((g) => mapGame(g, gameIcons));
  const groups = (groupsRaw.data || []).map((entry) => {
    const group = entry.group || {};
    const role = entry.role || {};
    return {
      id: group.id,
      name: group.name,
      description: group.description || "",
      memberCount: group.memberCount || 0,
      owner: group.owner || null,
      hasVerifiedBadge: group.hasVerifiedBadge || false,
      role: role.name || "Member",
      rank: role.rank || 0,
      icon: groupIcons[String(group.id)] || null,
      url: group.id ? `https://www.roblox.com/groups/${group.id}` : null,
    };
  });

  const friends = friendsNamed
    .map((f) => mapPerson(f, headshots, presences))
    .sort((a, b) => (b.presence.type || 0) - (a.presence.type || 0));

  const mappedCollectibles = collectibles
    ? collectibles.map((c) => ({
        assetId: c.assetId,
        name: c.name,
        serialNumber: c.serialNumber,
        recentAveragePrice: c.recentAveragePrice,
        originalPrice: c.originalPrice,
        icon: itemIcons[String(c.assetId)] || null,
        url: `https://www.roblox.com/catalog/${c.assetId}`,
      }))
    : null;

  const totalRap = mappedCollectibles
    ? mappedCollectibles.reduce((s, c) => s + (Number(c.recentAveragePrice) || 0), 0)
    : null;

  const earliestWithIcons = earliestItems.map((item) => ({
    ...item,
    icon: itemIcons[String(item.assetId)] || null,
  }));

  const oldestExperience = experiences[0] || null;
  const firstGameEstimate = oldestExperience
    ? {
        kind: "created",
        badgeName: oldestExperience.name,
        awardedDate: oldestExperience.created,
        universe: {
          id: oldestExperience.universeId,
          name: oldestExperience.name,
          rootPlaceId: oldestExperience.rootPlaceId,
        },
        icon: oldestExperience.icon,
        note: "Roblox hides play history and game badges. This is the oldest experience they published — not necessarily the first they played.",
      }
    : null;

  const timeline = [];
  if (user.created) {
    timeline.push({
      at: user.created,
      title: "Account created",
      detail: `@${user.name} joined Roblox`,
    });
  }
  if (earliestWithIcons[0]) {
    timeline.push({
      at: earliestWithIcons[0].created,
      title: `First public ${earliestWithIcons[0].type.toLowerCase()}`,
      detail: earliestWithIcons[0].name,
    });
  }
  if (oldestExperience) {
    timeline.push({
      at: oldestExperience.created,
      title: "Oldest published experience",
      detail: oldestExperience.name,
    });
  }
  if (core.officialBadges.some((b) => b.name === "Veteran")) {
    timeline.push({
      at: user.created
        ? new Date(new Date(user.created).getTime() + 365 * 86400000).toISOString()
        : null,
      title: "Veteran badge",
      detail: "Account reached one year on the platform",
    });
  }
  timeline.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));

  return {
    counts: {
      ...core.counts,
      experiences: experiences.length,
      favorites: favorites.length,
      groups: groups.length,
      badges: 0,
      collectibles: mappedCollectibles ? mappedCollectibles.length : null,
      onlineFriends: friends.filter((f) => f.presence.type > 0).length,
      placeVisits: experiences.reduce((s, g) => s + (g.visits || 0), 0),
      totalRap,
      outfits: outfits.length,
    },
    experiences,
    favorites,
    groups,
    friends,
    friendsTotal: friendsAll.length,
    followers: followersNamed.map((f) => mapPerson(f, headshots, {})),
    followings: followingsNamed.map((f) => mapPerson(f, headshots, {})),
    outfits,
    collectibles: mappedCollectibles,
    gameBadges: [],
    firstGameEstimate,
    earliestItems: earliestWithIcons,
    timeline,
    ready: "full",
    fetchedAt: new Date().toISOString(),
  };
}

export async function searchUsers(q) {
  q = String(q || "").trim();
  if (q.length < 2) return { results: [] };
  const key = `search:${q.toLowerCase()}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const [searchRes, exactRes] = await Promise.all([
    rbx(`${HOST.users}/v1/users/search?keyword=${encodeURIComponent(q)}&limit=10`),
    /^\d+$/.test(q)
      ? rbx(`${HOST.users}/v1/users/${q}`)
      : rbx(`${HOST.users}/v1/usernames/users`, {
          method: "POST",
          body: { usernames: [q], excludeBannedUsers: false },
        }),
  ]);

  const results = [];
  const seen = new Set();

  if (/^\d+$/.test(q) && exactRes.ok && exactRes.data && exactRes.data.id) {
    results.push({
      id: exactRes.data.id,
      name: exactRes.data.name,
      displayName: exactRes.data.displayName,
      hasVerifiedBadge: exactRes.data.hasVerifiedBadge,
      isBanned: Boolean(exactRes.data.isBanned),
      previousUsernames: [],
    });
    seen.add(exactRes.data.id);
  } else if (exactRes.data && Array.isArray(exactRes.data.data)) {
    const extras = await Promise.all(
      exactRes.data.data.map((u) => rbx(`${HOST.users}/v1/users/${u.id}`))
    );
    extras.forEach((full, i) => {
      const u = exactRes.data.data[i];
      if (!u || seen.has(u.id)) return;
      const info = settled(full, u) || u;
      results.push({
        id: u.id,
        name: info.name || u.name,
        displayName: info.displayName || u.displayName,
        hasVerifiedBadge: Boolean(info.hasVerifiedBadge || u.hasVerifiedBadge),
        isBanned: Boolean(info.isBanned),
        previousUsernames: [],
      });
      seen.add(u.id);
    });
  }

  for (const u of (searchRes.data && searchRes.data.data) || []) {
    if (!u || seen.has(u.id)) continue;
    results.push({
      id: u.id,
      name: u.name,
      displayName: u.displayName,
      hasVerifiedBadge: u.hasVerifiedBadge,
      isBanned: false,
      previousUsernames: u.previousUsernames || [],
    });
    seen.add(u.id);
  }

  const thumbs = await thumbnailMap(
    "headshot",
    results.map((r) => r.id)
  );
  const payload = {
    results: results.map((r) => ({ ...r, headshot: thumbs[String(r.id)] || null })),
  };
  cacheSet(key, payload);
  return payload;
}

export async function loadCore(query) {
  query = String(query || "").trim();
  if (!query) throw Object.assign(new Error("User not found"), { status: 400 });
  const cached = cacheGet(`coreq:${query.toLowerCase()}`);
  if (cached) return cached;
  const user = await resolveUser(query);
  if (!user) {
    const err = new Error("User not found");
    err.status = 404;
    throw err;
  }
  const byId = cacheGet(`core:${user.id}`);
  const core = byId || (await buildCore(user));
  cacheSet(`core:${user.id}`, core);
  cacheSet(`coreq:${query.toLowerCase()}`, core);
  if (user.name) cacheSet(`coreq:${user.name.toLowerCase()}`, core);
  return core;
}

export async function loadDetails(query) {
  query = String(query || "").trim();
  const user = await resolveUser(query);
  if (!user) {
    const err = new Error("User not found");
    err.status = 404;
    throw err;
  }
  const cached = cacheGet(`details:${user.id}`);
  if (cached) return cached;
  const core = cacheGet(`core:${user.id}`) || (await buildCore(user));
  cacheSet(`core:${user.id}`, core);
  const details = await buildDetails(user, core);
  cacheSet(`details:${user.id}`, details);
  return details;
}

export async function loadOutfit(id) {
  id = String(id || "").trim();
  if (!/^\d+$/.test(id)) {
    const err = new Error("Invalid outfit id");
    err.status = 400;
    throw err;
  }
  const cached = cacheGet(`outfit:${id}`);
  if (cached) return cached;
  const detailRes = await rbx(`${HOST.avatar}/v1/outfits/${id}/details`);
  const detail = settled(detailRes, null);
  if (!detail || !detail.id) {
    const err = new Error("Outfit not found");
    err.status = 404;
    throw err;
  }
  const assets = detail.assets || [];
  const [icons, outfitIconMap] = await Promise.all([
    thumbnailMap(
      "asset",
      assets.map((a) => a.id)
    ),
    thumbnailMap("outfit", [detail.id]),
  ]);
  const payload = {
    id: detail.id,
    name: detail.name || "Untitled outfit",
    isEditable: Boolean(detail.isEditable),
    outfitType: detail.outfitType || "Avatar",
    playerAvatarType: detail.playerAvatarType || null,
    scale: detail.scale || null,
    bodyColors: detail.bodyColors || null,
    icon: outfitIconMap[String(detail.id)] || null,
    assets: assets.map((a) => ({
      id: a.id,
      name: a.name,
      type: (a.assetType && a.assetType.name) || "Asset",
      icon: icons[String(a.id)] || null,
      url: `https://www.roblox.com/catalog/${a.id}`,
    })),
  };
  cacheSet(`outfit:${id}`, payload);
  return payload;
}
