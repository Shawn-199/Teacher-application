// server.js — Admin API + CORS + статика admin-ui + teacher application + schedule + admin bookings create
// Fast-response edition: email is fire-and-forget (non-blocking)

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

/* ---------------- Startup sanity checks ---------------- */
(function bootChecks() {
  const missing = [];
  if (!process.env.JWT_SECRET) missing.push('JWT_SECRET');
  if (!process.env.MONGO_URI && !process.env.MONGODB_URI) missing.push('MONGO_URI or MONGODB_URI');
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) missing.push('EMAIL_USER/EMAIL_PASS');
  if (missing.length) console.error('[WARN] Missing env:', missing.join(', '));
})();

/* ---------------- FFmpeg helpers (WebM -> MP3, low bitrate) ---------------- */
ffmpeg.setFfmpegPath(ffmpegPath);

function bufferToStream(buffer) {
  const s = new Readable();
  s.push(buffer);
  s.push(null);
  return s;
}

async function webmToMp3(buffer, { bitrateKbps = 64, frequency = 22050 } = {}) {
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
      .audioBitrate(bitrateKbps)
      .audioFrequency(frequency)
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
    const mp3buf = await webmToMp3(file.buffer); // сжатый MP3
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

/* ---------------- App & CORS ---------------- */
const app = express();
app.set('trust proxy', 1);

const corsOptions = {
  origin: (origin, cb) => cb(null, true),
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-user-email'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
  optionsSuccessStatus: 204,
  preflightContinue: false,
  maxAge: 86400
};
app.use(cors(corsOptions));

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
if (!MONGO_URI) {
  console.error('Missing MONGO_URI in .env');
  process.exit(1);
}
mongoose
  .connect(MONGO_URI, { dbName: 'grandenglish' })
  .then(() => console.log('MongoDB connected'))
  .catch((e) => {
    console.error('Mongo connect error:', e);
    process.exit(1);
  });

const { Schema, model } = mongoose;

const UserSchema = new Schema(
  {
    email: { type: String, unique: true, required: true, index: true },
    passwordHash: { type: String, required: true },
    firstName: String,
    lastName: String,
    role: { type: String, default: 'student' }, // 'student' | 'manager' | 'admin'
    isGuest: { type: Boolean, default: false }
  },
  { timestamps: true }
);
const User = model('User', UserSchema);

const BookingSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    email: { type: String, required: true },
    childName: { type: String, required: true },
    parentName: { type: String, required: true },
    childAge: { type: Number },
    country: { type: String },
    timeZone: { type: String },
    dateStr: { type: String, required: true }, // e.g. "Tuesday, October 8, 2025"
    timeStr: { type: String, required: true }, // e.g. "14:00"
    level: { type: String, required: true },
    status: { type: String, default: 'Scheduled' }, // Scheduled | Completed | Cancelled | No-Show | Rescheduled
    teacherName: { type: String, default: process.env.TEACHER_NAME || 'Teacher' }
  },
  { timestamps: true }
);
const Booking = model('Booking', BookingSchema);

let TimeSlot;
try {
  TimeSlot = mongoose.model('TimeSlot');
} catch (e) {
  const TimeSlotSchema = new Schema(
    {
      kind: { type: String, enum: ['oneoff', 'recurring'], default: 'oneoff' },
      // recurring:
      validFrom: Date,
      validTo: Date,
      dow: Number, // 0..6
      startTime: String, // "HH:mm"
      endTime: String, // "HH:mm"
      timeZone: String,
      // one-off:
      startISO: Date,
      endISO: Date,
      teacherName: { type: String, default: process.env.TEACHER_NAME || 'Teacher' },
      note: String,
      isActive: { type: Boolean, default: true }
    },
    { timestamps: true }
  );
  TimeSlot = mongoose.model('TimeSlot', TimeSlotSchema);
}

/* ---------------- Mailer (pooled, with retries) ---------------- */
const transporter = nodemailer.createTransport({
  service: 'gmail',
  pool: true,
  maxConnections: 3,
  maxMessages: 50,
  rateDelta: 1000,
  rateLimit: 5,
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  connectionTimeout: 15_000,
  socketTimeout: 20_000
});

const ADMIN_TO = process.env.ADMIN_BOOKINGS_TO || process.env.NOTIFY_TO || process.env.EMAIL_USER;

