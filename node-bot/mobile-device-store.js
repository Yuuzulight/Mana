const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.MANA_MOBILE_DEVICES_DIR || path.join(__dirname, 'data');
const FILE_PATH = path.join(DATA_DIR, 'mobile-devices.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

class MobileDeviceStore {
  constructor(filePath = FILE_PATH) {
    this.filePath = filePath;
    ensureDataDir();
    this._load();
    // in-memory pairing codes: code -> { expiresAt, used }
    this._codes = new Map();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const txt = fs.readFileSync(this.filePath, 'utf8') || '[]';
        this.devices = JSON.parse(txt || '[]');
      } else {
        this.devices = [];
        this._persist();
      }
    } catch (e) {
      console.warn('Failed to load mobile devices store:', e.message || e);
      this.devices = [];
    }
  }

  _persist() {
    try {
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.devices, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (e) {
      console.warn('Failed to persist mobile devices store:', e.message || e);
    }
  }

  _nowMs() { return Date.now(); }

  generatePairingCode(ttlMinutes = 5) {
    const code = (Math.floor(100000 + Math.random() * 900000)).toString(); // 6-digit
    const expiresAt = this._nowMs() + ttlMinutes * 60 * 1000;
    this._codes.set(code, { expiresAt, used: false });
    return { code, expiresAt };
  }

  consumePairingCode(code) {
    const entry = this._codes.get(code);
    if (!entry) return false;
    if (entry.used) return false;
    if (entry.expiresAt < this._nowMs()) { this._codes.delete(code); return false; }
    entry.used = true;
    this._codes.delete(code);
    return true;
  }

  _makeId() {
    return crypto.randomBytes(6).toString('hex');
  }

  addDevice({ name, token, allowMemorySync = false }) {
    const id = this._makeId();
    const tokenHash = sha256Hex(token);
    const d = {
      id,
      name: String(name || '').slice(0, 128),
      tokenHash,
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
      revoked: false,
      allowMemorySync: !!allowMemorySync,
    };
    this.devices.push(d);
    this._persist();
    return d;
  }

  listDevices() {
    return JSON.parse(JSON.stringify(this.devices));
  }

  findDeviceByToken(token) {
    const h = sha256Hex(token);
    return this.devices.find(d => !d.revoked && d.tokenHash === h) || null;
  }

  findDeviceById(id) {
    return this.devices.find(d => d.id === id) || null;
  }

  updateLastSeen(id) {
    const d = this.findDeviceById(id);
    if (!d) return false;
    d.lastSeenAt = new Date().toISOString();
    this._persist();
    return true;
  }

  revokeDevice(id) {
    const d = this.findDeviceById(id);
    if (!d) return false;
    d.revoked = true;
    this._persist();
    return true;
  }

  rotateToken(id, newToken) {
    const d = this.findDeviceById(id);
    if (!d) return false;
    d.tokenHash = sha256Hex(newToken);
    d.revoked = false;
    this._persist();
    return true;
  }
}

module.exports = {
  MobileDeviceStore,
  sha256Hex,
};
