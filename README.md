# Curtain Lights

A phone remote for Bluetooth lights, with a switch at the top for each device:

- **Curtain** (`index.html`): Electight / Surplife LED curtain lights (3 × 3 m, 300 LEDs).
- **Strip** (`strip.html`): Govee H617C RGBIC LED strip (10 m, Bluetooth only).

Open the page in **Chrome on Android** (or Chrome/Edge on a computer), tap **Connect** and pick the device.
It talks to the lights directly over Web Bluetooth, so no app or PC is needed. Close the maker's app first
(Surplife or Govee Home), because the lights only accept one connection at a time.

**Home** (`home.html`, `home.css`, `home.js`) is a wall-panel app for a tablet, with four screens:
- **Home**: greeting, clock, weather (Open-Meteo), tiles for the other screens, and **Goodnight**
  (runs an Alexa routine through Voice Monkey, then turns the lights off after a delay).
- **Lights**: 15 scenes that set the curtain and strip together, Alexa buttons, and a card per light.
- **Music**: Spotify library, search, playlists and albums, with a player bar and speaker picker.
  Needs your own Spotify app's Client ID (Premium) with this page's URL as the redirect URI.
- **Calendar**: a shared Google Calendar through `calendar-bridge.gs` (an Apps Script web app; set-up steps
  are at the top of that file). Opening it switches the panel into calendar mode until "Close calendar".

Install it from Chrome (menu > Install app) to run full screen. Open `home.html?demo` to preview it with sample data.

Both pages have solid colours with brightness, animated effects (including music via the phone's mic),
a painter and a command finder for testing.

Protocol sources:
- Curtain: https://zff.dev/ge0rg/surplife-curtain, plus decoding of the Surplife app.
- Strip: H617A notes at https://notes.generalzero.org/Reverse%20Engineering/Signals/Bluetooth/Govee_lights.html
  and https://community.home-assistant.io/t/govee-h617a-ble-led-strip-lights-reverse-engineering/901353
  (20-byte commands with an XOR checksum, a keep-alive every 2 seconds, and per-segment colour via `33 05 15 01`).
  The H617C is assumed to behave like the H617A until tested.
