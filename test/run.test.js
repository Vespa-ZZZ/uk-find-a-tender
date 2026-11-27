import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { run } from '../src/run.js';

const tender = JSON.parse(readFileSync(new URL('./fixtures/tender-page.json', import.meta.url), 'utf8'));
const NOW = () => new Date('2026-11-21T00:00:00Z');
const API = 'https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages';

async function exec(input, respond, state = new Map(), chargeResult, configureActor) {
    const records = [];
    const lifecycle = [];
    const urls = [];
    const warnings = [];
    const values = new Map();
    let pushes = 0;
    const actor = {
        async init() {},
        async getInput() { return input; },
        async openKeyValueStore() {
            return { getValue: async (k) => structuredClone(state.get(k) ?? null), setValue: async (k, v) => { state.set(k, structuredClone(v)); } };
        },
        async pushData(rows) {
            pushes++;
            records.push(...(chargeResult?.eventChargeLimitReached ? rows.slice(0, chargeResult.chargedCount) : rows));
            return chargeResult;
        },
        async setValue(k, v) { values.set(k, v); },
        async exit() { lifecycle.push('exit'); },
        async fail(m) { lifecycle.push('fail', m); },
    };
    const log = { info() {}, warning(m) { warnings.push(m); }, error() {} };
    const fetchImpl = async (url) => { urls.push(url); return respond(url, urls.length); };
    configureActor?.(actor, records);
    await run({ actor, log, fetchImpl, sleep: async () => {}, now: NOW });
    return { records, lifecycle, urls, warnings, pushes, summary: values.get('RUN_SUMMARY') };
}
const ok = (o) => new Response(JSON.stringify(o));
const single = () => ok({ ...tender, links: {} });

test('follows next links and applies the default 3-day window', async () => {
    const r = await exec({}, (u, n) => ok(n === 1 ? { ...tender, links: { next: `${API}?cursor=abc` } } : { releases: [], links: {} }));
    assert.deepEqual(r.lifecycle, ['exit']);
    assert.equal(r.records.length, tender.releases.length);
    assert.match(r.urls[0], /updatedFrom=2026-11-18T00%3A00%3A00/);
    assert.doesNotMatch(r.urls[0], /stages=/);
    assert.equal(r.urls[1], `${API}?cursor=abc`);
});

test('monitoring mode reports each notice version once', async () => {
    const state = new Map();
    const a = await exec({ onlyNew: true }, single, state);
    const b = await exec({ onlyNew: true }, single, state);
    assert.equal(a.records.length, tender.releases.length);
    assert.equal(b.records.length, 0);
});

test('a charge-limited page saves seen keys only for notices written to the dataset', async () => {
    const input = { onlyNew: true };
    const state = new Map();
    const first = await exec(input, () => ok({ ...tender, links: { next: `${API}?cursor=more` } }), state,
        { eventChargeLimitReached: true, chargedCount: 1 });
    assert.deepEqual(first.lifecycle, ['exit']);
    assert.equal(first.urls.length, 1);
    assert.equal(first.pushes, 1);
    assert.equal(first.summary.pushed, 1);
    assert.equal(first.summary.incomplete, true);
    assert.match(first.warnings[0], /charge limit reached/i);
    const [saved] = first.records;
    assert.deepEqual(Object.keys(state.get('seen-default')), [`${saved.noticeId}@${saved.releaseDate}`]);

    const next = await exec(input, single, state, { eventChargeLimitReached: false, chargedCount: 0 });
    assert.equal(next.summary.pushed, tender.releases.length - 1);
    assert.ok(next.records.every((r) => r.noticeId !== saved.noticeId || r.releaseDate !== saved.releaseDate));
});

test('filters, maxItems and input validation', async () => {
    const f = await exec({ keywords: ['insurance'] }, single);
    assert.ok(f.records.length >= 1 && f.records.every((x) => /insurance/i.test(`${x.title} ${x.description}`)));
    const m = await exec({ maxItems: 1 }, () => ok({ ...tender, links: { next: `${API}?cursor=more` } }));
    assert.equal(m.records.length, 1);
    assert.equal(m.urls.length, 1);
    const bad = await exec({ cpvPrefixes: ['IT'] }, () => { throw new Error('no request'); });
    assert.match(bad.lifecycle[1], /cpvPrefixes/);
    const st = await exec({ stages: ['bid'] }, () => { throw new Error('no request'); });
    assert.match(st.lifecycle[1], /Unknown stage/);
});

test('HTTP errors fail, 503 retried', async () => {
    const e = await exec({}, () => new Response('nope', { status: 400 }));
    assert.match(e.lifecycle[1], /HTTP 400/);
    let n = 0;
    const r = await exec({}, () => (n++ === 0 ? new Response('busy', { status: 503 }) : single()));
    assert.deepEqual(r.lifecycle, ['exit']);
});

test('duplicate versions within one run are output once', async () => {
    const dup = { ...tender, releases: [tender.releases[0], tender.releases[0]], links: {} };
    const r = await exec({ onlyNew: true }, () => ok(dup));
    assert.equal(r.records.length, 1);
});

test('empty pages with a next link keep paging; repeated links stop with an error', async () => {
    const r = await exec({}, (u, n) => ok(n === 1 ? { releases: [], links: { next: `${API}?cursor=b` } } : { ...tender, links: {} }));
    assert.equal(r.records.length, tender.releases.length);
    const loop = await exec({}, () => ok({ releases: [], links: { next: `${API}?cursor=same` } }));
    assert.match(loop.lifecycle[1], /same page link twice/);
});

test('stopping inside the last page is reported as incomplete', async () => {
    const values = new Map();
    const records = [];
    await run({
        actor: { init: async () => {}, getInput: async () => ({ maxItems: 1 }), pushData: async (r) => records.push(...r), setValue: async (k, v) => values.set(k, v), exit: async () => {}, fail: async () => {} },
        log: { info() {}, warning() {}, error() {} },
        fetchImpl: async () => ok({ ...tender, links: {} }), sleep: async () => {}, now: NOW,
    });
    assert.equal(records.length, 1);
    assert.equal(values.get('RUN_SUMMARY').incomplete, true);
    assert.equal(values.get('RUN_SUMMARY').pages, 1);
});

test('prechecks the dataset item budget and allows non-PPE output', async () => {
    for (const [isPayPerEvent, budget] of [[true, 1], [true, 0], [false, 0]]) {
        const configureActor = (actor, records) => {
            actor.getChargingManager = () => ({
                getPricingInfo: () => ({ isPayPerEvent }),
                calculateMaxEventChargeCountWithinLimit(event) {
                    assert.equal(event, 'apify-default-dataset-item');
                    return budget - records.length;
                },
            });
        };
        const result = await exec({ onlyNew: true }, single, new Map(), undefined, configureActor);
        assert.deepEqual(result.lifecycle, ['exit']);
        assert.equal(result.records.length, isPayPerEvent ? budget : tender.releases.length);
        assert.equal(result.summary.pushed, result.records.length);
        assert.equal(result.summary.stopReason, isPayPerEvent ? 'spendingLimit' : undefined);
        assert.equal(result.pushes, result.records.length ? 1 : 0);
    }
});
