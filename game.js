// Coinstep — walk around, catch coins, turn steps into magnets and chests.
const BASE_RADIUS_M = 40;
const MAGNET_RADIUS_M = 100;
const MAGNET_MS = 120000;
const STEPS_PER_MAGNET = 250;
const MAX_MAGNETS = 3;
const MAX_WALK_SPEED = 8.5;      // m/s; about 30 km/h, faster than this is a vehicle
const MIN_GPS_MOVE_M = 3;        // smaller moves are GPS jitter
const MAX_GPS_ACCURACY_M = 30;
const STOPPED_AFTER_MS = 10000;  // this long without moving clears the vehicle check
const DEMO_SPEED = 6;            // m/s
const DEMO_START = { lat: 3.1390, lon: 101.6869 };
const DAILY_GOAL = 10000;

const GOALS = [
  { steps: 2000, reward: { silver: 2 } },
  { steps: 5000, reward: { silver: 5 } },
  { steps: 10000, reward: { gold: 2 } },
];

const CHESTS = [
  { name: 'Wooden chest', steps: 300, weight: 60, reward: { bronze: [5, 10] } },
  { name: 'Iron chest', steps: 800, weight: 30, reward: { bronze: [10, 20], silver: [2, 4] } },
  { name: 'Brass chest', steps: 2000, weight: 10, reward: { silver: [5, 8], gold: [1, 3] } },
];

const $ = id => document.getElementById(id);

function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function yesterdayKey() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return dayKey(date);
}

function randomBetween(low, high) {
  return low + Math.floor(Math.random() * (high - low + 1));
}

function pickChest() {
  let roll = Math.random() * CHESTS.reduce((sum, chest) => sum + chest.weight, 0);
  const chest = CHESTS.find(c => (roll -= c.weight) < 0) || CHESTS[0];
  return { index: CHESTS.indexOf(chest), progress: 0 };
}

function freshState() {
  return {
    wallet: { bronze: 0, silver: 0, gold: 0 },
    xp: 0,
    day: dayKey(),
    stepsToday: 0,
    metersToday: 0,
    totalSteps: 0,
    totalMeters: 0,
    history: {},
    goalsReached: 0,
    streak: 0,
    streakDay: null,
    magnets: 1,
    magnetSteps: 0,
    magnetUntil: 0,
    chest: pickChest(),
    collected: { window: 0, ids: [] },
  };
}

// --- Saving ---
let saveKey = 'coinstep.save';
let state = freshState();
let saveTimer = null;

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(saveKey));
    if (saved) state = { ...freshState(), ...saved };
  } catch (e) { /* no saved game, or storage is blocked */ }
}

function saveState() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { localStorage.setItem(saveKey, JSON.stringify(state)); } catch (e) { /* storage is blocked */ }
  }, 500);
}

// --- Daily rollover ---
function rollDay() {
  if (state.day === dayKey()) return;
  state.history[state.day] = state.stepsToday;
  state.day = dayKey();
  state.stepsToday = 0;
  state.metersToday = 0;
  state.goalsReached = 0;
}

// --- Rewards ---
function pay(reward) {
  for (const type in reward) {
    state.wallet[type] += reward[type];
    state.xp += COIN_TYPES[type].xp * reward[type];
  }
}

function describe(reward) {
  return Object.keys(reward).map(type => `${reward[type]} ${COIN_TYPES[type].name.toLowerCase()}`).join(' and ');
}

function level() {
  return Math.floor(Math.sqrt(state.xp / 100)) + 1;
}

function walletValue() {
  return Object.keys(state.wallet).reduce((sum, type) => sum + state.wallet[type] * COIN_TYPES[type].value, 0);
}

// --- Steps ---
let stepSource = 'Waiting for steps';