async function sendEmailSafe(opts, { retries = 2 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await transporter.sendMail({ from: `"Grand English Courses" <${process.env.EMAIL_USER}>`, ...opts });
      return true;
    } catch (e) {
      console.error(`[Email] attempt ${attempt + 1} failed:`, e && e.message ? e.message : e);
      if (attempt === retries) return false;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
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
      return res.status(401).json({ success: false, code: 'MISSING_TOKEN', message: 'Missing Authorization: Bearer <token>' });
    }
    const theToken = h.slice(7).trim();
    if (!theToken) {
      return res.status(401).json({ success: false, code: 'EMPTY_TOKEN', message: 'Empty bearer token' });
    }
    const payload = jwt.verify(theToken, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ success: false, code: 'INVALID_TOKEN', message: 'Invalid or expired auth token' });
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
const LESSON_STATUSES = ['Scheduled', 'Completed', 'Cancelled', 'No-Show', 'Rescheduled'];

async function requireAdmin(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return res.status(401).json({ success: false, message: 'Missing token' });
    const payload = jwt.verify(h.slice(7), process.env.JWT_SECRET);
    const u = await User.findById(payload.uid).select('_id email role');
    if (!u) return res.status(401).json({ success: false, message: 'User not found' });
    if (!['admin', 'manager'].includes(u.role)) return res.status(403).json({ success: false, message: 'Admin or manager only' });
    req.admin = { id: u._id, email: u.email, role: u.role };
    next();
  } catch (e) {
    console.error('requireAdmin error:', e);
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
}

/* ---------------- Health ---------------- */
app.get('/health', (_req, res) => res.json({ ok: true }));

/* ---------------- Teachers form (audio) ---------------- */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // per file
});

app.post('/submit', upload.any(), async (req, res) => {
  // Быстрый ответ клиенту, а почту шлём в фоне
  try {
    const files = {};
    for (const f of (req.files || [])) files[f.fieldname] = f;

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
      email = '-',
      fullname = '-',
      age = '-',
      country = '-',
      languages = '',
      timezone = '-',
      experience = '-',
      quizAnswers = '{}',
      quizScore = '-',
      quizPercentage = '-'
    } = req.body;

    // Отвечаем сразу — чтобы UI мгновенно показал "thank you"
    res.status(201).json({ success: true, message: 'Application received. You will get a confirmation by email.' });

    // Дальше — «в фоне»: конвертация/сжатие и отправка почты
    setImmediate(async () => {
      try {
        const parsedLanguages = languages ? String(languages).split(',').map((l) => l.trim()) : [];

        // Параллельная нормализация аудио
        const [a1, a2, aMain] = await Promise.all([
          normalizeToMp3(fQ1, 'speaking-q1.webm'),
          normalizeToMp3(fQ2, 'speaking-q2.webm'),
          normalizeToMp3(fMain, 'speaking-assessment.webm')
        ]);

        // Собираем вложения
        const attachments = [];
        const seen = new Set();
        function pushUnique(att) {
          if (!att || !att.content) return;
          try {
            const hash = crypto.createHash('sha1').update(att.content).digest('hex');
            const aux = `${att.filename || ''}:${att.content.length}`;
            const key = `${hash}:${aux}`;
            if (seen.has(key)) return;
            seen.add(key);
          } catch {}
          attachments.push(att);
        }

        // CV
        pushUnique({
          filename: fCV.originalname || 'CV',
          content: fCV.buffer,
          contentType: fCV.mimetype || 'application/octet-stream'
        });

        // Аудио (если есть)
        if (a1) pushUnique(a1);
        if (a2) pushUnique(a2);
        if (aMain) pushUnique(aMain);

        // Ограничим общую «тяжесть» вложений (безопасно < ~22MB)
        const totalBytes = attachments.reduce((sum, a) => sum + (a.content?.length || 0), 0);
        let noteHeavy = '';
        let finalAttachments = attachments;
        const MAX_TOTAL = 22 * 1024 * 1024;
        if (totalBytes > MAX_TOTAL) {
          // оставим только CV
          finalAttachments = attachments.filter((a) => !/\.mp3$/i.test(a.filename || ''));
          noteHeavy =
            '<p><em>Note:</em> Audio attachments were omitted due to size limits. They are available on request.</p>';
        }

        const html = `
          <h2>Новая заявка</h2>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Имя:</strong> ${fullname}</p>
          <p><strong>Страна:</strong> ${country}</p>
          <p><strong>Возраст:</strong> ${age}</p>
          <p><strong>Часовой пояс:</strong> ${timezone}</p>
          <p><strong>Языки:</strong> ${parsedLanguages.join(', ')}</p>
          <p><strong>Опыт:</strong> ${experience}</p>
          <p><strong>Тест:</strong> ${quizScore}/20 (${quizPercentage}%)</p>
          ${noteHeavy}
        `;

        await sendEmailSafe({
          to: ADMIN_TO,
          subject: `🎓 Новая заявка от ${fullname}`,
          html,
          attachments: finalAttachments
        });
      } catch (err) {
        console.error('Background email for application failed:', err && err.message ? err.message : err);
      }
    });
  } catch (err) {
    console.error('Error submitting application (sync part):', err);
    // Если что-то пошло не так до ответа — вернём 500
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
    }
  }
});

