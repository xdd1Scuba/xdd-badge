// 從 Twitch 官方 API 更新 data/badges.json
// 需要環境變數：TWITCH_CLIENT_ID、TWITCH_CLIENT_SECRET
// 選用：TWITCH_USER_TOKEN（用來讀取 Drops 活動的開始／結束時間，非官方介面）
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const DATA = "data/badges.json";
const MANUAL = "data/campaigns.manual.json";
const { TWITCH_CLIENT_ID: CID, TWITCH_CLIENT_SECRET: SECRET, TWITCH_USER_TOKEN: USER_TOKEN } = process.env;

if (!CID || !SECRET) {
  console.error("缺少 TWITCH_CLIENT_ID 或 TWITCH_CLIENT_SECRET");
  process.exit(1);
}

const key = (setId, v) => `${setId}/${v}`;
const norm = s => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
const readJSON = async (p, fallback) => (existsSync(p) ? JSON.parse(await readFile(p, "utf8")) : fallback);

async function appToken() {
  const r = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CID, client_secret: SECRET, grant_type: "client_credentials" }),
  });
  if (!r.ok) throw new Error(`取得 App Token 失敗：${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}

async function fetchGlobalBadges(token) {
  const r = await fetch("https://api.twitch.tv/helix/chat/badges/global", {
    headers: { "Client-Id": CID, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`讀取全域徽章失敗：${r.status} ${await r.text()}`);
  const { data } = await r.json();
  const out = [];
  for (const set of data) {
    for (const v of set.versions) {
      out.push({
        set_id: set.set_id,
        id: v.id,
        title: v.title,
        description: v.description,
        click_action: v.click_action ?? null,
        click_url: v.click_url ?? null,
        image_url_1x: v.image_url_1x,
        image_url_2x: v.image_url_2x,
        image_url_4x: v.image_url_4x,
      });
    }
  }
  return out;
}

// ---- Drops 活動（Twitch 網頁內部介面，需要 TWITCH_USER_TOKEN；失敗時不影響徽章更新）----
const GQL_CLIENT = "kimne78kx3ncx6brgtihcdtnyx";
const HASH = {
  ViewerDropsDashboard: "5a4da2ab3d5b47c9f9ce864e727b2cb346af1e3ea8b897fe8f704a97ff017619",
  DropCampaignDetails: "039277bf98f3130929262cc7c6efd9c141ca3749cb6dca442fc8ead9a53f77c1",
};
async function gqlPost(body) {
  const r = await fetch("https://gql.twitch.tv/gql", {
    method: "POST",
    headers: { "Client-Id": GQL_CLIENT, Authorization: `OAuth ${USER_TOKEN.replace(/^OAuth\s+/i, "").trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { throw new Error(`HTTP ${r.status}：${text.slice(0, 200)}`); }
  const one = Array.isArray(j) ? j[0] : j;
  if (!r.ok || one.errors || one.error) throw new Error(`HTTP ${r.status}：${JSON.stringify(one.errors || one.error || one).slice(0, 300)}`);
  return one.data;
}
const persisted = (op, variables) => gqlPost({ operationName: op, variables, extensions: { persistedQuery: { version: 1, sha256Hash: HASH[op] } } });
const raw = (query, variables = {}) => gqlPost({ query, variables });

async function listCampaigns() {
  try {
    const d = await persisted("ViewerDropsDashboard", { fetchRewardCampaigns: true });
    if (!d?.currentUser) throw new Error("沒有 currentUser，token 可能無效或已過期");
    return { userId: d.currentUser.id, camps: d.currentUser.dropCampaigns || [], rewards: d.rewardCampaignsAvailableToUser || [], via: "persisted" };
  } catch (e) {
    console.warn(`  方式一（ViewerDropsDashboard）失敗：${e.message}`);
  }
  const d = await raw(`query { currentUser { id dropCampaigns { id name status startAt endAt game { displayName } } } }`);
  if (!d?.currentUser) throw new Error("沒有 currentUser，token 可能無效或已過期");
  return { userId: d.currentUser.id, camps: d.currentUser.dropCampaigns || [], rewards: [], via: "raw" };
}
let detailWarned = false;
async function campaignDetail(userId, id) {
  try {
    const d = await persisted("DropCampaignDetails", { channelLogin: userId, dropID: id });
    if (d?.user?.dropCampaign) return d.user.dropCampaign;
    throw new Error("回應中沒有 dropCampaign");
  } catch (e) {
    if (!detailWarned) { console.warn(`  方式一（DropCampaignDetails）失敗，改用方式二：${e.message}`); detailWarned = true; }
  }
  const d = await raw(
    `query($u:ID!,$c:ID!){ user(id:$u){ dropCampaign(id:$c){ id name startAt endAt game { displayName } timeBasedDrops { name requiredMinutesWatched requiredSubs startAt endAt benefitEdges { benefit { name distributionType imageAssetURL } } } } } }`,
    { u: userId, c: id }
  );
  return d?.user?.dropCampaign;
}

async function fetchDropCampaigns() {
  if (!USER_TOKEN) { console.log("未設定 TWITCH_USER_TOKEN，略過 Drops 活動時間"); return null; }
  try {
    console.log("讀取 Drops 活動…");
    const ctx = await listCampaigns();
    const camps = ctx.camps.filter(c => !c.status || ["ACTIVE", "UPCOMING"].includes(c.status));
    console.log(`  找到 ${camps.length} 個 Drops 活動（${ctx.via}）`);
    const out = [];
    for (const c of camps) {
      try {
        const d = await campaignDetail(ctx.userId, c.id);
        for (const drop of d?.timeBasedDrops || []) {
          for (const { benefit } of drop.benefitEdges || []) {
            if (benefit?.distributionType !== "BADGE") continue;
            out.push({
              reward: benefit.name, campaign: c.name, game: c.game?.displayName || d.game?.displayName || null,
              start: drop.startAt || c.startAt, end: drop.endAt || c.endAt,
              minutes: drop.requiredMinutesWatched || null, subs: drop.requiredSubs || null, source: "drops",
            });
          }
        }
      } catch (e) {
        console.warn(`  活動「${c.name}」讀取失敗：${e.message}`);
      }
      await new Promise(r => setTimeout(r, 150));
    }
    // 非 Drops 的獎勵活動（例如 TwitchCon、官方活動）
    for (const rc of ctx.rewards) {
      for (const rw of rc.rewards || []) {
        out.push({ reward: rw.name, campaign: rc.name, game: rc.game?.displayName || null, start: rc.startsAt || rc.startAt, end: rc.endsAt || rc.endAt, minutes: null, subs: null, source: "drops", maybe: true });
      }
    }
    console.log(`  共 ${out.length} 個徽章獎勵`);
    return out;
  } catch (e) {
    console.warn(`Drops 讀取失敗（不影響徽章更新）：${e.message}`);
    return null; // null = 這次讀不到，保留舊的活動資料
  }
}

// ---- main ----
const now = new Date().toISOString();
const prev = await readJSON(DATA, { badges: [] });
const manual = await readJSON(MANUAL, {});
const prevMap = new Map(prev.badges.map(b => [key(b.set_id, b.id), b]));
const firstRun = prev.badges.length === 0;

const token = await appToken();
const live = await fetchGlobalBadges(token);
const liveKeys = new Set(live.map(b => key(b.set_id, b.id)));
const drops = await fetchDropCampaigns();

const merged = [];
const added = [];
for (const b of live) {
  const k = key(b.set_id, b.id);
  const old = prevMap.get(k);
  const rec = {
    ...b,
    first_seen: old?.first_seen || now,
    baseline: old ? !!old.baseline : firstRun, // 第一次執行時已存在的徽章，無法得知實際上線日
    removed_at: null,
    campaign: old?.campaign || null,
  };
  if (!old) added.push(rec);
  merged.push(rec);
}
// Twitch 移除的徽章保留紀錄
for (const old of prev.badges) {
  if (!liveKeys.has(key(old.set_id, old.id))) merged.push({ ...old, removed_at: old.removed_at || now });
}

// 套用 Drops 活動時間（以獎勵名稱比對徽章標題）
if (drops) {
  const used = new Set();
  const live = merged.filter(b => !b.removed_at);
  const byTitle = new Map();
  for (const b of live) { const k = norm(b.title); if (!byTitle.has(k)) byTitle.set(k, []); byTitle.get(k).push(b); }
  for (const d of drops) {
    const n = norm(d.reward);
    let hits = byTitle.get(n) || live.filter(b => norm(b.set_id) === n);
    if (!hits.length && n.length >= 6) hits = live.filter(b => { const t = norm(b.title); return t.length >= 6 && (t.includes(n) || n.includes(t)); });
    if (!hits.length) { if (!d.maybe) console.log(`  未配對：「${d.reward}」（${d.campaign}）`); continue; }
    // 同名多版本時，取最新偵測到的那一個
    const b = hits.sort((x, y) => y.first_seen.localeCompare(x.first_seen))[0];
    const { maybe, ...camp } = d;
    b.campaign = camp; used.add(key(b.set_id, b.id));
  }
  console.log(`  已配對 ${used.size} 個徽章的活動時間`);
}
// 手動資料最優先：data/campaigns.manual.json 以 "set_id/版本" 為 key
for (const b of merged) {
  const m = manual[key(b.set_id, b.id)];
  if (m) b.campaign = { ...(b.campaign || {}), ...m, source: b.campaign?.source === "drops" ? "drops+manual" : "manual" };
}

merged.sort((a, b) => (b.first_seen.localeCompare(a.first_seen)) || a.set_id.localeCompare(b.set_id) || Number(a.id) - Number(b.id));

const out = { updated_at: now, count: merged.length, badges: merged };
const before = JSON.stringify({ ...prev, updated_at: null });
const after = JSON.stringify({ ...out, updated_at: null });
if (before === after) {
  console.log(`沒有變化（共 ${merged.length} 個徽章）`);
} else {
  await mkdir("data", { recursive: true });
  await writeFile(DATA, JSON.stringify(out, null, 1));
  console.log(`已更新：共 ${merged.length} 個，新增 ${added.length} 個${added.length ? "：" + added.map(b => b.title).join("、") : ""}`);
}
