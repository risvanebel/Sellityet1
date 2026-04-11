const cloudinary = require('cloudinary').v2;
const multer = require('multer');

// Configure Cloudinary
if (process.env.CLOUDINARY_URL) {
  // Parse URL format: cloudinary://api_key:api_secret@cloud_name
  const url = new URL(process.env.CLOUDINARY_URL);
  cloudinary.config({
    cloud_name: url.hostname,
    api_key: url.username,
    api_secret: url.password,
    secure: true
  });
} else {
  // Fallback to direct config (replace with env vars in production)
  cloudinary.config({
    cloud_name: 'dqjv09qfc',
    api_key: '194236154687873',
    api_secret: 'XjdGkc0-_V-Q-kst6Go6-SCQnAM',
    secure: true
  });
}

// Multer configuration (memory storage)
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Nur JPEG, PNG und WebBilder erlaubt'), false);
    }
  }
});

const uploadToCloudinary = (buffer, folder = 'products') => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        transformation: [
          { width: 800, height: 800, crop: 'limit' },
          { quality: 'auto' }
        ]
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    
    const { Readable } = require('stream');
    const readableStream = new Readable();
    readableStream.push(buffer);
    readableStream.push(null);
    readableStream.pipe(uploadStream);
  });
};

module.exports = { upload, uploadToCloudinary };