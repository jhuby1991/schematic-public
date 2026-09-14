# RAKO Schematic Drawing Tool

Public build of the schematic drawing tool, hosted with GitHub Pages.

**Live tool:** https://jhuby1991.github.io/schematic-public/

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
