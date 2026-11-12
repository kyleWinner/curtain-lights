'use strict';
// =====================================================================
// Home wall panel. One page, four views (home, lights, music, calendar),
// so the Bluetooth connections to the lights survive moving between them.
// =====================================================================
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const DEMO = new URLSearchParams(location.search).has('demo');
// Same origin as the curtain and strip remotes, so their saved settings
// (curtain.*, strip.*) are shared; this page's own keys start with home.
const ls = {
  get(k, d){ try{ const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); }catch(e){ return d; } },
  set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); return true; }catch(e){ return false; } },
  del(k){ try{ localStorage.removeItem(k); }catch(e){} },
};
function toast(msg, err){
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.className = '', 3400);
}
function throttle(fn, ms){
  let timer = null, pending = null;
  return (...a) => {
    pending = a; if(timer) return;
    fn(...pending); pending = null;
    timer = setTimeout(function tick(){
      if(pending){ const p = pending; pending = null; fn(...p); timer = setTimeout(tick, ms); } else timer = null;
    }, ms);
  };
}
function debounce(fn, ms){ let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('Timed out')), ms))]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtMs = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
// Small element builder. Text always goes in as text, never as HTML.
function h(tag, props, ...kids){
  const el = document.createElement(tag);
  if(props) for(const [k, v] of Object.entries(props)){
    if(v == null || v === false) continue;
    if(k === 'class') el.className = v;
    else if(k === 'html') el.innerHTML = v;
    else if(k === 'style') el.style.cssText = v;
    else if(k.startsWith('on')) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for(const c of kids.flat()) if(c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

// colour
function hexToRgb(hex){ hex = String(hex).replace('#', ''); return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) || 0); }
const rgbToHex = rgb => '#' + rgb.map(x => clamp(Math.round(x), 0, 255).toString(16).padStart(2, '0')).join('');
function mixHex(a, b, f){ const A = hexToRgb(a), B = hexToRgb(b); return rgbToHex(A.map((x, i) => x + (B[i] - x) * f)); }
function rgbToHsv(r, g, b){
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let hh = 0;
  if(d){ if(max === r) hh = ((g - b) / d) % 6; else if(max === g) hh = (b - r) / d + 2; else hh = (r - g) / d + 4; hh *= 60; if(hh < 0) hh += 360; }
  return [hh, max ? d / max : 0, max];
}
function hsvToHex(hh, s, v){
  const f = n => { const k = (n + hh / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return rgbToHex([f(5), f(3), f(1)].map(x => x * 255));
}
// Screen colours are gamma-encoded and LEDs are linear: linearise before sending (same as the remotes).
const linRgb = rgb => rgb.map(c => Math.pow(c / 255, 2.2) * 255);
const ledHsv = hex => rgbToHsv(...linRgb(hexToRgb(hex)));
const dim = (hex, b) => mixHex('#0d0f16', hex, 0.3 + 0.7 * b);

// A "look" is ['#hex'] (solid), ['#a','#b',...] (gradient), 'rainbow', or {bands:[...], every:n} (hard stripes).
const RAINBOW = ['#ff2a2a', '#ff9500', '#ffe500', '#22ff66', '#00e5ff', '#2a7cff', '#9b2aff', '#ff2ad4'];
function lookStops(look){
  if(look === 'rainbow') return RAINBOW;
  if(Array.isArray(look) && look.length) return look;
  if(look && Array.isArray(look.bands) && look.bands.length) return look.bands;
  return ['#ffffff'];
}
function colorAt(stops, f){
  if(stops.length === 1) return stops[0];
  const x = clamp(f, 0, 1) * (stops.length - 1), i = Math.min(Math.floor(x), stops.length - 2);
  return mixHex(stops[i], stops[i + 1], x - i);
}
// colour of position f (0..1) / index i of n along the light
function lookAt(look, f, i){
  if(look && look.bands){ const b = look.bands, every = look.every || 1; return b[Math.floor(i / every) % b.length]; }
  return colorAt(lookStops(look), f);
}
const isSolid = look => Array.isArray(look) && look.length === 1;
function lookCss(look, dir = '90deg'){
  if(look && look.bands){
    const b = look.bands, n = b.length * 2;
    return `linear-gradient(${dir},${Array.from({length: n}, (_, k) => `${b[k % b.length]} ${k * 100 / n}% ${(k + 1) * 100 / n}%`).join(',')})`;
  }
  const st = lookStops(look);
  return st.length === 1 ? st[0] : `linear-gradient(${dir},${st.join(',')})`;
}
const lookMid = look => look && look.bands ? look.bands[0] : colorAt(lookStops(look), 0.5);

// =====================================================================
// Light protocols (copied from index.html and strip.html)
// =====================================================================
const CURTAIN = {
  frame(seq, p){ const n = p.length; return Uint8Array.from([0x00, seq & 255, 0x80, 0x00, (n >> 8) & 255, n & 255, (n + 1) & 255, 0x0a, ...p]); },
  power: on => [0x71, on ? 0x23 : 0x24],
  colour(hh, s, v){
    return [0xe0, 0x01, 0x00, 0xa1, Math.round((((hh % 360) + 360) % 360) / 2) % 180,
      clamp(Math.round(s * 100), 0, 100), clamp(Math.round(v * 100), 0, 100), 0, 0, 0, 0, 0x14, 0, 0];
  },
  smear(points){
    const n = points.length;
    return [0xe1, 0x04, 0, 0, 0, 80, 100, n >> 8, n & 255, ...points.flatMap(([hh, s, v]) => {
      const hs = ((Math.round(hh) % 360) << 7) | clamp(Math.round(s * 100), 0, 100);
      return [0, hs >> 8, hs & 255, clamp(Math.round(v * 100), 0, 100), 0];
    })];
  },
  clock(d = new Date()){
    const y = d.getFullYear(), wd = d.getDay() || 7;
    const body = [0x10, Math.floor(y / 100), y % 100, d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), wd, 0x00, 0x0f];
    return [...body, body.reduce((a, b) => a + b, 0) & 255];
  },
};
const GV_SVC = '00010203-0405-0607-0809-0a0b0c0d1910';
const GV_WRITE = '00010203-0405-0607-0809-0a0b0c0d2b11';
const GV_NOTIFY = '00010203-0405-0607-0809-0a0b0c0d2b10';
const STRIP = {
  packet(bytes){ const p = new Uint8Array(20); p.set(bytes.slice(0, 19)); let x = 0; for(let i = 0; i < 19; i++) x ^= p[i]; p[19] = x; return p; },
  power: on => [0x33, 0x01, on ? 1 : 0],
  bright: pct => ls.get('strip.brightScale', '100') === '255' ? [0x33, 0x04, clamp(Math.round(pct * 2.55), 1, 255)] : [0x33, 0x04, clamp(Math.round(pct), 1, 100)],
  keepAlive: () => [0xaa, 0x01],
  getBright: () => [0xaa, 0x04],
  methods: {
    seg:   {segs: true,  fn: (c, m) => [0x33, 0x05, 0x15, 0x01, ...c, 0, 0, 0, 0, 0, ...m]},
    seg0b: {segs: true,  fn: (c, m) => [0x33, 0x05, 0x0b, ...c, 0, 0, ...m]},
    rgb02: {segs: false, fn: c => [0x33, 0x05, 0x02, ...c]},
    rgb0d: {segs: false, fn: c => [0x33, 0x05, 0x0d, ...c]},
  },
};
const segCount = () => clamp(ls.get('strip.segCount', 15), 1, 30);
const stripMethod = () => STRIP.methods[ls.get('strip.colourMethod', 'seg')] || STRIP.methods.seg;
const stripRgb = hex => (ls.get('strip.gamma', true) ? linRgb(hexToRgb(hex)) : hexToRgb(hex)).map(c => clamp(Math.round(c), 0, 255));
function maskBytes(idxs, n){
  const m = new Array(Math.max(2, Math.ceil(n / 8))).fill(0);
  for(const i of idxs) if(i >= 0 && i < m.length * 8) m[i >> 3] |= 1 << (i & 7);
  return m;
}
// Third light: Zengge "BT SPI LED controller" (USB, ZJ-YBCUAS-HCQ2-1K). Same company and
// Bluetooth framing as the curtain, so it reuses the curtain's commands. Its colour
// command is picked with a test in Settings in case it differs from the curtain's.
// LEDs the gradient command paints: the "Number of IC light per segment" in the ZENGGE app.
const usbSegs = () => clamp(ls.get('usb.leds', 200), 2, 600);
// One Zengge message carries at most 254 bytes (the length is one byte), which is 49 LEDs of the
// gradient command. Longer ones are sent in pieces flagged 0x40, the last piece flagged 0x80
// (from community notes on the protocol). Exactly how the pieces are labelled isn't documented,
// so these are the five candidates the Settings test tries; the one that works is kept.
const FRAG_DATA = 200;
function usbFrames(seq, payload, variant){
  const n = payload.length;
  if(n + 1 <= 255) return [CURTAIN.frame(seq, payload)];
  if(variant === 'E'){   // one ordinary header with the full 16-bit length, bytes simply split across writes
    const all = Uint8Array.from([0x00, seq, 0x80, 0x00, n >> 8, n & 255, (n + 1) & 255, 0x0a, ...payload]), out = [];
    for(let i = 0; i < all.length; i += 240) out.push(all.slice(i, i + 240));
    return out;
  }
  const six = variant === 'B' || variant === 'D', zeroBased = variant === 'C' || variant === 'D';
  const out = [], first = payload.slice(0, FRAG_DATA - 1);
  out.push(Uint8Array.from([0x40, seq, 0x00, 0x00, n >> 8, n & 255, first.length + 1, 0x0a, ...first]));
  let k = 1;
  for(let i = first.length; i < n; i += FRAG_DATA, k++){
    const part = payload.slice(i, i + FRAG_DATA), last = i + FRAG_DATA >= n, idx = zeroBased ? k - 1 : k;
    out.push(Uint8Array.from([0x40, seq, (last ? 0x80 : 0) | ((idx >> 8) & 0x7f), idx & 255, part.length, ...(six ? [0x00] : []), ...part]));
  }
  return out;
}
const usbName = () => (ls.get('usb.name', '') || 'USB lights').trim();
const withSum = arr => [...arr, arr.reduce((a, b) => a + b, 0) & 255];
const USB_COLOUR = {
  a1: (hh, s, v) => CURTAIN.colour(hh, s, v),
  '3b': (hh, s, v) => { const hu = Math.round((((hh % 360) + 360) % 360)); return withSum([0x3b, 0xa1, hu >> 8, hu & 255, clamp(Math.round(s * 100), 0, 100), clamp(Math.round(v * 100), 0, 100), 0, 0, 0, 0, 0, 0]); },
  '31': (hh, s, v) => { const [r, g, b] = hexToRgb(hsvToHex(hh, s, v)); return withSum([0x31, r, g, b, 0x00, 0xf0, 0x0f]); },
};
const usbColour = (hh, s, v) => (USB_COLOUR[ls.get('usb.method', 'a1')] || USB_COLOUR.a1)(hh, s, v);
// Colour order fix. 'grb' means: what the tablet sends as red shows as green, as green shows as red, as blue shows as blue.
// To show a wanted colour, send each channel the value of the colour it actually lights up as.
const usbOrder = () => /^(?=.*r)(?=.*g)(?=.*b)[rgb]{3}$/.test(ls.get('usb.order', 'rgb')) ? ls.get('usb.order', 'rgb') : 'rgb';
function usbFix(hex){
  const o = usbOrder(); if(o === 'rgb') return hex;
  const [r, g, b] = hexToRgb(hex), want = {r, g, b};
  return rgbToHex([want[o[0]], want[o[1]], want[o[2]]]);
}
const curtainRows = () => { const rc = clamp(ls.get('curtain.rowCount', 30), 1, 33); return {rc, vis: clamp(ls.get('curtain.visRows', 20), 1, rc)}; };

// =====================================================================
// Bluetooth links: one per light. Keeps the device after the first pick and
// reconnects by itself when the connection drops, backing off 4 s to 1 min.
// =====================================================================
class Link {
  constructor(o){
    Object.assign(this, o);
    this.device = null; this.char = null; this.busy = false; this.wanted = false;
    this.retryMs = 4000; this.retryT = null; this.queue = Promise.resolve(); this.noResp = false;
    this.state = DEMO ? 'on' : navigator.bluetooth ? 'idle' : 'nobt';
    this.onDrop = this.onDrop.bind(this);
  }
  get on(){ return DEMO || !!(this.device && this.device.gatt && this.device.gatt.connected && this.char); }
  set(state){ this.state = state; render(this.key); }
  async choose(showAll){
    if(!navigator.bluetooth){ toast('This browser can\'t use Bluetooth. Open it in Chrome on Android.', true); return; }
    let d;
    try{
      d = await navigator.bluetooth.requestDevice(showAll ? {acceptAllDevices: true, optionalServices: [this.svc]} : {filters: this.filters, optionalServices: [this.svc]});
    }catch(e){ if(e.name !== 'NotFoundError') toast(e.message, true); return; }
    const other = Object.keys(links).find(k => k !== this.key && links[k].device && links[k].device.id === d.id);
    if(other){ toast(`That's the ${links[other].label.toLowerCase()}. Pick the other one.`, true); return; }
    this.adopt(d); ls.set('home.' + this.key + '.id', d.id);
    await this.open();
  }
  adopt(d){
    if(this.device === d) return;
    if(this.device){ this.device.removeEventListener('gattserverdisconnected', this.onDrop); try{ this.device.gatt.disconnect(); }catch(e){} }
    this.device = d; this.char = null;
    d.addEventListener('gattserverdisconnected', this.onDrop);
  }
  onDrop(){
    this.char = null; if(this.stopTimers) this.stopTimers();
    if(this.wanted){ this.set('lost'); this.retry(); } else this.set('idle');
  }
  retry(){
    clearTimeout(this.retryT);
    if(!this.wanted || !this.device) return;
    this.retryT = setTimeout(() => this.open(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 1.6, 60000);
  }
  async open(){
    if(DEMO || !this.device || this.busy || this.on) return;
    clearTimeout(this.retryT); this.busy = true; this.wanted = true; this.set('connecting');
    try{
      const server = await withTimeout(this.device.gatt.connect(), 20000);
      let svc;
      try{ svc = await server.getPrimaryService(this.svc); }
      catch(e){ this.wanted = false; this.device.gatt.disconnect(); throw new Error(`That isn't the ${this.label.toLowerCase()}. Pair it again from Settings.`); }
      this.char = await svc.getCharacteristic(this.write);
      await this.setup(svc);
      this.busy = false; this.retryMs = 4000; this.set('on');
      if(this.onOpen) this.onOpen();
    }catch(e){
      this.busy = false; this.char = null;
      if(!this.wanted){ toast(e.message, true); this.set('idle'); return; }
      try{ this.device.gatt.disconnect(); }catch(_){}
      this.set('lost'); this.retry();
    }
  }
  async restore(){
    if(DEMO || !navigator.bluetooth || !navigator.bluetooth.getDevices) return;
    try{
      const id = ls.get('home.' + this.key + '.id', null), list = await navigator.bluetooth.getDevices();
      const taken = Object.keys(links).filter(k => k !== this.key).map(k => ls.get('home.' + k + '.id', null));
      const d = list.find(x => x.id === id) || list.find(x => !taken.includes(x.id) && this.match(x.name || ''));
      if(!d) return;
      this.adopt(d); this.wanted = true; this.open();
    }catch(e){}
  }
  nextSeq(){ this.seq = ((this.seq || 0) + 1) & 255; return this.seq; }
  // several writes as one job, so nothing else lands between the pieces of a split message
  sendFrames(frames){
    if(DEMO){ window.lastFrames = frames; return Promise.resolve(true); }
    if(!this.on) return Promise.resolve(false);
    const job = this.queue.then(async () => {
      for(const f of frames){
        if(!this.on) return false;
        if(this.noResp) await this.char.writeValueWithoutResponse(f); else await this.char.writeValueWithResponse(f);
      }
      return true;
    }).catch(e => { console.warn(this.key, e); return false; });
    this.queue = job;
    return job;
  }
  send(bytes){
    if(DEMO) return Promise.resolve(true);
    if(!this.on) return Promise.resolve(false);
    const job = this.queue.then(async () => {
      if(!this.on) return false;
      const f = this.encode(bytes);
      if(this.noResp) await this.char.writeValueWithoutResponse(f); else await this.char.writeValueWithResponse(f);
      return true;
    }).catch(e => { console.warn(this.key, e); return false; });
    this.queue = job;
    return job;
  }
}
const links = {
  curtain: new Link({
    key: 'curtain', label: 'Curtain', svc: 0xffff, write: 0xff01, seq: 0,
    filters: [{namePrefix: 'IOTBT'}, {services: [0xffff]}],
    match: n => n.startsWith('IOTBT'),
    encode(b){ this.seq = (this.seq + 1) & 255; return CURTAIN.frame(this.seq, b); },
    async setup(svc){
      this.noResp = !this.char.properties.write; this.seq = 0;
      try{ const n = await svc.getCharacteristic(0xff02); await n.startNotifications(); }catch(e){}
    },
    onOpen(){ this.send(CURTAIN.clock()); },
  }),
  usb: new Link({
    key: 'usb', label: usbName(), svc: 0xffff, write: 0xff01, seq: 0,
    filters: [{services: [0xffff]}, {namePrefix: 'IOTBT'}, {namePrefix: 'LEDnet'}],
    match: () => false,   // looks like the curtain by name, so only reconnect by its saved ID
    encode(b){ this.seq = (this.seq + 1) & 255; return CURTAIN.frame(this.seq, b); },
    async setup(svc){
      this.noResp = !this.char.properties.write; this.seq = 0;
      try{ const n = await svc.getCharacteristic(0xff02); await n.startNotifications(); }catch(e){}
    },
  }),
  strip: new Link({
    key: 'strip', label: 'Strip', svc: GV_SVC, write: GV_WRITE,
    filters: [{namePrefix: 'Govee_H617'}, {namePrefix: 'ihoment_H617'}, {namePrefix: 'GBK_H617'}],
    match: n => /^(Govee|ihoment|GBK)_H617/.test(n),
    encode: b => STRIP.packet(b),
    async setup(svc){
      this.noResp = !!this.char.properties.writeWithoutResponse;
      for(const uuid of [GV_NOTIFY, GV_WRITE]){
        try{
          const ch = uuid === GV_WRITE ? this.char : await svc.getCharacteristic(uuid);
          if(ch.properties.notify){ await ch.startNotifications(); ch.addEventListener('characteristicvaluechanged', onStripNotify); }
        }catch(e){}
      }
    },
    onOpen(){
      clearInterval(this.ka);
      this.ka = setInterval(() => this.send(STRIP.keepAlive()), 2000);
      this.send(STRIP.keepAlive()); this.send(STRIP.getBright());
    },
    stopTimers(){ clearInterval(this.ka); },
  }),
};
function onStripNotify(e){
  const d = new Uint8Array(e.target.value.buffer), s = L.strip;
  if(d[0] === 0xaa && d[1] === 0x01){ const on = d[2] === 1; if(on !== s.on){ s.on = on; save('strip'); render('strip'); } }
  if(d[0] === 0xaa && d[1] === 0x04){
    const pct = ls.get('strip.brightScale', '100') === '255' ? Math.round(d[2] / 2.55) : d[2];
    if(pct >= 1 && pct <= 100 && pct !== s.bright){ s.bright = pct; save('strip'); render('strip'); }
  }
}

// =====================================================================
// Light state
// =====================================================================
function loadLook(key, fallback){
  const remote = ls.get(key + '.colour', null), look = ls.get('home.' + key + '.look', null);
  if(remote && (!look || ls.get('home.' + key + '.seen', null) !== remote)) return [remote];
  return look || [remote || fallback];
}
const L = {
  curtain: {on: ls.get('home.curtain.on', true), bright: ls.get('curtain.bright', 80), look: loadLook('curtain', '#ff7a3d')},
  strip: {on: ls.get('home.strip.on', true), bright: ls.get('strip.bright', 80), look: loadLook('strip', '#2a7cff')},
  usb: {on: ls.get('home.usb.on', true), bright: ls.get('usb.bright', 80), look: loadLook('usb', '#ff2ad4')},
};
const usesZengge = key => key === 'curtain' || key === 'usb';
const powerCmd = (key, on) => usesZengge(key) ? CURTAIN.power(on) : STRIP.power(on);
function save(key){
  const s = L[key];
  ls.set('home.' + key + '.on', s.on); ls.set('home.' + key + '.look', s.look); ls.set(key + '.bright', s.bright);
  if(isSolid(s.look)) ls.set(key + '.colour', s.look[0]);
  ls.set('home.' + key + '.seen', ls.get(key + '.colour', null));
}
async function pushLook(key){
  const s = L[key], link = links[key];
  if(!link.on) return false;
  const b = s.bright / 100;
  if(key === 'curtain'){
    if(isSolid(s.look)){ const [hh, sat, v] = ledHsv(s.look[0]); return link.send(CURTAIN.colour(hh, sat, v * b)); }
    const {rc, vis} = curtainRows();
    const pts = Array.from({length: rc}, (_, i) => {
      if(i >= vis) return [0, 0, 0];
      const [hh, sat, v] = ledHsv(lookAt(s.look, vis > 1 ? i / (vis - 1) : 0, i));
      return [hh, sat, v * b];
    });
    return link.send(CURTAIN.smear(pts));
  }
  if(key === 'usb'){
    if(isSolid(s.look)){ const [hh, sat, v] = ledHsv(usbFix(s.look[0])); return link.send(usbColour(hh, sat, v * b)); }
    const n = usbSegs();
    const payload = CURTAIN.smear(Array.from({length: n}, (_, i) => { const [hh, sat, v] = ledHsv(usbFix(lookAt(s.look, i / (n - 1), i))); return [hh, sat, v * b]; }));
    return payload.length + 1 <= 255 ? link.send(payload) : link.sendFrames(usbFrames(link.nextSeq(), payload, ls.get('usb.frag', 'A')));
  }
  const n = segCount(), m = stripMethod();
  const frame = Array.from({length: n}, (_, i) => stripRgb(lookAt(s.look, n > 1 ? i / (n - 1) : 0, i)));
  if(!m.segs) return link.send(m.fn(frame[0]));
  const groups = new Map();
  frame.forEach((c, i) => { const k = c.join(','); if(!groups.has(k)) groups.set(k, []); groups.get(k).push(i); });
  let ok = true;
  for(const [k, idxs] of groups) ok = (await link.send(m.fn(k.split(',').map(Number), maskBytes(idxs, n)))) && ok;
  return ok;
}
const pushBright = {
  curtain: throttle(() => pushLook('curtain'), 250),
  usb: throttle(() => pushLook('usb'), 450),
  strip: throttle(() => links.strip.send(STRIP.bright(L.strip.bright)), 150),
};
async function applyLight(key, {look, bright} = {}){
  if(FX.name) stopFx(true);
  const s = L[key], link = links[key];
  if(look !== undefined) s.look = look;
  if(bright !== undefined) s.bright = bright;
  const wasOff = !s.on; s.on = true; save(key); render(key);
  if(!link.on) return false;
  if(wasOff || key === 'strip') await link.send(powerCmd(key, true));
  const ok = await pushLook(key);
  if(key === 'strip') await link.send(STRIP.bright(s.bright));
  return ok;
}
async function setPower(key, on){
  if(FX.name) stopFx(true);
  const s = L[key], link = links[key];
  s.on = on; save(key); render(key);
  if(!link.on) return false;
  await link.send(powerCmd(key, on));
  if(on){ await pushLook(key); if(key === 'strip') await link.send(STRIP.bright(s.bright)); }
  return true;
}

// =====================================================================
// Light cards
// =====================================================================
const SWATCHES = [
  ['#ffc98a', 'Warm white'], ['#ffffff', 'White'], ['#ff2a2a', 'Red'], ['#ff6a00', 'Orange'], ['#ffd000', 'Yellow'],
  ['#22ff66', 'Green'], ['#00e5ff', 'Cyan'], ['#2a7cff', 'Blue'], ['#8a2aff', 'Purple'], ['#ff2ad4', 'Pink'],
];
const SUN = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const cards = {};
function makeCard(key){
  const el = $('#dev-' + key), link = links[key];
  el.innerHTML = `
    <div class="devHead">
      <div style="min-width:0"><h2 class="devName">${link.label}</h2><div class="status"><span class="dot"></span><span class="stext"></span></div></div>
      <button class="switch" role="switch" aria-checked="false" aria-label="${link.label} power"><i></i></button>
    </div>
    <div class="stage">${key === 'curtain'
      ? '<div class="rod"></div><div class="grid"></div>'
      : '<div class="stripBox"><div class="wash"></div><div class="bar"></div><div class="shelf"></div></div>'}<div class="offNote"></div></div>
    <div class="ctrl" style="display:flex;flex-direction:column;gap:12px">
      <div class="range"><div class="fill"></div><div class="lbl"><span style="display:flex;align-items:center;gap:8px">${SUN}Brightness</span><span class="pct"></span></div>
        <input type="range" min="5" max="100" aria-label="${link.label} brightness"></div>
      <div class="sws"></div>
    </div>
    <div class="devFoot"><button class="btn sm connect">Connect</button>${key === 'usb' ? '' : `<a class="more" href="${key === 'curtain' ? './' : 'strip.html'}">Full remote ›</a>`}</div>`;
  const c = {el, stage: $('.stage', el), sw: $('.switch', el), range: $('input[type=range]', el), fill: $('.fill', el), pct: $('.pct', el),
    stext: $('.stext', el), connect: $('.connect', el), note: $('.offNote', el), grid: $('.grid', el), bar: $('.bar', el), wash: $('.wash', el), swatches: []};
  for(const [hex, name] of SWATCHES){
    const b = h('button', {class: 'sw', 'aria-label': name, style: '--s:' + hex});
    b.dataset.hex = hex;
    b.onclick = () => { if(!needLink(key)) return; clearScene(); setFollow(false); applyLight(key, {look: [hex]}); };
    $('.sws', el).appendChild(b); c.swatches.push(b);
  }
  c.sw.onclick = () => { if(!needLink(key)) return; clearScene(); setPower(key, !L[key].on); };
  c.range.addEventListener('input', e => {
    L[key].bright = +e.target.value; save(key); render(key);
    if(links[key].on && L[key].on && !FX.name) pushBright[key]();
  });
  c.connect.onclick = () => link.device ? link.open() : link.choose(false);
  cards[key] = c;
  if(key === 'curtain') new ResizeObserver(sizeCurtain).observe(c.stage);
}
function needLink(key){
  if(links[key].on) return true;
  toast(links[key].state === 'nobt' ? 'Bluetooth needs Chrome on Android' : `${links[key].label} isn't connected yet`, true);
  return false;
}
function sizeCurtain(){
  const c = cards.curtain; if(!c) return;
  const {vis} = curtainRows();
  if(c.grid.childElementCount !== vis * 10){
    c.grid.innerHTML = '';
    for(let r = 0; r < vis; r++) for(let i = 0; i < 10; i++){ const d = h('i', {class: 'cell'}); d.dataset.r = r; c.grid.appendChild(d); }
    render('curtain');
  }
  const hh = c.stage.clientHeight - 46, w = c.stage.clientWidth - 30;
  if(hh <= 0) return;
  c.grid.style.setProperty('--cs', clamp(Math.floor(Math.min((hh - (vis - 1) * 3) / vis, (w - 27) / 10)), 4, 22) + 'px');
}
const STATUS = {on: 'Connected', connecting: 'Connecting…', lost: 'Reconnecting…', idle: 'Not connected', nobt: 'Needs Chrome on Android'};
function render(key){
  const c = cards[key]; if(!c) return;
  const s = L[key], link = links[key], b = s.bright / 100, lit = s.on;
  c.el.dataset.state = link.state;
  c.stext.textContent = link.state === 'on' ? (lit ? `On · ${s.bright}%` : 'Off') : STATUS[link.state];
  c.sw.setAttribute('aria-checked', String(lit));
  const mid = lookMid(s.look);
  c.el.style.setProperty('--dc', mid);
  c.range.value = s.bright; c.fill.style.width = ((s.bright - 5) / 95 * 100) + '%'; c.pct.textContent = s.bright + '%';
  c.swatches.forEach(w => w.classList.toggle('sel', isSolid(s.look) && w.dataset.hex === s.look[0]));
  c.connect.hidden = link.state === 'on' || link.state === 'nobt';
  c.connect.textContent = link.state === 'connecting' ? 'Connecting…' : link.device ? 'Reconnect' : 'Connect';
  c.connect.disabled = link.state === 'connecting';
  c.note.textContent = link.state === 'on' && !lit ? 'Switched off' : '';
  c.stage.classList.toggle('lit', lit);
  if(key === 'curtain'){
    const {vis} = curtainRows();
    $$('.cell', c.grid).forEach(d => { const r = +d.dataset.r; d.style.setProperty('--c', dim(lookAt(s.look, vis > 1 ? r / (vis - 1) : 0, r), b)); });
  }else{
    const n = key === 'usb' ? Math.min(usbSegs(), 30) : segCount();
    if(c.bar.childElementCount !== n){ c.bar.innerHTML = ''; for(let i = 0; i < n; i++) c.bar.appendChild(h('i')); }
    Array.from(c.bar.children).forEach((d, i) => d.style.setProperty('--c', dim(lookAt(s.look, n > 1 ? i / (n - 1) : 0, i), b)));
    c.wash.style.setProperty('--wash', lookCss(s.look)); c.wash.style.setProperty('--wo', String(0.25 + 0.5 * b));
  }
  if(key !== 'usb'){
    const root = document.documentElement.style;
    root.setProperty(key === 'curtain' ? '--c1' : '--c2', mid);
    root.setProperty(key === 'curtain' ? '--o1' : '--o2', lit ? String(0.45 + 0.55 * b) : '0');
  }
  renderHomeTiles();
}

// =====================================================================
// Scenes
// =====================================================================
const SCENES = [
  {id: 'warm', name: 'Evening', bright: 65, curtain: ['#ffb066'], strip: ['#ffb066']},
  {id: 'reading', name: 'Reading', bright: 90, curtain: ['#ffdcb0'], strip: ['#ffdcb0']},
  {id: 'focus', name: 'Focus', bright: 100, curtain: ['#ffffff'], strip: ['#ffffff']},
  {id: 'relax', name: 'Relax', bright: 45, curtain: ['#ff9a5a', '#ff5f7e'], strip: ['#ff9a5a', '#ff5f7e', '#ff9a5a']},
  {id: 'sunset', name: 'Sunset', bright: 90, curtain: ['#ff8a1a', '#ff3d6e', '#7a2aff'], strip: ['#ff8a1a', '#ff3d6e', '#9b2aff', '#ff3d6e', '#ff8a1a']},
  {id: 'ocean', name: 'Ocean', bright: 80, curtain: ['#00e5ff', '#2a7cff', '#3a1aff'], strip: ['#00e5ff', '#2a7cff', '#00e5ff']},
  {id: 'aurora', name: 'Aurora', bright: 80, curtain: ['#22ff9a', '#00d5ff', '#7a2aff'], strip: ['#22ff9a', '#00d5ff', '#7a2aff', '#00d5ff', '#22ff9a']},
  {id: 'fire', name: 'Fireplace', bright: 85, curtain: ['#c81800', '#ff5a00', '#ffb000'], strip: ['#ff5a00', '#ffb000', '#ff3000', '#ffb000', '#ff5a00']},
  {id: 'forest', name: 'Forest', bright: 70, curtain: ['#b4ff5a', '#1fa32a', '#0b5a2a'], strip: ['#1fa32a', '#b4ff5a', '#1fa32a']},
  {id: 'candy', name: 'Candy', bright: 75, curtain: ['#ff8ad8', '#c99bff', '#8adfff'], strip: ['#ff8ad8', '#c99bff', '#8adfff', '#c99bff', '#ff8ad8']},
  {id: 'movie', name: 'Movie', bright: 14, curtain: ['#3a2aff'], strip: ['#5a2aff']},
  {id: 'night', name: 'Night light', bright: 6, curtain: ['#ff3a10'], strip: ['#ff3a10']},
  {id: 'party', name: 'Party', bright: 100, curtain: 'rainbow', strip: 'rainbow'},
  {id: 'xmas', name: 'Christmas', bright: 85, curtain: {bands: ['#ff1a1a', '#22ff44'], every: 2}, strip: {bands: ['#ff1a1a', '#22ff44', '#ffd9a0']}},
  {id: 'off', name: 'All off', off: true},
];
const POWER_ICON = '<svg viewBox="0 0 24 24"><path d="M12 3v9"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/></svg>';
function buildScenes(){
  const box = $('#scenes'); box.innerHTML = '';
  for(const sc of SCENES){
    if(sc.off) continue; // All on / All off live in the header now
    const i = h('i', {html: sc.off ? POWER_ICON : ''});
    i.style.setProperty('--g', sc.off ? 'var(--surface2)' : lookCss(sc.curtain));
    const b = h('button', {class: 'scene', onclick: () => runScene(sc)}, i, h('b', null, sc.name));
    b.dataset.id = sc.id;
    box.appendChild(b);
  }
  markScene(ls.get('home.scene', null));
}
function markScene(id){ ls.set('home.scene', id); $$('.scene').forEach(b => b.classList.toggle('on', b.dataset.id === id)); }
function clearScene(){ markScene(null); }
async function runScene(sc){
  const skipped = Object.keys(links).filter(k => !links[k].on).map(k => links[k].label);
  if(skipped.length === Object.keys(links).length){ toast('Connect your lights first', true); return; }
  markScene(sc.id); setFollow(false);
  await Promise.all(Object.keys(links).filter(k => links[k].on).map(k =>
    sc.off ? setPower(k, false) : applyLight(k, {look: sc[k] || sc.strip, bright: sc.bright})));
  if(skipped.length) toast(`${skipped.join(' and ')} ${skipped.length > 1 ? 'aren\'t' : 'isn\'t'} connected, so ${skipped.length > 1 ? 'they were' : 'it was'} left alone`);
}
// All on / All off: every connected light at once.
async function allPower(on){
  const keys = Object.keys(links), live = keys.filter(k => links[k].on);
  if(!live.length){ toast('Connect your lights first', true); return; }
  clearScene(); setFollow(false);
  await Promise.all(live.map(k => setPower(k, on)));
  const skipped = keys.filter(k => !links[k].on).map(k => links[k].label);
  toast((live.length === keys.length ? 'All lights ' : live.map(k => links[k].label).join(' and ') + ' ') + (on ? 'on' : 'off') +
    (skipped.length ? ` · ${skipped.join(' and ')} not connected` : ''));
}
function renderHomeTiles(){
  const el = $('#tLights'); if(!el) return;
  const parts = Object.keys(links).filter(k => links[k].on).map(k => `${links[k].label} ${L[k].on ? 'on' : 'off'}`);
  if(FX.name && FX_MAP[FX.name]){ el.textContent = FX_MAP[FX.name].name + ' effect'; return; }
  el.textContent = parts.length ? parts.join(' · ') : (navigator.bluetooth || DEMO ? 'Tap to connect' : 'Needs Chrome on Android');
}

// =====================================================================
// Effects: animated from the tablet, like the remotes. Each tick works out a
// colour per light and sends it as one colour command; newest frame wins.
// =====================================================================
const smooth = x => x * x * (3 - 2 * x);
function hueMix(a, b, f){ const d = ((b - a + 540) % 360) - 180; return (a + d * f + 360) % 360; }
function hueWalk(list, P, t){ const i = Math.floor(t / P), f = smooth((t / P) % 1); return hueMix(list[i % list.length], list[(i + 1) % list.length], f); }
function flicker(st, t, k, hueBase, hueWob, sat){
  if(!st.next || t > st.next){ st.target = 0.35 + Math.random() * 0.65; st.next = t + (0.05 + Math.random() * 0.25) / k; }
  if(st.v === undefined) st.v = 0.8;
  st.v += (st.target - st.v) * 0.45;
  return [hueBase + Math.sin(t * 3) * hueWob, sat, st.v];
}
// spread: each light runs a little behind the last, so colour moves across the room
const FX_LIST = [
  {id: 'rainbow', name: 'Rainbow', spread: true, g: 'linear-gradient(90deg,#ff3b3b,#ffd23b,#3bff6a,#3bd5ff,#6a3bff,#ff3bd2,#ff3b3b)',
    fn: (t, k) => [(t * k * 30) % 360, 1, 1]},
  {id: 'fade', name: 'Colour fade', spread: true, g: 'linear-gradient(90deg,#ff3b3b,#ff9a3b,#3bff9a,#3b8cff,#b43bff,#ff3b3b)',
    fn: (t, k) => [hueWalk([0, 25, 50, 120, 185, 220, 270, 315], 4 / k, t), 1, 1]},
  {id: 'breathe', name: 'Breathe', g: 'linear-gradient(90deg,#000,#ffb066,#000)',
    fn: (t, k, st) => [st.base[0], st.base[1], st.base[2] * (0.06 + 0.94 * (0.5 - 0.5 * Math.cos(2 * Math.PI * t * k / 4)))]},
  {id: 'candle', name: 'Candlelight', g: 'linear-gradient(90deg,#ff7a1a,#ffb347,#ff8a2a,#ffc266,#ff7a1a)',
    fn: (t, k, st) => flicker(st, t, k, 26, 4, 0.9)},
  {id: 'sunset', name: 'Sunset', spread: true, g: 'linear-gradient(90deg,#ff8a1a,#ff4d6d,#b14dff,#ff4d6d,#ff8a1a)',
    fn: (t, k) => [hueWalk([28, 350, 290, 350], 6 / k, t), 1, 0.9]},
  {id: 'aurora', name: 'Aurora', spread: true, g: 'linear-gradient(90deg,#22ff9a,#00d5ff,#7a2aff,#00d5ff,#22ff9a)',
    fn: (t, k) => [hueWalk([140, 175, 200, 275, 200], 5 / k, t), 0.9, 0.65 + 0.35 * (0.5 + 0.5 * Math.sin(t * k * 0.9))]},
  {id: 'ocean', name: 'Ocean', spread: true, g: 'linear-gradient(90deg,#00e5ff,#2a7cff,#1a3aff,#2a7cff,#00e5ff)',
    fn: (t, k) => [205 + 22 * Math.sin(t * k * 0.5), 1, 0.55 + 0.45 * Math.pow(0.5 + 0.5 * Math.sin(t * k * 1.3), 1.5)]},
  {id: 'storm', name: 'Storm', g: 'linear-gradient(90deg,#1c0638 0 40%,#fff 45%,#1c0638 50% 70%,#e8e0ff 74%,#1c0638 78%)',
    fn: (t, k, st) => {
      if(st.strike === undefined) st.strike = t + 1 + Math.random() * 2;
      const d = t - st.strike;
      if(d > 1.4){ st.strike = t + (2 + Math.random() * 6) / k; st.double = Math.random() < 0.6; }
      if(d >= 0 && d < 0.07) return [260, 0.05, 1];
      if(st.double && d >= 0.16 && d < 0.26) return [250, 0.1, 0.9];
      if(d >= 0.26 && d < 1.4) return [270, 0.6, Math.max(0.1, 0.7 * (1 - d / 1.4))];
      return [262, 1, 0.12 + 0.03 * Math.sin(t * 0.7)];
    }},
  {id: 'police', name: 'Red & blue', g: 'linear-gradient(90deg,#ff2a2a 0 50%,#2a5bff 50% 100%)',
    fn: (t, k, st) => { const ph = (t * k * 1.5 + st.idx * 0.5) % 1; return ph < 0.5 ? [0, 1, ph < 0.4 ? 1 : 0] : [225, 1, ph < 0.9 ? 1 : 0]; }},
  {id: 'strobe', name: 'Strobe', g: 'linear-gradient(90deg,#fff 0 25%,#000 25% 50%,#fff 50% 75%,#000 75% 100%)',
    fn: (t, k, st) => [st.base[0], st.base[1], (t * k * 2.5) % 1 < 0.5 ? st.base[2] : 0]},
  {id: 'music', name: 'Music', g: 'linear-gradient(90deg,#3bd5ff,#6a3bff,#ff3bd2,#ffd23b,#3bd5ff)',
    fn: (t, k, st) => {
      if(!fxAudio) return [0, 0, 0];
      const lvl = fxMic.level, avg = fxMic.avg;
      const v = Math.pow(clamp(lvl / (avg * 1.9 + 0.002), 0, 1), 1.4);
      st.hue = ((st.hue ?? (200 + st.idx * 90)) + 0.4 * k) % 360;
      if(fxMic.beat && st.lastBeat !== fxMic.beat){ st.lastBeat = fxMic.beat; st.hue = (st.hue + 50 + Math.random() * 80) % 360; }
      return [st.hue, 1, Math.max(0.04, v)];
    }},
  // ---- Christmas ----
  {id: 'twinkle', group: 'Christmas', name: 'Twinkle', spread: true, g: 'linear-gradient(90deg,#ff1a1a,#22ff44,#ff1a1a,#22ff44)',
    fn: (t, k) => { const P = 3 / k, ph = (t / P) % 2, f = smooth(ph % 1); return ph < 1 ? [0, 1, 1 - f * 0.9] : [125, 1, 0.1 + f * 0.9]; }},
  {id: 'xmasfade', group: 'Christmas', name: 'Red & green', spread: true, g: 'linear-gradient(90deg,#ff1a1a,#ffd9a0,#22ff44,#ffd9a0,#ff1a1a)',
    fn: (t, k) => { const f = 0.5 - 0.5 * Math.cos(t * k * 0.8); return f < 0.5 ? [0, 1 - f * 1.6, 1] : [125, (f - 0.5) * 1.6 + 0.2, 1]; }},
  {id: 'cane', group: 'Christmas', name: 'Candy cane', g: 'linear-gradient(90deg,#ff1a1a 0 25%,#fff 25% 50%,#ff1a1a 50% 75%,#fff 75%)',
    fn: (t, k, st) => ((t * k * 0.8 + st.idx * 0.5) % 1) < 0.5 ? [0, 1, 1] : [0, 0, 0.9]},
  {id: 'snow', group: 'Christmas', name: 'Snowfall', g: 'linear-gradient(90deg,#6f8cff,#e8f0ff,#9fb6ff,#fff,#6f8cff)',
    fn: (t, k, st) => {
      if(!st.next || t > st.next){ st.target = Math.random() < 0.25 ? 1 : 0.35 + Math.random() * 0.3; st.next = t + (0.2 + Math.random() * 0.6) / k; }
      st.v = (st.v ?? 0.5) + (st.target - (st.v ?? 0.5)) * 0.2;
      return [215, 0.12 + (1 - st.v) * 0.35, st.v];
    }},
  {id: 'fireside', group: 'Christmas', name: 'Fireside', g: 'linear-gradient(90deg,#c81800,#ff5a00,#ffb000,#ff5a00,#c81800)',
    fn: (t, k, st) => flicker(st, t, k * 1.3, 16, 8, 1)},
];
const FX_MAP = Object.fromEntries(FX_LIST.map(f => [f.id, f]));
const FX = {name: null, timer: null, start: 0, st: {}, last: {}, pend: {}, busy: {}, targets: [], lastPreview: 0};
let fxSpeed = ls.get('home.fx.speed', 50), fxBright = ls.get('home.fx.bright', 100);
const fxLights = () => ls.get('home.fx.lights', {});
const fxWants = k => fxLights()[k] !== false;
// Music: the tablet's microphone
let fxAudio = null; const fxMic = {level: 0, avg: 0.02, beat: 0};
async function fxStartMic(){
  const stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: false, noiseSuppression: false, autoGainControl: false}});
  const ctx = new (window.AudioContext || window.webkitAudioContext)(), an = ctx.createAnalyser(); an.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(an);
  fxAudio = {stream, ctx, an, buf: new Float32Array(an.fftSize)};
}
function fxStopMic(){ if(!fxAudio) return; fxAudio.stream.getTracks().forEach(tr => tr.stop()); try{ fxAudio.ctx.close(); }catch(e){} fxAudio = null; }
function fxReadMic(t){
  if(!fxAudio) return;
  fxAudio.an.getFloatTimeDomainData(fxAudio.buf);
  let s2 = 0; for(const x of fxAudio.buf) s2 += x * x;
  fxMic.level = Math.sqrt(s2 / fxAudio.buf.length);
  fxMic.avg = fxMic.avg * 0.96 + fxMic.level * 0.04;
  if(fxMic.level > fxMic.avg * 1.7 && t - (fxMic.beatAt || 0) > 0.2){ fxMic.beatAt = t; fxMic.beat++; }
}
async function startFx(id){
  const targets = Object.keys(links).filter(k => links[k].on && fxWants(k));
  if(!targets.length){ toast(Object.keys(links).some(k => links[k].on) ? 'Pick at least one light to run it on' : 'Connect your lights first', true); return; }
  if(FX.name) stopFx(true);
  if(id === 'music'){
    try{ await fxStartMic(); }catch(e){ toast('Music needs the microphone. Allow it for this site in Chrome and try again.', true); return; }
  }
  clearScene(); setFollow(false);
  FX.name = id; FX.start = performance.now(); FX.st = {}; FX.last = {}; FX.pend = {}; FX.targets = targets;
  targets.forEach((k, i) => {
    const [hh, sat, v] = rgbToHsv(...hexToRgb(lookMid(L[k].look)));
    FX.st[k] = {idx: i, base: [hh, sat, Math.max(v, 0.6)]};
    if(!L[k].on){ L[k].on = true; save(k); render(k); }
    links[k].send(powerCmd(k, true));
    if(k === 'strip') links.strip.send(STRIP.bright(100));
  });
  clearInterval(FX.timer); FX.timer = setInterval(fxTick, 70);
  renderFx(); renderHomeTiles();
}
// silent: something else is about to set the lights, so don't put the old colours back
function stopFx(silent){
  if(!FX.name) return;
  clearInterval(FX.timer); FX.timer = null;
  const was = FX.targets; FX.name = null; FX.pend = {};
  fxStopMic(); renderFx(); renderHomeTiles();
  for(const k of was){
    render(k);
    if(!silent && links[k].on && L[k].on){ pushLook(k); if(k === 'strip') links.strip.send(STRIP.bright(L.strip.bright)); }
  }
}
function fxCmd(k, hh, s, v){
  if(k === 'curtain') return CURTAIN.colour(hh, s, v);
  if(k === 'usb'){ const [h2, s2] = rgbToHsv(...hexToRgb(usbFix(hsvToHex(hh, s, 1)))); return usbColour(h2, s2, v); }
  const rgb = stripRgb(hsvToHex(hh, s, v)), m = stripMethod(), n = segCount();
  return m.segs ? m.fn(rgb, maskBytes(Array.from({length: n}, (_, i) => i), n)) : m.fn(rgb);
}
async function fxPump(k){
  FX.busy[k] = true;
  while(FX.pend[k]){ const c = FX.pend[k]; FX.pend[k] = null; await links[k].send(c); }
  FX.busy[k] = false;
}
function fxTick(){
  const fx = FX_MAP[FX.name]; if(!fx){ stopFx(true); return; }
  const now = performance.now(), t = (now - FX.start) / 1000, sp = 0.2 + (fxSpeed / 100) * 2.8;
  if(FX.name === 'music') fxReadMic(t);
  const preview = now - FX.lastPreview > 200; if(preview) FX.lastPreview = now;
  let live = 0;
  for(const k of FX.targets){
    if(!links[k].on) continue; live++;
    const st = FX.st[k], off = fx.spread ? st.idx * 1.4 / sp : 0;
    const [hh, s, v0] = fx.fn(t + off, sp, st), v = clamp(v0, 0, 1) * fxBright / 100;
    if(preview) fxPreview(k, hsvToHex(hh, s, Math.max(v, 0.08)));
    const key = `${Math.round(hh)},${Math.round(s * 100)},${Math.round(v * 100)}`;
    if(FX.last[k] === key) continue;
    FX.last[k] = key; FX.pend[k] = fxCmd(k, hh, s, v);
    if(!FX.busy[k]) fxPump(k);
  }
  if(!live) stopFx(true);
}
// the light cards show what the effect is doing
function fxPreview(k, hex){
  const c = cards[k]; if(!c) return;
  c.el.style.setProperty('--dc', hex);
  if(k === 'curtain') $$('.cell', c.grid).forEach(d => d.style.setProperty('--c', hex));
  else { Array.from(c.bar.children).forEach(d => d.style.setProperty('--c', hex)); c.wash.style.setProperty('--wash', hex); }
  c.stext.textContent = 'Effect · ' + FX_MAP[FX.name].name;
}
function buildFx(){
  const grid = $('#fxGrid'); grid.innerHTML = '';
  let group = null;
  for(const fx of FX_LIST){
    if((fx.group || '') !== group){ group = fx.group || ''; if(group) grid.appendChild(h('div', {class: 'secLabel fxHead'}, group)); }
    const i = h('i'); i.style.setProperty('--g', fx.g);
    const b = h('button', {class: 'scene fxTile', onclick: () => FX.name === fx.id ? stopFx(false) : startFx(fx.id)}, i, h('b', null, fx.name));
    b.dataset.fx = fx.id; grid.appendChild(b);
  }
  const chips = $('#fxOn'); chips.innerHTML = '';
  for(const k of Object.keys(links)){
    const b = h('button', {class: 'lchip'}, h('i'), links[k].label);
    b.dataset.k = k;
    b.onclick = () => {
      const m = Object.assign({}, fxLights()); m[k] = !fxWants(k); ls.set('home.fx.lights', m); renderFx();
      if(FX.name){ const id = FX.name; stopFx(false); if(Object.keys(links).some(x => links[x].on && fxWants(x))) startFx(id); }
    };
    chips.appendChild(b);
  }
  const bindRange = (sel, get, set, fmt) => {
    const r = $(sel + ' input'), fill = $(sel + ' .fill'), out = $(sel + ' .pct');
    const show = () => { r.value = get(); fill.style.width = ((get() - r.min) / (r.max - r.min) * 100) + '%'; out.textContent = fmt(get()); };
    r.addEventListener('input', () => { set(+r.value); show(); }); show();
  };
  bindRange('#fxSpeedR', () => fxSpeed, v => {
    // keep the animation's position continuous when the speed changes
    const now = performance.now(), kOld = 0.2 + (fxSpeed / 100) * 2.8, kNew = 0.2 + (v / 100) * 2.8;
    if(FX.name) FX.start = now - (now - FX.start) * kOld / kNew;
    fxSpeed = v; ls.set('home.fx.speed', v);
  }, v => v < 25 ? 'Slow' : v < 70 ? 'Medium' : 'Fast');
  bindRange('#fxBrightR', () => fxBright, v => { fxBright = v; ls.set('home.fx.bright', v); }, v => v + '%');
  $('#fxStop').onclick = () => stopFx(false);
  renderFx();
}
function renderFx(){
  $$('.fxTile').forEach(b => b.classList.toggle('on', b.dataset.fx === FX.name));
  $$('#fxOn .lchip').forEach(b => { b.classList.toggle('on', fxWants(b.dataset.k)); b.classList.toggle('off', !links[b.dataset.k].on); });
  $('#fxStop').hidden = !FX.name;
  $('#lTabs [data-t=effects]').classList.toggle('live', !!FX.name);
}
function showLightsTab(t){
  ls.set('home.lightsTab', t);
  $$('#lTabs button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  $('#scenesPane').hidden = t !== 'scenes'; $('#fxPane').hidden = t !== 'effects';
}

// =====================================================================
// Alexa (Voice Monkey v3: /trigger fires a Routine Trigger, /announce speaks)
// =====================================================================
const AX_ICONS = {
  bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V17h5v-1.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>',
  tv: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>',
  heat: '<path d="M14 14.8V4a2 2 0 1 0-4 0v10.8a4 4 0 1 0 4 0z"/><path d="M12 9v7"/>',
  fan: '<circle cx="12" cy="12" r="2"/><path d="M12 10c0-4 1-7 4-7 2 0 3 2 2 4l-4 4M14 12c4 0 7 1 7 4 0 2-2 3-4 2l-4-4M12 14c0 4-1 7-4 7-2 0-3-2-2-4l4-4M10 12c-4 0-7-1-7-4 0-2 2-3 4-2l4 4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  speak: '<path d="M3 10v4h4l5 4V6L7 10z"/><path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"/>',
  food: '<path d="M4 3v8a3 3 0 0 0 6 0V3M7 3v18M17 3c-2 0-3 3-3 7h3v11"/>',
  coffee: '<path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 11h1.5a2.5 2.5 0 0 1 0 5H17M8 3v3M12 3v3"/>',
  plug: '<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4"/>',
  home: '<path d="M3 11 12 3l9 8M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>',
};
const axSvg = k => `<svg viewBox="0 0 24 24">${AX_ICONS[k] || AX_ICONS.home}</svg>`;
const vmToken = () => ls.get('home.vm.token', '');
let axButtons = ls.get('home.vm.buttons', null) || (DEMO ? [
  {label: 'Heating on', icon: 'heat', kind: 'trigger', device: 'demo'}, {label: 'Movie time', icon: 'tv', kind: 'trigger', device: 'demo', scene: 'movie'},
  {label: 'Main lights off', icon: 'bulb', kind: 'trigger', device: 'demo'}, {label: 'Dinner\'s ready', icon: 'food', kind: 'announce', device: 'demo', speech: 'Dinner is ready!'},
  {label: 'Lock up', icon: 'lock', kind: 'trigger', device: 'demo'},
] : []);
const VM_ERRORS = {INVALID_TOKEN: 'Voice Monkey didn\'t accept the API token', UNAUTHORIZED: 'Add your Voice Monkey API token in Settings',
  DEVICE_NOT_FOUND: 'Voice Monkey doesn\'t have that device ID', THROTTLED: 'Voice Monkey is rate-limiting. Try again shortly',
  MONTHLY_QUOTA_EXCEEDED: 'This month\'s Voice Monkey allowance is used up', ALEXA_TRIGGER_FAILED: 'Alexa didn\'t respond. Try again'};
async function vmCall(b){
  if(DEMO){ await sleep(500); return; }
  if(!vmToken()) throw new Error(VM_ERRORS.UNAUTHORIZED);
  const q = {token: vmToken(), device: b.device}; if(b.kind === 'announce') q.speech = b.speech || b.label;
  let r;
  // A plain GET, so no preflight. If the reply can't be read (CORS), the call was still made.
  try{ r = await fetch(`https://api-v3.voicemonkey.io/${b.kind === 'announce' ? 'announce' : 'trigger'}?` + new URLSearchParams(q), {cache: 'no-store'}); }
  catch(e){ if(navigator.onLine) return; throw new Error('No internet connection'); }
  const j = await r.json().catch(() => null);
  if(!r.ok || (j && j.success === false)) throw new Error((j && VM_ERRORS[j.error]) || (j && j.error) || 'Voice Monkey error ' + r.status);
}
// What a button does, in a few words, for the Alexa page.
function axDesc(b){
  const parts = [];
  if(b.device) parts.push(b.kind === 'announce' ? `Says “${b.speech || b.label}”` : 'Runs a routine');
  const act = axAction(b.scene);
  if(act){
    const mins = +b.delay || 0, what = SCENES.some(x => x.id === b.scene) ? act.name + ' scene' : act.name;
    parts.push((parts.length ? 'then ' : '') + what + (mins ? ` in ${mins} min` : ''));
  }
  const t = parts.join(', ');
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Nothing set yet';
}
function renderAlexa(){
  const box = $('#alexa'); box.innerHTML = '';
  if(!axButtons.length){
    box.appendChild(h('div', {class: 'axEmpty'}, 'No Alexa buttons yet. Tap ', h('b', null, 'Edit buttons'), ' to add ones that run your Alexa routines, make announcements or set the lights.'));
  }
  axButtons.forEach(b => {
    const sub = h('small', null, axDesc(b));
    const el = h('button', {class: 'axc'}, h('span', {class: 'ring', html: axSvg(b.icon)}), h('b', null, b.label), sub);
    el.onclick = async () => {
      if(el.classList.contains('busy')) return;
      el.classList.remove('done', 'fail'); el.classList.add('busy');
      let ok = true, msg = [];
      if(b.device){
        try{ await vmCall(b); msg.push(b.kind === 'announce' ? 'Alexa announcing' : 'Alexa routine sent'); }
        catch(e){ ok = false; toast(e.message, true); }
      }
      // The light part runs even if Alexa failed, so the lights still do their bit.
      const act = axAction(b.scene);
      if(act){
        const mins = +b.delay || 0;
        clearTimeout(axTimers[b.label]);
        if(mins){ axTimers[b.label] = setTimeout(act.run, mins * 60000); msg.push(`${act.done} in ${mins} min`); }
        else{ act.run(); msg.push(act.done); }
      }
      el.classList.add(ok ? 'done' : 'fail');
      if(ok && msg.length){ const t = msg.join(', '); toast(t.charAt(0).toUpperCase() + t.slice(1)); }
      sub.textContent = ok ? 'Sent ✓' : 'Didn’t go through';
      el.classList.remove('busy'); setTimeout(() => { el.classList.remove('done', 'fail'); sub.textContent = axDesc(b); }, 1800);
    };
    box.appendChild(el);
  });
  const t = $('#tAlexa');
  if(t) t.textContent = axButtons.length ? `${axButtons.length} button${axButtons.length === 1 ? '' : 's'}` : 'Set up buttons';
  renderAxList();
}
let axEditing = -1, axIcon = 'bulb';
const axTimers = {};
const LIGHT_ACTIONS = [['all:on', 'All lights on'], ['all:off', 'All lights off'], ['curtain:on', 'Curtain on'], ['curtain:off', 'Curtain off'], ['strip:on', 'Strip on'], ['strip:off', 'Strip off'],
  ['usb:on', usbName() + ' on'], ['usb:off', usbName() + ' off']];
// A button's light part: a scene id, or 'curtain:on' style for one light.
function axAction(id){
  if(!id) return null;
  const sc = SCENES.find(x => x.id === id);
  if(sc) return {name: sc.name, done: 'lights set to ' + sc.name, run: () => runScene(sc)};
  const la = LIGHT_ACTIONS.find(([k]) => k === id); if(!la) return null;
  const [key, state] = id.split(':');
  if(key === 'all') return {name: la[1], done: la[1].toLowerCase().replace(' on', ' switched on').replace(' off', ' switched off'), run: () => allPower(state === 'on')};
  return {name: la[1], done: la[1].toLowerCase().replace(' on', ' switched on').replace(' off', ' switched off'), run: () => { if(!needLink(key)) return; clearScene(); setPower(key, state === 'on'); }};
}
function saveAx(){ ls.set('home.vm.buttons', axButtons); renderAlexa(); }
function renderAxList(){
  const list = $('#axList'); if(!list) return; list.innerHTML = '';
  axButtons.forEach((b, i) => {
    const up = h('button', {'aria-label': 'Move up'}, '↑'), ed = h('button', {'aria-label': 'Edit'}, '✎'), del = h('button', {'aria-label': 'Delete'}, '✕');
    up.disabled = i === 0;
    up.onclick = () => { [axButtons[i - 1], axButtons[i]] = [axButtons[i], axButtons[i - 1]]; saveAx(); };
    ed.onclick = () => axEdit(i);
    del.onclick = () => { axButtons.splice(i, 1); if(axEditing === i) axReset(); saveAx(); };
    list.appendChild(h('div', {class: 'axItem'}, h('span', {class: 'ring', html: axSvg(b.icon)}),
      h('div', null, h('div', null, b.label), h('small', null, axSummary(b))),
      up, ed, del));
  });
}
function axSummary(b){
  const parts = [];
  if(b.device) parts.push((b.kind === 'announce' ? 'Says “' + (b.speech || b.label) + '”' : 'Routine') + ' · ' + b.device);
  const act = axAction(b.scene);
  if(act) parts.push((b.device ? 'then ' : 'Lights: ') + act.name + (+b.delay ? ` after ${b.delay} min` : ''));
  return parts.join(' · ');
}
function axFormValue(){
  return {label: $('#axLabel').value.trim(), icon: axIcon, kind: $('#axKind').value, device: $('#axDevice').value.trim(), speech: $('#axSpeech').value.trim(),
    scene: $('#axScene').value, delay: $('#axScene').value ? +$('#axDelay').value : 0};
}
function axCheck(b){
  if(!b.label){ toast('Give the button a name', true); return false; }
  if(!b.device && !b.scene){ toast('Paste the device ID from Voice Monkey, or pick a lights scene', true); return false; }
  if(b.kind === 'announce' && !b.device){ toast('Paste the Speaker ID from Voice Monkey', true); return false; }
  if(b.kind === 'announce' && !b.speech){ toast('Add what Alexa should say', true); return false; }
  return true;
}
function axKindChanged(){
  const ann = $('#axKind').value === 'announce';
  $('#axSpeech').hidden = !ann;
  $('#axDevice').placeholder = ann ? 'Speaker ID from Voice Monkey' : 'Routine Trigger ID from Voice Monkey';
}
function renderAxIcons(){
  const box = $('#axIcons'); box.innerHTML = '';
  for(const k of Object.keys(AX_ICONS)){
    const b = h('button', {type: 'button', class: k === axIcon ? 'on' : '', html: axSvg(k), 'aria-label': k});
    b.onclick = () => { axIcon = k; renderAxIcons(); };
    box.appendChild(b);
  }
}
function axEdit(i){
  const b = axButtons[i]; axEditing = i;
  $('#axLabel').value = b.label; $('#axKind').value = b.kind; $('#axDevice').value = b.device; $('#axSpeech').value = b.speech || '';
  $('#axScene').value = b.scene || ''; $('#axDelay').value = String(b.delay || 0); $('#axDelay').hidden = !b.scene;
  axIcon = b.icon; renderAxIcons(); axKindChanged();
  $('#axAdd').textContent = 'Save button'; $('#axCancel').hidden = false; $('#axLabel').focus();
}
function axReset(){
  axEditing = -1; ['#axLabel', '#axDevice', '#axSpeech'].forEach(s => $(s).value = ''); $('#axKind').value = 'trigger';
  $('#axScene').value = ''; $('#axDelay').value = '0'; $('#axDelay').hidden = true;
  axIcon = 'bulb'; renderAxIcons(); axKindChanged(); $('#axAdd').textContent = 'Add button'; $('#axCancel').hidden = true;
}

// Goodnight: run the Alexa routine now, turn the lights off after a delay.
const GN = {until: ls.get('home.gn.until', 0)};
async function goodnight(){
  if(GN.until > Date.now()){ GN.until = 0; ls.set('home.gn.until', 0); renderGn(); toast('Goodnight cancelled, so the lights stay on'); return; }
  const id = ls.get('home.gn.device', ''), mins = +ls.get('home.gn.mins', 5);
  GN.until = Date.now() + mins * 60000; ls.set('home.gn.until', GN.until); renderGn();
  if(id){
    try{ await vmCall({kind: 'trigger', device: id}); toast(`Goodnight! Alexa's running your routine, and the lights go off in ${mins} minutes.`); }
    catch(e){ toast(e.message, true); }
  }else toast(`Lights off in ${mins} minutes. Add your Alexa Goodnight trigger in Settings to run that too.`);
}
function gnTick(){
  if(!GN.until) return;
  if(Date.now() < GN.until){ renderGn(); return; }
  GN.until = 0; ls.set('home.gn.until', 0); renderGn();
  stopFx(true); clearScene(); setFollow(false);
  const missed = Object.keys(links).filter(k => !links[k].on);
  Object.keys(links).forEach(k => setPower(k, false));
  if(missed.length) toast(`Couldn't reach the ${missed.map(k => links[k].label.toLowerCase()).join(' or ')} to switch it off`, true);
  if(!calMode()){ go('home'); showAmbient(); }
}
function renderGn(){
  const on = GN.until > Date.now(), b = $('#gnBtn');
  b.classList.toggle('armed', on);
  $('#gnText').textContent = on ? 'Lights off in ' + fmtMs(GN.until - Date.now()) : 'Goodnight';
  $('#gnSub').textContent = on ? '· tap to cancel' : '';
}

// =====================================================================
// Views
// =====================================================================
const VIEWS = ['home', 'lights', 'music', 'calendar', 'alexa'];
let view = null;
const calMode = () => ls.get('home.calMode', false);
const homeView = () => calMode() ? 'calendar' : 'home';
function go(v){
  if(!VIEWS.includes(v)) v = 'home';
  if(v === 'calendar') ls.set('home.calMode', true);
  view = v; document.body.dataset.view = v;
  $$('.view').forEach(s => { s.hidden = s.dataset.view !== v; });
  $$('.backLbl').forEach(e => { e.textContent = calMode() ? 'Calendar' : 'Home'; });
  if(v === 'lights') requestAnimationFrame(sizeCurtain);
  if(v === 'music') musicEnter();
  if(v === 'calendar') calEnter();
  closeSheets(); bump();
}
document.addEventListener('click', e => {
  const g = e.target.closest('[data-go]'); if(g){ go(g.dataset.go); return; }
  if(e.target.closest('[data-back]')){ go(homeView()); return; }
  if(e.target.closest('[data-settings]')) openSheet('settings');
});

// =====================================================================
// Clock + weather
// =====================================================================
let lastMinute = -1;
function clockParts(d = new Date()){
  const h24 = ls.get('home.h24', true), hr = d.getHours();
  return {hh: h24 ? String(hr).padStart(2, '0') : String((hr % 12) || 12), mm: String(d.getMinutes()).padStart(2, '0'), ampm: h24 ? '' : (hr < 12 ? 'am' : 'pm'), hr};
}
const isNight = (d = new Date()) => d.getHours() >= 22 || d.getHours() < 7;
function tick(force){
  const d = new Date();
  gnTick(); progress();
  if(!force && d.getMinutes() === lastMinute) return;
  lastMinute = d.getMinutes();
  const p = clockParts(d), t = p.hh + ':' + p.mm + (p.ampm ? ' ' + p.ampm : '');
  $('#hh').textContent = p.hh; $('#mm').textContent = p.mm; $('#ampm').textContent = p.ampm;
  $('#aClock').textContent = $('#aSmallClock').textContent = $('#calClock').textContent = t;
  $('#date').textContent = $('#aDate').textContent = d.toLocaleDateString('en-GB', {weekday: 'long', day: 'numeric', month: 'long'});
  const g = p.hr < 5 ? 'Good night' : p.hr < 12 ? 'Good morning' : p.hr < 18 ? 'Good afternoon' : p.hr < 22 ? 'Good evening' : 'Good night';
  const name = ls.get('home.name', 'Kyle').trim();
  $('#greet').textContent = name ? g + ',' : g; $('#gName').textContent = name;
  $('#ambient').classList.toggle('night', isNight(d));
  if($('#ambient').classList.contains('show')) nudgeAmbient();
  if(d.getHours() === 0 && d.getMinutes() === 0 && CAL.loaded) calLoad();
  renderCalTile();
}
const WX = {
  sun: '<svg class="wx" viewBox="0 0 24 24"><g class="sun"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/></g></svg>',
  moon: '<svg class="wx" viewBox="0 0 24 24"><path class="moon" d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>',
  partly: '<svg class="wx" viewBox="0 0 24 24"><g class="sun"><circle cx="9" cy="9" r="3"/><path d="M9 3v1.2M3 9h1.2M4.8 4.8l.9.9M13.2 4.8l-.9.9"/></g><path d="M8 20h9a3.5 3.5 0 0 0 .4-7A5 5 0 0 0 8 13.5 3.3 3.3 0 0 0 8 20z"/></svg>',
  partlyNight: '<svg class="wx" viewBox="0 0 24 24"><path class="moon" d="M13 6.5A4.5 4.5 0 1 1 7 3a3.6 3.6 0 0 0 6 3.5z"/><path d="M8 20h9a3.5 3.5 0 0 0 .4-7A5 5 0 0 0 8 13.5 3.3 3.3 0 0 0 8 20z"/></svg>',
  cloud: '<svg class="wx" viewBox="0 0 24 24"><path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 11a3.5 3.5 0 0 0 1 7z"/></svg>',
  rain: '<svg class="wx" viewBox="0 0 24 24"><path d="M7 15h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 8a3.5 3.5 0 0 0 1 7z"/><path class="drop" d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/></svg>',
  snow: '<svg class="wx" viewBox="0 0 24 24"><path d="M7 15h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 8a3.5 3.5 0 0 0 1 7z"/><path class="drop" d="M8 19h.01M12 18h.01M16 19h.01M10 21.5h.01M14 21.5h.01"/></svg>',
  storm: '<svg class="wx" viewBox="0 0 24 24"><path d="M7 15h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 8a3.5 3.5 0 0 0 1 7z"/><path class="bolt" d="M12.5 15 10 19h4l-2.5 4"/></svg>',
  fog: '<svg class="wx" viewBox="0 0 24 24"><path d="M4 9h16M3 13h18M5 17h14"/></svg>',
};
function wxInfo(code, day){
  if(code === 0) return [day ? 'sun' : 'moon', 'Clear'];
  if(code === 1) return [day ? 'sun' : 'moon', 'Mostly clear'];
  if(code === 2) return [day ? 'partly' : 'partlyNight', 'Partly cloudy'];
  if(code === 3) return ['cloud', 'Cloudy'];
  if(code === 45 || code === 48) return ['fog', 'Fog'];
  if(code >= 51 && code <= 57) return ['rain', 'Drizzle'];
  if(code >= 61 && code <= 67) return ['rain', code >= 65 ? 'Heavy rain' : 'Rain'];
  if(code >= 71 && code <= 77) return ['snow', 'Snow'];
  if(code >= 80 && code <= 82) return ['rain', 'Showers'];
  if(code === 85 || code === 86) return ['snow', 'Snow showers'];
  if(code >= 95) return ['storm', 'Thunderstorms'];
  return ['cloud', ''];
}
let wxTimer = null;
async function loadWeather(){
  clearTimeout(wxTimer); wxTimer = setTimeout(loadWeather, 15 * 60000);
  if(DEMO){ renderWeather(demoWeather()); return; }
  const loc = ls.get('home.loc', null);
  if(!loc){ askLocation(true); return; }
  const u = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
    latitude: loc.lat, longitude: loc.lon, timezone: 'auto', forecast_days: 2,
    current: 'temperature_2m,apparent_temperature,weather_code,is_day',
    hourly: 'temperature_2m,weather_code,precipitation_probability,is_day',
    daily: 'temperature_2m_max,temperature_2m_min',
  });
  try{
    const r = await fetch(u); if(!r.ok) throw new Error('Weather ' + r.status);
    const j = await r.json(); ls.set('home.wx', j); renderWeather(j);
  }catch(e){
    const cached = ls.get('home.wx', null);
    if(cached) renderWeather(cached, true); else $('#wMeta').textContent = 'Weather unavailable';
  }
}
function renderWeather(j, stale){
  const loc = ls.get('home.loc', {name: ''}) || {name: ''}, cur = j.current;
  const [icon, desc] = wxInfo(cur.weather_code, cur.is_day);
  const temp = Math.round(cur.temperature_2m) + '°';
  $('#wIcon').innerHTML = WX[icon]; $('#wTemp').textContent = temp;
  $('#wDesc').textContent = desc + (loc.name ? ' · ' + loc.name : '');
  $('#wMeta').textContent = `H ${Math.round(j.daily.temperature_2m_max[0])}°  L ${Math.round(j.daily.temperature_2m_min[0])}°  ·  Feels ${Math.round(cur.apparent_temperature)}°` + (stale ? '  ·  offline' : '');
  $('#calWx').innerHTML = WX[icon]; $('#calWx').appendChild(h('b', null, temp)); $('#calWx').appendChild(h('span', null, desc));
  $('#wSetup').hidden = true;
  const key = cur.time.slice(0, 13) + ':00', i0 = j.hourly.time.indexOf(key), h24 = ls.get('home.h24', true), box = $('#wHours');
  box.innerHTML = '';
  if(i0 < 0){ box.hidden = true; return; }
  for(let i = i0 + 1; i <= i0 + 6 && i < j.hourly.time.length; i++){
    const hr = +j.hourly.time[i].slice(11, 13), [ic] = wxInfo(j.hourly.weather_code[i], j.hourly.is_day[i]), rain = j.hourly.precipitation_probability[i];
    box.appendChild(h('div', {class: 'hr', html: `<span>${h24 ? String(hr).padStart(2, '0') : ((hr % 12) || 12) + (hr < 12 ? 'a' : 'p')}</span>${WX[ic]}<b>${Math.round(j.hourly.temperature_2m[i])}°</b><span class="rain">${rain >= 30 ? rain + '%' : ''}</span>`}));
  }
  box.hidden = false;
}
function askLocation(auto){
  if(!navigator.geolocation){ showLocSetup(); return; }
  if(auto && ls.get('home.locAsked', false)){ showLocSetup(); return; }
  ls.set('home.locAsked', true);
  navigator.geolocation.getCurrentPosition(p => {
    ls.set('home.loc', {lat: +p.coords.latitude.toFixed(3), lon: +p.coords.longitude.toFixed(3), name: ''});
    renderLocNow(); loadWeather();
  }, () => { showLocSetup(); if(!auto) toast('Location is blocked. Search for your town instead.', true); }, {timeout: 20000, maximumAge: 6 * 3600e3});
}
function showLocSetup(){
  if(ls.get('home.wx', null)) return;
  $('#wSetup').hidden = false; $('#wIcon').innerHTML = WX.partly; $('#wTemp').textContent = '';
  $('#wDesc').textContent = 'Weather'; $('#wMeta').textContent = 'Add your location for the forecast'; $('#wHours').hidden = true;
}
function renderLocNow(){ const l = ls.get('home.loc', null); $('#locNow').textContent = l ? `Showing weather for ${l.name || 'this tablet\'s location'}.` : ''; }
async function searchCity(){
  const q = $('#cityIn').value.trim(); if(!q) return;
  const box = $('#cityResults'); box.innerHTML = '<p class="hint">Searching…</p>';
  try{
    const r = await fetch('https://geocoding-api.open-meteo.com/v1/search?' + new URLSearchParams({name: q, count: 6, language: 'en'}));
    const j = await r.json(); box.innerHTML = '';
    if(!j.results || !j.results.length){ box.innerHTML = '<p class="hint">No places found.</p>'; return; }
    for(const p of j.results){
      box.appendChild(h('button', {onclick: () => {
        ls.set('home.loc', {lat: p.latitude, lon: p.longitude, name: p.name}); box.innerHTML = ''; $('#cityIn').value = '';
        renderLocNow(); loadWeather(); toast('Weather set to ' + p.name);
      }}, h('div', null, p.name), h('small', null, [p.admin1, p.country].filter(Boolean).join(', '))));
    }
  }catch(e){ box.innerHTML = '<p class="hint">Couldn\'t search right now.</p>'; }
}

