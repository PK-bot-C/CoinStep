// Coinstep world rules — coin spawning, map maths and step detection. No DOM or map code here.
const COIN_TYPES = {
  bronze: { name: 'Bronze', value: 1, xp: 10, tries: 3, arc: 40, lapSeconds: 1.7 },
  silver: { name: 'Silver', value: 5, xp: 30, tries: 3, arc: 28, lapSeconds: 1.35 },
  gold: { name: 'Gold', value: 25, xp: 100, tries: 2, arc: 18, lapSeconds: 1.05 },
};

const CELL_DEGREES = 0.001;      // about 110 m north to south
const SPAWN_WINDOW_MS = 3600000; // coins move to new spots every hour
const STEP_LENGTH_M = 0.75;

function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededRandom(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function spawnWindow(time) {
  return Math.floor(time / SPAWN_WINDOW_MS);
}

// Columns get wider in degrees away from the equator so cells stay roughly square.
function lonDegrees(row) {
  return CELL_DEGREES / Math.max(0.2, Math.cos((row * CELL_DEGREES * Math.PI) / 180));
}

function coinsInCell(row, col, window) {
  const random = seededRandom(hashString(`${row}:${col}:${window}`));
  const roll = random();
  const count = roll < 0.3 ? 0 : roll < 0.7 ? 1 : roll < 0.92 ? 2 : 3;
  const width = lonDegrees(row);
  const coins = [];
  for (let i = 0; i < count; i++) {
    const rarity = random();
    coins.push({
      id: `${row}:${col}:${window}:${i}`,
      type: rarity < 0.04 ? 'gold' : rarity < 0.26 ? 'silver' : 'bronze',
      lat: (row + random()) * CELL_DEGREES,
      lon: (col + random()) * width,
    });
  }
  return coins;
}

// Everyone at the same place in the same hour sees the same coins.
function coinsNear(lat, lon, time, reach = 4) {
  const window = spawnWindow(time);
  const centerRow = Math.floor(lat / CELL_DEGREES);
  const coins = [];
  for (let row = centerRow - reach; row <= centerRow + reach; row++) {
    const centerCol = Math.floor(lon / lonDegrees(row));
    for (let col = centerCol - reach; col <= centerCol + reach; col++) {
      coins.push(...coinsInCell(row, col, window));
    }
  }
  return coins;
}

function distanceMeters(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

function compassPoint(a, b) {
  const rad = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad)
    - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
  const degrees = (Math.atan2(y, x) / rad + 360) % 360;
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(degrees / 45) % 8];
}

// Counts steps from accelerometer samples. A step is a peak in acceleration, and
// nothing is counted until four land in a walking rhythm, so a single shake scores 0.
class StepDetector {
  constructor(onSteps) {
    this.onSteps = onSteps;
    this.gravity = null;
    this.smooth = 0;
    this.peak = 0;
    this.lastStep = 0;
    this.run = 0;
  }

  push(x, y, z, time) {
    const magnitude = Math.sqrt(x * x + y * y + z * z);
    if (this.gravity === null) this.gravity = magnitude;
    this.gravity += (magnitude - this.gravity) * 0.02;
    this.smooth += (magnitude - this.gravity - this.smooth) * 0.3;

    if (this.smooth > this.peak) this.peak = this.smooth;
    if (this.smooth < 0 && this.peak > 0) {
      if (this.peak >= StepDetector.PEAK_THRESHOLD) this.registerPeak(time);
      this.peak = 0;
    }
  }

  registerPeak(time) {
    const gap = time - this.lastStep;
    if (gap < StepDetector.MIN_GAP_MS) return;
    this.lastStep = time;
    this.run = gap <= StepDetector.MAX_GAP_MS ? this.run + 1 : 1;
    if (this.run === StepDetector.RHYTHM_STEPS) this.onSteps(StepDetector.RHYTHM_STEPS);
    else if (this.run > StepDetector.RHYTHM_STEPS) this.onSteps(1);
  }
}
StepDetector.PEAK_THRESHOLD = 1.0; // m/s² above gravity
StepDetector.MIN_GAP_MS = 250;
StepDetector.MAX_GAP_MS = 2000;
StepDetector.RHYTHM_STEPS = 4;
