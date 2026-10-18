# DollarFin — project notes for Claude

A monorepo of small, **single-file** finance tools (mostly file converters),
deployed as a static site via **GitHub Pages** from the repo root.

## Layout
- `index.html` — the homepage / launcher (links to every tool).
- `tools/<tool-name>/index.html` — one self-contained tool per folder. Each tool
  must run offline by double-click: inline all CSS/JS, no CDNs, no web fonts, no
  network requests.
- `tools/<tool-name>/<tool-name>.test.js` — optional `node --test` unit tests.
  Keep testable logic in a DOM-free `<script id="core">` block; the test
  extracts it with `vm`.
- `.nojekyll` — serve files as-is on GitHub Pages.

## Privacy — IMPORTANT
- **Never commit real financial data.** No statements, exports, account
  numbers, balances or names from the owner's files — not as fixtures, test
  data, examples, comments or commit messages. Tests use invented values only.
- `.gitignore` blocks `*.csv`, `*.qif`, `*.ofx`, `*.xlsx`, `*.pdf`, `*.json`
  and similar. Don't loosen it; if a tool genuinely needs a committed sample,
  make it synthetic and force-add that one file deliberately.
- Tools process files in the browser only — never add uploads, analytics or
  any network request.

## Conventions
- Follow the Teaching Tools design system
  (https://github.com/EthanPullan/TeachingTools/blob/main/STYLE_GUIDE.md):
  forest-green primary (`--board`), amber accent (`--accent`), monospace for
  data, uppercase tracked labels. Copy the `:root` token block into each tool.
- Keep every tool dependency-free and portable.

## Commit / PR rules
- **Never include Claude session links** in commit messages, PR descriptions,
  code, comments, or any other artifact. (Plain co-author attribution is fine.)
- **Push finished work straight to `main`** — standing instruction from the repo
  owner, no need to ask each time. Work on a branch if you like, but land it on
  `main` when it's done and tested. (Solo project; `main` is what GitHub Pages
  serves.)
