const express = require('express');
const multer = require('multer');
const cors = require('cors');
const nodemailer = require('nodemailer');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Настройка multer
const upload = multer({ dest: 'uploads/' });

// Настройка почты
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

app.post('/submit', upload.single('audio'), async (req, res) => {
  try {
    const audioFile = req.file;
    if (!audioFile) {
      return res.status(400).json({ success: false, message: 'Missing audio file' });
    }

    // Извлечь и распарсить данные формы
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

    const parsedLanguages = languages.split(',').map(l => l.trim());

    // Формируем письмо
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
        {
          filename: 'speaking-assessment.webm',
          path: path.join(__dirname, audioFile.path)
        }
      ]
    };

    await transporter.sendMail(mailOptions);

    res.status(201).json({ success: true, message: 'Application submitted and email sent' });

  } catch (err) {
    console.error('Error submitting application:', err);
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});