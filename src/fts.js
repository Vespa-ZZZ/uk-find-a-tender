// Pure helpers for the UK Find a Tender Service OCDS API.
// API: https://www.find-tender.service.gov.uk/apidocumentation  Licence: Open Government Licence v3.0.

export const API = 'https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages';
export const NOTICE_URL = 'https://www.find-tender.service.gov.uk/Notice/';
export const SOURCE = 'Find a Tender Service (UK Government) — contains public sector information licensed under the Open Government Licence v3.0';
export const STAGES = ['planning', 'tender', 'award'];

export class InputError extends Error {}

const ISO_DT = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$/;
const CLOSED_STATUSES = new Set(['cancelled', 'unsuccessful', 'complete', 'withdrawn']);

export function firstPageUrl({ updatedFrom, updatedTo, limit = 100 }) {
    const url = new URL(API);
    const norm = {};
    for (const [k, v, endOfDay] of [['updatedFrom', updatedFrom, false], ['updatedTo', updatedTo, true]]) {
        if (!v) continue;
        if (!ISO_DT.test(v) || Number.isNaN(Date.parse(v.length === 10 ? `${v}T00:00:00Z` : `${v}Z`))) {
            throw new InputError(`${k} must be YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS.`);
        }
        // A date-only end includes that whole day.
        norm[k] = v.length === 10 ? `${v}T${endOfDay ? '23:59:59' : '00:00:00'}` : v;
        url.searchParams.set(k, norm[k]);
    }
    if (norm.updatedFrom && norm.updatedTo && norm.updatedFrom > norm.updatedTo) throw new InputError('updatedFrom must not be later than updatedTo.');
    // The API's own "stages" parameter stops pagination early, so stages are filtered client-side.
    url.searchParams.set('limit', String(limit));
    return url.href;
}

export function validateStages(stages) {
    const bad = stages.filter((s) => !STAGES.includes(s));
    if (bad.length) throw new InputError(`Unknown stage(s): ${bad.join(', ')}. Allowed: ${STAGES.join(', ')}`);
}