// =====================================================================
// Spotify (Web API with PKCE; your own app's Client ID; Premium)
// =====================================================================
const SP_SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private playlist-read-collaborative user-library-read user-read-recently-played';
const SP = {tok: ls.get('home.sp.tok', null), state: null, at: 0, timer: null, backoff: 0, trackId: null, palette: null, artUrl: null, err: null};
const spClient = () => ls.get('home.sp.client', '');
const spRedirect = () => location.origin + location.pathname;
const spSigned = () => DEMO || !!SP.tok;
const spHasLib = () => DEMO || !!(SP.tok && /playlist-read-private/.test(SP.tok.scope || ''));
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function spLogin(){
  const id = spClient(); if(!id){ openSheet('settings'); setTimeout(() => $('#spSec').scrollIntoView({behavior: 'smooth'}), 150); return; }
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
  ls.set('home.sp.verifier', verifier); ls.set('home.sp.state', state);
  location.href = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
    client_id: id, response_type: 'code', redirect_uri: spRedirect(), scope: SP_SCOPES,
    code_challenge_method: 'S256', code_challenge: challenge, state,
  });
}
async function spReturn(){
  const q = new URLSearchParams(location.search);
  if(!q.has('code') && !q.has('error')) return;
  const keep = new URLSearchParams(location.search); ['code', 'state', 'error'].forEach(k => keep.delete(k));
  history.replaceState(null, '', location.pathname + (String(keep) ? '?' + keep : ''));
  if(q.has('error')){ toast('Spotify sign-in was cancelled', true); return; }
  if(q.get('state') !== ls.get('home.sp.state', null)){ toast('Spotify sign-in didn\'t match. Try again.', true); return; }
  try{
    await spToken({grant_type: 'authorization_code', code: q.get('code'), redirect_uri: spRedirect(), code_verifier: ls.get('home.sp.verifier', '')});
    ls.del('home.sp.verifier'); ls.del('home.sp.state');
    toast('Spotify connected');
    if(ls.get('home.sp.return', null) === 'music'){ ls.del('home.sp.return'); go('music'); }
  }catch(e){ toast(e.message, true); }
}
async function spToken(params){
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams(Object.assign({client_id: spClient()}, params)),
  });
  const j = await r.json().catch(() => ({}));
  if(!r.ok){
    if(j.error === 'invalid_grant' && params.grant_type === 'refresh_token') spLogout(true);
    throw new Error(j.error_description || j.error || 'Spotify sign-in failed');
  }
  SP.tok = {access: j.access_token, refresh: j.refresh_token || (SP.tok && SP.tok.refresh), exp: Date.now() + (j.expires_in - 60) * 1000,
    scope: j.scope || (SP.tok && SP.tok.scope) || ''};
  ls.set('home.sp.tok', SP.tok); renderSpSettings();
  return SP.tok;
}
let spRefreshing = null;
async function spAccess(){
  if(!SP.tok) throw Object.assign(new Error('Spotify isn\'t connected'), {status: 0});
  if(Date.now() < SP.tok.exp) return SP.tok.access;
  if(!spRefreshing) spRefreshing = spToken({grant_type: 'refresh_token', refresh_token: SP.tok.refresh}).finally(() => { spRefreshing = null; });
  return (await spRefreshing).access;
}
async function sp(method, path, body, retried){
  const tok = await spAccess();
  const r = await fetch('https://api.spotify.com/v1' + path, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: Object.assign({Authorization: 'Bearer ' + tok}, body ? {'Content-Type': 'application/json'} : {}),
  });
  if(r.status === 401 && !retried){ SP.tok.exp = 0; return sp(method, path, body, true); }
  if(r.status === 429){ SP.backoff = Date.now() + 30000; }
  const text = await r.text(); let j = null; try{ j = text ? JSON.parse(text) : null; }catch(e){}
  if(!r.ok){
    const err = new Error((j && j.error && j.error.message) || 'Spotify error ' + r.status);
    err.status = r.status; err.reason = j && j.error && j.error.reason; throw err;
  }
  return j;
}
function spLogout(expired){
  SP.tok = null; SP.state = null; ls.del('home.sp.tok'); clearTimeout(SP.timer);
  M.lib = null; M.libRaw = null; M.recent = null; renderMusic(); renderSpSettings(); if(view === 'music') musicEnter();
  if(expired) toast('Spotify signed out. Connect it again in Settings.', true);
}
async function spPoll(){
  clearTimeout(SP.timer);
  if(DEMO){ if(!SP.state) SP.state = demoPlayer(); SP.at = SP.at || Date.now(); renderMusic(); return; }
  if(!SP.tok){ renderMusic(); return; }
  if(document.visibilityState !== 'visible'){ SP.timer = setTimeout(spPoll, 30000); return; }
  if(Date.now() < SP.backoff){ SP.timer = setTimeout(spPoll, SP.backoff - Date.now()); return; }
  try{ SP.state = await sp('GET', '/me/player?additional_types=episode'); SP.at = Date.now(); SP.err = null; }
  catch(e){ SP.err = e; if(e.status === 403) SP.state = null; }
  if(SP.state && SP.state.is_playing && SP.state.context) markPlayed(SP.state.context.uri);
  renderMusic();
  const st = SP.state, playing = !!(st && st.is_playing && st.item);
  let next = playing ? 5000 : (view === 'music' ? 8000 : 15000);
  if(playing){ const left = st.item.duration_ms - st.progress_ms; if(left > 0 && left < next) next = left + 700; }
  SP.timer = setTimeout(spPoll, next);
}
const spPos = () => { const s = SP.state; if(!s || !s.item) return 0; return clamp(s.progress_ms + (s.is_playing ? Date.now() - SP.at : 0), 0, s.item.duration_ms); };
function spErr(e){
  if(e.status === 403) toast('Spotify refused. Playback control needs Premium.', true);
  else if(e.status === 404) toast('No active speaker. Pick one to play on.', true);
  else toast(e.message, true);
}
async function spCmd(kind){
  const s = SP.state;
  try{
    if(kind === 'toggle'){
      const was = s && s.is_playing;
      if(s){ s.progress_ms = spPos(); SP.at = Date.now(); s.is_playing = !was; renderMusic(); }
      if(!DEMO){ if(was) await sp('PUT', '/me/player/pause'); else await spPlay(null); }
    }else if(kind === 'shuffle'){
      const on = !(s && s.shuffle_state); if(s) s.shuffle_state = on; renderMusic();
      if(!DEMO) await sp('PUT', '/me/player/shuffle?state=' + on);
    }else if(kind === 'repeat'){
      const order = ['off', 'context', 'track'], next = order[(order.indexOf((s && s.repeat_state) || 'off') + 1) % 3];
      if(s) s.repeat_state = next; renderMusic();
      if(!DEMO) await sp('PUT', '/me/player/repeat?state=' + next);
    }else if(!DEMO) await sp('POST', '/me/player/' + kind);
    setTimeout(spPoll, 500);
  }catch(e){ spErr(e); spPoll(); }
}
// Start playback; if no speaker is active, use the last one or ask which.
let pendingPlay = null;
async function spPlay(body){
  if(DEMO){ toast('Playing (demo)'); return; }
  const path = '/me/player/play';
  try{ await sp('PUT', path, body || undefined); setTimeout(spPoll, 700); }
  catch(e){
    if(e.status === 404 || e.reason === 'NO_ACTIVE_DEVICE'){
      try{
        const devs = ((await sp('GET', '/me/player/devices')) || {}).devices || [];
        const last = ls.get('home.sp.lastDev', ''), pick = devs.find(d => d.id === last) || (devs.length === 1 ? devs[0] : null);
        if(pick){ await sp('PUT', path + '?device_id=' + encodeURIComponent(pick.id), body || undefined); setTimeout(spPoll, 700); return; }
      }catch(_){}
      pendingPlay = body || {}; openSpeakers(); toast('Pick a speaker to play on');
    }else spErr(e);
  }
}
const playContext = (uri, offsetUri) => (markPlayed(uri), spPlay(offsetUri ? {context_uri: uri, offset: {uri: offsetUri}} : {context_uri: uri}));
const playUris = (uris, i = 0) => spPlay({uris, offset: {position: i}});
async function queueTrack(uri, name){
  try{ if(!DEMO) await sp('POST', '/me/player/queue?uri=' + encodeURIComponent(uri)); toast('Added to queue: ' + name); }catch(e){ spErr(e); }
}
const spVolume = throttle(v => { if(!DEMO) sp('PUT', '/me/player/volume?volume_percent=' + v).catch(spErr); }, 350);
async function openSpeakers(){
  openSheet('speakers');
  const list = $('#devList'); list.innerHTML = '<p class="hint">Looking for speakers…</p>';
  let devs = [];
  try{ devs = DEMO ? demoDevices() : ((await sp('GET', '/me/player/devices')) || {}).devices || []; }
  catch(e){ list.innerHTML = ''; list.appendChild(h('p', {class: 'hint'}, e.message)); return; }
  list.innerHTML = devs.length ? '' : '<p class="hint">No speakers found. Open Spotify on a speaker or phone and try again.</p>';
  for(const d of devs){
    list.appendChild(h('button', {class: d.is_active ? 'on' : '', html: devIcon(d.type), onclick: async () => {
      closeSheets(); ls.set('home.sp.lastDev', d.id);
      try{
        if(DEMO){ toast('Playing on ' + d.name); return; }
        if(pendingPlay){ const body = pendingPlay; pendingPlay = null; await sp('PUT', '/me/player/play?device_id=' + encodeURIComponent(d.id), Object.keys(body).length ? body : undefined); }
        else await sp('PUT', '/me/player', {device_ids: [d.id], play: true});
        toast('Playing on ' + d.name); setTimeout(spPoll, 800);
      }catch(e){ spErr(e); }
    }}, h('div', null, h('div', null, d.name), h('small', null, (d.is_active ? 'Playing here · ' : '') + String(d.type || '').toLowerCase()))));
  }
}
function devIcon(type){
  const t = String(type).toLowerCase();
  if(t === 'computer') return '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>';
  if(t === 'smartphone' || t === 'tablet') return '<svg viewBox="0 0 24 24"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></svg>';
  if(t === 'tv') return '<svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="13" rx="2"/><path d="M8 21h8"/></svg>';
  return '<svg viewBox="0 0 24 24"><rect x="5" y="2" width="14" height="20" rx="2"/><circle cx="12" cy="14" r="4"/><path d="M12 6h.01"/></svg>';
}
const PLAY = '<path d="M8 5v14l11-7z"/>', PAUSE = '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>';
const MUSIC_ICON = '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
const imgOf = (imgs) => (imgs && imgs.length ? (imgs.find(i => i.width && i.width <= 320) || imgs[0]).url : '');
const bigImg = (imgs) => (imgs && imgs.length ? imgs[0].url : '');
const artists = t => (t.artists || []).map(a => a.name).join(', ');
// Now playing: landing tile, player bar, ambient screen.
function renderMusic(){
  const s = SP.state, has = !!(s && s.item), playing = has && s.is_playing;
  // landing tile
  $('#tLive').hidden = !playing;
  const ti = $('#tMusicIcon');
  if(has){
    const it = s.item, ep = it.type === 'episode';
    const url = bigImg(ep ? (it.images || (it.show && it.show.images)) : (it.album && it.album.images));
    if(url !== SP.artUrl){ SP.artUrl = url; $('#pArt').src = url; $('#aArt').src = url; readPalette(url); }
    if(!ti.querySelector('img') || ti.querySelector('img').src !== url){ ti.innerHTML = ''; ti.appendChild(h('img', {src: url, alt: ''})); }
    const title = it.name, by = ep ? (it.show && it.show.name) || '' : artists(it);
    $('#tMusic').textContent = (playing ? '' : 'Paused · ') + title;
    $('#pTitle').textContent = title; $('#pArtist').textContent = by;
    $('#aTitle').textContent = title; $('#aArtist').textContent = by;
    $('#pDevName').textContent = s.device ? s.device.name : 'Speakers';
    $('#pPlayIcon').innerHTML = playing ? PAUSE : PLAY;
    $('#pShuffle').classList.toggle('on', !!s.shuffle_state);
    $('#pRepeat').classList.toggle('on', s.repeat_state && s.repeat_state !== 'off');
    $('#pRepeat .one').hidden = s.repeat_state !== 'track';
    const vol = s.device && s.device.supports_volume !== false && s.device.volume_percent != null;
    $('#pVolRow').style.visibility = vol ? 'visible' : 'hidden';
    if(vol && document.activeElement !== $('#pVol') && !volDrag) $('#pVol').value = s.device.volume_percent;
    if(it.id !== SP.trackId){ SP.trackId = it.id; if(follow) setTimeout(followAlbum, 400); }
    $$('.tr').forEach(r => r.classList.toggle('playing', r.dataset.uri === it.uri));
    $$('.li').forEach(r => r.classList.toggle('playing', !!(s.context && r.dataset.uri === s.context.uri)));
  }else{
    if(!ti.querySelector('svg')) ti.innerHTML = MUSIC_ICON;
    $('#tMusic').textContent = !spSigned() ? 'Set up Spotify' : SP.err && SP.err.status === 403 ? 'Spotify needs Premium' : 'Nothing playing';
    $('#pTitle').textContent = spSigned() ? 'Nothing playing' : 'Spotify isn\'t connected';
    $('#pArtist').textContent = spSigned() ? 'Pick something to play' : 'Set it up in Settings';
    $('#pArt').removeAttribute('src');
  }
  $('#player').classList.toggle('empty', !has);
  document.documentElement.style.setProperty('--o3', playing ? '.9' : has ? '.4' : '0');
  progress(); renderAmbient();
}
let seekPreview = null, volDrag = false;
function progress(){
  const s = SP.state; if(!s || !s.item) return;
  const pos = seekPreview != null ? seekPreview : spPos(), dur = s.item.duration_ms, pc = dur ? pos / dur * 100 : 0;
  $('#pBar').style.width = pc + '%'; $('#aBar').style.width = pc + '%';
  $('#pPos').textContent = fmtMs(pos); $('#pDur').textContent = fmtMs(dur);
}
function seekAt(e){ const r = $('#pProg').getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1) * SP.state.item.duration_ms; }

