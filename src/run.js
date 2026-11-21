import { setTimeout as delay } from 'node:timers/promises';
import {
    InputError, firstPageUrl, matches, nextPageUrl, normalizeRelease, sanitize, validateStages,
} from './fts.js';

const USER_AGENT = 'uk-find-a-tender-actor/1.0';
const SEEN_MARGIN_DAYS = 120; // seen keys older than the window minus this margin are pruned (no fixed cap)
const MAX_WAIT_MS = 120000;
const MAX_PAGES = 2000;

const list = (v) => (Array.isArray(v) ? v : []).map((s) => String(s).trim()).filter(Boolean);
const optNum = (v, name) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new InputError(`${name} must be a non-negative number.`);
    return n;
};

function retryAfterMs(res) {
    const h = res.headers.get('retry-after');
    if (!h) return 0;
    if (/^\d+$/.test(h)) return Number(h) * 1000;
    const t = Date.parse(h);
    return Number.isFinite(t) ? Math.max(0, t - Date.now()) : 0;
}

function makeFetcher({ fetchImpl, sleep, intervalMs, log }) {
    let first = true;
    return async (url) => {
        for (let attempt = 0; attempt <= 3; attempt++) {
            if (!first) await sleep(attempt === 0 ? intervalMs : intervalMs * 2 ** attempt);
            first = false;
            let res;
            let text;
            try {
                res = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(90000) });
                text = await res.text();
            } catch (err) {
                if (attempt === 3) throw new Error(`Network error: ${err.message}`);
                log.warning('Network error, retrying');
                continue;
            }
            let json = null;
            try { json = JSON.parse(text); } catch { /* not JSON */ }
            if (res.ok && json && Array.isArray(json.releases)) return json;
            if (res.ok) throw new Error('Find a Tender returned an unexpected response (no releases array)');
            if (res.status !== 429 && res.status < 500) throw new Error(`Find a Tender API: HTTP ${res.status}${json?.message ? ` — ${json.message}` : ''}`);
            if (attempt === 3) throw new Error(`Find a Tender API: HTTP ${res.status} after retries`);
            const wait = retryAfterMs(res);
            if (wait > MAX_WAIT_MS) throw new Error(`Find a Tender API: HTTP ${res.status}; asked to wait ${Math.round(wait / 1000)} s — try again later`);
            if (wait > 0) await sleep(wait);
            log.warning(`Find a Tender API: HTTP ${res.status}, retrying`);
        }
        throw new Error('Find a Tender request failed');
    };
}

export async function run({ actor, log, fetchImpl = fetch, sleep = delay, now = () => new Date() }) {
    await actor.init();
    try {
        const input = (await actor.getInput()) ?? {};
        const stages = [...new Set(list(input.stages))];
        if (!stages.length) stages.push('tender');
        validateStages(stages);
        const onlyNew = input.onlyNew ?? false;
        const stateKey = input.stateKey || 'default';
        if (!/^[a-zA-Z0-9_-]{1,50}$/.test(stateKey)) throw new InputError('stateKey may only contain letters, digits, "-" and "_" (max 50).');
        const maxItems = Math.max(1, Math.min(Number(input.maxItems ?? 500), 50000));
        const intervalMs = Math.max(2000, Number(input.requestIntervalMs ?? 2000));
        const filters = {
            stages,
            keywords: list(input.keywords),
            cpvPrefixes: list(input.cpvPrefixes),
            regions: list(input.regions),
            minValue: optNum(input.minValue, 'minValue'),
            maxValue: optNum(input.maxValue, 'maxValue'),
            onlyOpen: input.onlyOpen ?? false,
            now: now(),
        };
        if (filters.cpvPrefixes.some((p) => !/^\d{1,8}$/.test(p))) throw new InputError('cpvPrefixes must be 1-8 digits, e.g. 72 or 7222.');
        let updatedFrom = input.updatedFrom || null;
        if (!updatedFrom) {
            const days = Math.max(1, Math.min(Number(input.daysBack ?? 3), 90));
            updatedFrom = new Date(now().getTime() - days * 864e5).toISOString().slice(0, 19);
        }
        const url0 = firstPageUrl({ updatedFrom, updatedTo: input.updatedTo || null });

        const store = onlyNew ? await actor.openKeyValueStore('uk-find-a-tender-state') : null;
        // seen: key -> release date (old array format is migrated).
        const rawSeen = onlyNew ? ((await store.getValue(`seen-${stateKey}`)) ?? {}) : {};
        const seen = new Map(Array.isArray(rawSeen) ? rawSeen.map((k) => [k, now().toISOString()]) : Object.entries(rawSeen));
        const pruneBefore = new Date(Date.parse(`${updatedFrom.slice(0, 10)}T00:00:00Z`) - SEEN_MARGIN_DAYS * 864e5).toISOString();
        // A notice can be republished (amended); monitoring keys include the release date so amendments
        // are reported once each.
        const keyOf = (rec) => `${rec.noticeId}@${rec.releaseDate}`;

        const get = makeFetcher({ fetchImpl, sleep, intervalMs, log });
        let url = url0;
        let pushed = 0;
        let scanned = 0;
        let pages = 0;
        let truncated = false;
        const visited = new Set();
        while (url && pushed < maxItems) {
            if (pages >= MAX_PAGES) { truncated = true; log.warning(`Stopped after ${MAX_PAGES} pages; results are incomplete — narrow the date window.`); break; }
            if (visited.has(url)) throw new Error('Find a Tender returned the same page link twice; stopping to avoid a loop.');
            visited.add(url);
            const pkg = await get(url);
            pages++;
            const out = [];
            for (const r of pkg.releases) {
                scanned++;
                const rec = normalizeRelease(r);
                if (seen.has(keyOf(rec)) || !matches(rec, filters)) continue;
                seen.set(keyOf(rec), rec.releaseDate ?? now().toISOString()); // also de-duplicates within the run
                out.push(rec);
                if (pushed + out.length >= maxItems) {
                    // stopping inside this page: anything after this release is not processed
                    if (pkg.releases.indexOf(r) < pkg.releases.length - 1) truncated = true;
                    break;
                }
            }
            if (out.length) {
                await actor.pushData(out);
                pushed += out.length;
                if (onlyNew) {
                    for (const [k, d] of seen) if (d < pruneBefore) seen.delete(k);
                    await store.setValue(`seen-${stateKey}`, Object.fromEntries(seen));
                }
            }
            if (pushed >= maxItems && nextPageUrl(pkg)) truncated = true;
            url = nextPageUrl(pkg);
        }
        await actor.setValue('RUN_SUMMARY', { firstPage: url0, pages, scanned, pushed, incomplete: truncated });
        if (pushed === 0) log.info(onlyNew ? 'No new notices since the last run.' : 'No notices matched.');
        log.info(`Done. Scanned ${scanned} notices, pushed ${pushed}.`);
        await actor.exit();
    } catch (err) {
        const msg = sanitize(err.message);
        log.error(err instanceof InputError ? `Invalid input: ${msg}` : msg);
        await actor.fail(msg);
    }
}