/** Only follow "next" links that stay on the same API endpoint. */
export function nextPageUrl(pkg) {
    const next = pkg?.links?.next;
    if (!next) return null;
    const u = new URL(next);
    if (u.origin + u.pathname !== API) throw new Error('Unexpected pagination link from Find a Tender');
    return u.href;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Remove e-mail addresses and phone numbers (with or without separators) from free text. */
export function redactContacts(text) {
    if (typeof text !== 'string') return text ?? null;
    return text
        .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[redacted]')
        .replace(/(?<![\w/])(?:\+\d{1,3}[\s.-]?)?(?:\(0\)[\s.-]?)?0?\d{2,5}[\s.-]\d{3,4}[\s.-]?\d{3,4}(?![\w/])/g, '[redacted]')
        .replace(/(?<![\d/])(?:\+44\s?\d{9,10}|0\d{9,10})(?!\d)/g, '[redacted]')
        // area code in parentheses, e.g. (020) 7946 0000
        .replace(/\(\d{2,5}\)[\s.-]?\d{2,5}(?:[\s.-]?\d{2,5}){0,3}/g, '[redacted]')
        // "Tel: ...", "Email: ..." (a colon is required so titles like "Phone system replacement" are kept)
        .replace(/\b(?:tel(?:ephone)?|phone|e-?mail)\s*:\s*[^,;()\n|]{1,60}/gi, '[redacted]')
        // "contact Jane Example" (a capitalised name must follow, so "Contact centre services" is kept)
        .replace(/\b[Cc]ontact(?:\s+person)?\s*:?\s+[A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+){0,2}/g, '[redacted]');
}

/** OCDS release tags -> stage group used by the stages filter. */
export function stageGroups(tags = []) {
    const groups = new Set();
    for (const t of tags) {
        if (t.startsWith('planning')) groups.add('planning');
        else if (t.startsWith('tender')) groups.add('tender');
        else if (t.startsWith('award') || t.startsWith('contract')) groups.add('award');
    }
    return [...groups];
}

const cpvOf = (classifications) => classifications.filter((c) => c && c.scheme === 'CPV' && c.id).map((c) => c.id);
const itemsCpv = (items) => (items ?? []).flatMap((i) => cpvOf([i.classification, ...(i.additionalClassifications ?? [])]));

/**
 * Flatten one OCDS release. Contact points, supplier / tenderer details and free-text descriptions are never
 * output (they can identify individuals); only the buying organisation is kept, and e-mail addresses and
 * phone numbers are removed from titles. The description is still used for keyword matching.
 */
export function normalizeRelease(r) {
    if (!r || typeof r.id !== 'string' || !r.tender) throw new Error('Find a Tender returned a release without id or tender');
    const t = r.tender;
    const buyerParty = (r.parties ?? []).find((p) => p.id === r.buyer?.id) ?? null;
    const cpvCodes = [...new Set([
        ...cpvOf([t.classification]), ...itemsCpv(t.items),
        ...(r.awards ?? []).flatMap((a) => itemsCpv(a.items)), ...(r.contracts ?? []).flatMap((c) => itemsCpv(c.items)),
    ])];
    const lots = (t.lots ?? []).map((l) => ({
        id: l.id ?? null, title: redactContacts(l.title ?? null), valueAmount: num(l.value?.amount), valueCurrency: l.value?.currency ?? null,
    }));
    const awards = (r.awards ?? []).map((a) => ({
        id: a.id ?? null, status: a.status ?? null, statusDetails: a.statusDetails ?? null, date: a.date ?? null,
        valueAmount: num(a.value?.amount), valueCurrency: a.value?.currency ?? null, relatedLots: a.relatedLots ?? [],
    }));
    const contracts = (r.contracts ?? []).map((c) => ({
        id: c.id ?? null, awardId: c.awardID ?? null, status: c.status ?? null, dateSigned: c.dateSigned ?? null,
        valueAmount: num(c.value?.amount), valueAmountGross: num(c.value?.amountGross), valueCurrency: c.value?.currency ?? null,
    }));
    const sumSameCurrency = (rows) => {
        const valued = rows.filter((x) => x.valueAmount !== null);
        if (!valued.length || new Set(valued.map((x) => x.valueCurrency)).size !== 1) return { amount: null, currency: null };
        return { amount: valued.reduce((s, x) => s + x.valueAmount, 0), currency: valued[0].valueCurrency };
    };
    const contractTotal = sumSameCurrency(contracts);
    const awardTotal = sumSameCurrency(awards);
    const deadline = t.tenderPeriod?.endDate ?? t.expressionOfInterestDeadline ?? null;
    const rec = {
        noticeId: r.id,
        ocid: r.ocid ?? null,
        releaseDate: r.date ?? null,
        stage: (r.tag ?? []).join(',') || null,
        tags: r.tag ?? [],
        title: redactContacts(t.title ?? null),
        status: t.status ?? null,
        buyerName: r.buyer?.name ?? buyerParty?.name ?? null,
        buyerLocality: buyerParty?.address?.locality ?? null,
        buyerRegion: buyerParty?.address?.region ?? null,
        buyerCountry: buyerParty?.address?.countryName ?? null,
        mainCategory: t.mainProcurementCategory ?? null,
        cpvCode: t.classification?.scheme === 'CPV' ? t.classification.id : null,
        cpvDescription: t.classification?.scheme === 'CPV' ? (t.classification.description ?? null) : null,
        cpvCodes,
        valueAmount: num(t.value?.amount),
        valueCurrency: t.value?.currency ?? null,
        awardedValueAmount: contractTotal.amount ?? awardTotal.amount,
        awardedValueCurrency: contractTotal.amount !== null ? contractTotal.currency : awardTotal.currency,
        procurementMethod: t.procurementMethod ?? null,
        procurementMethodDetails: t.procurementMethodDetails ?? null,
        tenderDeadline: deadline,
        deadlineType: t.tenderPeriod?.endDate ? 'tender' : (t.expressionOfInterestDeadline ? 'expressionOfInterest' : null),
        lots,
        awards,
        contracts,
        noticeUrl: NOTICE_URL + encodeURIComponent(r.id),
        source: SOURCE,
    };
    // Used for keyword matching only; not enumerable, so it is not written to the dataset.
    Object.defineProperty(rec, 'searchText', { value: `${t.title ?? ''}\n${t.description ?? ''}`.toLowerCase(), enumerable: false });
    return rec;
}

/** Whether a notice can still be responded to at `now`. */
export function isOpen(rec, now = new Date()) {
    if (rec.tags.some((t) => t.startsWith('tenderCancellation')) || CLOSED_STATUSES.has(rec.status)) return false;
    return Boolean(rec.tenderDeadline && Date.parse(rec.tenderDeadline) >= now.getTime());
}

/** Client-side filters (the API filters only by date). */
export function matches(rec, { stages = [], keywords = [], cpvPrefixes = [], minValue = null, maxValue = null, regions = [], onlyOpen = false, now = new Date() } = {}) {
    if (stages.length && !stageGroups(rec.tags).some((g) => stages.includes(g))) return false;
    if (keywords.length) {
        const hay = rec.searchText ?? `${rec.title ?? ''}`.toLowerCase();
        if (!keywords.some((k) => hay.includes(k.toLowerCase()))) return false;
    }
    if (cpvPrefixes.length && !rec.cpvCodes.some((c) => cpvPrefixes.some((p) => c.startsWith(p)))) return false;
    const value = rec.valueAmount ?? rec.awardedValueAmount;
    if (minValue !== null && !(value !== null && value >= minValue)) return false;
    if (maxValue !== null && !(value !== null && value <= maxValue)) return false;
    if (regions.length && !regions.some((g) => (rec.buyerRegion ?? '').toUpperCase().startsWith(g.toUpperCase()))) return false;
    if (onlyOpen && !isOpen(rec, now)) return false;
    return true;
}

export function sanitize(message) {
    return String(message)
        .replace(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s'"`)]*/g, '<path>')
        .replace(/\/(?:home|Users|root|tmp|var|usr)\/[^\s'"`)]*/g, '<path>');
}