// Album colours: sample the art on a canvas (Spotify's image server allows it).
function artPalette(url){
  return new Promise(res => {
    if(!url){ res(null); return; }
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => {
      try{
        const c = document.createElement('canvas'); c.width = c.height = 32;
        const x = c.getContext('2d'); x.drawImage(img, 0, 0, 32, 32);
        res(paletteFrom(x.getImageData(0, 0, 32, 32).data));
      }catch(e){ res(null); }
    };
    img.onerror = () => res(null);
    img.src = url;
  });
}
function paletteFrom(d){
  const bins = Array.from({length: 18}, () => ({w: 0, r: 0, g: 0, b: 0}));
  for(let i = 0; i < d.length; i += 4){
    const [hh, s, v] = rgbToHsv(d[i], d[i + 1], d[i + 2]);
    const w = s * s * v; if(s < 0.22 || v < 0.18) continue;
    const bin = bins[Math.floor(hh / 20) % 18]; bin.w += w; bin.r += d[i] * w; bin.g += d[i + 1] * w; bin.b += d[i + 2] * w;
  }
  const top = bins.filter(b => b.w > 0).sort((a, b) => b.w - a.w);
  const total = top.reduce((a, b) => a + b.w, 0);
  const pick = top.filter((b, i) => i === 0 || b.w > total * 0.08).slice(0, 3)
    .map(b => { const [hh, s] = rgbToHsv(b.r / b.w, b.g / b.w, b.b / b.w); return hsvToHex(hh, Math.max(s, 0.75), 1); });
  return pick.length ? pick : ['#ffc98a'];
}
async function readPalette(url){
  SP.palette = null; $('#pFollow').hidden = true;
  const p = await artPalette(url);
  if(!p || url !== SP.artUrl) return;
  SP.palette = p; $('#pFollow').hidden = false;
  document.documentElement.style.setProperty('--c3', p[0]);
  if(follow && SP.trackId && SP.followed !== SP.trackId) followAlbum();
}
let follow = ls.get('home.sp.follow', false);
function setFollow(on){ follow = on; ls.set('home.sp.follow', on); $('#pFollow').classList.toggle('on', on); }
function followAlbum(){
  if(!SP.palette || !SP.trackId) return;
  SP.followed = SP.trackId;
  const p = SP.palette, strip = p.length === 1 ? p : [...p, ...p.slice(0, -1).reverse()];
  if(links.curtain.on) applyLight('curtain', {look: p.slice()});
  if(links.strip.on) applyLight('strip', {look: strip});
  if(links.usb.on) applyLight('usb', {look: strip});
}

