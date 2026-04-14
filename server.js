// server.js - Admin API + CORS + Static admin-ui + Teacher application + Schedule + Bookings
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
const fs = require('fs');
const path = require('path');
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

// --- CORS (including preflight) ---
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

// Universal preflight handler
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

// Serve admin UI as static
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
  role: { type: String, default: 'student' }, // 'student' | 'teacher' | 'manager' | 'admin'
  isGuest: { type: Boolean, default: false },
  assignedTeacher: { type: Schema.Types.ObjectId, ref: 'User' },
  resetCode: { type: String }
}, { timestamps: true });
const User = model('User', UserSchema);

const BookingSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  email: { type: String, required: true },
  phone: { type: String, default: 'Not provided' },
  childName: { type: String, required: true },
  parentName: { type: String, required: true },
  childAge: { type: Number },
  country: { type: String },
  timeZone: { type: String },
  dateStr: { type: String, required: true },
  timeStr: { type: String, required: true },
  level:   { type: String, required: true },
  isTrial: { type: Boolean, default: false }, // ADDED: identifies trial lessons
  status:  { type: String, default: 'PendingPayment' }, 
  teacherName: { type: String, default: process.env.TEACHER_NAME || 'Teacher' },
  teacherId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  start: { type: Date, required: true },
  end: { type: Date, required: true }
}, { timestamps: true });
const Booking = model('Booking', BookingSchema);

// DeferredCredit model to track how many lessons a student has moved to a specific month
const DeferredCreditSchema = new Schema({
  student: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  month: { type: String, required: true }, // YYYY-MM, e.g. "2026-04"
  count: { type: Number, default: 0, min: 0, max: 2 } // max 2 per month
}, { timestamps: true });
// Unique index ensures one record per student per month
DeferredCreditSchema.index({ student: 1, month: 1 }, { unique: true });
const DeferredCredit = model('DeferredCredit', DeferredCreditSchema);

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
    teacherId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    // NEW FIELDS FOR FIXED GRID:
    studentId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    studentName: String,
    note: String,
    isActive: { type: Boolean, default: true }
  }, { timestamps: true });
  TimeSlot = mongoose.model('TimeSlot', TimeSlotSchema);
}

/* ---------------- Mailer (Brevo SMTP 2525) ---------------- */
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
  port: process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT) : 2525,
  secure: false, 
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

// Check connection on startup
transporter.verify((error, success) => {
  if (error) {
    console.error('SMTP connection failed:', error.message);
  } else {
    console.log('SMTP server is ready on port 2525');
  }
});

const ADMIN_TO = process.env.ADMIN_BOOKINGS_TO || process.env.NOTIFY_TO || process.env.EMAIL_USER;
const FROM_EMAIL = process.env.BREVO_FROM || process.env.EMAIL_USER;
const REPLY_TO   = process.env.REPLY_TO   || process.env.NOTIFY_TO || process.env.EMAIL_USER;

async function sendEmail(opts) {
  try {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      console.error('Email credentials missing');
      return false;
    }
    const result = await transporter.sendMail({
      from: `"Grand English Courses" <${FROM_EMAIL}>`, 
      replyTo: REPLY_TO,                                 
      ...opts
    });
    console.log('Email sent successfully to:', opts.to);
    return true;
  } catch (e) {
    console.error('Email send failed:', e.message);
    return false;
  }
}

/* ---------------- JWT ---------------- */
function signToken(user) {
  if (!process.env.JWT_SECRET) throw new Error('Missing JWT_SECRET in .env');
  return jwt.sign(
    { 
      uid: user._id, 
      id: user._id, 
      email: user.email, 
      role: user.role 
    },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function auth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) {
      return res.status(401).json({ success:false, code:'MISSING_TOKEN', message:'Missing Authorization header' });
    }
    const theToken = h.slice(7).trim();
    if (!theToken) {
      return res.status(401).json({ success:false, code:'EMPTY_TOKEN', message:'Empty bearer token' });
    }
    const payload = jwt.verify(theToken, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ success:false, code:'INVALID_TOKEN', message:'Invalid or expired token' });
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

/* -------- Admin guard -------- */
const ADMIN_PAGE_SIZE_DEFAULT = 25;
const LESSON_STATUSES = ['PendingPayment','Scheduled','Completed','Cancelled','No-Show','Rescheduled'];

async function requireAdmin(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return res.status(401).json({ success:false, message:'Missing token' });
    const payload = jwt.verify(h.slice(7), process.env.JWT_SECRET);
    const u = await User.findById(payload.uid).select('_id email role');
    if (!u) return res.status(401).json({ success:false, message:'User not found' });
    
    if (u.email === 'shakhrom.azimov99@gmail.com' || ['admin','manager'].includes(u.role)) {
      req.admin = { id: u._id, email: u.email, role: 'admin' };
      return next();
    }
    return res.status(403).json({ success:false, message:'Admin or manager only' });
  } catch (e) {
    return res.status(401).json({ success:false, message:'Invalid token' });
  }
}

/* -------- Teacher (or Admin) guard -------- */
async function requireTeacher(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: 'Missing token' });
    }
    
    const payload = jwt.verify(h.slice(7), process.env.JWT_SECRET);
    const u = await User.findById(payload.uid).select('_id email role');
    if (!u) {
        return res.status(401).json({ success: false, message: 'User not found' });
    }

    if (u.email === 'shakhrom.azimov99@gmail.com' || ['admin', 'teacher', 'manager'].includes(u.role)) {
      req.user = { id: u._id, email: u.email, role: u.role, uid: u._id }; 
      return next(); 
    }
    return res.status(403).json({ success: false, message: 'Teacher access required' });
  } catch (e) {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
}

/* ---------------- Health ---------------- */
app.get('/health', (req, res) => res.json({ ok: true }));

/* ---------------- Teachers form (audio) ---------------- */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const tmpDir = path.join('/tmp', 'uploads-' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    cb(null, tmpDir);
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, Date.now() + '-' + safeName);
  }
});
const upload = multer({
  storage: storage,
  limits: { fileSize: 25 * 1024 * 1024 }
}).any();

