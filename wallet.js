// ════════════════════════════════════════════════════════════════════════════
// Inline browser-side SolRpcPool — token-bucket rate limiting against the
// 4 verified free public Solana RPC endpoints. Server mirror lives at
// src/sol-rpc-pool.ts with the same EMPIRICAL_SPECS table and routing logic.
//
// Each browser tab is a separate IP from each provider's perspective, so
// every user gets their own per-provider rate-limit budget — far better
// than proxying through one server-side pool where all users would share
// a single upstream IP bucket.
//
// Empirically-derived specs (read = paced getSlot test, write = paced
// sendTransaction test, 2026-05-15). See scripts/stress-sol-rpcs-{hard,
// sustained,sendtx}.ts for the methodology + raw numbers.
//
// `patchSolanaConnection(solanaWeb3)` monkey-patches
// Connection.prototype._rpcRequest so every existing/new Connection routes
// through this pool. WebSocket subscriptions (onAccountChange etc.) are
// NOT covered — those go through a different web3.js code path.
// ════════════════════════════════════════════════════════════════════════════
const patchSolanaConnection = (function () {
    'use strict';

    const EMPIRICAL_SPECS = {
        'https://solana.lava.build': {
            read: { burst: 50, refillPerSec: 50 },
            write: { burst: 200, refillPerSec: 10 },
        },
        'https://solana-rpc.publicnode.com': {
            read: { burst: 200, refillPerSec: 30 },
            write: { burst: 200, refillPerSec: 10 },
        },
        'https://api.mainnet-beta.solana.com': {
            read: { burst: 40, refillPerSec: 4 },
            write: { burst: 20, refillPerSec: 2 },
        },
        'https://api.tatum.io/v3/blockchain/node/solana-mainnet': {
            read: { burst: 30, refillPerSec: 0.5 },
            write: { burst: 5, refillPerSec: 0.1 },
        },
    };

    const FALLBACK_SPEC = { read: { burst: 20, refillPerSec: 10 }, write: { burst: 10, refillPerSec: 2 } };

    const DEFAULT_URLS = [
        'https://solana.lava.build',
        'https://solana-rpc.publicnode.com',
        'https://api.mainnet-beta.solana.com',
        'https://api.tatum.io/v3/blockchain/node/solana-mainnet',
    ];

    function isWriteMethod(method) {
        return method === 'sendTransaction' || method === 'requestAirdrop';
    }

    class SolRpcPool {
        constructor(urls, opts) {
            opts = opts || {};
            if (!urls || !urls.length) throw new Error('SolRpcPool needs at least one URL');
            const specOverrides = Object.assign({}, EMPIRICAL_SPECS, opts.specs || {});
            const now = Date.now();
            this.endpoints = urls.map(function (url) {
                const spec = specOverrides[url] || FALLBACK_SPEC;
                return {
                    url: url,
                    readSpec: spec.read,
                    writeSpec: spec.write,
                    read: { tokens: spec.read.burst, lastRefillMs: now, rateLimitedUntil: 0 },
                    write: { tokens: spec.write.burst, lastRefillMs: now, rateLimitedUntil: 0 },
                    totalCalls: 0,
                    totalErrors: 0,
                };
            });
            this.maxRetries = opts.maxRetries != null ? opts.maxRetries : 3;
            this.verbose = !!opts.verbose;
        }

        _refillBucket(spec, bucket, now) {
            const elapsedSec = (now - bucket.lastRefillMs) / 1000;
            if (elapsedSec > 0) {
                bucket.tokens = Math.min(spec.burst, bucket.tokens + elapsedSec * spec.refillPerSec);
                bucket.lastRefillMs = now;
            }
        }

        _refillAll(ep, now) {
            this._refillBucket(ep.readSpec, ep.read, now);
            this._refillBucket(ep.writeSpec, ep.write, now);
        }

        _pickEndpoint(method, now) {
            const isWrite = isWriteMethod(method);
            for (let i = 0; i < this.endpoints.length; i++) this._refillAll(this.endpoints[i], now);
            const available = this.endpoints.filter(function (ep) {
                const bucket = isWrite ? ep.write : ep.read;
                return bucket.rateLimitedUntil <= now && bucket.tokens >= 1;
            });
            if (!available.length) return null;
            available.sort(function (a, b) {
                const at = isWrite ? a.write.tokens : a.read.tokens;
                const bt = isWrite ? b.write.tokens : b.read.tokens;
                return bt - at;
            });
            return available[0];
        }

        async send(method, params) {
            params = params || [];
            const isWrite = isWriteMethod(method);
            let attempt = 0;
            while (attempt < this.maxRetries) {
                const now = Date.now();
                const ep = this._pickEndpoint(method, now);
                if (!ep) {
                    if (this.verbose) console.log('[sol-rpc-pool] no endpoint available for ' + method + '; waiting 200ms');
                    await new Promise(function (r) { setTimeout(r, 200); });
                    attempt++;
                    continue;
                }
                const bucket = isWrite ? ep.write : ep.read;
                bucket.tokens -= 1;
                ep.totalCalls++;
                try {
                    const res = await fetch(ep.url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params }),
                    });
                    const text = await res.text();

                    if (res.status === 429 || /rate limit|too many requests/i.test(text)) {
                        const retryAfterHeader = res.headers.get('retry-after');
                        let cooldownMs = 60000;
                        if (retryAfterHeader) {
                            const asInt = parseInt(retryAfterHeader, 10);
                            if (!isNaN(asInt) && asInt > 0) cooldownMs = Math.min(300000, Math.max(5000, asInt * 1000));
                        }
                        bucket.tokens = 0;
                        bucket.rateLimitedUntil = Date.now() + cooldownMs;
                        ep.totalErrors++;
                        if (this.verbose) console.log('[sol-rpc-pool] ' + ep.url + ' ' + (isWrite ? 'write' : 'read') + '-bucket rate-limited; cooling ' + cooldownMs / 1000 + 's');
                        attempt++;
                        continue;
                    }

                    if (res.status === 401 || res.status === 403 || /unauthorized|api[- ]?key|authenticate/i.test(text)) {
                        ep.read.tokens = 0;
                        ep.write.tokens = 0;
                        ep.read.rateLimitedUntil = Date.now() + 3600000;
                        ep.write.rateLimitedUntil = Date.now() + 3600000;
                        ep.totalErrors++;
                        if (this.verbose) console.log('[sol-rpc-pool] ' + ep.url + ' requires API key; disabled for 1 hour');
                        attempt++;
                        continue;
                    }

                    let json;
                    try { json = JSON.parse(text); }
                    catch (e) { ep.totalErrors++; throw new Error('Non-JSON response from ' + ep.url + ': ' + text.slice(0, 200)); }
                    if (json.error) {
                        ep.totalErrors++;
                        throw new Error(ep.url + ' error: ' + (json.error.message || JSON.stringify(json.error)));
                    }
                    return json.result;
                } catch (e) {
                    ep.totalErrors++;
                    const msg = (e && e.message) || String(e);
                    if (/fetch|network|timeout|ECONN|ENOTFOUND|EAI_AGAIN|abort/i.test(msg)) {
                        if (this.verbose) console.log('[sol-rpc-pool] ' + ep.url + ' network error: ' + msg.slice(0, 80));
                        attempt++;
                        continue;
                    }
                    throw e;
                }
            }
            throw new Error('SolRpcPool: all ' + this.maxRetries + ' retries exhausted for ' + method);
        }

        // Public URL picker. Asks the pool which endpoint it would actually serve
        // a request of this kind through right now — so callers passing the URL
        // into `new Connection(URL, …)` see the same routing decision the pool
        // would make for the next real RPC. `method` defaults to 'getAccountInfo'
        // (a read) which uses read-bucket scoring; pass 'sendTransaction' to ask
        // for a write-route URL.
        pickUrl(method) {
            const now = Date.now();
            const ep = this._pickEndpoint(method || 'getAccountInfo', now);
            // Every bucket drained → fall back to first endpoint. The patched
            // _rpcRequest will still retry/back-off correctly when it actually fires.
            return (ep && ep.url) || this.endpoints[0].url;
        }

        getStats() {
            const now = Date.now();
            const self = this;
            return this.endpoints.map(function (ep) {
                self._refillAll(ep, now);
                return {
                    url: ep.url,
                    read: { tokens: Math.round(ep.read.tokens * 10) / 10, burst: ep.readSpec.burst, refillPerSec: ep.readSpec.refillPerSec, rateLimitedUntilMs: ep.read.rateLimitedUntil },
                    write: { tokens: Math.round(ep.write.tokens * 10) / 10, burst: ep.writeSpec.burst, refillPerSec: ep.writeSpec.refillPerSec, rateLimitedUntilMs: ep.write.rateLimitedUntil },
                    totalCalls: ep.totalCalls,
                    totalErrors: ep.totalErrors,
                };
            });
        }
    }

    const pool = new SolRpcPool(DEFAULT_URLS);

    // Expose the pool + class on window so DevTools / app.js / other scripts
    // can introspect rate-limit state (window.solRpcPool.getStats()) and so
    // anyone embedding wallet.js elsewhere can read the same instance.
    window.solRpcPool = pool;
    window.SolRpcPool = SolRpcPool;

    return function patchSolanaConnection(solanaWeb3) {
        if (!solanaWeb3 || !solanaWeb3.Connection) {
            console.warn('[sol-rpc-pool] patchSolanaConnection: solanaWeb3.Connection not found, skipping');
            return false;
        }
        const Connection = solanaWeb3.Connection;
        if (Connection.prototype.__solRpcPoolPatched) return true;
        Connection.prototype._rpcRequest = async function (method, args) {
            try {
                const result = await pool.send(method, args || []);
                return { jsonrpc: '2.0', id: 1, result: result };
            } catch (e) {
                return { jsonrpc: '2.0', id: 1, error: { code: -32000, message: (e && e.message) || String(e) } };
            }
        };
        Connection.prototype.__solRpcPoolPatched = true;
        console.log('[sol-rpc-pool] Connection._rpcRequest patched — all calls now flow through the pool');
        return true;
    };
})();

/**
 * Reusable Crypto Client Class
 * Multi-wallet support with Apple-inspired UI.
 */
class CryptoClient {
    // Supported wallets configuration
    static WALLETS = {
        phantom: {
            name: 'Phantom',
            icon: 'data:image/png;base64,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',
            getProvider: () => window.phantom?.solana || window.solana,
            isInstalled: () => !!(window.phantom?.solana?.isPhantom || window.solana?.isPhantom),
            downloadUrl: 'https://phantom.app/'
        },
        solflare: {
            name: 'Solflare',
            icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAHhlWElmTU0AKgAAAAgABAEaAAUAAAABAAAAPgEbAAUAAAABAAAARgEoAAMAAAABAAIAAIdpAAQAAAABAAAATgAAAAAAAABIAAAAAQAAAEgAAAABAAOgAQADAAAAAQABAACgAgAEAAAAAQAAAECgAwAEAAAAAQAAAEAAAAAAdd52hwAAAAlwSFlzAAALEwAACxMBAJqcGAAAEFZJREFUeAHlWwl4VOW5fs8kk52QDUH2ICIkoIBIqdJaywUExEBFQZAWq9c+T+ly7XIL2la0gtoi9tpra0Ut3taNioCKQCgigkiRtexUoQQxAklICEvWOX3f/8wJk5CEM8mkXOr3ZDLbOf//fe+3f+eMBY9kFw/LhM/XF4HACJ4yGbDiYNsez27hwyyLG9hl/PdH8riUPG61UnIPeNlVZzZItj0iFicCt8CHKajGIMRYrczBFQHu1+BpF+YLSRLjc/ausEsRhfUIYB6SfQssa2l5Q0w1CIBdMHQIF5wFvzXQnFxBiQP/36RuQCwfxYoJilZpb0BF4D4rY8XK+o6uFwC7ePh9iLYeoOZjUE5tX8wUS6sIoAJV9oNWyvJZdUWpBQBd2kLxsDmIj/ovI/jFovG6UtV9L4sQEGeqf42U3B8wZNSYctBpgmccHz4dCRS+rPriMfe6wtb3XoqUTJJNMoZQjQXYx2/8Cvx2LoOd/6Lx9RBBPL2UJUShEpXWMCt12bs6x1iAfeArcVT5bPisf1/hJa0sQTJSVkfmIABo7R+LuKirWzzgyd7kiwlRznON/Ym7fxEpqEtWyUzymcBn+e5q0cQuQeN9qKyykbusEI/MPIA1q4tRJmYuCBi0BMos2S36flfYgR2IshJbxPep8cqyAF59/Rh+8/RhbNhcSgsMwIqOQtYVCRg+JBU335iGgf1bIT41GoxBQCWB4Z8nkl8rqHs9XovqnGr7FEHoTQCG5yDOWgQyGVFSdKHw69aWYPqMA3hvbbFZ3or2EXayTJ5tWoQ4t6J86Hl5EIwR6QaMxHQPYPgtlB6vQhQFSmhFt6rWeh4pjgyW2WMIwNC5iI26O6L+H22hisw8+vghzHo8D2dOV8PnN/G2Xu5CwWAtjx7d441ljL4xHYMGtEKrDMUtnqoS3NUTBTicV4bbvrEbl7Tx45V5WYglIJ5BUCwqr36WAAwrY/kTe7Y0qJdH7x+SieLiKvznd/bhtUVHmXZ8lElm6o0MGNKkTUktH7pfFo9hN6Ri9Ig0XDswGckCgwBv31iK2+/cjZ27T5mFJ09oi9/+z+VIkmBeDEEs2Si32OXZnk7wwj8ZK6JJ3jp5F95ZXcQzHMFds/eyROgxksO4SRCMbt3iMOyrqejbJwm/+GUeDn9SZiwrwJjRoUMc1iy7CpldmdGNa4Wu1MBrsicL8IJXAyuEfEzgKxjAJPwbS47BxyD3tZvSkfdpBTZvK0VVuaIb/Z8gme415FSvLwMSTCYiolX5oixIeFnJ6y9mow+BMW7iHOHpPyNNhIim98uHDzrC+6MMYzkj03H7He2wZcMJvLm8CEuWF2LbzlNNBsNH8FyrEtcSvlfPRCx8KQtX9EpkUHMDhHeZImMB9Pt9e07jmiFbUXqyiq7raObOye3w/HO9nLTG6F/F77ZsP4W3IgCGhL/qyiQspOYzGTSbIrxgigwACT5Mm7Yfjz1xkD7JdEQKMJC1axuDrav7oW37WIJA05UClQ2oybpg/I2WUenRTST8wAHJWPCnLHTsTJ9vRsvefAAoVDUtb9DQrdi4qZQASEqHxOgd49viD89cgWhNa8SoG3EaA2MHwWDKqy91as0vXZeC+f/XC+3aEVilxmZQ8wGgXCdLq9F78GYcPMiobPz0LEdieNTwdPxsWhd8gdUeVIDwMxOp6wOjtArb957GvD9+hqeezYd9Fk/6fDX+44Y05vxeSFc61JSqmRSRIJiUGAU9arQbwpS0qOCX+24xvsCi5mbm8xFD09CbZbDpA1wwpMkKegd7g640630fn2HFzGKdkV4k4UfdmIEXGVNat+ZeERBe6zbPAsQcNb707ULc/b19yP+sooZhLR5KTrUnc7URnxiNq/s6YIwkGNkCI96JHYcOnMG4O3Zhw8YTNS4g4W/JuQQv0JUSBbTiSYSo6QBw6HicRc/0Bw5g7gv5MDmaTNXnt3V5VVuOqtpgjBmVjv59k/CD6fuxlXWDu46EnzS+HeY+1QPxqvK8Fjl1N23gfdMAICMff3QaE+/cgw2bSri0hRuuT0UPFiS/f/6w6fS8FjtnweAysiji4sYRi2bz7bvb48nZ3R33irDwwiT8GECTP3yoDDkTdmLnLnaUrPgS2ev/5tHLkHVlImJoGWp7pWRXi9qoITJtQrBRkptYQY70Oi4uCm3bxJh9snuExIwL6QIBAjCe5a4aHeV8RfkvDmqNdcv7OnmeVrpgUQFmzs7Dlq3s/UXBstV54/2/GzfiGBgH9FPMSMeoYanIUtWndKvKT0g3g8JzAeby9etKMHjENtOVyswD1MaAq1vhw5UEQCSGaBFlJ6qRu+o4gSrAO2uKTeNivm8CGC4QWjwhyY/Bg5LxzUntkMO4Eac5QBNKYMML/4UHADUxc+Y/8NOH9hvtaxExF0OzfXt+H3x1ZBrAmsAQwTHzPz4V5FdgzQclWMxs8c57BIPZoqkUGjMGsK54YHpX3EQgwpoihWxOgw2PPjtSWesEWUE5c/KUqXux/M1CR2hagBk7STN8ZLBoGfu1Npj3bE/s3DgA37+nfU3W0GICUaWzF2tWzFBs0WMjx2s5E3Zg2k/3O3OQsKXhWrWk8fAmKencU9SWHvqkHDfdtgM5t+7AKy8fwWfSstKWwBAJDHL//vsleOm1o5p1GFKrzyEQOnfixWaCoLSnlCpQzkcCwaYGHptz0KRjsOEKl6JmTLtshueTKOiJokrMX1hwTsFjOkAyvXfvKSxYXIA/zT+GDR+eQPmZANLT/Ejm2GohB6MT79rN+oEjMq6lSk8sz/5FNzz9vz0w5EsprPL8KKEbFRRWEpAAgeD8QGpvgEy6JYIfsOUefE0yuilbaKLkkcKLAeT2BJkbyLZXgjaW5mTS7pS5zSUx6MfK74O/lqCU50t4aTiWGeXxmd3w7akdnNKW73nlBqcKq8z0+E2O0JfkFmHfvtMUhwOQkEarrnzKRmNGt8HCV7K5Fs3KI4UHgBZlM7N8aRHGTtqJM9RuY0y5PEjTRitmPuh8KnO/74ed8fAj3UzxY5g2Ex9+L7NQbUCgTtISFjF4Pjonz9QDDYEuwNuz7d65tj9SUjVE9WYF4bmAeCeT3XsloA9z8VpG9pJimiq107iZ8nsKY8xVa5B0/C4OUVZQw0XHKpGcFIWMdD8sZhoTDdXsMMXGxFq48upk3M4gepjZZNvfTp7jflpPsaCKvH19/CVOp+jRCMK3AO0moiUcOlCGOU99glcXHkP+p8GbMCiYTNwL8fqIM0xQfk/0o/9VSRjJQudmjsOze7PYke+7ww66h0btapQWv1VwjvuZdMwqdMuqfuiVzXM9VotNB0ASymfpl0eZAVYyvy9eUojVjPIFDJQeLbAGJ3N8sEFKYLeo6e+PvtcJ1w1ufXaQwkLsY8aDAUO2oKSkuiaTaBG5WWqKH9vX9EeHjhyUKAZ5oOYB4G4gjQdvSTnCKfCEKbvwLqs/XzAtmRhAfjxbhngnGLFMo9MZJzRM8QkhfU7Lu23SLvz5dZXiChYOqSK9ihakitQvxehYD3R2BQ8HN3iI0C7ngz74JF3i/fXs5RnwRGIsjUFJeV6R2jwU7BohWb6EK+dxM2Yd4BWmvJqqUm4xsB/H3+dIGDBp1J/EsrTx5WvtHBkAaAEBMv39H39kLoUZS+Z7CduxQwyWvJqNLYzOi17OxhROirtw4iNgzgeGuaJEIB954hA+3s1UKM1SujRdRDUTVkcWk1LjozGZAdAMKGuJ2PibYPPZ+EGNfkvhK2me37n3Izzzh0/ZzjoXPyVcZlddsMhCXzZLspCcMW2QM7YNjh+pwNq/8lrB0kKs4KjsHwymEizUpN09BcLJE5V4e2URvpvdyXysWiRUzXZVNSZOaB/cx2P4D27QPACokXIWHd/67t/xwkv5sNgeGx3RJfr0TsIbLEq6atx1MtgglTm2qWA1enQGRt+cgRKmQHWLv537Kf6yqpgA1k6XLhBKmUZoLqGLK64FqGzu2CkeD93fxXPgc9fUc9NdgIyeZiH0jXv2GuE1G5Dwhvgimt+v4E0QBznhrekJ5NwiBTT1Bjy/dXK0aZSWL74Ssx/ONEMhmXRtskzRJf8vZLqV1ei1zXX8zEK/48SoY2YY1wRDFm8aANy0lFqd+M3deHXBEZoui5cQUpGzZetJ3DN1D/pfvxm3smr88/yjvHDKTlLNkZokFy2BoYqSUv/wv7vgLsYI2wSRkAXpHvE6j+715DP5ZragPVRN/uqhbrgpJ8OsEXqG19fhp0EKf5yXvyfy0vSyFYXnCF9345oymF90ZvAbOSwNtzIWXHtNK8TRFcxwVEWLtE5gNjI2fHH4VhPL3MpRHeLjs7rjy9e2xvWjthnLkxU9dH9X/IwPU0afYzV1Oan/fXgAsBA5dqwC47++C6veO35e4etuWXN1l9rrnZWIsRxkjGUs6Muqz9JYnP5ckF+O7Os24yj3qakbKOwM1gIvvnbMacIYeGf9PBM/+XHnZgkv/rwDQO3kHy7HOM4D160vMRHb9VVXU3UFbui9znNvj4mNi8ZAZolxYzLMzC8jJRo9B23CYfq6C4DWT2CPUMq+I4HXBZ58rDvuuvtSJ440UfMub94AYJWXl1eOW+jLmsIoXUmb0fxcDYgpO6lVl2F3cS/PDhhO6krl3OAajrk++LAUJ0+x1HXjBBeSG3TsGI/neX1gKHsF3vYamgm9bFXvMecHgNH8IO/FGXHLDuze48wAlOMvvTQW856+wjD5Mic8ue+EDD5pouHcFuNy5sYLt5bQ5w5A1bh+cCrmcmhyeU+mVQbNSFG0k7gbWY4KjmP93TrZifQSXndkzH8hC/04gVEwGsrAVsAe4C+rOQXmNGjVmhIUFQYHnyEzgEZ2MV8Z0GhJLsnKNDq7d2onPPxApjH/SAov2WUB579JipFfM77hY7ejmqlHJW13jZ6Uy12i1k1DxI/yeH1v2UoHjHUcVZ0q1SCVBU6wSnRPaexZQOu+n18/2g3jxrHEVaZQzxEpEs7mJimvt8nR39X/S0sddCOS26fXxxDdxoDBocYeFkIabb3OifEm1gaV5VU8o+F7hdxRWs6oDDzBq02ZApq32UWcVIs4t8mFcaOkBJMSwtEErUfjrQCF2MxpzqK3CrGYPcAO3d6mOyto4+61QGk9lZ3jg/d1wdR7OjCoci9pviWIbh28UbKFb5V1mZfJCQy6QRkLqfW8/L3gjQK8vaII+/ef4Ze2uflhziOXoQ8vg0Uqyrvb13pWnKm5VVYDveLhK3i77JBaPl3rjAi/ERgsqtSJmGaItb2mSFMmtYVfBVEYU90mceZofyVSlg+NZq617aLAc1TNkCYt1pSTZNXBGGKaoXFtFCOdoNrSwht+uZld/Zxkpw5IJZUL+ZOSTaZJMR/8C/+pGQp2hia+tPTWCn6SVTKTDABW5rucSPh+xJxeaSaxLc3EhVpfvi8ZKasjcxAA8WN+Q1OBGeYuLpnjvxtJJvk+ZXR/LyQRa4nKsvPz/bM5BQUrNfde+uT9HM1UXJCYEGnLk89LFsok2SRj6Ba1LCD0i8/1T2ddID7XP552QXCfL56fz9v8+bzl+efz/wQMfDTt5tznOQAAAABJRU5ErkJggg==',
            getProvider: () => window.solflare,
            isInstalled: () => !!window.solflare?.isSolflare,
            downloadUrl: 'https://solflare.com/'
        },
        backpack: {
            name: 'Backpack',
            icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAQKADAAQAAAABAAAAQAAAAABGUUKwAAAFA0lEQVRoBe1ZzW8bRRTf2Q9n3SY4bmq3SdUkiCD1EhmpB6BWD+RfgEM4gAQClZZL2yOtVA49tJdKPfIhkUOQegTBoVJBICJBRfChQRVFLUlwSCrHxPHa2PF6dmd5Yzfy7nidxjMrh4gdRcnO9+/33pv3Zl6Q4zjSfi7yfgZPsYcE9lqDoQZCDQhKIDQhQQEKT9/3GlCFRdB5AQjyGEM3ikQ6DxLtCZ6AU61Wf5gz53+2Vv4i1SoAlAcGtLEx/aUX9XQaaZooZO98FOxdyLx3b/PadfzwoYSQJMv0NxS4btk2VPtSqfilD7TxcS8GoVqQBOz19dxbbxPDkGMxFNEkVUPAAfAT28GWU6+TjYI28Vzy44/kgweFULsmB0qgWMQPfleHj6IDB1Bfn6SqqKEBqmSMiWk65bKVy+mpFPpvEnDJpXefwR9iUiqBLcEPKZepFwItaBoYlZJIKsmE3N8fLLnACADi6nff1+7exUuLpGg4Zl2yrRZWTQNnqsTj2vMT0XQ6evq0HI+3egW+AjgD4CvLs7OVL76083lq96pKnU/T/xDS+oaTQIhjWfBbHRnpn57uf+1VOlisiBKwc7mNKx+amQzSdeo3t0vTeJRYzCEEjIoakhurbYNTik5NHbp8SdCohAiAlecvXKgv/Iqi0W3k9C+A65ucHHjzjciJEyBvc2Gh9NkMXlxkQjKEvOjUK0NXr4pENyECxZs3y7Ofg9Nk0OsnTw5dv+Z29nb+7/z583h52aMHoFqtDl68OPD6tHuFrr5bSu9qGgzG2Wzlq68Z2UPQBTE/c/Y9N3oYrCQOx959h4Zkb4Fw8c+tW/bmpre5ixo/ga1vvm0at2c3QpRkMjIx4WlsVCKTk/LgIFiUp0tRrMePaz/+5GnspsJLwHFqmYykKMxeIGGkbF+BmD4kNwMz0wznuzY/zzbuus5JAI6vtbqK2gjA5cdez0NXOwC8+IdtGG5P9WSMqlpLyxK4V67CS6BYdIySDxqEICyAz2HM3anVSjMzku21nwZi4EyMIqlUuPBLnHEE9nMg0DajlXdnOJfVO3cAFrhR9fhxYIIfPTI++dT8JUNveO2Fct4ChlIs1t751BZOAo5lUxn7EYAtwRFVbt/emptTh4chkFlra45p+qNvAsS4+XZ7Ktz2AZwEGAtpXxfgAqb60hJ0wVFhQhg7HmTBOlh2SKc6L4FO67nbmeuDuyu4b85DHBwA0ZVCAqISFJ3PewYQgps9czPjxAJPZhrAG/mL7pfgJKA9O66fOoXv32/cJjj3bqCFjAvR0y8rR5Ldg6czBK7ThNiFTUkE/BPISBk6xIdejAD3noFO5DQhwACXeEgeSsQWxINUTR0bhfQj3zqcBEihkD/3vpXN+tznugVCSOSFVOLGDfqq7r5wEsCra9bKihRIplaW8W8P7I2Cemyke/zc/2YFz+fKQXBs7JkCbpR5qXm6d6qEkXgn6fSi7/+qgY4vdz6hQx6A90RxagDpUXp7oZcY4QKpJD2Kojw+FPbmJKAcPaIcTnC/A92k4bWpHhuGLKq7cfffnHEAEm+xc2chtQgRrZlw3v2WrZGyDFlRdXQ0duZMe4qpNWzHL4HLHPhuw8B/ZknJ4Mvq0H98xOPq2BiTh9wRMNspRIBdbC/qnGdgL6D67xkS8JdL71pDDfRO1v47hRrwl0vvWkMN9E7W/juFGvCXS+9aQw30Ttb+O/0LSazc4Xcn4sEAAAAASUVORK5CYII=',
            getProvider: () => window.backpack,
            isInstalled: () => !!window.backpack,
            downloadUrl: 'https://backpack.app/'
        },
        jupiter: {
            name: 'Jupiter',
            icon: 'data:image/jpeg;base64,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',
            getProvider: () => CryptoClient.getJupiterProvider(),
            isInstalled: () => CryptoClient.isJupiterInstalled(),
            downloadUrl: 'https://jup.ag/'
        },
        burner: {
            name: 'Burner Wallet',
            icon: 'data:image/jpeg;base64,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',
            getProvider: () => CryptoClient.getBurnerProvider(),
            isInstalled: () => true, // Always available
            isBurner: true,
            downloadUrl: null
        }
    };

    static STORAGE_KEY = 'cryptoClient_lastWallet';
    static BURNER_STORAGE_KEY = 'cryptoClient_burnerWallets';
    static ACTIVE_BURNER_KEY = 'cryptoClient_activeBurner';

    // Jupiter wallet detection using Wallet Standard
    static _jupiterWalletCache = null;

    static _walletStandardWallets = [];
    static _walletStandardInitialized = false;

    static initWalletStandard() {
        if (CryptoClient._walletStandardInitialized) return;
        CryptoClient._walletStandardInitialized = true;

        // The Wallet Standard uses a callback pattern via custom events
        // When we dispatch 'wallet-standard:app-ready', wallets call our register function
        const register = (wallet) => {
            if (!CryptoClient._walletStandardWallets.find(w => w.name === wallet.name)) {
                CryptoClient._walletStandardWallets.push(wallet);
                console.log('[CryptoClient] Wallet Standard: registered', wallet.name);

                // Check if this is Jupiter
                if (wallet.name?.toLowerCase().includes('jupiter')) {
                    CryptoClient._jupiterWalletCache = wallet;
                }
            }
        };

        // Store register function for re-announcements
        CryptoClient._walletStandardRegister = register;

        // Listen for wallets registering themselves
        window.addEventListener('wallet-standard:register-wallet', (event) => {
            register(event.detail);
        });

        // Announce we're ready to receive wallet registrations
        CryptoClient.announceWalletStandardReady();

        // Retry announcements to catch late-loading wallets
        setTimeout(() => CryptoClient.announceWalletStandardReady(), 100);
        setTimeout(() => CryptoClient.announceWalletStandardReady(), 500);
        setTimeout(() => CryptoClient.announceWalletStandardReady(), 1500);
    }

