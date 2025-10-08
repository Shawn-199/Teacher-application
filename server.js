// server.js — Admin API + CORS + статика admin-ui + teacher application + schedule + admin bookings create
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const mongoose = require('mongoose');
const xlsx = require('xlsx');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
const { Readable, PassThrough } = require('stream');
require('dotenv').config();

// ---- Startup sanity checks ----
(function bootChecks() {
  const missing = [];
  if (!process.env.JWT_SECRET) missing.push('JWT_SECRET');
  if (!process.env.MONGO_URI && !process.env.MONGODB_URI) missing.push('MONGO_URI or MONGODB_URI');
  if (missing.length) console.error('[WARN] Missing env:', missing.join(', '));
})();

// === FFmpeg for audio conversion (WebM -> MP3) ===
ffmpeg.setFfmpegPath(ffmpegPath);
function bufferToStream(buffer) {
  const s = new Readable();
  s.push(buffer);
  s.push(null);
  return s;
}
async function webmToMp3(buffer) {
  return new Promise((resolve, reject) => {
    const input = bufferToStream(buffer);
    const output = new PassThrough();
    const chunks = [];
    output.on('data', (c) => chunks.push(c));
    output.on('end', () => resolve(Buffer.concat(chunks)));
    output.on('error', reject);
    ffmpeg(input)
      .inputFormat('webm')
      .noVideo()
      .audioCodec('libmp3lame')
      .format('mp3')
      .on('error', reject)
      .pipe(output, { end: true });
  });
}
async function normalizeToMp3(file, fallbackName) {
  if (!file) return null;
  const looksLikeWebm =
    (file.mimetype || '').includes('webm') ||
    (file.originalname || '').toLowerCase().endsWith('.webm');

  if (looksLikeWebm) {
    const mp3buf = await webmToMp3(file.buffer);
    const base = (file.originalname || fallbackName || 'recording')
      .replace(/\.webm$/i, '')
      .replace(/\.[a-z0-9]+$/i, '');
    return { filename: `${base}.mp3`, content: mp3buf, contentType: 'audio/mpeg' };
  }
  return {
    filename: file.originalname || (fallbackName || 'recording'),
    content: file.buffer,
    contentType: file.mimetype || 'application/octet-stream'
  };
}

const app = express();
app.set('trust proxy', 1);

// --- CORS (включая preflight) ---
const corsOptions = {
  origin: (origin, cb) => cb(null, true),
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-user-email'],
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS','HEAD'],
  optionsSuccessStatus: 204,
  preflightContinue: false,
  maxAge: 86400
};
app.use(cors(corsOptions));
// Универсальный handler для preflight
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    const origin = req.headers.origin;
    if (origin) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Vary', 'Origin');
      res.header('Access-Control-Allow-Credentials', 'true');
    } else {
      res.header('Access-Control-Allow-Origin', '*');
    }
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, x-user-email');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD');
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Раздача админки как статики (public/admin.html -> /admin-ui/admin.html)
app.use('/admin-ui', express.static('public', { extensions: ['html'], index: false }));

/* ---------------- MongoDB ---------------- */
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!MONGO_URI) { console.error('Missing MONGO_URI in .env'); process.exit(1); }
mongoose
  .connect(MONGO_URI, { dbName: 'grandenglish' })
  .then(() => console.log('MongoDB connected'))
  .catch((e) => { console.error('Mongo connect error:', e); process.exit(1); });

const { Schema, model } = mongoose;

const UserSchema = new Schema({
  email: { type: String, unique: true, required: true, index: true },
  passwordHash: { type: String, required: true },
  firstName: String,
  lastName: String,
  role: { type: String, default: 'student' }, // 'student' | 'manager' | 'admin'
  isGuest: { type: Boolean, default: false }
}, { timestamps: true });
const User = model('User', UserSchema);

const BookingSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  email: { type: String, required: true },
  childName: { type: String, required: true },
  parentName: { type: String, required: true },
  childAge: { type: Number },
  country: { type: String },
  timeZone: { type: String },
  dateStr: { type: String, required: true },  // e.g. "2025-09-20"
  timeStr: { type: String, required: true },  // e.g. "14:00"
  level:   { type: String, required: true },
  status:  { type: String, default: 'Scheduled' }, // Scheduled | Completed | Cancelled | No-Show | Rescheduled
  teacherName: { type: String, default: process.env.TEACHER_NAME || 'Teacher' }
}, { timestamps: true });
const Booking = model('Booking', BookingSchema);

