// server.js
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
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

/* -------------------------- MongoDB -------------------------- */
mongoose
  .connect(process.env.MONGO_URI, { dbName: 'grandenglish' })
  .then(() => console.log('MongoDB connected'))
  .catch((e) => console.error('Mongo connect error:', e));

const { Schema, model } = mongoose;

const UserSchema = new Schema(
  {
    email: { type: String, unique: true, required: true, index: true },
    passwordHash: { type: String, required: true },
    firstName: String,
    lastName: String,
    role: { type: String, default: 'student' }
  },
  { timestamps: true }
);
const User = model('User', UserSchema);

/**
 * Booking:
 * + country   (String)
 * + timeZone  (String; e.g. "Asia/Dushanbe")
 * + childAge  (Number)
 */
const BookingSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    email: { type: String, required: true },          // email родителя
    childName: { type: String, required: true },
    parentName: { type: String, required: true },
    childAge: { type: Number },                       // ← добавлено
    country: { type: String },                        // ← добавлено
    timeZone: { type: String },                       // ← добавлено
    dateStr: { type: String, required: true },        // "Friday, July 28, 2023"
    timeStr: { type: String, required: true },        // "2:00 PM"
    level:   { type: String, required: true },        // "Beginner" и т.п.
    status:  { type: String, default: 'Scheduled' }   // Scheduled/Cancelled/Completed
  },
  { timestamps: true }
);
const Booking = model('Booking', BookingSchema);

/* -------------------------- Mailer --------------------------- */
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

const ADMIN_TO = process.env.ADMIN_BOOKINGS_TO || process.env.NOTIFY_TO || process.env.EMAIL_USER;

async function sendEmail(opts) {
  try {
    await transporter.sendMail({ from: `"Grand English Courses" <${process.env.EMAIL_USER}>`, ...opts });
  } catch (e) {
    console.error('Email error:', e.message);
  }
}

/* -------------------------- Auth utils ----------------------- */
function signToken(user) {
  return jwt.sign({ uid: user._id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
}
function auth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { uid, email }
    next();
  } catch (e) {
    return res.status(401).json({ success: false, message: 'Invalid auth token' });
  }
}

/* -------------------------- Helpers -------------------------- */
function parseBookingDT(b) {
  // Пытаемся распарсить "Friday, July 28, 2023 2:00 PM"
  const d = new Date(`${b.dateStr} ${b.timeStr}`);
  return isNaN(+d) ? null : d;
}
async function autoCompletePastBookings(userId) {
  const list = await Booking.find({ user: userId, status: 'Scheduled' });
  const now = Date.now();
  for (const b of list) {
    const dt = parseBookingDT(b);
    if (dt && dt.getTime() < now - 60 * 1000) {
      b.status = 'Completed';
      await b.save();
    }
  }
}

/* -------------------------- Health --------------------------- */
app.get('/health', (req, res) => res.json({ ok: true }));

/* =======================================================
   A) Форма набора преподавателей (как было)
   ======================================================= */
const upload = multer({ dest: 'uploads/' });

