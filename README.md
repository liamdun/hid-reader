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

Pushing to the default branch runs the tests, builds the site, and force-pushes
it to the `gh-pages` branch. So a fix reaches the reader desk without anyone
copying a file around.

**One-time setup**, which needs a repo admin and cannot be done from CI —
GitHub's own workflow token is not allowed to create a Pages site
(`Resource not accessible by integration`), and pushing a `gh-pages` branch no
longer turns Pages on by itself:

> **Settings → Pages → Build and deployment → Source: Deploy from a branch →
> Branch: `gh-pages` / `(root)` → Save**

After that the site is at <https://liamdun.github.io/hid-reader/> and every push
redeploys it. Pages serves HTML with a ten-minute cache, so a fresh deploy can
take that long to appear; a hard reload skips the wait.

`npm run build` writes the same site to `dist/` locally: `index.html` with the
whole app inlined into one request, a `fob-reader.html` copy under a
download-friendly name, and a `_headers` file that Cloudflare Pages honours and
GitHub Pages ignores.

**Cloudflare Pages** remains an option, and is the one that works on a private
repo: connect the repo, framework preset **None**, build command `npm run build`,
output directory `dist`.

Either host serves over https, which is what WebHID and Web Serial need — so a
hosted copy can do things the single downloaded file cannot.

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
this app already works with it.

### Reference hardware: HID OMNIKEY 5427 CK

The reader this was built against. "CK" is *contactless keyboard*: it has two
personalities, and which one it is in decides everything.

- **Keyboard wedge** — enumerates as a USB keyboard and types the card data.
  Works here with nothing to connect.
- **CCID / PC-SC** — enumerates as a smartcard reader that the operating
  system's driver owns. No browser can reach it.

Either way the **Connect HID reader** button is useless for this model: in wedge
mode Chrome hides it because it is a keyboard, and in CCID mode the smartcard
driver has already claimed it. It will never appear in the WebHID picker.

Card personalization software generally drives this reader over PC/SC, so a
reader that is in daily use for programming is probably in CCID mode. HID's
OMNIKEY Workbench utility switches personalities — but switching to wedge mode
can stop the personalization software finding the reader, so check whether your
firmware offers a combined mode before changing a working station.

Tap a card in Notepad to tell the two apart: characters mean wedge mode.

#### Why CCID mode cannot be reached from a browser

No web API exposes PC/SC on Windows, and this is a platform gap rather than a
gap in this app:

- The **Web Smart Card API** (`navigator.smartCard`) exists, but it is available
  only to Isolated Web Apps, and only on ChromeOS. It is not implemented on
  Windows, macOS or Linux.
- **WebUSB** cannot claim the interface, because the operating system's
  smartcard driver already owns it. Rebinding it needs administrator rights.
- **WebHID** never sees the reader: in CCID mode it presents no HID interface,
  and in keyboard wedge mode Chrome hides it because it is a keyboard.
- Java applets, the old answer, died with NPAPI.

Every working browser-plus-smartcard product therefore ships a native helper.
That is not a workaround anyone skipped — it is the only route the platform
leaves open.

#### Getting facility code and card number out of wedge mode

Keyboard wedge mode is not limited to the card serial number. Its **PACS Custom**
output parses the PACS payload into separate fields — facility code, card
number, site code, OEM code — and types them with a separator and terminator of
your choosing. The reader does the decoding, and this app's "Facility code and
card number, separated" input mode reads the result directly.

Two constraints shape any plan around that:

- **The modes are mutually exclusive.** CCID cannot operate while keyboard wedge
  is active. A reader switched to wedge stops existing as a PC/SC device, so
  personalization software will not find it at all.
- **Switching does not have to mean installing anything.** Configuration lives
  in the reader, not the PC, and HID's documented deployment path is to build a
  configuration on one machine with OMNIKEY Workbench and apply it to other
  readers with a **configuration card** — tapped on the reader, no software on
  the target PC, and it persists across machines.

There is one documented direction that needs no tooling at all, and it is the
unhelpful one: a HID Set Feature Report of `0xA5 0x5A` on report ID `0x00`
switches a reader from wedge mode back to CCID. Going the other way is an
abstraction-layer command over CCID, which needs PC/SC access. That is also the mode worth switching a reader
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