function addSteps(count, source) {
  rollDay();
  stepSource = source;
  state.stepsToday += count;
  state.totalSteps += count;
  state.xp += count / 10;

  state.chest.progress = Math.min(CHESTS[state.chest.index].steps, state.chest.progress + count);

  state.magnetSteps += count;
  while (state.magnetSteps >= STEPS_PER_MAGNET) {
    state.magnetSteps -= STEPS_PER_MAGNET;
    if (state.magnets < MAX_MAGNETS) {
      state.magnets++;
      toast('Your steps charged a magnet');
    }
  }

  while (state.goalsReached < GOALS.length && state.stepsToday >= GOALS[state.goalsReached].steps) {
    const goal = GOALS[state.goalsReached++];
    pay(goal.reward);
    toast(`${goal.steps.toLocaleString()} steps: +${describe(goal.reward)}`);
    if (goal === GOALS[0]) {
      state.streak = state.streakDay === yesterdayKey() ? state.streak + 1 : 1;
      state.streakDay = dayKey();
    }
  }
  saveState();
  renderHud();
}

// --- Position ---
let player = null;
let lastCounted = null;
let walkSpeed = 0;
let lastFixTime = 0;
let accuracy = null;
let lastMotionAt = 0;
let demo = false;

function catchRadius() {
  return Date.now() < state.magnetUntil ? MAGNET_RADIUS_M : BASE_RADIUS_M;
}

function isDriving() {
  return walkSpeed > MAX_WALK_SPEED;
}

function moveTo(lat, lon) {
  player = { lat, lon };
  const point = [lat, lon];
  playerMarker.setLatLng(point);
  radiusCircle.setLatLng(point);
  map.setView(point, map.getZoom(), { animate: !demo });
  renderCoins();
  renderHud();
}

function onGpsFix(position) {
  const { latitude: lat, longitude: lon, accuracy: fixAccuracy, speed } = position.coords;
  const now = position.timestamp || Date.now();
  if (!player) enterMap(lat, lon);
  accuracy = fixAccuracy;

  if (lastCounted && fixAccuracy <= MAX_GPS_ACCURACY_M) {
    const moved = distanceMeters(lastCounted, { lat, lon });
    if (moved >= MIN_GPS_MOVE_M) {
      const seconds = Math.max(1, (now - lastFixTime) / 1000);
      walkSpeed = speed != null ? speed : moved / seconds;
      if (!isDriving()) {
        state.metersToday += moved;
        state.totalMeters += moved;
        // Phones without a working motion sensor still earn steps from distance walked.
        if (Date.now() - lastMotionAt > 3000) addSteps(Math.round(moved / STEP_LENGTH_M), 'Estimated from GPS');
      }
      lastCounted = { lat, lon };
      lastFixTime = now;
    } else if (now - lastFixTime > STOPPED_AFTER_MS) {
      walkSpeed = 0;
    }
  } else if (!lastCounted) {
    lastCounted = { lat, lon };
    lastFixTime = now;
  }
  moveTo(lat, lon);
}

function onGpsError(error) {
  if (player) {
    $('status').textContent = 'GPS signal lost. Coins resume when it returns.';
    $('status').className = 'warn';
    return;
  }
  const messages = {
    1: 'Location is turned off for this site. Allow it in your browser settings and reload, or try the demo walk.',
    2: 'Your phone could not get a location. Turn on location services and try again.',
    3: 'Finding you is taking too long. Step outside for a clearer GPS signal and try again.',
  };
  showStartMessage(messages[error.code] || messages[2]);
}

// --- Motion sensor ---
const detector = new StepDetector(count => addSteps(count, 'Motion sensor'));

function onMotion(event) {
  const a = event.accelerationIncludingGravity;
  if (!a || a.x === null) return;
  lastMotionAt = Date.now();
  if (!isDriving()) detector.push(a.x, a.y, a.z, performance.now());
}

async function startMotion() {
  if (typeof DeviceMotionEvent === 'undefined') return;
  try {
    // iPhones must ask for motion access from inside a tap.
    if (DeviceMotionEvent.requestPermission) {
      if (await DeviceMotionEvent.requestPermission() !== 'granted') return;
    }
    addEventListener('devicemotion', onMotion);
  } catch (e) { /* steps fall back to GPS distance */ }
}

// --- Screen wake lock ---
let wakeLock = null;

