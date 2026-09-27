# Flipradar – webbversion

Den här mappen gör Flipradar till en riktig webbsida med egen adress, och lägger till en schemalagd kontroll som skickar notiser till mobilen när en bevakad tillgång flippar, även när datorn är avstängd.

Filerna:

| Fil | Vad den gör |
|---|---|
| `index.html` | Själva Flipradar-sidan |
| `check.mjs` | Skriptet som körs automatiskt. Hämtar aktiekurser (även svenska) till `data/stocks.json` och kontrollerar dina bevakningar |
| `.github/workflows/flipradar.yml` | Talar om för GitHub när skriptet ska köras (strax efter 02:10 och 00:15 svensk sommartid) |
| `watchlist.json` | Tillgångarna du vill ha mobilnotiser för |
| `state.json` | Senast kända trend för varje bevakning. Skriptet sköter den själv |

## Engångsinstallation (cirka 20 minuter)

### 1. Skapa ett GitHub-konto och ett repo
1. Skapa ett gratiskonto på [github.com](https://github.com) om du inte har ett.
2. Klicka på **+** uppe till höger → **New repository**.
3. Namn: `flipradar`. Välj **Public** (gratis webbsidor kräver det, se "Bra att veta" nedan). Klicka **Create repository**.

### 2. Ladda upp filerna
1. Packa upp zip-filen på din dator.
2. På repots sida: klicka **uploading an existing file**.
3. Dra in **allt innehåll** i mappen, inklusive mappen `.github`. På Mac är mappar som börjar med punkt dolda; tryck **Cmd + Shift + .** i Finder för att visa dem.
4. Klicka **Commit changes**.
5. Kontrollera att filen `.github/workflows/flipradar.yml` syns i repot. Saknas den: klicka **Add file → Create new file**, skriv `.github/workflows/flipradar.yml` som namn och klistra in innehållet från filen.

### 3. Slå på webbsidan (GitHub Pages)
1. **Settings → Pages**.
2. Under **Build and deployment**: Source = **Deploy from a branch**, Branch = **main** och **/ (root)**. Klicka **Save**.
3. Efter någon minut visas adressen, till exempel `https://dittnamn.github.io/flipradar/`. Det är din Flipradar.

### 4. Ge skriptet lov att spara kurser
1. **Settings → Actions → General**.
2. Under **Workflow permissions**: välj **Read and write permissions**. Klicka **Save**.

### 5. Installera ntfy och välj ett hemligt ämne
1. Installera appen **ntfy** på mobilen (App Store eller Google Play). På datorn kan du använda [ntfy.sh/app](https://ntfy.sh/app).
2. Hitta på ett långt, unikt ämnesnamn som ingen kan gissa, till exempel `flipradar-k7x2m9qp4w`. Ämnesnamnet fungerar som ett lösenord: den som känner till det kan läsa notiserna.
3. I appen: **+** → skriv ämnesnamnet → **Subscribe**.

### 6. Lägg in ämnet och adressen i GitHub
1. **Settings → Secrets and variables → Actions**.
2. Fliken **Secrets** → **New repository secret**. Name: `NTFY_TOPIC`, Secret: ditt ämnesnamn. Spara.
3. Fliken **Variables** → **New repository variable**. Name: `SITE_URL`, Value: adressen från steg 3. Spara. (Då öppnas Flipradar när du trycker på en notis.)

### 7. Välj vad du vill ha mobilnotiser för
1. Öppna Flipradar och stjärnmärk det du vill bevaka.
2. **Handelsdagbok och dina data → Kopiera bevakningslista för mobilnotiser**.
3. I repot: öppna `watchlist.json` → pennan (Edit) → ersätt innehållet med det du kopierade → **Commit changes**.

Formatet är en lista med nycklar: krypto som `"c:BTC"`, amerikanska aktier som `"NVDA"`, svenska som `"SWEC.B@XSTO"`.

### 8. Kör en första gång
1. Fliken **Actions** → **Flipradar** → **Run workflow** → **Run workflow**.
2. Efter ett par minuter ska körningen vara grön. Då finns `data/stocks.json` i repot och webbsidan visar aktier, även svenska, utan API-nyckel.
3. Första körningen sparar bara läget. Notiser kommer från och med nästa flip.

### 9. Flytta dina data från den lokala versionen
1. I din lokala Flipradar-fil: **Handelsdagbok och dina data → Exportera data**.
2. På webbversionen: **Importera data** och välj filen. Bevakningar, dagbok och inställningar följer med.

## Bra att veta

- **Offentligt repo:** med ett gratiskonto måste repot vara offentligt för att webbsidan ska fungera. Då kan vem som helst se koden, din `watchlist.json` och kursfilen. Ditt ntfy-ämne ligger som hemlighet och syns inte. Dagbok och bevakningar i webbläsaren syns inte heller, de ligger bara i din webbläsare.
- **Kursdata från Yahoo Finance:** skriptet använder Yahoos öppna men inofficiella gränssnitt. Det kan sluta fungera utan förvarning, och Yahoos villkor är skrivna för personligt bruk. Att lägga kursfilen på en offentlig sida är en gråzon. Vill du undvika det kan du sätta variabeln `PUBLISH_STOCKS` till `0` (samma ställe som `SITE_URL`); då hämtas bara bevakade aktier för notiserna, och webbsidan använder Twelve Data-nyckeln som förut.
- **Tider:** GitHub kan försena schemalagda körningar med upp till en halvtimme när det är mycket trafik.
- **Inaktiva repon:** GitHub stänger av schemat om repot inte har haft någon aktivitet på 60 dagar. Skriptet sparar kurser vid varje körning, vilket brukar räcka som aktivitet. Får du ett mejl om att arbetsflödet stängts av: gå till **Actions** och slå på det igen.
- **Notisernas logik** är densamma som sidans läge "Flippen är bekräftad": bara stängda staplar räknas, på både vecko- och dagsgraf.
