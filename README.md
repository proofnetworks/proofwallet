# proofwallet

> **The frontend SDK for [ProofNetwork](https://proofnetwork.lol).** One drop-in class (`CryptoClient`) that handles Solana wallet connect (Phantom / Solflare / Backpack / Jupiter / burner), message signing, transaction sending, and — most importantly — calling ProofNetwork smart contracts with the platform's signed-write challenge flow baked in.

If you're building a UI for a ProofNetwork contract — game, marketplace, DAO, Telegram-linked app — start here. This is the library; nothing else is needed.

---

## Features

- **Talks to ProofNetwork contracts natively** — `wallet.callContract(fn, inputs)` handles the platform's `/blockchain/contracts/call` API, view-vs-write response shapes, encoded-transaction discovery, error toasts, and in-flight duplicate dedup
- **Multi-wallet** — Phantom, Solflare, Backpack, Jupiter (Wallet Standard), and built-in burner wallets
- **Burner wallet management** — generate, import, export, rename, delete, sign-as-specific without switching active
- **Transaction sending** — auto-detects burner keypair; signs and submits legacy or versioned transactions
- **Pool-backed RPC** — every read routes through `window.solRpcPool` so rate-limit-aware endpoint selection happens for free
- **Bulk operations** — multi-recipient SOL transfers, bulk token swaps, atomic multi-transfer txs
- **Privacy mode** — `window.privacyMode = true` routes transfers through PrivacyCash and restricts the wallet picker to burners
- **Polling** — `pollContract(fn, …, frequency, onUpdate)` for view functions with an automatic error budget
- **Drop-in UI** — auto-rendered Connect button, wallet-selection modal, toasts, result modals

---

## The ProofNetwork model in 60 seconds

Three things shape the API surface and the rest of this README:

1. **State is public; blackbox is private.** A contract has two storage halves: `state` (returned by public read APIs — anything in here is visible to anyone who asks the network) and `blackbox` (Solana keypairs and secrets — never serialized over the API, never exposed in transaction logs). When you read a contract from the frontend you only ever see `state`.

2. **Functions are either *view* or *write*.** Views are read-only, cheap, server-cached for ~30 seconds, and return their result directly. Writes mutate state, are queued, and return inside a `transaction` wrapper. `wallet.callContract` smooths over the shape difference — you always get back the contract's `outputs` object — but the latency and caching characteristics matter when designing your UI.

3. **Writes that touch a wallet's funds, data, or rank require a signed challenge.** ProofNetwork contracts call `verify.verifyTimeBoundSignature(message, signature, walletAddress, 5)` to confirm "this wallet really authorized this call." The flow is always two HTTP calls: ① `generate<Action>Challenge` returns a fresh challenge string + a `challengeId`; ② sign the challenge with the connected wallet; ③ submit the real mutation with `{walletAddress, signature, challengeId, ...inputs}`. Anything that mutates per-wallet state and doesn't take a signature is a security bug in the contract.

The Calling Contracts section below shows both shapes end-to-end.

---

## Quick Start

```html
<script src="https://cdn.example.com/proofwallet/wallet.js"></script>
<script>
  window.wallet = new CryptoClient({
    contractAddress: '0xYourProofNetworkContract',
    apiUrl:          'https://proofnetwork.lol',
    apiKey:          'optional-bearer-token',
    appName:         'My App',
    mountTo:         '#wallet-button',
  });

  // Restore the previous session if there was one
  await wallet.autoReconnect();

  // Listen for connection changes (works in any framework)
  document.addEventListener('walletConnected',    e => console.log('connected:',   e.detail.publicKey));
  document.addEventListener('walletDisconnected', () => console.log('disconnected'));
</script>
```

That's it for setup. For real flows, read **Calling contracts** below.

---

## Configuration

```javascript
new CryptoClient({
  contractAddress: string,      // ProofNetwork contract address (0x… or named)
  apiUrl:          string,      // API base — default: 'https://proofnetwork.lol'
  apiKey:          string,      // Optional Bearer token (only needed off-domain)
  appName:         string,      // Shown in modal headers
  mountTo:         string | Element, // CSS selector / DOM node for the auto-rendered Connect button
  onVerify:        async (publicKey) => boolean, // Optional connection gate — return false to refuse
  theme: {
    primaryColor:  string,      // default: '#10b981'
    accentColor:   string,      // default: '#34d399'
  },
});
```

`contractAddress` is the contract your UI primarily talks to (used as the default by `callContract`/`pollContract`). You can still call other contracts by passing `options.contractAddress` per call if you build a multi-contract app.

After init, the library exposes:

| Global | What it is |
|---|---|
| `window.CryptoClient` | The class itself (static burner-management helpers live here) |
| `window.solanaWeb3` | Lazy-loaded `@solana/web3.js` |
| `window.solanaConnection` | Live RPC `Connection`, routed through `window.solRpcPool` |
| `window.nacl` | TweetNaCl (for ad-hoc verification) |

---

## Supported Wallets

| Wallet | ID | Type | Detection |
|--------|----|------|-----------|
| Phantom | `phantom` | Extension | `window.phantom?.solana` |
| Solflare | `solflare` | Extension | `window.solflare` |
| Backpack | `backpack` | Extension | `window.backpack` |
| Jupiter | `jupiter` | Extension | Wallet Standard |
| Burner  | `burner`  | Local     | localStorage |

---

## Wallet connection

```javascript
// Open the picker modal
wallet.showOverlay();

// Or connect a specific wallet by ID
await wallet.connectWallet('phantom');   // 'phantom' | 'solflare' | 'backpack' | 'jupiter' | 'burner'

// Restore last session
await wallet.autoReconnect();

// Disconnect
wallet.disconnect();
```

**Read state, don't write it.** `wallet.state` is the read-only source of truth for the connection:

```javascript
wallet.state = {
  walletAddress: string | null,   // base58 pubkey
  isConnected:   boolean,
  isConnecting:  boolean,
  activeWallet:  'phantom' | 'solflare' | 'backpack' | 'jupiter' | 'burner' | null,
};
```

**Document events** are the recommended way to react:

```javascript
document.addEventListener('walletConnected', (e) => {
  const { publicKey, wallet: walletId, walletName } = e.detail;
  // wire up your UI here
});

document.addEventListener('walletDisconnected', () => {
  // tear down
});
```

### React glue

```tsx
import { useEffect, useState } from 'react';

export function useProofWallet() {
  const [address, setAddress] = useState<string | null>(
    () => (window as any).wallet?.state?.walletAddress ?? null
  );

  useEffect(() => {
    const onConnect    = (e: any) => setAddress(e.detail.publicKey);
    const onDisconnect = ()       => setAddress(null);
    document.addEventListener('walletConnected',    onConnect);
    document.addEventListener('walletDisconnected', onDisconnect);
    return () => {
      document.removeEventListener('walletConnected',    onConnect);
      document.removeEventListener('walletDisconnected', onDisconnect);
    };
  }, []);

  return {
    address,
    connect:    () => (window as any).wallet.showOverlay(),
    disconnect: () => (window as any).wallet.disconnect(),
    sign:       (msg: string) => (window as any).wallet.signMessage(msg),
    call:       (fn: string, params: any) => (window as any).wallet.callContract(fn, params),
  };
}
```

---

## Calling contracts — the two patterns

This is the heart of the library and the place most bugs hide. Every ProofNetwork contract call is one of two shapes.

### Pattern A — view / unsigned write (single round-trip)

For view functions (`getX`, `isX`, `checkX`, `listX`, `findX`, anything declared `@view`) and the rare unsigned write, just call once:

```javascript
const board = await wallet.callContract('getLeaderboard', { limit: 10 });
// → contract's `outputs` object (e.g. { entries: [...], total: 42 })
```

`callContract` POSTs to `{apiUrl}/blockchain/contracts/call` with `{from, contractAddress, functionName, inputs, responseMode:"minimal"}` (Bearer-authed with `apiKey` if provided) and returns the contract's `outputs` directly. View calls are cached on the server for ~30 s — repeated `getBalance(wallet=X)` calls within that window come back from the cache.

If a view returns a base64-serialized transaction in its result, the library auto-discovers it and surfaces it on `_encodedTransaction` so you can pass it straight to `signAndSendTransaction` (used by server-built atomic flows; see *Multi-transfer atomic transactions* below).

### Pattern B — signed write (`verifyTimeBoundSignature` two-step)

Any function that mutates per-wallet state (claim a reward, move a player, withdraw funds, set a username) MUST go through the challenge flow. The contract has no way to know a wallet authorized a call from an HTTP body alone — the signed challenge is what proves it.

```javascript
async function movePlayer(x, y) {
  const walletAddress = wallet.state.walletAddress;

  // ① Ask the contract for a fresh, single-use, time-bound challenge
  const challenge = await wallet.callContract('generateMoveChallenge', { walletAddress });
  // → { challengeId, challenge: '<string to sign>', expiresAt }

  // ② Sign the EXACT challenge string with the connected wallet
  const { signatureBase58 } = await wallet.signMessage(challenge.challenge);
  //         ^^^^^^^^^^^^^^^ THIS field, not `signature` — see landmines

  // ③ Submit the mutation with the wallet + signature + challengeId
  return await wallet.callContract('movePlayer', {
    walletAddress,
    signature: signatureBase58,
    challengeId: challenge.challengeId,
    x, y,
  });
}
```

A few rules that come straight out of the contract-side `verify.verifyTimeBoundSignature` and the replay-prevention pattern most contracts implement:

- **Sign the exact bytes.** The contract recomputes the expected message byte-for-byte. Trim, JSON-stringify, or re-quote it once and you get `Signature verification failed`.
- **Single-use.** The contract tracks used signatures (`state.usedSignatures[…]`) and rejects replays. Don't cache challenges across calls or share them between functions — generate a fresh one per mutation.
- **Short TTL.** Challenges typically expire after 5 minutes. If the user takes too long to confirm in their wallet, generate a new challenge and retry.
- **One challenge family per action.** `generateMoveChallenge` only authorizes `movePlayer`; trying to reuse it for `attackPlayer` is rejected by design.

### `signMessage` return shape

```javascript
{
  signature:        Uint8Array,    // raw bytes
  signatureBase58:  string,        // ← this is what most ProofNetwork verifiers want
  signatureBase64:  string,
  signatureHex:     string,
  publicKey:        string,        // base58
  message:          string,        // echoed back
}
```

**Landmine:** destructuring `const { signature } = await wallet.signMessage(...)` gives you the `Uint8Array`. Most contracts reject that — they want the base58 string. When in doubt, send `signatureBase58`.

### Throttle vs throw — handling rate limits gracefully

Contracts often rate-limit per-wallet writes (e.g. `state.lastActionTime[wallet]`). Best practice on a frozen client is to **throttle silently** rather than throw — so a write under the rate limit may return:

```json
{ "success": true, "throttled": true }
```

Treat `throttled: true` as "your call didn't apply, try again later" — not as a network error. Same goes for anti-cheat: if a value is *implausible* (vs *impossible*), the contract typically withholds that field and returns `{ success: true }` anyway. Inspect the returned `outputs` to see what actually applied.

### View-function polling

For UIs that need to refresh a view function (leaderboard, balance, room state) without manual `setInterval` plumbing:

```javascript
const poller = wallet.pollContract(
  'getRoomState',
  () => ({ roomId: currentRoomId }),  // function form — re-evaluated each poll
  2000,                                // every 2 s
  (state) => updateUI(state),          // onUpdate
  { maxErrors: 4 }                     // give up after N consecutive failures
);

// later
poller.stop();
```

Inputs can be a static object or a function — the function form is re-evaluated each poll, which is what you usually want when state changes. `pollContract` quietly stops after `maxErrors` consecutive failures (default 4) so a contract redeploy or network blip doesn't leave a runaway loop in your tab.

### Duplicate-call dedup

`callContract` keys in-flight calls by `${fn}:${from}:${stringify(inputs)}`. If two parts of your UI fire the *exact same call* concurrently, the second one piggybacks on the first promise — one network request, two consumers, identical result. This is a useful default; don't fight it by adding random nonces to inputs just because you think you should.

---

## Sending arbitrary Solana transactions

For transactions your UI builds itself (DEX swaps, NFT mints, anything outside `callContract`) — or for the `_encodedTransaction` returned by a contract atomic-multi-transfer — use `signAndSendTransaction`:

```javascript
import { Transaction, SystemProgram, PublicKey } from '@solana/web3.js';

const tx = new Transaction().add(
  SystemProgram.transfer({
    fromPubkey: new PublicKey(wallet.state.walletAddress),
    toPubkey:   new PublicKey('RecipientAddress…'),
    lamports:   100_000_000, // 0.1 SOL
  }),
);
tx.feePayer       = new PublicKey(wallet.state.walletAddress);
tx.recentBlockhash = (await window.solanaConnection.getLatestBlockhash()).blockhash;

const base64Tx = tx.serialize({ requireAllSignatures: false }).toString('base64');

const { signature, success } = await wallet.signAndSendTransaction(base64Tx, {
  callbacks: {
    onSuccess: sig => console.log('sent:', sig),
    onError:   err => console.error('failed:', err),
  },
});
```

When the active wallet is a burner, the library auto-detects it and signs with the burner keypair locally — no extension popup. Versioned transactions are handled the same way; the library auto-detects legacy vs versioned at sign time.

### Multi-transfer atomic transactions (contract-built)

ProofNetwork contracts can build atomic transactions via `umi.buildMultiTransferTx({ transfers: [...], feePayer, ... })` that mix contract-signed transfers (treasury, fees) with user-signed transfers (user pays, user burns) inside one transaction. The contract returns the base64-encoded partially-signed tx, the frontend collects the remaining user signature, and submits.

The library makes this nearly invisible:

```javascript
// 1) Ask the contract to build the multi-transfer
const result = await wallet.callContract('fillBuyOrder', {
  walletAddress: wallet.state.walletAddress,
  signature:     signatureBase58,        // from the challenge flow
  challengeId,
  orderId,
});

// 2) The library auto-detects encoded transactions in the response
//    and surfaces them on _encodedTransaction
if (result._encodedTransaction) {
  await wallet.signAndSendTransaction(result._encodedTransaction);
}
```

Contracts can also return the transaction in any field named `transaction`, `tx`, `signedTx`, `serializedTx`, or `rawTransaction` and the auto-discovery finds it (recursive scan, depth-limited).

---

## Burner wallets (in-browser keypairs)

A burner is a fresh Solana keypair generated and stored in `localStorage`. No extension, no signature popup. Useful for game accounts, anonymous play, and dev tooling. Burners can sign anything an extension wallet can sign.

```javascript
// Generate
const burner = CryptoClient.generateBurnerWallet('My Game Account');
// → { id, name, publicKey, secretKey: [64 bytes], createdAt, imported: false }

// Import (Base58 or JSON array form)
const { wallet: imported, error } = CryptoClient.importBurnerWallet(privateKey, 'Imported');

// Connect to the active burner
await wallet.connectWallet('burner');

// Switch active burner
CryptoClient.setActiveBurnerId(burner.id);

// Read all burners (for a picker UI)
const all = CryptoClient.getBurnerWallets();

// Rename / delete
CryptoClient.renameBurnerWallet(burner.id, 'Better Name');
CryptoClient.deleteBurnerWallet(burner.id);
```

### Signing as a specific burner without switching active

For multi-account bots / batch flows that need to sign as different burners without churning the connected wallet:

```javascript
const { signatureBase58 } = await wallet.signMessageWithBurner(challenge.challenge, burnerId);
```

### Burner balances in bulk

```javascript
const pubkeys = burners.map(b => new solanaWeb3.PublicKey(b.publicKey));
const infos   = await CryptoClient.batchGetAccountsInfo(pubkeys);
const sol     = infos.map(i => (i ? i.lamports / 1e9 : 0));
```

Internally chunks into groups of 5, parallelises with up to 3 retries (300 ms × attempt backoff). A failed chunk yields `null` slots instead of throwing — render those as `0` SOL and move on.

### Burner transfers

```javascript
// Single recipient
await wallet.transferFromBurner(burnerObj, 'DestPubkey…', 0.05);
// → { success: true, signature } or { success: false, error }

// Multiple recipients in ONE transaction
await wallet.transferFromBurnerMulti(burnerObj, [
  { address: 'RecipientA…', amount: 0.01 },
  { address: 'RecipientB…', amount: 0.02 },
]);
// With window.privacyMode === true this routes through PrivacyCash automatically.
```

**Landmine: burner localStorage is not encrypted.** Anything with `document.cookie`-level access to your origin can read every burner secret. Don't store funds you wouldn't lose to an XSS bug. For high-value flows use an extension wallet — proofwallet itself signs identically either way; only the storage threat model differs.

---

## Real-time updates (WebSocket)

ProofNetwork's `/ws` channel pushes three things relevant to UIs:

1. **`contract_state_changed`** — a passive ping fired on every state write to a contract you've subscribed to. Body is `{ contractAddress, reason, timestamp }` — no state payload, on purpose, because state shapes vary. Refetch (or call your `pollContract` once) when you receive one.
2. **`rt.broadcast` channels** — contract-driven pushes on arbitrary channel names (`room:abc`, `world`, `player:feed`). You opt in by subscribing.
3. **`rt.emit` targeted pushes** — contract pushes to a specific wallet (its turn, a private reward). You opt in by authenticating the socket with your wallet.

```javascript
const ws = new WebSocket('wss://proofnetwork.lol/ws');

ws.onopen = () => {
  // Subscribe to passive state-change pings for our contract
  ws.send(JSON.stringify({ type: 'watch_contract', contractAddress: wallet.config.contractAddress }));

  // Subscribe to a specific broadcast channel the contract publishes on
  ws.send(JSON.stringify({
    type: 'subscribe_channel',
    contractAddress: wallet.config.contractAddress,
    channel: `room:${roomId}`,
  }));

  // To receive rt.emit messages targeted at this wallet, authenticate the socket
  ws.send(JSON.stringify({
    type: 'authenticate',
    authToken: '<your auth token>',
    wallet:    wallet.state.walletAddress,
  }));
};

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  switch (msg.type) {
    case 'contract_state_changed': refetch();                       break;
    case 'channel_message':        applyChannelDelta(msg.payload);  break;
    case 'wallet_event':           applyPrivateMessage(msg.payload);break;
  }
};
```

### When the contract has a `tickRate`

Some contracts declare `state.metadata.tickRate` (1–30 Hz) and use `onTick` to advance a server-driven sim. From the frontend you don't need to call anything — the contract is broadcasting deltas at that cadence. Subscribe to the appropriate `rt.broadcast` channel (typically `world` or `room:${roomId}`) and apply incoming deltas to your local view.

A few client-side rules that make tick-driven contracts feel good:

- **Predict + interpolate on the client.** Don't snap to the broadcasted position; lerp toward it.
- **Batch high-frequency inputs.** For per-frame controls, accumulate intents on the client for ~50–100 ms and submit one `callContract`. Don't send a contract call per keystroke.
- **Treat broadcasts as advisory, state as authoritative.** A `rt.broadcast` is a hint about what changed; the source of truth is `state` (refetch via a view if your local copy diverges).

---

## Privacy mode

```javascript
window.privacyMode = true;
document.dispatchEvent(new CustomEvent('privacyModeChanged', { detail: { enabled: true } }));
```

When set:

- Extension wallets are hidden in the picker (burners only)
- `transferFromBurnerMulti` routes through the PrivacyCash API
- Privacy badges appear on modals

Toggle back with `window.privacyMode = false` and the same `privacyModeChanged` event.

---

## Bulk operations

```javascript
// UI-driven (drop-in modals)
wallet.showBulkTransferModal(sourceWallet);  // SOL → N recipients
wallet.showBulkSwapModal();                   // N burners → token buys

// Programmatic bulk swap
const result = await wallet.bulkSwap([
  {
    fromToken: 'So11111111111111111111111111111111111111112', // wrapped SOL
    toToken:   'TokenMintAddress…',
    amount:    0.1,
    walletAddress: burner.publicKey,
    urgent:    true,
  },
]);
```

---

## Token pricing

```javascript
const price = await wallet.fetchTokenPrice('TokenMintAddress…');
// → { priceUsd, priceNative, priceChange24h, liquidity, pair }
```

Backed by DexScreener. Cache for at least 30 s — don't poll on every tick.

---

## RPC routing

`CryptoClient.SYNDICA_RPC` is a **getter**, not a constant. It calls `window.solRpcPool.pickUrl()` each access, so every read flows through whichever endpoint the pool decides is healthiest right now (rate-limit-aware). If `solRpcPool` isn't loaded, it falls back to `api.mainnet-beta.solana.com`.

The actual per-request routing happens via a patched `Connection.prototype._rpcRequest`, so any `new solanaWeb3.Connection(...)` you create inherits pool routing too. You almost never need to set an RPC URL manually — and you shouldn't.

---

## UI components

The library renders its own connect button, wallet-selection modal, toasts, and result modals. If you want a fully custom UI, skip `mountTo` and call the imperative methods directly:

```javascript
// Picker / connection
wallet.showOverlay();
wallet.hideOverlay();

// Bulk modals
wallet.showBulkTransferModal(sourceWallet);
wallet.showBulkSwapModal();

// Toasts
wallet.showCopiedToast('Address copied!');
wallet.showErrorToast('Move rejected — try again', 5000);

// Result modals
wallet.showSuccessModal('Win!', 'You looted 3 items', [
  { label: 'Drop', value: 'Mythic Sword' },
  { label: 'Tx',   value: 'abc123…' },
]);
wallet.showErrorModal('Error', 'Transfer failed', errorDetails);
```

---

## Static helpers

```javascript
// Burner wallet management
CryptoClient.generateBurnerWallet(name);
CryptoClient.importBurnerWallet(privateKey, name);     // → { wallet, error }
CryptoClient.getBurnerWallets();
CryptoClient.getActiveBurnerId();
CryptoClient.setActiveBurnerId(walletId);
CryptoClient.renameBurnerWallet(walletId, newName);
CryptoClient.deleteBurnerWallet(walletId);
CryptoClient.getBurnerKeypair(walletId);

// Wallet detection
CryptoClient.isJupiterInstalled();
CryptoClient.getJupiterProvider();
CryptoClient.getWalletStandardWallets();

// Balance queries
CryptoClient.batchGetAccountsInfo(pubkeys);

// Encoding
CryptoClient.encodeBase58(byteArray);
CryptoClient.decodeBase58(base58String);
```

---

## Events

### Dispatched

```javascript
document.addEventListener('walletConnected', (e) => {
  e.detail.publicKey;   // base58 wallet address
  e.detail.wallet;      // wallet ID ('phantom' | 'burner' | …)
  e.detail.walletName;  // display name
});

document.addEventListener('walletDisconnected', () => { /* … */ });
```

### Listened

```javascript
// Privacy mode toggle (your app dispatches this)
document.dispatchEvent(new CustomEvent('privacyModeChanged', { detail: { enabled: true } }));
```

---

## Error handling

### Wallet errors

| Code | What happened |
|------|---------------|
| `4001`   | User rejected the connection / signature prompt |
| `-32002` | A request is already pending in the wallet UI |
| `-32603` | Internal wallet error — usually retry-able |

### Contract-call errors

`wallet.callContract` rejects with `Error(serverMessage)` when the server returns non-2xx or a contract throws. The most common ProofNetwork-specific failures:

| Message | Cause | Fix |
|---|---|---|
| `Signature verification failed` | Wrong wallet signed; challenge expired; sent `signature` (bytes) or `signatureBase64` instead of `signatureBase58`; or the message was mutated before signing | Generate a fresh challenge, sign the exact string, send `signatureBase58` |
| `Signature already used` | Replayed a single-use signature | Generate a fresh challenge per mutation |
| `challenge not found` / expired | Single-use consumed, or older than the TTL | Generate fresh |
| `Function does not exist on contract` | Contract was redeployed and the ABI shifted | Refetch the ABI or update the function name |
| `Rate limit exceeded` / `{success:true, throttled:true}` | Per-wallet rate limit hit | Back off; in the throttled-success shape, just retry later |

The library auto-toasts non-CORS errors (unless one is already on screen). On CORS / network errors off localhost it shows a reconnecting overlay and retries after 3 s.

---

## Common patterns

### Sign-in (prove wallet ownership for a session)

```javascript
async function signIn() {
  const wa  = wallet.state.walletAddress;
  const { challenge } = await wallet.callContract('generateLoginChallenge', { walletAddress: wa });
  const { signatureBase58 } = await wallet.signMessage(challenge.challenge);
  return wallet.callContract('verifyLogin', {
    walletAddress: wa,
    signature:     signatureBase58,
    challengeId:   challenge.challengeId,
  });
}
```

### Claim a per-wallet reward

```javascript
async function claimReward(rewardId) {
  const wa = wallet.state.walletAddress;
  const { challenge } = await wallet.callContract('generateClaimChallenge', {
    walletAddress: wa, rewardId,
  });
  const { signatureBase58 } = await wallet.signMessage(challenge.challenge);

  const result = await wallet.callContract('claimReward', {
    walletAddress: wa, rewardId,
    signature:   signatureBase58,
    challengeId: challenge.challengeId,
  });

  // If the contract built an atomic transfer for the payout, finish signing it
  if (result?._encodedTransaction) {
    await wallet.signAndSendTransaction(result._encodedTransaction);
  }

  return result;
}
```

### Live leaderboard with polling + WebSocket invalidation

```javascript
const poller = wallet.pollContract(
  'getLeaderboard',
  { limit: 50 },
  10_000,
  (board) => renderLeaderboard(board),
);

const ws = new WebSocket('wss://proofnetwork.lol/ws');
ws.onopen = () => ws.send(JSON.stringify({
  type: 'watch_contract',
  contractAddress: wallet.config.contractAddress,
}));
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'contract_state_changed') {
    // Don't wait for the next 10 s poll — refresh immediately
    wallet.callContract('getLeaderboard', { limit: 50 }).then(renderLeaderboard);
  }
};
```

### Read your contract's ABI

```javascript
const abi = await fetch(`${apiUrl}/blockchain/contracts/${contractAddress}/abi`, {
  headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
}).then(r => r.json());
// abi → [{ name, inputs, outputs, description, type: 'view' | 'function', … }, …]
```

Use it to build dynamic forms, validate inputs client-side, and decide which functions need the challenge/sign/call flow (look for a matching `generate<Name>Challenge` view).

### Gate connection on an external check

```javascript
new CryptoClient({
  contractAddress: '0x…',
  onVerify: async (publicKey) => {
    const ok = await fetch(`/api/allowlist/${publicKey}`).then(r => r.ok);
    return ok;
  },
});
```

Returning `false` cancels the connection and shows the user a denial toast.

---

## Anti-patterns

- **Don't roll your own wallet adapter.** proofwallet already handles Wallet Standard, versioned txs, the pool-aware RPC, and burner storage. Replacing it with `@solana/wallet-adapter-react` loses the pool routing and the burner flow.
- **Don't sign a mutated challenge string.** The contract recomputes the expected bytes; any trim/reformat/re-quote breaks verification.
- **Don't reuse a challenge.** Single-use, short TTL. Reusing one is at best a `Signature already used` rejection — at worst, in a poorly-written contract, a replay vector.
- **Don't destructure `signature` when you meant `signatureBase58`.** The raw `Uint8Array` is almost never what ProofNetwork verifiers want.
- **Don't treat `{success: true, throttled: true}` as a network failure.** It means "the contract chose not to apply this write right now." Tell the user and retry later.
- **Don't put high-value flows on burner wallets.** XSS = total loss. Use an extension wallet for anything you care about.
- **Don't poll a write function.** Use views (`pollContract` only with view-style functions). Polling a write floods the queue and burns gas.
- **Don't hard-code RPC URLs** unless you also bypass `solRpcPool`. The pool exists to dodge rate limits — pinning a single endpoint defeats it.
- **Don't add random nonces just to defeat the in-flight dedup.** Identical concurrent calls *should* share one result. If you genuinely need a fresh call per click, vary an input that the contract actually uses.
- **Don't expect `state` to contain secrets.** Anything sensitive lives in the contract's blackbox, which is never serialized to any client. If you "need" a secret on the frontend, you've misdesigned the flow — push the action into the contract instead.

---

## Browser requirements

- Modern browser with ES6+ support
- `localStorage` for burner wallet storage
- `crypto.getRandomValues()` for key generation
- WebSocket support for RPC + realtime

---

## Dependencies (loaded from CDN at runtime)

- `@solana/web3.js` — transaction handling
- `TweetNaCl` — message signing
- `QRCode` — wallet-address QR

You don't need to install these yourself; the library lazy-loads them when first needed.

---

## License

See `LICENSE` in this repo.
