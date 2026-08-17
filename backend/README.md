# KF-001 Owner Backend

Minimaler Cloudflare-Worker mit D1 als zentralem Case-State. Der Worker veröffentlicht ausschließlich den anonymisierten Owner-State für die GitHub-Pages-PWA.

## Wahrheitsstatus dieses Schritts

- D1: zentraler Source of Truth für den aktiven anonymisierten Case-State.
- Owner State API: read-only für die feste Origin `https://keschflow.github.io`.
- Radar Intake: nur mit dem Worker-Secret `RADAR_INGEST_TOKEN`.
- Approval Intent: absichtlich `NOT_LIVE` bis sichere Owner-Authentifizierung vorhanden ist.
- Push: absichtlich `NOT_LIVE`.
- Outreach Dispatch: absichtlich `NOT_LIVE`.

## Endpunkte

- `GET /health`
- `GET /v1/owner-state`
- `POST /v1/radar/cases` – Bearer-Secret erforderlich
- `POST /v1/approval-intents` – derzeit 503 / `NOT_LIVE`
- `POST /v1/push/subscriptions` – derzeit 503 / `NOT_LIVE`

Die Radar-API akzeptiert ausschließlich eine enge Liste öffentlicher, anonymisierter Felder. Reale Namen, Kontaktinformationen, Credential-IDs, private Evidence und exakte Finanzdetails gehören nicht in diese API.

## Deployment

1. `npx wrangler d1 create kf001-owner-state`
2. Die erzeugte `database_id` in `wrangler.toml` eintragen.
3. `npx wrangler d1 migrations apply kf001-owner-state --remote`
4. `npx wrangler secret put RADAR_INGEST_TOKEN`
5. `npx wrangler deploy`

Das Secret wird ausschließlich in Cloudflare gespeichert und niemals committed. Die verwendeten Worker- und D1-Ressourcen bleiben im kostenlosen Cloudflare-Tarif; ein Upgrade ist nicht Teil dieses Deployments.
