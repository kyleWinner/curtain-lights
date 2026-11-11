# Curtain Lights

A phone remote for Bluetooth lights, with a switch at the top for each device:

- **Curtain** (`index.html`): Electight / Surplife LED curtain lights (3 × 3 m, 300 LEDs).
- **Strip** (`strip.html`): Govee H617C RGBIC LED strip (10 m, Bluetooth only).

Open the page in **Chrome on Android** (or Chrome/Edge on a computer), tap **Connect** and pick the device.
It talks to the lights directly over Web Bluetooth, so no app or PC is needed. Close the maker's app first
(Surplife or Govee Home), because the lights only accept one connection at a time.

**Home** (`home.html`) is a wall-panel dashboard for a tablet: clock, weather (Open-Meteo), scenes that set both
lights at once, a card per light, and Spotify's now playing with controls and a speaker picker. Install it from Chrome
(menu > Install app / Add to Home screen) to run it full screen. It goes to a black clock, or the album art, when idle.
Spotify needs your own app's Client ID from developer.spotify.com (Premium account) with this page's URL as the redirect URI.
Open `home.html?demo` to preview it with sample data.

Both pages have solid colours with brightness, animated effects (including music via the phone's mic),
a painter and a command finder for testing.

Protocol sources:
- Curtain: https://zff.dev/ge0rg/surplife-curtain, plus decoding of the Surplife app.
- Strip: H617A notes at https://notes.generalzero.org/Reverse%20Engineering/Signals/Bluetooth/Govee_lights.html
  and https://community.home-assistant.io/t/govee-h617a-ble-led-strip-lights-reverse-engineering/901353
  (20-byte commands with an XOR checksum, a keep-alive every 2 seconds, and per-segment colour via `33 05 15 01`).
  The H617C is assumed to behave like the H617A until tested.