let TimeSlot;
try { TimeSlot = mongoose.model('TimeSlot'); } catch (e) {
  const TimeSlotSchema = new Schema({
    kind: { type: String, enum: ['oneoff','recurring'], default: 'oneoff' },
    // recurring:
    validFrom: Date,
    validTo: Date,
    dow: Number,          // 0..6
    startTime: String,    // "HH:mm"
    endTime: String,      // "HH:mm"
    timeZone: String,
    // one-off:
    startISO: Date,
    endISO: Date,
    teacherName: { type: String, default: process.env.TEACHER_NAME || 'Teacher' },
    note: String,
    isActive: { type: Boolean, default: true }
  }, { timestamps: true });
  TimeSlot = mongoose.model('TimeSlot', TimeSlotSchema);
}

/* ---------------- Mailer (Brevo SMTP 2525) ---------------- */
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
  port: process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT) : 2525,
  secure: false, // порт 2525 не требует SSL
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  pool: true,
  maxConnections: 1,
  maxMessages: 50,
  connectionTimeout: 15000,
  greetingTimeout: 10000,
  socketTimeout: 20000,
  family: 4
});

// Проверка соединения при запуске
transporter.verify((error, success) => {
  if (error) {
    console.error('❌ Brevo SMTP connection failed:', error.message);
  } else {
    console.log('✅ Brevo SMTP server is ready on port', process.env.SMTP_PORT || 2525);
  }
});

// === Глобальные параметры отправки ===
const ADMIN_TO = process.env.ADMIN_BOOKINGS_TO || process.env.NOTIFY_TO || process.env.EMAIL_USER;
const FROM_EMAIL = process.env.BREVO_FROM || process.env.EMAIL_USER; // подтверждённый отправитель в Brevo
const REPLY_TO   = process.env.REPLY_TO   || process.env.NOTIFY_TO || process.env.EMAIL_USER;

async function sendEmail(opts) {
  try {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      console.error('Email credentials missing: EMAIL_USER and EMAIL_PASS required');
      return false;
    }

    const mailOptions = {
      from: `"Grand English Courses" <${FROM_EMAIL}>`, // ⚠️ подтверждённый sender
      replyTo: REPLY_TO,                              // куда придут ответы
      ...opts
    };

    await transporter.sendMail(mailOptions);
    console.log('📧 Email sent successfully to:', opts.to);
    return true;
  } catch (e) {
    console.error('❌ Email send failed:', e.message);
    return false;
  }
}

/* ---------------- JWT ---------------- */
function signToken(user) {
  if (!process.env.JWT_SECRET) throw new Error('Missing JWT_SECRET in .env');
  return jwt.sign({ uid: user._id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
}
function auth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) {
      return res.status(401).json({ success:false, code:'MISSING_TOKEN', message:'Missing Authorization: Bearer <token>' });
    }
    const theToken = h.slice(7).trim();
    if (!theToken) {
      return res.status(401).json({ success:false, code:'EMPTY_TOKEN', message:'Empty bearer token' });
    }
    const payload = jwt.verify(theToken, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ success:false, code:'INVALID_TOKEN', message:'Invalid or expired auth token' });
  }
}
function optionalAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) {
      const t = h.slice(7).trim();
      if (t) req.user = jwt.verify(t, process.env.JWT_SECRET);
    }
  } catch {}
  next();
}

/* -------- Admin guard (для /api/admin/*) -------- */
const ADMIN_PAGE_SIZE_DEFAULT = 25;
const LESSON_STATUSES = ['Scheduled','Completed','Cancelled','No-Show','Rescheduled'];

async function requireAdmin(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return res.status(401).json({ success:false, message:'Missing token' });
    const payload = jwt.verify(h.slice(7), process.env.JWT_SECRET);
    const u = await User.findById(payload.uid).select('_id email role');
    if (!u) return res.status(401).json({ success:false, message:'User not found' });
    if (!['admin','manager'].includes(u.role)) return res.status(403).json({ success:false, message:'Admin or manager only' });
    req.admin = { id: u._id, email: u.email, role: u.role };
    next();
  } catch (e) {
    console.error('requireAdmin error:', e);
    return res.status(401).json({ success:false, message:'Invalid token' });
  }
}

