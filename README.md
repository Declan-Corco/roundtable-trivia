# roundtable — pull up a chair

A live party-game night around a round table. The **host** puts a lobby on a big screen with a QR code and game PIN, and players join from their **phones**. The host picks one of two games, and can switch games between rounds without anyone re-joining.

### Wager Wars

Trivia with bets. **How a question plays:**

1. **Bet.** The big screen shows the next question's category (and difficulty). Everyone bets some or all of their points on their phone. Everyone starts with 1,000, and you can always bet up to 500 even if you have less.
2. **Answer.** The question appears and everyone answers **A, B, C or D**.
3. **Reveal.** A right answer wins your bet, a wrong answer (or no answer) loses it. Double-points questions pay out twice the bet. The screen calls out the biggest win and the biggest loss.

Questions come from Open Trivia DB (see below), or from your own files.

### Only One

Each round, the big screen shows a category, like "Things in a dorm room". Every table types as many answers as it can on their phones before the timer runs out. **Any answer another table also wrote scores nothing; every answer only your table thought of scores 100.**

- **The server decides which answers count as the same**, in a few dozen milliseconds:
  - **Text rules** handle spelling: "Mini fridge" = "minifridge", "Microwaves" = "microwve".
  - **A small AI model running on the server** handles meaning: "Keurig" = "coffee maker", "TV" = "television", "couch" = "sofa". The model is [bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5), about 34 MB, and runs on the CPU with no API key and no cost per game. It downloads once, the first time the server starts, to `server/data/models/`, and works offline after that.
- **The host has the final say.** Before scoring, the TV shows the groups. Tap an answer to pull it out of a group, tap two groups to merge them, or ✕ an answer that doesn't fit the category.
- 230 categories ship in six packs (`server/onlyone/`), and the host can type their own on the setup page.
- If the AI model can't be installed or loaded, Only One still works: matching falls back to the text rules, and the host merges the rest.

#### Claude check (optional)

With an Anthropic API key, Claude double-checks every round. When time is up, the TV shows a grading screen with the roundtable logo spinning while the server matches answers and Claude checks them (usually about 4 seconds). Claude rejects answers that don't fit the category ("banana" for "Things a superhero needs"), merges answers the local model missed ("Doritos" = "chips"), and splits ones it grouped wrongly. The results then appear with Claude's changes tagged "Claude", and the host can still undo any of them before scoring. If Claude doesn't answer within 15 seconds (`AI_CHECK_WAIT_MS`) or fails, the results appear without its check.

- **Cost:** about $0.0005–0.001 per round with Claude Haiku 5.5 (it gives a verdict on every answer), so roughly 1,000–2,000 rounds per dollar. The server log prints the answers judged, tokens, cost and time of every check.
- **Check it:** `cd /opt/roundtable/server && sudo node scripts/try-claude-check.js` sends Claude three tricky rounds (including "Things you shouldn't say on a first date") and shows what it rejected and merged, and what it got wrong.
- **Turn it on:** get a key at https://console.anthropic.com, then run `sudo bash server/setup.sh --anthropic-key sk-ant-...`, or add `ANTHROPIC_API_KEY=sk-ant-...` to `/etc/roundtable.env` and run `sudo systemctl restart roundtable`. It's then always on for Only One; remove the key to turn it off.
- **Privacy:** each round's category and answers are sent to Anthropic. Leave the key unset to keep everything on your server.
- `AI_CHECK_MODEL` changes the model (default `claude-haiku-5-5`).

```
Roundtable/
├── client/              ← the website (plain HTML/CSS/JS, no build step)
│   ├── index.html       ← landing page: short intro + Join / Host buttons
│   ├── join.html        ← player screen (phones): join, bet, answer, type answers
│   ├── host.html        ← host screen (TV/projector/laptop): lobby, questions, scores
│   ├── css/style.css    ← all styling; brand colours are variables at the top
│   ├── fonts/           ← Fredoka (SIL Open Font License), served locally
│   └── js/              ← common.js, host.js, player.js
└── server/              ← the backend (Node.js + Socket.IO), also serves the website
    ├── src/             ← index.js (web server), games.js (the games, categories + settings),
    │                       game.js (game engine), matcher.js (Only One answer matching),
    │                       sources.js (Open Trivia DB question bank), trivia.js (question file loader)
    ├── trivia/          ← your own Wager Wars questions: one .json file each
    ├── onlyone/         ← Only One category packs: one .json file each
    ├── setup.sh         ← one-command Linux installer
    └── package.json
```

