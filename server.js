require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');

const { MONGODB_URI, DB_NAME = 'dental_clinic', ADMIN_USER, ADMIN_PASS, PORT = 3000 } = process.env;
if (!MONGODB_URI || !ADMIN_USER || !ADMIN_PASS) {
  console.error('Missing MONGODB_URI, ADMIN_USER or ADMIN_PASS. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const SLOTS = ['10:00 am','10:30 am','11:00 am','11:30 am','12:00 pm','12:30 pm','1:00 pm','1:30 pm',
               '5:00 pm','5:30 pm','6:00 pm','6:30 pm','7:00 pm','7:30 pm','8:00 pm','8:30 pm'];
const SERVICES = ['Check-up','Teeth cleaning','Teeth whitening','Root canal','Smile designing','Dental implants',
                  'Dentures and bridges','Veneers and crowns','Fillings and sealants','Teeth reshaping',
                  'Extraction','Oral surgery','Not sure, need advice'];
const STATUSES = ['pending', 'confirmed', 'cancelled'];

const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const validDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) &&
  new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;

// Constant-time string compare
const same = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
function adminAuth(req, res, next) {
  const [type, token] = (req.headers.authorization || '').split(' ');
  if (type === 'Basic' && token) {
    const i = Buffer.from(token, 'base64').toString().indexOf(':');
    const dec = Buffer.from(token, 'base64').toString();
    if (i > -1 && same(dec.slice(0, i), ADMIN_USER) && same(dec.slice(i + 1), ADMIN_PASS)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Clinic admin"').status(401).send('Login required');
}

async function main() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const col = client.db(DB_NAME).collection('appointments');
  // One active booking per date + time (cancelled bookings free the slot)
  await col.createIndex({ date: 1, time: 1 }, { unique: true, partialFilterExpression: { active: true } });
  console.log('Connected to MongoDB Atlas');

  const app = express();
  app.use(express.json({ limit: '10kb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  // Booked slots for a date
  app.get('/api/slots', async (req, res) => {
    try {
      if (!validDate(req.query.date)) return res.status(400).json({ ok: false, error: 'Invalid date' });
      const taken = await col.find({ date: req.query.date, active: true }).project({ time: 1, _id: 0 }).toArray();
      res.json({ ok: true, taken: taken.map((t) => t.time) });
    } catch (e) { console.error(e); res.status(500).json({ ok: false, error: 'Server error' }); }
  });

  // New booking
  app.post('/api/appointments', async (req, res) => {
    try {
      const b = req.body || {};
      const name = String(b.name || '').trim();
      const phone = String(b.phone || '').replace(/[\s-]/g, '');
      const message = String(b.message || '').trim();
      const fail = (m, c = 422) => res.status(c).json({ ok: false, error: m });
      if (name.length < 2 || name.length > 80) return fail('Enter your full name.');
      if (!/^[6-9]\d{9}$/.test(phone)) return fail('Enter a valid 10-digit mobile number.');
      if (!SERVICES.includes(b.service)) return fail('Select a treatment.');
      if (!validDate(b.date) || b.date < todayIST()) return fail('Select a valid future date.');
      if (!SLOTS.includes(b.time)) return fail('Select a valid time.');
      if (message.length > 500) return fail('Note is too long.');
      try {
        const r = await col.insertOne({ name, phone, service: b.service, date: b.date, time: b.time,
          message, status: 'pending', active: true, createdAt: new Date() });
        res.json({ ok: true, id: r.insertedId });
      } catch (e) {
        if (e.code === 11000) return fail('That slot is already booked. Please pick another time.', 409);
        throw e;
      }
    } catch (e) { console.error(e); res.status(500).json({ ok: false, error: 'Server error. Please try again later.' }); }
  });

  // Admin page and API (HTTP Basic login)
  app.get('/admin', adminAuth, (req, res) => res.sendFile(path.join(__dirname, 'private', 'admin.html')));

  app.get('/api/admin/appointments', adminAuth, async (req, res) => {
    const f = req.query.f, q = {};
    if (STATUSES.includes(f)) q.status = f;
    if (f === 'today') q.date = todayIST();
    const rows = await col.find(q).sort({ date: -1, createdAt: -1 }).limit(500).toArray();
    res.json(rows);
  });

  app.patch('/api/admin/appointments/:id', adminAuth, async (req, res) => {
    const status = req.body && req.body.status;
    if (!ObjectId.isValid(req.params.id) || !STATUSES.includes(status)) return res.status(400).json({ ok: false });
    try {
      await col.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status, active: status !== 'cancelled' } });
      res.json({ ok: true });
    } catch (e) {
      if (e.code === 11000) return res.status(409).json({ ok: false, error: 'Slot taken by another booking' });
      console.error(e); res.status(500).json({ ok: false });
    }
  });

  app.delete('/api/admin/appointments/:id', adminAuth, async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ ok: false });
    await col.deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ ok: true });
  });

  app.listen(PORT, () => console.log(`Website: http://localhost:${PORT}   Admin: http://localhost:${PORT}/admin`));
}
main().catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