/* ---------------- Health ---------------- */
app.get('/health', (req, res) => res.json({ ok: true }));

/* ---------------- Teachers form (audio) ---------------- */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});
app.post('/submit', upload.any(), async (req, res) => {
  try {
    // Check email configuration first
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      console.error('Email configuration missing - cannot send teacher application');
      return res.status(500).json({ success:false, message:'Email service not configured' });
    }
    
    const files = {};
    for (const f of (req.files || [])) files[f.fieldname] = f;

    console.log('FILES:', (req.files || []).map(f => ({ field: f.fieldname, name: f.originalname, size: f.size, type: f.mimetype })));
    const fQ1 = files['audioQ1'] || null;
    const fQ2 = files['audioQ2'] || null;
    const fMain = files['audio'] || null;
    const fCV = files['cv'] || files['resume'] || files['cvFile'] || null;

    if (!fCV) {
      return res.status(400).json({ success: false, message: 'Missing required file: CV' });
    }
    if (!fQ1 && !fQ2 && !fMain) {
      return res.status(400).json({ success: false, message: 'Missing audio file (audio, audioQ1 or audioQ2)' });
    }

    const {
      email='-', fullname='-', age='-', country='-', languages='',
      timezone='-', experience='-', quizAnswers='{}', quizScore='-', quizPercentage='-'
    } = req.body;

    const parsedLanguages = languages ? String(languages).split(',').map(l=>l.trim()) : [];

    const a1 = await normalizeToMp3(fQ1, 'speaking-q1.webm');
    const a2 = await normalizeToMp3(fQ2, 'speaking-q2.webm');
    const aMain = await normalizeToMp3(fMain, 'speaking-assessment.webm');

    // Collect attachments: CV + audio (deduplicated)
    const attachments = [];
    function pushUnique(att) {
      if (!att || !att.content) return;
      try {
        const hash = crypto.createHash('sha1').update(att.content).digest('hex');
        pushUnique._seen = pushUnique._seen || new Set();
        const aux = `${att.filename || ''}:${att.content.length}`;
        const key = `${hash}:${aux}`;
        if (!pushUnique._seen.has(key)) {
          pushUnique._seen.add(key);
          attachments.push(att);
        }
      } catch (e) {
        // Fallback: still push if hashing fails
        attachments.push(att);
      }
    }

    // CV
    if (fCV) {
      pushUnique({
        filename: fCV.originalname || 'CV',
        content:  fCV.buffer,
        contentType: fCV.mimetype || 'application/octet-stream'
      });
    }

    // Audio (only if present & unique)
    if (a1)    pushUnique(a1);
    if (a2)    pushUnique(a2);
    if (aMain) pushUnique(aMain);

    await sendEmail({
      to: ADMIN_TO,
      subject: `🎓 Новая заявка от ${fullname}`,
      html: `
        <h2>Новая заявка</h2>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Имя:</strong> ${fullname}</p>
        <p><strong>Страна:</strong> ${country}</p>
        <p><strong>Возраст:</strong> ${age}</p>
        <p><strong>Часовой пояс:</strong> ${timezone}</p>
        <p><strong>Языки:</strong> ${parsedLanguages.join(', ')}</p>
        <p><strong>Опыт:</strong> ${experience}</p>
        <p><strong>Тест:</strong> ${quizScore}/20 (${quizPercentage}%)</p>
      `,
      attachments
    });

    res.status(201).json({ success:true, message:'Application submitted and email sent' });
  } catch (err) {
    console.error('Error submitting application:', err);
    res.status(500).json({ success:false, message:'Internal server error', error: err.message });
  }
});

/* ---------------- Auth APIs ---------------- */
app.post('/api/register', async (req, res) => {
  try {
    const { fullName, email, password } = req.body;
    if (!fullName || !email || !password)
      return res.status(400).json({ success:false, message:'fullName, email, password required' });

    const exists = await User.findOne({ email: email.toLowerCase() });
    if (exists) return res.status(409).json({ success:false, message:'User already exists' });

    const [firstName='', ...rest] = fullName.trim().split(' ');
    const lastName = rest.join(' ');
    const passwordHash = await bcrypt.hash(password, 10);

    const user = await User.create({
      email: email.toLowerCase(), passwordHash, firstName, lastName, role:'student'
    });

    const token = signToken(user);
    res.json({ success:true, token, user:{ id:user._id, email:user.email, firstName, lastName } });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ success:false, message:'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if(!email || !password) return res.status(400).json({ success:false, message:'email and password required' });
    const user = await User.findOne({ email:(email||'').toLowerCase() });
    if (!user) return res.status(401).json({ success:false, message:'Invalid credentials' });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ success:false, message:'Invalid credentials' });
    const token = signToken(user);
    res.json({ success:true, token, user:{ id:user._id, email:user.email, firstName:user.firstName, lastName:user.lastName } });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ success:false, message:'Login failed' });
  }
});

