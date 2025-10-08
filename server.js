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
  if (!process.env.EMAIL_USER) missing.push('EMAIL_USER');
  if (missing.length) {
    console.error('[ERROR] Missing required env variables:', missing.join(', '));
    process.exit(1);
  }
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
    return { 
      filename: `${base}.mp3`, 
      content: mp3buf, 
      contentType: 'audio/mpeg',
      size: mp3buf.length 
    };
  }
  
  return {
    filename: file.originalname || (fallbackName || 'recording'),
    content: file.buffer,
    contentType: file.mimetype || 'application/octet-stream',
    size: file.buffer.length
  };
}

const app = express();
app.set('trust proxy', 1);

// --- CORS configuration ---
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

// Universal handler for preflight
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

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve admin UI as static files
app.use('/admin-ui', express.static('public', { 
  extensions: ['html'], 
  index: false,
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

/* ---------------- MongoDB Connection ---------------- */
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('Missing MONGO_URI in .env');
  process.exit(1);
}

mongoose.connect(MONGO_URI, { 
  dbName: 'grandenglish',
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 5000
})
.then(() => console.log('MongoDB connected successfully'))
.catch((e) => { 
  console.error('MongoDB connection error:', e); 
  process.exit(1); 
});

const { Schema, model } = mongoose;

/* ---------------- Schema Definitions ---------------- */
const UserSchema = new Schema({
  email: { 
    type: String, 
    unique: true, 
    required: true, 
    index: true,
    lowercase: true,
    trim: true
  },
  passwordHash: { type: String, required: true },
  firstName: { type: String, trim: true },
  lastName: { type: String, trim: true },
  role: { 
    type: String, 
    enum: ['student', 'manager', 'admin'], 
    default: 'student' 
  },
  isGuest: { type: Boolean, default: false }
}, { 
  timestamps: true,
  toJSON: {
    transform: function(doc, ret) {
      delete ret.passwordHash;
      return ret;
    }
  }
});

const BookingSchema = new Schema({
  user: { 
    type: Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  email: { 
    type: String, 
    required: true,
    lowercase: true,
    trim: true
  },
  childName: { 
    type: String, 
    required: true,
    trim: true
  },
  parentName: { 
    type: String, 
    required: true,
    trim: true
  },
  childAge: { 
    type: Number, 
    min: 3, 
    max: 18 
  },
  country: { 
    type: String, 
    trim: true 
  },
  timeZone: { 
    type: String, 
    trim: true 
  },
  dateStr: { 
    type: String, 
    required: true 
  },
  timeStr: { 
    type: String, 
    required: true 
  },
  level: { 
    type: String, 
    required: true,
    enum: ['Beginner', 'Intermediate', 'Advanced', 'Mixed'],
    default: 'Beginner'
  },
  status: { 
    type: String, 
    enum: ['Scheduled', 'Completed', 'Cancelled', 'No-Show', 'Rescheduled'],
    default: 'Scheduled' 
  },
  teacherName: { 
    type: String, 
    default: process.env.TEACHER_NAME || 'Teacher',
    trim: true
  }
}, { 
  timestamps: true 
});

const TimeSlotSchema = new Schema({
  kind: { 
    type: String, 
    enum: ['oneoff', 'recurring'], 
    default: 'oneoff' 
  },
  // recurring slots
  validFrom: Date,
  validTo: Date,
  dow: { 
    type: Number, 
    min: 0, 
    max: 6 
  },
  startTime: String,
  endTime: String,
  timeZone: String,
  // one-off slots
  startISO: Date,
  endISO: Date,
  teacherName: { 
    type: String, 
    default: process.env.TEACHER_NAME || 'Teacher',
    trim: true
  },
  note: String,
  isActive: { 
    type: Boolean, 
    default: true 
  }
}, { 
  timestamps: true 
});

// Create models
const User = model('User', UserSchema);
const Booking = model('Booking', BookingSchema);
const TimeSlot = model('TimeSlot', TimeSlotSchema);

/* ---------------- Email Service ---------------- */
const transporter = nodemailer.createTransporter({
  service: 'gmail',
  auth: { 
    user: process.env.EMAIL_USER, 
    pass: process.env.EMAIL_PASS 
  },
  pool: true,
  maxConnections: 5,
  maxMessages: 100
});

const ADMIN_TO = process.env.ADMIN_BOOKINGS_TO || process.env.NOTIFY_TO || process.env.EMAIL_USER;

async function sendEmail(opts) {
  try {
    const mailOptions = {
      from: `"Grand English Courses" <${process.env.EMAIL_USER}>`,
      ...opts
    };
    await transporter.sendMail(mailOptions);
    console.log(`Email sent to ${opts.to}`);
  } catch (error) {
    console.error('Email sending failed:', error.message);
    // Don't throw to avoid breaking the main flow
  }
}

/* ---------------- JWT Authentication ---------------- */
function signToken(user) {
  if (!process.env.JWT_SECRET) {
    throw new Error('Missing JWT_SECRET in .env');
  }
  return jwt.sign(
    { 
      uid: user._id, 
      email: user.email,
      role: user.role 
    }, 
    process.env.JWT_SECRET, 
    { expiresIn: '30d' }
  );
}

function auth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        code: 'MISSING_TOKEN',
        message: 'Missing Authorization: Bearer <token>'
      });
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      return res.status(401).json({
        success: false,
        code: 'EMPTY_TOKEN',
        message: 'Empty bearer token'
      });
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      code: 'INVALID_TOKEN',
      message: 'Invalid or expired authentication token'
    });
  }
}

function optionalAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      if (token) {
        req.user = jwt.verify(token, process.env.JWT_SECRET);
      }
    }
  } catch (error) {
    // Silently fail for optional auth
  }
  next();
}

/* ---------------- Admin Middleware ---------------- */
const ADMIN_PAGE_SIZE_DEFAULT = 25;
const LESSON_STATUSES = ['Scheduled', 'Completed', 'Cancelled', 'No-Show', 'Rescheduled'];

async function requireAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Missing authentication token'
      });
    }

    const token = authHeader.slice(7);
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(payload.uid).select('_id email role');
    
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User not found'
      });
    }

    if (!['admin', 'manager'].includes(user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Admin or manager access required'
      });
    }

    req.admin = { 
      id: user._id, 
      email: user.email, 
      role: user.role 
    };
    next();
  } catch (error) {
    console.error('Admin authentication error:', error);
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token'
    });
  }
}

/* ---------------- Utility Functions ---------------- */
function validateEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function sanitizeInput(input) {
  if (typeof input !== 'string') return input;
  return input.trim().replace(/[<>]/g, '');
}

async function createGuestUser(email) {
  const sanitizedEmail = email.toLowerCase().trim();
  if (!validateEmail(sanitizedEmail)) {
    throw new Error('Invalid email format for guest user');
  }

  const existingUser = await User.findOne({ email: sanitizedEmail });
  if (existingUser) return existingUser;

  const randomPassword = crypto.randomBytes(16).toString('hex');
  const passwordHash = await bcrypt.hash(randomPassword, 10);

  return await User.create({
    email: sanitizedEmail,
    passwordHash,
    firstName: 'Guest',
    lastName: 'User',
    role: 'student',
    isGuest: true
  });
}

/* ---------------- Route Handlers ---------------- */

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    ok: true, 
    timestamp: new Date().toISOString(),
    service: 'Grand English Courses API'
  });
});

