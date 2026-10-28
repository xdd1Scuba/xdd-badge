# Twitch 徽章圖鑑

所有徽章資料都直接取自 Twitch 官方 API，由 GitHub 每 10 分鐘自動更新一次，網站完全免費架設在 GitHub Pages。

## 檔案說明

| 檔案 | 用途 |
|---|---|
| `index.html` | 網站本體（時間軸＋所有徽章） |
| `scripts/update.mjs` | 向 Twitch 抓取徽章、比對新增、寫入資料 |
| `.github/workflows/update.yml` | 每 10 分鐘自動執行更新並重新部署網站 |
| `data/campaigns.manual.json` | 手動補充或修正活動時間 |
| `data/badges.json` | 第一次執行後自動產生，不需要手動編輯 |

## 架設步驟（約 10 分鐘）

### 1. 建立 GitHub 儲存庫
到 GitHub 建立一個新的 **Public** 儲存庫（例如 `twitch-badges`），把這個資料夾裡的所有檔案上傳，包含 `.github` 資料夾。

### 2. 申請 Twitch 開發者應用程式
1. 到 <https://dev.twitch.tv/console/apps> 登入，按「註冊您的應用程式」
2. 名稱隨意填，OAuth 重新導向網址填 `http://localhost`，類別選「Website Integration」，用戶端類型選「機密」
3. 建立後點「管理」，複製 **用戶端 ID**，再按「新密碼」產生並複製 **用戶端密碼**

### 3. 把金鑰存進 GitHub
儲存庫的 **Settings → Secrets and variables → Actions → New repository secret**，新增兩筆：

- `TWITCH_CLIENT_ID`：用戶端 ID
- `TWITCH_CLIENT_SECRET`：用戶端密碼

金鑰只存在 GitHub 的加密設定中，不會出現在網站上。

### 4. 開啟 GitHub Pages
**Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**。

### 5. 第一次執行
**Actions → 更新徽章資料 → Run workflow**。約 1 分鐘後，網站會出現在
`https://你的帳號.github.io/twitch-badges/`

之後每 10 分鐘會自動檢查一次，Twitch 有新徽章時會自動存檔並重新部署。開著網站的觀眾，網頁每 2 分鐘會檢查一次，有新徽章時會跳出通知。

## 活動時間（時間軸用）

Twitch 官方 API 只提供徽章本身（名稱、說明、圖片），**不提供 Drops 的開始與結束時間**。時間軸的資料有兩個來源：

### 方法 A：自動讀取 Drops（選用，非官方）
新增第三個 Secret `TWITCH_USER_TOKEN`，程式就會讀取 Drops 活動的時間並自動配對徽章。

取得方式：用瀏覽器登入 Twitch → 開發者工具（F12）→ Application → Cookies → `https://www.twitch.tv` → 複製 `auth-token` 的值。

注意事項：
- 這是 Twitch 網頁內部使用的介面，不是公開 API，Twitch 隨時可能變更而失效。失效時只會略過活動時間，徽章更新不受影響。
- 這個值等同你的登入憑證，**建議用一個另外註冊的小帳號**，不要用主帳號。
- 登出或改密碼後會失效，需重新設定。

### 方法 B：手動補充
編輯 `data/campaigns.manual.json`，以 `set_id/版本` 為 key 填入 UTC 時間：

```json
"hunt-white/1": { "game": "Hunt: Showdown 1896", "start": "2026-10-26T14:54:00Z", "end": "2026-11-09T13:59:00Z", "minutes": 15 }
```

可填欄位：`game`、`start`、`end`、`minutes`（觀看分鐘數）、`subs`（需訂閱數）。手動資料會覆蓋自動資料。存檔後網站會自動重新部署。

## 常見問題

**舊徽章為什麼沒有新增日期？**
Twitch API 不提供徽章上線日期。第一次執行時已存在的所有徽章都會標示為「建站前即存在」；之後新出現的徽章才有準確的偵測時間。

**為什麼有時候超過 10 分鐘才更新？**
GitHub 的排程在尖峰時段常延遲 5–20 分鐘，這是免費方案的限制。想要更即時，可以改用 Cloudflare Workers 的每分鐘排程。

**時區怎麼決定？**
網頁讀取觀眾裝置的時區設定，台灣觀眾看到台灣時間，美西觀眾看到太平洋時間，夏令時間也會自動處理。

**60 天沒有更新會停止嗎？**
GitHub 會停用 60 天沒有任何提交的儲存庫排程。只要有新徽章就會自動提交，通常不會發生；若被停用，到 Actions 頁面重新啟用即可。