**Features:** lobby with QR code + PIN · auto mode (the game moves on by itself 10 s, 30 s or 1 min after each answer and the standings, so the host doesn't have to press anything) · the PIN stays on screen so people can join late, even mid-game · play again with the same table and pick a new game · remove players · lock the lobby · "get ready" countdown · categories you can mix, and settings (question count, betting time, answer time, order) · bet on each category before the question · 4-colour A/B/C/D answer tiles · answer streaks · double-winnings questions · true/false and multiple-correct questions · answer chart after each question · top-5 scoreboard · podium finish · players and the host can refresh or lose signal and rejoin automatically · works on phones, tablets and desktops · upload a trivia file straight from the host screen · optional host password.

---

## 1. Try it on your own computer (2 minutes)

Install [Node.js](https://nodejs.org) (version 22 or newer), then:

```bash
cd server
npm install
npm start
```

- Host screen: **http://localhost:3000/host**
- Players scan the QR code (phones must be on the **same Wi-Fi**). The QR code automatically uses your computer's network address, not "localhost".

> **Windows:** the first time, Windows Firewall may ask whether Node.js can accept connections. Allow it on **Private networks**, or phones won't be able to connect.

---

## 2. Install on a Linux server (one command)

Works on Ubuntu, Debian, Raspberry Pi OS, Linux Mint, Fedora, Rocky and Alma Linux.

**Step 1 — Copy the `Roundtable` folder to the Linux machine.** Use any of these:

- A USB stick.
- From Windows PowerShell: `scp -r C:\Roundtable youruser@LINUX-IP:~/` (replace `youruser` and `LINUX-IP`).
- Push it to GitHub and `git clone` it on the server.

**Step 2 — Run the installer** on the Linux machine:

```bash
cd ~/Roundtable
sudo bash server/setup.sh
```

It asks one question, which is how players will reach the server:

1. **With my own domain.** Choose this after you've followed [section 3](#3-get-a-domain-and-host-it-from-home). It sets up HTTPS for you.
2. **Local network only.** Choose this for home or classroom use on the same Wi-Fi.
3. **Through Cloudflare Tunnel or another proxy.** See [option B](#option-b--cloudflare-tunnel-no-port-forwarding-works-anywhere).

Then it does everything else:

- installs Node.js
- copies the app to `/opt/roundtable`
- creates a `roundtable` background service that starts on boot and restarts if it crashes
- installs **Caddy** for automatic free HTTPS certificates (domain option only)
- opens the firewall
- prints the address to open

You can also skip the question with a flag:

```bash
sudo bash server/setup.sh --lan
sudo bash server/setup.sh --domain trivia.example.com --email you@example.com
sudo bash server/setup.sh --public-url https://trivia.example.com
sudo bash server/setup.sh --uninstall
```

**Updating:** from the folder you cloned, run `git pull && sudo bash server/setup.sh`. It doesn't ask any questions on an update. Your settings (domain, password) and any trivia sets you added on the server are kept.

### Everyday commands

| What | Command |
|---|---|
| See if it's running | `systemctl status roundtable` |
| Live logs | `sudo journalctl -u roundtable -f` |
| Restart (e.g. after editing settings) | `sudo systemctl restart roundtable` |
| Edit settings | `sudo nano /etc/roundtable.env` |
| Add trivia sets | copy `.json` files into `/opt/roundtable/server/trivia/` (no restart needed) |

---

## 3. Get a domain and host it from home

You need two things: a **domain name** that points to your home's public IP address, and a **router** that forwards web traffic to your Linux machine. Allow about 20 minutes.

### Option A — Domain + port forwarding (classic way)

#### Step 1: Buy a domain (~$10/year)

Any registrar works. These are good, cheap and simple:

- **Cloudflare Registrar** (dash.cloudflare.com → Domain Registration). Sells at cost and has the best DNS.
- **Porkbun** (porkbun.com).
- **Namecheap** (namecheap.com).

Search for a name, buy it, and turn on **WHOIS privacy** if the registrar offers it (it's usually free).

*Free alternative:* [DuckDNS](https://www.duckdns.org) gives you a free subdomain like `mytrivia.duckdns.org`. Sign in, create a subdomain, and use it everywhere this guide says "your domain".

#### Step 2: Check that your internet connection allows hosting

1. On the Linux machine, run `curl -4 ifconfig.me`. This is your **public IP**.
2. Log in to your router (usually http://192.168.0.1 or http://192.168.1.1; the address and password are often on a sticker on the router). Find the **WAN / Internet IP**.
3. If the two numbers **match**, carry on.
4. If they **differ**, or the router's WAN IP starts with `100.64`–`100.127`, `10.` or `192.168.`, your ISP uses **CGNAT** and port forwarding won't work. Use [Option B](#option-b--cloudflare-tunnel-no-port-forwarding-works-anywhere) instead.

#### Step 3: Give the Linux machine a fixed local IP

In your router, find **DHCP reservation** (also called "Static lease" or "Address reservation"). Reserve the Linux machine's current IP, which you can see with `hostname -I`. This stops the IP from changing, which would break port forwarding.

#### Step 4: Forward ports 80 and 443

In your router, find **Port Forwarding** (also called "Virtual Server" or "NAT"). Add two rules:

| Name | External port | Internal IP | Internal port | Protocol |
|---|---|---|---|---|
| web | 80 | *your Linux IP* | 80 | TCP |
| web-secure | 443 | *your Linux IP* | 443 | TCP |

#### Step 5: Point the domain at your home

At your registrar or DNS provider, open **DNS settings** and add a record:

| Type | Name / Host | Value | TTL |
|---|---|---|---|
| A | `trivia` (or `@` for the bare domain) | *your public IP from step 2* | Auto / 5 min |

With `trivia`, your game lives at `trivia.yourdomain.com`.

> **Using Cloudflare DNS?** Set the record to **"DNS only"** (grey cloud) while you set things up.

DNS usually takes effect within a few minutes. To check it, run `getent hosts trivia.yourdomain.com` on the server; it should print your public IP.

#### Step 6: Run the installer with your domain

```bash
sudo bash server/setup.sh --domain trivia.yourdomain.com
```

Caddy fetches a free HTTPS certificate from Let's Encrypt automatically and renews it forever. Open **https://trivia.yourdomain.com/host** and you're live.

#### Step 7: Keep the domain pointed at you if your home IP changes

Most home IPs change occasionally. Pick one:

- **DuckDNS:** follow the "install" page on duckdns.org for Linux cron. It's a one-line cron job.
- **Cloudflare DNS:** install [`ddclient`](https://ddclient.net) (`sudo apt install ddclient`) and choose Cloudflare during setup.
- Many routers have a **Dynamic DNS** setting built in that supports common providers.

#### Step 8: Set a host password

Your site is now public, so stop strangers from creating games:

```bash
sudo nano /etc/roundtable.env      # set HOST_PASSWORD=something-secret
sudo systemctl restart roundtable
```

Players never need the password. Only the host screen asks for it.

### Option B — Cloudflare Tunnel (no port forwarding, works anywhere)

Use this if you have CGNAT, can't access your router, or don't want to open ports. It's free. Your domain must use Cloudflare for DNS: either buy it at Cloudflare, or add your domain at dash.cloudflare.com and change the nameservers at your registrar to the two Cloudflare gives you.

1. Run the installer in LAN mode first: `sudo bash server/setup.sh --lan`
2. In the Cloudflare dashboard, go to **Zero Trust → Networks → Tunnels → Create a tunnel** and choose **Cloudflared**. Give it a name.
3. Pick your OS (Debian/Red Hat). Cloudflare shows a command. **Copy and run it on the Linux machine.** It installs `cloudflared` as a service.
4. Under **Public Hostname**, add a hostname:
   - Subdomain: `trivia`
   - Domain: *your domain*
   - Service type: `HTTP`
   - URL: `localhost:3000`
5. Tell the game its public address:
   ```bash
   sudo bash server/setup.sh --public-url https://trivia.yourdomain.com
   ```

Cloudflare handles HTTPS. Open **https://trivia.yourdomain.com/host**.

### Option C — Rent a small cloud server (VPS)

If you'd rather not host from home, a $4–6/month VPS works perfectly: Hetzner, DigitalOcean, Linode/Akamai or Vultr, running Ubuntu 24.04.

1. Point your domain's **A record** at the VPS's IP.
2. Copy the folder over and run `sudo bash server/setup.sh --domain trivia.yourdomain.com`.

There's no router to configure.

---

## 4. Where trivia questions come from

Questions come from [Open Trivia DB](https://opentdb.com), a free public trivia database licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The server keeps a **question bank** of them, so a lobby opens instantly.

The host picks from a few popular categories, and can tick several to mix them:

- General Knowledge
- Science & Nature
- Geography
- History
- Film
- Music
- Sports
- Animals

They can also set the **Difficulty**: Mixed, Easy, Medium or Hard.

- Each question shows a small credit line on the host screen ("Open Trivia DB · CC BY-SA 4.0"), as the license requires.
- **The question bank.** Open Trivia DB allows only one request every 5 seconds, one category at a time, so fetching questions when a lobby opens took 10–15 seconds. Instead, the server fills a bank in the background, about 100 questions per category. A new server takes 2–3 minutes to fill it. The bank is saved in `server/data/question-bank.json` (on an installed server, `/opt/roundtable/server/data/`), so it is ready straight away after a restart or an update.
- **No repeats.** Played questions leave the bank and the server tops it back up between games, so a question doesn't come back until its whole category has been played through. If a category runs short (lots of games in a row, or a difficulty with few questions), the rest are fetched live, which takes a few seconds.
- **The server needs internet access** to fill the bank. If Open Trivia DB can't be reached, the server keeps using what's banked and tries again every minute. Your own question files (next section) work offline. Delete the bank file to start it fresh.
- To offer more categories, add a line to the `CATEGORIES` list in [server/src/sources.js](server/src/sources.js). Category IDs are listed at https://opentdb.com/api_category.php.

---

## 5. Make your own categories

Your own categories are `.json` files in `server/trivia/` (on an installed server: `/opt/roundtable/server/trivia/`).

A new file appears on the host screen the next time the page loads. Hosts can also **upload a .json file** right from the setup page, and tick several categories to mix them into one game. The file's `title` is the category players see before they bet.

```json
{
  "title": "Movie Night",
  "description": "Films from every decade",
  "defaultTime": 20,
  "questions": [
    { "question": "Who directed Jaws?", "answers": ["Spielberg", "Lucas", "Scorsese", "Coppola"], "correct": 0 },
    { "question": "Toy Story was the first fully computer-animated feature film.", "answers": ["True", "False"], "correct": 0, "time": 10 },
    { "question": "Which of these won Best Picture?", "answers": ["Titanic", "Avatar", "Parasite", "Jurassic Park"], "correct": [0, 2], "points": "double" }
  ]
}
```

- `correct` counts from **0**: the first answer is 0 and the fourth answer is 3. Use an array if several answers are right.
- Optional per question: `time` (seconds), `points` (`"standard"`, `"double"` pays twice the bet, `"none"` is a practice question with no bets at stake), `category` (shown before betting instead of the file's title), and `image` (an `https://` URL or `/media/file.png` placed in `trivia/media/`).
- A file with a mistake is skipped. The host screen tells you which file and which question is wrong.

Full details are in [server/trivia/README.md](server/trivia/README.md).

### Only One categories

Only One packs are `.json` files in `server/onlyone/` (installed: `/opt/roundtable/server/onlyone/`), each a list of prompts:

```json
{ "title": "College Life", "icon": "🎓", "description": "Dorms, classes, campus and late nights.",
  "prompts": ["Things in a dorm room", "College majors", "Excuses for missing class"] }
```

Hosts can also type their own prompts, one per line, on the Only One setup page; those are played first. Details: [server/onlyone/README.md](server/onlyone/README.md).

---

## 6. Settings

On Linux they're in `/etc/roundtable.env`. When running by hand, set them as environment variables.

| Setting | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port the app listens on. |
| `PUBLIC_URL` | *(auto)* | Address in the QR code, e.g. `https://trivia.example.com`. |
| `HOST_PASSWORD` | *(none)* | Password required to create games. |
| `ALLOW_UPLOADS` | `true` | Let hosts upload their own trivia file. |
| `MAX_PLAYERS` | `200` | Max players per game. |
| `MAX_GAMES` | `50` | Max games running at once. |
| `APPLE_APP_ID` | *(none)* | iOS app ID (`TEAMID.site.round-table.app`) so scanning the QR code opens the app. See [ios/README.md](ios/README.md). |
| `TRIVIA_DIR` | `server/trivia` | Where trivia sets are loaded from. |

---

## 7. Troubleshooting

| Problem | Fix |
|---|---|
| Phones can't open the QR link (LAN) | Phones must be on the same Wi-Fi, not a guest network. Check the firewall (`sudo ufw allow 3000/tcp`). |
| QR code shows the wrong address | Set `PUBLIC_URL` in `/etc/roundtable.env` and restart. |
| HTTPS doesn't work | Check `sudo journalctl -u caddy -f`. Usually DNS isn't pointing at you yet, or ports 80/443 aren't forwarded. |
| Domain works from mobile data but not home Wi-Fi | Your router lacks "NAT loopback". Use `http://LINUX-IP:3000` at home, or use Cloudflare Tunnel. |
| `setup.sh: $'\r': command not found` | The file got Windows line endings. Run `sed -i 's/\r$//' server/setup.sh` and try again. |
| Service won't start | Run `sudo journalctl -u roundtable -n 50` to see the error. |

**Keyboard tip for hosts:** press **Space** or **→** to start or advance. This works with presentation clickers too.
