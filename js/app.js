import { searchUsers, loadCore, loadDetails, loadOutfit } from "./api.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const searchForm = $("#searchForm");
const searchInput = $("#searchInput");
const suggestEl = $("#suggest");
const landing = $("#landing");
const workspace = $("#workspace");
const dossierEl = $("#dossier");
const statusLine = $("#statusLine");
const toastEl = $("#toast");
const recentsWrap = $("#recents");
const recentRow = $("#recentRow");
const compareDock = $("#compareDock");
const outfitModal = $("#outfitModal");
const outfitBody = $("#outfitBody");

let suggestItems = [];
let suggestIndex = -1;
let suggestTimer = 0;
let currentProfile = null;
let compareProfile = null;
let activeTab = "overview";
let gameSort = "oldest";
let requestToken = 0;

const RECENT_KEY = "dossier.recents.v1";

function formatNumber(n) {
  if (n == null) return "—";
  return Number(n).toLocaleString("en-US");
}

function formatDate(iso) {
  if (!iso) return "Unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function toast(message) {
  toastEl.hidden = false;
  toastEl.textContent = message;
  clearTimeout(toast.tid);
  toast.tid = setTimeout(() => {
    toastEl.hidden = true;
  }, 1800);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
  } catch {
    toast("Could not copy");
  }
}

function loadRecents() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveRecent(profile) {
  const recents = loadRecents().filter((r) => r.id !== profile.user.id);
  recents.unshift({
    id: profile.user.id,
    name: profile.user.name,
    displayName: profile.user.displayName,
    headshot: profile.avatar.headshot,
  });
  localStorage.setItem(RECENT_KEY, JSON.stringify(recents.slice(0, 8)));
  renderRecents();
}

function renderRecents() {
  const recents = loadRecents();
  if (!recents.length) {
    recentsWrap.hidden = true;
    return;
  }
  recentsWrap.hidden = false;
  recentRow.innerHTML = recents
    .map(
      (r) => `
      <button class="recent-card" data-lookup="${escapeHtml(r.name)}">
        ${r.headshot ? `<img src="${r.headshot}" alt="">` : `<div class="ph"></div>`}
        <span>
          <strong>${escapeHtml(r.displayName)}</strong><br>
          <span class="muted">@${escapeHtml(r.name)}</span>
        </span>
      </button>`
    )
    .join("");
}

function imgTag(src, alt = "", cls = "") {
  if (!src) return `<div class="ph ${cls}"></div>`;
  return `<img class="${cls}" src="${src}" alt="${escapeHtml(alt)}" loading="lazy">`;
}

function currentUrl(u, vs, tab) {
  const params = new URLSearchParams();
  if (u) params.set("u", u);
  if (vs) params.set("vs", vs);
  if (tab && tab !== "overview") params.set("tab", tab);
  const q = params.toString();
  return q ? `/?${q}` : "/";
}

function pushUrl() {
  const u = currentProfile && currentProfile.user.name;
  const vs = compareProfile && compareProfile.user.name;
  history.pushState({ u, vs, tab: activeTab }, "", currentUrl(u, vs, activeTab));
}

function renderSuggest(results) {
  suggestItems = results;
  suggestIndex = -1;
  if (!results.length) {
    suggestEl.hidden = true;
    suggestEl.innerHTML = "";
    return;
  }
  suggestEl.hidden = false;
  suggestEl.innerHTML = results
    .map(
      (r, i) => `
      <button type="button" data-i="${i}" data-name="${escapeHtml(r.name)}">
        ${imgTag(r.headshot, r.displayName)}
        <span class="who">
          <strong>${escapeHtml(r.displayName)} ${r.isBanned ? `<em class="ban-pill">Banned</em>` : ""}</strong>
          <span>@${escapeHtml(r.name)}</span>
        </span>
        <span class="sid">#${r.id}</span>
      </button>`
    )
    .join("");
}

async function runSearch(q) {
  if (q.trim().length < 2) {
    renderSuggest([]);
    return;
  }
  try {
    const data = await searchUsers(q.trim());
    if (searchInput.value.trim() !== q.trim()) return;
    renderSuggest(data.results || []);
  } catch {
    renderSuggest([]);
  }
}

function highlightSuggest() {
  $$(".suggest button").forEach((btn, i) => btn.classList.toggle("active", i === suggestIndex));
}

function setLoading(query) {
  landing.hidden = true;
  workspace.hidden = false;
  statusLine.textContent = `Opening @${query}…`;
  dossierEl.innerHTML = `
    <div class="hero">
      <div class="skel" style="height:168px"></div>
      <div>
        <div class="skel" style="height:42px;width:50%;margin-bottom:12px"></div>
        <div class="skel" style="height:18px;width:30%;margin-bottom:18px"></div>
        <div class="skel" style="height:72px;width:80%"></div>
      </div>
    </div>
    <div class="stat-grid">
      ${Array.from({ length: 6 }, () => `<div class="stat skel" style="height:84px"></div>`).join("")}
    </div>`;
}