/* ---------------- Teacher Application Form ---------------- */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { 
    fileSize: 25 * 1024 * 1024, // 25MB
    files: 5
  },
  fileFilter: (req, file, cb) => {
    // Allow audio files and documents
    const allowedMimes = [
      'audio/webm', 'audio/mpeg', 'audio/wav', 'audio/ogg',
      'application/pdf', 'application/msword', 
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];
    
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} not allowed`), false);
    }
  }
});

app.post('/submit', upload.any(), async (req, res) => {
  try {
    const files = {};
    (req.files || []).forEach(file => {
      files[file.fieldname] = file;
    });

    console.log('Uploaded files:', Object.keys(files));

    // Validate required files
    const cvFile = files['cv'] || files['resume'] || files['cvFile'] || null;
    const audioQ1 = files['audioQ1'] || null;
    const audioQ2 = files['audioQ2'] || null;
    const audioMain = files['audio'] || null;

    if (!cvFile) {
      return res.status(400).json({
        success: false,
        message: 'CV/resume file is required'
      });
    }

    if (!audioQ1 && !audioQ2 && !audioMain) {
      return res.status(400).json({
        success: false,
        message: 'At least one audio file is required (audio, audioQ1, or audioQ2)'
      });
    }

    // Extract and sanitize form data
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

    const parsedLanguages = languages ? 
      String(languages).split(',').map(lang => sanitizeInput(lang.trim())) : [];

    // Process audio files
    const [processedQ1, processedQ2, processedMain] = await Promise.all([
      normalizeToMp3(audioQ1, 'speaking-q1'),
      normalizeToMp3(audioQ2, 'speaking-q2'),
      normalizeToMp3(audioMain, 'speaking-assessment')
    ]);

    // Prepare attachments
    const attachments = [];
    const seenFiles = new Set();

    function addAttachment(attachment) {
      if (!attachment || !attachment.content) return;
      
      const fileKey = `${attachment.filename}:${attachment.content.length}`;
      if (!seenFiles.has(fileKey)) {
        seenFiles.add(fileKey);
        attachments.push(attachment);
      }
    }

    // Add CV
    if (cvFile) {
      addAttachment({
        filename: cvFile.originalname || 'CV.pdf',
        content: cvFile.buffer,
        contentType: cvFile.mimetype || 'application/octet-stream'
      });
    }

    // Add processed audio files
    [processedQ1, processedQ2, processedMain].forEach(audio => {
      if (audio) addAttachment(audio);
    });

    // Send response immediately
    res.status(201).json({
      success: true,
      message: 'Application submitted successfully'
    });

    // Send email in background
    setImmediate(async () => {
      try {
        await sendEmail({
          to: ADMIN_TO,
          subject: `🎓 New Teacher Application from ${fullname}`,
          html: `
            <h2>New Teacher Application</h2>
            <p><strong>Email:</strong> ${sanitizeInput(email)}</p>
            <p><strong>Full Name:</strong> ${sanitizeInput(fullname)}</p>
            <p><strong>Country:</strong> ${sanitizeInput(country)}</p>
            <p><strong>Age:</strong> ${sanitizeInput(age)}</p>
            <p><strong>Timezone:</strong> ${sanitizeInput(timezone)}</p>
            <p><strong>Languages:</strong> ${parsedLanguages.join(', ')}</p>
            <p><strong>Experience:</strong> ${sanitizeInput(experience)}</p>
            <p><strong>Quiz Score:</strong> ${quizScore}/20 (${quizPercentage}%)</p>
            <p><strong>Submitted:</strong> ${new Date().toLocaleString()}</p>
          `,
          attachments
        });
      } catch (emailError) {
        console.error('Failed to send application email:', emailError);
      }
    });

  } catch (error) {
    console.error('Teacher application submission error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/* ---------------- Authentication Routes ---------------- */
app.post('/api/register', async (req, res) => {
  try {
    const { fullName, email, password } = req.body;

    // Validation
    if (!fullName || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Full name, email, and password are required'
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters long'
      });
    }

    if (!validateEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format'
      });
    }

    const sanitizedEmail = email.toLowerCase().trim();
    const existingUser = await User.findOne({ email: sanitizedEmail });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: 'User with this email already exists'
      });
    }

    // Split name
    const nameParts = fullName.trim().split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    // Hash password and create user
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({
      email: sanitizedEmail,
      passwordHash,
      firstName: sanitizeInput(firstName),
      lastName: sanitizeInput(lastName),
      role: 'student'
    });

    const token = signToken(user);
    
    res.status(201).json({
      success: true,
      token,
      user: {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      message: 'Registration failed due to server error'
    });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required'
      });
    }

    const sanitizedEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: sanitizedEmail });
    
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    const token = signToken(user);
    
    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Login failed due to server error'
    });
  }
});

app.get('/api/me', optionalAuth, async (req, res) => {
  try {
    if (!req.user) {
      return res.json({ 
        success: true, 
        user: null 
      });
    }

    const user = await User.findById(req.user.uid)
      .select('_id email firstName lastName role isGuest');
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      user
    });

  } catch (error) {
    console.error('Get user profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user profile'
    });
  }
});

/* ---------------- Booking Routes ---------------- */

// Unified booking function
async function createBooking(bookingData, user, isTrial = false) {
  const {
    date, time, level, childName, parentName, childAge, country, timeZone, email
  } = bookingData;

  // Validate required fields
  if (!date || !time || !level) {
    throw new Error('Date, time, and level are required');
  }

  if (!isTrial && (!childName || !parentName || !email)) {
    throw new Error('Child name, parent name, and email are required for regular bookings');
  }

  const bookingPayload = {
    user: user._id,
    email: user.email,
    childName: isTrial ? 'Trial Student' : childName,
    parentName: isTrial ? 
      `${user.firstName || 'Parent'} ${user.lastName || ''}`.trim() : 
      parentName,
    childAge: childAge || null,
    country: country || '',
    timeZone: timeZone || '',
    dateStr: date,
    timeStr: time,
    level: level || 'Beginner',
    status: 'Scheduled',
    teacherName: process.env.TEACHER_NAME || 'Teacher'
  };

  const booking = await Booking.create(bookingPayload);

  // Send notification emails
  setImmediate(async () => {
    try {
      const lessonType = isTrial ? 'trial lesson' : 'lesson';
      
      // Admin notification
      await sendEmail({
        to: ADMIN_TO,
        subject: `🗓️ New ${lessonType} booking: ${booking.childName} (${booking.dateStr} ${booking.timeStr})`,
        html: `
          <h2>New ${lessonType} Booking</h2>
          <p><strong>Child:</strong> ${booking.childName}</p>
          <p><strong>Parent:</strong> ${booking.parentName}</p>
          <p><strong>Email:</strong> ${booking.email}</p>
          <p><strong>Level:</strong> ${booking.level}</p>
          <p><strong>Date & Time:</strong> ${booking.dateStr} ${booking.timeStr}${booking.timeZone ? ` (${booking.timeZone})` : ''}</p>
          ${booking.country ? `<p><strong>Country:</strong> ${booking.country}</p>` : ''}
          ${!isTrial ? `<p><strong>Type:</strong> Regular lesson</p>` : `<p><strong>Type:</strong> Trial lesson</p>`}
        `
      });

      // Student confirmation
      await sendEmail({
        to: booking.email,
        subject: `Your ${lessonType} is scheduled (${booking.dateStr} ${booking.timeStr})`,
        html: `
          <h2>Your ${lessonType} is scheduled ✅</h2>
          <p><strong>Date & Time:</strong> ${booking.dateStr} ${booking.timeStr}${booking.timeZone ? ` (${booking.timeZone})` : ''}</p>
          <p><strong>Teacher:</strong> ${booking.teacherName}</p>
          <p><strong>Level:</strong> ${booking.level}</p>
          <p>If you have any questions or need to reschedule, please reply to this email.</p>
          <br>
          <p>Best regards,<br>Grand English Courses Team</p>
        `
      });

    } catch (emailError) {
      console.error('Failed to send booking confirmation emails:', emailError);
    }
  });

  return booking;
}

// Trial booking (works with JWT and guest users)
app.post('/api/bookings/trial', optionalAuth, async (req, res) => {
  try {
    const { date, time, level, email: providedEmail } = req.body;

    if (!date || !time) {
      return res.status(400).json({
        success: false,
        message: 'Date and time are required for trial booking'
      });
    }

    let user;

    if (req.user && req.user.uid) {
      // Authenticated user
      user = await User.findById(req.user.uid);
      if (!user) {
        return res.status(401).json({
          success: false,
          message: 'Authenticated user not found'
        });
      }
    } else {
      // Guest user - find or create
      const emailCandidates = [
        providedEmail,
        req.body.userEmail,
        req.body.contactEmail,
        req.body.login,
        req.body.username,
        req.headers['x-user-email']
      ].map(v => (v || '').toString().trim()).filter(Boolean);

      const guestEmail = (emailCandidates[0] || `guest+${Date.now()}@grandenglish.local`).toLowerCase();
      
      if (!validateEmail(guestEmail)) {
        return res.status(400).json({
          success: false,
          message: 'Valid email is required for guest booking'
        });
      }

      user = await createGuestUser(guestEmail);
    }

    const booking = await createBooking(
      { date, time, level: level || 'Beginner' },
      user,
      true // isTrial
    );

    res.json({
      success: true,
      booking: {
        id: booking._id,
        date: booking.dateStr,
        time: booking.timeStr,
        level: booking.level,
        status: booking.status,
        teacherName: booking.teacherName
      }
    });

  } catch (error) {
    console.error('Trial booking error:', error);
    res.status(500).json({
      success: false,
      message: 'Trial booking failed',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Regular booking (requires authentication)
app.post('/api/book', auth, async (req, res) => {
  try {
    const {
      email,
      childName,
      parentName,
      childAge,
      country,
      timeZone,
      date,
      time,
      level
    } = req.body;

    // Validation
    if (!date || !time || !childName || !parentName || !email || !level) {
      return res.status(400).json({
        success: false,
        message: 'All fields are required: date, time, childName, parentName, email, level'
      });
    }

    if (!validateEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Valid email is required'
      });
    }

    const user = await User.findById(req.user.uid);
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User not found'
      });
    }

    const booking = await createBooking(
      { date, time, level, childName, parentName, childAge, country, timeZone, email },
      user,
      false // isTrial
    );

    res.json({
      success: true,
      booking: {
        id: booking._id,
        childName: booking.childName,
        date: booking.dateStr,
        time: booking.timeStr,
        level: booking.level,
        status: booking.status,
        teacherName: booking.teacherName
      }
    });

  } catch (error) {
    console.error('Regular booking error:', error);
    res.status(500).json({
      success: false,
      message: 'Booking failed',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get user's bookings
app.get('/api/my-bookings', auth, async (req, res) => {
  try {
    const bookings = await Booking.find({ user: req.user.uid })
      .sort({ createdAt: -1 })
      .lean();

    const formattedBookings = bookings.map(booking => ({
      ...booking,
      status: (booking.status || '').toLowerCase()
    }));

    res.json({
      success: true,
      bookings: formattedBookings,
      count: formattedBookings.length
    });

  } catch (error) {
    console.error('Get user bookings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve bookings'
    });
  }
});

// Get latest booking
app.get('/api/my-bookings/latest', auth, async (req, res) => {
  try {
    const booking = await Booking.findOne({ user: req.user.uid })
      .sort({ createdAt: -1 })
      .lean();

    if (!booking) {
      return res.json({
        success: true,
        booking: null
      });
    }

    booking.status = String(booking.status).toLowerCase();

    res.json({
      success: true,
      booking
    });

  } catch (error) {
    console.error('Get latest booking error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch latest booking'
    });
  }
});

// Cancel booking
app.post('/api/bookings/:id/cancel', auth, async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid booking ID format'
      });
    }

    const booking = await Booking.findOne({ 
      _id: id, 
      user: req.user.uid 
    });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found or access denied'
      });
    }

    if (booking.status === 'Cancelled') {
      return res.status(400).json({
        success: false,
        message: 'Booking is already cancelled'
      });
    }

    booking.status = 'Cancelled';
    await booking.save();

    // Send cancellation emails
    setImmediate(async () => {
      try {
        await sendEmail({
          to: ADMIN_TO,
          subject: `❌ Booking Cancelled: ${booking.childName} (${booking.dateStr} ${booking.timeStr})`,
          html: `
            <h2>Booking Cancelled</h2>
            <p><strong>Child:</strong> ${booking.childName}</p>
            <p><strong>Parent:</strong> ${booking.parentName}</p>
            <p><strong>Email:</strong> ${booking.email}</p>
            <p><strong>Original Date & Time:</strong> ${booking.dateStr} ${booking.timeStr}</p>
            <p><strong>Cancelled At:</strong> ${new Date().toLocaleString()}</p>
          `
        });

        await sendEmail({
          to: booking.email,
          subject: `Booking Cancelled: ${booking.dateStr} ${booking.timeStr}`,
          html: `
            <h2>Booking Cancellation Confirmed</h2>
            <p>Your lesson scheduled for <strong>${booking.dateStr} ${booking.timeStr}</strong> has been cancelled.</p>
            <p>If this was a mistake or you'd like to reschedule, please contact us.</p>
          `
        });

      } catch (emailError) {
        console.error('Failed to send cancellation emails:', emailError);
      }
    });

    res.json({
      success: true,
      booking: {
        id: booking._id,
        status: booking.status,
        cancelledAt: new Date()
      }
    });

  } catch (error) {
    console.error('Cancel booking error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel booking'
    });
  }
});

// Reschedule booking
app.post('/api/bookings/:id/reschedule', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { date, time, level } = req.body;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid booking ID format'
      });
    }

    const booking = await Booking.findOne({ 
      _id: id, 
      user: req.user.uid 
    });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found or access denied'
      });
    }

    // Update booking details
    const oldDate = booking.dateStr;
    const oldTime = booking.timeStr;
    
    if (date) booking.dateStr = date;
    if (time) booking.timeStr = time;
    if (level) booking.level = level;
    
    booking.status = 'Scheduled';
    await booking.save();

    // Send rescheduling emails
    setImmediate(async () => {
      try {
        await sendEmail({
          to: ADMIN_TO,
          subject: `🔄 Booking Rescheduled: ${booking.childName}`,
          html: `
            <h2>Booking Rescheduled</h2>
            <p><strong>Child:</strong> ${booking.childName}</p>
            <p><strong>Parent:</strong> ${booking.parentName}</p>
            <p><strong>Email:</strong> ${booking.email}</p>
            <p><strong>From:</strong> ${oldDate} ${oldTime}</p>
            <p><strong>To:</strong> ${booking.dateStr} ${booking.timeStr}</p>
            <p><strong>Rescheduled At:</strong> ${new Date().toLocaleString()}</p>
          `
        });

        await sendEmail({
          to: booking.email,
          subject: `Booking Rescheduled: ${booking.dateStr} ${booking.timeStr}`,
          html: `
            <h2>Booking Rescheduled Successfully</h2>
            <p>Your lesson has been rescheduled to:</p>
            <p><strong>${booking.dateStr} ${booking.timeStr}</strong></p>
            <p>If you have any questions, please reply to this email.</p>
          `
        });

      } catch (emailError) {
        console.error('Failed to send rescheduling emails:', emailError);
      }
    });

    res.json({
      success: true,
      booking: {
        id: booking._id,
        date: booking.dateStr,
        time: booking.timeStr,
        level: booking.level,
        status: booking.status
      }
    });

  } catch (error) {
    console.error('Reschedule booking error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reschedule booking'
    });
  }
});

/* ---------------- Admin Routes ---------------- */

// Admin login
app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required'
      });
    }

    const sanitizedEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: sanitizedEmail });
    
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    if (!['admin', 'manager'].includes(user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Admin access required'
      });
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    const token = signToken(user);
    
    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role
      }
    });

  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({
      success: false,
      message: 'Login failed'
    });
  }
});

// Get bookings for admin
app.get('/api/admin/bookings', requireAdmin, async (req, res) => {
  try {
    const {
      page = 1,
      limit = ADMIN_PAGE_SIZE_DEFAULT,
      status,
      search,
      dateFrom,
      dateTo,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    // Build filter
    const filter = {};
    
    if (status && status !== 'all') {
      filter.status = status;
    }

    if (dateFrom || dateTo) {
      filter.createdAt = {};
      if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
      if (dateTo) filter.createdAt.$lte = new Date(dateTo);
    }

    if (search) {
      const searchRegex = new RegExp(search, 'i');
      filter.$or = [
        { childName: searchRegex },
        { parentName: searchRegex },
        { email: searchRegex },
        { country: searchRegex },
        { level: searchRegex }
      ];
    }

    // Get total count
    const total = await Booking.countDocuments(filter);
    
    // Get bookings with pagination
    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    const bookings = await Booking.find(filter)
      .populate('user', 'email firstName lastName isGuest')
      .sort(sort)
      .skip(skip)
      .limit(limitNum)
      .lean();

    res.json({
      success: true,
      bookings,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });

  } catch (error) {
    console.error('Admin get bookings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch bookings'
    });
  }
});

// Update booking status (admin)
app.patch('/api/admin/bookings/:id/status', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid booking ID'
      });
    }

    if (!LESSON_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${LESSON_STATUSES.join(', ')}`
      });
    }

    const booking = await Booking.findById(id);
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    const oldStatus = booking.status;
    booking.status = status;
    await booking.save();

    // Send status update email
    setImmediate(async () => {
      try {
        await sendEmail({
          to: booking.email,
          subject: `Lesson Status Updated: ${booking.dateStr} ${booking.timeStr}`,
          html: `
            <h2>Lesson Status Updated</h2>
            <p>Your lesson scheduled for <strong>${booking.dateStr} ${booking.timeStr}</strong> has been updated:</p>
            <p><strong>Status:</strong> ${oldStatus} → ${status}</p>
            <p>If you have any questions, please reply to this email.</p>
          `
        });
      } catch (emailError) {
        console.error('Failed to send status update email:', emailError);
      }
    });

    res.json({
      success: true,
      booking: {
        id: booking._id,
        status: booking.status,
        updatedAt: booking.updatedAt
      }
    });

  } catch (error) {
    console.error('Admin update booking status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update booking status'
    });
  }
});

