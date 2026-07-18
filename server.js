const express = require('express');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3002;
const JWT_SECRET = 'fridge-sbody-2026';
const DB_PATH = path.join(__dirname, 'fridge.db');

// === DB Setup ===
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS families (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    invite_code TEXT UNIQUE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    family_id TEXT NOT NULL,
    name TEXT NOT NULL UNIQUE,
    avatar TEXT DEFAULT '😊',
    password TEXT NOT NULL,
    role TEXT DEFAULT 'member',
    created_at INTEGER NOT NULL,
    FOREIGN KEY (family_id) REFERENCES families(id)
  );

  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    family_id TEXT NOT NULL,
    name TEXT NOT NULL,
    category TEXT DEFAULT '其他',
    emoji TEXT DEFAULT '📦',
    unit TEXT DEFAULT '个',
    shared INTEGER DEFAULT 1,
    created_by TEXT,
    FOREIGN KEY (family_id) REFERENCES families(id)
  );

  CREATE TABLE IF NOT EXISTS inventory (
    id TEXT PRIMARY KEY,
    family_id TEXT NOT NULL,
    product_id TEXT,
    product_name TEXT NOT NULL,
    emoji TEXT DEFAULT '📦',
    quantity REAL DEFAULT 1,
    unit TEXT DEFAULT '个',
    expiry_date TEXT,
    location TEXT DEFAULT 'door-1',
    photo TEXT DEFAULT '',
    voice_note TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    added_by TEXT NOT NULL,
    added_by_name TEXT,
    added_at INTEGER NOT NULL,
    FOREIGN KEY (family_id) REFERENCES families(id)
  );

  CREATE TABLE IF NOT EXISTS activity (
    id TEXT PRIMARY KEY,
    family_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    user_id TEXT,
    user_name TEXT,
    action TEXT NOT NULL,
    product_name TEXT,
    emoji TEXT DEFAULT '📦',
    quantity REAL DEFAULT 1,
    unit TEXT DEFAULT '个',
    item_id TEXT,
    FOREIGN KEY (family_id) REFERENCES families(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    family_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (family_id, key),
    FOREIGN KEY (family_id) REFERENCES families(id)
  );
`);

// === Middleware ===
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Auth middleware
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录' });
  }
  try {
    const decoded = jwt.verify(header.slice(7), JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: '登录已过期' });
  }
}

// === Auth Routes ===

// Register
app.post('/api/register', async (req, res) => {
  try {
    const { name, password, avatar, familyName } = req.body;
    if (!name || !password || password.length < 4) {
      return res.status(400).json({ error: '名称和密码（至少4位）必填' });
    }

    // Check duplicate name
    const existing = db.prepare('SELECT id FROM members WHERE name = ?').get(name);
    if (existing) {
      return res.status(400).json({ error: '该名称已被使用' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const now = Date.now();
    const isFirst = db.prepare('SELECT COUNT(*) as c FROM members').get().c === 0;

    // Create family for first user
    let familyId;
    if (isFirst) {
      familyId = 'fam_' + now.toString(36);
      const code = Math.random().toString(36).slice(2, 8).toUpperCase();
      db.prepare('INSERT INTO families (id, name, invite_code, created_at) VALUES (?, ?, ?, ?)')
        .run(familyId, familyName || name + '的家', code, now);
    } else {
      // First user must exist (but we still allow reg without invite code for now)
      const firstFamily = db.prepare('SELECT id FROM families LIMIT 1').get();
      if (!firstFamily) {
        return res.status(400).json({ error: '请先联系管理员加入家庭' });
      }
      familyId = firstFamily.id;
    }

    const userId = 'u_' + now.toString(36);
    db.prepare('INSERT INTO members (id, family_id, name, avatar, password, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(userId, familyId, name, avatar || '😊', hashed, isFirst ? 'owner' : 'member', now);

    // Seed default products for new families
    if (isFirst) {
      const defaults = [
        ['牛奶','乳制品','🥛','盒'],['鸡蛋','蛋类','🥚','个'],['猪肉','肉类','🥩','份'],
        ['鸡肉','肉类','🍗','份'],['牛肉','肉类','🥩','份'],['虾','海鲜','🦐','份'],
        ['鱼','海鲜','🐟','条'],['白菜','蔬菜','🥬','颗'],['西红柿','蔬菜','🍅','个'],
        ['黄瓜','蔬菜','🥒','根'],['胡萝卜','蔬菜','🥕','根'],['苹果','水果','🍎','个'],
        ['香蕉','水果','🍌','根'],['橙子','水果','🍊','个'],['矿泉水','饮品','💧','瓶'],
        ['可乐','饮品','🥤','罐'],['啤酒','饮品','🍺','罐'],['酱油','调味品','🧂','瓶'],
        ['饺子','冷冻食品','🥟','份'],['冰淇淋','冷冻食品','🍦','盒'],['豆腐','其他','🫘','块'],
        ['面包','其他','🍞','袋'],['大米','干货','🍚','kg'],['面条','干货','🍜','把'],
        ['食用油','调味品','🫒','瓶']
      ];
      const insert = db.prepare('INSERT INTO products (id, family_id, name, category, emoji, unit, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const tx = db.transaction(() => {
        for (const [n, cat, em, u] of defaults) {
          insert.run('p_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6), familyId, n, cat, em, u, userId);
        }
      });
      tx();

      // Default settings
      db.prepare('INSERT OR IGNORE INTO settings (family_id, key, value) VALUES (?, ?, ?)').run(familyId, 'reminderDays', '3');
      db.prepare('INSERT OR IGNORE INTO settings (family_id, key, value) VALUES (?, ?, ?)').run(familyId, 'doorCount', '2');
    }

    const token = jwt.sign({ id: userId, familyId, name, avatar: avatar || '😊', role: isFirst ? 'owner' : 'member' }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: userId, name, avatar: avatar || '😊', role: isFirst ? 'owner' : 'member', familyId }, isFirst });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ error: '注册失败' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { name, password } = req.body;
    if (!name || !password) return res.status(400).json({ error: '请输入名称和密码' });

    const member = db.prepare('SELECT m.*, f.name as family_name, f.invite_code FROM members m JOIN families f ON m.family_id = f.id WHERE m.name = ?').get(name);
    if (!member) return res.status(400).json({ error: '用户不存在' });

    const match = await bcrypt.compare(password, member.password);
    if (!match) return res.status(400).json({ error: '密码错误' });

    const token = jwt.sign({
      id: member.id, familyId: member.family_id,
      name: member.name, avatar: member.avatar, role: member.role
    }, JWT_SECRET, { expiresIn: '30d' });

    res.json({ token, user: { id: member.id, name: member.name, avatar: member.avatar, role: member.role, familyId: member.family_id } });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: '登录失败' });
  }
});

// Get family members
app.get('/api/members', auth, (req, res) => {
  const members = db.prepare('SELECT id, name, avatar, role, created_at FROM members WHERE family_id = ?').all(req.user.familyId);
  res.json(members);
});

// Remove member
app.delete('/api/members/:id', auth, (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: '仅管理员可移除成员' });
  db.prepare('DELETE FROM members WHERE id = ? AND family_id = ?').run(req.params.id, req.user.familyId);
  res.json({ success: true });
});

// Get invite code
app.get('/api/family/invite', auth, (req, res) => {
  const family = db.prepare('SELECT invite_code FROM families WHERE id = ?').get(req.user.familyId);
  if (!family) return res.status(404).json({ error: '家庭不存在' });
  res.json({ code: family.invite_code, familyId: req.user.familyId });
});

// Join family via invite
app.post('/api/family/join', async (req, res) => {
  try {
    const { name, password, avatar, inviteCode } = req.body;
    if (!name || !password || !inviteCode) return res.status(400).json({ error: '请填写完整信息' });

    const family = db.prepare('SELECT id, name FROM families WHERE invite_code = ?').get(inviteCode.toUpperCase());
    if (!family) return res.status(400).json({ error: '邀请码无效' });

    const existing = db.prepare('SELECT id FROM members WHERE name = ?').get(name);
    if (existing) return res.status(400).json({ error: '该名称已被使用' });

    const hashed = await bcrypt.hash(password, 10);
    const userId = 'u_' + Date.now().toString(36);
    db.prepare('INSERT INTO members (id, family_id, name, avatar, password, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(userId, family.id, name, avatar || '😊', hashed, 'member', Date.now());

    const token = jwt.sign({ id: userId, familyId: family.id, name, avatar: avatar || '😊', role: 'member' }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: userId, name, avatar: avatar || '😊', role: 'member', familyId: family.id } });
  } catch (e) {
    console.error('Join error:', e);
    res.status(500).json({ error: '加入失败' });
  }
});

// === Data Routes (all require auth) ===

// Products
app.get('/api/products', auth, (req, res) => {
  const products = db.prepare('SELECT * FROM products WHERE family_id = ? ORDER BY category, name').all(req.user.familyId);
  res.json(products);
});

app.post('/api/products', auth, (req, res) => {
  const { name, category, emoji, unit } = req.body;
  if (!name) return res.status(400).json({ error: '名称必填' });
  const id = 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
  db.prepare('INSERT INTO products (id, family_id, name, category, emoji, unit, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.user.familyId, name, category || '其他', emoji || '📦', unit || '个', req.user.id);
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  res.json(product);
});

app.delete('/api/products/:id', auth, (req, res) => {
  db.prepare('DELETE FROM products WHERE id = ? AND family_id = ?').run(req.params.id, req.user.familyId);
  res.json({ success: true });
});

// Inventory
app.get('/api/inventory', auth, (req, res) => {
  const items = db.prepare('SELECT * FROM inventory WHERE family_id = ? ORDER BY expiry_date ASC').all(req.user.familyId);
  res.json(items);
});

app.post('/api/inventory', auth, (req, res) => {
  const { productId, productName, emoji, quantity, unit, expiryDate, location, photo, voiceNote, notes } = req.body;
  if (!productName) return res.status(400).json({ error: '名称必填' });
  const id = 'i_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
  const now = Date.now();
  const expiry = expiryDate || new Date(Date.now() + 7*86400000).toISOString().slice(0,10);
  const loc = location || 'door-1';
  const sts = new Date(expiry + 'T00:00:00') < new Date() ? 'expired' : 'active';

  db.prepare(`INSERT INTO inventory (id, family_id, product_id, product_name, emoji, quantity, unit, expiry_date, location, photo, voice_note, notes, status, added_by, added_by_name, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.user.familyId, productId || '', productName, emoji || '📦', quantity || 1, unit || '个',
      expiry, loc, photo || '', voiceNote || '', notes || '', sts,
      req.user.id, req.user.name, now);

  // Activity log
  const actId = 'a_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
  db.prepare('INSERT INTO activity (id, family_id, timestamp, user_id, user_name, action, product_name, emoji, quantity, unit, item_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(actId, req.user.familyId, now, req.user.id, req.user.name, 'add', productName, emoji || '📦', quantity || 1, unit || '个', id);

  const item = db.prepare('SELECT * FROM inventory WHERE id = ?').get(id);
  res.json(item);
});