function presenceDot(type) {
  if (type === 2) return "play";
  if (type === 1) return "on";
  if (type === 3) return "studio";
  if (type === -1) return "ban";
  return "";
}

function emptyState(text) {
  return `<div class="empty">${text}</div>`;
}

function scaleValue(scale, key) {
  if (!scale) return null;
  const raw = scale[key] ?? scale[key.charAt(0).toUpperCase() + key.slice(1)];
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function scalePct(n) {
  return Math.max(0, Math.min(100, Math.round(n * 100)));
}

function scaleBlock(scale, avatarType) {
  const keys = [
    ["height", "Height"],
    ["width", "Width"],
    ["head", "Head"],
    ["proportion", "Proportion"],
    ["bodyType", "Body type"],
  ];
  const rows = keys
    .map(([key, label]) => {
      const n = scaleValue(scale, key);
      if (n == null) return "";
      return `<div class="scale-row">
        <span>${label}</span>
        <div class="scale-track"><i style="width:${scalePct(n)}%"></i></div>
        <b>${n.toFixed(2)}</b>
      </div>`;
    })
    .join("");
  if (!rows) return "";
  return `<div class="scale-card">
    <h3 class="section-title">${avatarType ? `${escapeHtml(avatarType)} scale` : "Avatar scale"}</h3>
    ${rows}
  </div>`;
}

function sortGames(list) {
  const copy = list.slice();
  if (gameSort === "visits") copy.sort((a, b) => (b.visits || 0) - (a.visits || 0));
  else if (gameSort === "newest") copy.sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0));
  else if (gameSort === "name") copy.sort((a, b) => a.name.localeCompare(b.name));
  else copy.sort((a, b) => new Date(a.created || 0) - new Date(b.created || 0));
  return copy;
}

function gameCard(g) {
  return `
    <a class="card" href="${g.url || "#"}" target="_blank" rel="noopener">
      ${g.icon ? `<img src="${g.icon}" alt="">` : `<div class="ph-wide"></div>`}
      <div class="body">
        <h4>${escapeHtml(g.name)}</h4>
        <p>${formatNumber(g.visits)} visits · ${formatDate(g.created)}</p>
      </div>
    </a>`;
}

function personCard(f, lookup = true) {
  const tag = lookup ? "button" : "a";
  const extra = lookup
    ? `data-lookup="${escapeHtml(f.name)}"`
    : `href="${f.profileUrl}" target="_blank" rel="noopener"`;
  const pres = f.presence || { type: 0, label: "" };
  return `
    <${tag} class="friend" ${extra}>
      ${imgTag(f.headshot, f.displayName)}
      <span>
        <strong>${escapeHtml(f.displayName)}</strong><br>
        <span class="muted">@${escapeHtml(f.name)}</span>
        ${
          pres.type
            ? `<br><span class="live"><i class="dot ${presenceDot(pres.type)}"></i>${escapeHtml(
                pres.type === 2 && pres.lastLocation ? pres.lastLocation : pres.label
              )}</span>`
            : ""
        }
      </span>
    </${tag}>`;
}

function mergeProfile(core, details) {
  if (!details) return { ...core, experiences: [], favorites: [], groups: [], friends: [], followers: [], followings: [], collectibles: null, gameBadges: [], earliestItems: [], timeline: [], outfits: [] };
  return {
    ...core,
    ...details,
    counts: { ...core.counts, ...details.counts },
    avatar: { ...core.avatar, ...(details.avatar || {}) },
  };
}

