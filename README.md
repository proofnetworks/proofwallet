A production-grade cryptocurrency wallet management library for Solana with multi-wallet support, burner wallet management, bulk operations, and privacy mode integration.

## Features

- **Multi-Wallet Support**: Phantom, Solflare, Backpack, Jupiter, and Burner wallets
- **Burner Wallet Management**: Generate, import, export, rename, and delete local wallets
- **Bulk Operations**: Multi-recipient SOL transfers and bulk token swaps
- **Privacy Mode**: PrivacyCash integration for anonymous transfers
- **Apple-Inspired UI**: Dark theme with blur effects and smooth animations
- **Transaction Handling**: Sign and send transactions with any wallet type
- **Wallet Standard**: Modern wallet detection and connection

---

## Quick Start

```javascript
// Initialize
const wallet = new CryptoClient({
    contractAddress: '0xYourContract',
    apiUrl: 'https://api.example.com',
    apiKey: 'your-api-key',
    appName: 'My App'
});

// Connect to wallet
await wallet.connectWallet('phantom');

// Sign a message
const signed = await wallet.signMessage('Hello, Solana!');

// Disconnect
wallet.disconnect();
```

---

## Configuration

```javascript
const wallet = new CryptoClient({
    contractAddress: string,      // Smart contract address
    apiUrl: string,               // API endpoint (default: proofnetwork.lol)
    apiKey: string,               // Bearer token for API requests
    appName: string,              // Application name (default: "Emerald Supply")
    mountTo: string | Element,    // CSS selector or DOM element for button
    onVerify: async Function,     // Optional wallet verification callback
    theme: {
        primaryColor: string,     // Primary color (default: #10b981)
        accentColor: string       // Accent color (default: #34d399)
    }
});
```

---

## Supported Wallets

| Wallet | ID | Type | Detection |
|--------|-----|------|-----------|
| Phantom | `phantom` | Extension | `window.phantom?.solana` |
| Solflare | `solflare` | Extension | `window.solflare` |
| Backpack | `backpack` | Extension | `window.backpack` |
| Jupiter | `jupiter` | Extension | Wallet Standard |
| Burner | `burner` | Local | localStorage |

---

## Instance Methods

### Connection

```javascript
// Connect to a specific wallet
await wallet.connectWallet('phantom');
await wallet.connectWallet('burner');

// Auto-reconnect with last used wallet
await wallet.autoReconnect();

// Disconnect
wallet.disconnect();

// Show wallet selection modal
wallet.showOverlay();

// Hide modal
wallet.hideOverlay();
```

### Signing

```javascript
// Sign a message with the currently connected wallet
const result = await wallet.signMessage('Hello', 'utf8');
// Returns: { signature, signatureBase58, signatureBase64, signatureHex, publicKey, message }

// Sign a message with a specific burner wallet (no wallet switch required)
const burnerResult = await wallet.signMessageWithBurner('Hello', burnerId);
// Returns: { signature, signatureBase58, signatureBase64, publicKey, message }

// Sign and send a transaction
const txResult = await wallet.signAndSendTransaction(base64Transaction, {
    keypair: optionalKeypair,
    callbacks: { onSuccess, onError }
});
// Returns: { signature, success }
```

### Contract Calls

```javascript
// Call a smart contract function
const result = await wallet.callContract('functionName', {
    param1: 'value1',
    param2: 'value2'
});
```

### Bulk Operations

```javascript
// Show bulk transfer modal (SOL to multiple recipients)
wallet.showBulkTransferModal(sourceWallet);

// Show bulk swap modal (token purchases with multiple wallets)
wallet.showBulkSwapModal();

// Execute bulk swap programmatically
const result = await wallet.bulkSwap([
    {
        fromToken: 'So11111111111111111111111111111111111111112', // SOL
        toToken: 'TokenMintAddress',
        amount: 0.1,
        walletAddress: 'BurnerPublicKey',
        urgent: true
    }
]);
```

### Burner Transfers

```javascript
// Single-recipient SOL transfer from a burner (convenience wrapper)
const result = await wallet.transferFromBurner(fromWalletObj, toAddress, 0.05);
// Returns: { success, signature } or { success: false, error }

// Multi-recipient SOL transfer from a single burner in one transaction.
// When window.privacyMode === true, transfers are routed through PrivacyCash.
const multi = await wallet.transferFromBurnerMulti(fromWalletObj, [
    { address: 'RecipientA...', amount: 0.01 },
    { address: 'RecipientB...', amount: 0.02 }
]);
```

### Token Pricing

```javascript
// Fetch token price from DexScreener
const price = await wallet.fetchTokenPrice('TokenMintAddress');
// Returns: { priceUsd, priceNative, priceChange24h, liquidity, pair }
```

---

## Static Methods

### Burner Wallet Management

```javascript
// Generate a new burner wallet
const burner = CryptoClient.generateBurnerWallet('My Wallet');
// Returns: { id, name, publicKey, secretKey, createdAt }

// Import from private key (Base58 or JSON array)
const { wallet, error } = CryptoClient.importBurnerWallet(privateKey, 'Imported');

// Get all burner wallets
const wallets = CryptoClient.getBurnerWallets();

// Get/set active burner wallet
const activeId = CryptoClient.getActiveBurnerId();
CryptoClient.setActiveBurnerId(walletId);

// Rename a burner wallet
CryptoClient.renameBurnerWallet(walletId, 'New Name');

// Delete a burner wallet
CryptoClient.deleteBurnerWallet(walletId);

// Get keypair for signing
const keypair = CryptoClient.getBurnerKeypair(walletId);
```