app.post('/submit', (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message });

    const tmpDir = req.files && req.files.length > 0 ? path.dirname(req.files[0].path) : null;
    try {
      if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        return res.status(500).json({ success:false, message:'Email service not configured' });
      }

      const filePromises = (req.files || []).map(async (f) => {
        const buffer = await fs.promises.readFile(f.path);
        return {
          fieldname: f.fieldname,
          originalname: f.originalname,
          mimetype: f.mimetype,
          buffer,
          size: f.size
        };
      });
      const fileObjs = await Promise.all(filePromises);
      const files = {};
      for (const f of fileObjs) files[f.fieldname] = f;

      const fQ1 = files['audioQ1'] || null;
      const fQ2 = files['audioQ2'] || null;
      const fMain = files['audio'] || null;
      const fCV = files['cv'] || files['resume'] || files['cvFile'] || null;

      if (!fCV) return res.status(400).json({ success: false, message: 'Missing required file: CV' });
      if (!fQ1 && !fQ2 && !fMain) return res.status(400).json({ success: false, message: 'Missing audio file' });

      const {
        email='-', fullname='-', age='-', country='-', languages='',
        timezone='-', experience='-', quizAnswers='{}', quizScore='-', quizPercentage='-'
      } = req.body;

      const parsedLanguages = languages ? String(languages).split(',').map(l=>l.trim()) : [];
      const a1 = await normalizeToMp3(fQ1, 'speaking-q1.webm');
      const a2 = await normalizeToMp3(fQ2, 'speaking-q2.webm');
      const aMain = await normalizeToMp3(fMain, 'speaking-assessment.webm');

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
          attachments.push(att);
        }
      }

      if (fCV) pushUnique({ filename: fCV.originalname || 'CV', content: fCV.buffer, contentType: fCV.mimetype || 'application/octet-stream' });
      if (a1) pushUnique(a1);
      if (a2) pushUnique(a2);
      if (aMain) pushUnique(aMain);

      await sendEmail({
        to: ADMIN_TO,
        subject: `New application from ${fullname}`,
        html: `
          <h2>New Teacher Application</h2>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Name:</strong> ${fullname}</p>
          <p><strong>Country:</strong> ${country}</p>
          <p><strong>Age:</strong> ${age}</p>
          <p><strong>Timezone:</strong> ${timezone}</p>
          <p><strong>Languages:</strong> ${parsedLanguages.join(', ')}</p>
          <p><strong>Experience:</strong> ${experience}</p>
          <p><strong>Test Score:</strong> ${quizScore}/20 (${quizPercentage}%)</p>
        `,
        attachments
      });

      res.status(201).json({ success:true, message:'Application submitted successfully' });
    } catch (err) {
      console.error('Error submitting application:', err);
      res.status(500).json({ success:false, message:'Internal server error', error: err.message });
    } finally {
      if (tmpDir && tmpDir.startsWith('/tmp')) {
        fs.rm(tmpDir, { recursive: true, force: true }, () => {});
      }
    }
  });
});

/* ---------------- Auth APIs ---------------- */
app.post('/api/forgot-password/send-code', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email required' });
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    user.resetCode = code;
    await user.save();

    await sendEmail({
      to: email,
      subject: `Your Password Reset Code: ${code}`,
      html: `<h3>Password Reset</h3><p>Hello,</p><p>Your code to reset your password is: <strong style="color:#2563EB; font-size: 20px;">${code}</strong></p>`
    });
    res.json({ success: true, message: 'Code sent' });
  } catch(e) { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.post('/api/forgot-password/reset', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    const user = await User.findOne({ email: email.toLowerCase(), resetCode: code });
    if (!user) return res.status(400).json({ success: false, message: 'Invalid code or email' });

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    user.resetCode = undefined;
    await user.save();
    res.json({ success: true, message: 'Password updated' });
  } catch(e) { res.status(500).json({ success: false, message: 'Server error' }); }
});

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
    res.json({ success:true, token, user:{ id:user._id, email:user.email, firstName, lastName, role:user.role } });
  } catch (e) {
    res.status(500).json({ success:false, message:'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if(!email || !password) return res.status(400).json({ success:false, message:'Email and password required' });
    const user = await User.findOne({ email:(email||'').toLowerCase() });
    if (!user) return res.status(401).json({ success:false, message:'Invalid credentials' });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ success:false, message:'Invalid credentials' });
    const token = signToken(user);
    res.json({ success:true, token, user:{ id:user._id, email:user.email, firstName:user.firstName, lastName:user.lastName, role:user.role } });
  } catch (e) {
    res.status(500).json({ success:false, message:'Login failed' });
  }
});

app.get('/api/me', optionalAuth, async (req, res) => {
  if (!req.user) return res.json({ success:true, user:null });
  const user = await User.findById(req.user.uid).select('_id email firstName lastName role assignedTeacher');
  res.json({ success:true, user });
});

/* ---------------- Bookings (student) ---------------- */
async function isSlotBooked(start, duration = 25, excludeId = null, studentId = null, teacherId = null) {
  const end = new Date(start.getTime() + duration * 60 * 1000);
  
  // 1. Check existing Bookings
  const query = {
    status: { $in: ['Scheduled', 'Rescheduled', 'PendingPayment'] }, 
    $or: [
      { start: { $lt: end }, end: { $gt: start } } 
    ]
  };
  if (excludeId) query._id = { $ne: excludeId };
  if (teacherId) query.teacherId = teacherId;
  
  const existingBooking = await Booking.findOne(query);
  if (existingBooking) return true;

  // 2. Check TimeSlots
  const dow = start.getUTCDay();
  const timeStr = start.toISOString().split('T')[1].substring(0,5);
  
  const slotQuery = {
    $or: [
      { kind: 'oneoff', startISO: { $lt: end }, endISO: { $gt: start } },
      { kind: 'recurring', dow: dow, startTime: timeStr }
    ]
  };
  if (teacherId) slotQuery.teacherId = teacherId;

  const blockingSlots = await TimeSlot.find(slotQuery);

  for (const slot of blockingSlots) {
     // Explicitly closed by teacher
     if (slot.isActive === false) return true;
     // Assigned to another student
     if (slot.studentId && studentId && slot.studentId.toString() !== studentId.toString()) {
        return true;
     }
  }
  return false;
}