/* ---------------- Auth APIs ---------------- */
app.post('/api/register', async (req, res) => {
  try {
    const { fullName, email, password } = req.body || {};
    if (!fullName || !email || !password)
      return res.status(400).json({ success: false, message: 'fullName, email, password required' });

    const exists = await User.findOne({ email: (email || '').toLowerCase() });
    if (exists) return res.status(409).json({ success: false, message: 'User already exists' });

    const [firstName = '', ...rest] = fullName.trim().split(' ');
    const lastName = rest.join(' ');
    const passwordHash = await bcrypt.hash(password, 10);

    const user = await User.create({
      email: email.toLowerCase(),
      passwordHash,
      firstName,
      lastName,
      role: 'student'
    });

    const token = signToken(user);
    res.json({ success: true, token, user: { id: user._id, email: user.email, firstName, lastName } });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ success: false, message: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ success: false, message: 'email and password required' });
    const user = await User.findOne({ email: (email || '').toLowerCase() });
    if (!user) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    const token = signToken(user);
    res.json({
      success: true,
      token,
      user: { id: user._id, email: user.email, firstName: user.firstName, lastName: user.lastName }
    });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ success: false, message: 'Login failed' });
  }
});

app.get('/api/me', optionalAuth, async (req, res) => {
  if (!req.user) return res.json({ success: true, user: null });
  const user = await User.findById(req.user.uid).select('_id email firstName lastName role');
  res.json({ success: true, user });
});

/* ---------------- Bookings (student) ---------------- */

// TRIAL booking — работает и с JWT, и без (гость)
app.post('/api/bookings/trial', optionalAuth, async (req, res) => {
  try {
    const { date, time, level } = req.body || {};
    if (!date || !time) return res.status(400).json({ success: false, message: 'date and time are required' });

    let userDoc = null;
    if (req.user && req.user.uid) {
      userDoc = await User.findById(req.user.uid);
      if (!userDoc) return res.status(401).json({ success: false, message: 'Auth user not found' });
    } else {
      // гость — достаём email из разных полей/заголовков
      const candidates = [
        req.body.email,
        req.body.userEmail,
        req.body.contactEmail,
        req.body.login,
        req.body.username,
        req.headers['x-user-email']
      ]
        .map((v) => (v || '').toString().trim())
        .filter(Boolean);
      let email = (candidates[0] || '').toLowerCase();
      if (!email) email = `guest+${Date.now()}@guest.local`;
      userDoc =
        (await User.findOne({ email })) ||
        (await User.create({
          email,
          passwordHash: await bcrypt.hash(Math.random().toString(36).slice(2), 10),
          role: 'student',
          isGuest: true
        }));
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

    res.json({ success: true, booking });
  } catch (e) {
    console.error('Trial booking error:', e);
    res.status(500).json({ success: false, message: 'Booking failed' });
  }
});

app.post('/api/book', auth, async (req, res) => {
  try {
    const { email, childName, parentName, childAge, country, timeZone, date, time, level } = req.body || {};
    if (!date || !time || !childName || !parentName || !email || !level) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const booking = await Booking.create({
      user: req.user.uid,
      email,
      childName,
      parentName,
      childAge,
      country,
      timeZone,
      dateStr: date,
      timeStr: time,
      level,
      status: 'Scheduled',
      teacherName: process.env.TEACHER_NAME || 'Teacher'
    });

    // Отвечаем сразу (не ждём почту)
    res.json({ success: true, booking });

    // Письма — в фоне
    setImmediate(async () => {
      const htmlAdmin = `
        <h2>New trial booking</h2>
        <p><strong>Child:</strong> ${childName}</p>
        <p><strong>Parent:</strong> ${parentName}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Date & Time:</strong> ${date} ${time}${timeZone ? ` (${timeZone})` : ''}</p>
        <p><strong>Level:</strong> ${level}</p>
      `;
      await sendEmailSafe({
        to: ADMIN_TO,
        subject: `🗓️ New trial booking: ${childName} (${date} ${time})`,
        html: htmlAdmin
      });

      const htmlStudent = `
        <h2>Your trial lesson is scheduled ✅</h2>
        <p><strong>Date & Time:</strong> ${date} ${time}${timeZone ? ` (${timeZone})` : ''}</p>
        <p><strong>Teacher:</strong> ${process.env.TEACHER_NAME || 'Teacher'}</p>
        <p>If you have questions, just reply to this email.</p>
      `;
      await sendEmailSafe({
        to: email,
        subject: `Your trial lesson is scheduled (${date} ${time})`,
        html: htmlStudent
      });
    });
  } catch (e) {
    console.error('Book error:', e);
    res.status(500).json({ success: false, message: 'Booking failed' });
  }
});

/* ---------------- Admin: update booking status (example) ---------------- */
app.patch('/api/admin/bookings/:id/status', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};
  if (!LESSON_STATUSES.includes(status)) return res.status(400).json({ success: false, message: 'Bad status' });

  const b = await Booking.findByIdAndUpdate(id, { status }, { new: true });
  if (!b) return res.status(404).json({ success: false, message: 'Not found' });

  // Письмо ученику — в фоне
  if (b.email) {
    const statusText = b.status;
    const html = `
      <h2>Update for your lesson</h2>
      <p><strong>Status:</strong> ${statusText}</p>
      <p><strong>Date & Time:</strong> ${b.dateStr || '—'} ${b.timeStr || ''}</p>
      <p><strong>Teacher:</strong> ${b.teacherName || '—'}</p>
      <p>If you have questions, just reply to this email.</p>
    `;
    sendEmailSafe({ to: b.email, subject: `Lesson status updated: ${statusText}`, html }).catch(() => {});
  }

  res.json({ success: true, booking: b });
});

