// jellyfin-webos-switcher: inject/webos.js  (MIT licence)
//
// 1. Passwordless tile login.
// 2. User switcher (passwordless users, plus "Sign out" to reach the login screen).
//
// Tile login: Jellyfin's own click handler runs as normal. It fills in the
// username and shows the password form. Straight after that, this script
// submits that same form with an empty password, so Jellyfin's own login code
// does the authenticating. If anything on the page isn't where it expects,
// it does nothing and you get Jellyfin's normal prompt.
//
// Switcher: signs out through Jellyfin's own sign-out, then picks the chosen
// user's tile on the login screen, which hands over to the tile login above.
//
// This script never calls the auth API itself and never sees or stores a token.
//
// Engine: Chrome 79 (webOS 6). Don't use ?. or ?? or flexbox gap.
(function () {
    'use strict';
    if (window.__jfWebos) { return; }
    window.__jfWebos = { version: '1.0.0' };

    // ---------------------------------------------------------------- config
    // Usernames that never get a blank-password attempt (case-insensitive).
    // Put your admin here, so a blank attempt can never count towards its
    // lockout limit. Example: ['admin', 'dad'].
    var ALWAYS_PROMPT = ['CHANGE_ME_ADMIN'];

    // Status line at the bottom of the screen. Set to false once tested.
    var DEBUG = false;

    // ----------------------------------------------------------------- state
    // List of usernames whose blank password was rejected. No tokens.
    var STORE_KEY = 'jfwebos.needsPassword';
    var AUTH_PATH = /\/users\/authenticatebyname/i;
    var pending = null; // { name: '...' } while our blank attempt is in flight

    function log(msg) {
        if (window.console) { console.log('[jf-webos] ' + msg); }
        if (!DEBUG || !document.body) { return; }
        var el = document.getElementById('jf-webos-debug');
        if (!el) {
            el = document.createElement('div');
            el.id = 'jf-webos-debug';
            el.style.cssText = [
                'position:fixed', 'left:0', 'right:0', 'bottom:0',
                'z-index:2147483647', 'background:rgba(0,0,0,.85)',
                'color:#7CFC00', 'font:16px/1.3 monospace',
                'padding:6px 12px', 'pointer-events:none'
            ].join(';');
            document.body.appendChild(el);
        }
        el.textContent = new Date().toLocaleTimeString() + '  ' + msg;
    }

    function readStore() {
        try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]') || []; }
        catch (e) { return []; }
    }

    function markNeedsPassword(name) {
        var list = readStore();
        var n = name.toLowerCase();
        if (list.indexOf(n) === -1) { list.push(n); }
        try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); } catch (e) {}
    }

    function needsPassword(name) {
        var n = name.toLowerCase();
        for (var i = 0; i < ALWAYS_PROMPT.length; i++) {
            if (ALWAYS_PROMPT[i].toLowerCase() === n) { return true; }
        }
        return readStore().indexOf(n) !== -1;
    }

    // ------------------------------------------- watch the login result only
    // Matches only our own attempt: right username, empty password.
    function isOurAttempt(body) {
        if (!pending || typeof body !== 'string') { return false; }
        try {
            var d = JSON.parse(body);
            return d && d.Pw === '' &&
                String(d.Username).toLowerCase() === pending.name.toLowerCase();
        } catch (e) { return false; }
    }

    function onAuthResult(status) {
        if (!pending) { return; }
        var name = pending.name;
        pending = null;
        if (status === 401) {
            markNeedsPassword(name);
            log('blank password rejected for "' + name + '" - will prompt from now on');
            hideCover();
        } else if (status >= 200 && status < 300) {
            log('blank password accepted for "' + name + '"');
            waitHome = true;                 // loading screen goes once home has rendered
        } else {
            log('login for "' + name + '" returned ' + status + ' - not remembered');
            hideCover();
        }
    }

    // XHR: always hooked (it also covers a fetch polyfill, which is built on XHR).
    var xhrOpen = XMLHttpRequest.prototype.open;
    var xhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
        this.__jfAuth = AUTH_PATH.test(String(url));
        return xhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
        if (this.__jfAuth && isOurAttempt(body)) {
            var xhr = this;
            xhr.addEventListener('loadend', function () { onAuthResult(xhr.status); });
        }
        return xhrSend.apply(this, arguments);
    };

    // fetch: hooked only if native. We never define it, so a polyfill still installs.
    if (typeof window.fetch === 'function') {
        var nativeFetch = window.fetch;
        window.fetch = function (input, init) {
            var url = typeof input === 'string' ? input : (input && input.url) || '';
            var p = nativeFetch.apply(window, arguments);
            if (AUTH_PATH.test(url) && isOurAttempt(init && init.body)) {
                p.then(function (r) { onAuthResult(r.status); },
                       function () { onAuthResult(0); });
            }
            return p;
        };
    }

    // ------------------------------------------------------------ the login page
    function attr(el, name) {
        return el && el.getAttribute ? el.getAttribute(name) : null;
    }

    function visible(el) {
        return !!el && (el.offsetWidth > 0 || el.offsetHeight > 0);
    }

    // Walk up from the click target to the element carrying data-username.
    // Some versions put it on a child of the .card rather than on an ancestor.
    function findTile(el) {
        while (el && el !== document) {
            if (attr(el, 'data-username') !== null) { return el; }
            if (el.classList && el.classList.contains('card')) {
                return el.querySelector('[data-username]');
            }
            el = el.parentNode;
        }
        return null;
    }

    function passwordInput() {
        return document.querySelector('#txtManualPassword') ||
            document.querySelector('.manualLoginForm input[type="password"]');
    }

    function submitBlank(name) {
        var pw = passwordInput();
        var form = pw && pw.form;
        var user = form && (form.querySelector('#txtManualName') ||
            form.querySelector('input[type="text"]'));
        var btn = form && form.querySelector('button[type="submit"]');

        // Jellyfin didn't show the form (e.g. it logged in by itself): don't double-submit.
        if (!form || !visible(form)) { log('"' + name + '": form not shown - leaving it to Jellyfin'); hideCover(); return; }
        if (!user || String(user.value).toLowerCase() !== name.toLowerCase()) {
            log('"' + name + '": username field not filled as expected - not submitting');
            hideCover();
            return;
        }
        if (!btn) { log('"' + name + '": no submit button found - not submitting'); hideCover(); return; }

        pw.value = '';
        pending = { name: name };
        log('trying blank password for "' + name + '"');
        btn.click();
    }

    // Capture phase, so this runs before Jellyfin's handler. Propagation isn't
    // stopped: Jellyfin's handler always runs normally.
    document.addEventListener('click', function (e) {
        var tile = findTile(e.target);
        if (!tile) { return; }
        var name = attr(tile, 'data-username');
        var id = attr(tile, 'data-userid');
        if (!name || id === 'manual') { return; }
        if (!passwordInput()) {
            log('tile "' + name + '" clicked but no login form on page - ignoring');
            return;
        }
        pending = null;
        if (needsPassword(name)) {
            log('"' + name + '" needs a password - normal prompt');
            hideCover();
            return;
        }
        // Keep "Switching to ..." if a switch is already showing the loading screen
        showCover(cover ? cover.querySelector('.jfw-cover-text').textContent : 'Signing in as ' + name);
        // Run after Jellyfin's own handler has filled in the form.
        setTimeout(function () { submitBlank(name); }, 0);
    }, true);

    // ===================================================== the user switcher
    // The pending switch lives in sessionStorage: it's only a username, and it
    // expires after 30 seconds.
    var SWITCH_KEY = 'jfwebos.switchTo';
    var SWITCH_TTL = 30000;
    var GREEN_KEY = 404; // LG remote's green button, if your remote has one
    // Switch-button icon size in px. null = match the user icon next to it.
    var SWITCH_ICON_SIZE = null;

    // "swap_horiz" icon (Material Icons, Apache 2.0)
    var ICON = '<svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true" ' +
        'style="fill:currentColor;vertical-align:middle;display:block"><path d="M6.99 11L3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z"/></svg>';

    function getSwitch() {
        try {
            var s = JSON.parse(sessionStorage.getItem(SWITCH_KEY) || 'null');
            if (s && Date.now() - s.at < SWITCH_TTL) { return s; }
        } catch (e) {}
        clearSwitch();
        return null;
    }
    // name: user to select on the login screen, or null for "Sign out".
    // serverId: lets us skip the webOS app's server-selection screen.
    function setSwitch(s) {
        try { sessionStorage.setItem(SWITCH_KEY, JSON.stringify(s)); } catch (e) {}
    }
    function clearSwitch() {
        try { sessionStorage.removeItem(SWITCH_KEY); } catch (e) {}
    }

    function currentUserId() {
        try {
            return window.ApiClient && window.ApiClient.getCurrentUserId ?
                window.ApiClient.getCurrentUserId() : null;
        } catch (e) { return null; }
    }

    function currentServerId() {
        try {
            var a = window.ApiClient;
            if (!a) { return null; }
            if (typeof a.serverId === 'function') { return a.serverId(); }
            if (typeof a.serverInfo === 'function') { var i = a.serverInfo(); return i && i.Id; }
        } catch (e) {}
        return null;
    }

    // Same list the login screen shows: no auth needed, and hidden users
    // (your admin) aren't in it.
    function loadUsers() {
        return fetch('/Users/Public', { credentials: 'same-origin' }).then(function (r) {
            if (!r.ok) { throw new Error('HTTP ' + r.status); }
            return r.json();
        });
    }

    // Precache: the user list and avatars are fetched once after sign-in and
    // kept in memory, so the switcher opens instantly. Each avatar is a loaded
    // <img> that gets reused, so it's never fetched or decoded again. The
    // cache key includes the image tag, so a changed avatar is picked up.
    var userCache = null;
    var imgCache = {};

    function avatarUrl(u) {
        return '/Users/' + encodeURIComponent(u.Id) + '/Images/Primary?tag=' +
            encodeURIComponent(u.PrimaryImageTag) + '&height=120&quality=90';
    }

    function avatarImg(u) {
        var key = u.Id + ':' + u.PrimaryImageTag;
        if (!imgCache[key]) {
            var img = new Image();
            img.alt = '';
            img.src = avatarUrl(u);
            imgCache[key] = img;
        }
        return imgCache[key];
    }

    function refreshUsers() {
        return loadUsers().then(function (users) {
            userCache = users || [];
            for (var i = 0; i < userCache.length; i++) {
                if (userCache[i].PrimaryImageTag) { avatarImg(userCache[i]); }
            }
            return userCache;
        });
    }

    function waitFor(test, timeout, done) {
        var start = Date.now();
        var t = setInterval(function () {
            var v = test();
            if (v || Date.now() - start > timeout) { clearInterval(t); done(v || null); }
        }, 200);
    }

    // Sign out through Jellyfin's own code. Try its global first, then its own
    // Sign Out button on the preferences menu.
    function signOut() {
        if (window.Dashboard && typeof window.Dashboard.logout === 'function') {
            log('signing out via Dashboard.logout');
            window.Dashboard.logout();
            return;
        }
        location.hash = '#/mypreferencesmenu';
        waitFor(function () {
            var b = document.querySelector('.btnLogout');
            return visible(b) ? b : null;
        }, 5000, function (b) {
            if (b) { log('signing out via preferences menu'); b.click(); }
            else { clearSwitch(); hideCover(); log('could not find a way to sign out - switch cancelled'); }
        });
    }

    function switchTo(name) {
        closeSwitcher();
        setSwitch({ name: name, serverId: currentServerId(), at: Date.now() });
        showCover(name ? 'Switching to ' + name : 'Signing out');
        interceptServerPicker();
        if (name) { log('switching to "' + name + '" - signing out first'); }
        else { log('signing out'); }
        signOut();
    }

    // After sign-out, jellyfin-web asks the webOS app shell (window.NativeShell)
    // to show the app's own server picker - the "Connect" screen, which this
    // script can't reach. While a switch is pending, go to the login page
    // instead. Otherwise (e.g. "Change Server") the app's picker shows as normal.
    function interceptServerPicker() {
        var ns = window.NativeShell;
        if (!ns) { log('no NativeShell found'); return; }
        if (DEBUG) {
            var keys = [];
            for (var k in ns) { keys.push(k); }
            if (window.console) { console.log('[jf-webos] NativeShell: ' + keys.join(', ')); }
        }
        if (typeof ns.selectServer !== 'function' || ns.selectServer.__jfWebos) { return; }
        var original = ns.selectServer;
        var wrapped = function () {
            var s = getSwitch();
            if (s && s.serverId && !s.skipped) {
                log('skipping the webOS server picker');
                setTimeout(function () { goToLogin(s); }, 0);
                return;
            }
            return original.apply(this, arguments);
        };
        wrapped.__jfWebos = true;
        ns.selectServer = wrapped;
    }

    // After sign-out the webOS app shows server selection. Do what its Connect
    // button does instead: open the login page for this server.
    function goToLogin(s) {
        s.skipped = true;
        setSwitch(s);
        if (!s.serverId) { log('server id unknown - pick your server to continue'); hideCover(); return; }
        var path = 'login?serverid=' + encodeURIComponent(s.serverId);
        log('skipping server selection');
        if (window.Dashboard && typeof window.Dashboard.navigate === 'function') {
            window.Dashboard.navigate(path);
        } else {
            location.hash = '#/' + path;
        }
    }

    // Runs every 500 ms while a switch is pending: skip server selection, then
    // select the user's tile. The tile login above does the rest.
    function checkPendingSwitch() {
        var s = getSwitch();
        if (!s) { return; }
        var where = location.hash || location.pathname;
        if (!s.warned && Date.now() - s.at > 6000) {
            s.warned = true;
            setSwitch(s);
            log('switch still pending, now at "' + where + '"');
        }
        if (/selectserver/i.test(where)) {
            if (!s.skipped) { goToLogin(s); }
            return;
        }
        if (!s.name) {                       // "Sign out": done once we're on the login page
            if (/login/i.test(where)) { clearSwitch(); hideCover(); log('signed out'); }
            return;
        }
        if (!passwordInput()) { return; }
        var tiles = document.querySelectorAll('[data-username]');
        for (var i = 0; i < tiles.length; i++) {
            if (String(attr(tiles[i], 'data-username')).toLowerCase() === s.name.toLowerCase() &&
                visible(tiles[i])) {
                clearSwitch();
                log('selecting "' + s.name + '" on the login screen');
                tiles[i].click();
                return;
            }
        }
    }

    // ---- overlay
    var overlay = null;
    var lastFocus = null;

    function addStyles() {
        if (document.getElementById('jf-webos-style')) { return; }
        var st = document.createElement('style');
        st.id = 'jf-webos-style';
        st.textContent = [
            '#jf-webos-switcher{position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483646;',
            'background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center}',
            '#jf-webos-switcher .jfw-panel{background:#202020;color:#fff;border-radius:12px;',
            'padding:32px 40px;min-width:520px;max-height:85vh;overflow:auto}',
            '#jf-webos-switcher .jfw-title{font-size:34px;margin:0 0 20px}',
            '#jf-webos-switcher button{display:flex;align-items:center;width:100%;margin:10px 0;',
            'padding:12px 20px;font:inherit;font-size:28px;color:#fff;background:#333;',
            'border:3px solid transparent;border-radius:8px;text-align:left;cursor:pointer}',
            '#jf-webos-switcher button:focus{border-color:#00a4dc;background:#404040;outline:none}',
            '#jf-webos-switcher .jfw-avatar{width:60px;height:60px;margin-right:20px;flex:none;',
            'border-radius:50%;background:#00a4dc;overflow:hidden;display:flex;',
            'align-items:center;justify-content:center;font-size:30px}',
            '#jf-webos-switcher .jfw-avatar img{width:100%;height:100%;object-fit:cover;display:block}',
            '#jf-webos-switcher .jfw-plain{padding-left:20px}',
            '#jf-webos-cover{position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483645;',
            'background:#101010;color:#fff;display:flex;flex-direction:column;',
            'align-items:center;justify-content:center;font-size:32px}',
            '#jf-webos-cover .jfw-spin{width:72px;height:72px;margin-bottom:28px;',
            'border:6px solid rgba(255,255,255,.2);border-top-color:#00a4dc;border-radius:50%;',
            'animation:jfwspin 1s linear infinite}',
            '@keyframes jfwspin{to{transform:rotate(360deg)}}'
        ].join('');
        document.head.appendChild(st);
    }

    function makeButton(label, onClick, avatar) {
        var b = document.createElement('button');
        b.type = 'button';
        if (avatar) { b.appendChild(avatar); } else { b.className = 'jfw-plain'; }
        var span = document.createElement('span');
        span.textContent = label;
        b.appendChild(span);
        b.addEventListener('click', onClick);
        return b;
    }

    function userButton(u) {
        var av = document.createElement('span');
        av.className = 'jfw-avatar';
        if (u.PrimaryImageTag) {
            av.appendChild(avatarImg(u));    // the cached element, moved into this menu
        } else {
            av.textContent = String(u.Name || '?').charAt(0).toUpperCase();
        }
        return makeButton(u.Name, function () { switchTo(u.Name); }, av);
    }

    function focusIndex(i) {
        var btns = overlay && overlay.querySelectorAll('button');
        if (btns && btns[i]) { btns[i].focus(); }
    }

    function fillList(list, users) {
        list.textContent = '';
        var me = currentUserId();
        for (var i = 0; i < users.length; i++) {
            if (users[i].Id !== me) { list.appendChild(userButton(users[i])); }
        }
        list.appendChild(makeButton('Sign out', function () { switchTo(null); }));
        focusIndex(0);                       // Back closes the menu
    }

    function openSwitcher() {
        if (overlay) { return; }
        addStyles();
        lastFocus = document.activeElement;
        overlay = document.createElement('div');
        overlay.id = 'jf-webos-switcher';
        var panel = document.createElement('div');
        panel.className = 'jfw-panel';
        var title = document.createElement('div');
        title.className = 'jfw-title';
        title.textContent = 'Switch user';
        var list = document.createElement('div');
        panel.appendChild(title);
        panel.appendChild(list);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        if (userCache) {                     // precached at sign-in: instant, no fetch
            fillList(list, userCache);
            return;
        }
        list.textContent = 'Loading';
        refreshUsers().then(function (users) {
            if (overlay) { fillList(list, users); }
        }, function (err) {
            log('could not load users: ' + err.message);
            if (overlay) { fillList(list, []); }
        });
    }

    function closeSwitcher() {
        if (!overlay) { return; }
        overlay.parentNode.removeChild(overlay);
        overlay = null;
        if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
    }

    // Registered before Jellyfin's scripts run, so this sees remote keys first
    // while the overlay is open. Jellyfin's own navigation doesn't move focus
    // behind it.
    window.addEventListener('keydown', function (e) {
        var k = e.keyCode;
        if (!overlay) {
            if (k === GREEN_KEY && loggedIn()) {
                e.preventDefault();
                e.stopImmediatePropagation();
                openSwitcher();
            }
            return;
        }
        var btns = overlay.querySelectorAll('button');
        var i = Array.prototype.indexOf.call(btns, document.activeElement);
        if (k === 38 || k === 37) { focusIndex(Math.max(0, i - 1)); }            // up / left
        else if (k === 40 || k === 39) { focusIndex(Math.min(btns.length - 1, i + 1)); } // down / right
        else if (k === 13) { if (i !== -1) { btns[i].click(); } }               // OK
        else if (k === 461 || k === 27 || k === 8) { closeSwitcher(); }         // Back / Esc
        else { return; }
        e.preventDefault();
        e.stopImmediatePropagation();
    }, true);

    // ---- header button (shown only while signed in)
    function loggedIn() {
        return visible(document.querySelector('.headerUserButton'));
    }

    var headerWarned = false;
    function ensureHeaderButton() {
        var right = document.querySelector('.headerRight');
        var userBtn = right && right.querySelector('.headerUserButton');
        var mine = document.getElementById('jf-webos-switch-btn');
        if (right && !userBtn && !headerWarned) {
            headerWarned = true;
            log('header found but no .headerUserButton - switch button not added');
        }
        if (!visible(userBtn)) {
            if (mine && mine.parentNode) { mine.parentNode.removeChild(mine); }
            return;
        }
        if (mine && mine.parentNode === right) { sizeIcon(mine, userBtn); return; }
        mine = document.createElement('button');
        mine.id = 'jf-webos-switch-btn';
        mine.type = 'button';
        mine.title = 'Switch user';
        // Borrow Jellyfin's header-button styling so it looks and focuses like its neighbours
        mine.className = userBtn.className.replace(/\bheaderUserButton\b/g, '').trim();
        mine.innerHTML = ICON;
        mine.addEventListener('click', openSwitcher);
        right.insertBefore(mine, userBtn);
        sizeIcon(mine, userBtn);
        log('switch-user button added to header');
        // Signed in: precache the user list and avatars for the switcher
        refreshUsers().catch(function (err) { log('could not precache users: ' + err.message); });
    }

    // Match the largest icon among the header's own buttons (search, cast,
    // user...). Fall back to 70% of the user button's height.
    function sizeIcon(mine, userBtn) {
        var svg = mine.querySelector('svg');
        if (!svg) { return; }
        var px = SWITCH_ICON_SIZE;
        if (!px) {
            var icons = userBtn.parentNode.querySelectorAll('.material-icons, [class*="material-icons"], img, svg');
            for (var i = 0; i < icons.length; i++) {
                if (mine.contains(icons[i])) { continue; }
                if (icons[i].offsetHeight > px) { px = icons[i].offsetHeight; }
            }
            if (!px) { px = Math.round(userBtn.offsetHeight * 0.7); }
        }
        if (!px || px < 16) { return; }
        if (svg.getAttribute('width') !== String(px)) {
            svg.setAttribute('width', px);
            svg.setAttribute('height', px);
            log('switch icon sized to ' + px + 'px');
        }
    }

    // ---- loading screen
    // Covers the page flicking between sign-out, login and home during a
    // switch or tile login. Only explicit outcomes take it down (home loaded,
    // failure, manual sign-in ready); the 20 s timeout is a safety net.
    var cover = null;
    var coverTimer = null;
    var waitHome = false;

    function showCover(text) {
        addStyles();
        if (!cover) {
            cover = document.createElement('div');
            cover.id = 'jf-webos-cover';
            var spin = document.createElement('div');
            spin.className = 'jfw-spin';
            var label = document.createElement('div');
            label.className = 'jfw-cover-text';
            cover.appendChild(spin);
            cover.appendChild(label);
            document.body.appendChild(cover);
            if (document.activeElement && document.activeElement.blur) {
                try { document.activeElement.blur(); } catch (e) {}
            }
        }
        cover.querySelector('.jfw-cover-text').textContent = text;
        clearTimeout(coverTimer);
        coverTimer = setTimeout(function () { log('loading screen timed out'); hideCover(); }, 20000);
    }

    function hideCover() {
        clearTimeout(coverTimer);
        waitHome = false;
        if (cover && cover.parentNode) { cover.parentNode.removeChild(cover); }
        cover = null;
    }

    // While the loading screen is up, nothing behind it may take focus. On
    // webOS, a focused text field brings up the on-screen keyboard.
    document.addEventListener('focusin', function (e) {
        var t = e.target;
        if (cover && t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) {
            try { t.blur(); } catch (err) {}
        }
    }, true);

    setInterval(function () {
        ensureHeaderButton();
        if (getSwitch() && !cover) { showCover('Switching user'); }  // e.g. after a page reload
        checkPendingSwitch();
        if (waitHome && loggedIn()) {
            waitHome = false;
            setTimeout(hideCover, 400);      // let the home screen paint first
        }
    }, 500);

    function ready() { log('webos.js ' + window.__jfWebos.version + ' loaded | ' + navigator.userAgent); }
    if (document.body) { ready(); }
    else { document.addEventListener('DOMContentLoaded', ready); }
})();