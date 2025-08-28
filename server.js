// server.js  (robust CORS + optionalAuth + resilient /api/bookings/trial)
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const nodemailer = require('nodemailer');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

// === FFmpeg for audio conversion (WebM -> MP3) ===
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
const { Readable, PassThrough } = require('stream');
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
    return {
      filename: `${base}.mp3`,
      content: mp3buf,
      contentType: 'audio/mpeg'
    };
  }
  return {
    filename: file.originalname || (fallbackName || 'recording'),
    content: file.buffer,
    contentType: file.mimetype || 'application/octet-stream'
  };
}

const app = express();

// --- CORS: отражаем Origin (корректно с credentials) ---
app.use(cors({
  origin: (origin, cb) => cb(null, true), // доверяем всем источникам
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-user-email'],
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS']
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

/* ---------------- MongoDB ---------------- */
if (!process.env.MONGO_URI) {
  console.error('Missing MONGO_URI in .env');
  process.exit(1);
}
mongoose
  .connect(process.env.MONGO_URI, { dbName: 'grandenglish' })
  .then(() => console.log('MongoDB connected'))
  .catch((e) => { console.error('Mongo connect error:', e); process.exit(1); });

const { Schema, model } = mongoose;

const UserSchema = new Schema({
  email: { type: String, unique: true, required: true, index: true },
  passwordHash: { type: String, required: true },
  firstName: String,
  lastName: String,
  role: { type: String, default: 'student' },
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
  dateStr: { type: String, required: true },   // свободный текст ок
  timeStr: { type: String, required: true },
  level:   { type: String, required: true },
  status:  { type: String, default: 'Scheduled' }, // Scheduled | Confirmed | Completed | Cancelled
  teacherName: { type: String, default: process.env.TEACHER_NAME || 'Teacher' }
}, { timestamps: true });
const Booking = model('Booking', BookingSchema);

/* ---------------- Mailer ---------------- */
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});
const ADMIN_TO = process.env.ADMIN_BOOKINGS_TO || process.env.NOTIFY_TO || process.env.EMAIL_USER;

async function sendEmail(opts) {
  try {
    await transporter.sendMail({ from: `"Grand English Courses" <${process.env.EMAIL_USER}>`, ...opts });
  } catch (e) { console.error('Email error:', e.message); }
}

/* ---------------- JWT ---------------- */
function signToken(user) {
  if (!process.env.JWT_SECRET) throw new Error('Missing JWT_SECRET in .env');
  return jwt.sign({ uid: user._id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
}
function auth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const theToken = h.startsWith('Bearer ') ? h.slice(7) : '';
    const payload = jwt.verify(theToken, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ success:false, message:'Invalid auth token' });
  }
}
// Опциональная аутентификация — НЕ падает, если токена нет/битый
function optionalAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) {
      const payload = jwt.verify(h.slice(7), process.env.JWT_SECRET);
      req.user = payload;
    }
  } catch { /* ignore */ }
  next();
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
    const files = {};
    for (const f of (req.files || [])) files[f.fieldname] = f;

    const fQ1 = files['audioQ1'] || null;
    const fQ2 = files['audioQ2'] || null;
    const fMain = files['audio'] || null;

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

    const attachments = [];
    if (a1) attachments.push(a1);
    if (a2) attachments.push(a2);
    if (!a1 && !a2 && aMain) attachments.push(aMain);

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
    const { email, password } = req.body;
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

/* ---------------- Bookings ---------------- */

// TRIAL booking — работает и с JWT, и без (гость)
app.post('/api/bookings/trial', optionalAuth, async (req, res) => {
  try {
    const { date, time, level } = req.body || {};
    if (!date || !time) {
      return res.status(400).json({ success:false, message:'date and time are required' });
    }

    let userDoc = null;

    if (req.user && req.user.uid) {
      // Авторизованный пользователь
      userDoc = await User.findById(req.user.uid);
      if (!userDoc) return res.status(401).json({ success:false, message:'Auth user not found' });
    } else {
      // Гость — пробуем достать e-mail из разных мест
      const emailCandidates = [
        req.body.email, req.body.userEmail, req.body.contactEmail,
        req.body.login, req.body.username,
        req.headers['x-user-email']
      ].map(v => (v || '').toString().trim()).filter(Boolean);

      let email = (emailCandidates[0] || '').toLowerCase();

      if (!email) {
        // Если совсем нет e-mail — создаём гостя с синтетическим адресом,
        // чтобы вернуть успех (лучше для UX, чем "booking failed").
        email = `guest+${Date.now()}@guest.local`;
      }

      userDoc = await User.findOne({ email });
      if (!userDoc) {
        const passwordHash = await bcrypt.hash(Math.random().toString(36).slice(2), 10);
        userDoc = await User.create({ email, passwordHash, role: 'student', isGuest: true });
      }
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

// Обычное бронирование
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

    res.json({ success:true, booking });
  } catch (e) {
    console.error('Book error:', e);
    res.status(500).json({ success:false, message:'Booking failed' });
  }
});

app.get('/api/my-bookings', auth, async (req, res) => {
  try {
    const items = await Booking.find({ user: req.user.uid }).sort({ createdAt: -1 }).lean();
    res.json({ success:true, bookings: items });
  } catch (e) {
    console.error('List bookings error:', e);
    res.status(500).json({ success:false, message:'Failed to list bookings' });
  }
});

app.post('/api/bookings/:id/cancel', auth, async (req, res) => {
  try {
    const { id } = req.params;
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

/* ---------------- Start ---------------- */
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => console.log(`Server is running on port ${PORT}`));
