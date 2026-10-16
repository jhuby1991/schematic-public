# RAKO Schematic Drawing Tool

Public build of the schematic drawing tool, hosted with GitHub Pages.

**Live tool:** https://create.rkdraw.workers.dev/ (Cloudflare, published from `main`)

The old GitHub Pages address (jhuby1991.github.io/schematic-public) still
serves the same files, but sends everyone on to the Cloudflare address, first
offering to bring across any drawings autosaved at the old one (`moved.js`).

## What this is

A drag-and-drop schematic editor for RAKO lighting systems. Drag components
(RAKs, DIN modules, keypads, HUB, sensors, generics, labels) from the left-hand
palette onto the canvas, wire them together with coloured connectors, fill in the
project details, and print to an A4 landscape PDF with a title block and legend.

## Differences from the private `schematic` repo

- No Firebase Google sign-in gate (the `@rakocontrols.com` domain restriction is gone)
- `firebase-config.js` removed
- `index.html` now redirects straight to the tool at `custom.html`

## Updating the tool

JavaScript modules are cached by the browser, so **bump the version query string
whenever you change a `.js` file** — otherwise returning visitors can end up
running new HTML against stale JavaScript.

The version appears in two places:

- `custom.html` — `<script type="module" src="main.js?v=1.12">`
- every relative import inside the `.js` files — `from './ui.js?v=1.12'`

Bump them together (a find-and-replace on `?v=1.12` is enough).

## Running locally

It's a static site — no build step. Serve the folder over HTTP, e.g.

```
python3 -m http.server 8000
```

then open http://localhost:8000/

## Notes

Component artwork is loaded from `s.myrako.com`, so the tool needs an internet
connection to render the palette images.

## Issuing drawings as Rako (staff sign-in)

Rako staff click **Sales**, sign in with their @rakocontrols.com Google account
and **Issue this drawing**. That adds the drawing to Rako's register and prints a
stamp next to the title block: their name, the date, a code like `RK-7F3K-92QD`
and a QR code. Anyone can check a code at `/verify` (verify.html), which shows the
drawing exactly as it was issued. Editing a drawing after issuing it takes the
stamp off until it is issued again. Anyone can also type a code into
**Retrieve** in the tool's toolbar to open that drawing in the tool.

- Sign-in and the register use the `rako-system-designer-b7de1` Firebase project
  (Firebase Auth with Google, and Firestore over its REST API) - see `register.js`.
- **`firestore.rules` is what makes a stamp trustworthy**: only a verified
  @rakocontrols.com account can add a drawing, only in its own name; anyone can
  look up a code, nobody can list the register. Publish it in the Firebase
  console (Firestore Database > Rules), keeping any other `match` blocks already
  there.
- Each web address the tool runs on must be listed in Firebase under
  Authentication > Settings > Authorized domains (e.g. `create.rkdraw.workers.dev`).
- `qrcode.js` is qrcode-generator by Kazuhiko Arase (MIT licence).
