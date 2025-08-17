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
    role: { type: String, default: 'student' }
  },
  { timestamps: true }
);
const User = model('User', UserSchema);

const BookingSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    email: { type: String, required: true },          // email родителя
    childName: { type: String, required: true },
    parentName: { type: String, required: true },
    dateStr: { type: String, required: true },         // "Friday, July 28, 2023"
    timeStr: { type: String, required: true },         // "2:00 PM"
    level: { type: String, required: true },           // "Beginner" и т.п.
    status: { type: String, default: 'Scheduled' }     // Scheduled/Cancelled/Done
  },
  { timestamps: true }
);
const Booking = model('Booking', BookingSchema);

// ---------- Mail ----------
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

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
   A) ТВОЙ СТАРЫЙ РОУТ: форма набора преподавателей (без изменений)
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
// Регистрация
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

// Логин
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

// Профиль
app.get('/api/me', auth, async (req, res) => {
  const user = await User.findById(req.user.uid).select('_id email firstName lastName role');
  res.json({ success: true, user });
});

/* =======================================================
   C) БРОНИРОВАНИЕ: запись в БД + письма + выдача в кабинет
   ======================================================= */
// Создать бронь (нужен токен)
app.post('/api/book', auth, async (req, res) => {
  try {
    const { email, childName, parentName, date, time, level } = req.body;

    if (!email || !childName || !parentName || !date || !time || !level) {
      return res.status(400).json({ success: false, message: 'Missing fields' });
    }

    // Создаём запись
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

    // Письмо админу
    const adminTo = process.env.ADMIN_BOOKINGS_TO || process.env.NOTIFY_TO || process.env.EMAIL_USER;
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
      `
    });

    // Письмо пользователю
    await transporter.sendMail({
      from: `"Grand English Courses" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Your Trial Lesson Booking Confirmation',
      html: `
        <h2>Booking Confirmed!</h2>
        <p>Dear ${parentName},</p>
        <p>Thank you for booking a trial lesson for <strong>${childName}</strong>.</p>
        <p><strong>Date & Time:</strong> ${date} at ${time}</p>
        <p><strong>Level:</strong> ${level}</p>
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

// Мои брони (для личного кабинета)
app.get('/api/my-bookings', auth, async (req, res) => {
  const bookings = await Booking.find({ user: req.user.uid }).sort({ createdAt: -1 }).lean();
  res.json({ success: true, bookings });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));