# jellyfin-webos-switcher

Netflix-style profile switching for the Jellyfin app on LG TVs (webOS), with no changes to the app and no sideloading.

A tiny nginx container sits in front of Jellyfin and adds one script to the web pages the TV loads. That script gives you:

- **One-press login for passwordless users.** Pick your tile on the login screen and you're in. No password prompt, no on-screen keyboard.
- **A "Switch user" button** in the header, next to the user icon. It opens a menu of the other users, plus **Sign out**. The **green button** on the LG remote opens it too.
- **A loading screen** that hides the flicker of sign-out → server picker → login → home while switching.

Users with passwords keep working normally and just get Jellyfin's usual prompt.

> [!IMPORTANT]
> **This project was vibe coded.** I built it in conversation with an AI assistant (Claude) to solve a problem in my own house, and tested it on my own TV. I understand what it does and I've read every line, but I'm not a JavaScript developer and it hasn't been reviewed by anyone else.
>
> **Maintenance is limited to keeping it working with current Jellyfin releases.** If a Jellyfin or webOS update breaks it, I'll try to fix it. I'm not planning new features, and I can't promise a timeline. Issues are welcome, and pull requests even more so. You're also free to fork it and take it wherever you like (MIT licence).

Not affiliated with or endorsed by the Jellyfin project or LG.

---

## How it works

```
Without a reverse proxy:
  LG TV app ──HTTP :8097──▶ jellyfin-webos-switcher (nginx) ──▶ Jellyfin

With a reverse proxy:
  LG TV app ──HTTPS──▶ your reverse proxy ──▶ jellyfin-webos-switcher (nginx) ──▶ Jellyfin

The switcher adds one <script> tag to Jellyfin's HTML pages. Everything else passes through untouched.
```

- nginx passes every request through to Jellyfin unchanged. The only change is to HTML responses: one `<script src="/__webos-inject/webos.js">` tag is added before `</body>`. Video streams, the API and WebSockets are passed straight through without buffering.
- **The script never calls Jellyfin's login API itself and never sees, stores or sends a token.** For tile login, it lets Jellyfin's own click handler fill in the login form, then presses Jellyfin's own Sign In button with the password left empty. Jellyfin does all of the authentication.
- If a blank password is rejected (HTTP 401), the script records the **username only** in the TV's local storage and from then on shows the normal password prompt for that user on that TV.
- For switching, it signs out through Jellyfin's own sign-out, skips the webOS app's server picker, and selects the new user's tile, which hands over to the tile login above.
- If anything on the page isn't where the script expects it, it does nothing and you get Jellyfin's normal behaviour.

The main idea: the TVs use **their own address** (a separate port, or a separate hostname if you have a reverse proxy). Phones, browsers and everything else keep using your normal Jellyfin address and never see the script.

## Requirements

- Jellyfin in Docker, with this container on the **same Docker network** and Jellyfin's service named `jellyfin` (port 8096). If yours is different, change `set $jellyfin http://jellyfin:8096;` in `conf.d/jellyfin-webos.conf`.
- The official Jellyfin app for LG webOS.
- For one-press login: users with **no password** who are **not hidden** from the login screen.
- A reverse proxy is **optional**. If you already reach Jellyfin through one, you can put the switcher behind it too.

## Setup

### 1. Copy the files

Put `conf.d/` and `inject/` somewhere on your Docker host, for example next to your Jellyfin compose file.

### 2. Set your admin username

Open `inject/webos.js` and replace `CHANGE_ME_ADMIN` with your admin account's username (and any other account that has a password):

```js
var ALWAYS_PROMPT = ['admin'];
```

These users never get a blank-password attempt, so the script can never push them towards Jellyfin's failed-login lockout. Even if you miss a user, the script only tries once per TV: after the first rejection it remembers that user needs a password.

### 3. Add the container

Add the service from [`docker-compose.example.yml`](docker-compose.example.yml) to the compose file that runs Jellyfin. Set its `ports:` line for your setup:

| Your setup | `ports:` |
|---|---|
| **No reverse proxy.** The TV connects straight to the switcher. | `- 8097:80/tcp` |
| **Reverse proxy on the same host** (plain nginx, a NAS's built-in proxy…) | `- 127.0.0.1:8097:80/tcp` (the example's default: only the proxy can reach it) |
| **Reverse proxy in Docker** on the same network (Caddy, NPM, Traefik…) | Remove the `ports:` section entirely |

Bring it up and check it's healthy:

```sh
docker ps --filter name=jellyfin-webos-switcher
```

### 4. Reverse proxy only: point it at the switcher

**Skip this step if you don't use a reverse proxy.**

Create a **new hostname** for the TVs (for example `jellyfin-tv.example.com`), separate from your normal Jellyfin one, and forward it to the switcher with WebSockets enabled:

| | |
|---|---|
| Source | HTTPS, `jellyfin-tv.example.com`, port 443, with a valid certificate |
| Destination | Proxy on the host: `http://127.0.0.1:8097`<br>Proxy in Docker: `http://jellyfin-webos-switcher:80` |
| WebSockets | Enabled (forward the `Upgrade` and `Connection` headers) |

