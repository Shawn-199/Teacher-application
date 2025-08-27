// server.js  (patched: memoryStorage + multi-audio support)
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const nodemailer = require('nodemailer');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*', credentials: true }));
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
  role: { type: String, default: 'student' }
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
  dateStr: { type: String, required: true },   // 'YYYY-MM-DD'
  timeStr: { type: String, required: true },   // 'HH:MM' or 'HH:MM - HH:MM'
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
  } catch { return res.status(401).json({ success:false, message:'Invalid auth token' }); }
}

/* ---------------- Health ---------------- */
app.get('/health', (req, res) => res.json({ ok: true }));

/* ---------------- Teachers form (audio) ---------------- */
// ✅ Переход на память: никаких каталогов на диске не требуется
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // до 25 МБ на файл
});

// Принимаем любые поля, но нам интересны audio / audioQ1 / audioQ2
app.post('/submit', upload.any(), async (req, res) => {
  try {
    // Поддержка разных названий
    const files = {};
    for (const f of (req.files || [])) {
      files[f.fieldname] = f;
    }
    const audio =
      files['audio'] || files['audioQ2'] || files['audioQ1'] || null;

    if (!audio) {
      return res.status(400).json({ success: false, message: 'Missing audio file (audio, audioQ1 or audioQ2)' });
    }

    const {
      email='-', fullname='-', age='-', country='-', languages='',
      timezone='-', experience='-', quizAnswers='{}', quizScore='-', quizPercentage='-'
    } = req.body;

    const parsedLanguages = languages ? String(languages).split(',').map(l=>l.trim()) : [];

    // Формируем вложения: если пришли оба — отправим оба
    const attachments = [];
    const mk = (f, fallbackName) => f && ({
      filename: f.originalname || fallbackName,
      content: f.buffer,
      contentType: f.mimetype || 'audio/webm'
    });
    const a1 = mk(files['audioQ1'], 'speaking-q1.webm');
    const a2 = mk(files['audioQ2'], 'speaking-q2.webm');
    const aMain = mk(files['audio'], 'speaking-assessment.webm');

    if (a1) attachments.push(a1);
    if (a2) attachments.push(a2);
    if (!a1 && !a2 && aMain) attachments.push(aMain); // если только одно поле

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

app.get('/api/me', auth, async (req, res) => {
  const user = await User.findById(req.user.uid).select('_id email firstName lastName role');
  res.json({ success:true, user });
});

/* ---------------- Bookings (no schedule dependency) ---------------- */
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

    // Notify admin
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