function compareRows(a, b) {
  const rows = [
    ["Account age", a.user.accountAgeLabel, b.user.accountAgeLabel],
    ["Joined", formatDate(a.user.created), formatDate(b.user.created)],
    ["Friends", formatNumber(a.counts.friends), formatNumber(b.counts.friends)],
    ["Followers", formatNumber(a.counts.followers), formatNumber(b.counts.followers)],
    ["Following", formatNumber(a.counts.followings), formatNumber(b.counts.followings)],
    ["Groups", formatNumber(a.counts.groups), formatNumber(b.counts.groups)],
    ["Experiences", formatNumber(a.counts.experiences), formatNumber(b.counts.experiences)],
    ["Place visits", formatNumber(a.counts.placeVisits), formatNumber(b.counts.placeVisits)],
    ["Online friends", formatNumber(a.counts.onlineFriends), formatNumber(b.counts.onlineFriends)],
    ["Inventory", a.privacy.canViewInventory ? "Public" : "Private", b.privacy.canViewInventory ? "Public" : "Private"],
    ["Collectible RAP", a.counts.totalRap != null ? formatNumber(a.counts.totalRap) : "Hidden", b.counts.totalRap != null ? formatNumber(b.counts.totalRap) : "Hidden"],
    ["Status", a.presence.label, b.presence.label],
  ];
  return rows
    .map(([label, left, right]) => {
      const lNum = Number(String(left).replace(/,/g, ""));
      const rNum = Number(String(right).replace(/,/g, ""));
      const numeric = !Number.isNaN(lNum) && !Number.isNaN(rNum) && String(left) !== "—" && String(right) !== "—";
      return `
        <div class="cmp-row">
          <span class="${numeric && lNum > rNum ? "win" : ""}">${escapeHtml(String(left))}</span>
          <span class="cmp-label">${escapeHtml(label)}</span>
          <span class="${numeric && rNum > lNum ? "win" : ""}">${escapeHtml(String(right))}</span>
        </div>`;
    })
    .join("");
}

function renderCompare() {
  if (!compareProfile || !currentProfile) {
    compareDock.hidden = true;
    compareDock.innerHTML = "";
    return;
  }
  compareDock.hidden = false;
  const a = currentProfile;
  const b = compareProfile;
  compareDock.innerHTML = `
    <div class="compare-head">
      <div class="mini">
        ${imgTag(a.avatar.headshot, a.user.displayName)}
        <div>
          <strong>${escapeHtml(a.user.displayName)}</strong>
          <span class="muted">@${escapeHtml(a.user.name)}</span>
        </div>
      </div>
      <div class="versus">VS</div>
      <div class="mini">
        ${imgTag(b.avatar.headshot, b.user.displayName)}
        <div>
          <strong>${escapeHtml(b.user.displayName)}</strong>
          <span class="muted">@${escapeHtml(b.user.name)}</span>
        </div>
      </div>
      <button class="icon-btn" id="clearCompare">Clear compare</button>
    </div>
    <div class="cmp-table">${compareRows(a, b)}</div>`;
}

