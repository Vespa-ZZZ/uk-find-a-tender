import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateStages, isOpen, firstPageUrl, nextPageUrl, normalizeRelease, matches, redactContacts, InputError, sanitize } from '../src/fts.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const tender = fx('tender-page.json');
const award = fx('award-page.json');

test('firstPageUrl and pagination links', () => {
    const u = new URL(firstPageUrl({ stages: ['tender', 'award'], updatedFrom: '2026-11-20', updatedTo: '2026-11-21T10:00:00' }));
    assert.equal(u.searchParams.get('updatedFrom'), '2026-11-20T00:00:00');
    assert.equal(u.searchParams.get('updatedTo'), '2026-11-21T10:00:00');
    assert.equal(u.searchParams.get('stages'), null);
    assert.throws(() => validateStages(['foo']), InputError);
    assert.equal(new URL(firstPageUrl({ updatedFrom: '2026-11-20', updatedTo: '2026-11-20' })).searchParams.get('updatedTo'), '2026-11-20T23:59:59');
    assert.throws(() => firstPageUrl({ updatedFrom: '2026-11-21', updatedTo: '2026-11-20' }), /not be later/);
    assert.throws(() => firstPageUrl({ stages: [], updatedFrom: '20/11/2026' }), /updatedFrom/);
    assert.equal(nextPageUrl({ links: {} }), null);
    assert.throws(() => nextPageUrl({ links: { next: 'https://evil.example/api' } }), /Unexpected pagination/);
});

test('normalizeRelease flattens a tender notice', () => {
    const r = normalizeRelease(tender.releases.find((x) => x.id === '110082-2026'));
    assert.equal(r.noticeId, '110082-2026');
    assert.match(r.title, /Central Heating Upgrade/);
    assert.equal(r.valueAmount, 4700000);
    assert.equal(r.valueCurrency, 'GBP');
    assert.equal(r.cpvCode, '45331100');
    assert.ok(r.cpvCodes.includes('45331100'));
    assert.equal(r.tenderDeadline, '2027-01-07T12:00:00Z');
    assert.equal(r.noticeUrl, 'https://www.find-tender.service.gov.uk/Notice/110082-2026');
    assert.ok(r.buyerName);
});

test('no contact points or supplier data are ever output', () => {
    const rel = structuredClone(award.releases[0]);
    rel.parties.push({ id: 'S1', name: 'Jane Doe Plumbing', roles: ['supplier'], contactPoint: { name: 'Jane Doe', email: 'jane@example.com', telephone: '+44 20 7946 0000' } });
    rel.parties[0].contactPoint = { name: 'John Smith', email: 'john@council.example.gov.uk', telephone: '01234 567890' };
    (rel.awards ?? (rel.awards = [{ id: 'A' }]))[0].suppliers = [{ id: 'S1', name: 'Jane Doe Plumbing' }];
    rel.tender.description = 'Questions to John via john@council.example.gov.uk or 01234 567890 please.';
    const out = JSON.stringify(normalizeRelease(rel));
    for (const s of ['Jane Doe', 'John Smith', 'john@', '01234 567890', '+44 20 7946 0000']) assert.ok(!out.includes(s), s);
});

test('redactContacts keeps ordinary numbers', () => {
    assert.equal(redactContacts('Call 0161 496 0000 or +44 (0)20 7946 0018'), 'Call [redacted] or [redacted]');
    assert.equal(redactContacts('Budget 4,700,000 GBP; lot 2; CPV 45331100; 2027-01-07'), 'Budget 4,700,000 GBP; lot 2; CPV 45331100; 2027-01-07');
});

test('client-side filters', () => {
    const r = normalizeRelease(tender.releases.find((x) => x.id === '110082-2026'));
    const now = new Date('2026-11-21T00:00:00Z');
    assert.equal(matches(r, { keywords: ['heating'] }), true);
    assert.equal(matches(r, { keywords: ['software'] }), false);
    assert.equal(matches(r, { cpvPrefixes: ['453'] }), true);
    assert.equal(matches(r, { cpvPrefixes: ['72'] }), false);
    assert.equal(matches(r, { minValue: 1000000 }), true);
    assert.equal(matches(r, { maxValue: 1000000 }), false);
    assert.equal(matches(r, { onlyOpen: true, now }), true);
    assert.equal(matches(r, { onlyOpen: true, now: new Date('2027-02-01') }), false);
    const noValue = { ...r, valueAmount: null };
    assert.equal(matches(noValue, { minValue: 1 }), false);
});

