# KF-001 Governance Backend – Phase 2 (noch nicht aktiviert)

## Kleinste sinnvolle Zielarchitektur

Die bestehende GitHub-Pages-PWA bleibt die ausschließlich anonymisierte Owner-Oberfläche. GitHub Pages ist statisches Hosting und kann deshalb weder vertrauliche Zustände noch Secrets oder serverseitigen Versand sicher ausführen ([GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)).

Als kleinste zusätzliche Backend-Komponente wird **ein Cloudflare Worker mit D1** empfohlen:

- Worker: authentifizierte API für Owner State, Approval-Intents, Push-Subscriptions und späteren Outreach-Dispatch.
- D1: zentraler Case State mit versionierten, idempotenten Statusübergängen und Audit-Ereignissen.
- Worker Secrets: VAPID Private Key und später Gmail-OAuth-Refresh-Token; niemals Browser, GitHub Pages oder Repository. Cloudflare beschreibt Secrets ausdrücklich für API-Keys und Auth-Tokens ([Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)).
- Web Push: Subscription entsteht in der PWA; Speicherung und Versand erfolgen nur im Worker. Die PWA zeigt bis dahin `PUSH_BACKEND_CONNECTED = NO`.
- Gmail: Der Browser übermittelt ausschließlich den Approval-Intent. Erst der Worker darf nach erfolgreicher, idempotenter Zustandsänderung eine Mail versenden und danach `DISPATCHED` setzen.
- Evidence: private Dateien werden nicht in GitHub oder D1 abgelegt. Ein privater Object Store wird erst in einer späteren, separat freigegebenen Stufe ergänzt; ohne Datei bleibt `HASH_STATUS = NOT_AVAILABLE`.

Der Ansatz passt voraussichtlich in die kostenlosen Kontingente eines kleinen Owner-Systems: Workers Free umfasst aktuell 100.000 Requests pro Tag ([Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/)); D1 Free umfasst aktuell 5 Mio. gelesene und 100.000 geschriebene Zeilen pro Tag sowie 5 GB Speicher ([D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/)). Diese Limits sind keine Verfügbarkeitsgarantie und müssen vor Aktivierung erneut geprüft werden.

## Verbindliche Sicherheitsregeln

1. Authentifizierung und Owner-Autorisierung vor jedem privaten API-Zugriff.
2. CORS nur für die feste GitHub-Pages-Origin.
3. Optimistic Locking über `expectedVersion`; doppelte Approval-Intents sind idempotent.
4. Erlaubte Übergänge: `PENDING_APPROVAL → APPROVED_PENDING_DISPATCH | REJECTED → DISPATCHED → RESPONSE_RECEIVED`.
5. Versand und Status `DISPATCHED` nur serverseitig nach bestätigtem Provider-Erfolg.
6. Unveränderliches Audit-Event pro Zustandsübergang; keine personenbezogenen Inhalte in Client-Logs.
7. Keine Secrets, privaten Evidence-Dateien oder realen Fallinhalte im öffentlichen Repository.

## Noch nicht ausgeführt

Es wurde kein Cloudflare-Konto, Worker, D1-Datenbank, Push-Key oder Gmail-Zugang aktiviert. Die öffentliche PWA enthält nur Adapter-Schnittstellen und zeigt alle nicht verbundenen Leistungen als `NOT LIVE` beziehungsweise `NO` an.