// Delete booking (admin)
app.delete('/api/admin/bookings/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid booking ID'
      });
    }

    const booking = await Booking.findById(id);
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    await Booking.findByIdAndDelete(id);

    res.json({
      success: true,
      message: 'Booking deleted successfully'
    });

  } catch (error) {
    console.error('Admin delete booking error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete booking'
    });
  }
});

// Create booking (admin)
app.post('/api/admin/bookings', requireAdmin, async (req, res) => {
  try {
    const {
      email,
      childName,
      parentName,
      childAge,
      country,
      timeZone,
      date,
      time,
      level,
      teacherName,
      status = 'Scheduled'
    } = req.body;

    // Validation
    if (!email || !childName || !parentName || !date || !time || !level) {
      return res.status(400).json({
        success: false,
        message: 'Email, childName, parentName, date, time, and level are required'
      });
    }

    if (!validateEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Valid email is required'
      });
    }

    // Find or create user
    let user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      user = await createGuestUser(email);
    }

    const booking = await Booking.create({
      user: user._id,
      email: user.email,
      childName: sanitizeInput(childName),
      parentName: sanitizeInput(parentName),
      childAge: childAge || null,
      country: sanitizeInput(country || ''),
      timeZone: sanitizeInput(timeZone || ''),
      dateStr: date,
      timeStr: time,
      level: level,
      status: status,
      teacherName: sanitizeInput(teacherName || process.env.TEACHER_NAME || 'Teacher')
    });

    // Send confirmation email
    setImmediate(async () => {
      try {
        await sendEmail({
          to: booking.email,
          subject: `Lesson Scheduled: ${booking.dateStr} ${booking.timeStr}`,
          html: `
            <h2>Lesson Scheduled</h2>
            <p><strong>Date & Time:</strong> ${booking.dateStr} ${booking.timeStr}${booking.timeZone ? ` (${booking.timeZone})` : ''}</p>
            <p><strong>Teacher:</strong> ${booking.teacherName}</p>
            <p><strong>Level:</strong> ${booking.level}</p>
            <p>If you have any questions, please reply to this email.</p>
          `
        });
      } catch (emailError) {
        console.error('Failed to send admin booking email:', emailError);
      }
    });

    const populatedBooking = await Booking.findById(booking._id)
      .populate('user', 'email firstName lastName isGuest');

    res.status(201).json({
      success: true,
      booking: populatedBooking
    });

  } catch (error) {
    console.error('Admin create booking error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create booking',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Export bookings to Excel
app.get('/api/admin/bookings/export', requireAdmin, async (req, res) => {
  try {
    const bookings = await Booking.find()
      .populate('user', 'email firstName lastName isGuest')
      .sort({ createdAt: -1 })
      .lean();

    // Prepare data for Excel
    const data = bookings.map(booking => ({
      'ID': booking._id.toString(),
      'Child Name': booking.childName,
      'Parent Name': booking.parentName,
      'Email': booking.email,
      'Child Age': booking.childAge || '',
      'Country': booking.country || '',
      'Time Zone': booking.timeZone || '',
      'Date': booking.dateStr,
      'Time': booking.timeStr,
      'Level': booking.level,
      'Status': booking.status,
      'Teacher': booking.teacherName,
      'Created At': new Date(booking.createdAt).toLocaleString(),
      'User Type': booking.user?.isGuest ? 'Guest' : 'Registered'
    }));

    const worksheet = xlsx.utils.json_to_sheet(data);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Bookings');
    
    const buffer = xlsx.write(workbook, { 
      type: 'buffer', 
      bookType: 'xlsx' 
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="bookings-${new Date().toISOString().split('T')[0]}.xlsx"`);
    
    res.send(buffer);

  } catch (error) {
    console.error('Export bookings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to export bookings'
    });
  }
});

// Get admin dashboard stats
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const [
      totalBookings,
      scheduledBookings,
      completedBookings,
      cancelledBookings,
      totalUsers,
      guestUsers
    ] = await Promise.all([
      Booking.countDocuments(),
      Booking.countDocuments({ status: 'Scheduled' }),
      Booking.countDocuments({ status: 'Completed' }),
      Booking.countDocuments({ status: 'Cancelled' }),
      User.countDocuments(),
      User.countDocuments({ isGuest: true })
    ]);

    // Recent bookings (last 7 days)
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    
    const recentBookings = await Booking.countDocuments({
      createdAt: { $gte: oneWeekAgo }
    });

    res.json({
      success: true,
      stats: {
        bookings: {
          total: totalBookings,
          scheduled: scheduledBookings,
          completed: completedBookings,
          cancelled: cancelledBookings,
          recent: recentBookings
        },
        users: {
          total: totalUsers,
          guests: guestUsers,
          registered: totalUsers - guestUsers
        }
      }
    });

  } catch (error) {
    console.error('Admin stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch dashboard stats'
    });
  }
});

/* ---------------- Time Slots Management ---------------- */

// Get available time slots
app.get('/api/time-slots', async (req, res) => {
  try {
    const now = new Date();
    const slots = await TimeSlot.find({ isActive: true })
      .sort({ startISO: 1, dow: 1, startTime: 1 })
      .lean();

    // Separate one-off and recurring slots
    const oneOffSlots = slots.filter(s => s.kind === 'oneoff');
    const recurringSlots = slots.filter(s => s.kind === 'recurring');

    res.json({
      success: true,
      oneOffSlots,
      recurringSlots
    });

  } catch (error) {
    console.error('Get time slots error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch time slots'
    });
  }
});

// Admin time slots management
app.get('/api/admin/time-slots', requireAdmin, async (req, res) => {
  try {
    const slots = await TimeSlot.find()
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      slots
    });

  } catch (error) {
    console.error('Admin get time slots error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch time slots'
    });
  }
});

// Create time slot (admin)
app.post('/api/admin/time-slots', requireAdmin, async (req, res) => {
  try {
    const {
      kind = 'oneoff',
      startISO,
      endISO,
      validFrom,
      validTo,
      dow,
      startTime,
      endTime,
      timeZone,
      teacherName,
      note,
      isActive = true
    } = req.body;

    // Validation based on slot type
    if (kind === 'oneoff') {
      if (!startISO || !endISO) {
        return res.status(400).json({
          success: false,
          message: 'startISO and endISO are required for one-off slots'
        });
      }
    } else if (kind === 'recurring') {
      if (dow === undefined || !startTime || !endTime) {
        return res.status(400).json({
          success: false,
          message: 'dow, startTime, and endTime are required for recurring slots'
        });
      }
    }

    const slot = await TimeSlot.create({
      kind,
      startISO: kind === 'oneoff' ? new Date(startISO) : undefined,
      endISO: kind === 'oneoff' ? new Date(endISO) : undefined,
      validFrom: kind === 'recurring' ? (validFrom ? new Date(validFrom) : undefined) : undefined,
      validTo: kind === 'recurring' ? (validTo ? new Date(validTo) : undefined) : undefined,
      dow: kind === 'recurring' ? parseInt(dow) : undefined,
      startTime: kind === 'recurring' ? startTime : undefined,
      endTime: kind === 'recurring' ? endTime : undefined,
      timeZone: kind === 'recurring' ? timeZone : undefined,
      teacherName: teacherName || process.env.TEACHER_NAME || 'Teacher',
      note,
      isActive
    });

    res.status(201).json({
      success: true,
      slot
    });

  } catch (error) {
    console.error('Create time slot error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create time slot'
    });
  }
});

// Update time slot (admin)
app.patch('/api/admin/time-slots/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid time slot ID'
      });
    }

    const slot = await TimeSlot.findById(id);
    if (!slot) {
      return res.status(404).json({
        success: false,
        message: 'Time slot not found'
      });
    }

    // Update fields
    Object.keys(updates).forEach(key => {
      if (key !== '_id' && key !== 'createdAt' && key !== 'updatedAt') {
        slot[key] = updates[key];
      }
    });

    await slot.save();

    res.json({
      success: true,
      slot
    });

  } catch (error) {
    console.error('Update time slot error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update time slot'
    });
  }
});

// Delete time slot (admin)
app.delete('/api/admin/time-slots/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid time slot ID'
      });
    }

    const slot = await TimeSlot.findById(id);
    if (!slot) {
      return res.status(404).json({
        success: false,
        message: 'Time slot not found'
      });
    }

    await TimeSlot.findByIdAndDelete(id);

    res.json({
      success: true,
      message: 'Time slot deleted successfully'
    });

  } catch (error) {
    console.error('Delete time slot error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete time slot'
    });
  }
});

/* ---------------- Error Handling Middleware ---------------- */
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message: 'File too large. Maximum size is 25MB.'
      });
    }
    if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        success: false,
        message: 'Too many files. Maximum is 5 files.'
      });
    }
  }

  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? error.message : undefined
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

/* ---------------- Server Startup ---------------- */
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📧 Email service: ${process.env.EMAIL_USER ? 'Configured' : 'NOT configured'}`);
  console.log(`🗄️  Database: ${MONGO_URI ? 'Connected' : 'NOT configured'}`);
  console.log(`🔐 JWT: ${process.env.JWT_SECRET ? 'Configured' : 'NOT configured'}`);
  console.log(`👨‍🏫 Teacher: ${process.env.TEACHER_NAME || 'Default'}`);
});