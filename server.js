const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: 'uploads/' });

app.post('/submit', upload.fields([
  { name: 'formData', maxCount: 1 },
  { name: 'audio', maxCount: 1 }
]), (req, res) => {
  try {
    const formFile = req.files['formData']?.[0];
    const audioFile = req.files['audio']?.[0];

    if (!formFile || !audioFile) {
      return res.status(400).json({ error: 'Missing formData or audio' });
    }

    // Читаем JSON из файла
    const formDataRaw = fs.readFileSync(formFile.path, 'utf8');
    let formData;
    try {
      formData = JSON.parse(formDataRaw);
    } catch (err) {
      return res.status(400).json({ error: 'Invalid JSON in formData' });
    }

    // Путь к аудио
    const audioPath = path.resolve(audioFile.path);

    // Логируем для проверки
    console.log('Received formData:', formData);
    console.log('Received audio file:', audioPath);

    res.json({ message: 'Data received successfully' });
  } catch (err) {
    console.error('Error in /submit:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
