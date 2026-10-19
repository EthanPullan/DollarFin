# DollarFin

Small, single-file money tools — mostly converters for statements and exports.
Each one runs in your browser, works offline, and can be downloaded on its own.
Files you open are read on your device and never uploaded.

### ▶︎ [Open the site](https://ethanpullan.github.io/DollarFin/)

## Tools

| Tool | What it does |
| --- | --- |
| [Quicken Investment Converter](https://ethanpullan.github.io/DollarFin/tools/quicken-investment-converter/) | Wealthsimple monthly-statement CSVs → one Quicken investment import CSV. Load several months at once and they're combined in date order (rows repeated across overlapping statements are kept once). Buys, sells, transfers in/out, fees, dividends and interest; rename securities to match Quicken; pick trade or statement dates; set a transfer account per row · **Already in Quicken:** drop in a QIF (or CSV report) exported from Quicken and rows already there are left out |
| [Quicken Banking Converter](https://ethanpullan.github.io/DollarFin/tools/quicken-banking-converter/) | Wealthsimple activities exports or cash-account monthly statements → Quicken banking import CSV. Pick which accounts to include and name them, set a payee and category once per kind of transaction (remembered on your device), executed or effective dates, several exports combined in date order · **Already in Quicken:** drop in a QIF (or CSV report) exported from Quicken and rows already there are left out |
| [GnuCash to Quicken](https://ethanpullan.github.io/DollarFin/tools/gnucash-quicken-converter/) | GnuCash transaction exports (File › Export › Export Transactions to CSV, one per account) → Quicken banking import CSV. Finds each file's account, maps GnuCash income/expense accounts to Quicken categories (matched to your Quicken list), flags transfers and split transactions in the memo, keeps each GnuCash Transaction ID once across overlapping exports · **Already in Quicken:** drop in a QIF (or CSV report) exported from Quicken and rows already there are left out |

## About

- **Your data stays out of the repo.** `.gitignore` blocks statement-type files
  (`*.csv`, `*.qif`, `*.ofx`, `*.xlsx`, `*.pdf`, …). Tests use made-up data only.
- **One file per tool.** Inline CSS/JS, no CDNs, no web fonts, no network.
- **Static site.** Served straight from the repo root with GitHub Pages.
- **Design system.** Same tokens and components as
  [Teaching Tools](https://github.com/EthanPullan/TeachingTools/blob/main/STYLE_GUIDE.md).

## Tests

```bash
node --test tools/*/*.test.js
```