async function keepScreenOn() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) { /* the phone refused; the game still runs */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && player && !demo) keepScreenOn();
});

// --- Map ---
let map, playerMarker, radiusCircle;
const coinMarkers = new Map();

function buildMap(lat, lon) {
  map = L.map('map', {
    center: [lat, lon], zoom: 18, minZoom: 16, maxZoom: 19,
    zoomControl: false, dragging: false, doubleClickZoom: false, keyboard: false,
    touchZoom: 'center', scrollWheelZoom: 'center',
  });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  radiusCircle = L.circle([lat, lon], {
    radius: BASE_RADIUS_M, color: '#e6b94d', weight: 1.5, fillColor: '#e6b94d', fillOpacity: 0.08, interactive: false,
  }).addTo(map);
  playerMarker = L.marker([lat, lon], {
    icon: L.divIcon({ className: 'coin-marker', html: '<div class="player"></div>', iconSize: [22, 22] }),
    interactive: false, zIndexOffset: 1000,
  }).addTo(map);
}

function coinIcon(coin) {
  const size = { bronze: 28, silver: 32, gold: 38 }[coin.type];
  return L.divIcon({
    className: 'coin-marker',
    html: `<div class="coin ${coin.type}">${COIN_TYPES[coin.type].value}</div>`,
    iconSize: [size, size],
  });
}

function pruneCollected() {
  const window = spawnWindow(Date.now());
  if (state.collected.window !== window) state.collected = { window, ids: [] };
}

function renderCoins() {
  pruneCollected();
  const radius = catchRadius();
  radiusCircle.setRadius(radius);
  const visible = coinsNear(player.lat, player.lon, Date.now())
    .filter(coin => !state.collected.ids.includes(coin.id));
  const ids = new Set(visible.map(coin => coin.id));

  for (const [id, entry] of coinMarkers) {
    if (!ids.has(id)) {
      entry.marker.remove();
      coinMarkers.delete(id);
    }
  }

  let nearest = null;
  for (const coin of visible) {
    let entry = coinMarkers.get(coin.id);
    if (!entry) {
      const marker = L.marker([coin.lat, coin.lon], { icon: coinIcon(coin), keyboard: false }).addTo(map);
      marker.on('click', () => tapCoin(coin));
      entry = { marker };
      coinMarkers.set(coin.id, entry);
    }
    const meters = distanceMeters(player, coin);
    if (!nearest || meters < nearest.meters) nearest = { coin, meters };
    const element = entry.marker.getElement();
    if (element) element.firstChild.classList.toggle('in-range', meters <= radius);
  }

  if (!nearest) $('nearest').textContent = 'No coins nearby. Keep walking.';
  else if (nearest.meters <= radius) $('nearest').textContent = `${COIN_TYPES[nearest.coin.type].name} coin in range. Tap it.`;
  else $('nearest').textContent = `Nearest: ${COIN_TYPES[nearest.coin.type].name.toLowerCase()} coin, ${Math.round(nearest.meters)} m ${compassPoint(player, nearest.coin)}`;
}

function tapCoin(coin) {
  if (isDriving()) return toast('Coins pause while you are in a vehicle');
  const meters = distanceMeters(player, coin);
  if (meters > catchRadius()) return toast(`Too far: walk ${Math.round(meters - catchRadius())} m closer`);
  openCatch(coin);
}

// --- Catching ---
let round = null;
const canvas = $('catchCanvas');
const ctx = canvas.getContext('2d');

function newArc() {
  return Math.random() * Math.PI * 2;
}

function openCatch(coin) {
  const type = COIN_TYPES[coin.type];
  round = {
    coin, type, tries: type.tries, angle: 0, arc: newArc(),
    half: (type.arc * Math.PI) / 180, last: performance.now(), done: false,
  };
  $('catchTitle').textContent = `${type.name} coin`;
  $('catchHint').textContent = 'Tap when the marker crosses the bright arc';
  renderTries();
  $('catchLeave').hidden = false;
  $('catch').hidden = false;
  requestAnimationFrame(drawCatch);
}

