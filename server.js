const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: 'uploads/' });

// Email transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

app.post('/submit', upload.single('audio'), async (req, res) => {
  try {
    const formDataRaw = req.body.formData;

    if (!formDataRaw || !req.file) {
      return res.status(400).json({ success: false, message: 'Missing formData or audio file' });
    }

    const formData = JSON.parse(formDataRaw);

    const application = {
      ...formData,
      audioFile: req.file.filename,
      submittedAt: new Date().toISOString()
    };

    // Логируем
    console.log('Received application:', application);

    // Формируем письмо
    const { email, fullname, age, country, languages, timezone, experience } = application.basicInfo;
    const score = application.quizScore;
    const percentage = application.quizPercentage;

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: process.env.NOTIFY_TO,
      subject: `🎓 Новая заявка от ${fullname || 'Неизвестно'}`,
      html: `
        <h2>Новая заявка</h2>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Имя:</strong> ${fullname}</p>
        <p><strong>Страна:</strong> ${country}</p>
        <p><strong>Возраст:</strong> ${age}</p>
        <p><strong>Часовой пояс:</strong> ${timezone}</p>
        <p><strong>Языки:</strong> ${languages?.join(', ') || '—'}</p>
        <p><strong>Опыт:</strong> ${experience || '—'}</p>
        <p><strong>Тест:</strong> ${score}/20 (${percentage}%)</p>
        <p><strong>Файл:</strong> ${req.file.filename}</p>
      `
    };

    // Отправляем письмо
    await transporter.sendMail(mailOptions);

    res.status(201).json({ success: true, message: 'Application submitted and email sent' });
  } catch (err) {
    console.error('Error submitting application:', err);
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