app.get('/api/me', optionalAuth, async (req, res) => {
  if (!req.user) return res.json({ success:true, user:null });
  const user = await User.findById(req.user.uid).select('_id email firstName lastName role');
  res.json({ success:true, user });
});

/* ---------------- Bookings (student) ---------------- */

// TRIAL booking — работает и с JWT, и без (гость)
app.post('/api/bookings/trial', optionalAuth, async (req, res) => {
  try {
    const { date, time, level } = req.body || {};
    if (!date || !time) return res.status(400).json({ success:false, message:'date and time are required' });

    let userDoc = null;
    if (req.user && req.user.uid) {
      userDoc = await User.findById(req.user.uid);
      if (!userDoc) return res.status(401).json({ success:false, message:'Auth user not found' });
    } else {
      // гость — достаём email из разных полей/заголовков
      const candidates = [
        req.body.email, req.body.userEmail, req.body.contactEmail,
        req.body.login, req.body.username, req.headers['x-user-email']
      ].map(v => (v || '').toString().trim()).filter(Boolean);
      let email = (candidates[0] || '').toLowerCase();
      if (!email) email = `guest+${Date.now()}@guest.local`;
      userDoc = await User.findOne({ email }) || await User.create({
        email, passwordHash: await bcrypt.hash(Math.random().toString(36).slice(2), 10),
        role: 'student', isGuest: true
      });
    }

    const booking = await Booking.create({
      user: userDoc._id,
      email: userDoc.email,
      childName: 'Trial Student',
      parentName: (userDoc.firstName || 'Parent') + (userDoc.lastName ? ' ' + userDoc.lastName : ''),
      childAge: null,
      country: '',
      timeZone: '',
      dateStr: date,
      timeStr: time,
      level: level || 'Beginner',
      status: 'Scheduled',
      teacherName: process.env.TEACHER_NAME || 'Teacher'
    });

    res.json({ success:true, booking });
  } catch (e) {
    console.error('Trial booking error:', e);
    res.status(500).json({ success:false, message:'Booking failed' });
  }
});

app.post('/api/book', auth, async (req, res) => {
  try {
    const { email, childName, parentName, childAge, country, timeZone, date, time, level } = req.body;
    if (!date || !time || !childName || !parentName || !email || !level) {
      return res.status(400).json({ success:false, message:'Missing required fields' });
    }

    const booking = await Booking.create({
      user: req.user.uid,
      email, childName, parentName, childAge, country, timeZone,
      dateStr: date, timeStr: time, level,
      status: 'Scheduled',
      teacherName: process.env.TEACHER_NAME || 'Teacher'
    });

    // Send to admin
    await sendEmail({
      to: ADMIN_TO,
      subject: `🗓️ New trial booking: ${childName} (${date} ${time})`,
      html: `
        <h2>New booking</h2>
        <p><strong>Child:</strong> ${childName}</p>
        <p><strong>Parent:</strong> ${parentName}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Level:</strong> ${level}</p>
        <p><strong>Date & Time:</strong> ${date} ${time} (${timeZone||'—'})</p>
        <p><strong>Country:</strong> ${country||'—'}</p>
      `
    });

    // Send confirmation to student
    await sendEmail({
      to: email,
      subject: `Your Trial Lesson Confirmation - ${date} at ${time}`,
      html: `
        <h2>Lesson Booked Successfully!</h2>
        <p>Dear ${parentName},</p>
        <p>Your trial lesson for <strong>${childName}</strong> has been scheduled.</p>
        <p><strong>Date:</strong> ${date}</p>
        <p><strong>Time:</strong> ${time} (${timeZone||''})</p>
        <p><strong>Level:</strong> ${level}</p>
        <p><strong>Teacher:</strong> ${process.env.TEACHER_NAME || 'Teacher'}</p>
        <p>We look forward to seeing you!</p>
      `
    });

    res.json({ success:true, booking });
  } catch (e) {
    console.error('Book error:', e);
    res.status(500).json({ success:false, message:'Booking failed' });
  }
});