app.post('/submit', upload.single('audio'), async (req, res) => {
  try {
    const audioFile = req.file;
    if (!audioFile) {
      return res.status(400).json({ success: false, message: 'Missing audio file' });
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

    const parsedLanguages = languages ? languages.split(',').map(l => l.trim()) : [];

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
      attachments: [{ filename: 'speaking-assessment.webm', path: path.join(__dirname, audioFile.path) }]
    });

    res.status(201).json({ success: true, message: 'Application submitted and email sent' });
  } catch (err) {
    console.error('Error submitting application:', err);
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

/* =======================================================
   B) Авторизация
   ======================================================= */
app.post('/api/register', async (req, res) => {
  try {
    const { fullName, email, password } = req.body;
    if (!fullName || !email || !password) {
      return res.status(400).json({ success: false, message: 'fullName, email, password required' });
    }
    const exists = await User.findOne({ email: email.toLowerCase() });
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
    const { email, password } = req.body;
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

app.get('/api/me', auth, async (req, res) => {
  const user = await User.findById(req.user.uid).select('_id email firstName lastName role');
  res.json({ success: true, user });
});

/* =======================================================
   C) Бронирование
   ======================================================= */
// Создать бронь
app.post('/api/book', auth, async (req, res) => {
  try {
    const {
      email,
      childName,
      parentName,
      date,
      time,
      level,
      country,
      timeZone,
      childAge
    } = req.body;

    // делаем базовую валидацию обязательных полей
    if (!email || !childName || !parentName || !date || !time || !level) {
      return res.status(400).json({ success: false, message: 'Missing fields' });
    }

    const booking = await Booking.create({
      user: req.user.uid,
      email: String(email).toLowerCase(),
      childName,
      parentName,
      childAge: typeof childAge === 'number' ? childAge : (childAge ? Number(childAge) : undefined),
      country,
      timeZone,
      dateStr: date,
      timeStr: time,
      level,
      status: 'Scheduled'
    });

    /* -------- Письмо админу (включая страну/таймзону/возраст) -------- */
    await sendEmail({
      to: ADMIN_TO,
      subject: `🗓 Новая бронь: ${childName} (${date} ${time})`,
      html: `
        <h2>Новая бронь пробного урока</h2>
        <p><strong>Ребёнок:</strong> ${childName}${childAge ? `, ${childAge} y.o.` : ''}</p>
        <p><strong>Родитель:</strong> ${parentName}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Дата и время:</strong> ${date} в ${time}</p>
        <p><strong>Уровень:</strong> ${level}</p>
        ${country ? `<p><strong>Страна:</strong> ${country}</p>` : ''}
        ${timeZone ? `<p><strong>Time Zone:</strong> ${timeZone}</p>` : ''}
      `
    });

    /* -------- Письмо пользователю (включая страну/таймзону/возраст) -------- */
    await sendEmail({
      to: email,
      subject: 'Your Trial Lesson Booking Confirmation',
      html: `
        <h2>Booking Confirmed!</h2>
        <p>Dear ${parentName},</p>
        <p>Thank you for booking a trial lesson for <strong>${childName}</strong>${childAge ? ` (${childAge} y.o.)` : ''}.</p>
        <p><strong>Date & Time:</strong> ${date} at ${time}${timeZone ? ` (${timeZone})` : ''}</p>
        <p><strong>Level:</strong> ${level}</p>
        ${country ? `<p><strong>Country:</strong> ${country}</p>` : ''}
        ${timeZone ? `<p><strong>Time Zone:</strong> ${timeZone}</p>` : ''}
        ${childAge ? `<p><strong>Child’s Age:</strong> ${childAge}</p>` : ''}
        <br/>
        <p>We look forward to seeing you!</p>
        <p>— Grand English Courses</p>
      `
    });

    res.json({ success: true, bookingId: booking._id });
  } catch (e) {
    console.error('Book error:', e);
    res.status(500).json({ success: false, message: 'Booking failed' });
  }
});

// Мои брони (и авто-комплит прошедших)
app.get('/api/my-bookings', auth, async (req, res) => {
  try {
    await autoCompletePastBookings(req.user.uid);
    const bookings = await Booking.find({ user: req.user.uid }).sort({ createdAt: -1 }).lean();
    res.json({ success: true, bookings });
  } catch (e) {
    console.error('My bookings error:', e);
    res.status(500).json({ success: false, message: 'Failed to load' });
  }
});

/* ===== Cancel / Reschedule эндпойнты + алиасы ===== */
async function cancelHandler(req, res) {
  try {
    const id = req.params.id;
    const booking = await Booking.findOne({ _id: id, user: req.user.uid });
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

    // Нельзя отменить прошедший
    const dt = parseBookingDT(booking);
    if (dt && dt.getTime() < Date.now() - 60 * 1000) {
      return res.status(400).json({ success: false, message: 'Lesson already completed' });
    }

    booking.status = 'Cancelled';
    await booking.save();

    // письма (добавили страну/таймзону/возраст для контекста)
    await sendEmail({
      to: ADMIN_TO,
      subject: `❌ Отмена брони: ${booking.childName} (${booking.dateStr} ${booking.timeStr})`,
      html: `
        <h2>Отмена пробного урока</h2>
        <p><strong>Ребёнок:</strong> ${booking.childName}${booking.childAge ? `, ${booking.childAge} y.o.` : ''}</p>
        <p><strong>Родитель:</strong> ${booking.parentName}</p>
        <p><strong>Email:</strong> ${booking.email}</p>
        <p><strong>Было назначено:</strong> ${booking.dateStr} в ${booking.timeStr}${booking.timeZone ? ` (${booking.timeZone})` : ''}</p>
        ${booking.country ? `<p><strong>Страна:</strong> ${booking.country}</p>` : ''}
        <p><strong>Статус:</strong> Cancelled</p>
      `
    });
    await sendEmail({
      to: booking.email,
      subject: 'Your Trial Lesson Was Cancelled',
      html: `
        <h2>Booking Cancelled</h2>
        <p>Dear ${booking.parentName},</p>
        <p>Your trial lesson for <strong>${booking.childName}</strong> scheduled on <strong>${booking.dateStr} at ${booking.timeStr}</strong>${booking.timeZone ? ` (${booking.timeZone})` : ''} has been cancelled.</p>
        ${booking.country ? `<p><strong>Country:</strong> ${booking.country}</p>` : ''}
        ${booking.childAge ? `<p><strong>Child’s Age:</strong> ${booking.childAge}</p>` : ''}
        <p>If you want to book a new time, please use our booking page.</p>
        <p>— Grand English Courses</p>
      `
    });

    res.json({ success: true });
  } catch (e) {
    console.error('Cancel error:', e);
    res.status(500).json({ success: false, message: 'Cancel failed' });
  }
}

async function rescheduleHandler(req, res) {
  try {
    const id = req.params.id;
    const { date, time, level } = req.body || {};
    if (!date || !time) return res.status(400).json({ success: false, message: 'date & time required' });

    const booking = await Booking.findOne({ _id: id, user: req.user.uid });
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

    // Нельзя переносить прошедший
    const oldDt = parseBookingDT(booking);
    if (oldDt && oldDt.getTime() < Date.now() - 60 * 1000) {
      return res.status(400).json({ success: false, message: 'Lesson already completed' });
    }

    const prev = { dateStr: booking.dateStr, timeStr: booking.timeStr, level: booking.level };

    booking.dateStr = date;
    booking.timeStr = time;
    if (level) booking.level = level;
    booking.status = 'Scheduled';
    await booking.save();

    // письма (с контекстом страны/таймзоны/возраста)
    await sendEmail({
      to: ADMIN_TO,
      subject: `🔄 Перенос брони: ${booking.childName} → ${date} ${time}`,
      html: `
        <h2>Перенос пробного урока</h2>
        <p><strong>Ребёнок:</strong> ${booking.childName}${booking.childAge ? `, ${booking.childAge} y.o.` : ''}</p>
        <p><strong>Родитель:</strong> ${booking.parentName}</p>
        <p><strong>Email:</strong> ${booking.email}</p>
        <p><strong>Было:</strong> ${prev.dateStr} в ${prev.timeStr}</p>
        <p><strong>Стало:</strong> ${date} в ${time}${booking.timeZone ? ` (${booking.timeZone})` : ''}</p>
        ${booking.country ? `<p><strong>Страна:</strong> ${booking.country}</p>` : ''}
        <p><strong>Уровень:</strong> ${booking.level}</p>
      `
    });
    await sendEmail({
      to: booking.email,
      subject: 'Your Trial Lesson Was Rescheduled',
      html: `
        <h2>Booking Rescheduled</h2>
        <p>Dear ${booking.parentName},</p>
        <p>Your trial lesson for <strong>${booking.childName}</strong>${booking.childAge ? ` (${booking.childAge} y.o.)` : ''} has been rescheduled.</p>
        <p><strong>New Date & Time:</strong> ${date} at ${time}${booking.timeZone ? ` (${booking.timeZone})` : ''}</p>
        <p><strong>Level:</strong> ${booking.level}</p>
        ${booking.country ? `<p><strong>Country:</strong> ${booking.country}</p>` : ''}
        <p>— Grand English Courses</p>
      `
    });

    res.json({ success: true });
  } catch (e) {
    console.error('Reschedule error:', e);
    res.status(500).json({ success: false, message: 'Reschedule failed' });
  }
}

// маршруты
app.post('/api/bookings/:id/cancel', auth, cancelHandler);
app.post('/api/bookings/:id/reschedule', auth, rescheduleHandler);

// алиасы на старые пути (на случай если фронт дергает их)
app.post('/api/book/:id/cancel', auth, cancelHandler);
app.post('/api/book/:id/reschedule', auth, rescheduleHandler);

/* -------------------------- Start ---------------------------- */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));