/* ---------------- Admin stats (unchanged) ---------------- */
app.get('/api/admin/stats', requireAdmin, async (_req, res) => {
  const [usersTotal, bookingsTotal, scheduled, completed, cancelled, noshow] = await Promise.all([
    User.countDocuments({}),
    Booking.countDocuments({}),
    Booking.countDocuments({ status: 'Scheduled' }),
    Booking.countDocuments({ status: 'Completed' }),
    Booking.countDocuments({ status: 'Cancelled' }),
    Booking.countDocuments({ status: 'No-Show' })
  ]);
  res.json({
    success: true,
    usersTotal,
    bookingsTotal,
    byStatus: { Scheduled: scheduled, Completed: completed, Cancelled: cancelled, 'No-Show': noshow }
  });
});

/* ---------------- Admin create lesson ---------------- */
app.post('/api/admin/bookings/create', requireAdmin, async (req, res) => {
  try {
    const { email, childName, parentName, childAge, country, timeZone, dateStr, timeStr, level, teacherName } =
      req.body || {};
    if (!email || !childName || !parentName || !dateStr || !timeStr || !level) {
      return res
        .status(400)
        .json({ success: false, message: 'Missing required fields: email, childName, parentName, dateStr, timeStr, level' });
    }
    let user = await User.findOne({ email: (email || '').toLowerCase() });
    if (!user) {
      user = await User.create({
        email: (email || '').toLowerCase(),
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
    res.json({ success: true, booking });
  } catch (e) {
    console.error('Admin create lesson failed:', e);
    res.status(500).json({ success: false, message: 'Admin create lesson failed' });
  }
});

/* ---------------- Schedule feed (unchanged core) ---------------- */
app.get('/api/schedule', optionalAuth, async (req, res) => {
  try {
    const from = new Date(req.query.from);
    const to = new Date(req.query.to);
    if (Number.isNaN(+from) || Number.isNaN(+to)) {
      return res.status(400).json({ success: false, message: 'Bad from/to' });
    }

    // возвращаем активные слоты one-off и отфильтрованные recurring (упрощённо)
    const oneoff = await TimeSlot.find({
      kind: 'oneoff',
      isActive: true,
      startISO: { $gte: from, $lte: to }
    }).sort({ startISO: 1 });

    const recurring = await TimeSlot.find({ kind: 'recurring', isActive: true }).sort({ dow: 1, startTime: 1 });

    res.json({ success: true, oneoff, recurring });
  } catch (e) {
    console.error('Schedule error:', e);
    res.status(500).json({ success: false, message: 'Schedule failed' });
  }
});

/* ---------------- Startup ---------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server listening on ' + PORT));