function renderTries() {
  $('catchTries').textContent = `${round.tries} ${round.tries === 1 ? 'try' : 'tries'} left`;
}

function angleGap(a, b) {
  const gap = Math.abs(a - b) % (Math.PI * 2);
  return gap > Math.PI ? Math.PI * 2 - gap : gap;
}

function strike() {
  if (!round || round.done) return;
  const gap = angleGap(round.angle, round.arc);
  if (gap <= round.half) {
    const perfect = gap <= round.half / 3;
    const reward = { [round.coin.type]: perfect ? 2 : 1 };
    pay(reward);
    markCollected(round.coin);
    ding(perfect ? 1320 : 880);
    if (navigator.vibrate) navigator.vibrate(perfect ? [40, 40, 80] : 50);
    endCatch(perfect ? `Perfect strike! +${describe(reward)}` : `Caught! +${describe(reward)}`);
    return;
  }
  round.tries--;
  if (navigator.vibrate) navigator.vibrate(120);
  if (round.tries === 0) {
    markCollected(round.coin);
    endCatch('It rolled away');
    return;
  }
  round.arc = newArc();
  renderTries();
  $('catchHint').textContent = 'Missed. The arc moved.';
}

function markCollected(coin) {
  pruneCollected();
  state.collected.ids.push(coin.id);
  saveState();
}

function endCatch(message) {
  round.done = true;
  $('catchHint').textContent = message;
  $('catchTries').textContent = '';
  $('catchLeave').hidden = true;
  renderHud();
  setTimeout(closeCatch, 1100);
}

function closeCatch() {
  round = null;
  $('catch').hidden = true;
  if (player) renderCoins();
}

function drawCatch(now) {
  if (!round) return;
  const seconds = (now - round.last) / 1000;
  round.last = now;
  if (!round.done) round.angle = (round.angle + (seconds / round.type.lapSeconds) * Math.PI * 2) % (Math.PI * 2);

  const center = canvas.width / 2;
  const rim = 280;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.lineCap = 'butt';
  ctx.lineWidth = 34;
  ctx.strokeStyle = '#2c5a51';
  ctx.beginPath();
  ctx.arc(center, center, rim, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = '#e6b94d';
  ctx.beginPath();
  ctx.arc(center, center, rim, round.arc - round.half, round.arc + round.half);
  ctx.stroke();
  ctx.strokeStyle = '#fff4c9';
  ctx.beginPath();
  ctx.arc(center, center, rim, round.arc - round.half / 3, round.arc + round.half / 3);
  ctx.stroke();

  // The coin turns on its edge, so its width follows a cosine.
  const metal = { bronze: '#c67c3e', silver: '#cdd8dc', gold: '#f4c430' }[round.coin.type];
  const face = Math.max(0.12, Math.abs(Math.cos(now / 420)));
  ctx.save();
  ctx.translate(center, center);
  ctx.scale(face, 1);
  ctx.fillStyle = metal;
  ctx.beginPath();
  ctx.arc(0, 0, 170, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 12;
  ctx.strokeStyle = 'rgba(0, 0, 0, .25)';
  ctx.beginPath();
  ctx.arc(0, 0, 146, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = 'rgba(0, 0, 0, .6)';
  ctx.font = "800 120px Cinzel, Georgia, serif";
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(round.type.value, 0, 8);
  ctx.restore();

  ctx.fillStyle = '#eef3e6';
  ctx.strokeStyle = '#0d2a26';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(center + Math.cos(round.angle) * rim, center + Math.sin(round.angle) * rim, 24, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  requestAnimationFrame(drawCatch);
}

let audio = null;

function ding(frequency) {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const tone = audio.createOscillator();
    const volume = audio.createGain();
    tone.frequency.value = frequency;
    volume.gain.setValueAtTime(0.15, audio.currentTime);
    volume.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.35);
    tone.connect(volume).connect(audio.destination);
    tone.start();
    tone.stop(audio.currentTime + 0.35);
  } catch (e) { /* sound is optional */ }
}

// --- Magnet and chest ---
function useMagnet() {
  if (Date.now() < state.magnetUntil) return toast('Your magnet is already on');
  if (state.magnets === 0) return toast(`Walk ${STEPS_PER_MAGNET - state.magnetSteps} more steps to charge a magnet`);
  state.magnets--;
  state.magnetUntil = Date.now() + MAGNET_MS;
  saveState();
  renderCoins();
  renderHud();
  toast(`Catch range is ${MAGNET_RADIUS_M} m for 2 minutes`);
}

function openChest() {
  const chest = CHESTS[state.chest.index];
  if (state.chest.progress < chest.steps) {
    return toast(`${chest.name}: ${(chest.steps - state.chest.progress).toLocaleString()} steps to go`);
  }
  const reward = {};
  for (const type in chest.reward) reward[type] = randomBetween(...chest.reward[type]);
  pay(reward);
  state.chest = pickChest();
  ding(660);
  saveState();
  renderHud();
  toast(`${chest.name} opened: +${describe(reward)}`);
}

// --- Display ---
let toastTimer = null;

function toast(message) {
  const element = $('toast');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.hidden = true; }, 2600);
}