// ---------- music browser ----------
const M = {stack: [], cur: {type: 'home'}, lib: null, libErr: null, me: null, recent: null, q: ''};
function musicEnter(){
  if(spSigned() && spHasLib() && !M.lib && !M.libLoading) loadLib(); else{ sortLib(); renderLib(); refreshLibOrder(); }
  renderMain();
  spPoll();
}
// Playlists are ordered by when they were last played: the playlists behind the recently played
// songs (any device), plus what this panel has started or seen playing. Never-played ones keep
// Spotify's own order underneath.
let plPlayed = ls.get('home.sp.plPlayed', {});
function markPlayed(uri, t = Date.now()){
  if(!uri || !/:playlist:|:collection/.test(uri)) return;
  if((plPlayed[uri] || 0) > t - 60000) return; // at most one save a minute per playlist
  plPlayed[uri] = t;
  const keep = Object.entries(plPlayed).sort((a, b) => b[1] - a[1]).slice(0, 300); // cap the stored list
  plPlayed = Object.fromEntries(keep); ls.set('home.sp.plPlayed', plPlayed);
}
async function getRecent(force){
  if(!force && M.recent && Date.now() - M.recent.at < 60000) return M.recent.items;
  const j = DEMO ? demoRecent() : await sp('GET', '/me/player/recently-played?limit=50');
  M.recent = {at: Date.now(), items: (j && j.items) || []};
  for(const it of M.recent.items) if(it.context && it.played_at) markPlayed(it.context.uri, Date.parse(it.played_at));
  return M.recent.items;
}
function sortLib(){
  if(!M.libRaw) return false;
  const pos = new Map(M.libRaw.map((p, i) => [p.uri, i]));
  const next = M.libRaw.slice().sort((a, b) => ((plPlayed[b.uri] || 0) - (plPlayed[a.uri] || 0)) || (pos.get(a.uri) - pos.get(b.uri)));
  const changed = !M.lib || next.some((p, i) => p !== M.lib[i]);
  M.lib = next; return changed;
}
async function loadLib(){
  M.libLoading = true;
  try{
    const all = [];
    if(DEMO) all.push(...demoLib().items);
    else{
      let path = '/me/playlists?limit=50';
      for(let i = 0; path && i < 8; i++){ // up to 400 playlists
        const j = await sp('GET', path);
        all.push(...((j && j.items) || []));
        path = j && j.next ? j.next.replace('https://api.spotify.com/v1', '') : null;
      }
    }
    M.libRaw = all.filter(Boolean); M.libErr = null;
    try{ await getRecent(); }catch(e){}
    sortLib();
  }
  catch(e){ M.libErr = e; }
  M.libLoading = false; renderLib();
  if(M.cur.type === 'home') renderMain();
}
// Re-sort when the music screen opens, so a playlist started on a phone moves up.
async function refreshLibOrder(){
  if(!M.libRaw) return;
  try{ await getRecent(); }catch(e){}
  if(sortLib()){ renderLib(); if(M.cur.type === 'home') renderMain(); }
}
const plCount = p => (p.items && p.items.total) ?? (p.tracks && p.tracks.total) ?? null;
function renderLib(){
  const box = $('#libList'); box.innerHTML = '';
  if(!spSigned()){ box.appendChild(h('p', {class: 'note'}, 'Connect Spotify in Settings to see your playlists.')); return; }
  if(!spHasLib()){ box.appendChild(h('p', {class: 'note'}, 'Reconnect Spotify to load your playlists.')); return; }
  box.appendChild(libItem({name: 'Liked Songs', sub: 'Playlist', liked: true, uri: 'liked', onclick: () => openView({type: 'liked'})}));
  if(M.libErr){ box.appendChild(h('p', {class: 'note'}, M.libErr.message)); return; }
  if(!M.lib){ box.appendChild(h('p', {class: 'note'}, 'Loading…')); return; }
  for(const p of M.lib){
    const n = plCount(p);
    box.appendChild(libItem({name: p.name, sub: 'Playlist · ' + ((p.owner && p.owner.display_name) || '') + (n != null ? ` · ${n}` : ''), img: imgOf(p.images), uri: p.uri,
      onclick: () => openView({type: 'playlist', id: p.id, uri: p.uri, name: p.name, img: bigImg(p.images), owner: p.owner && p.owner.display_name, count: n})}));
  }
  renderMusic();
}
function libItem({name, sub, img, liked, uri, onclick}){
  const art = liked ? h('span', {class: 'ph liked', html: '<svg viewBox="0 0 24 24"><path d="M12 21s-7-4.4-9.5-9A5.5 5.5 0 0 1 12 6a5.5 5.5 0 0 1 9.5 6c-2.5 4.6-9.5 9-9.5 9z"/></svg>'})
    : img ? h('img', {src: img, alt: '', loading: 'lazy'}) : h('span', {class: 'ph', html: MUSIC_ICON});
  const b = h('button', {class: 'li', onclick}, art, h('div', null, h('b', null, name), h('small', null, sub)));
  b.dataset.uri = uri || '';
  return b;
}
function openView(v){ M.stack.push(M.cur); M.cur = v; renderMain(); $('#mMain').scrollTop = 0; }
function backView(){ M.cur = M.stack.pop() || {type: 'home'}; renderMain(); }
function mainShell(){
  const main = $('#mMain'); main.innerHTML = ''; main.style.removeProperty('--mh');
  if(M.stack.length && M.cur.type !== 'home') main.appendChild(h('button', {class: 'mBack', 'aria-label': 'Back', onclick: backView, html: '<svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>'}));
  return main;
}
function renderMain(){
  if(!$('#mMain')) return;
  const t = M.cur.type;
  if(!spSigned()){
    const main = mainShell();
    main.appendChild(h('div', {class: 'calNote'}, h('div', {class: 'mh2'}, 'Music'), 'Connect Spotify to browse your playlists, search and play music around the house.',
      h('button', {class: 'btn green', onclick: () => { openSheet('settings'); setTimeout(() => $('#spSec').scrollIntoView({behavior: 'smooth'}), 150); }}, 'Set up Spotify')));
    return;
  }
  if(t === 'home') return renderMusicHome();
  if(t === 'search') return renderSearch();
  if(t === 'playlist') return renderPlaylist();
  if(t === 'album') return renderAlbum();
  if(t === 'liked') return renderLiked();
}
function reconnectBanner(main){
  if(spHasLib()) return;
  main.appendChild(h('div', {class: 'banner'}, h('span', null, 'Reconnect Spotify once so this screen can show your playlists and recently played.'),
    h('button', {class: 'btn sm green', onclick: () => { ls.set('home.sp.return', 'music'); spLogin(); }}, 'Reconnect')));
}
function mcard({img, title, sub, round, onOpen, onPlay}){
  const art = h('div', {class: 'art'}, img ? h('img', {src: img, alt: '', loading: 'lazy'}) : null);
  if(onPlay) art.appendChild(h('span', {class: 'pbtn', html: '<svg viewBox="0 0 24 24">' + PLAY + '</svg>', onclick: e => { e.stopPropagation(); onPlay(); }}));
  return h('button', {class: 'mcard' + (round ? ' round' : ''), onclick: onOpen || onPlay}, art, h('b', null, title), sub ? h('small', null, sub) : null);
}
function trackRow(t, i, {ctx, uris, showArt = true} = {}){
  const art = showArt && t.album ? h('img', {src: imgOf(t.album.images), alt: '', loading: 'lazy'}) : h('span', {class: 'n'}, String(i + 1));
  const q = h('span', {class: 'q', role: 'button', 'aria-label': 'Add to queue', html: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    onclick: e => { e.stopPropagation(); queueTrack(t.uri, t.name); }});
  const row = h('button', {class: 'tr', onclick: () => ctx ? playContext(ctx, t.uri) : playUris(uris || [t.uri], uris ? uris.indexOf(t.uri) : 0)},
    art, h('div', {class: 't'}, h('b', null, t.name), h('small', null, (t.explicit ? 'E · ' : '') + artists(t))),
    h('span', {class: 'al'}, t.album ? t.album.name : ''), h('span', {class: 'd'}, fmtMs(t.duration_ms)), q);
  row.dataset.uri = t.uri;
  return row;
}
async function renderMusicHome(){
  const main = mainShell();
  reconnectBanner(main);
  const g = new Date().getHours();
  main.appendChild(h('div', {class: 'mh2'}, g < 12 ? 'Good morning' : g < 18 ? 'Good afternoon' : 'Good evening'));
  if(spHasLib()){
    const recentBox = h('div', {class: 'cards hscroll'}, h('p', {class: 'note'}, 'Loading…'));
    main.append(h('div', {class: 'mh2'}, 'Recently played'), recentBox);
    try{
      await getRecent();
      if(!recentBox.isConnected) return; // a newer render replaced this one
      recentBox.innerHTML = '';
      const seen = new Set();
      for(const it of M.recent.items){
        const t = it.track; if(!t || seen.has(t.id)) continue; seen.add(t.id);
        recentBox.appendChild(mcard({img: imgOf(t.album && t.album.images), title: t.name, sub: artists(t),
          onPlay: () => it.context && it.context.uri ? playContext(it.context.uri, t.uri) : playUris([t.uri])}));
        if(seen.size >= 14) break;
      }
      if(!seen.size) recentBox.appendChild(h('p', {class: 'note'}, 'Nothing played recently.'));
    }catch(e){ recentBox.innerHTML = ''; recentBox.appendChild(h('p', {class: 'note'}, e.message)); }
    if(!recentBox.isConnected) return;
    if(M.lib && M.lib.length){
      const grid = h('div', {class: 'cards'});
      main.append(h('div', {class: 'mh2'}, 'Your playlists'), grid);
      for(const p of M.lib.slice(0, 18)) grid.appendChild(mcard({img: bigImg(p.images), title: p.name, sub: (p.owner && p.owner.display_name) || 'Playlist',
        onOpen: () => openView({type: 'playlist', id: p.id, uri: p.uri, name: p.name, img: bigImg(p.images), owner: p.owner && p.owner.display_name, count: plCount(p)}),
        onPlay: () => playContext(p.uri)}));
    }
  }else{
    main.appendChild(h('p', {class: 'note'}, 'Use the search box above to find something to play.'));
  }
}
async function renderSearch(){
  const main = mainShell(), q = M.cur.q;
  main.appendChild(h('div', {class: 'mh2'}, 'Results for “' + q + '”'));
  const box = h('div', null, h('p', {class: 'note'}, 'Searching…')); main.appendChild(box);
  let j;
  try{ j = DEMO ? demoSearch(q) : await sp('GET', '/search?' + new URLSearchParams({q, type: 'track,artist,album,playlist', limit: 10})); }
  catch(e){ box.innerHTML = ''; box.appendChild(h('p', {class: 'note'}, e.message)); return; }
  if(M.cur.type !== 'search' || M.cur.q !== q) return;
  box.innerHTML = '';
  const tracks = ((j.tracks && j.tracks.items) || []).filter(Boolean), uris = tracks.map(t => t.uri);
  if(tracks.length){ const list = h('div', {class: 'tracks'}); tracks.forEach((t, i) => list.appendChild(trackRow(t, i, {uris}))); box.append(h('div', {class: 'mh2'}, 'Songs'), list); }
  const row = (title, items, make) => { items = (items || []).filter(Boolean); if(!items.length) return; const r = h('div', {class: 'cards hscroll'}); items.forEach(x => r.appendChild(make(x))); box.append(h('div', {class: 'mh2', style: 'margin-top:18px'}, title), r); };
  row('Artists', j.artists && j.artists.items, a => mcard({img: imgOf(a.images), title: a.name, sub: 'Artist', round: true, onPlay: () => { playContext(a.uri); toast('Playing ' + a.name); }}));
  row('Albums', j.albums && j.albums.items, a => mcard({img: imgOf(a.images), title: a.name, sub: artists(a), onOpen: () => openView({type: 'album', id: a.id, uri: a.uri}), onPlay: () => playContext(a.uri)}));
  row('Playlists', j.playlists && j.playlists.items, p => mcard({img: imgOf(p.images), title: p.name, sub: (p.owner && p.owner.display_name) || 'Playlist',
    onOpen: () => openView({type: 'playlist', id: p.id, uri: p.uri, name: p.name, img: bigImg(p.images), owner: p.owner && p.owner.display_name}), onPlay: () => playContext(p.uri)}));
  if(!box.childElementCount) box.appendChild(h('p', {class: 'note'}, 'Nothing found.'));
  renderMusic();
}
function hero(main, {img, kind, title, sub, liked}){
  const art = h('div', {class: 'art' + (liked ? ' liked' : '')}, liked ? h('span', {style: 'display:grid;place-items:center;width:100%;height:100%',
    html: '<svg viewBox="0 0 24 24" style="width:64px;height:64px;fill:#fff"><path d="M12 21s-7-4.4-9.5-9A5.5 5.5 0 0 1 12 6a5.5 5.5 0 0 1 9.5 6c-2.5 4.6-9.5 9-9.5 9z"/></svg>'}) : img ? h('img', {src: img, alt: ''}) : null);
  main.appendChild(h('div', {class: 'hero2'}, art, h('div', {style: 'min-width:0'}, h('div', {class: 'kind'}, kind), h('h2', null, title), h('p', null, sub || ''))));
  if(img) artPalette(img).then(p => { if(p) main.style.setProperty('--mh', p[0]); });
  else if(liked) main.style.setProperty('--mh', '#4b2bff');
}
function heroButtons(main, onPlay, onShuffle){
  main.appendChild(h('div', {class: 'heroBtns'},
    h('button', {class: 'bigPlay', 'aria-label': 'Play', html: '<svg viewBox="0 0 24 24">' + PLAY + '</svg>', onclick: onPlay}),
    h('button', {class: 'roundBtn', 'aria-label': 'Shuffle play', onclick: onShuffle, html: '<svg viewBox="0 0 24 24"><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>'})));
}
async function shuffleThen(play){
  try{ if(!DEMO) await sp('PUT', '/me/player/shuffle?state=true'); }catch(e){}
  play();
}
async function renderPlaylist(){
  const v = M.cur, main = mainShell();
  hero(main, {img: v.img, kind: 'Playlist', title: v.name || 'Playlist', sub: [v.owner, v.count != null ? v.count + ' songs' : ''].filter(Boolean).join(' · ')});
  heroButtons(main, () => playContext(v.uri), () => shuffleThen(() => playContext(v.uri)));
  const list = h('div', {class: 'tracks'}, h('p', {class: 'note'}, 'Loading songs…')); main.appendChild(list);
  await loadTracks(list, async offset => {
    const j = DEMO ? demoTracks(v.id, offset) : await sp('GET', `/playlists/${v.id}/items?limit=50&offset=${offset}`);
    return {items: (j.items || []).map(x => x && (x.item || x.track)).filter(t => t && t.uri), next: j.next};
  }, {ctx: v.uri}, e => e.status === 403 || e.status === 404
    ? 'Spotify only shares the song list for playlists you made. You can still play this one with the button above.' : e.message);
}
async function renderAlbum(){
  const v = M.cur, main = mainShell();
  const list = h('div', {class: 'tracks'}, h('p', {class: 'note'}, 'Loading…'));
  let a;
  try{ a = DEMO ? demoAlbum(v.id) : await sp('GET', '/albums/' + v.id); }
  catch(e){ main.appendChild(h('p', {class: 'note'}, e.message)); return; }
  hero(main, {img: bigImg(a.images), kind: 'Album', title: a.name, sub: [artists(a), (a.release_date || '').slice(0, 4), a.total_tracks ? a.total_tracks + ' songs' : ''].filter(Boolean).join(' · ')});
  heroButtons(main, () => playContext(a.uri), () => shuffleThen(() => playContext(a.uri)));
  main.appendChild(list); list.innerHTML = '';
  ((a.tracks && a.tracks.items) || []).forEach((t, i) => list.appendChild(trackRow(t, i, {ctx: a.uri, showArt: false})));
  renderMusic();
}
async function renderLiked(){
  const main = mainShell();
  hero(main, {liked: true, kind: 'Playlist', title: 'Liked Songs', sub: 'Songs you\'ve liked on Spotify'});
  const ctx = await likedContext();
  const list = h('div', {class: 'tracks'}, h('p', {class: 'note'}, 'Loading songs…'));
  let loaded = [];
  heroButtons(main, () => ctx ? playContext(ctx) : playUris(loaded.map(t => t.uri)), () => shuffleThen(() => ctx ? playContext(ctx) : playUris(loaded.map(t => t.uri))));
  main.appendChild(list);
  await loadTracks(list, async offset => {
    const j = DEMO ? demoTracks('liked', offset) : await sp('GET', `/me/tracks?limit=50&offset=${offset}`);
    const items = (j.items || []).map(x => x && (x.track || x.item)).filter(Boolean); loaded = loaded.concat(items);
    return {items, next: j.next};
  }, ctx ? {ctx} : {getUris: () => loaded.map(t => t.uri)}, e => e.message);
}
async function likedContext(){
  if(DEMO) return 'spotify:user:demo:collection';
  try{ if(!M.me) M.me = await sp('GET', '/me'); return `spotify:user:${M.me.id}:collection`; }catch(e){ return null; }
}
async function loadTracks(list, fetchPage, opts, errText){
  let offset = 0, first = true, idx = 0;
  const more = h('button', {class: 'btn ghost sm', style: 'margin:12px auto 0;display:block'}, 'Load more');
  const page = async () => {
    more.disabled = true;
    try{
      const {items, next} = await fetchPage(offset);
      if(first){ list.innerHTML = ''; first = false; }
      for(const t of items){
        const o = opts.getUris ? {uris: opts.getUris()} : opts;
        list.appendChild(trackRow(t, idx++, o));
      }
      offset += 50; more.remove();
      if(next) { more.disabled = false; list.appendChild(more); }
      if(!list.querySelector('.tr')) list.appendChild(h('p', {class: 'note'}, 'No songs here.'));
      renderMusic();
    }catch(e){ list.innerHTML = ''; list.appendChild(h('p', {class: 'note'}, errText(e))); }
  };
  more.onclick = page;
  await page();
}
const doSearch = debounce(() => {
  const q = $('#q').value.trim(); $('#qClear').hidden = !q;
  if(q.length < 2){ if(M.cur.type === 'search'){ M.cur = M.stack.pop() || {type: 'home'}; renderMain(); } return; }
  if(M.cur.type === 'search') M.cur = {type: 'search', q}; else openView({type: 'search', q});
  renderMain();
}, 450);

