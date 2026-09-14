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

## Running locally

It's a static site — no build step. Serve the folder over HTTP, e.g.

```
python3 -m http.server 8000
```

then open http://localhost:8000/

## Notes

Component artwork is loaded from `s.myrako.com`, so the tool needs an internet
connection to render the palette images.
