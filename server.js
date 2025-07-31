require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

const uploadDir = process.env.UPLOAD_DIR || 'uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, 'audio-' + uniqueSuffix + '.webm');
  }
});

const upload = multer({ storage });

// 🔧 Вот тут обрабатываем обычное поле formData и файл audio
app.post('/submit', upload.single('audio'), (req, res) => {
  try {
    console.log('req.body:', req.body);

    const formDataRaw = req.body.formData;
    if (!formDataRaw) {
      return res.status(400).json({ error: 'Missing formData' });
    }

    const formData = JSON.parse(formDataRaw);
    const audioFile = req.file;

    if (!audioFile) {
      return res.status(400).json({ error: 'Missing audio file' });
    }

    const application = {
      ...formData,
      audioFile: audioFile.filename,
      submittedAt: new Date().toISOString()
    };

    console.log('Received application:', application);

    res.json({ message: 'Data received successfully', data: application });
  } catch (err) {
    console.error('Error in /submit:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
