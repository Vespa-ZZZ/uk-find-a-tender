# UK Public Tenders Monitor (Find a Tender)

Search and **monitor UK public sector tenders** from **Find a Tender (FTS)** — the UK government's central procurement notice service (under the Procurement Act 2023 it carries notices for most UK public procurement) — via its official **OCDS API**. One clean JSON row per notice, and a monitoring mode that returns **only new tenders**.

## What you get

`noticeId`, `title`, `status`, `stage`, buyer (`buyerName`, `buyerLocality`, `buyerRegion`, `buyerCountry`), `mainCategory`, main and all CPV codes, estimated `valueAmount`/`valueCurrency`, `procurementMethod`, `tenderDeadline` (tender or expression-of-interest deadline), `lots` (title and value), `awards` and `contracts` (status, dates, values — award stage) with `awardedValueAmount`, `noticeUrl`, `releaseDate`, `ocid`, `source`.

Filters: notice stage (tender / planning / award), keywords, CPV prefixes, buyer region (NUTS/ITL), value range, open deadline, date window. The value filter uses the estimated value (`valueAmount`) and, when there is none, the total contract value (`value.amount` of the contracts, excluding gross amounts); values are compared as published, without currency conversion.

**Privacy by design:** contact points (names, e-mails, phone numbers), supplier/tenderer details and the free-text description are never output (the description is still searched by `keywords`); e-mail addresses, phone numbers and "contact …" phrases are removed from titles. Use `noticeUrl` for the full notice.

## Use cases

- **Bid teams & SMEs:** a daily list of new UK opportunities in your CPV codes and regions
- **Market intelligence:** pipeline (planning) and award data by buyer, category and value
- **Tender alert services & CRMs:** feed new notices into Slack, e-mail or a sales pipeline
- **AI agents:** "which open NHS or council tenders for software were published this week?"

## Input examples

Open IT tenders over £100k published in the last 3 days:

```json
{ "cpvPrefixes": ["72", "48"], "minValue": 100000, "onlyOpen": true }
```

Daily monitoring of construction tenders in Scotland (schedule once a day):

```json
{ "cpvPrefixes": ["45"], "regions": ["UKM"], "onlyNew": true, "stateKey": "scotland-construction" }
```

## Output example

```json
{
  "noticeId": "110082-2026",
  "ocid": "ocds-h6vhtk-06cdc0",
  "releaseDate": "2026-11-20T10:31:12Z",
  "stage": "tender",
  "title": "PKC14238  Central Heating Upgrade Phase 6",
  "status": "active",
  "buyerName": "Perth & Kinross Council",
  "buyerRegion": "UKM77",
  "mainCategory": "works",
  "cpvCode": "45331100",
  "cpvCodes": ["45331100"],
  "valueAmount": 4700000,
  "valueCurrency": "GBP",
  "procurementMethod": "open",
  "tenderDeadline": "2027-01-07T12:00:00Z",
  "lots": [{ "id": "1", "title": "Lot 1", "valueAmount": null, "valueCurrency": null }],
  "awards": [],
  "noticeUrl": "https://www.find-tender.service.gov.uk/Notice/110082-2026",
  "source": "Find a Tender Service (UK Government) — contains public sector information licensed under the Open Government Licence v3.0"
}
```

(Example abbreviated.)

## How it works

The Actor reads the official Find a Tender OCDS release-package API page by page (100 notices per request) for the chosen date window and stages, with a pause between requests and retries on temporary errors. Keyword/CPV/region/value/deadline filters are applied to each notice. In monitoring mode each notice **version** (amendments are republished) is reported once. Do not run two schedules with the same `stateKey` simultaneously. A run stopped by `maxItems` or the page limit (2,000 pages = 200,000 notices) is marked `incomplete` in the `RUN_SUMMARY` record. Notices skipped because of `maxItems` are returned by the next monitoring run while they are still inside the date window; if the page limit is reached, rerunning the same window does not help — split it into shorter windows. API documentation: [Find a Tender API](https://www.find-tender.service.gov.uk/apidocumentation), [terms](https://www.find-tender.service.gov.uk/Home/TermsAndConditions).

## Data source & licence

Contains public sector information licensed under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/) — source: Find a Tender Service, UK Government. When you republish the data, include this attribution. This Actor is not affiliated with or endorsed by the UK Government.

---

## 日本語の概要

英国政府の公共調達サイト Find a Tender の公式 OCDS API から、入札公告・計画・落札通知を JSON で取得し、キーワード・CPV・地域・金額・締切で絞り込みます。監視モードで新着のみ取得可能。担当者の連絡先や落札者情報は出力しません（OGL v3.0）。
