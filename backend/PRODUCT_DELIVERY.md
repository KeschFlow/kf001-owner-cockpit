# Eddie's World – Delivery im vorhandenen Worker

Die serverseitige Logik aus `KeschFlow/eddiesworld-hq/delivery/worker.mjs` ist
in `src/product-delivery.js` übernommen und im tatsächlichen Entrypoint
`src/worker-v3.js` für genau zwei Routen eingebunden. Bestehende KF-001-Routen,
Webhook-Verarbeitung, Cron, D1 und der vorhandene Stripe-Schlüssel bleiben getrennt.
Keine neuen Ressourcen und keine Dateien ins Repository kopiert.

## Endpunkte

- `POST /api/delivery/authorize`, JSON: `{"product":"calendar","session":"<echte Stripe-Test-Session-ID>"}`.
  Prüft Session, Position/Price/Produkt, PaymentIntent und Charge bei Stripe,
  anschließend Existenz der privaten Datei. Ergebnis: `{token, expiresIn:300}`.
- `POST /api/delivery/download`, JSON: `{"token":"<aus authorize>"}`.
  Prüft HMAC, Produktbindung und Ablauf, dann Stripe einschließlich Refund und
  Dispute erneut. Streamt die PDF aus `env.PRODUCTS_BUCKET` mit `no-store` und
  `attachment`, ohne private oder öffentliche R2-URL auszugeben.
- OPTIONS für beide Routen unterstützt ausschließlich POST mit Content-Type
  und die exakt konfigurierte Shop-Origin. Keine Cookies oder CORS-Wildcards.

Nur Testmodus: `cs_test_`-Sessions, `livemode=false`, Session complete/paid,
PaymentIntent succeeded, Charge bezahlt/eingezogen, keine Rückerstattung oder
Dispute, genau eine Position/Menge 1, einmalig 490 Cent EUR. Andere Beträge,
Rabatte, zusätzliche Steuern oder Produkte werden nicht freigegeben. Signierte
Tokens gelten höchstens fünf Minuten; mehrere Zugriffe innerhalb der Frist sind
erlaubt, aber jeder Zugriff prüft erneut. Keine zusätzliche Datenbank oder E-Mail.
Session und Token sind vertrauliche Bearer-Referenzen; nicht öffentlich teilen
oder in Query-Strings/Logs schreiben. Besitz einer echten Session plus positive
Stripe-Prüfung berechtigt zum Download, keine zusätzliche Käuferanmeldung.

## Worker-Konfiguration vor echtem Sandbox-Test

Nur diese neuen Worker-Secrets über Cloudflare-Verwaltung setzen, niemals Git:

- `DELIVERY_STRIPE_TEST_SECRET`: passender `sk_test_`-Schlüssel der Sandbox.
  **Nicht** den bestehenden `STRIPE_SECRET_KEY` ändern; KF-001 benötigt ihn separat.
- `DELIVERY_DOWNLOAD_SIGNING_KEY`: kryptografisch zufälliger Schlüssel, mindestens
  32 Bytes, als Secret. Rotation invalidiert ausgestellte Download-Tokens.

Zusätzliche nicht geheime Laufzeitkonfiguration, nach Prüfung separat setzen:

- `DELIVERY_MODE`: `test`.
- `DELIVERY_APP_ORIGIN`: exakte zugelassene Website-Origin (z. B.
  `https://eddiesworld.de`), ohne Pfad/Slash. `PUBLIC_APP_ORIGIN` des Cockpits
  unverändert lassen. Same-Origin-Anfragen an den Worker sind ebenfalls erlaubt.
- `DELIVERY_PRODUCTS`: JSON-Objekt mit `calendar`, dessen Felder sind:
  `price` = echte Kalender-Test-Price-ID, `product` = echte Kalender-Test-Produkt-ID,
  `amount` = 490, `currency` = `eur`, `key` =
  `Mit-Eddie-durchs-Jahr-2027-26-Seiten-A4-quer.pdf`.
  Keine erfundenen IDs verwenden. `tracker` ist optional und benötigt separate
  korrekte IDs und eine andere private Datei; ohne Eintrag bleibt er gesperrt.
- Bestehendes R2-Binding `PRODUCTS_BUCKET`, Bucket
  `eddiesworld-private-products`. Dashboard-Privatheit/Dateiinhalt noch real prüfen;
  keine öffentlichen R2-Hosts aktivieren. `CASE_DB` unverändert lassen.

Ohne vollständige Konfiguration verweigert Delivery den Zugriff. Es gibt keinen
Fallback auf KF-001-Schlüssel, öffentliche PDFs oder fremde Produkte.

## Integrationstest und Rolloutgrenze

`npm run check` und `npm test` erfassen neue Logik und tatsächliches Routing im
Worker. Stripe und R2 werden gemockt; sie sind keine echte Sandbox-Zahlung und
bestätigen keine tatsächliche Cloudflare-Konfiguration oder Bucket-Datei.

Vor echtem Sandbox-Test nach Review erforderlich: Secret-/Produktkonfiguration,
eigener Test-Payment-Link mit Redirect zur Kalender-Danke-Seite und Session-ID,
privater R2-Objektcheck sowie freigegebene Testbereitstellung. Der Website-Client
in eddiesworld-hq verwendet derzeit relative `/api/delivery/*`-URLs: entweder
müssen diese zum bestehenden Worker geroutet werden oder ein gesondert geprüfter
Frontend-Wechsel zur Worker-Origin erfolgen. Diese Änderung aktiviert keinen
Frontend-Kaufbutton und ändert keine Website-/DNS-Routen.

Dann Erfolg bis zur vollständigen PDF sowie Abbruch, Ablehnung, falsches Produkt,
falsche Price/Betrag, direkter Download, Tokenablauf und Refund prüfen. Kein
Live-Link als Test, kein automatischer Wechsel auf Live-Modus. Beim Merge kann
der bestehende CI-Workflow automatisch deployen; Merge nur nach Review.