### Wallet Detection

```javascript
// Check if Jupiter is installed
const hasJupiter = CryptoClient.isJupiterInstalled();

// Get Jupiter provider
const provider = CryptoClient.getJupiterProvider();

// Get Wallet Standard wallets
const standardWallets = CryptoClient.getWalletStandardWallets();
```

### Balance Queries

```javascript
// Batch-fetch SOL balances for many wallets with retry + chunking.
// Returns an array aligned 1:1 with `pubkeys`, each element either
// { lamports: <number> } or null on failure for that slot.
const pubkeys = burners.map(b => new solanaWeb3.PublicKey(b.publicKey));
const infos = await CryptoClient.batchGetAccountsInfo(pubkeys);
const sol = infos.map(i => (i ? i.lamports / 1e9 : 0));
```

Internally chunks into groups of 5 and parallelises `getBalance` per chunk
with up to 3 retries (300 ms × attempt backoff). A failed chunk degrades
to `null` slots rather than throwing — callers can render those as `0`.

### Encoding Utilities

```javascript
// Base58 encoding/decoding
const base58 = CryptoClient.encodeBase58(byteArray);
const bytes = CryptoClient.decodeBase58(base58String);
```

---

## Events

### Dispatched Events

```javascript
// Wallet connected
document.addEventListener('walletConnected', (e) => {
    console.log(e.detail.publicKey);   // Wallet address
    console.log(e.detail.wallet);      // Wallet ID ('phantom', 'burner', etc.)
    console.log(e.detail.walletName);  // Display name
});

// Wallet disconnected
document.addEventListener('walletDisconnected', () => {
    console.log('Disconnected');
});
```

### Listened Events

```javascript
// Privacy mode changes (dispatched by app)
document.dispatchEvent(new CustomEvent('privacyModeChanged', {
    detail: { enabled: true }
}));
```

---

## Privacy Mode

When `window.privacyMode = true`:

- Extension wallets are hidden in the UI
- Only burner wallets are shown
- Bulk transfers route through PrivacyCash API
- Privacy badges displayed on modals

```javascript
// Enable privacy mode
window.privacyMode = true;
document.dispatchEvent(new CustomEvent('privacyModeChanged', {
    detail: { enabled: true }
}));
```

---

## UI Components

### Automatic UI

The library automatically creates:

- **Header Button**: Connect wallet button (mounted to `mountTo` config)
- **Wallet Modal**: Selection and connected views
- **Toast Notifications**: Success/error feedback
- **Transfer Modal**: Bulk transfer interface
- **QR Modal**: Wallet address QR codes

### Manual UI Control

```javascript
// Show/hide main modal
wallet.showOverlay();
wallet.hideOverlay();

// Show specific modals
wallet.showBulkTransferModal(sourceWallet);
wallet.showBulkSwapModal();

// Toast notifications (internal methods)
wallet.showCopiedToast('Address copied!');
wallet.showErrorToast('Something went wrong', 5000);

// Result modals
wallet.showSuccessModal('Success', 'Transfer complete', [
    { label: 'Amount', value: '1.5 SOL' }
]);
wallet.showErrorModal('Error', 'Transfer failed', errorDetails);
```

---

## RPC Endpoints

RPC URLs are served from a **pool-backed accessor**, not a static endpoint.
`CryptoClient.SYNDICA_RPC` is a getter that asks `window.solRpcPool.pickUrl()`
which endpoint to route the current read through — so the value reflects
live bucket state (rate-limit-aware routing), not a hard-coded URL. If the
pool isn't loaded, it falls back to `api.mainnet-beta.solana.com`.

The actual per-request routing happens via a patched
`Connection.prototype._rpcRequest`; the getter is used mainly for
`connection.rpcEndpoint` introspection and the very first request before
the patch lands.

```javascript
// Snapshot of the currently-picked endpoint
const rpc = CryptoClient.SYNDICA_RPC;
```

---

## Instance State

```javascript
wallet.state = {
    walletAddress: string | null,  // Connected wallet public key
    isConnected: boolean,          // Connection status
    isConnecting: boolean,         // Connection in progress
    activeWallet: string | null    // 'phantom' | 'solflare' | 'backpack' | 'jupiter' | 'burner'
};
```

---

## Burner Wallet Data Structure

```javascript
{
    id: 'burner_1234567890_abc123',  // Unique identifier
    name: 'My Burner',               // Display name
    publicKey: 'Base58Address...',   // Solana address
    secretKey: [/* 64 bytes */],     // Private key as byte array
    createdAt: 1234567890,           // Unix timestamp
    imported: false                   // True if imported, false if generated
}
```

---

## Error Handling

### Connection Errors

| Code | Meaning |
|------|---------|
| 4001 | User rejected connection |
| -32002 | Request pending in wallet |
| -32603 | Internal wallet error |

### Transaction Errors

The library handles:
- Blockhash validation
- Transaction serialization
- Signature verification
- Network failures with retry

---

## Browser Requirements

- Modern browser with ES6+ support
- `localStorage` for burner wallet storage
- `crypto.getRandomValues()` for key generation
- WebSocket support for RPC connections

---

## Dependencies

Loaded dynamically from CDN:
- **Solana Web3.js**: Transaction handling
- **TweetNaCl**: Message signing
- **QRCode**: QR code generation

---

## Global Exposure

After initialization, accessible via:

```javascript
window.wallet           // CryptoClient instance (if exposed by app)
window.solanaWeb3       // Solana Web3 library
window.solanaConnection // RPC connection instance
window.nacl             // TweetNaCl library
```