// =====================================================================
// Calendar (Google Calendar through calendar-bridge.gs, an Apps Script web app)
// =====================================================================
const WHO_COL = {p1: '#5b8cff', p2: '#ff6fa8', both: '#b07bff'};
const GCOL = {1: '#7986cb', 2: '#33b679', 3: '#8e24aa', 4: '#e67c73', 5: '#f6bf26', 6: '#f4511e', 7: '#039be5', 8: '#9e9e9e', 9: '#3f51b5', 10: '#0b8043', 11: '#d50000'};
const CAL = {events: [], loaded: false, err: null, loading: false, month: null, sel: null, from: null, to: null};
const calUrl = () => ls.get('home.cal.url', ''), calSecret = () => ls.get('home.cal.secret', '');
const calReady = () => DEMO || !!(calUrl() && calSecret());
const names = () => ({p1: ls.get('home.cal.p1', '') || ls.get('home.name', 'Kyle') || 'Me', p2: ls.get('home.cal.p2', '') || 'Partner'});
const dayStart = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const hm = d => { const p = clockParts(d); return p.hh + ':' + p.mm + (p.ampm ? p.ampm : ''); };
const KIND_COL = {holiday: '#3ddc97', observance: '#6fae94', birthday: '#ffb347'};
function evWho(e){ return e.kind ? '' : e.who || {9: 'p1', 4: 'p2', 3: 'both'}[e.color] || ''; }
function evColor(e){
  if(e.kind === 'holiday') return e.observance ? KIND_COL.observance : KIND_COL.holiday;
  if(e.kind === 'birthday') return KIND_COL.birthday;
  const w = evWho(e); return w ? WHO_COL[w] : (GCOL[e.color] || '#9aa3b8');
}
const evTitle = e => (e.kind === 'birthday' ? '🎂 ' : '') + (e.title || '(No title)');
// The tablet's own switches for the read-only extras the script sends.
function evShown(e){
  if(e.kind === 'holiday') return e.observance ? ls.get('home.cal.obs', false) : ls.get('home.cal.hol', true);
  if(e.kind === 'birthday') return ls.get('home.cal.bday', true);
  return true;
}
const byStart = (a, b) => (dayStart(a.s) - dayStart(b.s)) || (b.allDay - a.allDay) || (a.s - b.s);
function parseEvent(e){
  return Object.assign({}, e, e.allDay ? {s: parseYmd(e.start), e: parseYmd(e.end)} : {s: new Date(e.start), e: new Date(e.end)});
}
async function calApi(action, data = {}){
  if(DEMO) return demoCalApi(action, data);
  const url = calUrl(), secret = calSecret();
  if(!url || !secret) throw new Error('Set up the calendar in Settings first');
  let r;
  try{
    if(action === 'list') r = await fetch(url + (url.includes('?') ? '&' : '?') + new URLSearchParams(Object.assign({action, secret}, data)));
    else r = await fetch(url, {method: 'POST', headers: {'Content-Type': 'text/plain;charset=utf-8'}, body: JSON.stringify(Object.assign({action, secret}, data))});
  }catch(e){ throw new Error(navigator.onLine ? 'Couldn\'t reach the calendar script. Check the Web app URL and that access is set to Anyone.' : 'No internet connection'); }
  let j; try{ j = await r.json(); }catch(e){ throw new Error('The calendar script didn\'t reply properly. Check the Web app URL ends in /exec.'); }
  if(!j.ok) throw new Error(j.error || 'Calendar error');
  return j;
}
function gridStart(month){ const first = new Date(month.getFullYear(), month.getMonth(), 1); return addDays(first, -((first.getDay() + 6) % 7)); }
async function calLoad(){
  if(!calReady()){ renderCal(); return; }
  const today = dayStart(new Date()), gs = gridStart(CAL.month);
  const from = gs < today ? gs : today, to = new Date(Math.max(+addDays(gs, 42), +addDays(today, 45)));
  CAL.loading = true;
  try{
    const j = await calApi('list', {from: from.toISOString(), to: to.toISOString()});
    CAL.events = (j.events || []).map(parseEvent).filter(evShown).sort(byStart);
    CAL.loaded = true; CAL.err = null; CAL.name = j.name;
    ls.set('home.cal.cache', j.events || []);
  }catch(e){ CAL.err = e; }
  CAL.loading = false;
  renderCal(); renderCalTile();
}
const eventsOn = d => { const a = dayStart(d), b = addDays(a, 1); return CAL.events.filter(e => e.s < b && e.e > a && !(e.allDay && +e.e === +a)); };
function calEnter(){
  if(!CAL.month){ const t = new Date(); CAL.month = new Date(t.getFullYear(), t.getMonth(), 1); CAL.sel = dayStart(t); }
  renderCal(); calLoad();
}
function renderCal(){
  if(!CAL.month) return;
  const t = dayStart(new Date()), gs = gridStart(CAL.month), n = names();
  $('#calTitle').textContent = CAL.month.toLocaleDateString('en-GB', {month: 'long', year: 'numeric'});
  const lg = $('#legend'); lg.innerHTML = '';
  const keys = [[WHO_COL.p1, n.p1], [WHO_COL.p2, n.p2], [WHO_COL.both, 'Both']];
  if(CAL.events.some(e => e.kind === 'holiday')) keys.push([KIND_COL.holiday, 'Holiday']);
  if(CAL.events.some(e => e.kind === 'birthday')) keys.push([KIND_COL.birthday, 'Birthday']);
  keys.forEach(([col, label]) => { const s = h('span', null, h('i'), label); s.firstChild.style.setProperty('--ec', col); lg.appendChild(s); });
  const grid = $('#mgrid'); grid.innerHTML = '';
  const cellH = grid.clientHeight ? (grid.clientHeight - 20) / 6 : 80, fit = Math.max(1, Math.floor((cellH - 32) / 15));
  for(let i = 0; i < 42; i++){
    const d = addDays(gs, i), evs = eventsOn(d);
    const cell = h('button', {class: 'day' + (d.getMonth() !== CAL.month.getMonth() ? ' out' : '') + (sameDay(d, t) ? ' today' : '') + (CAL.sel && sameDay(d, CAL.sel) ? ' sel' : ''),
      onclick: () => { CAL.sel = d; if(d.getMonth() !== CAL.month.getMonth()){ CAL.month = new Date(d.getFullYear(), d.getMonth(), 1); calLoad(); } renderCal(); }},
      h('span', {class: 'dn'}, String(d.getDate())));
    evs.slice(0, evs.length > fit ? fit - 1 : fit).forEach(e => {
      const c = h('div', {class: 'ech' + (e.allDay ? ' ad' : '')}, e.allDay ? null : h('i'), h('span', null, evTitle(e)));
      c.style.setProperty('--ec', evColor(e)); cell.appendChild(c);
    });
    if(evs.length > fit) cell.appendChild(h('div', {class: 'emore'}, `+${evs.length - fit + 1} more`));
    grid.appendChild(cell);
  }
  renderAgenda();
}
function evRow(e, showDate){
  const allDayLabel = e.kind === 'birthday' ? 'Birthday' : e.kind === 'holiday' ? 'Holiday' : 'All day';
  const when = e.allDay ? h('div', {class: 'when'}, showDate ? h('b', null, e.s.toLocaleDateString('en-GB', {weekday: 'short', day: 'numeric'})) : null, allDayLabel)
    : h('div', {class: 'when'}, showDate ? h('b', null, e.s.toLocaleDateString('en-GB', {weekday: 'short', day: 'numeric'})) : h('b', null, hm(e.s)), showDate ? hm(e.s) : hm(e.e));
  const w = evWho(e), n = names(), who = w === 'p1' ? n.p1 : w === 'p2' ? n.p2 : w === 'both' ? 'Both' : '';
  const row = h('button', {class: 'ev', onclick: () => openEditor(e)}, h('span', {class: 'bar2'}), when,
    h('div', {class: 'what'}, h('b', null, evTitle(e)), (who || e.location) ? h('small', null, [who, e.location].filter(Boolean).join(' · ')) : null));
  row.style.setProperty('--ec', evColor(e));
  return row;
}
function renderAgenda(){
  const sel = CAL.sel || dayStart(new Date()), t = dayStart(new Date()), list = $('#agList');
  $('#agNum').textContent = sel.getDate();
  const rel = sameDay(sel, t) ? 'Today' : sameDay(sel, addDays(t, 1)) ? 'Tomorrow' : sameDay(sel, addDays(t, -1)) ? 'Yesterday' : sel.toLocaleDateString('en-GB', {weekday: 'long'});
  const wd = sel.toLocaleDateString('en-GB', {weekday: 'long'}), my = sel.toLocaleDateString('en-GB', {month: 'long', year: 'numeric'});
  $('#agDay').innerHTML = ''; $('#agDay').append(h('b', null, rel), rel === wd ? my : wd + ', ' + my);
  list.innerHTML = '';
  if(!calReady()){
    list.appendChild(h('div', {class: 'calNote'}, 'Link your shared Google Calendar so you can both add events from your phones and see them here.',
      h('button', {class: 'btn', onclick: () => { openSheet('settings'); setTimeout(() => $('#calSec').scrollIntoView({behavior: 'smooth'}), 150); }}, 'Set up the calendar')));
    $('#agAdd').hidden = true; return;
  }
  $('#agAdd').hidden = false;
  if(CAL.err) list.appendChild(h('div', {class: 'calNote', style: 'color:var(--err)'}, CAL.err.message));
  const evs = eventsOn(sel);
  if(evs.length) evs.forEach(e => list.appendChild(evRow(e)));
  else list.appendChild(h('div', {class: 'agEmpty'}, CAL.loading && !CAL.loaded ? 'Loading…' : 'Nothing planned.'));
  const after = addDays(sel, 1), up = CAL.events.filter(e => e.s >= after).slice(0, 6);
  if(up.length){ list.appendChild(h('div', {class: 'upHead'}, 'Coming up')); up.forEach(e => list.appendChild(evRow(e, true))); }
}
function renderCalTile(){
  const el = $('#tCal'); if(!el) return;
  if(!calReady()){ el.textContent = 'Shared calendar'; return; }
  const now = new Date(), next = CAL.events.find(e => e.allDay ? e.e > dayStart(now) : e.e > now);
  if(!next){ el.textContent = CAL.loaded ? 'Nothing coming up' : ''; return; }
  const t = dayStart(now), day = sameDay(next.s, t) || next.s < t ? 'Today' : sameDay(next.s, addDays(t, 1)) ? 'Tomorrow' : next.s.toLocaleDateString('en-GB', {weekday: 'short', day: 'numeric'});
  el.textContent = `${day}${next.allDay ? '' : ' ' + hm(next.s)} · ${evTitle(next)}`;
}
// editor
let evEditing = null, evWhoSel = 'p1', evAllDay = false, evDelArmed = false;
function setEvAllDay(on){ evAllDay = on; $('#evAllDay').setAttribute('aria-checked', String(on)); $('#evStart').hidden = $('#evEnd').hidden = on; $('#evTimes').style.gridTemplateColumns = on ? '1fr' : ''; }
function setEvWho(w){ evWhoSel = w; $$('#evWho button').forEach(b => b.classList.toggle('on', b.dataset.who === w)); }
function openEditor(e, date){
  evEditing = e || null; evDelArmed = false;
  const n = names();
  $$('#evWho button').forEach(b => { b.style.setProperty('--ec', WHO_COL[b.dataset.who]); b.querySelector('span').textContent = b.dataset.who === 'p1' ? n.p1 : b.dataset.who === 'p2' ? n.p2 : 'Both'; });
  $('#evHead').textContent = e ? 'Edit event' : 'New event';
  const d = e ? e.s : (date || CAL.sel || new Date());
  $('#evTitle').value = e ? e.title : ''; $('#evLoc').value = e ? e.location || '' : ''; $('#evNotes').value = e ? e.notes || '' : '';
  $('#evDate').value = ymd(d);
  const start = e && !e.allDay ? e.s : (() => { const x = new Date(); x.setMinutes(0, 0, 0); x.setHours(x.getHours() + 1); return x; })();
  const end = e && !e.allDay ? e.e : new Date(+start + 3600e3);
  const tt = x => String(x.getHours()).padStart(2, '0') + ':' + String(x.getMinutes()).padStart(2, '0');
  $('#evStart').value = tt(start); $('#evEnd').value = tt(end);
  setEvAllDay(e ? e.allDay : false); setEvWho(e ? (evWho(e) || 'both') : 'p1');
  const ro = !!(e && (e.recurring || e.readOnly));
  $('#evRecurring').textContent = !e ? '' : e.kind === 'birthday' ? 'Birthdays come from Google Contacts. Change them there.'
    : e.kind === 'holiday' ? 'From Google\'s UK holidays calendar.' : 'This event repeats, so change it in Google Calendar.';
  $('#evRecurring').hidden = !ro; $('#evSave').hidden = ro;
  $('#evHead').textContent = e && e.kind === 'birthday' ? 'Birthday' : e && e.kind === 'holiday' ? 'Holiday' : e ? 'Edit event' : 'New event';
  $('#evWho').hidden = !!(e && e.kind);
  $('#evDel').hidden = !e || ro; $('#evDel').textContent = 'Delete';
  $$('#evSheet .field').forEach(f => { f.disabled = ro; });
  openSheet('evSheet');
  if(!e) setTimeout(() => $('#evTitle').focus(), 250);
}
// ---- Discord: the tablet posts to a webhook itself (Discord often blocks Apps Script's servers) ----
const dcUrl = () => ls.get('home.cal.discord', '').trim();
const DC_COL = {p1: 0x5484ED, p2: 0xE67C73, both: 0x8E24AA, '': 0xD6A266};
function dcWhen(p){
  const d = x => x.toLocaleDateString('en-GB', {weekday: 'short', day: 'numeric', month: 'short'});
  const t = x => x.toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'});
  if(p.allDay){
    const s = parseYmd(p.start), e = addDays(parseYmd(p.end), -1);
    return +s === +e ? d(s) + ' · All day' : d(s) + ' – ' + d(e);
  }
  const s = new Date(p.start), e = new Date(p.end);
  return d(s) + ' · ' + t(s) + '–' + (ymd(s) === ymd(e) ? t(e) : d(e) + ' ' + t(e));
}
async function dcSend(body){
  const url = dcUrl(); if(!url) return;
  const r = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(Object.assign({username: 'Home calendar'}, body))});
  if(!r.ok) throw new Error('Discord replied ' + r.status);
}
function dcEvent(action, p){
  if(!dcUrl() || DEMO) return;
  if(action !== 'add' && !ls.get('home.cal.dcAll', false)) return;
  const heads = {add: 'New event, added on the wall panel', update: 'Event changed on the wall panel', delete: 'Event deleted on the wall panel'};
  const fields = [];
  if(p.whoName) fields.push({name: 'Who', value: p.whoName, inline: true});
  if(p.location) fields.push({name: 'Where', value: p.location, inline: true});
  if(p.notes) fields.push({name: 'Notes', value: p.notes.slice(0, 1000)});
  const day = (p.allDay ? p.start : ymd(new Date(p.start))).split('-');
  dcSend({embeds: [{author: {name: heads[action]}, title: (p.title || 'Event').slice(0, 250), description: p.start ? dcWhen(p) : '',
    url: 'https://calendar.google.com/calendar/r/day/' + day.map(Number).join('/'),
    color: DC_COL[p.who || ''] ?? DC_COL[''], fields}]})
    .catch(() => toast('Saved, but the Discord message didn\'t send', true));
}
async function saveEvent(){
  const title = $('#evTitle').value.trim(), date = $('#evDate').value;
  if(!title){ toast('Give the event a name', true); return; }
  if(!date){ toast('Pick a date', true); return; }
  const n = names(), whoName = evWhoSel === 'both' ? `${n.p1} & ${n.p2}` : (n[evWhoSel] || '');
  const p = {title, who: evWhoSel, whoName, allDay: evAllDay, location: $('#evLoc').value.trim(), notes: $('#evNotes').value.trim()};
  if(evAllDay){ p.start = date; p.end = ymd(addDays(parseYmd(date), 1)); }
  else{
    const s = new Date(`${date}T${$('#evStart').value || '09:00'}`); let en = new Date(`${date}T${$('#evEnd').value || '10:00'}`);
    if(en <= s) en = new Date(+en + 864e5);
    p.start = s.toISOString(); p.end = en.toISOString();
  }
  const btn = $('#evSave'); btn.disabled = true; btn.textContent = 'Saving…';
  try{
    await calApi(evEditing ? 'update' : 'add', evEditing ? Object.assign({id: evEditing.id}, p) : p);
    dcEvent(evEditing ? 'update' : 'add', p);
    closeSheets(); toast(evEditing ? 'Event updated' : 'Event added');
    CAL.sel = parseYmd(date); await calLoad();
  }catch(e){ toast(e.message, true); }
  btn.disabled = false; btn.textContent = 'Save';
}
async function deleteEvent(){
  if(!evEditing) return;
  if(!evDelArmed){ evDelArmed = true; $('#evDel').textContent = 'Tap again to delete'; setTimeout(() => { evDelArmed = false; $('#evDel').textContent = 'Delete'; }, 3500); return; }
  const n = names(), w = evEditing.who || '', whoName = w === 'both' ? `${n.p1} & ${n.p2}` : (n[w] || '');
  try{ await calApi('delete', {id: evEditing.id, whoName});
    dcEvent('delete', {title: evEditing.title, who: w, whoName, allDay: evEditing.allDay, start: evEditing.start, end: evEditing.end, location: evEditing.location});
    closeSheets(); toast('Event deleted'); await calLoad(); }catch(e){ toast(e.message, true); }
}