function renderProfile(p) {
  currentProfile = p;
  const u = p.user;
  const loadingMore = p.ready !== "full";
  const presenceText =
    p.presence.type === 2 && p.presence.game
      ? `In ${p.presence.game.name}`
      : p.presence.label;

  const tabs = [
    ["overview", "Overview"],
    ["outfits", `Outfits${p.counts.outfits != null ? ` (${p.counts.outfits})` : ""}`],
    ["avatar", `Avatar (${p.avatar.wearing.length})`],
    ["experiences", `Experiences${p.counts.experiences != null ? ` (${p.counts.experiences})` : ""}`],
    ["favorites", `Favorites${p.counts.favorites != null ? ` (${p.counts.favorites})` : ""}`],
    ["groups", `Groups${p.counts.groups != null ? ` (${p.counts.groups})` : ""}`],
    ["friends", `Friends (${formatNumber(p.counts.friends)})`],
    ["network", "Network"],
    ["limiteds", "Limiteds"],
  ];

  const share = `${location.origin}${currentUrl(u.name, compareProfile && compareProfile.user.name, activeTab)}`;

  dossierEl.innerHTML = `
    ${
      u.isBanned
        ? `<div class="ban-banner">This account is terminated on Roblox. Public leftovers are still shown — avatar, outfits, and some history may be wiped.</div>`
        : ""
    }
    <section class="hero ${u.isBanned ? "banned" : ""}">
      <div class="avatar-wrap">
        ${imgTag(p.avatar.fullBody || p.avatar.bust || p.avatar.headshot, u.displayName)}
        <span class="presence"><i class="dot ${presenceDot(p.presence.type)}"></i>${escapeHtml(presenceText)}</span>
      </div>
      <div class="identity">
        <h2>${escapeHtml(u.displayName)} ${
          u.hasVerifiedBadge ? `<span class="verified" title="Verified">●</span>` : ""
        }</h2>
        <div class="meta-row">
          <span>@${escapeHtml(u.name)}</span>
          <span>·</span>
          <span>#${u.id}</span>
          <span>·</span>
          <span>Joined ${formatDate(u.created)}</span>
          <span>·</span>
          <span>${escapeHtml(u.accountAgeLabel)} old</span>
          ${u.isBanned ? `<span>·</span><span style="color:var(--rose)">Banned</span>` : ""}
        </div>
        ${u.description ? `<p class="bio">${escapeHtml(u.description)}</p>` : `<p class="bio muted">No bio.</p>`}
        <div class="action-row">
          <a class="chip" href="${u.profileUrl}" target="_blank" rel="noopener">Roblox</a>
          <a class="chip" href="${p.links.rolimons}" target="_blank" rel="noopener">Rolimons</a>
          <button class="icon-btn" data-copy="${u.id}">Copy ID</button>
          <button class="icon-btn" data-copy="${u.name}">Copy username</button>
          <button class="icon-btn" data-copy="${share}">Copy dossier link</button>
          <button class="icon-btn" id="exportJson">Export JSON</button>
          <button class="icon-btn" id="startCompare">Compare</button>
          <button class="chip" data-tab="outfits" type="button">Outfits</button>
          ${
            p.presence.game && p.presence.game.url
              ? `<a class="chip" href="${p.presence.game.url}" target="_blank" rel="noopener">Join current game</a>`
              : ""
          }
        </div>
      </div>
    </section>

    <section class="stat-grid">
      <div class="stat"><b>${formatNumber(p.counts.friends)}</b><span>Friends</span></div>
      <div class="stat"><b>${formatNumber(p.counts.followers)}</b><span>Followers</span></div>
      <div class="stat"><b>${formatNumber(p.counts.followings)}</b><span>Following</span></div>
      <div class="stat"><b>${formatNumber(p.counts.groups)}</b><span>Groups</span></div>
      <div class="stat"><b>${formatNumber(p.counts.placeVisits)}</b><span>Place visits</span></div>
      <div class="stat"><b>${
        p.counts.totalRap != null ? formatNumber(p.counts.totalRap) : p.privacy.canViewInventory ? "0" : "Hidden"
      }</b><span>Collectible RAP</span></div>
    </section>

    <nav class="tabs">
      ${tabs
        .map(
          ([id, label]) =>
            `<button class="tab ${id === activeTab ? "active" : ""}" data-tab="${id}">${label}</button>`
        )
        .join("")}
    </nav>

    <section class="panel ${activeTab === "overview" ? "active" : ""}" data-panel="overview">
      <div class="overview">
        <div class="estimate">
          <h3>First-activity estimate</h3>
          ${
            p.firstGameEstimate
              ? `
                <div class="game-name">${escapeHtml(
                  (p.firstGameEstimate.universe && p.firstGameEstimate.universe.name) ||
                    p.firstGameEstimate.badgeName
                )}</div>
                <p class="muted">Around ${formatDate(p.firstGameEstimate.awardedDate)}</p>
                <p class="note" style="margin-top:.8rem">${escapeHtml(p.firstGameEstimate.note)}</p>
                ${
                  p.firstGameEstimate.universe && p.firstGameEstimate.universe.rootPlaceId
                    ? `<p style="margin-top:.8rem"><a class="chip" href="https://www.roblox.com/games/${p.firstGameEstimate.universe.rootPlaceId}" target="_blank" rel="noopener">Open experience</a></p>`
                    : ""
                }`
              : loadingMore
                ? `<p class="muted">Still gathering public history…</p>`
                : `<p class="muted">Roblox does not publish play history. No published experiences or public inventory items were found to estimate from.</p>`
          }
        </div>
        <div class="panel-card card" style="padding:1.1rem">
          <h3 class="section-title">Account signals</h3>
          <p><span class="muted">Avatar type</span> · ${escapeHtml(p.avatar.type || "Unknown")}</p>
          <p><span class="muted">Official badges</span> · ${
            p.officialBadges.length ? p.officialBadges.map((b) => escapeHtml(b.name)).join(", ") : "None"
          }</p>
          <p><span class="muted">Previous usernames</span> · ${
            p.usernameHistory.length ? p.usernameHistory.map(escapeHtml).join(", ") : "None on record"
          }</p>
          <p><span class="muted">Inventory</span> · ${p.privacy.canViewInventory ? "Public" : "Private"}</p>
          <p><span class="muted">Saved outfits</span> · ${formatNumber(p.counts.outfits)}</p>
          <p><span class="muted">Friends online now</span> · ${formatNumber(p.counts.onlineFriends)}</p>
          <p><span class="muted">Fetched</span> · ${formatDate(p.fetchedAt)} ${new Date(
            p.fetchedAt
          ).toLocaleTimeString()}</p>
        </div>
      </div>
      ${
        p.timeline && p.timeline.length
          ? `<h3 class="section-title" style="margin-top:1.2rem">Public timeline</h3>
             <ol class="timeline">
              ${p.timeline
                .map(
                  (ev) => `
                <li>
                  <time>${formatDate(ev.at)}</time>
                  <strong>${escapeHtml(ev.title)}</strong>
                  <span class="muted">${escapeHtml(ev.detail || "")}</span>
                </li>`
                )
                .join("")}
             </ol>`
          : ""
      }
      ${
        p.earliestItems && p.earliestItems.length
          ? `<h3 class="section-title" style="margin-top:1.2rem">Earliest public items</h3>
             <div class="badge-row">
              ${p.earliestItems
                .map(
                  (item) => `
                <a class="badge-card" href="${item.url}" target="_blank" rel="noopener">
                  ${imgTag(item.icon, item.name)}
                  <div>
                    <h4>${escapeHtml(item.name)}</h4>
                    <p>${escapeHtml(item.type)} · ${formatDate(item.created)}</p>
                  </div>
                </a>`
                )
                .join("")}
             </div>`
          : ""
      }
      ${
        p.outfits && p.outfits.length
          ? `<h3 class="section-title" style="margin-top:1.2rem">Saved outfits</h3>
             <div class="card-grid">
              ${p.outfits.slice(0, 8).map((o) => `
                <button class="card outfit-card" data-outfit="${o.id}" data-name="${escapeHtml((o.name || "").toLowerCase())}">
                  ${o.icon ? `<img src="${o.icon}" alt="">` : `<div class="ph-wide"></div>`}
                  <div class="body">
                    <h4>${escapeHtml(o.name)}</h4>
                    <p>Click for items + scale</p>
                  </div>
                </button>`).join("")}
             </div>
             <p style="margin-top:.8rem"><button class="chip" data-tab="outfits" type="button">See all outfits</button></p>`
          : loadingMore
            ? `<p class="muted" style="margin-top:1rem">Loading saved outfits…</p>`
            : ""
      }
      ${
        p.officialBadges.length
          ? `<h3 class="section-title" style="margin-top:1.2rem">Official badges</h3>
             <div class="badge-row">
              ${p.officialBadges
                .map(
                  (b) => `
                <article class="badge-card">
                  ${imgTag(b.imageUrl, b.name)}
                  <div>
                    <h4>${escapeHtml(b.name)}</h4>
                    <p>${escapeHtml(b.description)}</p>
                  </div>
                </article>`
                )
                .join("")}
            </div>`
          : ""
      }
    </section>

    <section class="panel ${activeTab === "experiences" ? "active" : ""}" data-panel="experiences">
      ${
        loadingMore && !(p.experiences && p.experiences.length)
          ? emptyState("Loading experiences…")
          : p.experiences && p.experiences.length
            ? `<div class="toolbar">
                <h3 class="section-title" style="margin:0">${p.experiences.length} published</h3>
                <select class="filter" id="gameSort">
                  <option value="oldest" ${gameSort === "oldest" ? "selected" : ""}>Oldest first</option>
                  <option value="newest" ${gameSort === "newest" ? "selected" : ""}>Newest first</option>
                  <option value="visits" ${gameSort === "visits" ? "selected" : ""}>Most visits</option>
                  <option value="name" ${gameSort === "name" ? "selected" : ""}>Name</option>
                </select>
              </div>
              <div class="card-grid">${sortGames(p.experiences).map(gameCard).join("")}</div>`
            : emptyState("No public experiences created.")
      }
    </section>

    <section class="panel ${activeTab === "favorites" ? "active" : ""}" data-panel="favorites">
      ${
        loadingMore && !(p.favorites && p.favorites.length)
          ? emptyState("Loading favorites…")
          : p.favorites && p.favorites.length
            ? `<div class="card-grid">${p.favorites.map(gameCard).join("")}</div>`
            : emptyState("No public favorite experiences.")
      }
    </section>

    <section class="panel ${activeTab === "groups" ? "active" : ""}" data-panel="groups">
      ${
        loadingMore && !(p.groups && p.groups.length)
          ? emptyState("Loading groups…")
          : `
      <div class="toolbar">
        <h3 class="section-title" style="margin:0">${(p.groups || []).length} communities</h3>
        <input class="filter" id="groupFilter" placeholder="Filter groups">
      </div>
      <div class="group-list" id="groupList">
        ${
          p.groups && p.groups.length
            ? p.groups
                .slice()
                .sort((a, b) => b.memberCount - a.memberCount)
                .map(
                  (g) => `
                <a class="group" data-name="${escapeHtml(g.name.toLowerCase())}" href="${g.url}" target="_blank" rel="noopener">
                  ${imgTag(g.icon, g.name)}
                  <div class="body">
                    <h4>${escapeHtml(g.name)}</h4>
                    <p>${formatNumber(g.memberCount)} members</p>
                  </div>
                  <div class="rank">${escapeHtml(g.role)}<br><span class="faint">rank ${g.rank}</span></div>
                </a>`
                )
                .join("")
            : emptyState("Not in any public groups.")
        }
      </div>`
      }
    </section>

    <section class="panel ${activeTab === "friends" ? "active" : ""}" data-panel="friends">
      ${
        loadingMore && !(p.friends && p.friends.length)
          ? emptyState("Loading friends…")
          : `
      <div class="toolbar">
        <p class="muted" style="margin:0">Showing ${(p.friends || []).length} of ${formatNumber(
            p.counts.friends
          )}. Online first. Click to open their dossier.</p>
        <input class="filter" id="friendFilter" placeholder="Filter friends">
      </div>
      ${
        p.friends && p.friends.length
          ? `<div class="friend-grid" id="friendList">${p.friends.map((f) => personCard(f)).join("")}</div>`
          : emptyState("No public friends to show.")
      }`
      }
    </section>

    <section class="panel ${activeTab === "network" ? "active" : ""}" data-panel="network">
      ${
        loadingMore
          ? emptyState("Loading network…")
          : `
        <p class="muted">Counts are public. Roblox now hides follower and following lists unless they come back from the API.</p>
        <div class="stat-grid" style="margin:1rem 0">
          <div class="stat"><b>${formatNumber(p.counts.followers)}</b><span>Followers</span></div>
          <div class="stat"><b>${formatNumber(p.counts.followings)}</b><span>Following</span></div>
          <div class="stat"><b>${formatNumber(p.counts.onlineFriends)}</b><span>Friends online</span></div>
        </div>
        <h3 class="section-title">Followers sample</h3>
        ${
          p.followers && p.followers.length
            ? `<div class="friend-grid">${p.followers.map((f) => personCard(f)).join("")}</div>`
            : emptyState("Follower list is hidden by Roblox.")
        }
        <h3 class="section-title" style="margin-top:1.4rem">Following sample</h3>
        ${
          p.followings && p.followings.length
            ? `<div class="friend-grid">${p.followings.map((f) => personCard(f)).join("")}</div>`
            : emptyState("Following list is hidden by Roblox.")
        }`
      }
    </section>

    <section class="panel ${activeTab === "avatar" ? "active" : ""}" data-panel="avatar">
      ${scaleBlock(p.avatar.scales, p.avatar.type)}
      ${
        p.avatar.wearing.length
          ? `<div class="wear-grid">
              ${p.avatar.wearing
                .map(
                  (item) => `
                <a class="wear" href="${item.url}" target="_blank" rel="noopener">
                  ${imgTag(item.icon, item.name)}
                  <span>
                    <strong>${escapeHtml(item.name)}</strong><br>
                    <span class="muted">${escapeHtml(item.type)}</span>
                  </span>
                </a>`
                )
                .join("")}
            </div>`
          : emptyState(u.isBanned ? "Avatar was wiped with the termination." : "No wearable items returned.")
      }
    </section>

    <section class="panel ${activeTab === "outfits" ? "active" : ""}" data-panel="outfits">
      ${
        loadingMore && !(p.outfits && p.outfits.length)
          ? emptyState("Loading saved outfits…")
          : u.isBanned
            ? emptyState("Saved outfits are removed on terminated accounts.")
            : p.outfits && p.outfits.length
              ? `<div class="toolbar">
                   <h3 class="section-title" style="margin:0">${p.outfits.length}${
                     p.counts.outfits > p.outfits.length ? ` of ${formatNumber(p.counts.outfits)}` : ""
                   } saved outfits</h3>
                   <input class="filter" id="outfitFilter" placeholder="Filter outfits">
                 </div>
                 <div class="card-grid" id="outfitList">
                  ${p.outfits
                    .map(
                      (o) => `
                    <button class="card outfit-card" data-outfit="${o.id}" data-name="${escapeHtml(
                        (o.name || "").toLowerCase()
                      )}">
                      ${o.icon ? `<img src="${o.icon}" alt="">` : `<div class="ph-wide"></div>`}
                      <div class="body">
                        <h4>${escapeHtml(o.name)}</h4>
                        <p>Saved outfit · #${o.id}</p>
                      </div>
                    </button>`
                    )
                    .join("")}
                 </div>`
              : emptyState("No public saved outfits.")
      }
    </section>

    <section class="panel ${activeTab === "limiteds" ? "active" : ""}" data-panel="limiteds">
      ${
        loadingMore
          ? emptyState("Checking inventory…")
          : !p.privacy.canViewInventory
            ? `<div class="empty lock">Inventory is private, so limiteds and RAP stay hidden.</div>`
            : p.collectibles && p.collectibles.length
              ? `<div class="toolbar">
                   <h3 class="section-title" style="margin:0">${p.collectibles.length} collectibles · RAP ${formatNumber(
                     p.counts.totalRap
                   )}</h3>
                 </div>
                 <div class="badge-row">
                  ${p.collectibles
                    .map(
                      (c) => `
                    <a class="badge-card" href="${c.url}" target="_blank" rel="noopener">
                      ${imgTag(c.icon, c.name)}
                      <div>
                        <h4>${escapeHtml(c.name)}</h4>
                        <p>${c.serialNumber != null ? `Serial #${c.serialNumber} · ` : ""}RAP ${
                          c.recentAveragePrice != null ? formatNumber(c.recentAveragePrice) : "—"
                        }</p>
                      </div>
                    </a>`
                    )
                    .join("")}
                 </div>`
              : emptyState("No public collectibles.")
      }
    </section>
  `;
  renderCompare();
}

async function hydrateDetails(query, token) {
  try {
    const details = await loadDetails(query);
    if (token !== requestToken) return null;
    return details;
  } catch {
    return null;
  }
}

async function openProfile(query, push = true, asCompare = false) {
  const q = String(query || "").trim();
  if (!q) return;
  suggestEl.hidden = true;
  if (!asCompare) searchInput.value = q;
  const token = ++requestToken;
  if (!asCompare) setLoading(q);
  try {
    const core = await loadCore(q);
    if (token !== requestToken && !asCompare) return;
    const merged = mergeProfile(core, null);
    if (asCompare) {
      compareProfile = merged;
    } else {
      renderProfile(merged);
      saveRecent(merged);
      statusLine.textContent = `Public dossier for @${core.user.name} · #${core.user.id}`;
      document.title = `${core.user.displayName} (@${core.user.name}) — Dossier`;
    }
    if (push && !asCompare) pushUrl();
    const details = await hydrateDetails(core.user.id, token);
    if (!details) return;
    const full = mergeProfile(core, details);
    if (asCompare) {
      compareProfile = full;
      renderCompare();
    } else {
      renderProfile(full);
      saveRecent(full);
      statusLine.textContent = `Public dossier for @${full.user.name} · #${full.user.id}${
        full.counts.onlineFriends ? ` · ${full.counts.onlineFriends} friends online` : ""
      }`;
    }
    if (push) pushUrl();
  } catch {
    if (!asCompare) {
      statusLine.textContent = "Lookup failed";
      dossierEl.innerHTML = emptyState("User not found or lookup failed.");
    }
  }
}