app.get('/api/my-bookings', auth, async (req, res) => {
  try {
    const items = await Booking.find({ user: req.user.uid }).sort({ createdAt: -1 }).lean();
    res.json({ success:true, bookings: items.map(x => ({ ...x, status: (x.status||'').toLowerCase() })) });
  } catch (e) {
    console.error('List bookings error:', e);
    res.status(500).json({ success:false, message:'Failed to list bookings' });
  }
});

app.get('/api/my-bookings/latest', auth, async (req, res) => {
  try {
    const b = await Booking.findOne({ user: req.user.uid }).sort({ createdAt: -1 }).lean();
    if (!b) return res.json({ success:true, booking: null });
    if (b.status) b.status = String(b.status).toLowerCase();
    res.json({ success:true, booking: b });
  } catch (e) {
    console.error('Latest booking error:', e);
    res.status(500).json({ success:false, message:'Failed to fetch latest booking' });
  }
});

app.post('/api/bookings/:id/cancel', auth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ success:false, message:'Invalid booking id' });
    const b = await Booking.findOne({ _id: id, user: req.user.uid });
    if (!b) return res.status(404).json({ success:false, message:'Not found' });
    b.status = 'Cancelled';
    await b.save();
    res.json({ success:true, booking: b });
  } catch (e) {
    console.error('Cancel error:', e);
    res.status(500).json({ success:false, message:'Cancel failed' });
  }
});

app.post('/api/bookings/:id/reschedule', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { date, time, level } = req.body;
    const b = await Booking.findOne({ _id: id, user: req.user.uid });
    if (!b) return res.status(404).json({ success:false, message:'Not found' });
    if (date) b.dateStr = date;
    if (time) b.timeStr = time;
    if (level) b.level = level;
    b.status = 'Scheduled';
    await b.save();
    res.json({ success:true, booking: b });
  } catch (e) {
    console.error('Reschedule error:', e);
    res.status(500).json({ success:false, message:'Reschedule failed' });
  }
});

/* ---------------- Admin APIs ---------------- */

// Quick SMTP test endpoint (send to ADMIN_TO)
app.post('/api/admin/test-email', requireAdmin, async (req, res) => {
  try {
    const ok = await sendEmail({
      to: ADMIN_TO,
      subject: 'SMTP test ✔',
      html: '<p>If you see this, SMTP works from Render.</p>'
    });
    if (!ok) return res.status(500).json({ success:false, message:'Send failed' });
    res.json({ success:true });
  } catch (e) {
    console.error('test-email failed:', e);
    res.status(500).json({ success:false, message:String(e) });
  }
});


// GET /api/admin/users — список пользователей с датой регистрации
app.get('/api/admin/users', requireAdmin, async (req, res) => {
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

  res.json({
    success: true,
    page: pg, limit: per, total,
    users: items
  });
});

// GET /api/admin/bookings — список бронирований с фильтрами
app.get('/api/admin/bookings', requireAdmin, async (req, res) => {
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
    Booking.find(cond).sort({ createdAt: -1 })
      .skip((pg-1)*per).limit(per)
      .lean(),
    Booking.countDocuments(cond)
  ]);

  res.json({
    success: true,
    page: pg, limit: per, total,
    bookings: items
  });
});

// PATCH /api/admin/bookings/:id/status — смена статуса/даты/времени/уровня/преподавателя
app.patch('/api/admin/bookings/:id/status', requireAdmin, async (req, res) => {
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

  // Always notify student when status changes
  if (b.email) {
    const statusText = b.status;
    const html = `
      <h2>Lesson Status Updated</h2>
      <p>Dear ${b.parentName},</p>
      <p>The status of <strong>${b.childName}'s</strong> lesson has been updated:</p>
      <p><strong>Status:</strong> ${statusText}</p>
      <p><strong>Date & Time:</strong> ${b.dateStr || '—'} ${b.timeStr || ''}</p>
      <p><strong>Teacher:</strong> ${b.teacherName || '—'}</p>
      <p>If you have questions, please reply to this email.</p>
    `;
    sendEmail({ to: b.email, subject: `Lesson Status Updated: ${statusText}`, html }).catch(()=>{});
  }

  res.json({ success:true, booking: b });
});