test('award releases keep award metadata', () => {
    const r = normalizeRelease(award.releases[0]);
    assert.match(r.stage, /award/);
    assert.ok(r.awards.length >= 1);
    assert.ok(!('suppliers' in r.awards[0]));
});

test('malformed release and sanitize', () => {
    assert.throws(() => normalizeRelease({}), /without id/);
    const p = ['C:', 'Users', 'someone', 'x'].join('\\');
    assert.equal(sanitize(`EPERM ${p}`), 'EPERM <path>');
});

test('stage groups from OCDS tags', async () => {
    const { stageGroups } = await import('../src/fts.js');
    assert.deepEqual(stageGroups(['tenderUpdate']), ['tender']);
    assert.deepEqual(stageGroups(['award', 'contract']), ['award']);
    assert.deepEqual(stageGroups(['planningUpdate']), ['planning']);
    const r = normalizeRelease(tender.releases[0]);
    assert.equal(matches(r, { stages: ['tender'] }), true);
    assert.equal(matches(r, { stages: ['award'] }), false);
});

test('descriptions are not output and phone numbers without separators are redacted', () => {
    const rel = structuredClone(tender.releases[0]);
    rel.tender.title = 'Advocacy service – call 07700900123 or +447700900123';
    rel.tender.description = 'Contact Mrs Example Person for details';
    const r = normalizeRelease(rel);
    const out = JSON.stringify(r);
    assert.ok(!('description' in r));
    assert.doesNotMatch(out, /07700900123|447700900123|Example Person/);
    assert.equal(matches(r, { keywords: ['example person'] }), true, 'description still searchable');
});

test('open = future tender or expression-of-interest deadline and not cancelled', () => {
    const now = new Date('2026-11-21T00:00:00Z');
    const base = normalizeRelease(tender.releases[0]);
    assert.equal(isOpen(base, now), true);
    const eoi = structuredClone(tender.releases[0]);
    delete eoi.tender.tenderPeriod;
    eoi.tender.expressionOfInterestDeadline = '2026-12-01T12:00:00Z';
    const e = normalizeRelease(eoi);
    assert.equal(e.deadlineType, 'expressionOfInterest');
    assert.equal(isOpen(e, now), true);
    const cancelled = structuredClone(tender.releases[0]);
    cancelled.tag = ['tenderCancellation'];
    assert.equal(isOpen(normalizeRelease(cancelled), now), false);
});

test('award releases carry contract values and contract CPVs for filters', () => {
    const withContracts = award.releases.find((r) => (r.contracts ?? []).some((c) => c.value?.amount));
    const r = normalizeRelease(withContracts);
    assert.ok(r.contracts.length >= 1);
    assert.ok(r.awardedValueAmount > 0);
    assert.equal(matches(r, { minValue: 1 }), true);
});

test('titles drop bracketed phone numbers and contact phrases', () => {
    const rel = structuredClone(tender.releases[0]);
    rel.tender.title = 'Cleaning services - contact Jane Example, (020) 7946 0000';
    rel.tender.lots = [{ id: '1', title: 'Lot 1 Tel: 0161 496 0000' }];
    const out = JSON.stringify(normalizeRelease(rel));
    for (const s of ['Jane Example', '7946 0000', '496 0000']) assert.ok(!out.includes(s), s);
    assert.match(normalizeRelease(rel).title, /^Cleaning services/);
});

test('ordinary titles mentioning phones or contact centres are kept', () => {
    for (const t of ['Phone system replacement', 'Contact centre services', 'Email security platform', 'Mobile phone contract 2027']) {
        assert.equal(redactContacts(t), t);
    }
});
