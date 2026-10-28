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

// ---- Drops 活動（非官方 GQL；失敗時不影響徽章更新）----
const GQL_CLIENT = "kimne78kx3ncx6brgtihcdtnyx";
async function gql(query, variables = {}) {
  const r = await fetch("https://gql.twitch.tv/gql", {
    method: "POST",
    headers: { "Client-Id": GQL_CLIENT, Authorization: `OAuth ${USER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (!r.ok || j.errors) throw new Error(JSON.stringify(j.errors || j).slice(0, 300));
  return j.data;
}
async function fetchDropCampaigns() {
  if (!USER_TOKEN) return [];
  try {
    const list = await gql(`query { currentUser { id dropCampaigns { id name status startAt endAt game { displayName } } } }`);
    const user = list.currentUser;
    const camps = user?.dropCampaigns || [];
    const out = [];
    for (const c of camps) {
      try {
        const d = await gql(
          `query($u:ID!,$c:ID!){ user(id:$u){ dropCampaign(id:$c){ timeBasedDrops { name requiredMinutesWatched requiredSubs startAt endAt benefitEdges { benefit { name distributionType imageAssetURL } } } } } }`,
          { u: user.id, c: c.id }
        );
        for (const drop of d.user?.dropCampaign?.timeBasedDrops || []) {
          for (const { benefit } of drop.benefitEdges || []) {
            if (benefit?.distributionType !== "BADGE") continue;
            out.push({
              reward: benefit.name,
              campaign: c.name,
              game: c.game?.displayName || null,
              start: drop.startAt || c.startAt,
              end: drop.endAt || c.endAt,
              minutes: drop.requiredMinutesWatched || null,
              subs: drop.requiredSubs || null,
              source: "drops",
            });
          }
        }
      } catch (e) {
        console.warn(`活動 ${c.name} 讀取失敗：${e.message}`);
      }
    }
    console.log(`Drops：找到 ${out.length} 個徽章獎勵`);
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
  const byTitle = new Map();
  for (const d of drops) byTitle.set(norm(d.reward), d);
  for (const b of merged) {
    const d = byTitle.get(norm(b.title)) || byTitle.get(norm(b.set_id));
    if (d) b.campaign = d;
  }
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