function getNextMonthKey(fromDate = new Date()) {
  const d = new Date(fromDate);
  d.setMonth(d.getMonth() + 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function getMonthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`;
}

app.get('/api/student/deferred', auth, async (req, res) => {
  try {
    const { month } = req.query;
    const targetMonth = month || getNextMonthKey(); 
    let deferred = await DeferredCredit.findOne({ student: req.user.uid, month: targetMonth });
    res.json({ success: true, count: deferred ? deferred.count : 0, month: targetMonth });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/bookings/:id/move-to-next-month', auth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ success: false, message: 'Invalid booking ID' });

    const booking = await Booking.findOne({ _id: id, user: req.user.uid }).populate('teacherId');
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

    const now = Date.now();
    const lessonTime = booking.start.getTime();
    const hoursUntil = (lessonTime - now) / (1000 * 60 * 60);
    
    if (hoursUntil < 8) return res.status(400).json({ success: false, message: 'Cannot move a lesson that starts in less than 8 hours' });
    if (booking.status !== 'Scheduled' && booking.status !== 'Rescheduled') {
      return res.status(400).json({ success: false, message: 'Only scheduled lessons can be moved' });
    }

    const nextMonth = getNextMonthKey(); 
    let deferred = await DeferredCredit.findOne({ student: req.user.uid, month: nextMonth });
    const currentCount = deferred ? deferred.count : 0;
    if (currentCount >= 2) return res.status(400).json({ success: false, message: 'Maximum 2 lessons can be moved to next month' });

    booking.status = 'Cancelled';
    await booking.save();

    if (!deferred) {
      deferred = new DeferredCredit({ student: req.user.uid, month: nextMonth, count: 1 });
    } else {
      deferred.count += 1;
    }
    await deferred.save();

    await sendEmail({
      to: ADMIN_TO,
      subject: `📅 Lesson moved to next month: ${booking.childName}`,
      html: `
        <h2>Lesson Deferred</h2>
        <p><strong>Student:</strong> ${booking.childName} (${booking.parentName})</p>
        <p><strong>Original time:</strong> ${booking.dateStr} ${booking.timeStr}</p>
        <p><strong>Moved to month:</strong> ${nextMonth}</p>
        <p>This student now has ${deferred.count}/2 deferred credits for that month.</p>
      `
    });

    await sendEmail({
      to: booking.email,
      subject: 'Your lesson has been moved to next month',
      html: `
        <h2>Lesson moved</h2>
        <p>Dear ${booking.parentName},</p>
        <p>The lesson for <strong>${booking.childName}</strong> originally scheduled for ${booking.dateStr} at ${booking.timeStr} has been moved to next month (${nextMonth}).</p>
        <p>You can now book a new lesson in ${nextMonth} using your deferred credit. You have <strong>${deferred.count}/2</strong> deferred lessons for next month.</p>
      `
    });

    if (booking.teacherId && booking.teacherId.email) {
      await sendEmail({
        to: booking.teacherId.email,
        subject: `Lesson Cancelled (Deferred): ${booking.childName} (${booking.dateStr})`,
        html: `
          <h3>Lesson deferred by student</h3>
          <p>Student: <b>${booking.childName}</b></p>
          <p>Freed date: ${booking.dateStr} at ${booking.timeStr}</p>
          <p>This slot is now available in your schedule.</p>
        `
      });
    }

    res.json({ success: true, deferredCount: deferred.count });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to move lesson' });
  }
});

// TRIAL booking - Smart Endpoint (Handles New & Reschedule)
app.post('/api/bookings/trial', optionalAuth, async (req, res) => {
  try {
    const { startISO, level, phone, childName, parentName, childAge, country, timeZone, date, time } = req.body || {};
    
    if (!startISO) return res.status(400).json({ success:false, message:'startISO is required' });

    const start = new Date(startISO);
    if (isNaN(start)) return res.status(400).json({ success:false, message:'Invalid startISO' });
    const end = new Date(start.getTime() + 25 * 60 * 1000); 

    // FIX TIMEZONE ISSUE: Use exact strings from frontend/bot if available
    const dateStr = date || start.toISOString().split('T')[0];
    const timeStr = time || start.toISOString().split('T')[1].substring(0,5);

    let userDoc = null;
    if (req.user && req.user.uid) {
      userDoc = await User.findById(req.user.uid);
      if (!userDoc) return res.status(401).json({ success:false, message:'Auth user not found' });
    } else {
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

    // CHECK IF ACTIVE TRIAL ALREADY EXISTS
    const existingTrial = await Booking.findOne({
      user: userDoc._id,
      isTrial: true,
      status: { $in: ['Scheduled', 'Rescheduled', 'PendingPayment'] }
    });

    if (existingTrial) {
      // RESCHEDULE EXISTING TRIAL
      if (await isSlotBooked(start, 25, existingTrial._id, userDoc._id, null)) {
        return res.status(409).json({ success:false, message:'This time slot is already booked' });
      }

      const oldDate = existingTrial.dateStr;
      const oldTime = existingTrial.timeStr;

      existingTrial.dateStr = dateStr;
      existingTrial.timeStr = timeStr;
      existingTrial.start = start;
      existingTrial.end = end;
      existingTrial.status = 'Rescheduled';
      await existingTrial.save();

      await sendEmail({
        to: ADMIN_TO,
        subject: `🔄 Trial Rescheduled: ${existingTrial.childName} (${dateStr} ${timeStr})`,
        html: `
          <h2>Trial Lesson Rescheduled</h2>
          <p><strong>Student:</strong> ${existingTrial.childName} (${existingTrial.parentName})</p>
          <p><strong>New Time:</strong> ${dateStr} at ${timeStr}</p>
          <p><strong>Previous Time:</strong> ${oldDate} at ${oldTime}</p>
        `
      });

      if (existingTrial.email && !existingTrial.email.includes('guest.local')) {
        await sendEmail({
          to: existingTrial.email,
          subject: `🔄 Trial Lesson Rescheduled - ${dateStr} at ${timeStr}`,
          html: `
            <h2>Trial Lesson Rescheduled</h2>
            <p>Dear ${existingTrial.parentName},</p>
            <p>Your trial lesson for <strong>${existingTrial.childName}</strong> has been updated.</p>
            <p><strong>New Date:</strong> ${dateStr}</p>
            <p><strong>New Time:</strong> ${timeStr} (${timeZone || ''})</p>
            <p>We look forward to seeing you!</p>
          `
        });
      }

      return res.json({ success:true, booking: existingTrial, isRescheduled: true });
    }

    // CREATE NEW TRIAL
    if (await isSlotBooked(start, 25, null, userDoc._id, null)) {
      return res.status(409).json({ success:false, message:'This time slot is already booked' });
    }

    const booking = await Booking.create({
      user: userDoc._id,
      email: userDoc.email,
      phone: phone || '',
      childName: childName || 'Trial Student',
      parentName: parentName || (userDoc.firstName || 'Parent') + (userDoc.lastName ? ' ' + userDoc.lastName : ''),
      childAge: childAge || null,
      country: country || '',
      timeZone: timeZone || '',
      dateStr,
      timeStr,
      level: level || 'Beginner',
      status: 'Scheduled',
      isTrial: true,
      teacherName: process.env.TEACHER_NAME || 'Teacher',
      start,
      end
    });

    await sendEmail({
      to: ADMIN_TO,
      subject: `🗓️ New trial booking: ${booking.childName} (${dateStr} ${timeStr})`,
      html: `
        <h2>New Booking (Trial)</h2>
        <p><strong>Parent:</strong> ${booking.parentName}</p>
        <p><strong>Child:</strong> ${booking.childName} (${booking.childAge || '-'} y.o.)</p>
        <p><strong>Phone:</strong> ${booking.phone}</p>
        <p><strong>Email:</strong> ${booking.email}</p>
        <p><strong>Date & Time:</strong> ${dateStr} ${timeStr}</p>
      `
    });

    if (booking.email && !booking.email.includes('guest.local')) {
      await sendEmail({
        to: booking.email,
        subject: `🗓️ Your Trial Lesson Confirmation - ${dateStr} at ${timeStr}`,
        html: `
          <h2>Lesson Booked Successfully!</h2>
          <p>Dear ${booking.parentName},</p>
          <p>Your trial lesson for <strong>${booking.childName}</strong> has been scheduled.</p>
          <p><strong>Date:</strong> ${dateStr}</p>
          <p><strong>Time:</strong> ${timeStr} (${booking.timeZone||''})</p>
          <p>We look forward to seeing you!</p>
        `
      });
    }

    res.json({ success:true, booking });
  } catch (e) {
    console.error('Trial booking error:', e);
    res.status(500).json({ success:false, message:'Booking failed' });
  }
});

// Regular booking endpoint (for schedule lessons)
app.post('/api/book', auth, async (req, res) => {
  try {
    const { email, childName, parentName, childAge, country, timeZone, level, phone, startISO, useDeferred, date, time } = req.body;
    if (!startISO || !childName || !parentName || !email || !level) {
      return res.status(400).json({ success:false, message:'Missing required fields' });
    }

    const start = new Date(startISO);
    if (isNaN(start)) return res.status(400).json({ success:false, message:'Invalid startISO' });
    const end = new Date(start.getTime() + 25 * 60 * 1000); 

    const dateStr = date || start.toISOString().split('T')[0];
    const timeStr = time || start.toISOString().split('T')[1].substring(0,5);

    const studentUser = await User.findById(req.user.uid);
    const assignedTeacherId = studentUser ? studentUser.assignedTeacher : null;

    if (await isSlotBooked(start, 25, null, req.user.uid, assignedTeacherId)) {
      return res.status(409).json({ success:false, message:'This time slot is already booked' });
    }

    const monthKey = getMonthKey(start);
    let deferredUsed = false;
    if (useDeferred) {
      const deferred = await DeferredCredit.findOne({ student: req.user.uid, month: monthKey });
      if (deferred && deferred.count > 0) {
        deferred.count -= 1;
        await deferred.save();
        deferredUsed = true;
      } else {
        return res.status(400).json({ success: false, message: 'No deferred credits available' });
      }
    }

   const booking = await Booking.create({
      user: req.user.uid,
      email, childName, parentName, childAge, country, timeZone,
      phone: phone || '',
      dateStr, timeStr, level,
      status: 'PendingPayment', 
      teacherName: process.env.TEACHER_NAME || 'Teacher',
      teacherId: assignedTeacherId, 
      start, end
    });

    await sendEmail({
      to: ADMIN_TO,
      subject: `🗓️ New lesson booking: ${childName} (${dateStr} ${timeStr})${deferredUsed ? ' [Deferred credit used]' : ''}`,
      html: `
        <h2>New booking</h2>
        <p><strong>Child:</strong> ${childName}</p>
        <p><strong>Parent:</strong> ${parentName}</p>
        <p><strong>Phone:</strong> ${phone || 'Not provided'}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Level:</strong> ${level}</p>
        <p><strong>Date & Time:</strong> ${dateStr} ${timeStr} (${timeZone||'—'})</p>
        <p><strong>Country:</strong> ${country||'—'}</p>
        ${deferredUsed ? '<p><strong>Note:</strong> This booking used a deferred credit.</p>' : ''}
      `
    });

    await sendEmail({
      to: email,
      subject: `Your Lesson Confirmation - ${dateStr} at ${timeStr}`,
      html: `
        <h2>Lesson Booked Successfully!</h2>
        <p>Dear ${parentName},</p>
        <p>Your lesson for <strong>${childName}</strong> has been scheduled.</p>
        <p><strong>Date:</strong> ${dateStr}</p>
        <p><strong>Time:</strong> ${timeStr} (${timeZone||''})</p>
        <p><strong>Level:</strong> ${level}</p>
        <p><strong>Teacher:</strong> ${process.env.TEACHER_NAME || 'Teacher'}</p>
        ${deferredUsed ? '<p><strong>Note:</strong> This booking used a deferred credit.</p>' : ''}
        <p>We look forward to seeing you!</p>
      `
    });

    res.json({ success:true, booking, deferredUsed });
  } catch (e) {
    console.error('Book error:', e);
    res.status(500).json({ success:false, message:'Booking failed' });
  }
});

// BULK BOOKING ENDPOINT
app.post('/api/book/bulk', auth, async (req, res) => {
  try {
    const { slots, email, childName, parentName, childAge, country, timeZone, level, phone, isFixed } = req.body;
    if (!slots || !Array.isArray(slots) || slots.length === 0) {
      return res.status(400).json({ success: false, message: 'No slots provided' });
    }
    
    const createdBookings = [];
    const studentUser = await User.findById(req.user.uid);
    const assignedTeacherId = studentUser ? studentUser.assignedTeacher : null;

    if (isFixed) {
        for (const slot of slots) {
            const start = new Date(slot.startISO);
            if (isNaN(start)) continue;

            await TimeSlot.findOneAndUpdate(
                { 
                    kind: 'recurring', 
                    dow: start.getUTCDay(), 
                    startTime: start.toISOString().split('T')[1].substring(0,5),
                    teacherId: assignedTeacherId 
                },
                { 
                    studentId: req.user.uid, 
                    studentName: childName || 'Student', 
                    isActive: true, 
                    teacherId: assignedTeacherId, 
                    teacherName: process.env.TEACHER_NAME || 'Teacher' 
                },
                { upsert: true, new: true }
            );

            for (let i = 0; i < 4; i++) {
                const bStart = new Date(start.getTime() + i * 7 * 24 * 60 * 60 * 1000);
                const bEnd = new Date(bStart.getTime() + 25 * 60 * 1000);

                if (await isSlotBooked(bStart, 25, null, req.user.uid, assignedTeacherId)) continue;

                const booking = await Booking.create({
                    user: req.user.uid, email, childName, parentName, childAge, country, timeZone,
                    phone: phone || '',
                    dateStr: bStart.toISOString().split('T')[0],
                    timeStr: bStart.toISOString().split('T')[1].substring(0,5),
                    level,
                    status: 'PendingPayment',
                    teacherId: assignedTeacherId, 
                    teacherName: process.env.TEACHER_NAME || 'Teacher',
                    start: bStart, end: bEnd
                });
                createdBookings.push(booking);
            }
        }
    } else {
        for (const slot of slots) {
          const start = new Date(slot.startISO);
          if (isNaN(start)) continue;
          
          if (await isSlotBooked(start, 25, null, req.user.uid, assignedTeacherId)) continue; 
          
          const dateStr = start.toISOString().split('T')[0];
          const timeStr = start.toISOString().split('T')[1].substring(0,5);
          const end = new Date(start.getTime() + 25 * 60 * 1000);
          
          const booking = await Booking.create({
            user: req.user.uid, email, childName, parentName, childAge, country, timeZone,
            phone: phone || '', dateStr, timeStr, level, status: 'PendingPayment',
            teacherId: assignedTeacherId, 
            teacherName: process.env.TEACHER_NAME || 'Teacher', start, end
          });
          createdBookings.push(booking);
        }
    }
    
    if (createdBookings.length === 0) {
      return res.status(409).json({ success: false, message: 'All selected slots were already booked' });
    }

    const slotsHtml = createdBookings.map(b => `<li>${b.dateStr} at ${b.timeStr}</li>`).join('');
    await sendEmail({
      to: ADMIN_TO,
      subject: `🗓️ Bulk lesson booking: ${childName} (${createdBookings.length} lessons)`,
      html: `
        <h2>New bulk booking</h2>
        <p><strong>Student:</strong> ${childName}</p>
        <p><strong>Parent:</strong> ${parentName}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Total lessons:</strong> ${createdBookings.length}</p>
        <p><strong>Type:</strong> ${isFixed ? 'Fixed Slots (4 Weeks)' : 'One-off'}</p>
        <ul>${slotsHtml}</ul>
      `
    });

    res.json({ success: true, count: createdBookings.length, bookings: createdBookings });
  } catch (e) {
    console.error('Bulk book error:', e);
    res.status(500).json({ success: false, message: 'Bulk booking failed' });
  }
});

app.get('/api/my-bookings', auth, async (req, res) => {
  try {
    const items = await Booking.find({ user: req.user.uid }).sort({ createdAt: -1 }).lean();
    res.json({ success:true, bookings: items.map(x => ({ ...x, status: (x.status||'').toLowerCase() })) });
  } catch (e) {
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
    
    await sendEmail({
      to: ADMIN_TO,
      subject: `❌ Booking Cancelled: ${b.childName}`,
      html: `
        <h2>Booking Cancelled</h2>
        <p><strong>Student:</strong> ${b.childName}</p>
        <p><strong>Parent:</strong> ${b.parentName}</p>
        <p><strong>Date:</strong> ${b.dateStr} ${b.timeStr}</p>
      `
    });

    res.json({ success:true, booking: b });
  } catch (e) {
    res.status(500).json({ success:false, message:'Cancel failed' });
  }
});

// RESCHEDULE
app.post('/api/bookings/:id/reschedule', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { startISO, level, date, time } = req.body;
    const b = await Booking.findOne({ _id: id, user: req.user.uid });
    if (!b) return res.status(404).json({ success:false, message:'Not found' });
    
    if (!startISO) return res.status(400).json({ success:false, message:'startISO is required' });
    const newStart = new Date(startISO);
    if (isNaN(newStart)) return res.status(400).json({ success:false, message:'Invalid startISO' });
    const newEnd = new Date(newStart.getTime() + 25 * 60 * 1000); 

    const newDateStr = date || newStart.toISOString().split('T')[0];
    const newTimeStr = time || newStart.toISOString().split('T')[1].substring(0,5);

    if (await isSlotBooked(newStart, 25, b._id, req.user.uid, b.teacherId)) {
      return res.status(409).json({ success:false, message:'This time slot is already booked' });
    }

    const oldDate = b.dateStr;
    const oldTime = b.timeStr;

    b.dateStr = newDateStr;
    b.timeStr = newTimeStr;
    if (level) b.level = level;
    b.start = newStart;
    b.end = newEnd;
    b.status = 'Rescheduled';
    await b.save();

    await sendEmail({
      to: ADMIN_TO,
      subject: `🔄 Lesson Rescheduled: ${b.childName}`,
      html: `
        <h2>Lesson Rescheduled</h2>
        <p><strong>Student:</strong> ${b.childName} (${b.parentName})</p>
        <p><strong>Phone:</strong> ${b.phone || 'N/A'}</p>
        <p><strong>New Time:</strong> ${b.dateStr} at ${b.timeStr}</p>
        <p><strong>Previous Time:</strong> ${oldDate} at ${oldTime}</p>
        <p><strong>Country:</strong> ${b.country || '-'}</p>
      `
    });

    await sendEmail({
      to: b.email,
      subject: `Lesson Rescheduled - ${b.dateStr}`,
      html: `
        <h2>Your lesson has been rescheduled</h2>
        <p>Dear ${b.parentName},</p>
        <p>The lesson for <strong>${b.childName}</strong> has been moved to:</p>
        <p><strong>Date:</strong> ${b.dateStr}</p>
        <p><strong>Time:</strong> ${b.timeStr} (${b.timeZone})</p>
        <p>If this was a mistake, please contact us at info@grandenglishcourses.com </p>
      `
    });

    res.json({ success:true, booking: b });
  } catch (e) {
    console.error('Reschedule error:', e);
    res.status(500).json({ success:false, message:'Reschedule failed' });
  }
});

/* ---------------- Admin APIs ---------------- */
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
    res.status(500).json({ success:false, message:String(e) });
  }
});

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

  res.json({ success: true, page: pg, limit: per, total, users: items });
});

app.patch('/api/admin/users/:id/role', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { role } = req.body;
  if (!['student','teacher','manager','admin'].includes(role)) {
    return res.status(400).json({ success:false, message:'Invalid role' });
  }
  const user = await User.findByIdAndUpdate(id, { role }, { new: true }).select('_id email role');
  if (!user) return res.status(404).json({ success:false, message:'User not found' });
  res.json({ success:true, user });
});

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

  res.json({ success: true, page: pg, limit: per, total, bookings: items });
});

app.patch('/api/admin/bookings/:id/status', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status, dateStr, timeStr, level, teacherName, teacherId } = req.body || {};

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
  if (teacherId) b.teacherId = teacherId;

  if (dateStr && timeStr) {
    const newStart = new Date(`${dateStr}T${timeStr}:00`);
    if (!isNaN(newStart)) {
      b.start = newStart;
      b.end = new Date(newStart.getTime() + 25 * 60 * 1000); 
    }
  }

  await b.save();

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

// ===== Admin Deferred Credits =====
app.get('/api/admin/deferred', requireAdmin, async (req, res) => {
  try {
    const deferred = await DeferredCredit.find({})
      .populate('student', 'email firstName lastName')
      .sort({ month: -1, createdAt: -1 })
      .lean();
    res.json({ success: true, deferred });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to fetch deferred credits' });
  }
});

app.post('/api/admin/deferred', requireAdmin, async (req, res) => {
  try {
    const { studentEmail, month, count } = req.body;
    if (!studentEmail || !month || count === undefined) {
      return res.status(400).json({ success: false, message: 'Fields required' });
    }
    const student = await User.findOne({ email: studentEmail.toLowerCase() });
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    const deferred = await DeferredCredit.findOneAndUpdate(
      { student: student._id, month },
      { count: Math.min(count, 2) },
      { upsert: true, new: true }
    );
    res.json({ success: true, deferred });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to create deferred credit' });
  }
});

app.patch('/api/admin/deferred/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { count } = req.body;
    if (count === undefined || count < 0 || count > 2) {
      return res.status(400).json({ success: false, message: 'Count must be between 0 and 2' });
    }
    const deferred = await DeferredCredit.findByIdAndUpdate(id, { count }, { new: true });
    if (!deferred) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, deferred });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to update' });
  }
});

app.delete('/api/admin/deferred/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await DeferredCredit.findByIdAndDelete(id);
    if (!result) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to delete' });
  }
});

/* ---------------- Admin create lesson ---------------- */
const TEACHER_TZ_OFFSET = 5; 

app.post('/api/admin/bookings/create', requireAdmin, async (req, res) => {
  try {
    const { email, childName, parentName, childAge, country, timeZone, dateStr, timeStr, level, teacherName, teacherId } = req.body || {};
    if (!email || !childName || !parentName || !dateStr || !timeStr || !level) {
      return res.status(400).json({ success:false, message:'Missing required fields' });
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
    const localDate = new Date(`${dateStr}T${timeStr}:00`); 
    const start = new Date(localDate.getTime() - TEACHER_TZ_OFFSET * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 25 * 60 * 1000);

    const booking = await Booking.create({
      user: user._id,
      email: user.email,
      childName,
      parentName,
      childAge: childAge ?? null,
      country: country || '',
      timeZone: timeZone || '',
      dateStr: start.toISOString().split('T')[0],
      timeStr: start.toISOString().split('T')[1].substring(0,5),
      level,
      status: 'Scheduled',
      teacherName: teacherName || process.env.TEACHER_NAME || 'Teacher',
      teacherId: teacherId || null,
      start,
      end
    });
    res.json({ success:true, booking });
  } catch (e) {
    res.status(500).json({ success:false, message:'Admin create lesson failed' });
  }
});

/* ---------------- Teacher APIs ---------------- */

app.get('/api/teacher/dashboard', requireTeacher, async (req, res) => {
  try {
    const teacherId = req.user.id;
    const studentsCount = await User.countDocuments({ role: 'student', assignedTeacher: teacherId });
    
    const startOfMonth = new Date(new Date().setDate(1));
    const endOfMonth = new Date(new Date().setMonth(startOfMonth.getMonth() + 1, 0));
    
    const lessonsThisMonth = await Booking.countDocuments({
      teacherId: teacherId,
      start: { $gte: startOfMonth, $lte: endOfMonth },
      status: { $in: ['Completed', 'Conducted'] }
    });

    res.json({ success: true, studentsCount, lessonsThisMonth });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Dashboard load failed' });
  }
});

app.get('/api/teacher/students', requireTeacher, async (req, res) => {
  try {
    const teacherId = req.user.id;
    const students = await User.find({ role: 'student', assignedTeacher: teacherId })
                               .select('firstName lastName email')
                               .lean();
    res.json({ success: true, students });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to load students' });
  }
});

app.patch('/api/teacher/bookings/:id/status', requireTeacher, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    
    if (!['Completed', 'Conducted', 'No-Show'].includes(status)) {
       return res.status(400).json({ success: false, message: 'Invalid status update for teacher' });
    }

    const b = await Booking.findOne({ _id: id, teacherId: req.user.id });
    if (!b) {
      return res.status(404).json({ success: false, message: 'Booking not found or not assigned' });
    }

    b.status = status;
    await b.save();

    res.json({ success: true, booking: b });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to update lesson status' });
  }
});

app.get('/api/teacher/schedule', requireTeacher, async (req, res) => {
  const { from, to } = req.query;
  const teacherId = req.user.id; 
  const start = from ? new Date(from) : new Date(new Date().setDate(1)); 
  const end = to ? new Date(to) : new Date(new Date().setMonth(start.getMonth()+1, 0));

  const [bookings, slots] = await Promise.all([
    Booking.find({
      teacherId,
      start: { $gte: start, $lte: end },
      status: { $in: ['Scheduled', 'Rescheduled', 'PendingPayment'] }
    }).lean(),
    TimeSlot.find({
      teacherId,
      $or: [
        { kind: 'oneoff', startISO: { $lte: end }, endISO: { $gte: start } },
        { kind: 'recurring', $or: [
          { validFrom: { $lte: end }, validTo: { $gte: start } },
          { validFrom: { $exists: false }, validTo: { $exists: false } }
        ]}
      ]
    }).lean()
  ]);

  res.json({ success:true, bookings, slots });
});

app.get('/api/teacher/slots', requireTeacher, async (req, res) => {
  const teacherId = req.user.id; 
  const slots = await TimeSlot.find({ teacherId }).sort({ createdAt: -1 }).limit(500);
  res.json({ success:true, slots });
});

app.post('/api/teacher/slots', requireTeacher, async (req, res) => {
  const teacherId = req.user.id; 
  const teacher = await User.findById(teacherId);
  if (!teacher) return res.status(404).json({ success:false, message:'Teacher not found' });

  const slotData = { 
    ...req.body, 
    isActive: req.body.isActive !== undefined ? req.body.isActive : true,
    teacherId, 
    teacherName: (teacher.firstName || 'Teacher') + ' ' + (teacher.lastName || '')
  };
  const slot = await TimeSlot.create(slotData);
  res.json({ success:true, slot });
});

app.patch('/api/teacher/slots/:id/toggle', requireTeacher, async (req, res) => {
  try {
    const { id } = req.params;
    const query = { _id: id };
    
    if (!['admin', 'manager'].includes(req.user.role) && req.user.email !== 'shakhrom.azimov99@gmail.com') {
        query.teacherId = req.user.id;
    }

    const slot = await TimeSlot.findOne(query); 
    if (!slot) return res.status(404).json({ success:false, message:'Slot not found or access denied' });
    
    if (slot.isActive) {
        if (slot.studentId) {
            return res.status(400).json({ success: false, message: 'This slot is assigned to a student (Fixed Grid). You cannot close it until you unassign the student.' });
        }

        const now = new Date();
        const next12h = new Date(now.getTime() + 12 * 60 * 60 * 1000); 
        const nextMonth = new Date(now.getTime() + 35 * 24 * 60 * 60 * 1000); 
        let hasBookings = false;

        if (slot.kind === 'oneoff') {
            if (slot.startISO > now && slot.startISO < next12h) {
                return res.status(400).json({ success: false, message: 'Cannot close a slot less than 12 hours before it starts.' });
            }
        } else if (slot.kind === 'recurring') {
            let testDate = new Date(now);
            const [h, m] = String(slot.startTime).split(':').map(Number);
            for(let i = 0; i < 7; i++) {
                if (testDate.getUTCDay() === slot.dow) {
                    let instance = new Date(testDate);
                    instance.setUTCHours(h, m, 0, 0);
                    if (instance > now && instance < next12h) {
                         return res.status(400).json({ success: false, message: 'Upcoming slot starts in less than 12 hours. Closing forbidden.' });
                    }
                }
                testDate.setDate(testDate.getDate() + 1);
            }
        }

        if (slot.kind === 'recurring') {
            const bookings = await Booking.find({ 
                teacherId: slot.teacherId, 
                start: { $gte: now, $lte: nextMonth },
                status: { $in: ['PendingPayment', 'Scheduled', 'Rescheduled'] }
            });
            for (const b of bookings) {
                if (b.start && b.start.getUTCDay() === slot.dow && b.timeStr === slot.startTime) {
                    hasBookings = true; break;
                }
            }
        } else {
             const b = await Booking.findOne({
                 teacherId: slot.teacherId,
                 start: slot.startISO,
                 status: { $in: ['PendingPayment', 'Scheduled', 'Rescheduled'] }
             });
             if (b) hasBookings = true;
        }

        if (hasBookings) {
            return res.status(400).json({ success: false, message: 'Cannot close slot: active bookings exist.' });
        }
    }

    slot.isActive = !slot.isActive;
    await slot.save();

    res.json({ success:true, isActive: slot.isActive });
  } catch(e) {
    res.status(500).json({ success:false, message:e.message });
  }
});

app.delete('/api/teacher/slots/:id', requireTeacher, async (req, res) => {
  try {
    const { id } = req.params;
    const query = { _id: id };
    
    if (!['admin', 'manager'].includes(req.user.role) && req.user.email !== 'shakhrom.azimov99@gmail.com') {
        query.teacherId = req.user.id;
    }

    const slot = await TimeSlot.findOne(query);
    if (!slot) return res.status(404).json({ success:false, message:'Slot not found or access denied' });

    if (slot.studentId) {
        return res.status(400).json({ success: false, message: 'This slot is assigned to a student (Fixed Grid). Deletion forbidden.' });
    }

    const now = new Date();
    const nextMonth = new Date(now.getTime() + 35 * 24 * 60 * 60 * 1000);
    let hasBookings = false;

    if (slot.kind === 'recurring') {
        const bookings = await Booking.find({ 
            teacherId: slot.teacherId,
            start: { $gte: now, $lte: nextMonth },
            status: { $in: ['PendingPayment', 'Scheduled', 'Rescheduled'] }
        });
        for (const b of bookings) {
            if (b.start && b.start.getUTCDay() === slot.dow && b.timeStr === slot.startTime) {
                hasBookings = true; break;
            }
        }
    } else {
         const b = await Booking.findOne({
             teacherId: slot.teacherId,
             start: slot.startISO,
             status: { $in: ['PendingPayment', 'Scheduled', 'Rescheduled'] }
         });
         if (b) hasBookings = true;
    }

    if (hasBookings) {
        return res.status(400).json({ success: false, message: 'Cannot delete slot: active bookings exist.' });
    }

    await TimeSlot.deleteOne({ _id: id });
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ success:false, message:e.message });
  }
});

/* ---------------- Schedule feed & Admin Slots ---------------- */

app.get('/api/schedule', optionalAuth, async (req, res) => {
  try {
    const from = new Date(req.query.from);
    const to   = new Date(req.query.to);
    if (isNaN(from) || isNaN(to)) {
      return res.status(400).json({ success:false, message:'Invalid range' });
    }

    let targetTeacherId = null;
    if (req.user) {
      const u = await User.findById(req.user.uid);
      if (u && u.role === 'student' && u.assignedTeacher) {
        targetTeacherId = u.assignedTeacher;
      } else if (u && u.role === 'teacher') {
        targetTeacherId = u._id;
      }
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

    const bQuery = {
      status: { $in: ['Scheduled', 'Rescheduled', 'PendingPayment'] },
      start: { $gte: from, $lte: to }
    };
    if (targetTeacherId) bQuery.teacherId = targetTeacherId;

    const lessons = await Booking.find(bQuery).lean();

    for (const b of lessons) {
      if (!b.start) continue;
      const end = b.end || new Date(b.start.getTime() + 25 * 60 * 1000);
      addItem(
        'lesson',
        b.level ? `${b.level} Lesson` : 'Lesson',
        b.start,
        end,
        {
          status: b.status || 'Scheduled',
          teacherName: b.teacherName || (process.env.TEACHER_NAME || 'Teacher'),
          bookingId: b._id,
          level: b.level,
          childName: b.childName
        }
      );
    }

    const sQuery = {
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
    };
    if (targetTeacherId) sQuery.teacherId = targetTeacherId;

    const slots = await TimeSlot.find(sQuery).lean();

    for (const s of slots) {
      if (s.kind !== 'oneoff') continue;
      if (!s.isActive) continue; 
      
      addItem('slot', 'Available', s.startISO, s.endISO, { 
        teacherName: s.teacherName, teacherId: s.teacherId,
        isActive: s.isActive, studentId: s.studentId, studentName: s.studentName
      });
    }

    const dayMs = 24 * 60 * 60 * 1000;
    for (const s of slots) {
      if (s.kind !== 'recurring') continue;
      if (!s.isActive || s.studentId) continue;
      
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
        addItem('slot', 'Available', start, end, { 
          teacherName: s.teacherName, teacherId: s.teacherId,
          isActive: s.isActive, studentId: s.studentId, studentName: s.studentName 
        });
      }
    }

    res.json({ success: true, items });
  } catch (e) {
    res.status(500).json({ success:false, message:'Failed to build schedule' });
  }
});

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
        .map(([kind,dow,startTime,endTime,validFrom,validTo,startISO,endISO,timeZone,teacherName,teacherId]) => ({
          kind, dow: dow? +dow : undefined,
          startTime, endTime,
          validFrom: validFrom? new Date(validFrom): undefined,
          validTo:   validTo?   new Date(validTo):   undefined,
          startISO:  startISO?  new Date(startISO):  undefined,
          endISO:    endISO?    new Date(endISO):    undefined,
          timeZone, teacherName, teacherId
        }));
    }
    const docs = await TimeSlot.insertMany(rows.filter(r => r && r.kind));
    res.json({ success:true, inserted: docs.length });
  } catch (e) {
    res.status(400).json({ success:false, message:String(e) });
  }
});

/* ---------------- REVIEWS SYSTEM ---------------- */

const ReviewSchema = new Schema({
  name: { type: String, required: true },
  email: { type: String, required: true },
  country: { type: String, default: '' },
  role: { type: String, default: 'Parent' },
  child: { type: String, default: '' },
  age: { type: Number },
  verificationCode: String,
  isVerified: { type: Boolean, default: false },
  ratings: {
    course: Number,
    teacher: Number,
    platform: Number
  },
  text: String,
  status: { type: String, default: 'Draft' }, 
}, { timestamps: true });

const Review = model('Review', ReviewSchema);

app.get('/api/reviews/list', async (req, res) => {
  try {
    const reviews = await Review.find({ status: 'Approved' })
      .select('name ratings text createdAt country role child age')
      .sort({ createdAt: -1 })
      .limit(50);
    
    const statsResult = await Review.aggregate([
      { $match: { status: 'Approved' } },
      { $group: {
          _id: null,
          count: { $sum: 1 },
          avgScore: { $avg: { $avg: ['$ratings.course', '$ratings.teacher', '$ratings.platform'] } }
      } }
    ]);

    const stats = statsResult[0] || { count: 0, avgScore: 0 };
    const avg = stats.avgScore ? stats.avgScore.toFixed(1) : '0.0';

    res.json({ success: true, reviews, stats: { count: stats.count, avg } });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Error fetching reviews' });
  }
});

app.post('/api/reviews/otp', async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email required' });

    const code = Math.floor(1000 + Math.random() * 9000).toString();

    let review = await Review.findOne({ email, status: 'Draft' });
    
    if (!review) {
      review = await Review.create({
        name, 
        email, 
        verificationCode: code,
        status: 'Draft'
      });
    } else {
      review.verificationCode = code;
      review.name = name;
      await review.save();
    }

    await sendEmail({
      to: email,
      subject: `Your Verification Code: ${code}`,
      html: `
        <h3>Grand English Courses Review</h3>
        <p>Hello ${name},</p>
        <p>Use this code to verify your email and post your review:</p>
        <h1 style="color:#2563EB;">${code}</h1>
      `
    });

    res.json({ success: true, message: 'Code sent' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/reviews/submit', async (req, res) => {
  try {
    const { email, code, ratings, text, country, role, child, age, name } = req.body;
    
    const review = await Review.findOne({ email, verificationCode: code, status: 'Draft' });
    
    if (!review) {
      return res.status(400).json({ success: false, message: 'Invalid code or email' });
    }

    review.isVerified = true;
    review.status = 'Pending';
    review.ratings = ratings;
    review.text = text;
    
    if (name) review.name = name;
    if (country) review.country = country;
    if (role) review.role = role;
    if (child) review.child = child;
    if (age) review.age = age;

    review.verificationCode = undefined;
    await review.save();

    await sendEmail({
      to: process.env.ADMIN_BOOKINGS_TO || process.env.EMAIL_USER,
      subject: '📝 New Review Waiting for Approval',
      html: `
        <h2>New Review from ${review.name} (${review.country})</h2>
        <p><strong>Role:</strong> ${review.role} of ${review.child} (${review.age}yo)</p>
        <p><strong>Text:</strong> ${text}</p>
        <p>Go to Admin Panel to approve.</p>
      `
    });

    res.json({ success: true, message: 'Review submitted for moderation' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Error submitting review' });
  }
});

app.get('/api/admin/reviews', requireAdmin, async (req, res) => {
  const reviews = await Review.find({ status: { $ne: 'Draft' } }).sort({ createdAt: -1 });
  res.json({ success: true, reviews });
});

app.patch('/api/admin/reviews/:id', requireAdmin, async (req, res) => {
  const { status } = req.body; 
  await Review.findByIdAndUpdate(req.params.id, { status });
  res.json({ success: true });
});

app.delete('/api/admin/reviews/:id', requireAdmin, async (req, res) => {
  await Review.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

/* ---------------- USER MANAGEMENT ---------------- */
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const users = await User.find({}).select('email firstName lastName role');
    res.json({ success: true, users });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.patch('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const { role } = req.body;
    if (!['student', 'teacher', 'manager', 'admin'].includes(role)) {
      return res.status(400).json({ success: false, message: 'Invalid role' });
    }
    
    await User.findByIdAndUpdate(req.params.id, { role: role });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ---------------- ASSIGNMENTS ---------------- */
app.get('/api/admin/assignments', requireAdmin, async (req, res) => {
  try {
    const students = await User.find({ role: 'student' }).populate('assignedTeacher', 'firstName lastName email');
    const teachers = await User.find({ role: 'teacher' }).select('firstName lastName email');
    res.json({ success: true, students, teachers });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.patch('/api/admin/assignments/:studentId', requireAdmin, async (req, res) => {
  try {
    const teacherId = req.body.teacherId === 'none' ? null : req.body.teacherId;
    await User.findByIdAndUpdate(req.params.studentId, { assignedTeacher: teacherId });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ---------------- Start ---------------- */
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => console.log(`Server is running on port ${PORT}`));

/* ---------------- Student Email Template Helpers ---------------- */
const LOGO_URL = process.env.LOGO_URL || 'https://grandenglishcourses.com/logo.png';
const STUDENT_PORTAL_URL = process.env.STUDENT_PORTAL_URL || (process.env.APP_BASE_URL ? process.env.APP_BASE_URL + '/dashboard' : 'https://grandenglishcourses.com/dashboard');

function renderStudentEmail({ title, bodyHtml, primaryCtaLabel = 'Open Dashboard', primaryCtaHref = STUDENT_PORTAL_URL, secondaryCtaLabel = '', secondaryCtaHref = '' }) {
  const buttonPrimary = primaryCtaHref ? `
    <a href="${primaryCtaHref}" style="display:inline-block;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:600;background:#2563eb;color:#fff;">${primaryCtaLabel}</a>
  ` : '';
  const buttonSecondary = secondaryCtaHref ? `
    <a href="${secondaryCtaHref}" style="display:inline-block;margin-left:12px;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:600;background:#111827;color:#fff;">${secondaryCtaLabel}</a>
  ` : '';

  return `
  <div style="background:#f3f4f6;padding:32px 12px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="max-width:640px;width:100%;background:#ffffff;border-radius:14px;box-shadow:0 4px 12px rgba(0,0,0,0.06);">
      <tr>
        <td style="padding:28px 24px 8px;text-align:center;">
          <img src="${LOGO_URL}" alt="Grand English Courses" style="height:60px;max-width:160px;display:block;margin:0 auto 6px;" />
        </td>
      </tr>
      <tr>
        <td style="padding:0 24px 8px;text-align:center;">
          <h1 style="margin:0;font-size:22px;line-height:1.3;color:#111827;font-weight:800;">${title}</h1>
        </td>
      </tr>
      <tr>
        <td style="padding:8px 24px 12px;color:#374151;font-size:14px;line-height:1.6;">
          ${bodyHtml}
        </td>
      </tr>
      <tr>
        <td style="padding:4px 24px 28px;text-align:center;">
          ${buttonPrimary}${buttonSecondary}
        </td>
      </tr>
      <tr>
        <td style="padding:16px 24px 28px;color:#6b7280;font-size:12px;line-height:1.5;text-align:center;border-top:1px solid #e5e7eb;">
          <div>Need help? Just reply to this email.</div>
          <div style="margin-top:6px;">© ${new Date().getFullYear()} Grand English Courses</div>
        </td>
      </tr>
    </table>
  </div>
  `;
}