function renderHud() {
  for (const type in state.wallet) $(`${type}Count`).textContent = state.wallet[type].toLocaleString();

  const lv = level();
  const floor = (lv - 1) ** 2 * 100;
  const ceiling = lv ** 2 * 100;
  $('level').textContent = lv;
  $('levelFill').style.width = `${((state.xp - floor) / (ceiling - floor)) * 100}%`;

  $('stepCount').textContent = state.stepsToday.toLocaleString();
  const next = GOALS[state.goalsReached];
  $('goalLabel').textContent = next ? `Next reward: ${describe(next.reward)} at ${next.steps.toLocaleString()}` : 'All daily rewards earned';
  $('goalFill').style.width = `${Math.min(100, (state.stepsToday / (next ? next.steps : DAILY_GOAL)) * 100)}%`;
  $('stepSource').textContent = stepSource;

  const magnetSeconds = Math.ceil((state.magnetUntil - Date.now()) / 1000);
  $('magnetBtn').classList.toggle('active', magnetSeconds > 0);
  $('magnetCount').textContent = magnetSeconds > 0 ? `${magnetSeconds}s` : `${state.magnets}/${MAX_MAGNETS}`;

  const chest = CHESTS[state.chest.index];
  const ready = state.chest.progress >= chest.steps;
  $('chestBtn').classList.toggle('ready', ready);
  $('chestProgress').textContent = ready ? 'Open' : `${Math.floor((state.chest.progress / chest.steps) * 100)}%`;
  $('chestLabel').textContent = chest.name;

  $('totalValue').textContent = walletValue().toLocaleString();

  if (demo) {
    $('status').textContent = 'Demo walk: arrow keys or the pad move you. Progress is kept apart from real walks.';
    $('status').className = '';
  } else if (isDriving()) {
    $('status').textContent = 'Moving too fast. Coins and steps pause in a vehicle.';
    $('status').className = 'warn';
  } else {
    $('status').textContent = accuracy === null ? '' : `GPS accurate to ${Math.round(accuracy)} m`;
    $('status').className = '';
  }
}

function openLedger() {
  rollDay();
  const rows = [
    ['Coin value', walletValue().toLocaleString()],
    ['Level', level()],
    ['Walking streak', `${state.streak} ${state.streak === 1 ? 'day' : 'days'}`],
    ['Distance today', `${(state.metersToday / 1000).toFixed(2)} km`],
    ['Lifetime steps', Math.round(state.totalSteps).toLocaleString()],
    ['Lifetime distance', `${(state.totalMeters / 1000).toFixed(1)} km`],
  ];
  $('ledgerStats').replaceChildren(...rows.flatMap(([label, value]) => {
    const term = document.createElement('dt');
    const detail = document.createElement('dd');
    term.textContent = label;
    detail.textContent = value;
    return [term, detail];
  }));

  const days = [];
  for (let back = 0; back < 7; back++) {
    const date = new Date();
    date.setDate(date.getDate() - back);
    const key = dayKey(date);
    const row = document.createElement('tr');
    const name = document.createElement('td');
    const steps = document.createElement('td');
    name.textContent = back === 0 ? 'Today' : date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    steps.textContent = (back === 0 ? state.stepsToday : state.history[key] || 0).toLocaleString();
    row.append(name, steps);
    days.push(row);
  }
  $('ledgerDays').replaceChildren(...days);
  $('ledger').hidden = false;
}