// GET /api/admin/stats — сводка
app.get('/api/admin/stats', requireAdmin, async (_req, res) => {
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

/* ---------------- NEW: Admin create lesson ---------------- */
app.post('/api/admin/bookings/create', requireAdmin, async (req, res) => {
  try {
    const { email, childName, parentName, childAge, country, timeZone, dateStr, timeStr, level, teacherName } = req.body || {};
    if (!email || !childName || !parentName || !dateStr || !timeStr || !level) {
      return res.status(400).json({ success:false, message:'Missing required fields: email, childName, parentName, dateStr, timeStr, level' });
    }
    let user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      user = await User.create({
        email: email.toLowerCase(),
        passwordHash: await bcrypt.hash(Math.random().toString(36).slice(2), 10),
        role: 'student',
        isGuest: true
      });
    }
    const booking = await Booking.create({
      user: user._id,
      email: user.email,
      childName,
      parentName,
      childAge: childAge ?? null,
      country: country || '',
      timeZone: timeZone || '',
      dateStr,
      timeStr,
      level,
      status: 'Scheduled',
      teacherName: teacherName || process.env.TEACHER_NAME || 'Teacher'
    });
    res.json({ success:true, booking });
  } catch (e) {
    console.error('Admin create lesson failed:', e);
    res.status(500).json({ success:false, message:'Admin create lesson failed' });
  }
});

/* ---------------- Schedule feed & Admin Slots ---------------- */

// GET /api/schedule?from=YYYY-MM-DD&to=YYYY-MM-DD
app.get('/api/schedule', optionalAuth, async (req, res) => {
  try {
    const from = new Date(req.query.from);
    const to   = new Date(req.query.to);
    if (isNaN(from) || isNaN(to)) {
      return res.status(400).json({ success:false, message:'Invalid range' });
    }

    const items = [];
    const addItem = (type, title, start, end, extra = {}) => {
      if (!start || !end) return;
      const st = new Date(start);
      const en = new Date(end);
      if (isNaN(st) || isNaN(en)) return;
      if (st < from || st > to) return;
      items.push({ type, title, start: st, end: en, ...extra });
    };

    // 1) Lessons from bookings
    const lessons = await Booking.find({
      status: { $in: ['Scheduled', 'Rescheduled'] }
    }).lean();

    for (const b of lessons) {
      try {
        const ds = String(b.dateStr || '').trim();
        const ts = String(b.timeStr || '').trim();
        if (!ds) continue;

        let start = new Date(ds + (ts ? (' ' + ts) : ''));
        if (isNaN(start)) {
          // fallback DD.MM.YYYY
          const m = ds.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
          if (m) {
            const [_, dd, mm, yyyy] = m;
            const hh = (ts.match(/^(\d{1,2})/) || [])[1] || '00';
            const mi = (ts.match(/:(\d{2})/) || [])[1] || '00';
            start = new Date(`${yyyy}-${mm}-${dd}T${hh.padStart(2,'0')}:${mi}:00`);
          }
        }
        if (isNaN(start)) continue;
        const end = new Date(start.getTime() + 60 * 60 * 1000);

        addItem(
          'lesson',
          b.level ? `${b.level} Lesson` : 'Lesson',
          start,
          end,
          { status: b.status || 'Scheduled', teacherName: b.teacherName || (process.env.TEACHER_NAME || 'Teacher') }
        );
      } catch {}
    }

    // 2) Slots from TimeSlot
    const slots = await TimeSlot.find({
      isActive: true,
      $or: [
        { kind: 'oneoff', startISO: { $lt: to }, endISO: { $gt: from } },
        {
          kind: 'recurring',
          $and: [
            { $or: [ { validFrom: { $exists: false } }, { validFrom: { $lte: to } } ] },
            { $or: [ { validTo:   { $exists: false } }, { validTo:   { $gte: from } } ] }
          ]
        }
      ]
    }).lean();

    // One-off slots
    for (const s of slots) {
      if (s.kind !== 'oneoff') continue;
      addItem('slot', 'Available', s.startISO, s.endISO, { teacherName: s.teacherName });
    }

    // Recurring slots expanded per day
    const dayMs = 24 * 60 * 60 * 1000;
    for (const s of slots) {
      if (s.kind !== 'recurring') continue;
      const vFrom = s.validFrom ? new Date(s.validFrom) : from;
      const vTo   = s.validTo   ? new Date(s.validTo)   : to;
      const rangeStart = new Date(Math.max(vFrom.getTime(), from.getTime()));
      const rangeEnd   = new Date(Math.min(vTo.getTime(),   to.getTime()));
      for (let d = new Date(rangeStart); d <= rangeEnd; d = new Date(d.getTime() + dayMs)) {
        if (d.getDay() !== Number(s.dow)) continue;
        const [sh, sm] = String(s.startTime || '0:0').split(':').map(Number);
        const [eh, em] = String(s.endTime   || '0:0').split(':').map(Number);
        const start = new Date(d); start.setHours(sh || 0, sm || 0, 0, 0);
        const end   = new Date(d); end.setHours(eh || 0, em || 0, 0, 0);
        addItem('slot', 'Available', start, end, { teacherName: s.teacherName });
      }
    }

    res.json({ success: true, items });
  } catch (e) {
    console.error('/api/schedule error:', e);
    res.status(500).json({ success:false, message:'Failed to build schedule' });
  }
});

// ===== Admin Slots CRUD + Import (CSV/XLSX) =====
const uploadAny = multer({ storage: multer.memoryStorage(), limits:{ fileSize: 10*1024*1024 } }).any();

app.get('/api/admin/slots', requireAdmin, async (req, res) => {
  try {
    const { from, to, kind, active } = req.query;
    const q = {};
    if (kind) q.kind = kind;
    if (active === 'true') q.isActive = true;
    if (active === 'false') q.isActive = false;

    if (from || to) {
      const fromDt = from ? new Date(from) : null;
      const toDt   = to   ? new Date(to)   : null;
      q.$or = [
        { kind: 'oneoff',
          ...(fromDt ? { endISO:   { $gte: fromDt } } : {}),
          ...(toDt   ? { startISO: { $lte: toDt   } } : {}),
        },
        { kind: 'recurring',
          ...(fromDt ? { $or: [ { validTo: { $exists:false } }, { validTo: { $gte: fromDt } } ] } : {}),
          ...(toDt   ? { $or: [ { validFrom: { $exists:false } }, { validFrom: { $lte: toDt } } ] } : {}),
        }
      ];
    }

    const items = await TimeSlot.find(q)
      .sort({ kind: 1, dow: 1, startISO: 1, startTime: 1 })
      .limit(1000)
      .lean();

    res.json({ success: true, items });
  } catch (e) {
    console.error('GET /api/admin/slots error:', e);
    res.status(500).json({ success:false, message:'Failed to list slots' });
  }
});

app.post('/api/admin/slots', requireAdmin, async (req, res) => {
  try {
    const s = await TimeSlot.create(req.body);
    res.json({ success:true, slot:s });
  } catch (e) {
    res.status(400).json({ success:false, message:e.message });
  }
});

app.patch('/api/admin/slots/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const s = await TimeSlot.findByIdAndUpdate(id, req.body, { new:true });
  if(!s) return res.status(404).json({ success:false, message:'Not found' });
  res.json({ success:true, slot:s });
});

app.delete('/api/admin/slots/:id', requireAdmin, async (req, res) => {
  const ok = await TimeSlot.findByIdAndDelete(req.params.id);
  res.json({ success: !!ok });
});

app.post('/api/admin/slots/import', requireAdmin, uploadAny, async (req, res) => {
  const f = (req.files||[])[0];
  if(!f) return res.status(400).json({ success:false, message:'File required' });

  let rows = [];
  try {
    if (/\.xlsx?$/.test(f.originalname)) {
      const wb = xlsx.read(f.buffer, { type:'buffer' });
      rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    } else {
      const text = f.buffer.toString('utf8');
      rows = text.split(/\r?\n/).map(l => l.split(',')).filter(a => a.length>1)
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
    const docs = await TimeSlot.insertMany(rows.filter(r => r && r.kind));
    res.json({ success:true, inserted: docs.length });
  } catch (e) {
    res.status(400).json({ success:false, message:String(e) });
  }
});

/* ---------------- Start ---------------- */
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => console.log(`Server is running on port ${PORT}`));