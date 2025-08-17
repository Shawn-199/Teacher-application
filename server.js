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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- MongoDB ----------
mongoose
  .connect(process.env.MONGO_URI, { dbName: 'grandenglish' })
  .then(() => console.log('MongoDB connected'))
  .catch((e) => console.error('Mongo connect error:', e));

// ---------- Schemas ----------
const { Schema, model } = mongoose;

const UserSchema = new Schema(
  {
    email: { type: String, unique: true, required: true, index: true },
    passwordHash: { type: String, required: true },
    firstName: String,
    lastName: String,
    role: { type: String, default: 'student' },
    // на будущее (аватар, прогресс и т.п.)
    avatarUrl: String,
    level: { type: String, default: 'Beginner' }
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
    dateStr: { type: String, required: true }, // "Friday, July 28, 2023"
    timeStr: { type: String, required: true }, // "2:00 PM"
    level: { type: String, required: true },   // "Beginner" и т.п.
    status: { type: String, default: 'Scheduled' } // Scheduled/Rescheduled/Cancelled/Done
  },
  { timestamps: true }
);
const Booking = model('Booking', BookingSchema);

// ---------- Mail ----------
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});
const adminTo = process.env.ADMIN_BOOKINGS_TO || process.env.NOTIFY_TO || process.env.EMAIL_USER;

// ---------- Utils ----------
function signToken(user) {
  return jwt.sign({ uid: user._id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
}
function auth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: 'No auth token' });
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { uid, email }
    next();
  } catch (e) {
    return res.status(401).json({ success: false, message: 'Invalid auth token' });
  }
}

// ---------- Health ----------
app.get('/health', (req, res) => res.json({ ok: true }));

/* =======================================================
   A) СТАРЫЙ РОУТ: форма набора преподавателей (как было)
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

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: process.env.NOTIFY_TO,
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
      attachments: [
        { filename: 'speaking-assessment.webm', path: path.join(__dirname, audioFile.path) }
      ]
    };

    await transporter.sendMail(mailOptions);
    res.status(201).json({ success: true, message: 'Application submitted and email sent' });
  } catch (err) {
    console.error('Error submitting application:', err);
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

/* =======================================================
   B) АВТОРИЗАЦИЯ: регистрация / логин / профиль
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
  const user = await User.findById(req.user.uid).select('_id email firstName lastName role avatarUrl level');
  res.json({ success: true, user });
});

/* =======================================================
   C) БРОНИРОВАНИЕ: create / my-bookings / cancel / reschedule
   ======================================================= */