// =====================================================================
// Idle: back to the landing (or the calendar), then the ambient screen
// =====================================================================
let idleT = null;
function bump(){
  clearTimeout(idleT);
  const mins = +ls.get('home.dim', 2);
  if(mins > 0) idleT = setTimeout(goIdle, mins * 60000);
}
function goIdle(){
  if($('.sheet.show') || document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName)){ bump(); return; }
  if(calMode()){
    if(view !== 'calendar') go('calendar');
    if(isNight()) $('#nightDim').classList.add('on', 'block');
    return;
  }
  if(view !== 'home') go('home');
  showAmbient();
}
function showAmbient(){ renderAmbient(); nudgeAmbient(); $('#ambient').classList.add('show', 'block'); }
function hideAmbient(){ const a = $('#ambient'); a.classList.remove('show'); setTimeout(() => a.classList.remove('block'), 350); }
function wakeUp(){
  if($('#ambient').classList.contains('show')) hideAmbient();
  const nd = $('#nightDim'); if(nd.classList.contains('on')){ nd.classList.remove('on'); setTimeout(() => nd.classList.remove('block'), 350); }
}
function renderAmbient(){
  const s = SP.state, music = !!(s && s.item && s.is_playing);
  $('#aMusic').hidden = !music; $('#aClockWrap').hidden = music;
}
function nudgeAmbient(){ $('#aIn').style.transform = `translate(${(Math.random() * 4 - 2).toFixed(2)}vw, ${(Math.random() * 4 - 2).toFixed(2)}vh)`; }
document.addEventListener('pointerdown', () => { wakeUp(); bump(); wake(); }, true);
// The calendar can stay up all day, so drift it a few pixels now and then (AMOLED burn-in).
setInterval(() => { $('#app').style.transform = calMode() && view === 'calendar' ? `translate(${Math.round(Math.random() * 6 - 3)}px, ${Math.round(Math.random() * 6 - 3)}px)` : ''; }, 5 * 60000);