// Update inventory item (consume/quantity change)
app.patch('/api/inventory/:id', auth, (req, res) => {
  const item = db.prepare('SELECT * FROM inventory WHERE id = ? AND family_id = ?').get(req.params.id, req.user.familyId);
  if (!item) return res.status(404).json({ error: '物品不存在' });

  const { quantity, status, expiryDate, location, notes } = req.body;
  if (quantity !== undefined) {
    if (quantity <= 0) {
      db.prepare('DELETE FROM inventory WHERE id = ?').run(req.params.id);
      // Activity: consume/remove
      const actId = 'a_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
      const action = (status === 'removed' || quantity < item.quantity) ? (quantity < item.quantity ? 'consume' : 'remove') : 'update';
      db.prepare('INSERT INTO activity (id, family_id, timestamp, user_id, user_name, action, product_name, emoji, quantity, unit, item_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(actId, req.user.familyId, Date.now(), req.user.id, req.user.name, action,
          item.product_name, item.emoji, Math.abs(item.quantity - quantity) || 1, item.unit, req.params.id);
      return res.json({ deleted: true });
    }
    db.prepare('UPDATE inventory SET quantity = ?, status = ? WHERE id = ?').run(quantity, status || 'active', req.params.id);
  }
  if (expiryDate) db.prepare('UPDATE inventory SET expiry_date = ? WHERE id = ?').run(expiryDate, req.params.id);
  if (location) db.prepare('UPDATE inventory SET location = ? WHERE id = ?').run(location, req.params.id);
  if (notes !== undefined) db.prepare('UPDATE inventory SET notes = ? WHERE id = ?').run(notes, req.params.id);

  const updated = db.prepare('SELECT * FROM inventory WHERE id = ?').get(req.params.id);
  res.json(updated);
});

