const multer = require('multer');
const xlsx = require('xlsx');
// adminRoutes.js — Express Router for GE Admin Panel
// Mount with: app.use('/api/admin', require('./adminRoutes'));
const express = require('express');
const jwt = require('jsonwebtoken');

// Adjust these paths to your project structure if needed:
const { User } = require('./models/User') || {};
const { Booking } = require('./models/Booking') || {};

// If your models are declared in server.js, you can replace the requires above with:
// const { User, Booking } = require('./server'); // and export them from server.js
// or simply paste this file's endpoints into server.js and remove requires.

const router = express.Router();
const ADMIN_PAGE_SIZE_DEFAULT = 25;
const LESSON_STATUSES = ['Scheduled','Completed','Cancelled','No-Show','Rescheduled'];

// Admin guard
async function requireAdmin(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return res.status(401).json({ success:false, message:'Missing token' });
    const payload = jwt.verify(h.slice(7), process.env.JWT_SECRET);
    // Minimal user lookup; adjust if your user model differs
    const u = await User.findById(payload.uid).select('_id email role');
    if (!u) return res.status(401).json({ success:false, message:'User not found' });
    if (u.role !== 'admin') return res.status(403).json({ success:false, message:'Admin only' });
    req.admin = { id: u._id, email: u.email };
    next();
  } catch (e) {
    console.error('requireAdmin error:', e);
    return res.status(401).json({ success:false, message:'Invalid token' });
  }
}

// GET /api/admin/users
router.get('/users', requireAdmin, async (req, res) => {
  const {
    q = '', since = '', till = '',
    page = 1, limit = ADMIN_PAGE_SIZE_DEFAULT
  } = req.query;

  const cond = {};
  if (q) {
    cond.$or = [
      { email: new RegExp(q, 'i') },
      { firstName: new RegExp(q, 'i') },
      { lastName: new RegExp(q, 'i') },
    ];
  }
  if (since || till) {
    cond.createdAt = {};
    if (since) cond.createdAt.$gte = new Date(since);
    if (till)  cond.createdAt.$lte = new Date(till);
  }

  const per = Math.min(Number(limit)||ADMIN_PAGE_SIZE_DEFAULT, 200);
  const pg = Math.max(Number(page)||1, 1);

  const [items, total] = await Promise.all([
    User.find(cond).sort({ createdAt: -1 })
      .skip((pg-1)*per).limit(per)
      .select('_id email firstName lastName role isGuest createdAt'),
    User.countDocuments(cond)
  ]);

  res.json({ success: true, page: pg, limit: per, total, users: items });
});

// GET /api/admin/bookings
router.get('/bookings', requireAdmin, async (req, res) => {
  const {
    status = '', email = '',
    dateFrom = '', dateTo = '',
    page = 1, limit = ADMIN_PAGE_SIZE_DEFAULT
  } = req.query;

  const cond = {};
  if (status) cond.status = status;
  if (email)  cond.email = new RegExp(email, 'i');
  if (dateFrom || dateTo) {
    cond.createdAt = {};
    if (dateFrom) cond.createdAt.$gte = new Date(dateFrom);
    if (dateTo)   cond.createdAt.$lte = new Date(dateTo);
  }

  const per = Math.min(Number(limit)||ADMIN_PAGE_SIZE_DEFAULT, 200);
  const pg = Math.max(Number(page)||1, 1);

  const [items, total] = await Promise.all([
    Booking.find(cond).sort({ createdAt: -1 }).skip((pg-1)*per).limit(per).lean(),
    Booking.countDocuments(cond)
  ]);

  res.json({ success: true, page: pg, limit: per, total, bookings: items });
});

// PATCH /api/admin/bookings/:id/status
router.patch('/bookings/:id/status', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status, dateStr, timeStr, level, teacherName } = req.body || {};

  const b = await Booking.findById(id);
  if (!b) return res.status(404).json({ success:false, message:'Booking not found' });

  if (status) {
    if (!LESSON_STATUSES.includes(status)) {
      return res.status(400).json({ success:false, message:`Invalid status. Allowed: ${LESSON_STATUSES.join(', ')}` });
    }
    b.status = status;
  }
  if (dateStr) b.dateStr = dateStr;
  if (timeStr) b.timeStr = timeStr;
  if (level)   b.level   = level;
  if (teacherName) b.teacherName = teacherName;

  await b.save();
  res.json({ success:true, booking: b });
});