// --- Starting a walk ---
function showStartMessage(message) {
  const element = $('startMessage');
  element.textContent = message;
  element.hidden = false;
  $('startBtn').disabled = false;
  $('startBtn').textContent = 'Start walking';
}

function enterMap(lat, lon) {
  loadState();
  rollDay();
  buildMap(lat, lon);
  player = { lat, lon };
  $('start').hidden = true;
  $('top').hidden = false;
  $('bottom').hidden = false;
  map.invalidateSize();
  setInterval(() => { if (player) { renderCoins(); renderHud(); } }, 1000);
}

function startWalking() {
  if (typeof L === 'undefined') return showStartMessage('The map could not load. Check your internet connection and reload.');
  if (!window.isSecureContext) return showStartMessage('Location only works on a secure https:// address. Open the https link for this game.');
  if (!navigator.geolocation) return showStartMessage('This browser has no location support. Try the demo walk.');
  $('startMessage').hidden = true;
  $('startBtn').disabled = true;
  $('startBtn').textContent = 'Finding you…';
  startMotion();
  keepScreenOn();
  navigator.geolocation.watchPosition(onGpsFix, onGpsError, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
}

// --- Demo walk ---
const held = new Set();
const KEY_DIRECTIONS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
let demoTime = 0;

function demoLoop(now) {
  const seconds = Math.min(0.1, (now - demoTime) / 1000);
  demoTime = now;
  if (held.size && !round) {
    const meters = DEMO_SPEED * seconds;
    const degrees = meters / 111320;
    const north = (held.has('up') ? 1 : 0) - (held.has('down') ? 1 : 0);
    const east = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0);
    if (north || east) {
      state.metersToday += meters;
      state.totalMeters += meters;
      demoSteps += meters / STEP_LENGTH_M;
      if (demoSteps >= 1) {
        const whole = Math.floor(demoSteps);
        demoSteps -= whole;
        addSteps(whole, 'Simulated for the demo');
      }
      moveTo(player.lat + north * degrees, player.lon + (east * degrees) / Math.cos(player.lat * Math.PI / 180));
    }
  }
  requestAnimationFrame(demoLoop);
}
let demoSteps = 0;

function startDemo() {
  if (typeof L === 'undefined') return showStartMessage('The map could not load. Check your internet connection and reload.');
  demo = true;
  saveKey = 'coinstep.demo';
  enterMap(DEMO_START.lat, DEMO_START.lon);
  $('demoPad').hidden = false;
  moveTo(DEMO_START.lat, DEMO_START.lon);
  demoTime = performance.now();
  requestAnimationFrame(demoLoop);
}

addEventListener('keydown', e => {
  if (KEY_DIRECTIONS[e.key]) { held.add(KEY_DIRECTIONS[e.key]); e.preventDefault(); }
});
addEventListener('keyup', e => held.delete(KEY_DIRECTIONS[e.key]));
for (const button of $('demoPad').children) {
  button.addEventListener('pointerdown', () => held.add(button.dataset.dir));
  button.addEventListener('pointerup', () => held.delete(button.dataset.dir));
  button.addEventListener('pointerleave', () => held.delete(button.dataset.dir));
}

$('startBtn').addEventListener('click', startWalking);
$('demoBtn').addEventListener('click', startDemo);
$('catchCanvas').addEventListener('pointerdown', strike);
$('catchLeave').addEventListener('click', closeCatch);
$('magnetBtn').addEventListener('click', useMagnet);
$('chestBtn').addEventListener('click', openChest);
$('ledgerBtn').addEventListener('click', openLedger);
$('ledgerClose').addEventListener('click', () => { $('ledger').hidden = true; });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