app.post('/api/book', auth, async (req, res) => {
  try {
    const { email, childName, parentName, date, time, level } = req.body;
    if (!email || !childName || !parentName || !date || !time || !level) {
      return res.status(400).json({ success: false, message: 'Missing fields' });
    }

    const booking = await Booking.create({
      user: req.user.uid,
      email: email.toLowerCase(),
      childName,
      parentName,
      dateStr: date,
      timeStr: time,
      level,
      status: 'Scheduled'
    });

    // Admin notify
    await transporter.sendMail({
      from: `"Grand English Courses" <${process.env.EMAIL_USER}>`,
      to: adminTo,
      subject: `🗓 Новая бронь: ${childName} (${date} ${time})`,
      html: `
        <h2>Новая бронь пробного урока</h2>
        <p><strong>Ребёнок:</strong> ${childName}</p>
        <p><strong>Родитель:</strong> ${parentName}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Дата и время:</strong> ${date} в ${time}</p>
        <p><strong>Уровень:</strong> ${level}</p>
        <p><strong>Статус:</strong> Scheduled</p>
      `
    });

    // User notify
    await transporter.sendMail({
      from: `"Grand English Courses" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Your Trial Lesson Booking Confirmation',
      html: `
        <h2>Booking Confirmed</h2>
        <p>Dear ${parentName},</p>
        <p>Your trial lesson for <strong>${childName}</strong> has been scheduled.</p>
        <p><strong>Date & Time:</strong> ${date} at ${time}</p>
        <p><strong>Level:</strong> ${level}</p>
        <p>Status: Scheduled</p>
        <p>— Grand English Courses</p>
      `
    });

    res.json({ success: true, bookingId: booking._id });
  } catch (e) {
    console.error('Book error:', e);
    res.status(500).json({ success: false, message: 'Booking failed' });
  }
});

app.get('/api/my-bookings', auth, async (req, res) => {
  const bookings = await Booking.find({ user: req.user.uid }).sort({ createdAt: -1 }).lean();
  res.json({ success: true, bookings });
});

// Cancel booking
app.patch('/api/bookings/:id/cancel', auth, async (req, res) => {
  try {
    const { reason = '' } = req.body;
    const booking = await Booking.findOne({ _id: req.params.id, user: req.user.uid });
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

    booking.status = 'Cancelled';
    await booking.save();

    // Admin email
    await transporter.sendMail({
      from: `"Grand English Courses" <${process.env.EMAIL_USER}>`,
      to: adminTo,
      subject: `❌ Отмена брони: ${booking.childName} (${booking.dateStr} ${booking.timeStr})`,
      html: `
        <h2>Бронь отменена пользователем</h2>
        <p><strong>Ребёнок:</strong> ${booking.childName}</p>
        <p><strong>Родитель:</strong> ${booking.parentName}</p>
        <p><strong>Email:</strong> ${booking.email}</p>
        <p><strong>Изначально:</strong> ${booking.dateStr} at ${booking.timeStr}</p>
        <p><strong>Причина:</strong> ${reason || '—'}</p>
        <p><strong>Статус:</strong> Cancelled</p>
      `
    });

    // User email
    await transporter.sendMail({
      from: `"Grand English Courses" <${process.env.EMAIL_USER}>`,
      to: booking.email,
      subject: 'Your Trial Lesson Has Been Cancelled',
      html: `
        <h2>Booking Cancelled</h2>
        <p>Dear ${booking.parentName},</p>
        <p>Your trial lesson for <strong>${booking.childName}</strong> has been cancelled.</p>
        <p><strong>Original date & time:</strong> ${booking.dateStr} at ${booking.timeStr}</p>
        <p>${reason ? `Reason provided: ${reason}` : ''}</p>
        <p>Status: Cancelled</p>
      `
    });

    res.json({ success: true });
  } catch (e) {
    console.error('Cancel error:', e);
    res.status(500).json({ success: false, message: 'Cancel failed' });
  }
});

// Reschedule booking
app.patch('/api/bookings/:id/reschedule', auth, async (req, res) => {
  try {
    const { newDate, newTime } = req.body;
    if (!newDate || !newTime) {
      return res.status(400).json({ success: false, message: 'newDate and newTime required' });
    }

    const booking = await Booking.findOne({ _id: req.params.id, user: req.user.uid });
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

    const oldDate = booking.dateStr;
    const oldTime = booking.timeStr;

    booking.dateStr = newDate;
    booking.timeStr = newTime;
    booking.status = 'Rescheduled';
    await booking.save();

    // Admin email
    await transporter.sendMail({
      from: `"Grand English Courses" <${process.env.EMAIL_USER}>`,
      to: adminTo,
      subject: `🔁 Перенос брони: ${booking.childName} на ${newDate} ${newTime}`,
      html: `
        <h2>Бронь перенесена пользователем</h2>
        <p><strong>Ребёнок:</strong> ${booking.childName}</p>
        <p><strong>Родитель:</strong> ${booking.parentName}</p>
        <p><strong>Email:</strong> ${booking.email}</p>
        <p><strong>Было:</strong> ${oldDate} at ${oldTime}</p>
        <p><strong>Стало:</strong> ${newDate} at ${newTime}</p>
        <p><strong>Статус:</strong> Rescheduled</p>
      `
    });

    // User email
    await transporter.sendMail({
      from: `"Grand English Courses" <${process.env.EMAIL_USER}>`,
      to: booking.email,
      subject: 'Your Trial Lesson Has Been Rescheduled',
      html: `
        <h2>Booking Rescheduled</h2>
        <p>Dear ${booking.parentName},</p>
        <p>Your trial lesson for <strong>${booking.childName}</strong> has been rescheduled.</p>
        <p><strong>Previous:</strong> ${oldDate} at ${oldTime}</p>
        <p><strong>New date & time:</strong> ${newDate} at ${newTime}</p>
        <p>Status: Rescheduled</p>
      `
    });

    res.json({ success: true });
  } catch (e) {
    console.error('Reschedule error:', e);
    res.status(500).json({ success: false, message: 'Reschedule failed' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));