### 5. Prepare Jellyfin

In the Jellyfin dashboard, under **Users**:

- Users who should get one-press login: no password, and **"Hide this user from login screens"** unticked.
- Your admin: give it a password and consider hiding it from login screens. Hidden users don't appear in the switcher either.

### 6. Point the TV at the switcher

In the Jellyfin app on the TV, add a server using the switcher's address and sign in from the login screen:

- **No reverse proxy:** `http://<docker-host-ip>:8097`
- **Reverse proxy:** `https://jellyfin-tv.example.com`

To land on the profile picker every time you open the app, untick **Remember me** / **Sign in automatically** when you log in. Otherwise the app reopens as the last user, and you can switch from there with the button or the green key.

## Configuration

All settings are at the top of `inject/webos.js`. The file is served with `Cache-Control: no-store`, so changes take effect the next time the app loads a page. Restarting the app on the TV is enough.

| Setting | Default | What it does |
|---|---|---|
| `ALWAYS_PROMPT` | `['CHANGE_ME_ADMIN']` | Usernames that never get a blank-password attempt. Case-insensitive. |
| `DEBUG` | `false` | Shows a green status line at the bottom of the screen describing what the script is doing. Turn it on when something isn't working. |
| `GREEN_KEY` | `404` | Remote key code that opens the switcher (404 is the green button on LG remotes). |
| `SWITCH_ICON_SIZE` | `null` | Switch-button icon size in px. `null` matches the neighbouring header icons. |

The nginx config needs no changes for either setup. It passes on the scheme your reverse proxy reports, or uses plain HTTP when there isn't one.

The script targets the TV's browser engine (Chrome 79 on webOS 6), so if you edit it, avoid `?.`, `??` and flexbox `gap`.

## Security and privacy

Please read this before putting it on your network.

- **Passwordless users are your choice, not this project's.** The script only makes it more convenient to use accounts that already have no password. Anyone who can reach your Jellyfin login screen can already log in as those users.
- **Blank-password attempts count as failed logins** for users who do have a password. That's what `ALWAYS_PROMPT` is for, and why the script remembers each rejection and only tries once per user per TV.
- **No tokens are handled.** The script watches login requests only to read the HTTP status of its own blank-password attempt. It doesn't read responses, headers or stored credentials.
- **What is stored on the TV:** a list of usernames that need a password (`localStorage`, key `jfwebos.needsPassword`) and, for up to 30 seconds during a switch, the target username and server ID (`sessionStorage`). Clearing the Jellyfin app's data on the TV resets both.
- **The switcher lists users from `/Users/Public`**, the same unauthenticated list Jellyfin's own login screen uses. It doesn't reveal anything the login screen doesn't.
- **Without a reverse proxy, traffic is unencrypted HTTP,** the same as connecting to Jellyfin's own port 8096. That's normal on a home network, but don't forward port 8097 on your router.
- **Logs never include query strings.** Jellyfin puts `api_key=<token>` in some URLs, so nginx's access log records the path only, and its error log is set to `crit` because error lines include the full request. If you change the error log to `error` for debugging, set it back afterwards.
- **Hardened container:** read-only root filesystem, `no-new-privileges`, config mounted read-only.
- **Client IPs:** Jellyfin sees requests coming from this container. If you rely on Jellyfin knowing real client IPs (bitrate limits, IP-based rules, logs), add this container (and your reverse proxy, if you have one) to Dashboard → Networking → **Known proxies**.

## Troubleshooting

**Nothing changes on the TV.** Check the script is being added: open the switcher's address in a desktop browser, view the page source and look for `__webos-inject` near the end. Make sure the TV is using the switcher's address, not your normal Jellyfin one.

**Something half-works.** Set `DEBUG = true`, restart the app and watch the green status line. It says what the script tried and why it stopped.

**A passwordless user gets a password prompt.** On that TV, the user was probably once rejected and remembered as needing a password, for example while they still had one. Clear the Jellyfin app's data on the TV (or remove them from `jfwebos.needsPassword`).

**502 / Bad Gateway.** nginx can't reach Jellyfin. Check both containers share a network and the name in `set $jellyfin` matches your Jellyfin service.

**The TV can't connect at all (no reverse proxy).** Check the `ports:` line is `8097:80/tcp`, not the `127.0.0.1:` version, and that nothing on the host's firewall blocks port 8097.

**It broke after a Jellyfin update.** Most likely Jellyfin changed its login page. Please open an issue with your versions and the debug output.

## Tested with

| | Version |
|---|---|
| Jellyfin server | 10.x.x <!-- TODO: fill in --> |
| Jellyfin webOS app | x.x.x <!-- TODO: fill in --> |
| webOS | 6 (Chrome 79) |
| nginx | 1.30.6-alpine |

## Licence

[MIT](LICENSE). The switch icon is "swap_horiz" from Google's Material Icons (Apache 2.0).