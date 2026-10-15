const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const walletSource = readFileSync(require.resolve('../wallet.js'), 'utf8');
const source = walletSource.slice(walletSource.indexOf('class ProofWalletSocialAuth {'), walletSource.indexOf('class CryptoClient {'));
function setup({ blocked = false, configured = true, storage = new Map() } = {}) {
    const listeners = new Set(), calls = [], popups = [];
    const window = {
        location: { origin: 'https://proofnetwork.lol' },
        sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
        open() {
            if (blocked) return null;
            const popup = { closed: false, url: '', location: { replace(url) { popup.url = url; } }, close() { popup.closed = true; } };
            popups.push(popup); return popup;
        },
        addEventListener(type, fn) { listeners.add(fn); },
        removeEventListener(type, fn) { listeners.delete(fn); },
    };
    const context = vm.createContext({ window, URL, URLSearchParams, crypto: webcrypto, TextEncoder, Uint8Array, AbortController, AbortSignal, btoa, setInterval, clearInterval, setTimeout, clearTimeout,
        async fetch(url, options) {
            calls.push({ url, options });
            if (url.endsWith('/providers')) return Response.json({ google: configured, x: configured });
            if (url.endsWith('/result')) return Response.json({ status: 'authenticated', token: (new URL(popups.at(-1).url).searchParams.get('provider') === 'x' ? 'b' : 'a').repeat(43), expiresAt: Date.now() + 60000, identity: { id: 'identity', provider: new URL(popups.at(-1).url).searchParams.get('provider'), name: 'Test' } });
            return Response.json({ success: true });
        },
    });
    const Auth = vm.runInContext(source + '\nProofWalletSocialAuth', context);
    const auth = new Auth();
    async function ready() {
        for (let i = 0; i < 100 && !popups.at(-1)?.url; i++) await new Promise(r => setTimeout(r, 5));
        assert.ok(popups.at(-1)?.url, 'popup navigated');
        return new URL(popups.at(-1).url);
    }
    async function message(data, origin = auth.endpoint, source = popups.at(-1)) {
        await Promise.all([...listeners].map(fn => fn({ data, origin, source })));
    }
    return { auth, Auth, calls, popups, ready, message, listeners, storage, window };
}

test('popup completion binds source, origin, request ID and PKCE; logout clears memory', async () => {
    const s = setup(), pending = s.auth.signIn('google');
    assert.equal(s.popups.length, 1, 'popup opened synchronously');
    const url = await s.ready();
    const data = { type: 'proofwallet:oauth-result', requestId: url.searchParams.get('request_id'), receipt: 'r'.repeat(43) };
    await s.message(data, 'https://evil.test');
    await s.message(data, s.auth.endpoint, {});
    await s.message({ ...data, requestId: 'wrong' });
    assert.equal(s.calls.filter(c => c.url.endsWith('/result')).length, 0);
    await s.message(data);
    const result = await pending;
    assert.equal(result.identity.provider, 'google');
    assert.equal(s.listeners.size, 0);
    assert.equal(s.popups[0].closed, true);
    const redemption = s.calls.find(c => c.url.endsWith('/result'));
    const body = JSON.parse(redemption.options.body);
    const digest = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(body.verifier))).toString('base64url');
    assert.equal(digest, url.searchParams.get('challenge'));
    assert.equal(redemption.options.credentials, 'omit');
    result.identity.name = 'changed';
    assert.equal(s.auth.session.identity.name, 'Test');
    await s.auth.signOut();
    assert.equal(s.auth.session, null);
    assert.equal(s.calls.at(-1).options.method, 'DELETE');
});

test('blocked popup, disabled transport/provider and insecure endpoints reject', async () => {
    const s = setup({ blocked: true });
    await assert.rejects(s.auth.signIn('google'), /popup_blocked/);
    await assert.rejects(s.auth.signIn('evil'), /invalid_provider/);
    await assert.rejects(new s.Auth(false).signIn('google'), /disabled/);
    assert.throws(() => new s.Auth({ endpoint: 'http://example.com' }), /HTTPS/);
    assert.throws(() => new s.Auth({ endpoint: 'https://example.com/path' }), /HTTPS/);
    const disabled = setup({ configured: false });
    await assert.rejects(disabled.auth.signIn('google'), /provider_not_configured/);
    assert.equal(disabled.popups[0].closed, true);
    assert.equal(disabled.listeners.size, 0);
});