app.delete('/api/inventory/:id', auth, (req, res) => {
  const item = db.prepare('SELECT * FROM inventory WHERE id = ? AND family_id = ?').get(req.params.id, req.user.familyId);
  if (!item) return res.status(404).json({ error: '物品不存在' });

  db.prepare('DELETE FROM inventory WHERE id = ?').run(req.params.id);
  const actId = 'a_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
  db.prepare('INSERT INTO activity (id, family_id, timestamp, user_id, user_name, action, product_name, emoji, quantity, unit, item_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(actId, req.user.familyId, Date.now(), req.user.id, req.user.name, 'remove',
      item.product_name, item.emoji, item.quantity, item.unit, req.params.id);
  res.json({ success: true });
});

// Activity
app.get('/api/activity', auth, (req, res) => {
  const activities = db.prepare('SELECT * FROM activity WHERE family_id = ? ORDER BY timestamp DESC LIMIT 50').all(req.user.familyId);
  res.json(activities);
});

// Settings
app.get('/api/settings', auth, (req, res) => {
  const settings = db.prepare('SELECT key, value FROM settings WHERE family_id = ?').all(req.user.familyId);
  const obj = {};
  for (const s of settings) obj[s.key] = s.value;
  res.json(obj);
});

app.post('/api/settings', auth, (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'key 必填' });
  db.prepare('INSERT OR REPLACE INTO settings (family_id, key, value) VALUES (?, ?, ?)').run(req.user.familyId, key, String(value));
  res.json({ success: true });
});

// === Start ===
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Fridge API running on port ${PORT}`);
});
