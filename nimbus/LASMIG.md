# Nimbus3000 – backtest

- `engine.mjs` – strategins regler (samma som `nimbus3000.pine`).
- `run.mjs` – hämtar ett års timdata för 10 krypto och 10 aktier, kör backtesten och skriver `results/`.
- `results/report.md` – sammanfattning. `results/trades.csv` – varje affär.
- `data/` – den hämtade timdatan (sparas så att backtesten kan köras om).

Körs från fliken **Actions → Nimbus3000 backtest → Run workflow**. Påverkar inte Flipradar-sidan.
