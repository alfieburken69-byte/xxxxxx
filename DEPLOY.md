# Deploying to a VPS

Yes — a VPS is the right call. The bot has to be running to catch trade ads as they appear, and ads are only returned for the **last 3 minutes**. Close your laptop and you miss everything.

Any 1 GB box works. The whole process idles around 60–90 MB RAM.

## What's already in the repo

| File | Use |
|---|---|
| `deploy/rolimons-tracker.service` | systemd unit — best for a plain VPS |
| `deploy/ecosystem.config.cjs` | pm2 config, if you prefer pm2 |
| `Dockerfile` + `docker-compose.yml` | container route |
| `start.bat` | Windows double-click launcher |

## Option A — systemd (recommended)

Ubuntu 22.04 / 24.04 / Debian 12.

**1. Get the files onto the box.** From Windows:

```powershell
cd "C:\Users\johns\Documents\Default Project"
scp -r rolimons-tracker root@YOUR_VPS_IP:/opt/
```

Or push it to a private GitHub repo and `git clone` on the server. Never commit `.env` — it's already in `.gitignore`.

**2. Install Node 22**

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v
```

**3. Install deps and set the token**

```bash
cd /opt/rolimons-tracker
npm install --omit=dev
cp .env.example .env
nano .env          # DISCORD_TOKEN + GUILD_ID
```

**4. Create the service user and log file**

```bash
sudo useradd -r -s /usr/sbin/nologin rolimons
sudo chown -R rolimons:rolimons /opt/rolimons-tracker
sudo touch /var/log/rolimons-tracker.log
sudo chown rolimons:rolimons /var/log/rolimons-tracker.log
```

**5. Install and start**

```bash
sudo cp deploy/rolimons-tracker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rolimons-tracker
sudo systemctl status rolimons-tracker
```

**6. Watch it work**

```bash
sudo tail -f /var/log/rolimons-tracker.log
```

Expected:

```
[bot] logged in as YourBot#1234
[bot] slash commands registered to guild 123456789
[scan] 385 ads · 385 players · 13 in game · no new matches
[post] SomeUser · 100k – 200k · RAP 145281 · Burger Incremental 🍔
```

Manage it:

```bash
sudo systemctl restart rolimons-tracker
sudo systemctl stop rolimons-tracker
sudo journalctl -u rolimons-tracker -f
```

## Option B — pm2

If you'd rather not use systemd:

```bash
sudo npm install -g pm2
cd /opt/rolimons-tracker
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup      # run the command it prints
pm2 logs rolimons-tracker
```

## Option C — Docker

```bash
cd /opt/rolimons-tracker
cp .env.example .env && nano .env
docker compose up -d --build
docker compose logs -f
```

State lives in `./data` on the host, so restarts keep your cooldowns and value cache.

## After deploying

- Only run **one** instance. Two copies double-post and split the Rolimon's rate limit between them, which makes both hit 429s.
- `/check` and `/stats` work from any channel the bot can see.
- Delete `data/state.json` to clear all cooldowns and cached values.
- `BUCKET_METRIC=rap` or `value` if you want brackets decided by one stat instead of either.

## Sizing

| Load | Spec |
|---|---|
| 1 guild, default settings | 1 vCPU / 512 MB–1 GB, ~80 MB RAM |
| Lower `POLL_INTERVAL_SECONDS` to 60 | Still fine, but Rolimon's throttle becomes the real ceiling |

The rate limiter queues every request serially at `ROLIMONS_MIN_INTERVAL_MS` (1.3 s ≈ 46/min), so CPU is never the bottleneck — network latency is.