test('explicit cancel clears listeners; COOP closed flag does not cancel authentication', async () => {
    const s = setup(), pending = s.auth.signIn('google');
    const rejected = assert.rejects(pending, /cancelled/);
    s.auth.cancel();
    await rejected;
    assert.equal(s.listeners.size, 0);
    assert.equal(s.auth.session, null);
    const next = s.auth.signIn('google');
    const url = await s.ready();
    s.popups.at(-1).closed = true;
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(s.listeners.size, 1);
    await s.message({ type: 'proofwallet:oauth-result', requestId: url.searchParams.get('request_id'), receipt: 'r'.repeat(43) });
    assert.equal((await next).identity.provider, 'google');
    assert.equal(s.listeners.size, 0);
});

test('new sign-in cancels previous attempt; expired sessions disappear', async () => {
    const s = setup(), first = s.auth.signIn('google');
    const rejected = assert.rejects(first, /cancelled/);
    const second = s.auth.signIn('google');
    const cancelled = assert.rejects(second, /cancelled/);
    await rejected;
    s.auth.cancel();
    await cancelled;
    s.auth._session = { expiresAt: 1, identity: {} };
    assert.equal(s.auth.session, null);
});

async function login(s, provider = 'google') {
    const pending = s.auth.signIn(provider);
    const url = await s.ready();
    await s.message({type: 'proofwallet:oauth-result', requestId: url.searchParams.get('request_id'), receipt: 'r'.repeat(43)});
    return pending;
}

test('tab-local sessions resume without popup, keep providers separate, and revoke on explicit logout', async () => {
    const s = setup();
    const google = await login(s);
    const x = await login(s, 'x');
    assert.equal(s.storage.size, 2);
    assert.equal(s.calls.filter(c => c.options.method === 'DELETE').length, 0, 'switching providers does not revoke the other');
    const reloaded = new s.Auth();
    assert.equal((await reloaded.signIn('google')).token, google.token);
    assert.equal((await reloaded.signIn('x')).token, x.token);
    assert.equal(s.popups.length, 2, 'resumption creates no popup');
    assert.ok([...s.storage.values()].every(value => !/seed|privateKey|access_token/.test(value)));
    await reloaded.signOut();
    assert.equal(s.storage.size, 0);
    assert.equal(s.calls.filter(c => c.options.method === 'DELETE').length, 2);
    assert.equal(reloaded.session, null);
});

test('expired or malformed cached sessions are removed and start a new provider flow', async () => {
    const s = setup();
    s.storage.set(s.auth._storageKey('google'), JSON.stringify({token:'a'.repeat(43),expiresAt:Date.now()-1,identity:{id:'old',provider:'google'}}));
    const pending = s.auth.signIn('google');
    const cancelled = assert.rejects(pending, /cancelled/);
    await s.ready();
    assert.equal(s.storage.size, 0);
    s.auth.cancel(); await cancelled;
    s.storage.set(s.auth._storageKey('x'), '{broken json');
    assert.equal(s.auth._cached('x'), null);
    assert.equal(s.storage.size, 0);
});

test('fresh linking transport ignores cached sessions and leaves normal cache intact', async () => {
    const s = setup(); await login(s);
    const target = new s.Auth({rememberSession:false});
    const pending = target.signIn('google');
    const cancelled = assert.rejects(pending, /cancelled/);
    await s.ready();
    assert.equal(s.popups.length, 2);
    target.cancel();await cancelled;await target.signOut();
    assert.equal(s.storage.size, 1);
});

test('storage unavailable falls back to in-memory sessions', async () => {
    const s = setup();
    Object.defineProperty(s.window,'sessionStorage',{get(){throw new Error('storage blocked')}});
    const logged = await login(s);
    assert.equal((await s.auth.signIn('google')).token, logged.token);
    assert.equal(s.popups.length, 1);
    await s.auth.signOut();assert.equal(s.auth.session, null);
});
