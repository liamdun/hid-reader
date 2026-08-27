# Fob Reader

A read-only enrollment display for HID prox fobs and cards. It sits there and
listens: tap a card, the facility code and card number appear in large type, tap
the next one and the previous read drops into a list below. No buttons, no
"read" step, no dialogs.

Built as an alternative to the read-back screen in card personalization software
like Asure ID, which needs a click per read.

Reads live in memory only — refreshing the page clears the list.

## Running it

Any of these work:

```bash
npm start           # http://localhost:8080  (recommended)
```

```bash
npm run build       # writes dist/fob-reader.html - one file, open it directly
```

Or open `index.html` straight from disk. Keyboard-wedge readers work in all
three; WebHID and Web Serial want a real origin, so use `npm start` or host the
folder over https (GitHub Pages is enough).

## Hosting it

`npm run build` writes a deployable `dist/`: `index.html` (the whole app inlined
into one request), a `fob-reader.html` copy under a download-friendly name, and
a `_headers` file that stops the page being served from cache — so a fix reaches
the reader desk without anyone copying a file around.

**Cloudflare Pages** works with this repo while it stays private, and needs no
build tooling beyond Node:

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** →
   **Connect to Git**, and pick this repo.
2. Framework preset **None**, build command `npm run build`, output directory
   `dist`, production branch `claude/azure-fob-reader-app-yffw1m`.
3. Deploy. Every push to that branch redeploys automatically.

The resulting `*.pages.dev` URL is public even though the repo is private. That
is harmless here — the app has no backend and stores nothing — but Cloudflare
Access will put it behind a login if you would rather it weren't.

**GitHub Pages** is the alternative, with one catch: Pages on a private repo
needs a paid GitHub plan. Make the repo public and it is free.

Either way the site is served over https, which is what WebHID and Web Serial
need — so a hosted copy can do things the single downloaded file cannot.

## Will my reader work?

HID's card technology is proprietary, but that stops at the reader. Once the
reader has demodulated the card it emits an ordinary Wiegand bit stream, and
what matters is only how it hands that stream to the PC:

| How the reader connects | Works in a browser? |
| --- | --- |
| **Keyboard wedge** — types the number as if it were a keyboard. RFIDeas pcProx, OMNIKEY 5127CK, most desktop enrollment readers. | **Yes.** No drivers, no permission prompt, nothing to configure. |
| **Vendor HID** — a non-keyboard USB HID interface. | Usually. Chrome/Edge, "Connect HID reader". |
| **USB serial / CDC** — emits ASCII lines over a COM port. | Usually. Chrome/Edge, "Connect serial reader". |
| **PC/SC smartcard** — OMNIKEY in CCID mode, iCLASS/SEOS readers. | **No.** No browser exposes PC/SC, and the OS driver owns the device so WebHID can't claim it either. Needs a native helper. |

If your reader types the card number into Notepad, it is a keyboard wedge and
this app already works with it. That is also the mode worth switching a reader
into if it supports both — it is the only one with no browser caveats.

## Reading the output

**Reader sends** tells the app how to interpret the characters that arrive:
decimal, hex, a pre-split facility code and card number, or a bare card number.
Auto-detect treats anything containing `A`–`F` as hex; force hex if your reader
sends hex that happens to be all digits.

**Card format** slices the raw Wiegand value into a facility code and a card
number. Auto-detect guesses from the value's width and, where the format defines
parity bits, prefers one whose parity checks out.

That guess is a guess. A 35-bit card whose top bits happen to be zero looks
exactly like a 26-bit one, so each read also shows an *"Or, read as"* row with
the other plausible splits — click one to lock the format for the rest of the
session. If you know what your site issues, just pick it from the dropdown.

Supported: 26-bit H10301, 33-bit D10202, 34-bit H10306, 35-bit Corporate 1000,
37-bit H10304 and H10302, 48-bit Corporate 1000, and raw passthrough. Parity is
verified for the 26- and 34-bit formats and reported as unchecked for the rest.

## Other behaviour worth knowing

- **Keep the window focused.** A keyboard-wedge reader types into whatever has
  focus, so the status pill turns red when the window loses it.
- **Holding a card** against the reader makes it repeat. Identical reads within
  three seconds merge into one row with a `×n` count instead of flooding the list.
- **Click any number to copy it.** "Copy all as CSV" copies the whole session.
- A reader whose output can't be parsed shows the raw characters it sent, which
  is usually enough to work out the right "Reader sends" setting.

## Development

```bash
npm test            # decoder unit tests (node:test, no dependencies)
```

`wiegand.js` holds all the bit arithmetic and has no DOM dependencies, so it runs
under Node directly. `app.js` is only wiring: input capture, rendering, and the
device connections. There is no build step and no package dependencies —
`npm run build` just inlines the three files into one HTML document.