// GET /api/admin/stats
router.get('/stats', requireAdmin, async (_req, res) => {
  const [usersTotal, bookingsTotal, scheduled, completed, cancelled, noshow] = await Promise.all([
    User.countDocuments({}),
    Booking.countDocuments({}),
    Booking.countDocuments({ status: 'Scheduled' }),
    Booking.countDocuments({ status: 'Completed' }),
    Booking.countDocuments({ status: 'Cancelled' }),
    Booking.countDocuments({ status: 'No-Show' }),
  ]);
  res.json({
    success:true,
    usersTotal, bookingsTotal,
    byStatus: { Scheduled: scheduled, Completed: completed, Cancelled: cancelled, 'No-Show': noshow }
  });
});
// === Injected: Admin Slots & Import ===
const uploadAny = multer({ storage: multer.memoryStorage(), limits:{ fileSize: 10*1024*1024 } }).any();

const mongooseRefAR = (typeof mongoose !== 'undefined' && mongoose) ? mongoose : require('mongoose');
const { Schema: ARSchema } = mongooseRefAR;

let AR_TimeSlot;
try { AR_TimeSlot = mongooseRefAR.model('TimeSlot'); } catch(e) {
  const TimeSlotSchema = new ARSchema({
    kind: { type: String, enum: ['oneoff','recurring'], default: 'oneoff' },
    validFrom: Date,
    validTo: Date,
    dow: Number,
    startTime: String,
    endTime: String,
    timeZone: String,
    startISO: Date,
    endISO: Date,
    teacherName: { type: String, default: 'Teacher' },
    note: String,
    isActive: { type: Boolean, default: true }
  }, { timestamps: true });
  AR_TimeSlot = mongooseRefAR.model('TimeSlot', TimeSlotSchema);
}

// Create slot
router.post('/api/admin/slots', requireAdmin, async (req, res) => {
  try {
    const s = await AR_TimeSlot.create(req.body);
    res.json({ success:true, slot:s });
  } catch (e) {
    res.status(400).json({ success:false, message:e.message });
  }
});

// Update slot
router.patch('/api/admin/slots/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const s = await AR_TimeSlot.findByIdAndUpdate(id, req.body, { new:true });
  if(!s) return res.status(404).json({ success:false, message:'Not found' });
  res.json({ success:true, slot:s });
});

// Delete slot
router.delete('/api/admin/slots/:id', requireAdmin, async (req, res) => {
  const ok = await AR_TimeSlot.findByIdAndDelete(req.params.id);
  res.json({ success: !!ok });
});

// Import slots (CSV/XLSX)
router.post('/api/admin/slots/import', requireAdmin, uploadAny, async (req, res) => {
  const f = (req.files||[])[0];
  if(!f) return res.status(400).json({ success:false, message:'File required' });

  let rows = [];
  try {
    if (/\.xlsx?$/.test(f.originalname)) {
      const wb = xlsx.read(f.buffer, { type:'buffer' });
      rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    } else {
      const text = f.buffer.toString('utf8');
      rows = text.split(/
?
/).map(l => l.split(',')).filter(a => a.length>1)
        .map(([kind,dow,startTime,endTime,validFrom,validTo,startISO,endISO,timeZone,teacherName]) => ({
          kind, dow: dow? +dow : undefined,
          startTime, endTime,
          validFrom: validFrom? new Date(validFrom): undefined,
          validTo:   validTo?   new Date(validTo):   undefined,
          startISO:  startISO?  new Date(startISO):  undefined,
          endISO:    endISO?    new Date(endISO):    undefined,
          timeZone, teacherName
        }));
    }
    const docs = await AR_TimeSlot.insertMany(rows.filter(r => r.kind));
    res.json({ success:true, inserted: docs.length });
  } catch (e) {
    res.status(400).json({ success:false, message:String(e) });
  }
});
// === End Injected: Admin Slots & Import ===

module.exports = router;