const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { webcrypto, createPrivateKey, sign, verify, createPublicKey } = require('node:crypto');
const web3 = require('@solana/web3.js');
const source = readFileSync(require.resolve('../wallet.js'), 'utf8');

function setup() {
    const events = [], timers = new Map(); let timerId = 0;
    const window = { solanaWeb3: web3, confirm: () => true };
    const document = { modalVisible: true, getElementById() { return {classList:{contains: () => document.modalVisible}}; }, dispatchEvent(event) { events.push(event); } };
    const context = vm.createContext({ window, document, console: { log() {}, error() {} }, TextEncoder, TextDecoder, Uint8Array, URL, URLSearchParams, atob, btoa,
        setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); },
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    });
    const Client = vm.runInContext(source.slice(source.indexOf('class CryptoClient {')) + '\nCryptoClient', context);
    Client.signWithKeypair = async (message, pair) => {
        const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(pair.secretKey.slice(0, 32))]), type: 'pkcs8', format: 'der' });
        return new Uint8Array(sign(null, message, key));
    };
    const seed = webcrypto.getRandomValues(new Uint8Array(32)), pair = web3.Keypair.fromSeed(seed);
    const authenticated = { token: 't'.repeat(43), expiresAt: Date.now() + 900000, identity: { provider: 'google' } };
    const client = Object.create(Client.prototype);
    client.state = { isConnected: false, isConnecting: false, activeWallet: null, walletAddress: null };
    client.config = { appName: 'Test app' };
    client.socialAuth = { session: null, cancel() {}, async signOut() { this.session = null; }, async signIn() { this.session = authenticated; return authenticated; },
        async recoverWallet() { return { publicKey: pair.publicKey.toBase58(), seed: Buffer.from(seed).toString('base64url') }; } };
    client.solanaWeb3Ready = Promise.resolve();
    for (const method of ['showOverlay', 'hideOverlay', 'updateStatus', 'resetHeaderButton', 'updateHeaderButton', 'setLastUsedWallet']) client[method] = () => {};
    return { client, Client, pair, events, timers, window, document };
}

test('social connect creates a real signer; messages and legacy/versioned transactions verify', async () => {
    const s = setup();
    await s.client.connectWallet('google');
    assert.equal(s.client.state.isConnected, true);
    assert.equal(s.client.state.walletAddress, s.pair.publicKey.toBase58());
    const provider = s.client.getProvider();
    const message = new TextEncoder().encode('ProofNetwork challenge');
    const signed = await provider.signMessage(message);
    const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), s.pair.publicKey.toBuffer()]), format: 'der', type: 'spki' });
    assert.equal(verify(null, message, publicKey, signed.signature), true);
    const instruction = web3.SystemProgram.transfer({ fromPubkey: s.pair.publicKey, toPubkey: web3.Keypair.generate().publicKey, lamports: 1 });
    const tx = new web3.Transaction({ feePayer: s.pair.publicKey, recentBlockhash: web3.Keypair.generate().publicKey.toBase58() }).add(instruction);
    await provider.signTransaction(tx);
    assert.equal(tx.verifySignatures(), true);
    const vtx = new web3.VersionedTransaction(new web3.TransactionMessage({ payerKey: s.pair.publicKey, recentBlockhash: tx.recentBlockhash, instructions: [instruction] }).compileToV0Message());
    await provider.signTransaction(vtx);
    assert.equal(verify(null, vtx.message.serialize(), publicKey, vtx.signatures[0]), true);
    s.window.confirm = () => false;
    await assert.rejects(provider.signMessage(message), /User rejected/);
    await assert.rejects(provider.signTransaction(tx), /User rejected/);
    s.client.disconnect();
    assert.equal(s.client._socialSigner, null);
    assert.equal(s.client.getProvider(), null);
    await assert.rejects(provider.signMessage(message), /expired/);
    for (const fn of [...s.timers.values()]) fn();
    assert.equal(s.events.filter(e => e.type === 'walletConnected').length, 0, 'delayed success does not reconnect after disconnect');
});

test('disconnect during recovery rejects late completion; address mismatch never connects', async () => {
    const s = setup(); let complete;
    s.client.socialAuth.recoverWallet = () => new Promise(resolve => { complete = resolve; });
    const pending = s.client.connectWallet('google');
    await new Promise(setImmediate);
    assert.equal(typeof complete, 'function');
    s.client.disconnect(); complete({ publicKey: s.pair.publicKey.toBase58(), seed: 'a'.repeat(43) });
    await pending;
    assert.equal(s.client.state.isConnected, false); assert.equal(s.client._socialSigner, null);
    const mismatch = setup();
    mismatch.client.socialAuth.recoverWallet = async () => ({ publicKey: 'wrong', seed: 'a'.repeat(43) });
    await mismatch.client.connectWallet('google');
    assert.equal(mismatch.client.state.isConnected, false); assert.equal(mismatch.client._socialSigner, null);
});

test('expiry and verification failure cannot leave a usable signer', async () => {
    const s = setup();
    await s.client.connectWallet('google');
    const provider = s.client.getProvider();
    s.client.socialAuth.session = null;
    await assert.rejects(provider.signMessage(new Uint8Array()), /expired/);
    for (const fn of [...s.timers.values()]) fn();
    assert.equal(s.client.state.isConnected, false); assert.equal(s.client._socialSigner, null);
    const failed = setup(); failed.client.config.onVerify = async () => { throw new Error('verification failed'); };
    await failed.client.connectWallet('google');
    assert.equal(failed.client.state.isConnected, false); assert.equal(failed.client._socialSigner, null);
});


test('using a burner keeps social session but clears signer and returns to main wallet UI', async () => {
    const s = setup(); let shown = 0, hidden = 0;
    await s.client.connectWallet('google');
    const session = s.client.socialAuth.session;
    s.client.showOverlay = () => { shown++; };
    s.client.hideOverlay = () => { hidden++; };
    s.Client.getActiveBurnerId = () => 'burner-one';
    s.Client.getBurnerWallets = () => [{id:'burner-one',name:'Burner',publicKey:'burner-address'}];
    await s.client.connectWallet('burner');
    assert.equal(s.client._socialSigner, null);
    assert.equal(s.client.socialAuth.session, session);
    for (const fn of [...s.timers.values()]) fn();
    assert.equal(shown, 1);
    assert.equal(hidden, 0);
    assert.equal(s.client.state.walletAddress, 'burner-address');
    assert.equal(s.events.filter(e => e.type === 'walletConnected').at(-1).detail.wallet, 'burner');
    s.client.disconnect();
    assert.equal(s.client.socialAuth.session, null);
});

test('silent burner selection and closing during connection never open the wallet manager', async () => {
    const s = setup(); let shown = 0;
    s.client.showOverlay = () => { shown++; };
    s.client.state.walletAddress = 'burner';
    s.client.onConnectSuccess('burner', 'burner');
    s.document.modalVisible = false;
    for (const fn of [...s.timers.values()]) fn();
    assert.equal(shown, 0);
    assert.equal(s.client.state.isConnected, true);
});