// Walk-up wake: tiny greyscale frames from the front camera, compared 4x a second.
const MOTION_SENS = {low: 0.06, med: 0.025, high: 0.01};
const motion = {stream: null, video: null, ctx: null, prev: null, timer: null, hits: 0, level: 0};
async function motionStart(){
  if(DEMO || motion.stream || !ls.get('home.motion', false) || document.visibilityState !== 'visible') return;
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ toast('This browser can\'t use the camera', true); setMotion(false); return; }
  try{
    motion.stream = await navigator.mediaDevices.getUserMedia({audio: false,
      video: {facingMode: 'user', width: {ideal: 160}, height: {ideal: 120}, frameRate: {ideal: 8, max: 15}}});
  }catch(e){ toast('Camera access was blocked, so walk-up wake is off', true); setMotion(false); return; }
  if(!ls.get('home.motion', false) || document.visibilityState !== 'visible'){ motionStop(); return; }
  if(!motion.video){ motion.video = document.createElement('video'); motion.video.muted = true; motion.video.setAttribute('playsinline', ''); }
  motion.video.srcObject = motion.stream;
  try{ await motion.video.play(); }catch(e){}
  if(!motion.ctx){ const c = document.createElement('canvas'); c.width = 48; c.height = 36; motion.ctx = c.getContext('2d', {willReadFrequently: true}); }
  motion.prev = null; motion.hits = 0;
  clearInterval(motion.timer); motion.timer = setInterval(motionTick, 250);
  $('#camDot').hidden = false;
}
function motionStop(){
  clearInterval(motion.timer); motion.timer = null;
  if(motion.stream){ motion.stream.getTracks().forEach(t => t.stop()); motion.stream = null; }
  if(motion.video) motion.video.srcObject = null;
  motion.prev = null; $('#camDot').hidden = true;
}
function motionTick(){
  const v = motion.video; if(!v || v.readyState < 2) return;
  const W = 48, H = 36, n = W * H;
  motion.ctx.drawImage(v, 0, 0, W, H);
  const d = motion.ctx.getImageData(0, 0, W, H).data, px = new Float32Array(n);
  let mean = 0;
  for(let i = 0, j = 0; j < n; i += 4, j++){ px[j] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114; mean += px[j]; }
  mean /= n;
  const prev = motion.prev; motion.prev = {px, mean};
  if(!prev) return;
  const shift = mean - prev.mean; let changed = 0;
  for(let j = 0; j < n; j++) if(Math.abs(px[j] - prev.px[j] - shift) > 22) changed++;
  motion.level = changed / n; renderMeter();
  motion.hits = motion.level > (MOTION_SENS[ls.get('home.sens', 'med')] || 0.025) ? motion.hits + 1 : 0;
  if(motion.hits >= 2){ motion.hits = 0; onMotion(); }
}
function onMotion(){
  wakeUp(); bump();
  const dot = $('#camDot'); dot.classList.add('seen'); clearTimeout(onMotion.t); onMotion.t = setTimeout(() => dot.classList.remove('seen'), 1500);
}
function renderMeter(){
  if(!$('#settings').classList.contains('show')) return;
  const top = 0.15, th = MOTION_SENS[ls.get('home.sens', 'med')] || 0.025;
  $('#motionLevel').style.width = Math.min(100, motion.level / top * 100) + '%';
  $('#motionMark').style.left = (th / top * 100) + '%';
}
function setMotion(on){
  ls.set('home.motion', on); $('#oMotion').setAttribute('aria-checked', String(on)); $('#motionBox').hidden = !on;
  if(on) motionStart(); else motionStop();
}
// keep the screen on (Screen Wake Lock; the tablet should also be on charge)
let wl = null;
async function wake(){
  if(!ls.get('home.awake', true) || !('wakeLock' in navigator) || document.visibilityState !== 'visible' || wl) return;
  try{ wl = await navigator.wakeLock.request('screen'); wl.addEventListener('release', () => { wl = null; }); }catch(e){}
}
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState === 'visible'){ wake(); tick(true); spPoll(); motionStart(); if(view === 'calendar') calLoad(); } else motionStop();
});