    static announceWalletStandardReady() {
        if (!CryptoClient._walletStandardRegister) return;

        // Dispatch app-ready event - wallets listen for this
        window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', {
            detail: { register: CryptoClient._walletStandardRegister }
        }));

        // Also check global registries that may exist
        const registries = [
            window['@wallet-standard:wallets'],
            window._standardWallets,
            window.navigator?.wallets
        ];

        registries.forEach(registry => {
            if (Array.isArray(registry)) {
                registry.forEach(CryptoClient._walletStandardRegister);
            } else if (registry?.get) {
                try {
                    const wallets = registry.get();
                    if (Array.isArray(wallets)) {
                        wallets.forEach(CryptoClient._walletStandardRegister);
                    }
                } catch (e) { /* ignore */ }
            }
        });
    }

    static getWalletStandardWallets() {
        // Initialize on first call
        CryptoClient.initWalletStandard();

        return CryptoClient._walletStandardWallets;
    }

    static findJupiterInStandard() {
        const wallets = CryptoClient.getWalletStandardWallets();
        if (Array.isArray(wallets)) {
            return wallets.find(w =>
                w.name?.toLowerCase().includes('jupiter') ||
                w.name === 'Jupiter' ||
                w.icon?.includes('jup')
            );
        }
        return null;
    }

    static isJupiterInstalled() {
        // Check cached result first
        if (CryptoClient._jupiterWalletCache !== null) {
            return true;
        }

        // Method 1: Check common window globals
        if (window.jupiterWallet) return true;
        if (window.jupiter?.isJupiter) return true;

        // Method 2: Check if Jupiter registered itself on window.solana
        // (Some wallets add themselves to the shared namespace)
        if (window.solana?.isJupiter || window.solana?.isJupiterWallet) return true;

        // Method 3: Check Wallet Standard
        const standardWallet = CryptoClient.findJupiterInStandard();
        if (standardWallet) {
            CryptoClient._jupiterWalletCache = standardWallet;
            return true;
        }

        // Method 4: Check for Jupiter in detected wallets list (some extensions populate this)
        if (window.wallets) {
            const jupWallet = window.wallets.find?.(w =>
                w.name?.toLowerCase().includes('jupiter')
            );
            if (jupWallet) {
                CryptoClient._jupiterWalletCache = jupWallet;
                return true;
            }
        }

        return false;
    }

    static getJupiterProvider() {
        // Return cached provider if available
        if (CryptoClient._jupiterWalletCache?.features?.['standard:connect']) {
            return CryptoClient._jupiterWalletCache;
        }

        // Check common globals
        if (window.jupiterWallet) return window.jupiterWallet;
        if (window.jupiter?.isJupiter) return window.jupiter;

        // Check if on shared namespace
        if (window.solana?.isJupiter || window.solana?.isJupiterWallet) return window.solana;

        // Check Wallet Standard
        const standardWallet = CryptoClient.findJupiterInStandard();
        if (standardWallet) {
            CryptoClient._jupiterWalletCache = standardWallet;
            return standardWallet;
        }

        // Check wallets array
        if (window.wallets) {
            const jupWallet = window.wallets.find?.(w =>
                w.name?.toLowerCase().includes('jupiter')
            );
            if (jupWallet) return jupWallet;
        }

        return null;
    }

    // ==================== BURNER WALLET METHODS ====================

    static _activeBurnerKeypair = null;

    static getBurnerWallets() {
        try {
            const stored = localStorage.getItem(CryptoClient.BURNER_STORAGE_KEY);
            return stored ? JSON.parse(stored) : [];
        } catch {
            return [];
        }
    }

    static saveBurnerWallets(wallets) {
        try {
            localStorage.setItem(CryptoClient.BURNER_STORAGE_KEY, JSON.stringify(wallets));
        } catch (e) {
            console.error('[CryptoClient] Failed to save burner wallets:', e);
        }
    }

    static getActiveBurnerId() {
        try {
            return localStorage.getItem(CryptoClient.ACTIVE_BURNER_KEY);
        } catch {
            return null;
        }
    }

    static setActiveBurnerId(id) {
        try {
            if (id) {
                localStorage.setItem(CryptoClient.ACTIVE_BURNER_KEY, id);
            } else {
                localStorage.removeItem(CryptoClient.ACTIVE_BURNER_KEY);
            }
        } catch { /* ignore */ }
    }

    static generateBurnerWallet(name = null) {
        // Ensure solanaWeb3 is available
        if (!window.solanaWeb3?.Keypair) {
            console.error('[CryptoClient] solanaWeb3 not loaded - cannot generate burner wallet');
            return null;
        }

        const keypair = window.solanaWeb3.Keypair.generate();
        const publicKey = keypair.publicKey.toBase58();
        const secretKey = Array.from(keypair.secretKey); // Convert Uint8Array to regular array for JSON storage

        const wallets = CryptoClient.getBurnerWallets();
        const id = `burner_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

        const newWallet = {
            id,
            name: name || `Burner ${wallets.length + 1}`,
            publicKey,
            secretKey,
            createdAt: Date.now()
        };

        wallets.push(newWallet);
        CryptoClient.saveBurnerWallets(wallets);

        console.log('[CryptoClient] Generated new burner wallet:', publicKey.slice(0, 8) + '...');
        try { window.dispatchEvent(new CustomEvent('burnerWalletsChanged', { detail: { type: 'create', id: newWallet.id } })); } catch {}
        return newWallet;
    }

    static importBurnerWallet(privateKeyString, name = null) {
        // Ensure solanaWeb3 is available
        if (!window.solanaWeb3?.Keypair) {
            console.error('[CryptoClient] solanaWeb3 not loaded - cannot import wallet');
            return { error: 'Solana Web3 not loaded' };
        }

        try {
            let secretKeyArray;

            // Try to decode as base58 first
            privateKeyString = privateKeyString.trim();

            // Check if it's a JSON array format [1,2,3,...]
            if (privateKeyString.startsWith('[') && privateKeyString.endsWith(']')) {
                try {
                    secretKeyArray = new Uint8Array(JSON.parse(privateKeyString));
                } catch (e) {
                    return { error: 'Invalid array format' };
                }
            } else {
                // Assume base58 encoded
                try {
                    secretKeyArray = CryptoClient.decodeBase58(privateKeyString);
                } catch (e) {
                    return { error: 'Invalid base58 private key' };
                }
            }

            // Validate key length (should be 64 bytes for Solana)
            if (secretKeyArray.length !== 64) {
                return { error: 'Invalid key length (expected 64 bytes)' };
            }

            // Create keypair from secret key
            const keypair = window.solanaWeb3.Keypair.fromSecretKey(secretKeyArray);
            const publicKey = keypair.publicKey.toBase58();

            // Check if wallet already exists
            const wallets = CryptoClient.getBurnerWallets();
            const existing = wallets.find(w => w.publicKey === publicKey);
            if (existing) {
                return { error: 'Wallet already imported', existing };
            }

            const id = `burner_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

            const newWallet = {
                id,
                name: name || `Imported ${wallets.length + 1}`,
                publicKey,
                secretKey: Array.from(secretKeyArray),
                createdAt: Date.now(),
                imported: true
            };

            wallets.push(newWallet);
            CryptoClient.saveBurnerWallets(wallets);

            console.log('[CryptoClient] Imported wallet:', publicKey.slice(0, 8) + '...');
            try { window.dispatchEvent(new CustomEvent('burnerWalletsChanged', { detail: { type: 'import', id: newWallet.id } })); } catch {}
            return { wallet: newWallet };
        } catch (e) {
            console.error('[CryptoClient] Failed to import wallet:', e);
            return { error: 'Failed to import wallet: ' + e.message };
        }
    }

    static renameBurnerWallet(id, newName) {
        const wallets = CryptoClient.getBurnerWallets();
        const wallet = wallets.find(w => w.id === id);
        if (wallet) {
            wallet.name = newName.trim() || wallet.name;
            CryptoClient.saveBurnerWallets(wallets);
            return true;
        }
        return false;
    }

    static deleteBurnerWallet(id) {
        let wallets = CryptoClient.getBurnerWallets();
        wallets = wallets.filter(w => w.id !== id);
        CryptoClient.saveBurnerWallets(wallets);

        // Clear active if it was the deleted one
        if (CryptoClient.getActiveBurnerId() === id) {
            CryptoClient.setActiveBurnerId(null);
            CryptoClient._activeBurnerKeypair = null;
        }

        console.log('[CryptoClient] Deleted burner wallet:', id);
        try { window.dispatchEvent(new CustomEvent('burnerWalletsChanged', { detail: { type: 'delete', id } })); } catch {}
    }

    static renameBurnerWallet(id, newName) {
        const wallets = CryptoClient.getBurnerWallets();
        const wallet = wallets.find(w => w.id === id);
        if (wallet) {
            wallet.name = newName;
            CryptoClient.saveBurnerWallets(wallets);
        }
    }

    static getBurnerKeypair(id = null) {
        const targetId = id || CryptoClient.getActiveBurnerId();
        if (!targetId) return null;

        const wallets = CryptoClient.getBurnerWallets();
        const wallet = wallets.find(w => w.id === targetId);
        if (!wallet) return null;

        // Reconstruct Keypair from stored secret key
        if (window.solanaWeb3?.Keypair) {
            const secretKeyArray = new Uint8Array(wallet.secretKey);
            return window.solanaWeb3.Keypair.fromSecretKey(secretKeyArray);
        }
        return null;
    }

    static getBurnerProvider() {
        // Return a provider-like object for burner wallets
        const activeBurnerId = CryptoClient.getActiveBurnerId();
        const wallets = CryptoClient.getBurnerWallets();
        const activeWallet = wallets.find(w => w.id === activeBurnerId);

        return {
            isBurner: true,
            publicKey: activeWallet ? {
                toString: () => activeWallet.publicKey,
                toBase58: () => activeWallet.publicKey
            } : null,
            isConnected: !!activeWallet,
            connect: async () => {
                const active = CryptoClient.getActiveBurnerId();
                const wallet = CryptoClient.getBurnerWallets().find(w => w.id === active);
                if (wallet) {
                    return {
                        publicKey: {
                            toString: () => wallet.publicKey,
                            toBase58: () => wallet.publicKey
                        }
                    };
                }
                throw new Error('No burner wallet selected');
            },
            disconnect: async () => {
                CryptoClient._activeBurnerKeypair = null;
            },
            signMessage: async (message) => {
                const keypair = CryptoClient.getBurnerKeypair();
                if (!keypair) throw new Error('No burner wallet available');

                console.log('[CryptoClient] Burner signMessage - message length:', message?.length);

                // Use nacl/tweetnacl for signing
                const signature = await CryptoClient.signWithKeypair(message, keypair);

                console.log('[CryptoClient] Burner signMessage - signature length:', signature?.length);

                return {
                    signature,
                    publicKey: keypair.publicKey.toBase58()
                };
            },
            signTransaction: async (transaction) => {
                const keypair = CryptoClient.getBurnerKeypair();
                if (!keypair) throw new Error('No burner wallet available');
                transaction.sign(keypair);
                return transaction;
            },
            signAllTransactions: async (transactions) => {
                const keypair = CryptoClient.getBurnerKeypair();
                if (!keypair) throw new Error('No burner wallet available');
                transactions.forEach(tx => tx.sign(keypair));
                return transactions;
            }
        };
    }

    static async ensureNaclLoaded() {
        if (window.nacl?.sign?.detached) return true;
        if (window.tweetnacl?.sign?.detached) {
            window.nacl = window.tweetnacl;
            return true;
        }

        // Try to load tweetnacl from CDN
        return new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/nacl-fast.min.js';
            script.onload = () => {
                window.nacl = window.nacl || window.tweetnacl;
                console.log('[CryptoClient] Loaded tweetnacl for signing');
                resolve(true);
            };
            script.onerror = () => {
                console.error('[CryptoClient] Failed to load tweetnacl');
                resolve(false);
            };
            document.head.appendChild(script);
        });
    }

    static async signWithKeypair(message, keypair) {
        // Ensure nacl is loaded
        await CryptoClient.ensureNaclLoaded();

        const nacl = window.nacl || window.tweetnacl;
        if (nacl?.sign?.detached) {
            return nacl.sign.detached(message, keypair.secretKey);
        }

        // Fallback using solanaWeb3 if available
        if (window.solanaWeb3?.sign) {
            return window.solanaWeb3.sign(message, keypair.secretKey);
        }

        throw new Error('No signing library available');
    }

    // ==================== END BURNER WALLET METHODS ====================

    constructor(config = {}) {
        const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

        this.config = {
            contractAddress: config.contractAddress || null,
            apiUrl: config.apiUrl || (isLocal ? "http://localhost:5001/api" : "https://proofnetwork.lol/api"),
            apiKey: config.apiKey || null,
            appName: config.appName || "Emerald Supply",
            onVerify: config.onVerify || null,
            // Mount point for the connect button (selector string or element)
            mountTo: config.mountTo || null,
            // Theme options
            theme: {
                primaryColor: config.theme?.primaryColor || '#10b981',
                accentColor: config.theme?.accentColor || '#34d399',
                ...config.theme
            }
        };

        this.state = {
            walletAddress: null,
            isConnected: false,
            isConnecting: false,
            activeWallet: null  // 'phantom' | 'solflare' | 'backpack' | 'jupiter' | 'burner'
        };

        // Inject styles and create UI
        this.injectStyles();
        this.createHeaderButton();
        this.createWalletModal();
        this.createReconnectOverlay();

        // UI Elements
        this.elements = {
            overlay: document.getElementById('cc-wallet-modal'),
            headerBtn: document.getElementById('cc-header-btn'),
            reconnectOverlay: document.getElementById('cc-reconnect-overlay')
        };

        this.solanaWeb3Ready = this.loadSolanaWeb3();
        this.init();
    }

    /**
     * Inject Apple-inspired CSS styles
     */
    injectStyles() {
        if (document.getElementById('cc-wallet-styles')) return;

        const styles = document.createElement('style');
        styles.id = 'cc-wallet-styles';
        styles.textContent = `
            /* ═══════════════════════════════════════════════════════════════
               CRYPTO WALLET UI — Refined Dark Theme
               Clean, mobile-first design with depth and polish
            ═══════════════════════════════════════════════════════════════ */

            :root {
                --cc-bg-primary: #0d0d0f;
                --cc-bg-secondary: #141418;
                --cc-bg-elevated: #1a1a1f;
                --cc-border: rgba(255, 255, 255, 0.06);
                --cc-border-hover: rgba(255, 255, 255, 0.12);
                --cc-text-primary: #ffffff;
                --cc-text-secondary: rgba(255, 255, 255, 0.6);
                --cc-text-tertiary: rgba(255, 255, 255, 0.4);
                --cc-accent-orange: #ff9955;
                --cc-accent-green: #10b981;
                --cc-accent-purple: #a855f7;
                --cc-accent-blue: #3b82f6;
                --cc-accent-red: #ef4444;
            }

            .cc-modal-backdrop {
                position: fixed;
                inset: 0;
                background: rgba(0, 0, 0, 0.6);
                backdrop-filter: blur(12px);
                -webkit-backdrop-filter: blur(12px);
                z-index: 99999;
                opacity: 0;
                visibility: hidden;
                transition: opacity 0.25s ease, visibility 0.25s ease;
            }
            .cc-modal-backdrop.visible {
                opacity: 1;
                visibility: visible;
            }

            .cc-modal {
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%) scale(0.96);
                background: var(--cc-bg-primary);
                border: 1px solid var(--cc-border);
                border-radius: 28px;
                padding: 36px;
                width: 520px;
                max-width: calc(100vw - 32px);
                max-height: calc(100vh - 48px);
                overflow-y: auto;
                z-index: 100000;
                box-shadow:
                    0 0 0 1px rgba(255, 255, 255, 0.03) inset,
                    0 24px 48px -12px rgba(0, 0, 0, 0.6),
                    0 0 80px -20px rgba(139, 92, 246, 0.15);
                opacity: 0;
                visibility: hidden;
                transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            }
            .cc-modal::-webkit-scrollbar {
                width: 4px;
            }
            .cc-modal::-webkit-scrollbar-track {
                background: transparent;
            }
            .cc-modal::-webkit-scrollbar-thumb {
                background: rgba(255, 255, 255, 0.1);
                border-radius: 2px;
            }
            .cc-modal-backdrop.visible .cc-modal {
                opacity: 1;
                visibility: visible;
                transform: translate(-50%, -50%) scale(1);
            }

            .cc-close-btn {
                position: absolute;
                top: 20px;
                right: 20px;
                width: 40px;
                height: 40px;
                border: none;
                background: rgba(255, 255, 255, 0.04);
                border-radius: 12px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.2s ease;
                color: var(--cc-text-tertiary);
                font-size: 24px;
                line-height: 1;
            }
            .cc-close-btn:hover {
                background: rgba(255, 255, 255, 0.08);
                color: var(--cc-text-secondary);
            }
            .cc-close-btn:active {
                transform: scale(0.95);
            }

            .cc-header {
                text-align: center;
                margin-bottom: 28px;
                padding-right: 36px;
            }
            .cc-title {
                font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui, sans-serif;
                font-size: 28px;
                font-weight: 600;
                color: var(--cc-text-primary);
                margin: 0 0 8px 0;
                letter-spacing: -0.5px;
            }
            .cc-subtitle {
                font-size: 16px;
                color: var(--cc-text-tertiary);
                margin: 0;
            }

            /* ─────────────────────────────────────────────────────────────
               Wallet List
            ───────────────────────────────────────────────────────────── */
            .cc-wallet-list {
                display: flex;
                flex-direction: column;
                gap: 14px;
            }
            .cc-privacy-notice {
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 14px 16px;
                background: rgba(56, 189, 248, 0.08);
                border: 1px solid rgba(56, 189, 248, 0.15);
                border-radius: 12px;
                color: #7dd3fc;
                font-size: 13px;
                font-weight: 500;
                margin-bottom: 6px;
            }
            .cc-privacy-notice svg {
                width: 18px;
                height: 18px;
                flex-shrink: 0;
            }
            .cc-wallet-btn {
                display: flex;
                align-items: center;
                gap: 18px;
                width: 100%;
                padding: 22px 24px;
                background: var(--cc-bg-secondary);
                border: 1px solid var(--cc-border);
                border-radius: 18px;
                cursor: pointer;
                transition: all 0.2s ease;
            }
            .cc-wallet-btn:hover {
                background: var(--cc-bg-elevated);
                border-color: var(--cc-border-hover);
            }
            .cc-wallet-btn:active {
                transform: scale(0.98);
            }
            .cc-wallet-btn.last-used {
                border-color: rgba(16, 185, 129, 0.3);
                background: rgba(16, 185, 129, 0.05);
            }
            .cc-wallet-btn.not-installed {
                opacity: 0.45;
            }
            .cc-wallet-icon {
                width: 56px;
                height: 56px;
                border-radius: 14px;
                flex-shrink: 0;
            }
            .cc-wallet-info {
                flex: 1;
                text-align: left;
                min-width: 0;
            }
            .cc-wallet-name {
                font-size: 19px;
                font-weight: 500;
                color: var(--cc-text-primary);
                margin: 0 0 4px 0;
            }
            .cc-wallet-status {
                font-size: 14px;
                color: var(--cc-text-tertiary);
                margin: 0;
            }
            .cc-wallet-status.detected {
                color: var(--cc-accent-green);
            }
            .cc-wallet-arrow {
                color: var(--cc-text-tertiary);
                font-size: 18px;
                transition: transform 0.2s ease;
                flex-shrink: 0;
            }
            .cc-wallet-btn:hover .cc-wallet-arrow {
                transform: translateX(2px);
                color: var(--cc-text-secondary);
            }
            .cc-last-used-badge {
                font-size: 11px;
                font-weight: 600;
                color: var(--cc-accent-green);
                background: rgba(16, 185, 129, 0.12);
                padding: 5px 10px;
                border-radius: 6px;
                text-transform: uppercase;
                letter-spacing: 0.3px;
                flex-shrink: 0;
            }

            /* ─────────────────────────────────────────────────────────────
               Connected View
            ───────────────────────────────────────────────────────────── */
            .cc-connected-view {
                text-align: center;
            }
            .cc-connected-address {
                font-family: 'SF Mono', ui-monospace, monospace;
                font-size: 13px;
                color: var(--cc-text-secondary);
                background: var(--cc-bg-secondary);
                padding: 10px 14px;
                border-radius: 10px;
                margin: 16px 0;
                word-break: break-all;
            }
            .cc-disconnect-btn {
                font-size: 14px;
                font-weight: 500;
                color: var(--cc-accent-red);
                background: rgba(239, 68, 68, 0.08);
                border: 1px solid rgba(239, 68, 68, 0.15);
                border-radius: 12px;
                padding: 12px 20px;
                cursor: pointer;
                width: 100%;
                transition: all 0.2s ease;
            }
            .cc-disconnect-btn:hover {
                background: rgba(239, 68, 68, 0.12);
            }

            .cc-connected-wallet-info {
                display: flex;
                align-items: center;
                gap: 16px;
                padding: 20px 22px;
                background: var(--cc-bg-secondary);
                border: 1px solid var(--cc-border);
                border-radius: 18px;
                margin-bottom: 16px;
            }
            .cc-connected-wallet-icon {
                width: 52px;
                height: 52px;
                border-radius: 14px;
                flex-shrink: 0;
            }
            .cc-connected-wallet-details {
                flex: 1;
                text-align: left;
                min-width: 0;
            }
            .cc-connected-wallet-name {
                font-size: 18px;
                font-weight: 600;
                color: var(--cc-text-primary);
                margin: 0 0 4px 0;
            }
            .cc-connected-wallet-address {
                font-family: 'SF Mono', ui-monospace, monospace;
                font-size: 14px;
                color: var(--cc-text-tertiary);
                margin: 0;
            }
            .cc-connected-wallet-dot {
                width: 10px;
                height: 10px;
                background: var(--cc-accent-green);
                border-radius: 50%;
                animation: ccPulse 2s ease-in-out infinite;
                flex-shrink: 0;
            }

            /* Quick Actions */
            .cc-quick-actions {
                display: flex;
                flex-direction: column;
                gap: 12px;
                margin-bottom: 16px;
            }
            .cc-quick-action-btn {
                display: flex;
                align-items: center;
                gap: 16px;
                width: 100%;
                padding: 18px 20px;
                background: var(--cc-bg-secondary);
                border: 1px solid var(--cc-border);
                border-radius: 16px;
                cursor: pointer;
                transition: all 0.2s ease;
            }
            .cc-quick-action-btn:hover {
                background: var(--cc-bg-elevated);
                border-color: var(--cc-border-hover);
            }
            .cc-quick-action-btn:active {
                transform: scale(0.98);
            }
            .cc-quick-action-icon {
                width: 44px;
                height: 44px;
                border-radius: 12px;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 20px;
                flex-shrink: 0;
            }
            .cc-quick-action-icon.burner {
                background: rgba(255, 153, 85, 0.12);
                color: var(--cc-accent-orange);
            }
            .cc-quick-action-icon.transfer {
                background: rgba(16, 185, 129, 0.12);
                color: var(--cc-accent-green);
            }
            .cc-quick-action-icon.swap {
                background: rgba(168, 85, 247, 0.12);
                color: var(--cc-accent-purple);
            }
            .cc-quick-action-icon.switch {
                background: rgba(59, 130, 246, 0.12);
                color: var(--cc-accent-blue);
            }
            .cc-quick-action-info {
                flex: 1;
                text-align: left;
                min-width: 0;
            }
            .cc-quick-action-title {
                font-size: 17px;
                font-weight: 500;
                color: var(--cc-text-primary);
                margin: 0 0 3px 0;
            }
            .cc-quick-action-desc {
                font-size: 14px;
                color: var(--cc-text-tertiary);
                margin: 0;
            }
            .cc-quick-action-arrow {
                color: var(--cc-text-tertiary);
                font-size: 18px;
                transition: transform 0.2s ease;
                flex-shrink: 0;
            }
            .cc-quick-action-btn:hover .cc-quick-action-arrow {
                transform: translateX(2px);
                color: var(--cc-text-secondary);
            }

            .cc-connected-footer {
                display: flex;
                gap: 12px;
            }
            .cc-switch-wallet-btn {
                flex: 1;
                font-size: 16px;
                font-weight: 500;
                color: var(--cc-text-secondary);
                background: var(--cc-bg-secondary);
                border: 1px solid var(--cc-border);
                border-radius: 14px;
                padding: 16px 20px;
                cursor: pointer;
                transition: all 0.2s ease;
            }
            .cc-switch-wallet-btn:hover {
                background: var(--cc-bg-elevated);
                color: var(--cc-text-primary);
            }
            .cc-disconnect-btn-small {
                font-size: 16px;
                font-weight: 500;
                color: var(--cc-accent-red);
                background: rgba(239, 68, 68, 0.08);
                border: 1px solid rgba(239, 68, 68, 0.12);
                border-radius: 14px;
                padding: 16px 20px;
                cursor: pointer;
                transition: all 0.2s ease;
            }
            .cc-disconnect-btn-small:hover {
                background: rgba(239, 68, 68, 0.12);
            }

            .cc-status {
                font-size: 12px;
                color: var(--cc-text-tertiary);
                text-align: center;
                margin-top: 14px;
                min-height: 18px;
            }
            .cc-status.error { color: var(--cc-accent-red); }
            .cc-status.success { color: var(--cc-accent-green); }

            /* ─────────────────────────────────────────────────────────────
               Burner Wallet View
            ───────────────────────────────────────────────────────────── */
            .cc-burner-view {
                display: none;
            }
            .cc-burner-view.visible {
                display: block;
            }
            .cc-burner-header {
                display: flex;
                align-items: center;
                gap: 12px;
                margin-bottom: 18px;
            }
            .cc-burner-back {
                background: var(--cc-bg-secondary);
                border: 1px solid var(--cc-border);
                border-radius: 10px;
                width: 36px;
                height: 36px;
                cursor: pointer;
                color: var(--cc-text-secondary);
                font-size: 20px;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.2s ease;
                flex-shrink: 0;
            }
            .cc-burner-back:hover {
                background: var(--cc-bg-elevated);
                color: var(--cc-text-primary);
            }
            .cc-burner-title {
                font-size: 18px;
                font-weight: 600;
                color: var(--cc-text-primary);
                margin: 0;
            }

            .cc-burner-list {
                display: flex;
                flex-direction: column;
                max-height: 320px;
                overflow-y: auto;
                margin-bottom: 16px;
                padding-right: 4px;
            }
            .cc-burner-list::-webkit-scrollbar {
                width: 4px;
            }
            .cc-burner-list::-webkit-scrollbar-track {
                background: transparent;
            }
            .cc-burner-list::-webkit-scrollbar-thumb {
                background: rgba(255, 255, 255, 0.1);
                border-radius: 2px;
            }

            /* Burner wallet card */
            .cc-burner-item-wrapper {
                background: var(--cc-bg-secondary);
                border: 1px solid var(--cc-border);
                border-radius: 14px;
                transition: all 0.2s ease;
                margin-bottom: 8px;
            }
            .cc-burner-item-wrapper:last-child {
                margin-bottom: 0;
            }
            .cc-burner-item-wrapper:hover {
                background: var(--cc-bg-elevated);
                border-color: var(--cc-border-hover);
            }
            .cc-burner-item-wrapper.active {
                border-color: rgba(255, 153, 85, 0.4);
                background: rgba(255, 153, 85, 0.08);
            }
            .cc-burner-item-wrapper.expanded {
                border-color: var(--cc-border-hover);
                background: var(--cc-bg-elevated);
            }

            /* Header row - clickable to select wallet */
            .cc-burner-item-header {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 14px 16px;
                cursor: pointer;
            }

            /* Wallet info section */
            .cc-burner-item-info {
                flex: 1;
                min-width: 0;
                display: flex;
                flex-direction: column;
                gap: 2px;
            }
            .cc-burner-name-display {
                display: flex;
                align-items: center;
                gap: 6px;
            }
            .cc-burner-name-display.hidden {
                display: none;
            }
            .cc-burner-item-name {
                font-size: 15px;
                font-weight: 500;
                color: #ffffff;
                margin: 0 0 4px 0;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .cc-burner-address-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
            }
            .cc-burner-item-address {
                font-family: 'SF Mono', ui-monospace, monospace;
                font-size: 11px;
                color: rgba(255, 255, 255, 0.5);
                margin: 0;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .cc-burner-item-balance {
                font-family: 'SF Mono', ui-monospace, monospace;
                font-size: 11px;
                color: rgba(255, 255, 255, 0.5);
                margin: 0;
                flex-shrink: 0;
            }
            .cc-burner-edit-container {
                display: none;
                align-items: center;
                gap: 6px;
                flex: 1;
            }
            .cc-burner-edit-container.editing {
                display: flex;
            }

            /* Options toggle button */
            .cc-burner-options-toggle {
                background: rgba(255, 255, 255, 0.06);
                border: 1px solid transparent;
                border-radius: 8px;
                width: 34px;
                height: 34px;
                cursor: pointer;
                color: var(--cc-text-secondary);
                font-size: 18px;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.2s ease;
                flex-shrink: 0;
                -webkit-tap-highlight-color: transparent;
            }
            .cc-burner-options-toggle:hover {
                background: rgba(255, 255, 255, 0.1);
                color: var(--cc-text-primary);
            }
            .cc-burner-options-toggle.open {
                background: rgba(255, 153, 85, 0.15);
                color: var(--cc-accent-orange);
                transform: rotate(180deg);
            }

            /* Expandable actions panel - slides down */
            .cc-burner-actions-panel {
                display: grid;
                grid-template-columns: repeat(3, 1fr);
                gap: 6px;
                padding: 0 12px;
                max-height: 0;
                overflow: hidden;
                transition: max-height 0.25s ease, padding 0.25s ease;
            }
            .cc-burner-actions-panel.open {
                max-height: 200px;
                padding: 6px 12px 14px 12px;
            }

            /* Action button */
            .cc-burner-action {
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                gap: 5px;
                padding: 14px 8px;
                background: rgba(255, 255, 255, 0.04);
                border: 1px solid var(--cc-border);
                border-radius: 10px;
                cursor: pointer;
                transition: all 0.15s ease;
                -webkit-tap-highlight-color: transparent;
            }
            .cc-burner-action:hover {
                background: rgba(255, 255, 255, 0.08);
                border-color: var(--cc-border-hover);
            }
            .cc-burner-action:active {
                transform: scale(0.95);
            }
            .cc-burner-action-icon {
                font-size: 20px;
                line-height: 1;
            }
            .cc-burner-action-label {
                font-size: 10px;
                font-weight: 600;
                color: var(--cc-text-tertiary);
                text-transform: uppercase;
                letter-spacing: 0.3px;
            }
            /* Action colors */
            .cc-burner-action.copy .cc-burner-action-icon { color: var(--cc-text-primary); }
            .cc-burner-action.qr .cc-burner-action-icon { color: var(--cc-accent-purple); }
            .cc-burner-action.rename .cc-burner-action-icon { color: var(--cc-accent-blue); }
            .cc-burner-action.transfer .cc-burner-action-icon { color: var(--cc-accent-green); }
            .cc-burner-action.export .cc-burner-action-icon { color: #ffcc66; }
            .cc-burner-action.delete .cc-burner-action-icon { color: var(--cc-accent-red); }
            .cc-burner-action.delete:hover { background: rgba(239, 68, 68, 0.1); border-color: rgba(239, 68, 68, 0.3); }

            .cc-rename-input {
                flex: 1;
                background: rgba(0, 0, 0, 0.4);
                border: 1px solid var(--cc-accent-blue);
                border-radius: 6px;
                padding: 6px 10px;
                color: var(--cc-text-primary);
                font-size: 13px;
                font-family: inherit;
                outline: none;
            }
            .cc-rename-input:focus {
                border-color: var(--cc-accent-blue);
                box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
            }
            .cc-rename-save {
                background: rgba(16, 185, 129, 0.15);
                border: none;
                border-radius: 5px;
                padding: 6px 10px;
                color: var(--cc-accent-green);
                font-size: 11px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.15s ease;
            }
            .cc-rename-save:hover {
                background: rgba(16, 185, 129, 0.25);
            }

            /* ─────────────────────────────────────────────────────────────
               QR Code Modal
            ───────────────────────────────────────────────────────────── */
            .cc-qr-modal {
                position: fixed;
                bottom: 0;
                left: 0;
                right: 0;
                background: var(--cc-bg-primary);
                border-radius: 24px 24px 0 0;
                padding: 24px;
                padding-bottom: calc(24px + env(safe-area-inset-bottom));
                max-height: 90vh;
                overflow-y: auto;
                z-index: 100001;
                transform: translateY(100%);
                transition: transform 0.35s cubic-bezier(0.16, 1, 0.3, 1);
                box-shadow: 0 -10px 40px rgba(0, 0, 0, 0.5);
            }
            .cc-qr-modal.visible {
                transform: translateY(0);
            }
            .cc-qr-handle {
                width: 36px;
                height: 4px;
                background: rgba(255, 255, 255, 0.2);
                border-radius: 2px;
                margin: 0 auto 20px;
            }
            .cc-qr-header {
                text-align: center;
                margin-bottom: 20px;
            }
            .cc-qr-title {
                color: var(--cc-text-primary);
                font-size: 18px;
                font-weight: 600;
                margin: 0 0 6px 0;
            }
            .cc-qr-subtitle {
                color: var(--cc-text-tertiary);
                font-size: 13px;
                margin: 0;
            }
            .cc-qr-code-container {
                background: #ffffff;
                border-radius: 20px;
                padding: 20px;
                display: flex;
                align-items: center;
                justify-content: center;
                margin: 0 auto 20px;
                max-width: 240px;
            }
            .cc-qr-code-container svg {
                width: 100%;
                height: auto;
                max-width: 200px;
            }
            .cc-qr-address {
                background: rgba(255, 255, 255, 0.04);
                border: 1px solid var(--cc-border);
                border-radius: 12px;
                padding: 14px;
                margin-bottom: 16px;
                word-break: break-all;
                text-align: center;
            }
            .cc-qr-address-text {
                color: var(--cc-text-secondary);
                font-size: 12px;
                font-family: 'SF Mono', ui-monospace, monospace;
                margin: 0;
                line-height: 1.5;
            }
            .cc-qr-copy-btn {
                width: 100%;
                padding: 16px;
                border-radius: 14px;
                border: none;
                background: var(--cc-accent-orange);
                color: #000;
                cursor: pointer;
                font-weight: 600;
                font-size: 15px;
                font-family: inherit;
                transition: all 0.2s ease;
                -webkit-tap-highlight-color: transparent;
            }
            .cc-qr-copy-btn:hover {
                filter: brightness(1.1);
            }
            .cc-qr-copy-btn:active {
                transform: scale(0.98);
            }
            .cc-qr-copy-btn.copied {
                background: var(--cc-accent-green);
            }

            /* Desktop: centered modal instead of bottom sheet */
            @media (min-width: 481px) {
                .cc-qr-modal {
                    top: 50%;
                    left: 50%;
                    bottom: auto;
                    right: auto;
                    transform: translate(-50%, -50%) scale(0.95);
                    opacity: 0;
                    border-radius: 24px;
                    width: 360px;
                    max-width: calc(100vw - 32px);
                    padding-bottom: 24px;
                }
                .cc-qr-modal.visible {
                    transform: translate(-50%, -50%) scale(1);
                    opacity: 1;
                }
                .cc-qr-handle {
                    display: none;
                }
            }

            /* ─────────────────────────────────────────────────────────────
               Transfer / Bulk Inputs
            ───────────────────────────────────────────────────────────── */
            .cc-transfer-input {
                width: 100%;
                padding: 10px 12px;
                background: rgba(0, 0, 0, 0.3);
                border: 1px solid var(--cc-border);
                border-radius: 8px;
                color: var(--cc-text-primary);
                font-size: 13px;
                font-family: inherit;
                outline: none;
                transition: all 0.2s ease;
                box-sizing: border-box;
            }
            .cc-transfer-input:focus {
                border-color: var(--cc-accent-green);
                box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.15);
            }
            .cc-transfer-input::placeholder {
                color: var(--cc-text-tertiary);
            }
            .cc-transfer-select {
                width: 100%;
                padding: 10px 12px;
                padding-right: 32px;
                background: rgba(0, 0, 0, 0.3);
                border: 1px solid var(--cc-border);
                border-radius: 8px;
                color: var(--cc-text-primary);
                font-size: 13px;
                font-family: inherit;
                outline: none;
                cursor: pointer;
                appearance: none;
                background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='rgba(255,255,255,0.4)' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
                background-repeat: no-repeat;
                background-position: right 10px center;
                transition: all 0.2s ease;
            }
            .cc-transfer-select:focus {
                border-color: var(--cc-accent-green);
            }
            .cc-transfer-label {
                color: var(--cc-text-secondary);
                font-size: 11px;
                font-weight: 500;
                margin: 0 0 5px 0;
                text-transform: uppercase;
                letter-spacing: 0.3px;
            }
            .cc-transfer-group {
                margin-bottom: 12px;
            }
            .cc-transfer-balance {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 10px 12px;
                background: var(--cc-bg-secondary);
                border-radius: 8px;
                margin-bottom: 12px;
            }
            .cc-transfer-balance-label {
                color: var(--cc-text-tertiary);
                font-size: 11px;
            }
            .cc-transfer-balance-value {
                color: var(--cc-text-primary);
                font-size: 13px;
                font-weight: 600;
                font-family: 'SF Mono', ui-monospace, monospace;
            }
            .cc-transfer-max {
                background: rgba(16, 185, 129, 0.12);
                border: none;
                color: var(--cc-accent-green);
                padding: 3px 7px;
                border-radius: 4px;
                font-size: 10px;
                font-weight: 600;
                cursor: pointer;
                margin-left: 8px;
                transition: all 0.15s ease;
            }
            .cc-transfer-max:hover {
                background: rgba(16, 185, 129, 0.2);
            }

            .cc-recipient-list {
                max-height: 180px;
                overflow-y: auto;
                margin-bottom: 10px;
                padding-right: 4px;
            }
            .cc-recipient-list::-webkit-scrollbar {
                width: 3px;
            }
            .cc-recipient-list::-webkit-scrollbar-thumb {
                background: rgba(255, 255, 255, 0.08);
                border-radius: 2px;
            }
            .cc-recipient-item {
                display: flex;
                gap: 6px;
                align-items: center;
                padding: 8px 10px;
                background: var(--cc-bg-secondary);
                border: 1px solid var(--cc-border);
                border-radius: 8px;
                margin-bottom: 6px;
            }
            .cc-recipient-item:last-child {
                margin-bottom: 0;
            }
            .cc-recipient-fields {
                flex: 1;
                display: flex;
                flex-direction: column;
                gap: 6px;
                min-width: 0;
            }
            .cc-recipient-row {
                display: flex;
                gap: 6px;
            }
            .cc-recipient-select {
                flex: 1;
                min-width: 0;
            }
            .cc-recipient-amount {
                width: 80px;
                flex-shrink: 0;
            }
            .cc-recipient-remove {
                background: rgba(239, 68, 68, 0.08);
                border: none;
                border-radius: 6px;
                width: 28px;
                height: 28px;
                min-width: 28px;
                color: var(--cc-accent-red);
                cursor: pointer;
                font-size: 14px;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.15s ease;
                flex-shrink: 0;
                align-self: center;
            }
            .cc-recipient-remove:hover {
                background: rgba(239, 68, 68, 0.15);
            }
            .cc-add-recipient {
                width: 100%;
                padding: 9px;
                background: rgba(59, 130, 246, 0.08);
                border: 1px dashed rgba(59, 130, 246, 0.25);
                border-radius: 8px;
                color: var(--cc-accent-blue);
                font-size: 12px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.2s ease;
                margin-bottom: 10px;
            }
            .cc-add-recipient:hover {
                background: rgba(59, 130, 246, 0.12);
                border-color: rgba(59, 130, 246, 0.4);
            }
            .cc-add-recipient:disabled {
                opacity: 0.4;
                cursor: not-allowed;
            }
            .cc-recipient-count {
                font-size: 10px;
                color: var(--cc-text-tertiary);
                text-align: right;
                margin-bottom: 6px;
            }
            .cc-transfer-total {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 10px 12px;
                background: rgba(16, 185, 129, 0.08);
                border: 1px solid rgba(16, 185, 129, 0.15);
                border-radius: 8px;
                margin-bottom: 10px;
            }
            .cc-transfer-total-label {
                color: var(--cc-accent-green);
                font-size: 11px;
                font-weight: 500;
            }
            .cc-transfer-total-value {
                color: var(--cc-accent-green);
                font-size: 14px;
                font-weight: 600;
                font-family: 'SF Mono', ui-monospace, monospace;
            }

            /* ─────────────────────────────────────────────────────────────
               Transfer Modal (Bottom Sheet)
            ───────────────────────────────────────────────────────────── */
            .cc-transfer-modal {
                position: fixed;
                bottom: 0;
                left: 0;
                right: 0;
                background: linear-gradient(180deg, #151820 0%, #0d0f14 100%);
                border-radius: 28px 28px 0 0;
                padding: 0;
                max-height: 92vh;
                overflow: hidden;
                z-index: 100002;
                transform: translateY(100%);
                transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
                box-shadow:
                    0 -4px 60px rgba(0, 0, 0, 0.6),
                    0 0 0 1px rgba(255, 255, 255, 0.06);
            }
            .cc-transfer-modal.visible {
                transform: translateY(0);
            }
            /* Desktop: centered modal */
            @media (min-width: 481px) {
                .cc-transfer-modal {
                    top: 50%;
                    left: 50%;
                    bottom: auto;
                    right: auto;
                    transform: translate(-50%, -50%) scale(0.95);
                    opacity: 0;
                    border-radius: 24px;
                    width: 440px;
                    max-height: 85vh;
                }
                .cc-transfer-modal.visible {
                    transform: translate(-50%, -50%) scale(1);
                    opacity: 1;
                }
            }
            .cc-transfer-modal-handle {
                width: 40px;
                height: 4px;
                background: rgba(255, 255, 255, 0.15);
                border-radius: 2px;
                margin: 12px auto 0;
            }
            @media (min-width: 481px) {
                .cc-transfer-modal-handle {
                    display: none;
                }
            }
            .cc-transfer-modal-content {
                padding: 20px 24px;
                padding-bottom: calc(24px + env(safe-area-inset-bottom));
                overflow-y: auto;
                max-height: calc(92vh - 16px);
            }
            @media (min-width: 481px) {
                .cc-transfer-modal-content {
                    padding-bottom: 24px;
                    max-height: calc(85vh - 16px);
                }
            }
            .cc-transfer-modal-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 20px;
            }
            .cc-transfer-modal-title {
                color: #fff;
                font-size: 20px;
                font-weight: 600;
                margin: 0;
                letter-spacing: -0.02em;
            }
            .cc-transfer-modal-close {
                width: 36px;
                height: 36px;
                border-radius: 50%;
                background: rgba(255, 255, 255, 0.06);
                border: 1px solid rgba(255, 255, 255, 0.08);
                color: rgba(255, 255, 255, 0.6);
                font-size: 18px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.2s ease;
            }
            .cc-transfer-modal-close:hover {
                background: rgba(255, 255, 255, 0.1);
                color: #fff;
            }

            /* Source wallet card */
            .cc-transfer-source {
                background: linear-gradient(135deg, rgba(16, 185, 129, 0.12) 0%, rgba(16, 185, 129, 0.04) 100%);
                border: 1px solid rgba(16, 185, 129, 0.2);
                border-radius: 16px;
                padding: 16px;
                margin-bottom: 20px;
                position: relative;
                overflow: hidden;
            }
            .cc-transfer-source::before {
                content: '';
                position: absolute;
                top: -50%;
                right: -30%;
                width: 150px;
                height: 150px;
                background: radial-gradient(circle, rgba(16, 185, 129, 0.15) 0%, transparent 70%);
                pointer-events: none;
            }
            .cc-transfer-source-label {
                color: rgba(16, 185, 129, 0.8);
                font-size: 10px;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.08em;
                margin: 0 0 8px 0;
                display: flex;
                align-items: center;
                gap: 6px;
            }
            .cc-transfer-source-label svg {
                width: 12px;
                height: 12px;
            }
            .cc-transfer-source-name {
                color: #fff;
                font-size: 16px;
                font-weight: 600;
                margin: 0 0 4px 0;
            }
            .cc-transfer-source-balance {
                display: flex;
                align-items: baseline;
                gap: 6px;
            }
            .cc-transfer-source-amount {
                color: var(--cc-accent-green);
                font-size: 24px;
                font-weight: 700;
                font-family: 'SF Mono', ui-monospace, monospace;
                letter-spacing: -0.02em;
            }
            .cc-transfer-source-unit {
                color: rgba(16, 185, 129, 0.6);
                font-size: 14px;
                font-weight: 500;
            }

            /* Recipients section */
            .cc-transfer-section-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 12px;
            }
            .cc-transfer-section-title {
                color: rgba(255, 255, 255, 0.5);
                font-size: 11px;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.06em;
                margin: 0;
            }
            .cc-transfer-recipient-count {
                color: rgba(255, 255, 255, 0.3);
                font-size: 11px;
                font-weight: 500;
            }
            .cc-transfer-recipients {
                max-height: 240px;
                overflow-y: auto;
                margin-bottom: 12px;
                padding-right: 4px;
            }
            .cc-transfer-recipients::-webkit-scrollbar {
                width: 4px;
            }
            .cc-transfer-recipients::-webkit-scrollbar-thumb {
                background: rgba(255, 255, 255, 0.1);
                border-radius: 2px;
            }
            .cc-transfer-recipient-card {
                background: rgba(255, 255, 255, 0.03);
                border: 1px solid rgba(255, 255, 255, 0.06);
                border-radius: 14px;
                padding: 14px;
                margin-bottom: 8px;
                transition: all 0.2s ease;
            }
            .cc-transfer-recipient-card:last-child {
                margin-bottom: 0;
            }
            .cc-transfer-recipient-card:hover {
                border-color: rgba(255, 255, 255, 0.1);
            }
            .cc-transfer-recipient-row {
                display: flex;
                gap: 10px;
                align-items: stretch;
            }
            .cc-transfer-recipient-select-wrap {
                flex: 1;
                min-width: 0;
            }
            .cc-transfer-recipient-select {
                width: 100%;
                padding: 12px 36px 12px 14px;
                background: rgba(0, 0, 0, 0.4);
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 10px;
                color: #fff;
                font-size: 13px;
                font-family: inherit;
                outline: none;
                cursor: pointer;
                appearance: none;
                background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='rgba(255,255,255,0.5)' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
                background-repeat: no-repeat;
                background-position: right 12px center;
                transition: all 0.2s ease;
            }
            .cc-transfer-recipient-select:focus {
                border-color: var(--cc-accent-green);
                box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.12);
            }
            .cc-transfer-amount-wrap {
                width: 100px;
                position: relative;
            }
            .cc-transfer-amount-input {
                width: 100%;
                padding: 12px 14px;
                background: rgba(0, 0, 0, 0.4);
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 10px;
                color: #fff;
                font-size: 14px;
                font-family: 'SF Mono', ui-monospace, monospace;
                font-weight: 500;
                outline: none;
                text-align: right;
                transition: all 0.2s ease;
            }
            .cc-transfer-amount-input::placeholder {
                color: rgba(255, 255, 255, 0.25);
            }
            .cc-transfer-amount-input:focus {
                border-color: var(--cc-accent-green);
                box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.12);
            }
            .cc-transfer-recipient-remove {
                width: 40px;
                height: 40px;
                background: rgba(239, 68, 68, 0.08);
                border: 1px solid rgba(239, 68, 68, 0.15);
                border-radius: 10px;
                color: #ef4444;
                font-size: 16px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.2s ease;
                flex-shrink: 0;
            }
            .cc-transfer-recipient-remove:hover {
                background: rgba(239, 68, 68, 0.15);
                border-color: rgba(239, 68, 68, 0.3);
            }
            .cc-transfer-external-input {
                width: 100%;
                padding: 10px 14px;
                margin-top: 10px;
                background: rgba(0, 0, 0, 0.3);
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 8px;
                color: #fff;
                font-size: 12px;
                font-family: 'SF Mono', ui-monospace, monospace;
                outline: none;
                transition: all 0.2s ease;
            }
            .cc-transfer-external-input::placeholder {
                color: rgba(255, 255, 255, 0.25);
            }
            .cc-transfer-external-input:focus {
                border-color: var(--cc-accent-blue);
                box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.12);
            }

            /* Add recipient button */
            .cc-transfer-add-btn {
                width: 100%;
                padding: 12px;
                background: transparent;
                border: 1px dashed rgba(59, 130, 246, 0.3);
                border-radius: 12px;
                color: var(--cc-accent-blue);
                font-size: 13px;
                font-weight: 500;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                transition: all 0.2s ease;
                margin-bottom: 16px;
            }
            .cc-transfer-add-btn:hover {
                background: rgba(59, 130, 246, 0.08);
                border-color: rgba(59, 130, 246, 0.5);
            }
            .cc-transfer-add-btn:disabled {
                opacity: 0.3;
                cursor: not-allowed;
            }
            .cc-transfer-add-btn svg {
                width: 16px;
                height: 16px;
            }

            /* Wallet Card Grid */
            .cc-transfer-wallet-grid {
                display: grid;
                grid-template-columns: repeat(2, 1fr);
                gap: 10px;
                margin-bottom: 16px;
                max-height: 220px;
                overflow-y: auto;
                padding: 2px;
            }
            .cc-transfer-wallet-card {
                background: rgba(255, 255, 255, 0.03);
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 12px;
                padding: 12px;
                cursor: pointer;
                transition: all 0.2s ease;
                position: relative;
            }
            .cc-transfer-wallet-card:hover {
                background: rgba(255, 255, 255, 0.06);
                border-color: rgba(255, 255, 255, 0.15);
            }
            .cc-transfer-wallet-card.selected {
                background: rgba(16, 185, 129, 0.1);
                border-color: rgba(16, 185, 129, 0.4);
            }
            .cc-transfer-wallet-card-content {
                display: flex;
                align-items: center;
                gap: 10px;
            }
            .cc-transfer-wallet-icon {
                font-size: 20px;
                flex-shrink: 0;
            }
            .cc-transfer-wallet-info {
                flex: 1;
                min-width: 0;
            }
            .cc-transfer-wallet-name {
                font-size: 13px;
                font-weight: 600;
                color: #fff;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                margin-bottom: 2px;
            }
            .cc-transfer-wallet-addr {
                font-size: 10px;
                color: rgba(255, 255, 255, 0.35);
                font-family: 'SF Mono', monospace;
            }
            .cc-transfer-wallet-balance {
                font-size: 11px;
                font-weight: 600;
                color: rgba(16, 185, 129, 0.9);
                font-family: 'SF Mono', monospace;
                margin-top: 4px;
            }
            .cc-transfer-modal.cc-privacy-mode .cc-transfer-wallet-balance {
                color: rgba(56, 189, 248, 0.9);
            }
            .cc-transfer-wallet-check {
                width: 20px;
                height: 20px;
                border-radius: 50%;
                background: rgba(255, 255, 255, 0.1);
                border: 1px solid rgba(255, 255, 255, 0.15);
                display: flex;
                align-items: center;
                justify-content: center;
                flex-shrink: 0;
                transition: all 0.2s ease;
            }
            .cc-transfer-wallet-check svg {
                width: 12px;
                height: 12px;
                stroke: transparent;
                transition: stroke 0.2s ease;
            }
            .cc-transfer-wallet-card.selected .cc-transfer-wallet-check {
                background: #10b981;
                border-color: #10b981;
            }
            .cc-transfer-wallet-card.selected .cc-transfer-wallet-check svg {
                stroke: #fff;
            }
            .cc-transfer-ext-addr-input {
                width: 100%;
                margin-top: 10px;
                padding: 8px 10px;
                background: rgba(0, 0, 0, 0.3);
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 8px;
                color: #fff;
                font-size: 12px;
                font-family: 'SF Mono', monospace;
            }
            .cc-transfer-ext-addr-input:focus {
                outline: none;
                border-color: rgba(59, 130, 246, 0.5);
            }
            .cc-transfer-wallet-card.external:not(.selected) .cc-transfer-ext-addr-input {
                display: none;
            }

            /* Add External Button */
            .cc-transfer-add-external-btn {
                background: rgba(255, 255, 255, 0.02);
                border: 1px dashed rgba(255, 255, 255, 0.15);
                border-radius: 12px;
                padding: 16px 12px;
                cursor: pointer;
                transition: all 0.2s ease;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                gap: 6px;
                min-height: 70px;
            }
            .cc-transfer-add-external-btn:hover {
                background: rgba(255, 255, 255, 0.05);
                border-color: rgba(255, 255, 255, 0.25);
            }
            .cc-transfer-add-external-btn svg {
                width: 20px;
                height: 20px;
                stroke: rgba(255, 255, 255, 0.4);
            }
            .cc-transfer-add-external-btn span {
                font-size: 11px;
                color: rgba(255, 255, 255, 0.4);
                font-weight: 500;
            }
            .cc-transfer-add-external-btn:hover svg {
                stroke: rgba(255, 255, 255, 0.7);
            }
            .cc-transfer-add-external-btn:hover span {
                color: rgba(255, 255, 255, 0.7);
            }
            .cc-transfer-modal.cc-privacy-mode .cc-transfer-add-external-btn:hover {
                border-color: rgba(56, 189, 248, 0.3);
            }
            .cc-transfer-modal.cc-privacy-mode .cc-transfer-add-external-btn:hover svg {
                stroke: rgba(56, 189, 248, 0.8);
            }
            .cc-transfer-modal.cc-privacy-mode .cc-transfer-add-external-btn:hover span {
                color: rgba(56, 189, 248, 0.8);
            }

            /* Amount Section */
            .cc-transfer-amount-section {
                background: rgba(255, 255, 255, 0.03);
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 12px;
                padding: 14px;
                margin-bottom: 16px;
            }
            .cc-transfer-amount-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 10px;
                font-size: 12px;
                color: rgba(255, 255, 255, 0.5);
            }
            .cc-transfer-global-amount {
                width: 100%;
                padding: 14px;
                background: rgba(0, 0, 0, 0.4);
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 10px;
                color: #fff;
                font-size: 18px;
                font-weight: 600;
                font-family: 'SF Mono', monospace;
                text-align: center;
            }
            .cc-transfer-global-amount:focus {
                outline: none;
                border-color: var(--cc-accent-blue);
            }
            .cc-transfer-global-amount::placeholder {
                color: rgba(255, 255, 255, 0.2);
            }

            /* Privacy mode card grid overrides */
            .cc-transfer-modal.cc-privacy-mode .cc-transfer-wallet-card.selected {
                background: rgba(56, 189, 248, 0.1);
                border-color: rgba(56, 189, 248, 0.4);
            }
            .cc-transfer-modal.cc-privacy-mode .cc-transfer-wallet-card.selected .cc-transfer-wallet-check {
                background: #0ea5e9;
                border-color: #0ea5e9;
            }
            .cc-transfer-modal.cc-privacy-mode .cc-transfer-global-amount:focus {
                border-color: #38bdf8;
            }

            /* Total and actions */
            .cc-transfer-summary {
                background: linear-gradient(135deg, rgba(16, 185, 129, 0.1) 0%, rgba(16, 185, 129, 0.03) 100%);
                border: 1px solid rgba(16, 185, 129, 0.2);
                border-radius: 14px;
                padding: 14px 16px;
                margin-bottom: 16px;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .cc-transfer-summary-label {
                color: rgba(16, 185, 129, 0.9);
                font-size: 12px;
                font-weight: 600;
            }
            .cc-transfer-summary-value {
                color: var(--cc-accent-green);
                font-size: 18px;
                font-weight: 700;
                font-family: 'SF Mono', ui-monospace, monospace;
            }
            .cc-transfer-even-split {
                background: rgba(168, 85, 247, 0.1);
                border: 1px solid rgba(168, 85, 247, 0.2);
                border-radius: 8px;
                padding: 8px 12px;
                color: var(--cc-accent-purple);
                font-size: 11px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s ease;
            }
            .cc-transfer-even-split:hover {
                background: rgba(168, 85, 247, 0.18);
                border-color: rgba(168, 85, 247, 0.35);
            }
            .cc-transfer-error {
                background: rgba(239, 68, 68, 0.1);
                border: 1px solid rgba(239, 68, 68, 0.2);
                border-radius: 10px;
                padding: 10px 14px;
                margin-bottom: 12px;
                color: #ef4444;
                font-size: 12px;
                display: none;
            }
            .cc-transfer-error.visible {
                display: block;
            }
            .cc-transfer-actions {
                display: flex;
                gap: 10px;
            }
            .cc-transfer-send-btn {
                flex: 1;
                padding: 16px;
                background: linear-gradient(135deg, #10b981 0%, #059669 100%);
                border: none;
                border-radius: 14px;
                color: #fff;
                font-size: 15px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s ease;
                box-shadow: 0 4px 16px rgba(16, 185, 129, 0.3);
            }
            .cc-transfer-send-btn:hover {
                background: linear-gradient(135deg, #34d399 0%, #10b981 100%);
                transform: translateY(-1px);
                box-shadow: 0 6px 24px rgba(16, 185, 129, 0.4);
            }
            .cc-transfer-send-btn:disabled {
                opacity: 0.5;
                cursor: not-allowed;
                transform: none;
                box-shadow: none;
            }
            .cc-transfer-cancel-btn {
                padding: 16px 24px;
                background: rgba(255, 255, 255, 0.04);
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 14px;
                color: rgba(255, 255, 255, 0.7);
                font-size: 15px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.2s ease;
            }
            .cc-transfer-cancel-btn:hover {
                background: rgba(255, 255, 255, 0.08);
                color: #fff;
            }

            /* ─────────────────────────────────────────────────────────────
               Privacy Mode Styles (Cyan/Blue Theme)
            ───────────────────────────────────────────────────────────── */
            .cc-transfer-modal.cc-privacy-mode {
                background: linear-gradient(180deg, #0a0f14 0%, #060a0d 100%);
                border-color: rgba(56, 189, 248, 0.15);
                box-shadow:
                    0 -4px 60px rgba(0, 0, 0, 0.6),
                    0 0 0 1px rgba(56, 189, 248, 0.1),
                    0 0 60px rgba(56, 189, 248, 0.05);
            }
            .cc-transfer-modal.cc-privacy-mode .cc-transfer-modal-title {
                color: #7dd3fc;
            }
            .cc-transfer-modal.cc-privacy-mode .cc-transfer-source {
                background: rgba(56, 189, 248, 0.06);
                border-color: rgba(56, 189, 248, 0.15);
            }
            .cc-transfer-modal.cc-privacy-mode .cc-transfer-source-label {
                color: #38bdf8;
            }
            .cc-transfer-modal.cc-privacy-mode .cc-transfer-source-amount {
                color: #38bdf8;
            }
            .cc-transfer-modal.cc-privacy-mode .cc-transfer-add-btn {
                border-color: rgba(56, 189, 248, 0.3);
                color: #38bdf8;
            }
            .cc-transfer-modal.cc-privacy-mode .cc-transfer-add-btn:hover {
                background: rgba(56, 189, 248, 0.08);
                border-color: rgba(56, 189, 248, 0.5);
            }
            .cc-transfer-modal.cc-privacy-mode .cc-transfer-send-btn {
                background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%);
                box-shadow: 0 4px 16px rgba(14, 165, 233, 0.3);
            }
            .cc-transfer-modal.cc-privacy-mode .cc-transfer-send-btn:hover {
                background: linear-gradient(135deg, #38bdf8 0%, #0ea5e9 100%);
                box-shadow: 0 6px 24px rgba(56, 189, 248, 0.4);
            }
            .cc-transfer-modal.cc-privacy-mode .cc-transfer-recipient-input:focus {
                border-color: #38bdf8;
                box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.12);
            }
            .cc-transfer-modal.cc-privacy-mode .cc-transfer-summary {
                background: linear-gradient(135deg, rgba(56, 189, 248, 0.1) 0%, rgba(56, 189, 248, 0.03) 100%);
                border-color: rgba(56, 189, 248, 0.2);
            }
            .cc-transfer-modal.cc-privacy-mode .cc-transfer-summary-label {
                color: rgba(56, 189, 248, 0.9);
            }
            .cc-transfer-modal.cc-privacy-mode .cc-transfer-summary-value {
                color: #38bdf8;
            }
            .cc-transfer-title-wrapper {
                display: flex;
                flex-direction: column;
                gap: 6px;
            }
            .cc-transfer-privacy-badge {
                display: inline-flex;
                align-items: center;
                gap: 5px;
                padding: 4px 10px;
                background: rgba(56, 189, 248, 0.12);
                border: 1px solid rgba(56, 189, 248, 0.2);
                border-radius: 20px;
                font-size: 11px;
                font-weight: 600;
                color: #7dd3fc;
                letter-spacing: 0.02em;
                width: fit-content;
            }
            .cc-transfer-privacy-badge svg {
                width: 12px;
                height: 12px;
                stroke: #38bdf8;
            }

            .cc-bulk-buy-btn {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                width: 100%;
                padding: 11px;
                background: rgba(168, 85, 247, 0.1);
                border: 1px solid rgba(168, 85, 247, 0.2);
                border-radius: 10px;
                cursor: pointer;
                color: var(--cc-accent-purple);
                font-size: 13px;
                font-weight: 600;
                transition: all 0.2s ease;
                margin-bottom: 10px;
            }
            .cc-bulk-buy-btn:hover {
                background: rgba(168, 85, 247, 0.15);
                border-color: rgba(168, 85, 247, 0.35);
            }
            .cc-bulk-buy-btn:active {
                transform: scale(0.98);
            }
            .cc-bulk-buy-btn:disabled {
                opacity: 0.4;
                cursor: not-allowed;
            }

            /* ─────────────────────────────────────────────────────────────
               Bulk Buy Modal (Bottom Sheet)
            ───────────────────────────────────────────────────────────── */
            .cc-bulk-modal {
                position: fixed;
                bottom: 0;
                left: 0;
                right: 0;
                background: linear-gradient(180deg, #18141f 0%, #0d0b12 100%);
                border-radius: 28px 28px 0 0;
                padding: 0;
                max-height: 94vh;
                overflow: hidden;
                z-index: 100002;
                transform: translateY(100%);
                transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
                box-shadow:
                    0 -4px 60px rgba(0, 0, 0, 0.6),
                    0 0 0 1px rgba(168, 85, 247, 0.1);
            }
            .cc-bulk-modal.visible {
                transform: translateY(0);
            }
            @media (min-width: 481px) {
                .cc-bulk-modal {
                    top: 50%;
                    left: 50%;
                    bottom: auto;
                    right: auto;
                    transform: translate(-50%, -50%) scale(0.95);
                    opacity: 0;
                    border-radius: 24px;
                    width: 480px;
                    max-height: 85vh;
                }
                .cc-bulk-modal.visible {
                    transform: translate(-50%, -50%) scale(1);
                    opacity: 1;
                }
            }
            .cc-bulk-modal-handle {
                width: 40px;
                height: 4px;
                background: rgba(168, 85, 247, 0.25);
                border-radius: 2px;
                margin: 12px auto 0;
            }
            @media (min-width: 481px) {
                .cc-bulk-modal-handle {
                    display: none;
                }
            }
            .cc-bulk-modal-content {
                padding: 20px 24px;
                padding-bottom: calc(24px + env(safe-area-inset-bottom));
                overflow-y: auto;
                max-height: calc(94vh - 16px);
            }
            @media (min-width: 481px) {
                .cc-bulk-modal-content {
                    padding-bottom: 24px;
                    max-height: calc(85vh - 16px);
                }
            }
            .cc-bulk-modal-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 20px;
            }
            .cc-bulk-modal-title {
                color: #fff;
                font-size: 20px;
                font-weight: 600;
                margin: 0;
                letter-spacing: -0.02em;
                display: flex;
                align-items: center;
                gap: 10px;
            }
            .cc-bulk-modal-title svg {
                width: 22px;
                height: 22px;
                color: var(--cc-accent-purple);
            }
            .cc-bulk-modal-close {
                width: 36px;
                height: 36px;
                border-radius: 50%;
                background: rgba(255, 255, 255, 0.06);
                border: 1px solid rgba(255, 255, 255, 0.08);
                color: rgba(255, 255, 255, 0.6);
                font-size: 18px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.2s ease;
            }
            .cc-bulk-modal-close:hover {
                background: rgba(255, 255, 255, 0.1);
                color: #fff;
            }

            /* Token input hero */
            .cc-bulk-token-section {
                background: linear-gradient(135deg, rgba(168, 85, 247, 0.12) 0%, rgba(168, 85, 247, 0.04) 100%);
                border: 1px solid rgba(168, 85, 247, 0.2);
                border-radius: 16px;
                padding: 16px;
                margin-bottom: 20px;
            }
            .cc-bulk-token-label {
                color: rgba(168, 85, 247, 0.8);
                font-size: 10px;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.08em;
                margin: 0 0 10px 0;
            }
            .cc-bulk-token-input {
                width: 100%;
                padding: 14px 16px;
                background: rgba(0, 0, 0, 0.4);
                border: 1px solid rgba(168, 85, 247, 0.15);
                border-radius: 12px;
                color: #fff;
                font-size: 13px;
                font-family: 'SF Mono', ui-monospace, monospace;
                outline: none;
                transition: all 0.2s ease;
            }
            .cc-bulk-token-input::placeholder {
                color: rgba(255, 255, 255, 0.25);
            }
            .cc-bulk-token-input:focus {
                border-color: var(--cc-accent-purple);
                box-shadow: 0 0 0 3px rgba(168, 85, 247, 0.12);
            }
            .cc-bulk-total-row {
                display: flex;
                gap: 12px;
                margin-top: 12px;
            }
            .cc-bulk-total-input-wrap {
                flex: 1;
            }
            .cc-bulk-total-input {
                width: 100%;
                padding: 12px 14px;
                background: rgba(0, 0, 0, 0.3);
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 10px;
                color: #fff;
                font-size: 14px;
                font-family: 'SF Mono', ui-monospace, monospace;
                font-weight: 500;
                outline: none;
                transition: all 0.2s ease;
            }
            .cc-bulk-total-input::placeholder {
                color: rgba(255, 255, 255, 0.25);
            }
            .cc-bulk-total-input:focus {
                border-color: var(--cc-accent-purple);
                box-shadow: 0 0 0 3px rgba(168, 85, 247, 0.12);
            }
            .cc-bulk-split-btn {
                padding: 12px 18px;
                background: rgba(168, 85, 247, 0.15);
                border: 1px solid rgba(168, 85, 247, 0.25);
                border-radius: 10px;
                color: var(--cc-accent-purple);
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                white-space: nowrap;
                transition: all 0.2s ease;
            }
            .cc-bulk-split-btn:hover {
                background: rgba(168, 85, 247, 0.25);
                border-color: rgba(168, 85, 247, 0.4);
            }

            /* Wallet selection section */
            .cc-bulk-wallets-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 12px;
            }
            .cc-bulk-wallets-title {
                color: rgba(255, 255, 255, 0.5);
                font-size: 11px;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.06em;
                margin: 0;
            }
            .cc-bulk-select-all {
                display: flex;
                align-items: center;
                gap: 8px;
                cursor: pointer;
            }
            .cc-bulk-select-all input {
                width: 16px;
                height: 16px;
                accent-color: var(--cc-accent-purple);
                cursor: pointer;
            }
            .cc-bulk-select-all span {
                color: rgba(255, 255, 255, 0.5);
                font-size: 11px;
            }

            /* Wallet list */
            .cc-bulk-wallet-list {
                max-height: 220px;
                overflow-y: auto;
                margin-bottom: 16px;
                padding-right: 4px;
            }
            .cc-bulk-wallet-list::-webkit-scrollbar {
                width: 4px;
            }
            .cc-bulk-wallet-list::-webkit-scrollbar-thumb {
                background: rgba(168, 85, 247, 0.2);
                border-radius: 2px;
            }
            .cc-bulk-wallet-card {
                display: flex;
                align-items: center;
                gap: 12px;
                background: rgba(255, 255, 255, 0.03);
                border: 1px solid rgba(255, 255, 255, 0.06);
                border-radius: 14px;
                padding: 12px 14px;
                margin-bottom: 8px;
                transition: all 0.2s ease;
            }
            .cc-bulk-wallet-card:last-child {
                margin-bottom: 0;
            }
            .cc-bulk-wallet-card:hover {
                border-color: rgba(255, 255, 255, 0.1);
            }
            .cc-bulk-wallet-card.selected {
                background: rgba(168, 85, 247, 0.08);
                border-color: rgba(168, 85, 247, 0.25);
            }
            .cc-bulk-wallet-checkbox {
                width: 20px;
                height: 20px;
                accent-color: var(--cc-accent-purple);
                cursor: pointer;
                flex-shrink: 0;
            }
            .cc-bulk-wallet-info {
                flex: 1;
                min-width: 0;
            }
            .cc-bulk-wallet-name {
                color: #fff;
                font-size: 13px;
                font-weight: 500;
                margin: 0 0 2px 0;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .cc-bulk-wallet-balance {
                color: rgba(255, 255, 255, 0.4);
                font-size: 11px;
                font-family: 'SF Mono', ui-monospace, monospace;
                margin: 0;
            }
            .cc-bulk-wallet-amount {
                width: 90px;
                padding: 10px 12px;
                background: rgba(0, 0, 0, 0.4);
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 10px;
                color: #fff;
                font-size: 13px;
                font-family: 'SF Mono', ui-monospace, monospace;
                font-weight: 500;
                text-align: right;
                outline: none;
                flex-shrink: 0;
                transition: all 0.2s ease;
            }
            .cc-bulk-wallet-amount::placeholder {
                color: rgba(255, 255, 255, 0.2);
            }
            .cc-bulk-wallet-amount:focus {
                border-color: var(--cc-accent-purple);
                box-shadow: 0 0 0 3px rgba(168, 85, 247, 0.12);
            }
            .cc-bulk-wallet-amount:disabled {
                opacity: 0.3;
                cursor: not-allowed;
            }

            /* Summary */
            .cc-bulk-summary {
                display: flex;
                gap: 16px;
                background: linear-gradient(135deg, rgba(168, 85, 247, 0.1) 0%, rgba(168, 85, 247, 0.03) 100%);
                border: 1px solid rgba(168, 85, 247, 0.2);
                border-radius: 14px;
                padding: 14px 18px;
                margin-bottom: 16px;
            }
            .cc-bulk-summary-item {
                flex: 1;
            }
            .cc-bulk-summary-label {
                color: rgba(168, 85, 247, 0.7);
                font-size: 10px;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.05em;
                margin: 0 0 4px 0;
            }
            .cc-bulk-summary-value {
                color: var(--cc-accent-purple);
                font-size: 18px;
                font-weight: 700;
                font-family: 'SF Mono', ui-monospace, monospace;
                margin: 0;
            }

            /* Error */
            .cc-bulk-error {
                background: rgba(239, 68, 68, 0.1);
                border: 1px solid rgba(239, 68, 68, 0.2);
                border-radius: 10px;
                padding: 10px 14px;
                margin-bottom: 12px;
                color: #ef4444;
                font-size: 12px;
                display: none;
            }
            .cc-bulk-error.visible {
                display: block;
            }

            /* Actions */
            .cc-bulk-actions {
                display: flex;
                gap: 10px;
            }
            .cc-bulk-execute-btn {
                flex: 1;
                padding: 16px;
                background: linear-gradient(135deg, #8b5cf6 0%, #a855f7 100%);
                border: none;
                border-radius: 14px;
                color: #fff;
                font-size: 15px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s ease;
                box-shadow: 0 4px 16px rgba(168, 85, 247, 0.3);
            }
            .cc-bulk-execute-btn:hover {
                background: linear-gradient(135deg, #a78bfa 0%, #c084fc 100%);
                transform: translateY(-1px);
                box-shadow: 0 6px 24px rgba(168, 85, 247, 0.4);
            }
            .cc-bulk-execute-btn:disabled {
                opacity: 0.5;
                cursor: not-allowed;
                transform: none;
                box-shadow: none;
            }
            .cc-bulk-cancel-btn {
                padding: 16px 24px;
                background: rgba(255, 255, 255, 0.04);
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 14px;
                color: rgba(255, 255, 255, 0.7);
                font-size: 15px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.2s ease;
            }
            .cc-bulk-cancel-btn:hover {
                background: rgba(255, 255, 255, 0.08);
                color: #fff;
            }

            /* Legacy swap styles (keep for compatibility) */
            .cc-swap-wallet-list {
                max-height: 180px;
                overflow-y: auto;
                margin-bottom: 10px;
            }
            .cc-swap-wallet-item {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 8px 10px;
                background: var(--cc-bg-secondary);
                border: 1px solid var(--cc-border);
                border-radius: 8px;
                margin-bottom: 6px;
                transition: all 0.2s ease;
            }
            .cc-swap-wallet-item:last-child {
                margin-bottom: 0;
            }
            .cc-swap-wallet-item.selected {
                background: rgba(168, 85, 247, 0.08);
                border-color: rgba(168, 85, 247, 0.25);
            }
            .cc-swap-wallet-checkbox {
                width: 16px;
                height: 16px;
                accent-color: var(--cc-accent-purple);
                cursor: pointer;
                flex-shrink: 0;
            }
            .cc-swap-wallet-info {
                flex: 1;
                min-width: 0;
            }
            .cc-swap-wallet-name {
                font-size: 12px;
                font-weight: 500;
                color: var(--cc-text-primary);
                margin: 0 0 1px 0;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .cc-swap-wallet-balance {
                font-size: 10px;
                color: var(--cc-text-tertiary);
                font-family: 'SF Mono', ui-monospace, monospace;
            }
            .cc-swap-wallet-amount {
                width: 70px;
                padding: 6px 8px;
                background: rgba(0, 0, 0, 0.3);
                border: 1px solid var(--cc-border);
                border-radius: 6px;
                color: var(--cc-text-primary);
                font-size: 12px;
                font-family: 'SF Mono', ui-monospace, monospace;
                text-align: right;
                flex-shrink: 0;
            }
            .cc-swap-wallet-amount:focus {
                border-color: var(--cc-accent-purple);
                outline: none;
            }
            .cc-swap-wallet-amount:disabled {
                opacity: 0.35;
                cursor: not-allowed;
            }
            .cc-swap-token-input {
                width: 100%;
                padding: 10px 12px;
                background: rgba(0, 0, 0, 0.3);
                border: 1px solid var(--cc-border);
                border-radius: 8px;
                color: var(--cc-text-primary);
                font-size: 12px;
                font-family: 'SF Mono', ui-monospace, monospace;
                outline: none;
            }
            .cc-swap-token-input:focus {
                border-color: var(--cc-accent-purple);
            }
            .cc-swap-token-input::placeholder {
                color: var(--cc-text-tertiary);
            }
            .cc-bulk-inputs-row {
                display: flex;
                gap: 8px;
                margin-bottom: 10px;
            }
            .cc-swap-summary {
                display: flex;
                justify-content: space-around;
                padding: 10px 12px;
                background: rgba(168, 85, 247, 0.08);
                border: 1px solid rgba(168, 85, 247, 0.15);
                border-radius: 8px;
                margin-bottom: 10px;
            }
            .cc-swap-summary-item {
                text-align: center;
            }
            .cc-swap-summary-label {
                font-size: 9px;
                color: var(--cc-text-tertiary);
                text-transform: uppercase;
                letter-spacing: 0.3px;
            }
            .cc-swap-summary-value {
                font-size: 13px;
                font-weight: 600;
                color: var(--cc-accent-purple);
                margin-top: 1px;
            }
            .cc-select-all-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 6px 0;
                margin-bottom: 6px;
                border-bottom: 1px solid var(--cc-border);
            }
            .cc-select-all-label {
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 11px;
                color: var(--cc-text-secondary);
                cursor: pointer;
            }
            .cc-equal-split-btn {
                background: rgba(168, 85, 247, 0.12);
                border: none;
                padding: 4px 8px;
                border-radius: 4px;
                color: var(--cc-accent-purple);
                font-size: 10px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.15s ease;
            }
            .cc-equal-split-btn:hover {
                background: rgba(168, 85, 247, 0.2);
            }

            /* ─────────────────────────────────────────────────────────────
               Toasts & Notifications
            ───────────────────────────────────────────────────────────── */
            .cc-burner-copied {
                position: fixed;
                bottom: 24px;
                left: 50%;
                transform: translateX(-50%);
                background: var(--cc-bg-elevated);
                border: 1px solid var(--cc-border);
                color: var(--cc-text-primary);
                padding: 10px 16px;
                border-radius: 10px;
                font-size: 12px;
                z-index: 100001;
                animation: ccFadeInOut 2s ease forwards;
            }
            @keyframes ccFadeInOut {
                0% { opacity: 0; transform: translateX(-50%) translateY(8px); }
                15% { opacity: 1; transform: translateX(-50%) translateY(0); }
                85% { opacity: 1; transform: translateX(-50%) translateY(0); }
                100% { opacity: 0; transform: translateX(-50%) translateY(-8px); }
            }
            .cc-error-toast {
                position: fixed;
                bottom: 24px;
                left: 50%;
                transform: translateX(-50%);
                background: rgba(220, 38, 38, 0.95);
                color: #fff;
                padding: 12px 18px;
                border-radius: 12px;
                font-size: 13px;
                font-weight: 500;
                z-index: 100001;
                max-width: 90%;
                text-align: center;
                box-shadow: 0 8px 24px rgba(220, 38, 38, 0.35);
                animation: ccErrorSlideIn 0.3s ease forwards;
                cursor: pointer;
            }
            .cc-error-toast:hover {
                background: rgba(185, 28, 28, 0.95);
            }
            .cc-error-toast-title {
                display: flex;
                align-items: center;
                gap: 6px;
                margin-bottom: 3px;
            }
            .cc-error-toast-title svg {
                width: 16px;
                height: 16px;
                flex-shrink: 0;
            }
            .cc-error-toast-message {
                font-size: 12px;
                opacity: 0.9;
                word-break: break-word;
            }
            @keyframes ccErrorSlideIn {
                0% { opacity: 0; transform: translateX(-50%) translateY(16px); }
                100% { opacity: 1; transform: translateX(-50%) translateY(0); }
            }
            @keyframes ccErrorSlideOut {
                0% { opacity: 1; transform: translateX(-50%) translateY(0); }
                100% { opacity: 0; transform: translateX(-50%) translateY(-8px); }
            }

            /* ─────────────────────────────────────────────────────────────
               Burner Actions (Generate/Import)
            ───────────────────────────────────────────────────────────── */
            .cc-burner-generate {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                width: 100%;
                padding: 11px;
                background: rgba(255, 153, 85, 0.1);
                border: 1px dashed rgba(255, 153, 85, 0.3);
                border-radius: 10px;
                cursor: pointer;
                color: var(--cc-accent-orange);
                font-size: 13px;
                font-weight: 500;
                transition: all 0.2s ease;
            }
            .cc-burner-generate:hover {
                background: rgba(255, 153, 85, 0.15);
                border-color: rgba(255, 153, 85, 0.5);
            }
            .cc-burner-generate:active {
                transform: scale(0.98);
            }
            .cc-burner-actions {
                display: flex;
                gap: 6px;
                margin-bottom: 6px;
            }
            .cc-burner-actions button {
                flex: 1;
            }
            .cc-burner-import {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                width: 100%;
                padding: 11px;
                background: rgba(168, 85, 247, 0.1);
                border: 1px dashed rgba(168, 85, 247, 0.3);
                border-radius: 10px;
                cursor: pointer;
                color: var(--cc-accent-purple);
                font-size: 13px;
                font-weight: 500;
                transition: all 0.2s ease;
            }
            .cc-burner-import:hover {
                background: rgba(168, 85, 247, 0.15);
                border-color: rgba(168, 85, 247, 0.5);
            }
            .cc-import-form {
                display: none;
                flex-direction: column;
                gap: 8px;
                padding: 12px;
                background: rgba(168, 85, 247, 0.06);
                border: 1px solid rgba(168, 85, 247, 0.15);
                border-radius: 10px;
                margin-bottom: 6px;
            }
            .cc-import-form.visible {
                display: flex;
            }
            .cc-import-form input {
                width: 100%;
                padding: 10px;
                background: rgba(0, 0, 0, 0.3);
                border: 1px solid var(--cc-border);
                border-radius: 6px;
                color: var(--cc-text-primary);
                font-family: 'SF Mono', ui-monospace, monospace;
                font-size: 11px;
                outline: none;
                transition: border-color 0.2s;
            }
            .cc-import-form input:focus {
                border-color: var(--cc-accent-purple);
            }
            .cc-import-form input::placeholder {
                color: var(--cc-text-tertiary);
            }
            .cc-import-form-actions {
                display: flex;
                gap: 6px;
            }
            .cc-import-form button {
                flex: 1;
                padding: 9px;
                border-radius: 6px;
                font-size: 12px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.2s ease;
            }
            .cc-import-confirm {
                background: var(--cc-accent-purple);
                border: none;
                color: #fff;
            }
            .cc-import-confirm:hover {
                background: #9333ea;
            }
            .cc-import-confirm:disabled {
                opacity: 0.4;
                cursor: not-allowed;
            }
            .cc-import-cancel {
                background: transparent;
                border: 1px solid var(--cc-border);
                color: var(--cc-text-secondary);
            }
            .cc-import-cancel:hover {
                background: var(--cc-bg-secondary);
                color: var(--cc-text-primary);
            }
            .cc-import-error {
                font-size: 10px;
                color: var(--cc-accent-red);
                padding: 5px 8px;
                background: rgba(239, 68, 68, 0.08);
                border-radius: 4px;
            }
            .cc-burner-empty {
                text-align: center;
                padding: 20px;
                color: var(--cc-text-tertiary);
                font-size: 12px;
            }
            .cc-burner-warning {
                font-size: 10px;
                color: rgba(255, 200, 100, 0.7);
                text-align: center;
                margin-top: 10px;
                padding: 8px;
                background: rgba(255, 200, 100, 0.06);
                border-radius: 6px;
                line-height: 1.4;
            }

            /* ─────────────────────────────────────────────────────────────
               Header Button
            ───────────────────────────────────────────────────────────── */
            .cc-header-container {
                display: inline-flex;
                align-items: center;
                gap: 8px;
            }
            .cc-header-btn {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 9px 14px;
                background: linear-gradient(135deg, var(--cc-primary, #10b981), var(--cc-accent, #34d399));
                border: none;
                border-radius: 10px;
                color: #fff;
                font-size: 13px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s ease;
                box-shadow: 0 2px 8px rgba(16, 185, 129, 0.25);
            }
            .cc-header-btn:hover {
                transform: translateY(-1px);
                box-shadow: 0 4px 12px rgba(16, 185, 129, 0.35);
            }
            .cc-header-btn:active {
                transform: translateY(0);
            }
            .cc-header-btn.connected {
                background: var(--cc-bg-secondary);
                border: 1px solid var(--cc-border);
                box-shadow: none;
            }
            .cc-header-btn.connected:hover {
                background: var(--cc-bg-elevated);
                box-shadow: none;
            }
            .cc-header-btn-icon {
                width: 16px;
                height: 16px;
            }
            .cc-header-btn-address {
                font-family: 'SF Mono', ui-monospace, monospace;
                font-size: 12px;
                font-weight: 500;
            }
            .cc-header-btn-dot {
                width: 7px;
                height: 7px;
                background: var(--cc-accent-green);
                border-radius: 50%;
                animation: ccPulse 2s ease-in-out infinite;
            }
            @keyframes ccPulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.4; }
            }

            /* Reconnect Overlay */
            .cc-reconnect-overlay {
                position: fixed;
                inset: 0;
                background: rgba(0, 0, 0, 0.85);
                backdrop-filter: blur(4px);
                z-index: 99998;
                display: none;
                align-items: center;
                justify-content: center;
                flex-direction: column;
                gap: 14px;
            }
            .cc-reconnect-overlay.visible {
                display: flex;
            }
            .cc-reconnect-spinner {
                width: 36px;
                height: 36px;
                border: 2px solid rgba(255, 255, 255, 0.08);
                border-top-color: var(--cc-primary, #10b981);
                border-radius: 50%;
                animation: ccSpin 0.8s linear infinite;
            }
            @keyframes ccSpin {
                to { transform: rotate(360deg); }
            }
            .cc-reconnect-text {
                color: var(--cc-text-secondary);
                font-size: 13px;
            }

            /* ═══════════════════════════════════════════════════════════════
               MOBILE RESPONSIVE STYLES
            ═══════════════════════════════════════════════════════════════ */
            @media (max-width: 480px) {
                .cc-modal {
                    position: fixed;
                    top: auto;
                    bottom: 0;
                    left: 0;
                    right: 0;
                    transform: translateY(100%);
                    width: 100%;
                    max-width: 100%;
                    max-height: 85vh;
                    border-radius: 20px 20px 0 0;
                    padding: 20px 16px;
                    padding-bottom: calc(20px + env(safe-area-inset-bottom));
                }
                .cc-modal-backdrop.visible .cc-modal {
                    transform: translateY(0);
                }

                /* Drag indicator for mobile bottom sheet */
                .cc-modal::before {
                    content: '';
                    position: absolute;
                    top: 8px;
                    left: 50%;
                    transform: translateX(-50%);
                    width: 36px;
                    height: 4px;
                    background: rgba(255, 255, 255, 0.15);
                    border-radius: 2px;
                }

                .cc-header {
                    margin-bottom: 20px;
                    margin-top: 12px;
                }
                .cc-title {
                    font-size: 22px;
                }
                .cc-subtitle {
                    font-size: 14px;
                }
                .cc-close-btn {
                    width: 40px;
                    height: 40px;
                    font-size: 24px;
                    top: 18px;
                    right: 18px;
                }

                .cc-wallet-list {
                    gap: 12px;
                }
                .cc-wallet-btn {
                    padding: 20px 18px;
                    border-radius: 16px;
                    gap: 16px;
                }
                .cc-wallet-icon {
                    width: 52px;
                    height: 52px;
                    border-radius: 14px;
                }
                .cc-wallet-name {
                    font-size: 18px;
                    margin-bottom: 4px;
                }
                .cc-wallet-status {
                    font-size: 14px;
                }
                .cc-last-used-badge {
                    font-size: 11px;
                    padding: 5px 10px;
                }
                .cc-privacy-notice {
                    padding: 16px 18px;
                    font-size: 15px;
                    gap: 12px;
                }
                .cc-privacy-notice svg {
                    width: 22px;
                    height: 22px;
                }

                .cc-quick-actions {
                    gap: 10px;
                }
                .cc-quick-action-btn {
                    padding: 18px 16px;
                    gap: 14px;
                    border-radius: 14px;
                }
                .cc-quick-action-icon {
                    width: 44px;
                    height: 44px;
                    font-size: 20px;
                    border-radius: 12px;
                }
                .cc-quick-action-title {
                    font-size: 16px;
                }
                .cc-quick-action-desc {
                    font-size: 13px;
                }

                .cc-connected-footer {
                    flex-direction: column;
                    gap: 10px;
                }
                .cc-switch-wallet-btn,
                .cc-disconnect-btn-small {
                    padding: 16px 18px;
                    font-size: 15px;
                }
                .cc-connected-wallet-info {
                    padding: 18px 16px;
                    gap: 14px;
                }
                .cc-connected-wallet-icon {
                    width: 48px;
                    height: 48px;
                    border-radius: 12px;
                }
                .cc-connected-wallet-name {
                    font-size: 17px;
                }
                .cc-connected-wallet-address {
                    font-size: 13px;
                }

                .cc-burner-header {
                    gap: 14px;
                    margin-bottom: 16px;
                }
                .cc-burner-back {
                    width: 44px;
                    height: 44px;
                    font-size: 20px;
                }
                .cc-burner-title {
                    font-size: 18px;
                }
                .cc-burner-list {
                    max-height: 300px;
                    margin-bottom: 16px;
                    gap: 10px;
                }
                .cc-burner-item-wrapper {
                    margin-bottom: 10px;
                }
                .cc-burner-item-header {
                    padding: 18px 16px;
                    gap: 14px;
                    border-radius: 14px;
                }
                .cc-burner-item-name {
                    font-size: 17px;
                }
                .cc-burner-item-address {
                    font-size: 13px;
                }
                .cc-burner-item-balance {
                    font-size: 15px;
                }
                .cc-burner-options-toggle {
                    width: 40px;
                    height: 40px;
                    font-size: 20px;
                }
                .cc-burner-actions-panel {
                    gap: 8px;
                    padding: 0 14px;
                }
                .cc-burner-actions-panel.open {
                    padding: 8px 14px 16px 14px;
                }
                .cc-burner-action {
                    padding: 16px 10px;
                    gap: 6px;
                }
                .cc-burner-action-icon {
                    font-size: 22px;
                }
                .cc-burner-action-label {
                    font-size: 12px;
                }

                .cc-burner-actions {
                    flex-direction: column;
                    gap: 10px;
                }
                .cc-burner-generate,
                .cc-burner-import {
                    padding: 16px;
                    font-size: 15px;
                }

                .cc-transfer-input,
                .cc-transfer-select,
                .cc-swap-token-input {
                    padding: 9px 10px;
                    font-size: 12px;
                }

                .cc-recipient-list {
                    max-height: 140px;
                }
                .cc-recipient-item {
                    padding: 7px 8px;
                    flex-wrap: wrap;
                }
                .cc-recipient-row {
                    flex: 1;
                    min-width: 100%;
                }
                .cc-recipient-amount {
                    width: 70px;
                }
                .cc-recipient-remove {
                    width: 26px;
                    height: 26px;
                    min-width: 26px;
                }

                .cc-swap-wallet-list {
                    max-height: 140px;
                }
                .cc-swap-wallet-item {
                    padding: 7px 8px;
                }
                .cc-swap-wallet-name {
                    font-size: 11px;
                }
                .cc-swap-wallet-balance {
                    font-size: 9px;
                }
                .cc-swap-wallet-amount {
                    width: 60px;
                    padding: 5px 6px;
                    font-size: 11px;
                }

                .cc-bulk-inputs-row {
                    flex-direction: column;
                    gap: 6px;
                }

                .cc-import-form {
                    padding: 10px;
                }
                .cc-import-form input {
                    padding: 9px;
                    font-size: 10px;
                }
                .cc-import-form button {
                    padding: 8px;
                    font-size: 11px;
                }

                .cc-header-btn {
                    padding: 8px 12px;
                    font-size: 12px;
                }
                .cc-header-btn-icon {
                    width: 14px;
                    height: 14px;
                }
            }

            /* Extra small screens */
            @media (max-width: 360px) {
                .cc-modal {
                    padding: 16px 12px;
                    padding-bottom: calc(16px + env(safe-area-inset-bottom));
                }
                .cc-burner-item-wrapper {
                    margin-bottom: 5px;
                }
                .cc-burner-item-header {
                    padding: 10px 12px;
                    gap: 8px;
                }
                .cc-burner-item-name {
                    font-size: 13px;
                }
                .cc-burner-options-toggle {
                    width: 28px;
                    height: 28px;
                    font-size: 14px;
                }
                .cc-burner-action {
                    padding: 10px 4px;
                }
            }
        `;
        document.head.appendChild(styles);

        // Apply theme CSS variables
        document.documentElement.style.setProperty('--cc-primary', this.config.theme.primaryColor);
        document.documentElement.style.setProperty('--cc-accent', this.config.theme.accentColor);
    }

    /**
     * Create the header connect button
     */
    createHeaderButton() {
        if (document.getElementById('cc-header-btn')) return;

        // Find mount point
        let mountPoint = null;
        if (this.config.mountTo) {
            if (typeof this.config.mountTo === 'string') {
                mountPoint = document.querySelector(this.config.mountTo);
            } else if (this.config.mountTo instanceof Element) {
                mountPoint = this.config.mountTo;
            }
        }

        // If no mount point specified, try common locations or create floating button
        if (!mountPoint) {
            // Try to find existing wallet button location
            mountPoint = document.querySelector('.wallet-status') ||
                         document.querySelector('[data-wallet-mount]') ||
                         document.querySelector('header nav') ||
                         document.querySelector('header');
        }

        // Create container
        const container = document.createElement('div');
        container.className = 'cc-header-container';
        container.id = 'cc-header-container';

        // Create button
        const btn = document.createElement('button');
        btn.className = 'cc-header-btn';
        btn.id = 'cc-header-btn';

        // Wallet icon SVG
        const icon = document.createElement('span');
        icon.innerHTML = `<svg class="cc-header-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>`;

        const text = document.createElement('span');
        text.className = 'cc-header-btn-text';
        text.textContent = 'Connect Wallet';

        btn.appendChild(icon);
        btn.appendChild(text);
        container.appendChild(btn);

        // Mount the button
        if (mountPoint) {
            // Replace existing connect button if found
            const existingBtn = mountPoint.querySelector('.connect-btn');
            if (existingBtn) {
                existingBtn.replaceWith(container);
            } else {
                mountPoint.appendChild(container);
            }
        } else {
            // Create a floating container if no mount point
            container.style.cssText = 'position: fixed; top: 20px; right: 20px; z-index: 9999;';
            document.body.appendChild(container);
        }

        // Add click handler
        btn.addEventListener('click', () => this.showOverlay());
    }

    /**
     * Create the reconnecting overlay
     */
    createReconnectOverlay() {
        if (document.getElementById('cc-reconnect-overlay')) return;

        const overlay = document.createElement('div');
        overlay.className = 'cc-reconnect-overlay';
        overlay.id = 'cc-reconnect-overlay';

        const spinner = document.createElement('div');
        spinner.className = 'cc-reconnect-spinner';

        const text = document.createElement('div');
        text.className = 'cc-reconnect-text';
        text.textContent = 'Reconnecting...';

        overlay.appendChild(spinner);
        overlay.appendChild(text);
        document.body.appendChild(overlay);
    }

    /**
     * Create the wallet selection modal using safe DOM methods
     */
    createWalletModal() {
        if (document.getElementById('cc-wallet-modal')) return;

        // Create backdrop
        const backdrop = document.createElement('div');
        backdrop.id = 'cc-wallet-modal';
        backdrop.className = 'cc-modal-backdrop';

        // Create modal
        const modal = document.createElement('div');
        modal.className = 'cc-modal';

        // Close button
        const closeBtn = document.createElement('button');
        closeBtn.className = 'cc-close-btn';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', () => this.hideOverlay());

        // Header
        const header = document.createElement('div');
        header.className = 'cc-header';

        const title = document.createElement('h2');
        title.className = 'cc-title';
        title.textContent = 'Connect Wallet';

        const subtitle = document.createElement('p');
        subtitle.className = 'cc-subtitle';
        subtitle.textContent = 'Choose your wallet to continue';

        header.appendChild(title);
        header.appendChild(subtitle);

        // Wallet list container
        const walletList = document.createElement('div');
        walletList.className = 'cc-wallet-list';
        walletList.id = 'cc-wallet-list';

        // Burner wallet view
        const burnerView = document.createElement('div');
        burnerView.className = 'cc-burner-view';
        burnerView.id = 'cc-burner-view';

        // Connected view (dynamically rendered)
        const connectedView = document.createElement('div');
        connectedView.className = 'cc-connected-view';
        connectedView.id = 'cc-connected-view';
        connectedView.style.display = 'none';

        // Status
        const status = document.createElement('div');
        status.className = 'cc-status';
        status.id = 'cc-status';

        // Assemble modal
        modal.appendChild(closeBtn);
        modal.appendChild(header);
        modal.appendChild(walletList);
        modal.appendChild(burnerView);
        modal.appendChild(connectedView);
        modal.appendChild(status);
        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);

        // Close on backdrop click
        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop) this.hideOverlay();
        });

        // Close on Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && backdrop.classList.contains('visible')) {
                this.hideOverlay();
            }
        });
    }

    /**
     * Get last used wallet from localStorage
     */
    getLastUsedWallet() {
        try {
            return localStorage.getItem(CryptoClient.STORAGE_KEY);
        } catch {
            return null;
        }
    }

    /**
     * Save last used wallet to localStorage
     */
    setLastUsedWallet(walletId) {
        try {
            localStorage.setItem(CryptoClient.STORAGE_KEY, walletId);
        } catch {
            // Silent fail
        }
    }

    /**
     * Detect available wallets
     */
    detectWallets() {
        const wallets = [];
        const lastUsed = this.getLastUsedWallet();

        for (const [id, wallet] of Object.entries(CryptoClient.WALLETS)) {
            wallets.push({
                id,
                ...wallet,
                installed: wallet.isInstalled(),
                isLastUsed: id === lastUsed
            });
        }

        // Sort: last used first, then installed, then alphabetical
        return wallets.sort((a, b) => {
            if (a.isLastUsed && !b.isLastUsed) return -1;
            if (!a.isLastUsed && b.isLastUsed) return 1;
            if (a.installed && !b.installed) return -1;
            if (!a.installed && b.installed) return 1;
            return a.name.localeCompare(b.name);
        });
    }

    /**
     * Render wallet list in modal using safe DOM methods
     */
    renderWalletList() {
        const container = document.getElementById('cc-wallet-list');
        if (!container) return;

        // Clear existing
        container.replaceChildren();

        let wallets = this.detectWallets();

        // Show all wallets - burner selection happens at launch time if needed

        wallets.forEach(wallet => {
            const btn = document.createElement('button');
            btn.className = 'cc-wallet-btn';
            if (wallet.isLastUsed) btn.classList.add('last-used');
            if (!wallet.installed) btn.classList.add('not-installed');
            btn.dataset.wallet = wallet.id;

            // Icon
            const icon = document.createElement('img');
            icon.className = 'cc-wallet-icon';
            icon.src = wallet.icon;
            icon.alt = wallet.name;

            // Info container
            const info = document.createElement('div');
            info.className = 'cc-wallet-info';

            const name = document.createElement('p');
            name.className = 'cc-wallet-name';
            name.textContent = wallet.name;

            const status = document.createElement('p');
            status.className = 'cc-wallet-status';
            if (wallet.installed) status.classList.add('detected');

            // Custom status text for burner wallets
            if (wallet.id === 'burner') {
                const burnerCount = CryptoClient.getBurnerWallets().length;
                status.textContent = burnerCount > 0 ? `${burnerCount} wallet${burnerCount > 1 ? 's' : ''} saved` : 'Create local wallets';
            } else {
                status.textContent = wallet.installed ? 'Detected' : 'Not installed';
            }

            info.appendChild(name);
            info.appendChild(status);

            btn.appendChild(icon);
            btn.appendChild(info);

            // Last used badge
            if (wallet.isLastUsed && wallet.installed) {
                const badge = document.createElement('span');
                badge.className = 'cc-last-used-badge';
                badge.textContent = 'Last used';
                btn.appendChild(badge);
            }

            // Arrow
            const arrow = document.createElement('span');
            arrow.className = 'cc-wallet-arrow';
            arrow.textContent = '›';
            btn.appendChild(arrow);

            // Click handler
            btn.addEventListener('click', () => {
                // Burner wallet - show burner view
                if (wallet.id === 'burner') {
                    this.showBurnerView();
                    return;
                }

                if (!wallet.installed) {
                    window.open(wallet.downloadUrl, '_blank');
                    return;
                }
                this.connectWallet(wallet.id);
            });

            container.appendChild(btn);
        });
    }

    /**
     * Render the connected wallet view with quick actions
     */
    renderConnectedView() {
        const container = document.getElementById('cc-connected-view');
        if (!container) return;

        container.replaceChildren();

        const walletConfig = CryptoClient.WALLETS[this.state.activeWallet];
        const burnerWallets = CryptoClient.getBurnerWallets();

        // Wallet info section
        const walletInfo = document.createElement('div');
        walletInfo.className = 'cc-connected-wallet-info';

        const walletIcon = document.createElement('img');
        walletIcon.className = 'cc-connected-wallet-icon';
        walletIcon.src = walletConfig?.icon || CryptoClient.WALLETS.phantom.icon;
        walletIcon.alt = walletConfig?.name || 'Wallet';

        const walletDetails = document.createElement('div');
        walletDetails.className = 'cc-connected-wallet-details';

        const walletName = document.createElement('p');
        walletName.className = 'cc-connected-wallet-name';

        // For burner wallets, show the burner wallet name
        if (this.state.activeWallet === 'burner') {
            const activeBurnerId = CryptoClient.getActiveBurnerId();
            const activeBurner = burnerWallets.find(w => w.id === activeBurnerId);
            walletName.textContent = activeBurner?.name || 'Burner Wallet';
        } else {
            walletName.textContent = walletConfig?.name || 'Connected';
        }

        const walletAddress = document.createElement('p');
        walletAddress.className = 'cc-connected-wallet-address';
        walletAddress.textContent = this.state.walletAddress
            ? this.state.walletAddress.slice(0, 8) + '...' + this.state.walletAddress.slice(-6)
            : '';

        walletDetails.appendChild(walletName);
        walletDetails.appendChild(walletAddress);

        const connectedDot = document.createElement('div');
        connectedDot.className = 'cc-connected-wallet-dot';

        walletInfo.appendChild(walletIcon);
        walletInfo.appendChild(walletDetails);
        walletInfo.appendChild(connectedDot);
        container.appendChild(walletInfo);

        // Quick actions section
        const quickActions = document.createElement('div');
        quickActions.className = 'cc-quick-actions';

        // Burner Wallets action
        const burnerAction = this.createQuickActionButton(
            'burner',
            '🔥',
            'Burner Wallets',
            `${burnerWallets.length} wallet${burnerWallets.length !== 1 ? 's' : ''} available`,
            () => this.showBurnerViewFromConnected()
        );
        quickActions.appendChild(burnerAction);

        // Bulk Transfer action (only if burner wallets exist)
        if (burnerWallets.length > 0) {
            const transferAction = this.createQuickActionButton(
                'transfer',
                '↗',
                'Bulk Transfer',
                'Send SOL to multiple wallets',
                () => this.showBulkTransferFromConnected()
            );
            quickActions.appendChild(transferAction);

            // Bulk Buy action
            const swapAction = this.createQuickActionButton(
                'swap',
                '⚡',
                'Bulk Buy',
                'Buy tokens with burner wallets',
                () => this.showBulkBuyFromConnected()
            );
            quickActions.appendChild(swapAction);
        }

        container.appendChild(quickActions);

        // Footer with Switch Wallet and Disconnect
        const footer = document.createElement('div');
        footer.className = 'cc-connected-footer';

        const switchBtn = document.createElement('button');
        switchBtn.className = 'cc-switch-wallet-btn';
        switchBtn.textContent = 'Switch Wallet';
        switchBtn.addEventListener('click', () => this.showWalletSelection());

        const disconnectBtn = document.createElement('button');
        disconnectBtn.className = 'cc-disconnect-btn-small';
        disconnectBtn.textContent = 'Disconnect';
        disconnectBtn.addEventListener('click', () => this.disconnect());

        footer.appendChild(switchBtn);
        footer.appendChild(disconnectBtn);
        container.appendChild(footer);
    }

    /**
     * Create a quick action button element
     */
    createQuickActionButton(type, icon, title, desc, onClick) {
        const btn = document.createElement('button');
        btn.className = 'cc-quick-action-btn';

        const iconDiv = document.createElement('div');
        iconDiv.className = `cc-quick-action-icon ${type}`;
        iconDiv.textContent = icon;

        const info = document.createElement('div');
        info.className = 'cc-quick-action-info';

        const titleEl = document.createElement('p');
        titleEl.className = 'cc-quick-action-title';
        titleEl.textContent = title;

        const descEl = document.createElement('p');
        descEl.className = 'cc-quick-action-desc';
        descEl.textContent = desc;

        info.appendChild(titleEl);
        info.appendChild(descEl);

        const arrow = document.createElement('span');
        arrow.className = 'cc-quick-action-arrow';
        arrow.textContent = '›';

        btn.appendChild(iconDiv);
        btn.appendChild(info);
        btn.appendChild(arrow);

        btn.addEventListener('click', onClick);

        return btn;
    }

    /**
     * Show burner view from connected state
     */
    showBurnerViewFromConnected() {
        const connectedView = document.getElementById('cc-connected-view');
        const burnerView = document.getElementById('cc-burner-view');
        const header = document.querySelector('.cc-header');

        if (connectedView) connectedView.style.display = 'none';
        if (header) header.style.display = 'none';
        if (burnerView) {
            burnerView.classList.add('visible');
            this.renderBurnerView(true); // Pass flag to show back to connected
        }
    }

    /**
     * Show bulk transfer modal from connected state
     */
    showBulkTransferFromConnected() {
        // Find a burner wallet with balance to use as source
        const burnerWallets = CryptoClient.getBurnerWallets();
        if (burnerWallets.length === 0) {
            this.setStatus('No burner wallets available', 'error');
            return;
        }
        // Use first burner wallet or the active one
        const activeBurnerId = CryptoClient.getActiveBurnerId();
        const sourceWallet = burnerWallets.find(w => w.id === activeBurnerId) || burnerWallets[0];

        // Transfer modal creates its own overlay with higher z-index
        // so the wallet modal stays visible underneath
        this.showTransferModal(sourceWallet);
    }

    /**
     * Show bulk buy modal from connected state
     */
    showBulkBuyFromConnected() {
        // Bulk buy modal creates its own overlay with higher z-index
        // so the wallet modal stays visible underneath
        this.showBulkSwapModal();
    }

    /**
     * Show wallet selection (switch wallet mode)
     */
    showWalletSelection() {
        const connectedView = document.getElementById('cc-connected-view');
        const walletList = document.getElementById('cc-wallet-list');
        const header = document.querySelector('.cc-header');

        if (connectedView) connectedView.style.display = 'none';
        if (header) header.style.display = '';
        if (walletList) {
            walletList.style.display = 'flex';
            this.renderWalletList();
        }
    }

    showBurnerView() {
        const walletList = document.getElementById('cc-wallet-list');
        const burnerView = document.getElementById('cc-burner-view');
        const header = document.querySelector('.cc-header');

        if (walletList) walletList.style.display = 'none';
        if (header) header.style.display = 'none';
        if (burnerView) {
            burnerView.classList.add('visible');
            this.renderBurnerView();
        }
    }

    hideBurnerView() {
        const walletList = document.getElementById('cc-wallet-list');
        const burnerView = document.getElementById('cc-burner-view');
        const header = document.querySelector('.cc-header');

        if (walletList) walletList.style.display = '';
        if (header) header.style.display = '';
        if (burnerView) burnerView.classList.remove('visible');
    }

    hideBurnerViewToConnected() {
        const connectedView = document.getElementById('cc-connected-view');
        const burnerView = document.getElementById('cc-burner-view');

        if (burnerView) burnerView.classList.remove('visible');
        if (connectedView) {
            connectedView.style.display = 'block';
            this.renderConnectedView();
        }
    }

    renderBurnerView(fromConnected = false) {
        const container = document.getElementById('cc-burner-view');
        if (!container) return;

        container.replaceChildren();

        // Header with back button
        const header = document.createElement('div');
        header.className = 'cc-burner-header';

        const backBtn = document.createElement('button');
        backBtn.className = 'cc-burner-back';
        backBtn.textContent = '‹';
        backBtn.addEventListener('click', () => {
            if (fromConnected && this.state.isConnected) {
                this.hideBurnerViewToConnected();
            } else {
                this.hideBurnerView();
            }
        });

        const title = document.createElement('h3');
        title.className = 'cc-burner-title';
        title.textContent = 'Burner Wallets';

        header.appendChild(backBtn);
        header.appendChild(title);
        container.appendChild(header);

        // Burner wallet list
        const list = document.createElement('div');
        list.className = 'cc-burner-list';

        const wallets = CryptoClient.getBurnerWallets();
        const activeBurnerId = CryptoClient.getActiveBurnerId();

        if (wallets.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'cc-burner-empty';
            empty.textContent = 'No burner wallets yet. Generate one below.';
            list.appendChild(empty);
        } else {
            // Track which panel is open (only one at a time)
            let openPanel = null;

            wallets.forEach(wallet => {
                // Wrapper contains header + expandable actions panel
                const wrapper = document.createElement('div');
                wrapper.className = 'cc-burner-item-wrapper';
                if (wallet.id === activeBurnerId) wrapper.classList.add('active');

                // Header row (wallet info + toggle button)
                const header = document.createElement('div');
                header.className = 'cc-burner-item-header';

                const info = document.createElement('div');
                info.className = 'cc-burner-item-info';

                // Name display (with inline edit support)
                const nameDisplay = document.createElement('div');
                nameDisplay.className = 'cc-burner-name-display';

                const name = document.createElement('p');
                name.className = 'cc-burner-item-name';
                name.textContent = wallet.name || `Burner ${wallet.publicKey.slice(0, 6)}`;
                nameDisplay.appendChild(name);

                const addressRow = document.createElement('div');
                addressRow.className = 'cc-burner-address-row';

                const address = document.createElement('p');
                address.className = 'cc-burner-item-address';
                address.textContent = wallet.publicKey.slice(0, 8) + '...' + wallet.publicKey.slice(-6);

                const balance = document.createElement('p');
                balance.className = 'cc-burner-item-balance';
                balance.dataset.pubkey = wallet.publicKey;
                balance.textContent = '...';

                addressRow.appendChild(address);
                addressRow.appendChild(balance);

                // Edit name container (hidden by default)
                const editContainer = document.createElement('div');
                editContainer.className = 'cc-burner-edit-container';

                const renameInput = document.createElement('input');
                renameInput.type = 'text';
                renameInput.className = 'cc-rename-input';
                renameInput.value = wallet.name || '';
                renameInput.placeholder = 'Wallet name...';

                const saveRenameBtn = document.createElement('button');
                saveRenameBtn.type = 'button';
                saveRenameBtn.className = 'cc-rename-save';
                saveRenameBtn.textContent = '✓';

                editContainer.appendChild(renameInput);
                editContainer.appendChild(saveRenameBtn);

                info.appendChild(nameDisplay);
                info.appendChild(editContainer);
                info.appendChild(addressRow);

                // Save rename function
                const saveRename = () => {
                    const newName = renameInput.value.trim();
                    if (newName && newName !== wallet.name) {
                        CryptoClient.renameBurnerWallet(wallet.id, newName);
                        wallet.name = newName;
                        name.textContent = newName;
                        this.showCopiedToast('Wallet renamed!');
                    }
                    editContainer.classList.remove('editing');
                    nameDisplay.classList.remove('hidden');
                };

                saveRenameBtn.onclick = (e) => {
                    e.stopPropagation();
                    saveRename();
                };

                renameInput.onkeydown = (e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') saveRename();
                    else if (e.key === 'Escape') {
                        editContainer.classList.remove('editing');
                        nameDisplay.classList.remove('hidden');
                        renameInput.value = wallet.name || '';
                    }
                };

                renameInput.onclick = (e) => e.stopPropagation();

                // Toggle button for actions panel
                const toggle = document.createElement('button');
                toggle.type = 'button';
                toggle.className = 'cc-burner-options-toggle';
                toggle.textContent = '∨';

                // Expandable actions panel
                const actionsPanel = document.createElement('div');
                actionsPanel.className = 'cc-burner-actions-panel';

                // Helper to create action buttons
                const createAction = (className, icon, label, handler) => {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = `cc-burner-action ${className}`;

                    const iconEl = document.createElement('span');
                    iconEl.className = 'cc-burner-action-icon';
                    iconEl.textContent = icon;

                    const labelEl = document.createElement('span');
                    labelEl.className = 'cc-burner-action-label';
                    labelEl.textContent = label;

                    btn.appendChild(iconEl);
                    btn.appendChild(labelEl);

                    btn.onclick = (e) => {
                        e.stopPropagation();
                        handler();
                    };

                    return btn;
                };

                // Add action buttons
                actionsPanel.appendChild(createAction('copy', '📋', 'Copy', () => {
                    navigator.clipboard.writeText(wallet.publicKey).then(() => {
                        this.showCopiedToast('Address copied!');
                    });
                }));

                actionsPanel.appendChild(createAction('qr', '⬚', 'QR', () => {
                    this.showQRModal(wallet);
                }));

                actionsPanel.appendChild(createAction('rename', '✏️', 'Rename', () => {
                    editContainer.classList.add('editing');
                    nameDisplay.classList.add('hidden');
                    renameInput.focus();
                    renameInput.select();
                }));

                actionsPanel.appendChild(createAction('transfer', '↗', 'Send', () => {
                    this.showTransferModal(wallet);
                }));

                actionsPanel.appendChild(createAction('export', '🔑', 'Export', () => {
                    this.exportBurnerPrivateKey(wallet);
                }));

                actionsPanel.appendChild(createAction('delete', '✕', 'Delete', () => {
                    if (confirm(`Delete "${wallet.name || 'this wallet'}"?`)) {
                        CryptoClient.deleteBurnerWallet(wallet.id);
                        this.renderBurnerView();
                    }
                }));

                // Toggle actions panel
                toggle.onclick = (e) => {
                    e.stopPropagation();

                    const isOpen = actionsPanel.classList.contains('open');

                    // Close any other open panel
                    if (openPanel && openPanel !== actionsPanel) {
                        openPanel.classList.remove('open');
                        openPanel.parentElement.classList.remove('expanded');
                        const otherToggle = openPanel.parentElement.querySelector('.cc-burner-options-toggle');
                        if (otherToggle) otherToggle.classList.remove('open');
                    }

                    // Toggle this panel
                    actionsPanel.classList.toggle('open', !isOpen);
                    toggle.classList.toggle('open', !isOpen);
                    wrapper.classList.toggle('expanded', !isOpen);
                    openPanel = isOpen ? null : actionsPanel;
                };

                // Click header to select wallet
                header.onclick = (e) => {
                    if (e.target.closest('.cc-burner-options-toggle')) return;
                    CryptoClient.setActiveBurnerId(wallet.id);
                    this.connectWallet('burner');
                };

                header.appendChild(info);
                header.appendChild(toggle);
                wrapper.appendChild(header);
                wrapper.appendChild(actionsPanel);
                list.appendChild(wrapper);
            });

        }

        container.appendChild(list);

        // Import form (hidden by default)
        const importForm = document.createElement('div');
        importForm.className = 'cc-import-form';
        importForm.id = 'cc-import-form';

        const importInput = document.createElement('input');
        importInput.type = 'text';
        importInput.placeholder = 'Paste private key (base58 or array format)';
        importInput.id = 'cc-import-input';
        importForm.appendChild(importInput);

        const importError = document.createElement('div');
        importError.className = 'cc-import-error';
        importError.id = 'cc-import-error';
        importError.style.display = 'none';
        importForm.appendChild(importError);

        const importFormActions = document.createElement('div');
        importFormActions.className = 'cc-import-form-actions';

        const importConfirmBtn = document.createElement('button');
        importConfirmBtn.className = 'cc-import-confirm';
        importConfirmBtn.textContent = 'Import Wallet';
        importConfirmBtn.addEventListener('click', () => {
            const privateKey = importInput.value.trim();
            if (!privateKey) {
                importError.textContent = 'Please enter a private key';
                importError.style.display = 'block';
                return;
            }

            const result = CryptoClient.importBurnerWallet(privateKey);
            if (result.error) {
                importError.textContent = result.error;
                importError.style.display = 'block';
            } else if (result.wallet) {
                CryptoClient.setActiveBurnerId(result.wallet.id);
                this.renderBurnerView(fromConnected);
                // Auto-scroll to bottom to show imported wallet
                const burnerList = document.querySelector('.cc-burner-list');
                if (burnerList) {
                    burnerList.scrollTop = burnerList.scrollHeight;
                }
                this.showCopiedToast('Wallet imported!');
            }
        });

        const importCancelBtn = document.createElement('button');
        importCancelBtn.className = 'cc-import-cancel';
        importCancelBtn.textContent = 'Cancel';
        importCancelBtn.addEventListener('click', () => {
            importForm.classList.remove('visible');
            importInput.value = '';
            importError.style.display = 'none';
        });

        importFormActions.appendChild(importConfirmBtn);
        importFormActions.appendChild(importCancelBtn);
        importForm.appendChild(importFormActions);
        container.appendChild(importForm);

        // Action buttons container
        const actionsContainer = document.createElement('div');
        actionsContainer.className = 'cc-burner-actions';

        // Generate new wallet button
        const generateBtn = document.createElement('button');
        generateBtn.className = 'cc-burner-generate';
        generateBtn.textContent = '+ Generate';
        generateBtn.addEventListener('click', () => {
            const newWallet = CryptoClient.generateBurnerWallet();
            if (newWallet) {
                CryptoClient.setActiveBurnerId(newWallet.id);
                this.renderBurnerView(fromConnected);
                // Auto-scroll to bottom to show new wallet
                const burnerList = document.querySelector('.cc-burner-list');
                if (burnerList) {
                    burnerList.scrollTop = burnerList.scrollHeight;
                }
            }
        });
        actionsContainer.appendChild(generateBtn);

        // Import wallet button
        const importBtn = document.createElement('button');
        importBtn.className = 'cc-burner-import';
        importBtn.textContent = '↓ Import';
        importBtn.addEventListener('click', () => {
            const form = document.getElementById('cc-import-form');
            if (form) {
                form.classList.toggle('visible');
                if (form.classList.contains('visible')) {
                    document.getElementById('cc-import-input')?.focus();
                }
            }
        });
        actionsContainer.appendChild(importBtn);

        container.appendChild(actionsContainer);

        // Bulk Buy button (only show if there are wallets)
        if (wallets.length > 0) {
            const bulkBuyBtn = document.createElement('button');
            bulkBuyBtn.className = 'cc-bulk-buy-btn';

            // Clean SVG icon (stacked layers/coins)
            const btnIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            btnIcon.setAttribute('width', '16');
            btnIcon.setAttribute('height', '16');
            btnIcon.setAttribute('viewBox', '0 0 24 24');
            btnIcon.setAttribute('fill', 'none');
            btnIcon.setAttribute('stroke', 'currentColor');
            btnIcon.setAttribute('stroke-width', '2');
            btnIcon.setAttribute('stroke-linecap', 'round');
            btnIcon.setAttribute('stroke-linejoin', 'round');
            btnIcon.style.marginRight = '8px';
            btnIcon.style.verticalAlign = 'middle';

            // Three stacked ellipses (coins/layers icon)
            const ellipse1 = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
            ellipse1.setAttribute('cx', '12');
            ellipse1.setAttribute('cy', '6');
            ellipse1.setAttribute('rx', '8');
            ellipse1.setAttribute('ry', '3');

            const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path1.setAttribute('d', 'M4 6v6c0 1.657 3.582 3 8 3s8-1.343 8-3V6');

            const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path2.setAttribute('d', 'M4 12v6c0 1.657 3.582 3 8 3s8-1.343 8-3v-6');

            btnIcon.appendChild(ellipse1);
            btnIcon.appendChild(path1);
            btnIcon.appendChild(path2);

            const btnText = document.createTextNode('Bulk Buy');
            bulkBuyBtn.appendChild(btnIcon);
            bulkBuyBtn.appendChild(btnText);

            bulkBuyBtn.addEventListener('click', () => {
                this.showBulkSwapModal();
            });
            container.appendChild(bulkBuyBtn);
        }

        // Warning
        const warning = document.createElement('div');
        warning.className = 'cc-burner-warning';
        warning.textContent = 'Burner wallets are stored locally. Only use for small amounts.';
        container.appendChild(warning);

        // Fetch balances asynchronously
        if (wallets.length > 0) {
            this.fetchBurnerBalances(wallets);
        }
    }

    /**
     * Fetch balances for burner wallets and update UI
     */
    async fetchBurnerBalances(wallets) {
        const web3 = window.solanaWeb3;
        if (!web3) return;

        try {
            const pubkeys = wallets.map(w => new web3.PublicKey(w.publicKey));
            const accountInfos = await CryptoClient.batchGetAccountsInfo(pubkeys);

            // Update each balance element
            wallets.forEach((wallet, i) => {
                const balanceEl = document.querySelector(`.cc-burner-item-balance[data-pubkey="${wallet.publicKey}"]`);
                if (balanceEl) {
                    const info = accountInfos[i];
                    const lamports = info ? info.lamports : 0;
                    const sol = lamports / 1e9;

                    // Format nicely
                    if (sol === 0) {
                        balanceEl.textContent = '0 SOL';
                        balanceEl.style.color = 'rgba(255,255,255,0.3)';
                    } else if (sol < 0.001) {
                        balanceEl.textContent = '<0.001 SOL';
                        balanceEl.style.color = 'rgba(255,255,255,0.5)';
                    } else {
                        balanceEl.textContent = sol.toFixed(4) + ' SOL';
                        balanceEl.style.color = '#10b981'; // Green for positive balance
                    }
                }
            });
        } catch (err) {
            console.error('[CryptoClient] Failed to fetch burner balances:', err);
            // Show error state
            document.querySelectorAll('.cc-burner-item-balance').forEach(el => {
                el.textContent = 'Error';
                el.style.color = 'rgba(239, 68, 68, 0.7)';
            });
        }
    }

    showCopiedToast(message) {
        // Remove existing toast
        const existing = document.querySelector('.cc-burner-copied');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = 'cc-burner-copied';
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => toast.remove(), 2000);
    }

    /**
     * Show error toast for contract/API errors
     * @param {string} message - Error message to display
     * @param {number} duration - Duration in ms (default 5000, 0 for manual dismiss only)
     */
    showErrorToast(message, duration = 5000) {
        // Remove existing error toast
        const existing = document.querySelector('.cc-error-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = 'cc-error-toast';

        // Create title with icon using safe DOM methods
        const title = document.createElement('div');
        title.className = 'cc-error-toast-title';

        // Create SVG icon using namespace
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');

        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', '12');
        circle.setAttribute('cy', '12');
        circle.setAttribute('r', '10');

        const line1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line1.setAttribute('x1', '12');
        line1.setAttribute('y1', '8');
        line1.setAttribute('x2', '12');
        line1.setAttribute('y2', '12');

        const line2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line2.setAttribute('x1', '12');
        line2.setAttribute('y1', '16');
        line2.setAttribute('x2', '12.01');
        line2.setAttribute('y2', '16');

        svg.appendChild(circle);
        svg.appendChild(line1);
        svg.appendChild(line2);

        const titleText = document.createElement('span');
        titleText.textContent = 'Error';

        title.appendChild(svg);
        title.appendChild(titleText);

        // Create message
        const msg = document.createElement('div');
        msg.className = 'cc-error-toast-message';
        msg.textContent = message;

        toast.appendChild(title);
        toast.appendChild(msg);

        // Click to dismiss
        toast.addEventListener('click', () => {
            toast.style.animation = 'ccErrorSlideOut 0.2s ease forwards';
            setTimeout(() => toast.remove(), 200);
        });

        document.body.appendChild(toast);

        // Auto-dismiss after duration (if not 0)
        if (duration > 0) {
            setTimeout(() => {
                if (document.body.contains(toast)) {
                    toast.style.animation = 'ccErrorSlideOut 0.2s ease forwards';
                    setTimeout(() => toast.remove(), 200);
                }
            }, duration);
        }
    }

    exportBurnerPrivateKey(wallet) {
        // Convert secret key array to base58 (standard Solana format)
        const secretKeyArray = new Uint8Array(wallet.secretKey);

        // Format options for export
        const formats = {
            array: JSON.stringify(Array.from(secretKeyArray)),
            base58: this.encodeBase58(secretKeyArray),
            hex: Array.from(secretKeyArray).map(b => b.toString(16).padStart(2, '0')).join('')
        };

        // Create export modal
        const overlay = document.createElement('div');
        overlay.className = 'cc-modal-backdrop visible';
        overlay.style.zIndex = '100002';

        const modal = document.createElement('div');
        modal.className = 'cc-modal';
        modal.style.maxWidth = '450px';

        modal.innerHTML = '';

        // Title
        const title = document.createElement('h3');
        title.style.cssText = 'color: #fff; margin: 0 0 8px 0; font-size: 18px;';
        title.textContent = `Export: ${wallet.name}`;
        modal.appendChild(title);

        // Warning
        const warn = document.createElement('p');
        warn.style.cssText = 'color: #ff9955; font-size: 12px; margin: 0 0 16px 0;';
        warn.textContent = 'Never share your private key. Anyone with it can steal your funds.';
        modal.appendChild(warn);

        // Format selector
        const formatLabel = document.createElement('p');
        formatLabel.style.cssText = 'color: rgba(255,255,255,0.6); font-size: 12px; margin: 0 0 8px 0;';
        formatLabel.textContent = 'Format:';
        modal.appendChild(formatLabel);

        const formatBtns = document.createElement('div');
        formatBtns.style.cssText = 'display: flex; gap: 8px; margin-bottom: 12px;';

        let currentFormat = 'base58';

        const keyDisplay = document.createElement('div');
        keyDisplay.style.cssText = 'background: rgba(0,0,0,0.3); border-radius: 8px; padding: 12px; font-family: monospace; font-size: 11px; color: rgba(255,255,255,0.8); word-break: break-all; max-height: 80px; overflow-y: auto; margin-bottom: 16px;';
        keyDisplay.textContent = formats.base58;

        ['Base58', 'Array', 'Hex'].forEach(fmt => {
            const btn = document.createElement('button');
            btn.style.cssText = 'padding: 6px 12px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05); color: rgba(255,255,255,0.7); cursor: pointer; font-size: 12px;';
            btn.textContent = fmt;
            if (fmt.toLowerCase() === currentFormat) {
                btn.style.background = 'rgba(255,255,255,0.15)';
                btn.style.color = '#fff';
            }
            btn.addEventListener('click', () => {
                currentFormat = fmt.toLowerCase();
                keyDisplay.textContent = formats[currentFormat];
                formatBtns.querySelectorAll('button').forEach(b => {
                    b.style.background = 'rgba(255,255,255,0.05)';
                    b.style.color = 'rgba(255,255,255,0.7)';
                });
                btn.style.background = 'rgba(255,255,255,0.15)';
                btn.style.color = '#fff';
            });
            formatBtns.appendChild(btn);
        });

        modal.appendChild(formatBtns);
        modal.appendChild(keyDisplay);

        // Buttons
        const btnContainer = document.createElement('div');
        btnContainer.style.cssText = 'display: flex; gap: 10px;';

        const copyBtn = document.createElement('button');
        copyBtn.style.cssText = 'flex: 1; padding: 12px; border-radius: 10px; border: none; background: rgba(255,153,85,0.2); color: #ff9955; cursor: pointer; font-weight: 500;';
        copyBtn.textContent = 'Copy Key';
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(formats[currentFormat]).then(() => {
                copyBtn.textContent = 'Copied!';
                setTimeout(() => copyBtn.textContent = 'Copy Key', 1500);
            });
        });

        const closeBtn = document.createElement('button');
        closeBtn.style.cssText = 'flex: 1; padding: 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.1); background: transparent; color: rgba(255,255,255,0.7); cursor: pointer;';
        closeBtn.textContent = 'Close';
        closeBtn.addEventListener('click', () => overlay.remove());

        btnContainer.appendChild(copyBtn);
        btnContainer.appendChild(closeBtn);
        modal.appendChild(btnContainer);

        overlay.appendChild(modal);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });

        document.body.appendChild(overlay);
    }

    /**
     * Load QR code library from CDN
     */
    static _qrLibLoaded = false;
    static _qrLibLoading = null;

    static async ensureQRLibLoaded() {
        if (CryptoClient._qrLibLoaded && window.qrcode) return true;
        if (CryptoClient._qrLibLoading) return CryptoClient._qrLibLoading;

        CryptoClient._qrLibLoading = new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js';
            script.onload = () => {
                CryptoClient._qrLibLoaded = true;
                console.log('[CryptoClient] QR code library loaded');
                resolve(true);
            };
            script.onerror = () => {
                console.error('[CryptoClient] Failed to load QR code library');
                resolve(false);
            };
            document.head.appendChild(script);
        });

        return CryptoClient._qrLibLoading;
    }

    generateQRCodeSVG(text, size = 200) {
        // Check if qrcode library is loaded
        if (!window.qrcode) {
            // Return a placeholder while loading
            const svgNS = 'http://www.w3.org/2000/svg';
            const svg = document.createElementNS(svgNS, 'svg');
            svg.setAttribute('width', size.toString());
            svg.setAttribute('height', size.toString());
            svg.setAttribute('viewBox', `0 0 ${size} ${size}`);

            const bg = document.createElementNS(svgNS, 'rect');
            bg.setAttribute('width', '100%');
            bg.setAttribute('height', '100%');
            bg.setAttribute('fill', '#f0f0f0');
            svg.appendChild(bg);

            const loadingText = document.createElementNS(svgNS, 'text');
            loadingText.setAttribute('x', '50%');
            loadingText.setAttribute('y', '50%');
            loadingText.setAttribute('text-anchor', 'middle');
            loadingText.setAttribute('dominant-baseline', 'middle');
            loadingText.setAttribute('fill', '#666');
            loadingText.setAttribute('font-size', '14');
            loadingText.textContent = 'Loading...';
            svg.appendChild(loadingText);

            return svg;
        }

        // Generate real QR code using qrcode-generator library
        const qr = window.qrcode(0, 'M'); // Type 0 = auto, Error correction M
        qr.addData(text);
        qr.make();

        const moduleCount = qr.getModuleCount();
        const cellSize = size / (moduleCount + 8); // Add quiet zone
        const offset = cellSize * 4; // Quiet zone offset

        const svgNS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('width', size.toString());
        svg.setAttribute('height', size.toString());
        svg.setAttribute('viewBox', `0 0 ${size} ${size}`);

        // White background with quiet zone
        const bg = document.createElementNS(svgNS, 'rect');
        bg.setAttribute('width', '100%');
        bg.setAttribute('height', '100%');
        bg.setAttribute('fill', '#ffffff');
        svg.appendChild(bg);

        // Draw QR modules
        for (let row = 0; row < moduleCount; row++) {
            for (let col = 0; col < moduleCount; col++) {
                if (qr.isDark(row, col)) {
                    const rect = document.createElementNS(svgNS, 'rect');
                    rect.setAttribute('x', (offset + col * cellSize).toString());
                    rect.setAttribute('y', (offset + row * cellSize).toString());
                    rect.setAttribute('width', cellSize.toString());
                    rect.setAttribute('height', cellSize.toString());
                    rect.setAttribute('fill', '#000000');
                    svg.appendChild(rect);
                }
            }
        }

        return svg;
    }

    /**
     * Show QR code modal for a wallet address
     */
    async showQRModal(wallet) {
        // Load QR library first
        await CryptoClient.ensureQRLibLoaded();

        // Create backdrop
        const overlay = document.createElement('div');
        overlay.className = 'cc-modal-backdrop';
        overlay.style.zIndex = '100002';

        // Create modal (bottom sheet on mobile, centered on desktop)
        const modal = document.createElement('div');
        modal.className = 'cc-qr-modal';

        // Handle bar for mobile
        const handle = document.createElement('div');
        handle.className = 'cc-qr-handle';
        modal.appendChild(handle);

        // Header
        const header = document.createElement('div');
        header.className = 'cc-qr-header';

        const title = document.createElement('h3');
        title.className = 'cc-qr-title';
        title.textContent = wallet.name || 'Wallet Address';
        header.appendChild(title);

        const subtitle = document.createElement('p');
        subtitle.className = 'cc-qr-subtitle';
        subtitle.textContent = 'Scan to send SOL to this address';
        header.appendChild(subtitle);

        modal.appendChild(header);

        // QR Code container
        const qrContainer = document.createElement('div');
        qrContainer.className = 'cc-qr-code-container';

        const qrCode = this.generateQRCodeSVG(wallet.publicKey, 200);
        qrContainer.appendChild(qrCode);
        modal.appendChild(qrContainer);

        // Address display
        const addressBox = document.createElement('div');
        addressBox.className = 'cc-qr-address';

        const addressText = document.createElement('p');
        addressText.className = 'cc-qr-address-text';
        addressText.textContent = wallet.publicKey;
        addressBox.appendChild(addressText);
        modal.appendChild(addressBox);

        // Copy button
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'cc-qr-copy-btn';
        copyBtn.textContent = 'Copy Address';
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(wallet.publicKey).then(() => {
                copyBtn.textContent = 'Copied!';
                copyBtn.classList.add('copied');
                setTimeout(() => {
                    copyBtn.textContent = 'Copy Address';
                    copyBtn.classList.remove('copied');
                }, 2000);
            });
        });
        modal.appendChild(copyBtn);

        overlay.appendChild(modal);

        // Close on backdrop click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                modal.classList.remove('visible');
                overlay.classList.remove('visible');
                setTimeout(() => overlay.remove(), 300);
            }
        });

        document.body.appendChild(overlay);

        // Animate in
        requestAnimationFrame(() => {
            overlay.classList.add('visible');
            requestAnimationFrame(() => {
                modal.classList.add('visible');
            });
        });
    }

    /**
     * Show success modal for completed transfers
     */
    showSuccessModal(title, message, details = []) {
        const overlay = document.createElement('div');
        overlay.className = 'cc-modal-backdrop visible';
        overlay.style.zIndex = '100002';

        const modal = document.createElement('div');
        modal.className = 'cc-modal';
        modal.style.maxWidth = '400px';
        modal.style.textAlign = 'center';

        // Success icon
        const iconContainer = document.createElement('div');
        iconContainer.style.cssText = 'width: 64px; height: 64px; border-radius: 50%; background: linear-gradient(135deg, #10b981, #059669); display: flex; align-items: center; justify-content: center; margin: 0 auto 16px;';

        const checkIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        checkIcon.setAttribute('width', '32');
        checkIcon.setAttribute('height', '32');
        checkIcon.setAttribute('viewBox', '0 0 24 24');
        checkIcon.setAttribute('fill', 'none');
        checkIcon.setAttribute('stroke', '#fff');
        checkIcon.setAttribute('stroke-width', '3');
        checkIcon.setAttribute('stroke-linecap', 'round');
        checkIcon.setAttribute('stroke-linejoin', 'round');

        const checkPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        checkPath.setAttribute('d', 'M20 6L9 17l-5-5');
        checkIcon.appendChild(checkPath);
        iconContainer.appendChild(checkIcon);
        modal.appendChild(iconContainer);

        // Title
        const titleEl = document.createElement('h3');
        titleEl.style.cssText = 'color: #fff; margin: 0 0 8px 0; font-size: 20px;';
        titleEl.textContent = title;
        modal.appendChild(titleEl);

        // Message
        const messageEl = document.createElement('p');
        messageEl.style.cssText = 'color: rgba(255,255,255,0.6); font-size: 14px; margin: 0 0 16px 0;';
        messageEl.textContent = message;
        modal.appendChild(messageEl);

        // Details list
        if (details.length > 0) {
            const detailsBox = document.createElement('div');
            detailsBox.style.cssText = 'background: rgba(255,255,255,0.05); border-radius: 10px; padding: 12px; margin-bottom: 16px; text-align: left;';

            details.forEach(detail => {
                const detailRow = document.createElement('div');
                detailRow.style.cssText = 'display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.05);';
                detailRow.style.borderBottom = details.indexOf(detail) === details.length - 1 ? 'none' : '1px solid rgba(255,255,255,0.05)';

                const label = document.createElement('span');
                label.style.cssText = 'color: rgba(255,255,255,0.5); font-size: 12px;';
                label.textContent = detail.label;

                const value = document.createElement('span');
                value.style.cssText = 'color: #fff; font-size: 12px; font-weight: 500;';
                value.textContent = detail.value;

                detailRow.appendChild(label);
                detailRow.appendChild(value);
                detailsBox.appendChild(detailRow);
            });

            modal.appendChild(detailsBox);
        }

        // Close button
        const closeBtn = document.createElement('button');
        closeBtn.style.cssText = 'width: 100%; padding: 14px; border-radius: 12px; border: none; background: rgba(255,255,255,0.1); color: #fff; cursor: pointer; font-weight: 600; font-size: 14px;';
        closeBtn.textContent = 'Done';
        closeBtn.addEventListener('click', () => overlay.remove());
        modal.appendChild(closeBtn);

        overlay.appendChild(modal);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });

        document.body.appendChild(overlay);
    }

    /**
     * Show privacy transfer success modal with detailed PrivacyCash results
     */
    showPrivacyTransferSuccess(result) {
        const overlay = document.createElement('div');
        overlay.className = 'cc-modal-backdrop visible';
        overlay.style.zIndex = '100002';

        const modal = document.createElement('div');
        modal.className = 'cc-modal cc-privacy-success-modal';
        modal.style.cssText = 'max-width: 440px; text-align: center; background: linear-gradient(180deg, #0a0f14 0%, #060a0d 100%); border: 1px solid rgba(56, 189, 248, 0.2);';

        // Shield icon (privacy theme)
        const iconContainer = document.createElement('div');
        iconContainer.style.cssText = 'width: 64px; height: 64px; border-radius: 50%; background: linear-gradient(135deg, #0ea5e9, #0284c7); display: flex; align-items: center; justify-content: center; margin: 0 auto 16px; box-shadow: 0 0 30px rgba(14, 165, 233, 0.3);';

        const shieldIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        shieldIcon.setAttribute('width', '28');
        shieldIcon.setAttribute('height', '28');
        shieldIcon.setAttribute('viewBox', '0 0 24 24');
        shieldIcon.setAttribute('fill', 'none');
        shieldIcon.setAttribute('stroke', '#fff');
        shieldIcon.setAttribute('stroke-width', '2');
        shieldIcon.setAttribute('stroke-linecap', 'round');
        shieldIcon.setAttribute('stroke-linejoin', 'round');

        const shieldPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        shieldPath.setAttribute('d', 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z');
        shieldIcon.appendChild(shieldPath);

        const checkPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        checkPath.setAttribute('d', 'M9 12l2 2 4-4');
        shieldIcon.appendChild(checkPath);

        iconContainer.appendChild(shieldIcon);
        modal.appendChild(iconContainer);

        // Title
        const titleEl = document.createElement('h3');
        titleEl.style.cssText = 'color: #7dd3fc; margin: 0 0 4px 0; font-size: 20px;';
        titleEl.textContent = 'Private Transfer Complete';
        modal.appendChild(titleEl);

        // Subtitle badge
        const badge = document.createElement('div');
        badge.style.cssText = 'display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; background: rgba(56, 189, 248, 0.12); border: 1px solid rgba(56, 189, 248, 0.2); border-radius: 20px; font-size: 11px; font-weight: 600; color: #7dd3fc; margin-bottom: 16px;';
        badge.textContent = 'Via PrivacyCash';
        modal.appendChild(badge);

        // Deposit Section
        const depositSection = document.createElement('div');
        depositSection.style.cssText = 'background: rgba(56, 189, 248, 0.06); border: 1px solid rgba(56, 189, 248, 0.12); border-radius: 12px; padding: 14px; margin-bottom: 12px; text-align: left;';

        const depositHeader = document.createElement('div');
        depositHeader.style.cssText = 'font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: rgba(255,255,255,0.4); margin-bottom: 10px;';
        depositHeader.textContent = 'Deposit';
        depositSection.appendChild(depositHeader);

        const depositGrid = document.createElement('div');
        depositGrid.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 8px;';

        const addStat = (label, value, highlight = false) => {
            const stat = document.createElement('div');
            const statLabel = document.createElement('div');
            statLabel.style.cssText = 'font-size: 11px; color: rgba(255,255,255,0.4);';
            statLabel.textContent = label;
            const statValue = document.createElement('div');
            statValue.style.cssText = `font-size: 14px; font-weight: 600; color: ${highlight ? '#38bdf8' : '#fff'}; font-family: 'SF Mono', monospace;`;
            statValue.textContent = value;
            stat.appendChild(statLabel);
            stat.appendChild(statValue);
            return stat;
        };

        depositGrid.appendChild(addStat('Amount', (result.depositAmount || 0).toFixed(4) + ' SOL'));
        depositSection.appendChild(depositGrid);

        if (result.depositTxHash) {
            const txLink = document.createElement('a');
            txLink.href = `https://solscan.io/tx/${result.depositTxHash}`;
            txLink.target = '_blank';
            txLink.style.cssText = 'display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: #38bdf8; text-decoration: none; margin-top: 10px;';
            txLink.innerHTML = `<span>View deposit tx</span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>`;
            depositSection.appendChild(txLink);
        }

        modal.appendChild(depositSection);

        // Recipients Section
        const recipientsSection = document.createElement('div');
        recipientsSection.style.cssText = 'background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; padding: 14px; margin-bottom: 12px; text-align: left;';

        const recipientsHeader = document.createElement('div');
        recipientsHeader.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;';

        const recipientsLabel = document.createElement('div');
        recipientsLabel.style.cssText = 'font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: rgba(255,255,255,0.4);';
        recipientsLabel.textContent = 'Recipients';

        const recipientsCount = document.createElement('div');
        recipientsCount.style.cssText = 'font-size: 12px; font-weight: 600; color: #10b981;';
        recipientsCount.textContent = `${result.count || 0} successful`;

        recipientsHeader.appendChild(recipientsLabel);
        recipientsHeader.appendChild(recipientsCount);
        recipientsSection.appendChild(recipientsHeader);

        // Recipients list (max 5 shown)
        if (result.results && result.results.length > 0) {
            const recipientsList = document.createElement('div');
            recipientsList.style.cssText = 'display: flex; flex-direction: column; gap: 6px; max-height: 150px; overflow-y: auto;';

            result.results.slice(0, 5).forEach((r, i) => {
                const row = document.createElement('div');
                row.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; background: rgba(255,255,255,0.02); border-radius: 8px;';

                const left = document.createElement('div');
                left.style.cssText = 'display: flex; align-items: center; gap: 8px;';

                const addr = document.createElement('span');
                addr.style.cssText = 'font-size: 12px; color: rgba(255,255,255,0.7); font-family: "SF Mono", monospace;';
                addr.textContent = r.address ? r.address.slice(0, 4) + '...' + r.address.slice(-4) : 'Unknown';

                const amount = document.createElement('span');
                amount.style.cssText = 'font-size: 12px; font-weight: 600; color: #fff;';
                amount.textContent = (r.amount || 0).toFixed(4) + ' SOL';

                left.appendChild(addr);
                row.appendChild(left);
                row.appendChild(amount);

                if (r.txHash) {
                    row.style.cursor = 'pointer';
                    row.onclick = () => window.open(`https://solscan.io/tx/${r.txHash}`, '_blank');
                }

                recipientsList.appendChild(row);
            });

            if (result.results.length > 5) {
                const more = document.createElement('div');
                more.style.cssText = 'text-align: center; font-size: 11px; color: rgba(255,255,255,0.4); padding: 4px;';
                more.textContent = `+${result.results.length - 5} more`;
                recipientsList.appendChild(more);
            }

            recipientsSection.appendChild(recipientsList);
        }

        modal.appendChild(recipientsSection);

        // Execution time
        if (result.executionTime) {
            const timeEl = document.createElement('div');
            timeEl.style.cssText = 'font-size: 11px; color: rgba(255,255,255,0.4); margin-bottom: 16px;';
            timeEl.textContent = `Completed in ${(result.executionTime / 1000).toFixed(1)}s`;
            modal.appendChild(timeEl);
        }

        // Close button
        const closeBtn = document.createElement('button');
        closeBtn.style.cssText = 'width: 100%; padding: 14px; border-radius: 12px; border: none; background: linear-gradient(135deg, #0ea5e9, #0284c7); color: #fff; cursor: pointer; font-weight: 600; font-size: 14px; box-shadow: 0 4px 16px rgba(14, 165, 233, 0.3);';
        closeBtn.textContent = 'Done';
        closeBtn.addEventListener('click', () => overlay.remove());
        modal.appendChild(closeBtn);

        overlay.appendChild(modal);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });

        document.body.appendChild(overlay);
    }

    /**
     * Show error modal for failed operations
     */
    showErrorModal(title, message, errorDetails = null) {
        const overlay = document.createElement('div');
        overlay.className = 'cc-modal-backdrop visible';
        overlay.style.zIndex = '100002';

        const modal = document.createElement('div');
        modal.className = 'cc-modal';
        modal.style.maxWidth = '400px';
        modal.style.textAlign = 'center';

        // Error icon
        const iconContainer = document.createElement('div');
        iconContainer.style.cssText = 'width: 64px; height: 64px; border-radius: 50%; background: linear-gradient(135deg, #ef4444, #dc2626); display: flex; align-items: center; justify-content: center; margin: 0 auto 16px;';

        const errorIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        errorIcon.setAttribute('width', '32');
        errorIcon.setAttribute('height', '32');
        errorIcon.setAttribute('viewBox', '0 0 24 24');
        errorIcon.setAttribute('fill', 'none');
        errorIcon.setAttribute('stroke', '#fff');
        errorIcon.setAttribute('stroke-width', '3');
        errorIcon.setAttribute('stroke-linecap', 'round');
        errorIcon.setAttribute('stroke-linejoin', 'round');

        const line1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line1.setAttribute('x1', '18');
        line1.setAttribute('y1', '6');
        line1.setAttribute('x2', '6');
        line1.setAttribute('y2', '18');

        const line2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line2.setAttribute('x1', '6');
        line2.setAttribute('y1', '6');
        line2.setAttribute('x2', '18');
        line2.setAttribute('y2', '18');

        errorIcon.appendChild(line1);
        errorIcon.appendChild(line2);
        iconContainer.appendChild(errorIcon);
        modal.appendChild(iconContainer);

        // Title
        const titleEl = document.createElement('h3');
        titleEl.style.cssText = 'color: #fff; margin: 0 0 8px 0; font-size: 20px;';
        titleEl.textContent = title;
        modal.appendChild(titleEl);

        // Message
        const messageEl = document.createElement('p');
        messageEl.style.cssText = 'color: rgba(255,255,255,0.6); font-size: 14px; margin: 0 0 16px 0;';
        messageEl.textContent = message;
        modal.appendChild(messageEl);

        // Error details
        if (errorDetails) {
            const detailsBox = document.createElement('div');
            detailsBox.style.cssText = 'background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 10px; padding: 12px; margin-bottom: 16px; text-align: left;';

            const detailText = document.createElement('p');
            detailText.style.cssText = 'color: rgba(255,255,255,0.7); font-size: 11px; font-family: "SF Mono", monospace; margin: 0; word-break: break-all;';
            detailText.textContent = errorDetails;
            detailsBox.appendChild(detailText);
            modal.appendChild(detailsBox);
        }

        // Close button
        const closeBtn = document.createElement('button');
        closeBtn.style.cssText = 'width: 100%; padding: 14px; border-radius: 12px; border: none; background: rgba(255,255,255,0.1); color: #fff; cursor: pointer; font-weight: 600; font-size: 14px;';
        closeBtn.textContent = 'Close';
        closeBtn.addEventListener('click', () => overlay.remove());
        modal.appendChild(closeBtn);

        overlay.appendChild(modal);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });

        document.body.appendChild(overlay);
    }

    /**
     * Show transfer modal for a burner wallet (supports multiple recipients)
     */
    async showTransferModal(fromWallet) {
        const web3 = window.solanaWeb3;
        if (!web3) {
            this.showErrorToast('Solana Web3 not loaded');
            return;
        }

        const MAX_RECIPIENTS = 5;

        // Get all burner wallets for recipient dropdown
        const allBurners = CryptoClient.getBurnerWallets();
        const otherBurners = allBurners.filter(w => w.id !== fromWallet.id);

        // Fetch current balance
        let balanceLamports = 0;
        try {
            const connection = new web3.Connection(CryptoClient.SYNDICA_RPC, 'confirmed');
            const pubkey = new web3.PublicKey(fromWallet.publicKey);
            balanceLamports = await connection.getBalance(pubkey);
        } catch (err) {
            console.error('[CryptoClient] Failed to fetch balance:', err);
        }

        const balanceSOL = balanceLamports / 1e9;

        // Check privacy mode
        const isPrivacyMode = window.privacyMode || false;

        // Create modal overlay
        const overlay = document.createElement('div');
        overlay.className = 'cc-modal-backdrop';
        overlay.style.zIndex = '100001';

        // Create bottom sheet modal
        const modal = document.createElement('div');
        modal.className = 'cc-transfer-modal' + (isPrivacyMode ? ' cc-privacy-mode' : '');

        // Drag handle (mobile only)
        const handle = document.createElement('div');
        handle.className = 'cc-transfer-modal-handle';
        modal.appendChild(handle);

        // Content wrapper
        const content = document.createElement('div');
        content.className = 'cc-transfer-modal-content';

        // Header with title and close button
        const header = document.createElement('div');
        header.className = 'cc-transfer-modal-header';

        const titleWrapper = document.createElement('div');
        titleWrapper.className = 'cc-transfer-title-wrapper';

        const title = document.createElement('h3');
        title.className = 'cc-transfer-modal-title';
        title.textContent = isPrivacyMode ? 'Private Transfer' : 'Transfer SOL';
        titleWrapper.appendChild(title);

        // Add privacy badge if in privacy mode
        if (isPrivacyMode) {
            const privacyBadge = document.createElement('span');
            privacyBadge.className = 'cc-transfer-privacy-badge';
            privacyBadge.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                </svg>
                PrivacyCash
            `;
            titleWrapper.appendChild(privacyBadge);
        }

        const closeBtn = document.createElement('button');
        closeBtn.className = 'cc-transfer-modal-close';
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', () => closeModal());

        header.appendChild(titleWrapper);
        header.appendChild(closeBtn);
        content.appendChild(header);

        // Source wallet card
        const sourceCard = document.createElement('div');
        sourceCard.className = 'cc-transfer-source';

        const sourceLabel = document.createElement('p');
        sourceLabel.className = 'cc-transfer-source-label';
        sourceLabel.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 19V5M5 12l7-7 7 7"/>
            </svg>
            Sending From
        `;

        const sourceName = document.createElement('p');
        sourceName.className = 'cc-transfer-source-name';
        sourceName.textContent = fromWallet.name || 'Burner Wallet';

        const sourceBalance = document.createElement('div');
        sourceBalance.className = 'cc-transfer-source-balance';

        const sourceAmount = document.createElement('span');
        sourceAmount.className = 'cc-transfer-source-amount';
        sourceAmount.textContent = balanceSOL.toFixed(4);

        const sourceUnit = document.createElement('span');
        sourceUnit.className = 'cc-transfer-source-unit';
        sourceUnit.textContent = 'SOL';

        sourceBalance.appendChild(sourceAmount);
        sourceBalance.appendChild(sourceUnit);

        sourceCard.appendChild(sourceLabel);
        sourceCard.appendChild(sourceName);
        sourceCard.appendChild(sourceBalance);
        content.appendChild(sourceCard);

        // Recipients section header
        const sectionHeader = document.createElement('div');
        sectionHeader.className = 'cc-transfer-section-header';

        const sectionTitle = document.createElement('p');
        sectionTitle.className = 'cc-transfer-section-title';
        sectionTitle.textContent = 'Select Recipients';

        const recipientCountEl = document.createElement('span');
        recipientCountEl.className = 'cc-transfer-recipient-count';
        recipientCountEl.textContent = '0 selected';

        sectionHeader.appendChild(sectionTitle);
        sectionHeader.appendChild(recipientCountEl);
        content.appendChild(sectionHeader);

        // Card grid for wallet selection
        const walletGrid = document.createElement('div');
        walletGrid.className = 'cc-transfer-wallet-grid';

        // Track selected wallets
        const selectedWallets = new Map(); // address -> { wallet, card, amountInput }

        // Create wallet card
        const createWalletCard = (wallet, isExternal = false) => {
            const card = document.createElement('div');
            card.className = 'cc-transfer-wallet-card' + (isExternal ? ' external' : '');
            card.dataset.address = wallet.publicKey || 'external';

            const cardContent = document.createElement('div');
            cardContent.className = 'cc-transfer-wallet-card-content';

            const icon = document.createElement('span');
            icon.className = 'cc-transfer-wallet-icon';
            icon.textContent = isExternal ? '📤' : '🔥';

            const info = document.createElement('div');
            info.className = 'cc-transfer-wallet-info';

            const name = document.createElement('div');
            name.className = 'cc-transfer-wallet-name';
            name.textContent = isExternal ? (wallet.label || 'External') : (wallet.name || 'Burner');

            const addr = document.createElement('div');
            addr.className = 'cc-transfer-wallet-addr';
            addr.textContent = isExternal ? 'Custom address' : (wallet.publicKey.slice(0, 4) + '...' + wallet.publicKey.slice(-4));

            info.appendChild(name);
            info.appendChild(addr);

            // Add balance for burner wallets
            if (!isExternal) {
                const balance = document.createElement('div');
                balance.className = 'cc-transfer-wallet-balance';
                balance.textContent = '...';
                info.appendChild(balance);
                card.balanceEl = balance;
            }

            const checkmark = document.createElement('div');
            checkmark.className = 'cc-transfer-wallet-check';
            checkmark.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>`;

            cardContent.appendChild(icon);
            cardContent.appendChild(info);
            cardContent.appendChild(checkmark);
            card.appendChild(cardContent);

            // External address input (hidden by default)
            if (isExternal) {
                const extInput = document.createElement('input');
                extInput.type = 'text';
                extInput.className = 'cc-transfer-ext-addr-input';
                extInput.placeholder = 'Enter Solana address...';
                extInput.onclick = (e) => e.stopPropagation();
                card.appendChild(extInput);
                card.extInput = extInput;
            }

            // Toggle selection on click
            card.onclick = () => {
                const address = card.dataset.address;

                if (card.classList.contains('selected')) {
                    card.classList.remove('selected');
                    selectedWallets.delete(address);
                } else {
                    if (selectedWallets.size >= MAX_RECIPIENTS) {
                        return; // Max reached
                    }
                    card.classList.add('selected');
                    selectedWallets.set(address, {
                        wallet: isExternal ? null : wallet,
                        card,
                        isExternal
                    });
                }
                updateSelectionUI();
            };

            return card;
        };

        // Add burner wallet cards and track them for balance updates
        const walletCards = [];
        otherBurners.forEach(w => {
            const card = createWalletCard(w);
            card.wallet = w;
            walletCards.push(card);
            walletGrid.appendChild(card);
        });

        // Track external wallet cards
        let externalCount = 0;
        const externalCards = [];

        // Create "Add External" button card
        const addExternalBtn = document.createElement('div');
        addExternalBtn.className = 'cc-transfer-add-external-btn';
        addExternalBtn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 5v14M5 12h14"/>
            </svg>
            <span>Add External</span>
        `;

        const addExternalCard = () => {
            if (selectedWallets.size >= MAX_RECIPIENTS) return;

            externalCount++;
            const extId = 'external-' + externalCount;
            const card = createWalletCard({ label: 'External ' + externalCount }, true);
            card.dataset.address = extId;
            externalCards.push(card);

            // Insert before the add button
            walletGrid.insertBefore(card, addExternalBtn);

            // Auto-select the new card
            card.classList.add('selected');
            selectedWallets.set(extId, {
                wallet: null,
                card,
                isExternal: true
            });
            updateSelectionUI();

            // Focus the input
            setTimeout(() => card.extInput?.focus(), 50);
        };

        addExternalBtn.onclick = addExternalCard;
        walletGrid.appendChild(addExternalBtn);

        content.appendChild(walletGrid);

        // Fetch balances asynchronously
        (async () => {
            const connection = new web3.Connection(CryptoClient.SYNDICA_RPC, 'confirmed');
            for (const card of walletCards) {
                try {
                    const pubkey = new web3.PublicKey(card.wallet.publicKey);
                    const bal = await connection.getBalance(pubkey);
                    const solBal = bal / 1e9;
                    if (card.balanceEl) {
                        card.balanceEl.textContent = solBal.toFixed(4) + ' SOL';
                    }
                } catch (err) {
                    if (card.balanceEl) card.balanceEl.textContent = '—';
                }
            }
        })();

        // Amount section (shown when wallets selected)
        const amountSection = document.createElement('div');
        amountSection.className = 'cc-transfer-amount-section';
        amountSection.style.display = 'none';

        const amountHeader = document.createElement('div');
        amountHeader.className = 'cc-transfer-amount-header';

        const amountLabel = document.createElement('span');
        amountLabel.textContent = 'Amount per recipient';

        const evenSplitBtn = document.createElement('button');
        evenSplitBtn.className = 'cc-transfer-even-split';
        evenSplitBtn.textContent = 'Max Split';
        evenSplitBtn.title = 'Split max balance evenly';

        amountHeader.appendChild(amountLabel);
        amountHeader.appendChild(evenSplitBtn);
        amountSection.appendChild(amountHeader);

        const amountInput = document.createElement('input');
        amountInput.type = 'number';
        amountInput.className = 'cc-transfer-global-amount';
        amountInput.placeholder = '0.0';
        amountInput.step = '0.000001';
        amountInput.min = '0';
        amountSection.appendChild(amountInput);

        content.appendChild(amountSection);

        // Summary row
        const summaryRow = document.createElement('div');
        summaryRow.className = 'cc-transfer-summary';

        const summaryLabel = document.createElement('span');
        summaryLabel.className = 'cc-transfer-summary-label';
        summaryLabel.textContent = 'Total to send';

        const summaryValue = document.createElement('span');
        summaryValue.className = 'cc-transfer-summary-value';
        summaryValue.textContent = '0 SOL';

        summaryRow.appendChild(summaryLabel);
        summaryRow.appendChild(summaryValue);
        content.appendChild(summaryRow);

        // Error display
        const errorDisplay = document.createElement('div');
        errorDisplay.className = 'cc-transfer-error';
        content.appendChild(errorDisplay);

        // Action buttons
        const actionsRow = document.createElement('div');
        actionsRow.className = 'cc-transfer-actions';

        const sendBtn = document.createElement('button');
        sendBtn.className = 'cc-transfer-send-btn';
        sendBtn.textContent = 'Send All';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'cc-transfer-cancel-btn';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => closeModal());

        actionsRow.appendChild(sendBtn);
        actionsRow.appendChild(cancelBtn);
        content.appendChild(actionsRow);

        modal.appendChild(content);
        overlay.appendChild(modal);

        // Close modal function
        const closeModal = () => {
            modal.classList.remove('visible');
            overlay.classList.remove('visible');
            setTimeout(() => overlay.remove(), 400);
        };

        // Update selection UI
        const updateSelectionUI = () => {
            const count = selectedWallets.size;
            recipientCountEl.textContent = count + ' selected';

            // Show/hide amount section
            amountSection.style.display = count > 0 ? 'block' : 'none';

            // Update total
            const perAmount = parseFloat(amountInput.value) || 0;
            const total = perAmount * count;
            summaryValue.textContent = total.toFixed(6) + ' SOL';

            // Update send button state
            sendBtn.disabled = count === 0;
        };

        // Amount input handler
        amountInput.addEventListener('input', updateSelectionUI);

        // Even split handler
        evenSplitBtn.addEventListener('click', () => {
            const count = selectedWallets.size;
            if (count === 0) return;

            // Leave 0.002 SOL for fees per transfer + base fee
            const feeBuffer = 0.002 + (0.000005 * count);
            const distributable = Math.max(0, balanceSOL - feeBuffer);
            const perRecipient = distributable / count;

            amountInput.value = perRecipient.toFixed(6);
            updateSelectionUI();
        });

        // Send button click handler
        sendBtn.addEventListener('click', async () => {
            errorDisplay.classList.remove('visible');

            const perAmount = parseFloat(amountInput.value) || 0;

            if (perAmount <= 0) {
                errorDisplay.textContent = 'Enter a valid amount';
                errorDisplay.classList.add('visible');
                return;
            }

            if (selectedWallets.size === 0) {
                errorDisplay.textContent = 'Select at least one recipient';
                errorDisplay.classList.add('visible');
                return;
            }

            // Validate and collect transfers
            const transfers = [];

            for (const [address, data] of selectedWallets) {
                let toAddress = address;

                // Handle external address
                if (data.isExternal) {
                    toAddress = data.card.extInput?.value?.trim();
                    if (!toAddress) {
                        errorDisplay.textContent = 'Enter external address';
                        errorDisplay.classList.add('visible');
                        return;
                    }
                }

                // Validate address
                try {
                    new web3.PublicKey(toAddress);
                } catch {
                    errorDisplay.textContent = 'Invalid address: ' + toAddress.slice(0, 8) + '...';
                    errorDisplay.classList.add('visible');
                    return;
                }

                transfers.push({ address: toAddress, amount: perAmount });
            }

            const totalAmount = perAmount * transfers.length;

            // Check total balance
            const estimatedFee = 0.000005 * transfers.length + 0.001;
            if (totalAmount + estimatedFee > balanceSOL) {
                errorDisplay.textContent = 'Insufficient balance (need ~' + estimatedFee.toFixed(6) + ' SOL for fees)';
                errorDisplay.classList.add('visible');
                return;
            }

            // Disable and show loading
            sendBtn.disabled = true;
            sendBtn.textContent = 'Sending ' + transfers.length + ' transfer' + (transfers.length > 1 ? 's' : '') + '...';

            try {
                const result = await this.transferFromBurnerMulti(fromWallet, transfers);

                if (result.success) {
                    closeModal();

                    // Show privacy-specific success modal if it was a privacy transfer
                    if (result.privacyMode) {
                        this.showPrivacyTransferSuccess(result);
                    } else {
                        const totalSent = transfers.reduce((sum, t) => sum + t.amount, 0);

                        this.showSuccessModal(
                            'Transfer Complete',
                            `Successfully sent SOL to ${transfers.length} recipient${transfers.length > 1 ? 's' : ''}`,
                            [
                                { label: 'Recipients', value: transfers.length.toString() },
                                { label: 'Total Sent', value: totalSent.toFixed(6) + ' SOL' },
                                { label: 'Transaction', value: result.signature ? result.signature.slice(0, 16) + '...' : 'Confirmed' }
                            ]
                        );
                    }

                    this.renderBurnerView();
                } else {
                    throw new Error(result.error || 'Transfer failed');
                }
            } catch (err) {
                console.error('[CryptoClient] Transfer error:', err);
                errorDisplay.textContent = err.message || 'Transfer failed';
                errorDisplay.classList.add('visible');
                sendBtn.disabled = false;
                sendBtn.textContent = 'Send All';
            }
        });

        // Click outside to close
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeModal();
        });

        document.body.appendChild(overlay);

        // Animate in
        requestAnimationFrame(() => {
            overlay.classList.add('visible');
            requestAnimationFrame(() => {
                modal.classList.add('visible');
            });
        });
    }

    /**
     * Transfer SOL from a burner wallet to multiple recipients in one transaction
     * @param {Object} fromWallet - Burner wallet object with secretKey
     * @param {Array} transfers - Array of { address: string, amount: number (SOL) }
     * @returns {Promise<Object>} - { success, signature } or { success: false, error }
     */
    async transferFromBurnerMulti(fromWallet, transfers) {
        if (!transfers || transfers.length === 0) {
            return { success: false, error: 'No transfers specified' };
        }

        if (transfers.length > 5) {
            return { success: false, error: 'Maximum 5 recipients per transaction' };
        }

        // If privacy mode is enabled, use PrivacyCash bulk-withdraw API
        if (window.privacyMode) {
            return this._transferViaPrivacyCash(fromWallet, transfers);
        }

        // Normal on-chain transfer
        return this._transferOnChain(fromWallet, transfers);
    }

    /**
     * Transfer SOL via PrivacyCash bulk-deposit-withdraw API (privacy mode)
     * Deposits from source wallet and withdraws to multiple recipients in one call
     * @private
     */
    async _transferViaPrivacyCash(fromWallet, transfers) {
        try {
            // Get private key as base58
            const secretKey = new Uint8Array(fromWallet.secretKey);
            const privateKeyBase58 = CryptoClient.encodeBase58(secretKey);

            // Format recipients for API
            const recipients = transfers.map(t => ({
                address: t.address,
                amount: t.amount
            }));

            console.log('[CryptoClient] Using PrivacyCash bulk-deposit-withdraw for', recipients.length, 'recipients');

            const response = await fetch('https://proofnetwork.lol/api/privacy-cash/bulk-deposit-withdraw', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.config.apiKey}`
                },
                body: JSON.stringify({
                    privateKey: privateKeyBase58,
                    currency: 'SOL',
                    recipients: recipients
                })
            });

            const result = await response.json();
            console.log('[CryptoClient] PrivacyCash bulk-deposit-withdraw result:', result);

            if (result.success) {
                return {
                    success: true,
                    count: result.successful || recipients.length,
                    totalAmount: result.totalAmount,
                    privacyMode: true,
                    depositTxHash: result.depositTxHash,
                    depositAmount: result.depositAmount,
                    depositFee: result.depositFee,
                    netDeposited: result.netDeposited,
                    results: result.results,
                    executionTime: result.executionTime
                };
            } else {
                return {
                    success: false,
                    error: result.error || 'PrivacyCash transfer failed',
                    failed: result.failed,
                    results: result.results
                };
            }
        } catch (err) {
            console.error('[CryptoClient] PrivacyCash bulk-deposit-withdraw error:', err);
            return { success: false, error: err.message || 'PrivacyCash transfer failed' };
        }
    }

    /**
     * Transfer SOL directly on-chain (normal mode)
     * @private
     */
    async _transferOnChain(fromWallet, transfers) {
        const web3 = window.solanaWeb3;
        if (!web3) {
            return { success: false, error: 'Solana Web3 not loaded' };
        }

        try {
            const connection = new web3.Connection(CryptoClient.SYNDICA_RPC, 'confirmed');

            // Create keypair from secret key
            const secretKey = new Uint8Array(fromWallet.secretKey);
            const fromKeypair = web3.Keypair.fromSecretKey(secretKey);
            const fromPubkey = fromKeypair.publicKey;

            // Create transaction with multiple transfer instructions
            const transaction = new web3.Transaction();

            for (const transfer of transfers) {
                const toPubkey = new web3.PublicKey(transfer.address);
                const lamports = Math.floor(transfer.amount * 1e9);

                transaction.add(
                    web3.SystemProgram.transfer({
                        fromPubkey,
                        toPubkey,
                        lamports
                    })
                );
            }

            // Get recent blockhash
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = fromPubkey;

            // Sign transaction with burner keypair
            transaction.sign(fromKeypair);

            // Send transaction
            const signature = await connection.sendRawTransaction(
                transaction.serialize(),
                { skipPreflight: false, preflightCommitment: 'confirmed' }
            );

            // Confirm transaction
            await connection.confirmTransaction({
                signature,
                blockhash,
                lastValidBlockHeight
            }, 'confirmed');

            console.log('[CryptoClient] Multi-transfer successful:', signature, '(' + transfers.length + ' recipients)');
            return { success: true, signature, count: transfers.length };

        } catch (err) {
            console.error('[CryptoClient] Multi-transfer failed:', err);
            return { success: false, error: err.message || 'Transfer failed' };
        }
    }

    /**
     * Transfer SOL from a burner wallet (single recipient - convenience wrapper)
     * @param {Object} fromWallet - Burner wallet object with secretKey
     * @param {string} toAddress - Recipient address
     * @param {number} amountSOL - Amount in SOL
     * @returns {Promise<Object>} - { success, signature } or { success: false, error }
     */
    async transferFromBurner(fromWallet, toAddress, amountSOL) {
        return this.transferFromBurnerMulti(fromWallet, [{ address: toAddress, amount: amountSOL }]);
    }

    // Helius RPC endpoint
    // Pool-backed RPC URL accessor. Delegates to window.solRpcPool.pickUrl(),
    // which asks the pool which endpoint it would currently route a read
    // through — so the URL we hand to `new Connection(URL, …)` reflects live
    // bucket state (rate-limit aware), not a static list index. The patched
    // Connection.prototype._rpcRequest is what *actually* serves requests; this
    // value is mostly used for `connection.rpcEndpoint` introspection and the
    // very first request before the patch lands.
    static get SYNDICA_RPC() {
        const pool = window.solRpcPool;
        if (pool && typeof pool.pickUrl === 'function') return pool.pickUrl();
        return 'https://api.mainnet-beta.solana.com';
    }

    /**
     * Batch-fetch SOL balances with retry + chunking to handle flaky RPCs.
     * Uses getBalance per pubkey (parallelised per chunk) rather than
     * getMultipleAccountsInfo. The return shape is kept identical — an array
     * of { lamports } objects (or null) aligned 1:1 with `pubkeys` — so every
     * caller that reads `.lamports` keeps working unchanged.
     * @param {PublicKey[]} pubkeys
     * @param {Connection} connection  (optional — creates one if omitted)
     * @returns {Array<{lamports:number}|null>}
     */
    static async batchGetAccountsInfo(pubkeys, connection) {
        const web3 = window.solanaWeb3;
        if (!web3 || pubkeys.length === 0) return new Array(pubkeys.length).fill(null);
        if (!connection) {
            connection = new web3.Connection(CryptoClient.SYNDICA_RPC, 'confirmed');
        }
        const BATCH = 5;
        const MAX_RETRIES = 3;
        const results = new Array(pubkeys.length).fill(null);

        for (let i = 0; i < pubkeys.length; i += BATCH) {
            const chunk = pubkeys.slice(i, i + BATCH);
            let lastErr;
            for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
                try {
                    const lamports = await Promise.all(
                        chunk.map(pk => connection.getBalance(pk))
                    );
                    lamports.forEach((bal, j) => { results[i + j] = { lamports: bal }; });
                    lastErr = null;
                    break;
                } catch (err) {
                    lastErr = err;
                    console.warn('[CryptoClient] batchGetAccountsInfo chunk retry', attempt + 1, err.message);
                    await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
                }
            }
            if (lastErr) {
                console.error('[CryptoClient] batchGetAccountsInfo chunk failed after retries:', lastErr);
            }
        }
        return results;
    }

    /**
     * Show bulk swap modal to buy tokens across multiple burner wallets
     */
    async showBulkSwapModal() {
        const web3 = window.solanaWeb3;
        if (!web3) {
            this.showErrorToast('Solana Web3 not loaded');
            return;
        }

        const burnerWallets = CryptoClient.getBurnerWallets();
        if (burnerWallets.length === 0) {
            this.showErrorToast('No burner wallets available');
            return;
        }

        // Fetch balances for all wallets
        const walletData = [];
        try {
            const pubkeys = burnerWallets.map(w => new web3.PublicKey(w.publicKey));
            const accountInfos = await CryptoClient.batchGetAccountsInfo(pubkeys);

            // Map results back to wallet data
            burnerWallets.forEach((wallet, index) => {
                const accountInfo = accountInfos[index];
                const balanceLamports = accountInfo ? accountInfo.lamports : 0;
                walletData.push({
                    ...wallet,
                    balanceLamports,
                    balanceSOL: balanceLamports / 1e9
                });
            });
        } catch (err) {
            console.error('[CryptoClient] Failed to fetch balances:', err);
            burnerWallets.forEach(w => {
                walletData.push({ ...w, balanceLamports: 0, balanceSOL: 0 });
            });
        }

        // Create modal overlay
        const overlay = document.createElement('div');
        overlay.className = 'cc-modal-backdrop';
        overlay.style.zIndex = '100001';

        // Create bottom sheet modal
        const modal = document.createElement('div');
        modal.className = 'cc-bulk-modal';

        // Drag handle (mobile only)
        const handle = document.createElement('div');
        handle.className = 'cc-bulk-modal-handle';
        modal.appendChild(handle);

        // Content wrapper
        const content = document.createElement('div');
        content.className = 'cc-bulk-modal-content';

        // Header with title and close button
        const header = document.createElement('div');
        header.className = 'cc-bulk-modal-header';

        const title = document.createElement('h3');
        title.className = 'cc-bulk-modal-title';
        title.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <ellipse cx="12" cy="6" rx="8" ry="3"/>
                <path d="M4 6v6c0 1.657 3.582 3 8 3s8-1.343 8-3V6"/>
                <path d="M4 12v6c0 1.657 3.582 3 8 3s8-1.343 8-3v-6"/>
            </svg>
            Bulk Buy Token
        `;

        const closeBtn = document.createElement('button');
        closeBtn.className = 'cc-bulk-modal-close';
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', () => closeModal());

        header.appendChild(title);
        header.appendChild(closeBtn);
        content.appendChild(header);

        // Token input section
        const tokenSection = document.createElement('div');
        tokenSection.className = 'cc-bulk-token-section';

        const tokenLabel = document.createElement('p');
        tokenLabel.className = 'cc-bulk-token-label';
        tokenLabel.textContent = 'Token Mint Address';

        const tokenInput = document.createElement('input');
        tokenInput.type = 'text';
        tokenInput.className = 'cc-bulk-token-input';
        tokenInput.placeholder = 'Enter token mint address...';

        const totalRow = document.createElement('div');
        totalRow.className = 'cc-bulk-total-row';

        const totalInputWrap = document.createElement('div');
        totalInputWrap.className = 'cc-bulk-total-input-wrap';

        const totalSolInput = document.createElement('input');
        totalSolInput.type = 'number';
        totalSolInput.className = 'cc-bulk-total-input';
        totalSolInput.placeholder = 'Total SOL to spend...';
        totalSolInput.step = '0.001';
        totalSolInput.min = '0';

        totalInputWrap.appendChild(totalSolInput);

        const splitBtn = document.createElement('button');
        splitBtn.className = 'cc-bulk-split-btn';
        splitBtn.textContent = 'Even Split';
        splitBtn.title = 'Split total evenly across selected wallets';

        totalRow.appendChild(totalInputWrap);
        totalRow.appendChild(splitBtn);

        tokenSection.appendChild(tokenLabel);
        tokenSection.appendChild(tokenInput);
        tokenSection.appendChild(totalRow);
        content.appendChild(tokenSection);

        // Wallets section header
        const walletsHeader = document.createElement('div');
        walletsHeader.className = 'cc-bulk-wallets-header';

        const walletsTitle = document.createElement('p');
        walletsTitle.className = 'cc-bulk-wallets-title';
        walletsTitle.textContent = 'Select Wallets';

        const selectAllLabel = document.createElement('label');
        selectAllLabel.className = 'cc-bulk-select-all';

        const selectAllCheckbox = document.createElement('input');
        selectAllCheckbox.type = 'checkbox';

        const selectAllText = document.createElement('span');
        selectAllText.textContent = 'Select All';

        selectAllLabel.appendChild(selectAllCheckbox);
        selectAllLabel.appendChild(selectAllText);

        walletsHeader.appendChild(walletsTitle);
        walletsHeader.appendChild(selectAllLabel);
        content.appendChild(walletsHeader);

        // Wallet list
        const walletList = document.createElement('div');
        walletList.className = 'cc-bulk-wallet-list';

        // Track selected wallets
        const selectedWallets = new Map();

        walletData.forEach(wallet => {
            const card = document.createElement('div');
            card.className = 'cc-bulk-wallet-card';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'cc-bulk-wallet-checkbox';

            const info = document.createElement('div');
            info.className = 'cc-bulk-wallet-info';

            const name = document.createElement('p');
            name.className = 'cc-bulk-wallet-name';
            name.textContent = wallet.name || 'Burner ' + wallet.publicKey.slice(0, 6);

            const balance = document.createElement('p');
            balance.className = 'cc-bulk-wallet-balance';
            balance.textContent = wallet.balanceSOL.toFixed(4) + ' SOL';

            info.appendChild(name);
            info.appendChild(balance);

            const amountInput = document.createElement('input');
            amountInput.type = 'number';
            amountInput.className = 'cc-bulk-wallet-amount';
            amountInput.placeholder = 'SOL';
            amountInput.step = '0.0001';
            amountInput.min = '0';
            amountInput.disabled = true;

            // Initialize tracking
            selectedWallets.set(wallet.id, {
                wallet,
                selected: false,
                amount: 0,
                checkbox,
                amountInput
            });

            // Checkbox change
            checkbox.addEventListener('change', () => {
                const data = selectedWallets.get(wallet.id);
                data.selected = checkbox.checked;
                amountInput.disabled = !checkbox.checked;
                card.classList.toggle('selected', checkbox.checked);

                if (!checkbox.checked) {
                    amountInput.value = '';
                    data.amount = 0;
                }
                updateSummary();
            });

            // Amount change
            amountInput.addEventListener('input', () => {
                const data = selectedWallets.get(wallet.id);
                data.amount = parseFloat(amountInput.value) || 0;
                updateSummary();
            });

            card.appendChild(checkbox);
            card.appendChild(info);
            card.appendChild(amountInput);
            walletList.appendChild(card);
        });

        content.appendChild(walletList);

        // Summary row
        const summaryRow = document.createElement('div');
        summaryRow.className = 'cc-bulk-summary';

        const summaryItem1 = document.createElement('div');
        summaryItem1.className = 'cc-bulk-summary-item';
        const summaryLabel1 = document.createElement('p');
        summaryLabel1.className = 'cc-bulk-summary-label';
        summaryLabel1.textContent = 'Wallets';
        const summaryWallets = document.createElement('p');
        summaryWallets.className = 'cc-bulk-summary-value';
        summaryWallets.textContent = '0';
        summaryItem1.appendChild(summaryLabel1);
        summaryItem1.appendChild(summaryWallets);

        const summaryItem2 = document.createElement('div');
        summaryItem2.className = 'cc-bulk-summary-item';
        const summaryLabel2 = document.createElement('p');
        summaryLabel2.className = 'cc-bulk-summary-label';
        summaryLabel2.textContent = 'Total SOL';
        const summaryTotal = document.createElement('p');
        summaryTotal.className = 'cc-bulk-summary-value';
        summaryTotal.textContent = '0';
        summaryItem2.appendChild(summaryLabel2);
        summaryItem2.appendChild(summaryTotal);

        summaryRow.appendChild(summaryItem1);
        summaryRow.appendChild(summaryItem2);
        content.appendChild(summaryRow);

        // Error display
        const errorDisplay = document.createElement('div');
        errorDisplay.className = 'cc-bulk-error';
        content.appendChild(errorDisplay);

        // Action buttons
        const actionsRow = document.createElement('div');
        actionsRow.className = 'cc-bulk-actions';

        const executeBtn = document.createElement('button');
        executeBtn.className = 'cc-bulk-execute-btn';
        executeBtn.textContent = 'Execute Bulk Buy';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'cc-bulk-cancel-btn';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => closeModal());

        actionsRow.appendChild(executeBtn);
        actionsRow.appendChild(cancelBtn);
        content.appendChild(actionsRow);

        modal.appendChild(content);
        overlay.appendChild(modal);

        // Close modal function
        const closeModal = () => {
            modal.classList.remove('visible');
            overlay.classList.remove('visible');
            setTimeout(() => overlay.remove(), 400);
        };

        // Update summary function
        const updateSummary = () => {
            let totalSOL = 0;
            let walletCount = 0;
            selectedWallets.forEach((data) => {
                if (data.selected && data.amount > 0) {
                    totalSOL += data.amount;
                    walletCount++;
                }
            });
            summaryWallets.textContent = walletCount;
            summaryTotal.textContent = totalSOL.toFixed(4) + ' SOL';
        };

        // Select all handler - only selects wallets with balance > 0
        selectAllCheckbox.addEventListener('change', () => {
            const isChecked = selectAllCheckbox.checked;
            selectedWallets.forEach((data) => {
                // Only select wallets that have balance when checking
                const hasFunds = data.wallet.balanceSOL > 0.001;
                const shouldSelect = isChecked && hasFunds;

                data.checkbox.checked = shouldSelect;
                data.selected = shouldSelect;
                data.amountInput.disabled = !shouldSelect;
                data.checkbox.closest('.cc-bulk-wallet-card').classList.toggle('selected', shouldSelect);
                if (!shouldSelect) {
                    data.amountInput.value = '';
                    data.amount = 0;
                }
            });
            updateSummary();
        });

        // Even split handler - skips wallets with 0 balance
        splitBtn.addEventListener('click', () => {
            // Only count wallets with actual balance
            let fundedSelected = Array.from(selectedWallets.values()).filter(
                d => d.selected && d.wallet.balanceSOL > 0.001
            );

            // If no funded wallets selected, auto-select all funded wallets
            if (fundedSelected.length === 0) {
                selectAllCheckbox.checked = true;
                selectedWallets.forEach((data) => {
                    const hasFunds = data.wallet.balanceSOL > 0.001;
                    if (hasFunds) {
                        data.checkbox.checked = true;
                        data.selected = true;
                        data.amountInput.disabled = false;
                        data.checkbox.closest('.cc-bulk-wallet-card').classList.add('selected');
                    }
                });
                fundedSelected = Array.from(selectedWallets.values()).filter(
                    d => d.selected && d.wallet.balanceSOL > 0.001
                );
            }

            if (fundedSelected.length === 0) return;

            const totalSolValue = parseFloat(totalSolInput.value);

            if (totalSolValue > 0) {
                // Split specified amount only across funded wallets
                const perWallet = totalSolValue / fundedSelected.length;
                fundedSelected.forEach(data => {
                    data.amountInput.value = perWallet.toFixed(4);
                    data.amount = perWallet;
                });
            } else {
                // Use wallet balances - only from funded wallets
                let totalAvailable = 0;
                fundedSelected.forEach(data => {
                    totalAvailable += data.wallet.balanceSOL;
                });

                const feeBuffer = 0.002 * fundedSelected.length;
                const distributable = Math.max(0, totalAvailable - feeBuffer);
                const perWallet = distributable / fundedSelected.length;

                fundedSelected.forEach(data => {
                    const maxForWallet = Math.max(0, data.wallet.balanceSOL - 0.002);
                    const amount = Math.min(perWallet, maxForWallet);
                    data.amountInput.value = amount.toFixed(4);
                    data.amount = amount;
                });
            }
            updateSummary();
        });

        // Execute button handler
        executeBtn.addEventListener('click', async () => {
            errorDisplay.classList.remove('visible');

            const tokenMint = tokenInput.value.trim();
            if (!tokenMint) {
                errorDisplay.textContent = 'Enter a token mint address';
                errorDisplay.classList.add('visible');
                return;
            }

            try {
                new web3.PublicKey(tokenMint);
            } catch {
                errorDisplay.textContent = 'Invalid token mint address';
                errorDisplay.classList.add('visible');
                return;
            }

            const swaps = [];
            selectedWallets.forEach(data => {
                if (data.selected && data.amount > 0) {
                    swaps.push({
                        fromToken: 'So11111111111111111111111111111111111111112',
                        toToken: tokenMint,
                        amount: data.amount,
                        walletAddress: data.wallet.publicKey
                    });
                }
            });

            if (swaps.length === 0) {
                errorDisplay.textContent = 'Select at least one wallet with an amount';
                errorDisplay.classList.add('visible');
                return;
            }

            for (const swap of swaps) {
                const walletEntry = Array.from(selectedWallets.values()).find(
                    d => d.wallet.publicKey === swap.walletAddress
                );
                if (walletEntry && swap.amount > walletEntry.wallet.balanceSOL - 0.001) {
                    errorDisplay.textContent = 'Amount exceeds balance for ' + (walletEntry.wallet.name || 'a wallet');
                    errorDisplay.classList.add('visible');
                    return;
                }
            }

            executeBtn.disabled = true;
            executeBtn.textContent = 'Executing ' + swaps.length + ' swap' + (swaps.length > 1 ? 's' : '') + '...';

            try {
                const result = await this.bulkSwap(swaps);

                if (result.success || (result.results && result.results.totalSent > 0)) {
                    closeModal();

                    const sent = result.results?.totalSent || swaps.length;
                    const failed = result.results?.totalFailed || 0;

                    this.showSuccessModal(
                        'Bulk Buy Complete',
                        `Successfully executed ${sent} swap${sent > 1 ? 's' : ''}${failed > 0 ? ` (${failed} failed)` : ''}`,
                        [
                            { label: 'Swaps Executed', value: sent.toString() },
                            { label: 'Token', value: tokenInput.value.slice(0, 8) + '...' },
                            ...(failed > 0 ? [{ label: 'Failed', value: failed.toString() }] : [])
                        ]
                    );

                    this.renderBurnerView();
                } else {
                    throw new Error(result.error || 'Bulk swap failed');
                }
            } catch (err) {
                console.error('[CryptoClient] Bulk swap error:', err);
                closeModal();
                this.showErrorModal(
                    'Bulk Buy Failed',
                    'The swap transaction could not be completed.',
                    err.message || 'Unknown error occurred'
                );
            }
        });

        // Click outside to close
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeModal();
        });

        document.body.appendChild(overlay);

        // Animate in
        requestAnimationFrame(() => {
            overlay.classList.add('visible');
            requestAnimationFrame(() => {
                modal.classList.add('visible');
            });
        });
    }

    /**
     * Execute bulk swap via ProofNetwork API
     * @param {Array} swaps - Array of { fromToken, toToken, amount, walletAddress }
     * @returns {Promise<Object>} - { success, results } or { success: false, error }
     */
    async bulkSwap(swaps) {
        if (!swaps || swaps.length === 0) {
            return { success: false, error: 'No swaps specified' };
        }

        const web3 = window.solanaWeb3;
        if (!web3) {
            return { success: false, error: 'Solana Web3 not loaded' };
        }

        try {
            // Step 1: Get unsigned transactions from API
            const response = await fetch(`${this.config.apiUrl}/dex/swap`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.config.apiKey}`
                },
                body: JSON.stringify(swaps)
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || result.message || 'API request failed');
            }

            if (result.success === false) {
                this.showErrorToast(result.error || 'Bulk swap failed');
                return { success: false, error: result.error || 'Bulk swap failed' };
            }

            console.log('[CryptoClient] Bulk swap API response:', result);

            // Step 2: Sign and send each transaction
            const data = result.data;
            if (!data || !data.successes || data.successes.length === 0) {
                return { success: false, error: 'No transactions to process' };
            }

            const burnerWallets = CryptoClient.getBurnerWallets();
            const signResults = [];
            const signFailures = [];

            for (const swap of data.successes) {
                try {
                    // Find the wallet by public key
                    const wallet = burnerWallets.find(w => w.publicKey === swap.walletAddress);
                    if (!wallet) {
                        signFailures.push({
                            walletAddress: swap.walletAddress,
                            error: 'Wallet not found in burner wallets'
                        });
                        continue;
                    }

                    // Create keypair from stored secret key (already an array)
                    const keypair = web3.Keypair.fromSecretKey(new Uint8Array(wallet.secretKey));

                    // Use unified signAndSendTransaction with keypair
                    const result = await this.signAndSendTransaction(swap.transaction, { keypair });

                    if (result && result.success) {
                        console.log('[CryptoClient] Transaction sent:', result.signature, 'for wallet:', swap.walletAddress);
                        signResults.push({
                            walletAddress: swap.walletAddress,
                            signature: result.signature,
                            swap: swap.swap
                        });
                    } else {
                        throw new Error('Transaction failed');
                    }

                } catch (err) {
                    console.error('[CryptoClient] Failed to sign/send for wallet:', swap.walletAddress, err);
                    signFailures.push({
                        walletAddress: swap.walletAddress,
                        error: err.message || 'Sign/send failed'
                    });
                }
            }

            // Return combined results
            const allSuccessful = signFailures.length === 0 && signResults.length > 0;

            if (signResults.length > 0) {
                this.showCopiedToast(`${signResults.length} swap${signResults.length > 1 ? 's' : ''} sent successfully!`);
            }

            return {
                success: allSuccessful,
                results: {
                    sent: signResults,
                    failed: signFailures,
                    totalSent: signResults.length,
                    totalFailed: signFailures.length
                }
            };

        } catch (err) {
            console.error('[CryptoClient] Bulk swap error:', err);
            this.showErrorToast(err.message || 'Bulk swap failed');
            return { success: false, error: err.message || 'Bulk swap failed' };
        }
    }

    static encodeBase58(bytes) {
        const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
        let result = '';
        let num = BigInt('0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''));

        while (num > 0n) {
            const mod = num % 58n;
            result = ALPHABET[Number(mod)] + result;
            num = num / 58n;
        }

        // Handle leading zeros
        for (const byte of bytes) {
            if (byte === 0) result = '1' + result;
            else break;
        }

        return result;
    }

    static decodeBase58(str) {
        const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
        const ALPHABET_MAP = {};
        for (let i = 0; i < ALPHABET.length; i++) {
            ALPHABET_MAP[ALPHABET[i]] = BigInt(i);
        }

        let num = 0n;
        for (const char of str) {
            if (!(char in ALPHABET_MAP)) {
                throw new Error('Invalid base58 character: ' + char);
            }
            num = num * 58n + ALPHABET_MAP[char];
        }

        // Convert BigInt to byte array
        let hex = num.toString(16);
        if (hex.length % 2) hex = '0' + hex;

        const bytes = [];
        for (let i = 0; i < hex.length; i += 2) {
            bytes.push(parseInt(hex.substr(i, 2), 16));
        }

        // Handle leading zeros (leading '1's in base58)
        for (const char of str) {
            if (char === '1') bytes.unshift(0);
            else break;
        }

        return new Uint8Array(bytes);
    }

    // Instance method wrappers for backwards compatibility
    encodeBase58(bytes) {
        return CryptoClient.encodeBase58(bytes);
    }

    decodeBase58(str) {
        return CryptoClient.decodeBase58(str);
    }

    init() {
        // Initialize Wallet Standard early to catch wallet registrations
        CryptoClient.initWalletStandard();

        // Preload nacl for burner wallet signing
        CryptoClient.ensureNaclLoaded();

        // Buffer is loaded automatically via loadBufferBundle() in loadSolanaWeb3()
        // No need to check here - it will be available when needed for transactions

        // Note: Click handler for header button is attached in createHeaderButton()
        // No need to bind again here

        // Attach provider event listeners for all wallets
        this.attachProviderListeners();

        // Listen for Wallet Standard wallet registrations (for Jupiter and modern wallets)
        this.listenForWalletStandard();

        // Auto-reconnect using last used wallet
        this.autoReconnect();

        // Log detected wallets for debugging (delay to allow wallets to register)
        setTimeout(() => this.logDetectedWallets(), 100);

        // Listen for privacy mode changes to refresh wallet list
        document.addEventListener('privacyModeChanged', (e) => {
            // Refresh wallet list if modal is visible
            if (this.elements.overlay?.classList.contains('visible')) {
                this.renderWalletList();
            }
            // Note: We no longer disconnect extension wallets in privacy mode
            // Burner wallet selection happens at launch time instead
        });
    }

    listenForWalletStandard() {
        // Listen for wallets registering via Wallet Standard
        window.addEventListener('wallet-standard:register-wallet', (event) => {
            const wallet = event.detail;
            if (wallet?.name?.toLowerCase().includes('jupiter')) {
                console.log('[CryptoClient] Jupiter wallet detected via Wallet Standard:', wallet.name);
                CryptoClient._jupiterWalletCache = wallet;
                // Refresh modal if visible
                if (this.elements.overlay?.classList.contains('visible')) {
                    this.refreshWalletList();
                }
            }
        });

        // Also check after a short delay in case wallets registered before we started listening
        setTimeout(() => {
            if (!CryptoClient._jupiterWalletCache && CryptoClient.isJupiterInstalled()) {
                console.log('[CryptoClient] Jupiter wallet found after delayed check');
            }
        }, 500);
    }

    logDetectedWallets() {
        const detected = [];
        for (const [id, config] of Object.entries(CryptoClient.WALLETS)) {
            if (config.isInstalled()) {
                detected.push(config.name);
            }
        }
        if (detected.length > 0) {
            console.log('[CryptoClient] Detected wallets:', detected.join(', '));
        }

        // Debug: Log window globals for wallet detection troubleshooting
        const globals = ['solana', 'phantom', 'solflare', 'backpack', 'jupiter', 'jupiterWallet'];
        const found = globals.filter(g => !!window[g]);
        if (found.length > 0) {
            console.log('[CryptoClient] Wallet globals found:', found.join(', '));
        }

        // Extended debug: Find any wallet-related globals
        const walletGlobals = Object.keys(window).filter(k =>
            /wallet|jup|phantom|solflare|backpack|solana/i.test(k) &&
            typeof window[k] === 'object' &&
            window[k] !== null
        );
        if (walletGlobals.length > 0) {
            console.log('[CryptoClient] All wallet-related globals:', walletGlobals);
        }

        // Check Wallet Standard
        const standardWallets = CryptoClient.getWalletStandardWallets();
        if (standardWallets?.length > 0) {
            const names = standardWallets.map(w => w.name).join(', ');
            console.log('[CryptoClient] Wallet Standard wallets:', names);
        }
    }

    refreshWalletList() {
        // Re-render wallet list to reflect updated detection status
        this.renderWalletList();
    }

    attachProviderListeners() {
        if (this._providerListenersAttached) return;
        this._providerListenersAttached = true;

        // Attach listeners to all available wallet providers
        for (const [walletId, walletConfig] of Object.entries(CryptoClient.WALLETS)) {
            const provider = walletConfig.getProvider();
            if (!provider || typeof provider.on !== 'function') continue;

            provider.on('connect', (publicKey) => {
                // Skip if we're in the middle of connectWallet() - it handles success
                if (this.state.isConnecting) return;

                try {
                    const pk = publicKey?.toString?.() || provider.publicKey?.toString?.();
                    if (pk && this.state.activeWallet === walletId && !this.state.isConnected) {
                        this.onConnectSuccess(pk, walletId);
                    }
                } catch (e) {
                    // Ignore
                }
            });

            provider.on('disconnect', () => {
                if (this.state.activeWallet === walletId) {
                    this.disconnect();
                }
            });

            provider.on('accountChanged', (publicKey) => {
                if (this.state.activeWallet !== walletId) return;

                const pk = publicKey?.toString?.() || null;
                if (!pk) {
                    this.disconnect();
                    return;
                }

                this.state.walletAddress = pk;
                this.state.isConnected = true;
                this.updateHeaderButton(pk);

                const event = new CustomEvent('walletConnected', {
                    detail: { publicKey: pk, wallet: walletId }
                });
                document.dispatchEvent(event);
                console.log(`[CryptoClient] Account changed (${walletId}):`, pk);
            });
        }
    }

    /**
     * Update header button with wallet address
     */
    updateHeaderButton(publicKey) {
        const btn = this.elements.headerBtn || document.getElementById('cc-header-btn');
        if (btn) {
            // Update the text span inside the button
            const textSpan = btn.querySelector('.cc-header-btn-text');
            if (textSpan) {
                textSpan.textContent = `${publicKey.slice(0, 4)}...${publicKey.slice(-4)}`;
            } else {
                // Fallback: if no text span, update entire button
                btn.textContent = `${publicKey.slice(0, 4)}...${publicKey.slice(-4)}`;
            }
            btn.classList.add('connected');
        }
    }

    /**
     * Reset header button to disconnected state
     */
    resetHeaderButton() {
        const btn = this.elements.headerBtn || document.getElementById('cc-header-btn');
        if (btn) {
            const textSpan = btn.querySelector('.cc-header-btn-text');
            if (textSpan) {
                textSpan.textContent = 'Connect Wallet';
            }
            btn.classList.remove('connected');
        }
    }

    async autoReconnect() {
        const lastWalletId = this.getLastUsedWallet();
        if (!lastWalletId) return;

        const walletConfig = CryptoClient.WALLETS[lastWalletId];
        if (!walletConfig || !walletConfig.isInstalled()) return;

        try {
            const provider = walletConfig.getProvider();
            if (!provider) return;

            // Try eager connection (only if previously trusted)
            const response = await provider.connect({ onlyIfTrusted: true });

            // Get public key - wallets return it differently
            const publicKey = (
                response?.publicKey?.toString?.() ||
                provider.publicKey?.toString?.()
            );

            if (publicKey) {
                this.state.walletAddress = publicKey;
                this.state.isConnected = true;
                this.state.activeWallet = lastWalletId;

                this.updateHeaderButton(publicKey);

                const event = new CustomEvent('walletConnected', {
                    detail: { publicKey, wallet: lastWalletId }
                });
                document.dispatchEvent(event);

                console.log(`[CryptoClient] Auto-reconnected via ${walletConfig.name}:`, publicKey);
            }
        } catch (error) {
            // Silent fail - user hasn't approved auto-connect
            console.log('[CryptoClient] Auto-reconnect not available');
        }
    }

    showOverlay() {
        const backdrop = document.getElementById('cc-wallet-modal');
        const walletList = document.getElementById('cc-wallet-list');
        const connectedView = document.getElementById('cc-connected-view');
        const burnerView = document.getElementById('cc-burner-view');
        const header = document.querySelector('.cc-header');
        const statusDiv = document.getElementById('cc-status');

        if (!backdrop) return;

        // Re-announce Wallet Standard ready to catch late-loading wallets (like Jupiter)
        CryptoClient.announceWalletStandardReady();

        // Clear status
        if (statusDiv) statusDiv.textContent = '';

        // Reset all views first
        if (burnerView) burnerView.classList.remove('visible');

        if (this.state.isConnected) {
            // Show connected view with quick actions
            if (walletList) walletList.style.display = 'none';
            if (header) header.style.display = 'none';
            if (connectedView) {
                connectedView.style.display = 'block';
                this.renderConnectedView();
            }
        } else {
            // Show wallet selection
            if (connectedView) connectedView.style.display = 'none';
            if (header) header.style.display = '';
            if (walletList) walletList.style.display = 'flex';
            this.renderWalletList();
        }

        backdrop.classList.add('visible');
    }

    hideOverlay() {
        const backdrop = document.getElementById('cc-wallet-modal');
        if (backdrop) {
            backdrop.classList.remove('visible');
        }
        // Also reset burner view
        this.hideBurnerView();
    }

    updateStatus(message, isError = false) {
        const statusDiv = document.getElementById('cc-status');
        if (statusDiv) {
            statusDiv.textContent = message;
            statusDiv.className = 'cc-status';
            if (isError) statusDiv.classList.add('error');
            else if (message.toLowerCase().includes('connected')) statusDiv.classList.add('success');
        }
    }

    /**
     * Load ProofNetwork Buffer Bundle (required for transaction handling)
     */
    loadBufferBundle() {
        if (window.Buffer) {
            return Promise.resolve(window.Buffer);
        }

        const existing = document.querySelector('script[data-buffer-bundle]');
        if (existing && window.buffer) {
            window.Buffer = window.Buffer ?? window.buffer.Buffer;
            return Promise.resolve(window.Buffer);
        }

        return new Promise((resolve, reject) => {
            const script = existing || document.createElement('script');
            script.src = 'https://proofnetwork.lol/bufferbundle.js';
            script.async = true;
            script.dataset.bufferBundle = 'true';

            script.onload = () => {
                try {
                    window.Buffer = window.Buffer ?? window.buffer.Buffer;
                    console.log('[CryptoClient] Buffer bundle loaded');
                    resolve(window.Buffer);
                } catch (err) {
                    reject(err);
                }
            };
            script.onerror = reject;

            if (!existing) document.head.appendChild(script);
        });
    }

    loadSolanaWeb3() {
        // Patch Connection.prototype to route every RPC call through the inline
        // SolRpcPool (token-bucketed across 4 free public endpoints). The pool
        // IIFE at the top of this file defined `patchSolanaConnection`; calling
        // it patches Connection._rpcRequest globally, so the URL passed to
        // `new Connection(URL, …)` becomes a no-op identifier — the pool picks
        // the actual upstream per request.
        const applyPool = () => {
            try { patchSolanaConnection(window.solanaWeb3); }
            catch (e) { console.warn('[CryptoClient] patchSolanaConnection failed:', e); }
        };

        // First ensure buffer bundle is loaded
        return this.loadBufferBundle().then(() => {
            if (window.solanaWeb3) {
                applyPool();
                if (!window.solanaConnection) {
                    window.solanaConnection = new window.solanaWeb3.Connection(CryptoClient.SYNDICA_RPC);
                }
                return Promise.resolve(window.solanaWeb3);
            }

            const existing = document.querySelector('script[data-solana-web3]');
            if (existing && window.solanaWeb3) {
                applyPool();
                return Promise.resolve(window.solanaWeb3);
            }

            return new Promise((resolve, reject) => {
                const script = existing || document.createElement('script');
                script.src = 'https://unpkg.com/@solana/web3.js@1.98.2/lib/index.iife.min.js';
                script.async = true;
                script.dataset.solanaWeb3 = 'true';

                script.onload = () => {
                    try {
                        applyPool();
                        window.solanaConnection = new window.solanaWeb3.Connection(CryptoClient.SYNDICA_RPC);
                        resolve(window.solanaWeb3);
                    } catch (err) {
                        reject(err);
                    }
                };
                script.onerror = reject;

                if (!existing) document.head.appendChild(script);
            });
        });
    }

    /**
     * Connect to a specific wallet
     * @param {string} walletId - 'phantom' | 'solflare' | 'backpack'
     */
    async connectWallet(walletId = 'phantom') {
        if (this.state.isConnecting) return;

        const walletConfig = CryptoClient.WALLETS[walletId];
        if (!walletConfig) {
            this.updateStatus('Unknown wallet', true);
            return;
        }

        // Handle burner wallet specially
        if (walletId === 'burner') {
            return this.connectBurnerWallet();
        }

        if (!walletConfig.isInstalled()) {
            window.open(walletConfig.downloadUrl, '_blank');
            return;
        }

        // Capture previous wallet BEFORE setting new one (for the "already connected" check)
        const previousWallet = this.state.activeWallet;

        this.state.isConnecting = true;
        this.state.activeWallet = walletId;
        this.updateStatus(`Connecting to ${walletConfig.name}...`);

        const provider = walletConfig.getProvider();

        try {
            // Ensure event listeners are attached
            this.attachProviderListeners();

            // If already connected with same wallet, reuse (compare against PREVIOUS wallet, not newly set one)
            if (this.state.isConnected && this.state.walletAddress && previousWallet === walletId) {
                console.log(`[CryptoClient] Already connected to ${walletConfig.name}`);
                this.onConnectSuccess(this.state.walletAddress, walletId);
                return;
            }

            const attemptConnect = async () => {
                // Method 1: Wallet Standard API (Jupiter, modern wallets)
                if (provider.features?.['standard:connect']?.connect) {
                    const result = await provider.features['standard:connect'].connect();
                    // Wallet Standard returns accounts array
                    if (result?.accounts?.length > 0) {
                        const account = result.accounts[0];
                        return {
                            publicKey: {
                                toString: () => account.address,
                                toBase58: () => account.address
                            }
                        };
                    }
                    return result;
                }

                // Method 2: Legacy provider.connect() (Phantom, Solflare, etc)
                try {
                    return await provider.connect({ onlyIfTrusted: false });
                } catch (err) {
                    // Method 3: Request method fallback
                    if (typeof provider.request === 'function') {
                        return await provider.request({ method: 'connect' });
                    }
                    throw err;
                }
            };

            let response;
            try {
                response = await attemptConnect();
            } catch (err) {
                const code = err?.code ?? err?.data?.code;
                const msg = err?.message || String(err);

                // Retry on internal errors
                if (code === -32603 || /unexpected error/i.test(msg)) {
                    this.updateStatus(`${walletConfig.name} internal error. Retrying...`, true);
                    try { await provider.disconnect(); } catch (_) {}
                    await new Promise(r => setTimeout(r, 250));
                    response = await attemptConnect();
                } else {
                    throw err;
                }
            }

            // Get public key - wallets return it differently
            const publicKey = (
                response?.publicKey?.toString?.() ||
                provider.publicKey?.toString?.() ||
                response?.toString?.()
            );

            if (!publicKey) {
                throw new Error('Failed to get public key from wallet');
            }

            this.state.walletAddress = publicKey;

            // Optional verification callback
            if (this.config.onVerify) {
                this.updateStatus('Verifying wallet...');
                await this.config.onVerify(publicKey, provider);
            }

            // Save as last used wallet
            this.setLastUsedWallet(walletId);

            this.onConnectSuccess(publicKey, walletId);

        } catch (error) {
            const code = error?.code ?? error?.data?.code;
            const rawMessage = error?.message || error?.toString?.() || 'Failed to connect';

            let friendly = rawMessage;
            if (code === 4001) {
                friendly = 'Connection cancelled.';
            } else if (code === -32002 || /pending/i.test(rawMessage)) {
                friendly = `A request is pending in ${walletConfig.name}. Please check your wallet.`;
            } else if (code === -32603) {
                friendly = `${walletConfig.name} returned an error. Try unlocking your wallet and reconnecting.`;
            } else if (/unexpected error/i.test(rawMessage)) {
                const isSecure = window.isSecureContext ||
                    window.location.protocol === 'https:' ||
                    window.location.hostname === 'localhost' ||
                    window.location.hostname === '127.0.0.1';
                friendly = isSecure
                    ? `${walletConfig.name} returned an error. Please try again.`
                    : 'Wallet connections require https:// or localhost.';
            }

            console.error(`[CryptoClient] ${walletConfig.name} connection error:`, { code, rawMessage, error });
            this.updateStatus(friendly, true);
        } finally {
            this.state.isConnecting = false;
        }
    }

    /**
     * Connect to a burner wallet
     */
    async connectBurnerWallet() {
        const activeBurnerId = CryptoClient.getActiveBurnerId();
        if (!activeBurnerId) {
            this.updateStatus('No burner wallet selected', true);
            return;
        }

        const wallets = CryptoClient.getBurnerWallets();
        const wallet = wallets.find(w => w.id === activeBurnerId);
        if (!wallet) {
            this.updateStatus('Burner wallet not found', true);
            return;
        }

        this.state.isConnecting = true;
        this.state.activeWallet = 'burner';
        this.updateStatus(`Connecting to ${wallet.name}...`);

        try {
            // Burner wallets are local, so "connection" is instant
            this.state.walletAddress = wallet.publicKey;
            this.setLastUsedWallet('burner');

            console.log(`[CryptoClient] Connected to burner wallet:`, wallet.publicKey.slice(0, 8) + '...');
            this.onConnectSuccess(wallet.publicKey, 'burner');

        } catch (error) {
            console.error('[CryptoClient] Burner wallet connection error:', error);
            this.updateStatus('Failed to connect burner wallet', true);
        } finally {
            this.state.isConnecting = false;
        }
    }

    /**
     * Handle successful wallet connection
     */
    onConnectSuccess(publicKey, walletId) {
        this.state.isConnected = true;
        this.state.activeWallet = walletId;
        this.updateStatus('Connected!', false);

        const walletName = CryptoClient.WALLETS[walletId]?.name || walletId;

        setTimeout(() => {
            this.hideOverlay();
            this.updateHeaderButton(publicKey);

            const event = new CustomEvent('walletConnected', {
                detail: { publicKey, wallet: walletId, walletName }
            });
            document.dispatchEvent(event);
        }, 600);

        console.log(`[CryptoClient] Connected via ${walletName}:`, publicKey);
    }

    /**
     * Disconnect from current wallet
     */
    disconnect() {
        // Disconnect from active wallet provider
        if (this.state.activeWallet) {
            const walletConfig = CryptoClient.WALLETS[this.state.activeWallet];
            const provider = walletConfig?.getProvider();
            if (provider?.disconnect) {
                try { provider.disconnect(); } catch (_) {}
            }
        }

        this.state.isConnected = false;
        this.state.walletAddress = null;
        this.state.activeWallet = null;

        // Reset header button to disconnected state
        this.resetHeaderButton();

        this.updateStatus('');
        this.hideOverlay();

        // Dispatch disconnect event
        document.dispatchEvent(new CustomEvent('walletDisconnected'));
        console.log('[CryptoClient] Disconnected');
    }

    /**
     * Get the current active provider
     */
    getProvider() {
        if (!this.state.activeWallet) return null;
        return CryptoClient.WALLETS[this.state.activeWallet]?.getProvider();
    }

    // --- Contract Integration (HTTP & Polling Only) ---

    // Track in-flight calls to prevent duplicates
    _pendingCalls = new Map();

    async callContract(functionName, inputs = {}, options = {}) {
        const { contractAddress } = this.config;

        // Allow callers to override fromAddress (e.g. privacy mode uses burner address)
        const fromAddress = options.fromAddress || this.state.walletAddress || `guest`;

        // Create unique key for this call to prevent duplicates
        const callKey = `${functionName}:${fromAddress}:${JSON.stringify(inputs)}`;

        // If this exact call is already in-flight, return the existing promise
        if (this._pendingCalls.has(callKey)) {
            console.log('[CryptoClient] Duplicate call detected, reusing pending request:', functionName);
            return this._pendingCalls.get(callKey);
        }

        // Create the call promise
        const callPromise = this._executeContractCall(functionName, inputs, fromAddress, callKey);

        // Store it to prevent duplicates
        this._pendingCalls.set(callKey, callPromise);

        // Clean up after completion (success or failure)
        callPromise.finally(() => {
            this._pendingCalls.delete(callKey);
        });

        return callPromise;
    }

    async _executeContractCall(functionName, inputs, fromAddress, callKey) {
        const { contractAddress } = this.config;

        // Debug: log what we're sending
        console.log('[CryptoClient] Contract call:', functionName, {
            from: fromAddress,
            inputs: inputs,
            signatureLength: inputs?.signature?.length
        });

        try {
            const response = await fetch(`${this.config.apiUrl}/blockchain/contracts/call`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.config.apiKey}`
                },
                body: JSON.stringify({
                    from: fromAddress,
                    contractAddress: contractAddress,
                    functionName: functionName,
                    inputs: inputs,
                    responseMode:"minimal"
                })
            });

            const result = await response.json();

            // Check for contract-level errors (success: false with error message)
            if (result.success === false && result.error) {
                const errorMsg = typeof result.error === 'string'
                    ? result.error
                    : result.error.message || 'Contract error';
                console.error('[CryptoClient] Contract error:', errorMsg);
                this.showErrorToast(errorMsg);
                throw new Error(errorMsg);
            }

            // Helper: Check if string looks like a serialized transaction (NOT an address)
            // Solana addresses: 32-44 chars base58
            // Solana signatures: 87-88 chars base58
            // Serialized transactions (base64): 200+ chars typically
            const isEncodedTransaction = (str) => {
                if (typeof str !== 'string') return false;

                // Base64 encoded transaction (most common for serialized tx)
                // Must be 200+ chars to avoid matching short strings
                if (str.length >= 200 && /^[A-Za-z0-9+/]+=*$/.test(str) && str.length % 4 === 0) {
                    return true;
                }

                // Base58 but only if very long (500+ chars indicates serialized data, not address/sig)
                if (str.length >= 500 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(str)) {
                    return true;
                }

                return false;
            };

            // Helper: Recursively scan object for encoded transaction data
            const findEncodedTransaction = (obj, depth = 0) => {
                if (depth > 5 || !obj) return null;  // Limit recursion depth

                if (typeof obj === 'string') {
                    return isEncodedTransaction(obj) ? obj : null;
                }

                if (Array.isArray(obj)) {
                    for (const item of obj) {
                        const found = findEncodedTransaction(item, depth + 1);
                        if (found) return found;
                    }
                    return null;
                }

                if (typeof obj === 'object') {
                    // Check common transaction field names first
                    const txFields = ['transaction', 'tx', 'signedTx', 'serializedTx', 'rawTransaction'];
                    for (const field of txFields) {
                        if (obj[field] && typeof obj[field] === 'string' && isEncodedTransaction(obj[field])) {
                            return obj[field];
                        }
                    }
                    // Then scan all values
                    for (const value of Object.values(obj)) {
                        const found = findEncodedTransaction(value, depth + 1);
                        if (found) return found;
                    }
                }
                return null;
            };

            // Handle view function responses (no transaction wrapper, just data)
            if (!result.transaction) {
                // Check if this is a successful view response
                if (result.outputs) {
                    // Scan outputs for encoded transactions (contract may return tx in outputs)
                    const encodedTx = findEncodedTransaction(result.outputs);
                    if (encodedTx) {
                        result.outputs._encodedTransaction = encodedTx;
                    }
                    return result.outputs;
                }
                // Check if result itself contains success (direct view response)
                if (result.success !== undefined) {
                    const encodedTx = findEncodedTransaction(result);
                    if (encodedTx) {
                        result._encodedTransaction = encodedTx;
                    }
                    return result;
                }
                // Otherwise it's an error
                const errorMsg = result.error?.message || result.error || 'No response from contract';
                this.showErrorToast(errorMsg);
                throw new Error(errorMsg);
            }

            // Check for failed transaction status
            if (result.transaction.status === 'failed') {
                const errorMsg = result.transaction.errorMessage || result.error || 'Transaction failed';
                console.error('[CryptoClient] Transaction failed:', errorMsg);
                this.showErrorToast(errorMsg);
                throw new Error(errorMsg);
            }

            // Check for error messages in transaction - show toast and return for caller handling
            if (result.transaction.errorMessage) {
                this.showErrorToast(result.transaction.errorMessage);
                return result.transaction;
            }

            // Get outputs and scan for encoded transactions
            const outputs = result.transaction.outputs || result.transaction;
            const encodedTx = findEncodedTransaction(outputs);
            if (encodedTx && typeof outputs === 'object') {
                outputs._encodedTransaction = encodedTx;
            }

            return outputs;
        } catch (error) {
            console.error('[CryptoClient] Contract call error:', error);

            // Check for CORS or network errors
            const isCorsError = error instanceof TypeError ||
                error.message?.toLowerCase().includes('cors') ||
                error.message?.toLowerCase().includes('network') ||
                error.message?.toLowerCase().includes('failed to fetch');

            // Don't show overlay on localhost
            const isLocalhost = window.location.hostname === 'localhost' ||
                window.location.hostname === '127.0.0.1';

            if (isCorsError && !isLocalhost) {
                this.showReconnectingOverlay();

                // Auto-hide after 3 seconds and retry
                setTimeout(() => {
                    this.hideReconnectingOverlay();
                }, 3000);
            } else if (!isCorsError) {
                // Show error toast for non-CORS errors (unless already shown)
                const alreadyShown = document.querySelector('.cc-error-toast');
                if (!alreadyShown) {
                    this.showErrorToast(error.message || 'Contract call failed');
                }
            }

            throw error;
        }
    }

    /**
     * Sign and send Solana transaction(s)
     * @param {string|string[]} transaction - Base64 encoded transaction(s)
     * @param {Object} options - Options { keypair, callbacks }
     *   - keypair: Optional Keypair for burner wallet signing (if not provided, uses connected wallet)
     *   - callbacks: Optional { onSuccess, onError }
     * @returns {Promise<Object|null>} - { signature, success } or null on error
     */
    async signAndSendTransaction(transaction, options = {}) {
        let { keypair, callbacks = {} } = options;

        // For backwards compatibility: if options is { onSuccess, onError }, treat as callbacks
        const actualCallbacks = callbacks.onSuccess ? callbacks : (options.onSuccess ? options : {});

        try {
            await this.solanaWeb3Ready;
        } catch (e) {
            console.error('[CryptoClient] Failed to load solanaWeb3:', e);
            return null;
        }

        const web3 = window.solanaWeb3;

        // Auto-detect burner wallet: if no keypair provided and active wallet is 'burner', get the keypair
        if (!keypair && this.state.activeWallet === 'burner') {
            keypair = CryptoClient.getBurnerKeypair();
            if (keypair) {
                console.log('[CryptoClient] Auto-detected burner wallet, using keypair for signing');
            }
        }

        const provider = keypair ? null : this.getProvider();

        // If no keypair provided, require connected wallet
        if (!keypair && (!provider || !this.state.isConnected)) {
            console.error('[CryptoClient] Wallet not connected and no keypair provided');
            return null;
        }

        // Get connection - use Syndica RPC for burner, global connection for provider
        const connection = keypair
            ? new web3.Connection(CryptoClient.SYNDICA_RPC, 'confirmed')
            : window.solanaConnection;

        // Helper to decode transaction string (tries base64 first, then base58)
        const decodeTransaction = (str) => {
            // Check if it looks like base64 (contains +, /, or = which aren't in base58)
            const isLikelyBase64 = /[+/=]/.test(str);

            if (isLikelyBase64) {
                try {
                    return Uint8Array.from(atob(str), c => c.charCodeAt(0));
                } catch {
                    // Fall through to base58
                }
            }

            // Try base58 decoding
            return new Uint8Array(CryptoClient.decodeBase58(str));
        };

        // Helper to deserialize transaction (versioned or legacy)
        const deserializeTx = (txBytes) => {
            try {
                const tx = web3.VersionedTransaction.deserialize(txBytes);
                return { tx, isVersioned: true };
            } catch {
                const tx = web3.Transaction.from(txBytes);
                return { tx, isVersioned: false };
            }
        };

        // Helper to sign transaction
        const signTx = (txObject, isVersioned, signer) => {
            if (isVersioned) {
                txObject.sign([signer]);
            } else {
                txObject.sign(signer);
            }
        };

        try {
            // Handle single transaction
            if (typeof transaction === 'string') {
                const txBytes = decodeTransaction(transaction);
                const { tx: txObject, isVersioned } = deserializeTx(txBytes);
                console.log(`[CryptoClient] Deserialized as ${isVersioned ? 'Versioned' : 'Legacy'} Transaction`);

                // Check if transaction already has a blockhash
                const hasBlockhash = isVersioned
                    ? txObject.message.recentBlockhash
                    : txObject.recentBlockhash;

                if (!hasBlockhash) {
                    console.log('[CryptoClient] Transaction missing blockhash, fetching latest...');
                    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
                    console.log('[CryptoClient] Latest blockhash:', blockhash);

                    if (isVersioned) {
                        txObject.message.recentBlockhash = blockhash;
                    } else {
                        txObject.recentBlockhash = blockhash;
                        txObject.lastValidBlockHeight = lastValidBlockHeight;
                    }
                } else {
                    console.log('[CryptoClient] Transaction already has blockhash:', hasBlockhash);
                }

                let signature;

                if (keypair) {
                    // Sign with provided keypair (burner wallet)
                    console.log('[CryptoClient] Signing with keypair...');
                    signTx(txObject, isVersioned, keypair);

                    signature = await connection.sendRawTransaction(
                        txObject.serialize(),
                        { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }
                    );
                } else {
                    // Sign with connected wallet provider
                    console.log('[CryptoClient] Requesting signature from wallet...');

                    // Try signAndSendTransaction first (Phantom, Solflare)
                    if (typeof provider.signAndSendTransaction === 'function') {
                        const result = await provider.signAndSendTransaction(txObject);
                        signature = result.signature || result;
                    }
                    // Wallet Standard API (Jupiter, modern wallets)
                    else if (provider.features?.['solana:signAndSendTransaction']?.signAndSendTransaction) {
                        console.log('[CryptoClient] Using Wallet Standard signAndSendTransaction...');
                        const account = provider.accounts?.[0];
                        if (!account) throw new Error('No account found in wallet');

                        // Serialize transaction for Wallet Standard
                        const serializedTx = txObject.serialize({ requireAllSignatures: false });

                        const result = await provider.features['solana:signAndSendTransaction'].signAndSendTransaction({
                            transaction: serializedTx,
                            account: account,
                            chain: 'solana:mainnet'
                        });

                        // Result is array of { signature: Uint8Array }
                        if (Array.isArray(result) && result.length > 0) {
                            const sigBytes = result[0].signature;
                            signature = CryptoClient.encodeBase58(new Uint8Array(sigBytes));
                        } else {
                            signature = result?.signature ? CryptoClient.encodeBase58(new Uint8Array(result.signature)) : result;
                        }
                    }
                    // Wallet Standard signTransaction fallback
                    else if (provider.features?.['solana:signTransaction']?.signTransaction) {
                        console.log('[CryptoClient] Using Wallet Standard signTransaction...');
                        const account = provider.accounts?.[0];
                        if (!account) throw new Error('No account found in wallet');

                        const serializedTx = txObject.serialize({ requireAllSignatures: false });

                        const result = await provider.features['solana:signTransaction'].signTransaction({
                            transaction: serializedTx,
                            account: account,
                            chain: 'solana:mainnet'
                        });

                        // Get signed transaction bytes
                        const signedTxBytes = Array.isArray(result) ? result[0].signedTransaction : result.signedTransaction;

                        signature = await connection.sendRawTransaction(
                            signedTxBytes,
                            { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }
                        );
                    }
                    // Fall back to signTransaction + manual send (other wallets)
                    else if (typeof provider.signTransaction === 'function') {
                        console.log('[CryptoClient] Using signTransaction fallback...');
                        const signedTx = await provider.signTransaction(txObject);
                        signature = await connection.sendRawTransaction(
                            signedTx.serialize(),
                            { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }
                        );
                    }
                    // No compatible signing method
                    else {
                        console.error('[CryptoClient] No signing method found. Provider features:', Object.keys(provider.features || {}));
                        throw new Error('Wallet does not support transaction signing');
                    }
                }

                console.log('[CryptoClient] Transaction sent with signature:', signature);

                if (actualCallbacks.onSuccess) {
                    actualCallbacks.onSuccess({ signature });
                }

                return { signature, success: true };
            }

            // Handle array of transactions
            if (Array.isArray(transaction)) {
                console.log(`[CryptoClient] Processing ${transaction.length} transactions`);

                const transactions = transaction.map(txString => {
                    const txBytes = decodeTransaction(txString);
                    return deserializeTx(txBytes);
                });

                // Check if transactions need blockhash update
                const needsBlockhash = transactions.some(({ tx, isVersioned }) => {
                    const hasBlockhash = isVersioned
                        ? tx.message.recentBlockhash
                        : tx.recentBlockhash;
                    return !hasBlockhash;
                });

                if (needsBlockhash) {
                    console.log('[CryptoClient] Fetching latest blockhash for batch...');
                    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

                    for (const { tx, isVersioned } of transactions) {
                        const hasBlockhash = isVersioned
                            ? tx.message.recentBlockhash
                            : tx.recentBlockhash;

                        if (!hasBlockhash) {
                            if (isVersioned) {
                                tx.message.recentBlockhash = blockhash;
                            } else {
                                tx.recentBlockhash = blockhash;
                                tx.lastValidBlockHeight = lastValidBlockHeight;
                            }
                        }
                    }
                }

                const signatures = [];

                if (keypair) {
                    // Sign and send each with keypair
                    for (let i = 0; i < transactions.length; i++) {
                        const { tx, isVersioned } = transactions[i];
                        console.log(`[CryptoClient] Signing tx ${i + 1}/${transactions.length} with keypair...`);

                        signTx(tx, isVersioned, keypair);

                        const signature = await connection.sendRawTransaction(
                            tx.serialize(),
                            { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }
                        );

                        signatures.push(signature);
                        console.log(`[CryptoClient] Transaction ${i + 1} sent:`, signature);

                        if (i < transactions.length - 1) {
                            await new Promise(resolve => setTimeout(resolve, 100));
                        }
                    }
                } else {
                    // Sign and send with provider
                    const txObjects = transactions.map(item => item.tx);
                    console.log(`[CryptoClient] Signing ${txObjects.length} transactions with wallet...`);

                    // Try batch signing if supported
                    if (typeof provider.signAllTransactions === 'function') {
                        const signedTransactions = await provider.signAllTransactions(txObjects);

                        for (let i = 0; i < signedTransactions.length; i++) {
                            const signedTx = signedTransactions[i];
                            console.log(`[CryptoClient] Sending tx ${i + 1}/${signedTransactions.length}`);

                            let signature;
                            if (typeof provider.sendTransaction === 'function') {
                                const result = await provider.sendTransaction(signedTx);
                                signature = result.signature || result;
                            } else {
                                signature = await connection.sendRawTransaction(signedTx.serialize());
                            }

                            signatures.push(signature);
                            console.log(`[CryptoClient] Transaction ${i + 1} sent:`, signature);

                            if (i < signedTransactions.length - 1) {
                                await new Promise(resolve => setTimeout(resolve, 100));
                            }
                        }
                    }
                    // Fallback: sign one at a time
                    else if (typeof provider.signTransaction === 'function') {
                        console.log('[CryptoClient] Using single-sign fallback for batch...');
                        for (let i = 0; i < txObjects.length; i++) {
                            const tx = txObjects[i];
                            console.log(`[CryptoClient] Signing tx ${i + 1}/${txObjects.length}...`);

                            const signedTx = await provider.signTransaction(tx);
                            const signature = await connection.sendRawTransaction(
                                signedTx.serialize(),
                                { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }
                            );

                            signatures.push(signature);
                            console.log(`[CryptoClient] Transaction ${i + 1} sent:`, signature);

                            if (i < txObjects.length - 1) {
                                await new Promise(resolve => setTimeout(resolve, 100));
                            }
                        }
                    }
                    // signAndSendTransaction fallback for single transactions
                    else if (typeof provider.signAndSendTransaction === 'function') {
                        for (let i = 0; i < txObjects.length; i++) {
                            const tx = txObjects[i];
                            console.log(`[CryptoClient] Sign+send tx ${i + 1}/${txObjects.length}...`);

                            const result = await provider.signAndSendTransaction(tx);
                            const signature = result.signature || result;

                            signatures.push(signature);
                            console.log(`[CryptoClient] Transaction ${i + 1} sent:`, signature);

                            if (i < txObjects.length - 1) {
                                await new Promise(resolve => setTimeout(resolve, 100));
                            }
                        }
                    }
                    // Wallet Standard API (Jupiter, modern wallets) - batch fallback
                    else if (provider.features?.['solana:signAndSendTransaction']?.signAndSendTransaction) {
                        console.log('[CryptoClient] Using Wallet Standard for batch transactions...');
                        const account = provider.accounts?.[0];
                        if (!account) throw new Error('No account found in wallet');

                        for (let i = 0; i < txObjects.length; i++) {
                            const tx = txObjects[i];
                            console.log(`[CryptoClient] Sign+send tx ${i + 1}/${txObjects.length} via Wallet Standard...`);

                            const serializedTx = tx.serialize({ requireAllSignatures: false });

                            const result = await provider.features['solana:signAndSendTransaction'].signAndSendTransaction({
                                transaction: serializedTx,
                                account: account,
                                chain: 'solana:mainnet'
                            });

                            let signature;
                            if (Array.isArray(result) && result.length > 0) {
                                const sigBytes = result[0].signature;
                                signature = CryptoClient.encodeBase58(new Uint8Array(sigBytes));
                            } else {
                                signature = result?.signature ? CryptoClient.encodeBase58(new Uint8Array(result.signature)) : result;
                            }

                            signatures.push(signature);
                            console.log(`[CryptoClient] Transaction ${i + 1} sent:`, signature);

                            if (i < txObjects.length - 1) {
                                await new Promise(resolve => setTimeout(resolve, 100));
                            }
                        }
                    }
                    else {
                        console.error('[CryptoClient] No batch signing method found. Provider features:', Object.keys(provider.features || {}));
                        throw new Error('Wallet does not support transaction signing');
                    }
                }

                console.log(`[CryptoClient] All ${signatures.length} transactions sent`);

                if (actualCallbacks.onSuccess) {
                    actualCallbacks.onSuccess({ signature: signatures[0], signatures });
                }

                return { signature: signatures[0], signatures, success: true };
            }

            throw new Error('Invalid transaction format');
        } catch (error) {
            console.error('[CryptoClient] Transaction error:', error);

            const errorMessage = error?.message || error?.toString() || 'Unknown error';
            const isUserRejection = errorMessage.includes('User rejected') ||
                errorMessage.includes('user rejected') ||
                errorMessage.includes('User declined');

            if (isUserRejection) {
                console.log('[CryptoClient] Transaction cancelled by user');
            }

            if (callbacks.onError) {
                callbacks.onError(error);
            }

            return null;
        }
    }

    // Polling mechanism for contract functions
    pollContract(functionName, inputs = {}, frequency = 2000, onUpdate, options = {}) {
        const maxErrors = options.maxErrors ?? 4;
        console.log(`[CryptoClient] Starting polling for ${functionName} every ${frequency}ms (max ${maxErrors} consecutive errors)`);

        let isPolling = true;
        let consecutiveErrors = 0;

        const poll = async () => {
            if (!isPolling) return;
            try {
                // Evaluate inputs dynamically on each poll
                const resolvedInputs = typeof inputs === 'function' ? inputs() : inputs;

                // If inputs contain walletAddress and it's null/undefined, use current state
                if (resolvedInputs.hasOwnProperty('walletAddress') && !resolvedInputs.walletAddress) {
                    resolvedInputs.walletAddress = this.state.walletAddress;
                }

                const data = await this.callContract(functionName, resolvedInputs);
                consecutiveErrors = 0; // Reset on success
                if (isPolling) onUpdate(data);
            } catch (e) {
                consecutiveErrors++;
                console.warn(`[CryptoClient] Poll error ${consecutiveErrors}/${maxErrors}:`, e.message || e);

                if (consecutiveErrors >= maxErrors) {
                    console.error(`[CryptoClient] Polling stopped for ${functionName} after ${maxErrors} consecutive errors`);
                    isPolling = false;
                    if (options.onMaxErrors) {
                        options.onMaxErrors(e);
                    }
                    return;
                }
            }
            if (isPolling) setTimeout(poll, frequency);
        };

        poll();

        return {
            stop: () => { isPolling = false; },
            isActive: () => isPolling
        };
    }

    /**
     * Sign a message using connected wallet
     * @param {string} message - The message to sign
     * @param {string} [encoding='utf8'] - Message encoding ('utf8' or 'hex')
     * @returns {Promise<Object|null>} - { signature, publicKey } or null on error/rejection
     */
    async signMessage(message, encoding = 'utf8') {
        const provider = this.getProvider();

        if (!provider) {
            console.error('[CryptoClient] No wallet provider available');
            return null;
        }

        if (!this.state.isConnected) {
            console.error('[CryptoClient] Wallet not connected');
            return null;
        }

        try {
            // Encode message to Uint8Array
            const encodedMessage = encoding === 'hex'
                ? new Uint8Array(message.match(/.{1,2}/g).map(byte => parseInt(byte, 16)))
                : new TextEncoder().encode(message);

            console.log('[CryptoClient] Requesting message signature...');

            let signature, publicKey;

            // Check for burner wallet (local signing)
            if (provider.isBurner) {
                const result = await provider.signMessage(encodedMessage);
                signature = result.signature;
                publicKey = result.publicKey;
            }
            // Check for Wallet Standard API (Jupiter, modern wallets)
            else if (provider.features?.['solana:signMessage']?.signMessage) {
                const result = await provider.features['solana:signMessage'].signMessage({
                    message: encodedMessage,
                    account: provider.accounts?.[0]
                });
                // Wallet Standard returns array of SignedMessage objects
                // Each has { signedMessage: Uint8Array, signature: Uint8Array }
                if (Array.isArray(result) && result.length > 0) {
                    signature = result[0].signature || result[0].signedMessage || result[0];
                } else {
                    signature = result?.signature || result?.signedMessage || result;
                }
                publicKey = provider.accounts?.[0]?.address || this.state.walletAddress;
            } else {
                // Legacy API (Phantom, Solflare, etc)
                const result = await provider.signMessage(encodedMessage, 'utf8');
                signature = result.signature;
                publicKey = result.publicKey;
            }

            console.log('[CryptoClient] Message signed successfully');

            // Ensure signature is a Uint8Array or array-like
            let signatureArray;
            if (signature instanceof Uint8Array) {
                signatureArray = Array.from(signature);
            } else if (Array.isArray(signature)) {
                signatureArray = signature;
            } else if (signature?.buffer) {
                // ArrayBuffer view
                signatureArray = Array.from(new Uint8Array(signature.buffer));
            } else {
                console.error('[CryptoClient] Unexpected signature format:', signature);
                signatureArray = [];
            }

            const pubKeyStr = typeof publicKey === 'string' ? publicKey : publicKey?.toString?.() || this.state.walletAddress;

            console.log('[CryptoClient] signMessage result:', {
                signatureLength: signatureArray.length,
                publicKey: pubKeyStr,
                messagePreview: message?.slice?.(0, 50) || message
            });

            // Convert to various formats
            const signatureBase64 = btoa(String.fromCharCode(...signatureArray));
            const signatureBase58 = CryptoClient.encodeBase58(new Uint8Array(signatureArray));

            return {
                signature: signatureArray,
                signatureBase58,
                signatureBase64,
                signatureHex: signatureArray.map(b => b.toString(16).padStart(2, '0')).join(''),
                publicKey: pubKeyStr,
                message: message
            };
        } catch (error) {
            const errorMessage = error?.message || error?.toString() || 'Unknown error';
            const isUserRejection = errorMessage.includes('User rejected') ||
                errorMessage.includes('user rejected') ||
                errorMessage.includes('User declined');

            if (isUserRejection) {
                console.log('[CryptoClient] Message signing cancelled by user');
            } else {
                console.error('[CryptoClient] Message signing error:', error);
            }

            return null;
        }
    }

    /**
     * Sign a message using a specific burner wallet keypair (bypasses connected wallet).
     * Used in privacy mode so the connected wallet is never associated with the launch.
     * @param {string} message - The message to sign
     * @param {string} burnerId - The burner wallet ID to sign with
     * @returns {Promise<Object|null>} - { signature, signatureBase58, publicKey } or null on error
     */
    async signMessageWithBurner(message, burnerId) {
        const keypair = CryptoClient.getBurnerKeypair(burnerId);
        if (!keypair) {
            console.error('[CryptoClient] Cannot sign: burner wallet not found or solanaWeb3 not loaded');
            return null;
        }

        try {
            const encodedMessage = new TextEncoder().encode(message);

            // Sign using nacl (TweetNaCl) which is already loaded for burner wallets
            const nacl = window.nacl;
            if (!nacl) {
                console.error('[CryptoClient] TweetNaCl not loaded');
                return null;
            }

            const signature = nacl.sign.detached(encodedMessage, keypair.secretKey);
            const signatureArray = Array.from(signature);
            const signatureBase58 = CryptoClient.encodeBase58(new Uint8Array(signatureArray));
            const publicKey = keypair.publicKey.toBase58();

            console.log('[CryptoClient] Burner message signed:', {
                signatureLength: signatureArray.length,
                publicKey,
                messagePreview: message?.slice?.(0, 50)
            });

            return {
                signature: signatureArray,
                signatureBase58,
                signatureBase64: btoa(String.fromCharCode(...signatureArray)),
                publicKey,
                message
            };
        } catch (error) {
            console.error('[CryptoClient] Burner signing error:', error);
            return null;
        }
    }

    /**
     * Show network reconnecting overlay
     */
    showReconnectingOverlay() {
        const overlay = this.elements.reconnectOverlay || document.getElementById('cc-reconnect-overlay');
        if (overlay) {
            overlay.classList.add('visible');
        }
    }

    /**
     * Hide network reconnecting overlay
     */
    hideReconnectingOverlay() {
        const overlay = this.elements.reconnectOverlay || document.getElementById('cc-reconnect-overlay');
        if (overlay) {
            overlay.classList.remove('visible');
        }
    }

    /**
     * Fetch token price from DexScreener API
     * @param {string} tokenMint - The token mint address
     * @returns {Promise<Object|null>} - { priceUsd, priceNative, priceChange24h, liquidity } or null on error
     */
    async fetchTokenPrice(tokenMint) {
        if (!tokenMint) {
            console.warn('[CryptoClient] No token mint provided for price fetch');
            return null;
        }

        try {
            const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`);

            if (!response.ok) {
                throw new Error(`DexScreener API error: ${response.status}`);
            }

            const data = await response.json();

            // DexScreener returns pairs array, we'll take the first pair with highest liquidity
            if (data.pairs && data.pairs.length > 0) {
                // Sort by liquidity (highest first)
                const sortedPairs = data.pairs.sort((a, b) => {
                    const liqA = parseFloat(a.liquidity?.usd || 0);
                    const liqB = parseFloat(b.liquidity?.usd || 0);
                    return liqB - liqA;
                });

                const bestPair = sortedPairs[0];

                return {
                    priceUsd: parseFloat(bestPair.priceUsd || 0),
                    priceNative: parseFloat(bestPair.priceNative || 0), // Price in SOL
                    priceChange24h: parseFloat(bestPair.priceChange?.h24 || 0),
                    liquidity: parseFloat(bestPair.liquidity?.usd || 0),
                    volume24h: parseFloat(bestPair.volume?.h24 || 0),
                    dexId: bestPair.dexId,
                    pairAddress: bestPair.pairAddress
                };
            }

            console.warn('[CryptoClient] No pairs found for token:', tokenMint);
            return null;
        } catch (error) {
            console.error('[CryptoClient] Error fetching token price:', error);
            return null;
        }
    }
}