searchInput.addEventListener("input", () => {
  clearTimeout(suggestTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) {
    renderSuggest([]);
    return;
  }
  suggestTimer = setTimeout(() => runSearch(q), 180);
});

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (!suggestItems.length) return;
    suggestIndex = (suggestIndex + 1) % suggestItems.length;
    highlightSuggest();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (!suggestItems.length) return;
    suggestIndex = (suggestIndex - 1 + suggestItems.length) % suggestItems.length;
    highlightSuggest();
  } else if (e.key === "Enter") {
    if (suggestIndex >= 0 && suggestItems[suggestIndex]) {
      e.preventDefault();
      openProfile(suggestItems[suggestIndex].name);
    }
  } else if (e.key === "Escape") {
    suggestEl.hidden = true;
  }
});

searchForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (suggestIndex >= 0 && suggestItems[suggestIndex]) {
    openProfile(suggestItems[suggestIndex].name);
    return;
  }
  openProfile(searchInput.value);
});

suggestEl.addEventListener("mousedown", (e) => {
  const btn = e.target.closest("button[data-name]");
  if (!btn) return;
  e.preventDefault();
  openProfile(btn.dataset.name);
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".search")) suggestEl.hidden = true;

  const lookup = e.target.closest("[data-lookup]");
  if (lookup) {
    openProfile(lookup.dataset.lookup);
    return;
  }

  const copy = e.target.closest("[data-copy]");
  if (copy) {
    copyText(copy.dataset.copy);
    return;
  }

  const tab = e.target.closest("[data-tab]");
  if (tab && currentProfile) {
    activeTab = tab.dataset.tab;
    $$(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    $$("[data-panel]").forEach((p) => p.classList.toggle("active", p.dataset.panel === activeTab));
    history.replaceState(history.state, "", currentUrl(currentProfile.user.name, compareProfile && compareProfile.user.name, activeTab));
  }

  if (e.target.id === "exportJson" && currentProfile) {
    const blob = new Blob([JSON.stringify(currentProfile, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${currentProfile.user.name}-dossier.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast("JSON exported");
  }

  if (e.target.id === "startCompare") {
    const name = window.prompt("Compare with username or user ID");
    if (name && name.trim()) openProfile(name.trim(), true, true);
  }

  if (e.target.id === "clearCompare") {
    compareProfile = null;
    renderCompare();
    if (currentProfile) pushUrl();
  }

  const outfitBtn = e.target.closest("[data-outfit]");
  if (outfitBtn) {
    openOutfit(outfitBtn.dataset.outfit);
    return;
  }

  if (e.target.id === "closeOutfit" || e.target === outfitModal) {
    outfitModal.hidden = true;
  }
});

document.addEventListener("input", (e) => {
  if (e.target.id === "groupFilter") {
    const q = e.target.value.trim().toLowerCase();
    $$("#groupList .group").forEach((row) => {
      row.style.display = !q || row.dataset.name.includes(q) ? "" : "none";
    });
  }
  if (e.target.id === "friendFilter") {
    const q = e.target.value.trim().toLowerCase();
    $$("#friendList .friend").forEach((row) => {
      row.style.display = !q || row.textContent.toLowerCase().includes(q) ? "" : "none";
    });
  }
  if (e.target.id === "outfitFilter") {
    const q = e.target.value.trim().toLowerCase();
    $$("#outfitList .outfit-card").forEach((row) => {
      row.style.display = !q || (row.dataset.name || "").includes(q) ? "" : "none";
    });
  }
});

document.addEventListener("change", (e) => {
  if (e.target.id !== "gameSort" || !currentProfile) return;
  gameSort = e.target.value;
  renderProfile(currentProfile);
});

$("#focusSearch").addEventListener("click", () => {
  searchInput.focus();
  searchInput.select();
});

const bookmarkBtn = $("#bookmarkBtn");
if (bookmarkBtn) {
  bookmarkBtn.addEventListener("click", async () => {
    const url = location.href;
    try {
      await navigator.clipboard.writeText(url);
    } catch {}
    if (window.sidebar && window.sidebar.addPanel) {
      window.sidebar.addPanel(document.title, url, "");
    } else if (window.external && "AddFavorite" in window.external) {
      window.external.AddFavorite(url, document.title);
    }
    toast("Link copied — press Ctrl+D (Cmd+D on Mac) to pin it on your bookmark bar");
  });
}

$("#brandLink").addEventListener("click", (e) => {
  if (e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  currentProfile = null;
  compareProfile = null;
  history.pushState({}, "", "./");
  landing.hidden = false;
  workspace.hidden = true;
  compareDock.hidden = true;
  document.title = "Dossier — Roblox player intelligence";
});

document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== searchInput && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
  if (e.key === "Escape" && outfitModal && !outfitModal.hidden) {
    outfitModal.hidden = true;
  }
});

async function openOutfit(id) {
  outfitModal.hidden = false;
  outfitBody.innerHTML = `<div class="skel" style="height:240px;margin-bottom:12px"></div><div class="skel" style="height:28px;width:40%"></div>`;
  try {
    const o = await loadOutfit(id);
    outfitBody.innerHTML = `
      <div class="outfit-hero">
        ${imgTag(o.icon, o.name, "outfit-preview")}
        <div>
          <h3 id="outfitTitle">${escapeHtml(o.name)}</h3>
          <p class="muted">${escapeHtml(o.playerAvatarType || "Avatar")} · ${o.assets.length} items · #${o.id}</p>
          <div class="action-row" style="margin-top:.7rem">
            <button class="icon-btn" data-copy="${o.id}">Copy outfit ID</button>
          </div>
        </div>
      </div>
      ${scaleBlock(o.scale, o.playerAvatarType)}
      <div class="wear-grid" style="margin-top:1rem">
        ${
          o.assets.length
            ? o.assets
                .map(
                  (item) => `
              <a class="wear" href="${item.url}" target="_blank" rel="noopener">
                ${imgTag(item.icon, item.name)}
                <span>
                  <strong>${escapeHtml(item.name)}</strong><br>
                  <span class="muted">${escapeHtml(item.type)}</span>
                </span>
              </a>`
                )
                .join("")
            : emptyState("No items on this outfit.")
        }
      </div>`;
  } catch {
    outfitBody.innerHTML = emptyState("Could not load this outfit.");
  }
}

window.addEventListener("popstate", () => {
  const params = new URLSearchParams(location.search);
  const u = params.get("u");
  const vs = params.get("vs");
  activeTab = params.get("tab") || "overview";
  if (u) {
    openProfile(u, false);
    if (vs) openProfile(vs, false, true);
  } else {
    landing.hidden = false;
    workspace.hidden = true;
  }
});

renderRecents();
const boot = new URLSearchParams(location.search);
activeTab = boot.get("tab") || "overview";
if (boot.get("u")) {
  openProfile(boot.get("u"), false);
  if (boot.get("vs")) openProfile(boot.get("vs"), false, true);
}