// =====================================================================
// Settings
// =====================================================================
function openSheet(id){
  $('#' + id).classList.add('show');
  if(id === 'settings'){
    renderLocNow(); renderSpSettings(); $('#vmToken').value = vmToken(); renderAxList();
    $('#oName').value = ls.get('home.name', 'Kyle'); $('#calUrl').value = calUrl(); $('#calSecret').value = calSecret();
    $('#calP1').value = ls.get('home.cal.p1', ''); $('#calP2').value = ls.get('home.cal.p2', ''); $('#calDiscord').value = dcUrl(); $('#calP1').placeholder = names().p1;
    $('#gnDevice').value = ls.get('home.gn.device', ''); $('#gnMins').value = String(ls.get('home.gn.mins', 5));
    $('#bgReset').hidden = !ls.get('home.bg', '');
  }
}
function closeSheets(){ $$('.sheet').forEach(s => s.classList.remove('show')); }
$$('.sheet').forEach(s => s.addEventListener('click', e => { if(e.target === s || e.target.closest('[data-close]')) closeSheets(); }));
function bindSwitch(el, key, def, after){
  const set = v => el.setAttribute('aria-checked', String(v));
  set(ls.get(key, def));
  el.onclick = e => { e.preventDefault(); const v = !ls.get(key, def); ls.set(key, v); set(v); if(after) after(v); };
}
function renderSpSettings(){
  const signed = !!SP.tok;
  $('#spOut').hidden = signed; $('#spIn').hidden = !signed;
  $('#spLib').hidden = !signed || spHasLib();
  $('#spRedirect').textContent = spRedirect();
  if(document.activeElement !== $('#spClient')) $('#spClient').value = spClient();
}
function applyBg(){
  const u = ls.get('home.bg', '');
  if(u) document.documentElement.style.setProperty('--bgimg', `url("${u}")`); else document.documentElement.style.removeProperty('--bgimg');
}
async function pickBg(file){
  try{
    const bmp = await createImageBitmap(file), scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    if(!ls.set('home.bg', c.toDataURL('image/jpeg', 0.82))){ toast('That photo is too big to save', true); return; }
    applyBg(); $('#bgReset').hidden = false; toast('Background updated');
  }catch(e){ toast('Couldn\'t use that photo', true); }
}
function bindSettings(){
  bindSwitch($('#o24'), 'home.h24', true, () => { tick(true); const j = DEMO ? demoWeather() : ls.get('home.wx', null); if(j) renderWeather(j); renderCal(); });
  bindSwitch($('#oAwake'), 'home.awake', true, v => { if(v) wake(); else if(wl){ wl.release(); wl = null; } });
  $('#oName').addEventListener('input', debounce(e => { ls.set('home.name', e.target.value.trim()); tick(true); }, 300));
  $('#bgPick').onchange = e => { if(e.target.files[0]) pickBg(e.target.files[0]); e.target.value = ''; };
  $('#bgReset').onclick = () => { ls.del('home.bg'); applyBg(); $('#bgReset').hidden = true; };
  $('#oDim').value = String(ls.get('home.dim', 2));
  $('#oDim').onchange = e => { ls.set('home.dim', +e.target.value); bump(); };
  $('#oMotion').onclick = e => { e.preventDefault(); setMotion(!ls.get('home.motion', false)); };
  $('#oSens').value = ls.get('home.sens', 'med');
  $('#oSens').onchange = e => { ls.set('home.sens', e.target.value); renderMeter(); };
  $('#useLoc').onclick = () => askLocation(false);
  $('#citySearch').onclick = searchCity;
  $('#cityIn').addEventListener('keydown', e => { if(e.key === 'Enter') searchCity(); });
  // spotify
  $('#spConnect').onclick = () => {
    const id = $('#spClient').value.trim();
    if(!/^[0-9a-f]{32}$/i.test(id)){ toast('That doesn\'t look like a Client ID (32 letters and numbers)', true); return; }
    ls.set('home.sp.client', id); spLogin();
  };
  $('#spRelog').onclick = () => spLogin();
  $('#spCopy').onclick = async () => { try{ await navigator.clipboard.writeText(spRedirect()); toast('Copied'); }catch(e){ toast('Select and copy it by hand', true); } };
  $('#spLogout').onclick = () => spLogout(false);
  // calendar
  $('#calScript').href = location.href.replace(/[^/]*([?#].*)?$/, '') + 'calendar-bridge.gs';
  $('#calSave').onclick = async () => {
    const url = $('#calUrl').value.trim(), secret = $('#calSecret').value.trim();
    if(!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)){ toast('Paste the Web app URL. It starts with https://script.google.com and ends in /exec', true); return; }
    if(!secret){ toast('Type the same secret you set in the script', true); return; }
    ls.set('home.cal.url', url); ls.set('home.cal.secret', secret);
    $('#calStatus').textContent = 'Checking…';
    try{ const j = await calApi('list', {from: new Date().toISOString(), to: addDays(new Date(), 7).toISOString()}); $('#calStatus').textContent = `Connected to “${j.name}”.`; CAL.loaded = false; calLoad(); }
    catch(e){ $('#calStatus').textContent = e.message; }
  };
  const calSwitch = (id, key, def) => bindSwitch($(id), key, def, () => calLoad());
  calSwitch('#oHol', 'home.cal.hol', true); calSwitch('#oObs', 'home.cal.obs', false); calSwitch('#oBday', 'home.cal.bday', true);
  $('#calP1').addEventListener('input', debounce(e => { ls.set('home.cal.p1', e.target.value.trim()); renderCal(); }, 300));
  $('#calP2').addEventListener('input', debounce(e => { ls.set('home.cal.p2', e.target.value.trim()); renderCal(); }, 300));
  $('#calDiscord').addEventListener('change', e => {
    const v = e.target.value.trim();
    if(v && !/^https:\/\/(\w+\.)?discord(app)?\.com\/api\/webhooks\//.test(v)){ toast('That doesn\'t look like a Discord webhook URL', true); return; }
    ls.set('home.cal.discord', v); toast(v ? 'Discord webhook saved' : 'Discord messages off');
  });
  bindSwitch($('#oDcAll'), 'home.cal.dcAll', false);
  $('#calDiscordTest').onclick = async () => {
    $('#calDiscord').dispatchEvent(new Event('change'));
    if(!dcUrl()){ toast('Paste the webhook URL first', true); return; }
    try{ await dcSend({embeds: [{title: 'Calendar messages are working', description: 'Events added on the wall panel will show up here.', color: DC_COL['']}]}); toast('Test message sent to Discord'); }
    catch(e){ toast(e.message.includes('Discord') ? e.message : 'Couldn\'t reach Discord', true); }
  };
  // alexa
  $('#vmSave').onclick = () => { ls.set('home.vm.token', $('#vmToken').value.trim()); toast($('#vmToken').value.trim() ? 'Voice Monkey token saved' : 'Token removed'); };
  $('#gnDevice').addEventListener('change', e => ls.set('home.gn.device', e.target.value.trim()));
  $('#gnMins').onchange = e => ls.set('home.gn.mins', +e.target.value);
  $('#gnTest').onclick = async () => { const id = $('#gnDevice').value.trim(); ls.set('home.gn.device', id); if(!id){ toast('Paste the Goodnight trigger ID first', true); return; } try{ await vmCall({kind: 'trigger', device: id}); toast('Sent. Did Alexa run your Goodnight routine?'); }catch(e){ toast(e.message, true); } };
  $('#axKind').onchange = axKindChanged;
  $('#axAdd').onclick = () => {
    const b = axFormValue(); if(!axCheck(b)) return;
    if(b.kind !== 'announce') delete b.speech;
    if(!b.scene){ delete b.scene; delete b.delay; }
    if(axEditing >= 0) axButtons[axEditing] = b; else axButtons.push(b);
    axReset(); saveAx(); toast('Button saved');
  };
  $('#axCancel').onclick = axReset;
  $('#axTest').onclick = async () => {
    const b = axFormValue(); if(!axCheck(b)) return;
    if(!b.device){ toast('Nothing to test with Alexa. The lights part runs when you tap the button.'); return; }
    try{ await vmCall(b); toast('Sent. Did Alexa do it?'); }catch(e){ toast(e.message, true); }
  };
  const scGroup = h('optgroup', {label: 'Scene on both lights'}), oneGroup = h('optgroup', {label: 'One light'});
  for(const sc of SCENES) scGroup.appendChild(h('option', {value: sc.id}, 'Then: ' + sc.name));
  for(const [k, name] of LIGHT_ACTIONS) oneGroup.appendChild(h('option', {value: k}, 'Then: ' + name));
  $('#axScene').append(scGroup, oneGroup);
  $('#axScene').onchange = e => { $('#axDelay').hidden = !e.target.value; };
  // lights
  $('#pairCurtain').onclick = () => { closeSheets(); links.curtain.choose(false); };
  $('#pairStrip').onclick = () => { closeSheets(); links.strip.choose(false); };
  $('#pairUsb').onclick = () => { closeSheets(); links.usb.choose(false); };
  $('#usbName').value = ls.get('usb.name', '');
  $('#usbName').addEventListener('input', debounce(e => {
    ls.set('usb.name', e.target.value.trim()); links.usb.label = usbName();
    $('#dev-usb .devName').textContent = usbName(); $('#pairUsb').textContent = 'Pair the ' + usbName(); renderHomeTiles();
  }, 300));
  $('#pairUsb').textContent = 'Pair the ' + usbName();
  $('#usbSegs').value = String(usbSegs());
  $('#usbSegs').onchange = e => { ls.set('usb.leds', clamp(+e.target.value || 200, 2, 600)); e.target.value = usbSegs(); render('usb'); if(links.usb.on && L.usb.on) pushLook('usb'); };
  // full-length test: a rainbow along every LED, sent with one of the five ways of splitting it
  $$('#usbFrag button').forEach(btn => {
    btn.classList.toggle('on', btn.dataset.v === ls.get('usb.frag', 'A'));
    btn.onclick = async () => {
      if(!needLink('usb')) return;
      ls.set('usb.frag', btn.dataset.v); $$('#usbFrag button').forEach(x => x.classList.toggle('on', x === btn));
      const n = usbSegs(), payload = CURTAIN.smear(Array.from({length: n}, (_, i) => ledHsv(usbFix(colorAt(RAINBOW, i / (n - 1))))));
      await links.usb.send(CURTAIN.power(true));
      await links.usb.sendFrames(usbFrames(links.usb.nextSeq(), payload, btn.dataset.v));
      toast(`Sent a rainbow with test ${btn.textContent}. Does it run along all ${n} LEDs?`);
    };
  });
  // colour check: show red, ask what it looks like, then green; work out the channel order from the two answers
  const ucBox = $('#usbCheck'), ucQ = $('#usbCheckQ'), ucStatus = () => { $('#usbOrderNow').textContent = usbOrder() === 'rgb' ? 'Not corrected' : 'Corrected (' + usbOrder().toUpperCase() + ')'; };
  let ucStep = 0, ucFirst = null;
  const sendRaw = hex => { const [hh, sat, v] = rgbToHsv(...hexToRgb(hex)); return links.usb.send(usbColour(hh, sat, v)); };
  $('#usbCheckStart').onclick = async () => {
    if(!needLink('usb')) return;
    ucStep = 1; ucFirst = null; ucBox.hidden = false; ucQ.textContent = 'The lights should now be one colour. Which colour are they?';
    await links.usb.send(CURTAIN.power(true)); await sendRaw('#ff0000');
  };
  $$('#usbCheck [data-c]').forEach(btn => btn.onclick = async () => {
    const c = btn.dataset.c;
    if(ucStep === 1){ ucFirst = c; ucStep = 2; ucQ.textContent = 'And which colour are they now?'; await sendRaw('#00ff00'); return; }
    if(ucStep === 2){
      if(c === ucFirst){ toast('Those two answers match, so let\'s try again', true); ucStep = 0; ucBox.hidden = true; return; }
      const third = 'rgb'.replace(ucFirst, '').replace(c, '');
      ls.set('usb.order', ucFirst + c + third); ucStep = 0; ucBox.hidden = true; ucStatus();
      toast('Colours corrected. Tap red on the card to check.'); if(L.usb.on) pushLook('usb');
    }
  });
  $('#usbCheckReset').onclick = () => { ls.set('usb.order', 'rgb'); ucStatus(); if(links.usb.on && L.usb.on) pushLook('usb'); toast('Colour correction removed'); };
  ucStatus();
  if(ls.get('usb.method', 'a1') !== 'a1') ls.set('usb.method', 'a1');   // A is the command that works on this controller
  $('#flagHint').hidden = !navigator.bluetooth || !!navigator.bluetooth.getDevices;
  // landing + music + calendar controls
  $('#gnBtn').onclick = goodnight;
  $('#wSetup').onclick = () => openSheet('settings');
  $('#closeCal').onclick = () => { ls.set('home.calMode', false); go('home'); };
  $('#calPrev').onclick = () => { CAL.month = new Date(CAL.month.getFullYear(), CAL.month.getMonth() - 1, 1); renderCal(); calLoad(); };
  $('#calNext').onclick = () => { CAL.month = new Date(CAL.month.getFullYear(), CAL.month.getMonth() + 1, 1); renderCal(); calLoad(); };
  $('#calToday').onclick = () => { const t = new Date(); CAL.month = new Date(t.getFullYear(), t.getMonth(), 1); CAL.sel = dayStart(t); renderCal(); calLoad(); };
  $('#agAdd').onclick = () => openEditor(null, CAL.sel);
  $('#evAllDay').onclick = e => { e.preventDefault(); setEvAllDay(!evAllDay); };
  $$('#evWho button').forEach(b => { b.onclick = () => setEvWho(b.dataset.who); });
  $('#evSave').onclick = saveEvent;
  $('#evDel').onclick = deleteEvent;
  $('#pPlay').onclick = () => spCmd('toggle');
  $('#pPrev').onclick = () => spCmd('previous');
  $('#pNext').onclick = () => spCmd('next');
  $('#pShuffle').onclick = () => spCmd('shuffle');
  $('#pRepeat').onclick = () => spCmd('repeat');
  $('#pDev').onclick = () => { pendingPlay = null; openSpeakers(); };
  $('#pFollow').onclick = () => {
    const on = !follow; setFollow(on);
    if(on){ clearScene(); if(!links.curtain.on && !links.strip.on) toast('Connect your lights first', true); else { followAlbum(); toast('The lights will follow the album art'); } }
  };
  $('#pVol').addEventListener('input', e => { volDrag = true; if(SP.state && SP.state.device) SP.state.device.volume_percent = +e.target.value; spVolume(+e.target.value); });
  $('#pVol').addEventListener('change', () => { volDrag = false; });
  $('#pProg').addEventListener('pointerdown', e => { if(!SP.state || !SP.state.item) return; $('#pProg').setPointerCapture(e.pointerId); seekPreview = seekAt(e); progress(); });
  $('#pProg').addEventListener('pointermove', e => { if(seekPreview == null) return; seekPreview = seekAt(e); progress(); });
  $('#pProg').addEventListener('pointerup', async e => {
    if(seekPreview == null) return;
    const ms = Math.round(seekAt(e)); seekPreview = null;
    SP.state.progress_ms = ms; SP.at = Date.now(); progress();
    try{ if(!DEMO) await sp('PUT', '/me/player/seek?position_ms=' + ms); }catch(err){ spErr(err); }
  });
  $('#q').addEventListener('input', doSearch);
  $('#q').addEventListener('keydown', e => { if(e.key === 'Enter') e.target.blur(); });
  $('#qClear').onclick = () => { $('#q').value = ''; doSearch(); };
}

// =====================================================================
// Demo data (open home.html?demo to preview without lights, Spotify or a calendar)
// =====================================================================
function demoWeather(){
  const now = new Date(), pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
  const times = Array.from({length: 48}, (_, i) => { const d = new Date(now); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + i - 2); return iso(d); });
  const codes = [2, 2, 3, 3, 61, 61, 80, 3, 2, 1, 1, 0];
  return {
    current: {time: iso(now).slice(0, 13) + ':15', temperature_2m: 11.4, apparent_temperature: 9.2, weather_code: 2, is_day: 1},
    daily: {temperature_2m_max: [13.1], temperature_2m_min: [6.4]},
    hourly: {time: times, temperature_2m: times.map((_, i) => 11 + Math.sin(i / 3) * 2), weather_code: times.map((_, i) => codes[i % 12]),
      precipitation_probability: times.map((_, i) => [10, 20, 40, 60, 70, 35, 10, 5][i % 8]), is_day: times.map(() => 1)},
  };
}
function demoArtSvg(a, b, c, shape = 0){
  const shapes = ['<circle cx="150" cy="170" r="70" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="3"/>',
    '<rect x="70" y="70" width="160" height="160" rx="10" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="3" transform="rotate(12 150 150)"/>',
    '<path d="M40 220 Q150 60 260 220" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="4"/>'];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset=".55" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></linearGradient></defs><rect width="300" height="300" fill="url(#g)"/>${shapes[shape % 3]}</svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}
const DEMO_ART = [['#ff3d6e', '#7a2aff', '#11063a'], ['#ffb066', '#ff5a00', '#3a0d00'], ['#00e5ff', '#2a7cff', '#0a0a3a'], ['#9dff5a', '#1fa32a', '#062b10'],
  ['#ff8ad8', '#c99bff', '#2a1050'], ['#ffe08a', '#ff8a3d', '#5a1a00'], ['#8adfff', '#5b8cff', '#101a40'], ['#ff6a6a', '#b0003a', '#200010']];
const demoImg = i => [{url: demoArtSvg(...DEMO_ART[i % DEMO_ART.length], i), width: 300}];
const DEMO_SONGS = [['Neon Afterglow', 'The Night Shift'], ['Slow Burn', 'Amber Coast'], ['Paper Planes at Dusk', 'Low Tide'], ['静かな夜', 'Kumo'], ['Golden Hour Drive', 'Sundays'],
  ['Velvet Static', 'Mira Lane'], ['Northern Lights', 'Fjord'], ['Coffee & Rain', 'Hollow Pines'], ['Midnight Bus', 'The Night Shift'], ['Satellite Heart', 'Amber Coast'],
  ['Warm Machines', 'Echo Park'], ['Lanterns', 'Low Tide']];
function demoTrack(i){ const [n, a] = DEMO_SONGS[i % DEMO_SONGS.length]; return {id: 't' + i, uri: 'spotify:track:demo' + i, name: n, artists: [{name: a}], duration_ms: 160000 + (i * 23117) % 120000, album: {name: a + ' — ' + ['Lights', 'Rooms', 'Weather', 'Sleep'][i % 4], images: demoImg(i)}}; }
function demoPlayer(){
  return {is_playing: true, progress_ms: 72000, shuffle_state: false, repeat_state: 'off', context: {uri: 'spotify:playlist:p0'},
    device: {name: 'Living room speaker', type: 'Speaker', volume_percent: 46, supports_volume: true},
    item: Object.assign(demoTrack(0), {duration_ms: 214000, album: {name: 'Lights', images: demoImg(0)}})};
}
function demoDevices(){
  return [{id: '1', name: 'Living room speaker', type: 'Speaker', is_active: true}, {id: '2', name: 'Kitchen', type: 'Speaker'}, {id: '3', name: 'Kyle\'s S24 Ultra', type: 'Smartphone'}, {id: '4', name: 'Shield TV', type: 'TV'}];
}
const DEMO_PL = ['Evening Wind Down', 'Saturday Kitchen', 'Focus Flow', 'Throwbacks', 'Gym Mode', 'Rainy Day', 'Dinner Party', 'Road Trip'];
function demoLib(){ return {items: DEMO_PL.map((n, i) => ({id: 'p' + i, uri: 'spotify:playlist:p' + i, name: n, owner: {display_name: i % 3 ? 'Kyle' : 'Spotify'}, images: demoImg(i + 1), items: {total: 20 + i * 7}}))}; }
function demoRecent(){ return {items: Array.from({length: 12}, (_, i) => ({track: demoTrack(i * 2 + 1), context: {uri: 'spotify:playlist:p' + [5, 2, 7, 5, 3][i % 5]}, played_at: new Date(Date.now() - (i + 1) * 600000).toISOString()}))}; }
function demoTracks(id, offset){ return {items: Array.from({length: 12}, (_, i) => ({item: demoTrack(i + offset + (String(id).length * 3))})), next: null}; }
function demoAlbum(id){ return {uri: 'spotify:album:' + id, name: 'Weather', artists: [{name: 'Low Tide'}], release_date: '2025-03-01', total_tracks: 10, images: demoImg(5), tracks: {items: Array.from({length: 10}, (_, i) => demoTrack(i + 3))}}; }
function demoSearch(q){
  return {tracks: {items: Array.from({length: 8}, (_, i) => demoTrack(i + q.length))},
    artists: {items: ['The Night Shift', 'Amber Coast', 'Low Tide', 'Mira Lane'].map((n, i) => ({uri: 'spotify:artist:a' + i, name: n, images: demoImg(i + 2)}))},
    albums: {items: Array.from({length: 6}, (_, i) => ({id: 'al' + i, uri: 'spotify:album:al' + i, name: ['Lights', 'Rooms', 'Weather', 'Sleep', 'Glow', 'Tides'][i], artists: [{name: DEMO_SONGS[i][1]}], images: demoImg(i + 3)}))},
    playlists: {items: DEMO_PL.slice(0, 6).map((n, i) => ({id: 'p' + i, uri: 'spotify:playlist:p' + i, name: n + ' Mix', owner: {display_name: 'Spotify'}, images: demoImg(i + 4)}))}};
}
let demoEvents = null;
function demoCalApi(action, data){
  if(!demoEvents){
    const t = dayStart(new Date()), at = (d, hr, mi, len) => { const s = new Date(+addDays(t, d)); s.setHours(hr, mi); return {start: s.toISOString(), end: new Date(+s + len * 60000).toISOString()}; };
    const ad = (d, n = 1) => ({allDay: true, start: ymd(addDays(t, d)), end: ymd(addDays(t, d + n))});
    demoEvents = [
      Object.assign({id: 'e1', title: 'Dinner at the Italian place', who: 'both', location: 'Town centre'}, at(0, 19, 30, 120)),
      Object.assign({id: 'e2', title: 'Gym', who: 'p1'}, at(1, 7, 0, 60)),
      Object.assign({id: 'e3', title: 'Hair appointment', who: 'p2'}, at(2, 10, 30, 90)),
      Object.assign({id: 'e4', title: 'Bin day', who: 'both', recurring: true}, ad(3)),
      Object.assign({id: 'e5', title: 'Cinema', who: 'both'}, at(5, 20, 0, 150)),
      Object.assign({id: 'e6', title: 'Dentist', who: 'p1'}, at(-3, 9, 15, 30)),
      Object.assign({id: 'e7', title: 'Weekend away', who: 'both', location: 'Lake District'}, ad(9, 3)),
      Object.assign({id: 'e8', title: 'Birthday drinks', who: 'p2'}, at(12, 19, 30, 180)),
      Object.assign({id: 'e9', title: 'Car MOT', who: 'p1'}, at(6, 8, 30, 60)),
      Object.assign({id: 'e10', title: 'Pick up parcel', who: 'p2'}, at(0, 16, 0, 30)),
      Object.assign({id: 'e11', title: 'Work drinks', who: 'p1'}, at(-6, 18, 0, 120)),
      Object.assign({id: 'e12', title: 'Book club', who: 'p2'}, at(-1, 19, 0, 90)),
      Object.assign({id: 'h1', title: 'St Andrew\'s Day', kind: 'holiday', readOnly: true}, ad(19)),
      Object.assign({id: 'h2', title: 'Christmas Day', kind: 'holiday', readOnly: true}, ad(44)),
      Object.assign({id: 'h3', title: 'Remembrance Sunday', kind: 'holiday', readOnly: true, observance: true}, ad(-3)),
      Object.assign({id: 'b1', title: 'Mum\'s birthday', kind: 'birthday', readOnly: true, recurring: true}, ad(4)),
      Object.assign({id: 'b2', title: 'Sam\'s birthday', kind: 'birthday', readOnly: true, recurring: true}, ad(15)),
    ].map(e => Object.assign({allDay: false, location: '', notes: '', color: '', recurring: false}, e));
  }
  if(action === 'list') return Promise.resolve({ok: true, name: 'Home', events: demoEvents});
  if(action === 'add'){ demoEvents.push(Object.assign({id: 'n' + Date.now(), color: '', recurring: false}, data)); }
  if(action === 'update'){ const i = demoEvents.findIndex(e => e.id === data.id); if(i >= 0) demoEvents[i] = Object.assign({}, demoEvents[i], data); }
  if(action === 'delete'){ demoEvents = demoEvents.filter(e => e.id !== data.id); }
  return sleep(300).then(() => ({ok: true}));
}

// =====================================================================
// Start
// =====================================================================
applyBg();
makeCard('curtain'); makeCard('strip'); makeCard('usb');
buildFx(); $$('#lTabs button').forEach(b => { b.onclick = () => showLightsTab(b.dataset.t); }); showLightsTab(ls.get('home.lightsTab', 'scenes')); buildScenes(); renderAlexa(); axReset();
$('#allOn').onclick = () => allPower(true); $('#allOff').onclick = () => allPower(false);
$('#axEditBtn').onclick = () => { openSheet('settings'); requestAnimationFrame(() => $('#axSec').scrollIntoView({block: 'start'})); };
bindSettings(); setFollow(follow);
render('curtain'); render('strip'); render('usb');
$('#oMotion').setAttribute('aria-checked', String(ls.get('home.motion', false))); $('#motionBox').hidden = !ls.get('home.motion', false);
{ const t = new Date(); CAL.month = new Date(t.getFullYear(), t.getMonth(), 1); CAL.sel = dayStart(t);
  const cached = ls.get('home.cal.cache', null); if(cached && !DEMO){ CAL.events = cached.map(parseEvent).filter(evShown).sort(byStart); } }
go(homeView());
tick(true); setInterval(() => tick(), 1000);
renderGn(); loadWeather();
spReturn().finally(spPoll);
if(calReady()) calLoad();
setInterval(() => { if(calReady()) calLoad(); }, 10 * 60000);
links.curtain.restore(); links.strip.restore(); links.usb.restore();
wake(); motionStart();
window.addEventListener('resize', debounce(() => { if(view === 'calendar') renderCal(); }, 200));
if('serviceWorker' in navigator && !DEMO) navigator.serviceWorker.register('sw.js').catch(() => {});
