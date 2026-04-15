const cloudinary = require('cloudinary').v2;
const multer = require('multer');

// Configure Cloudinary - using ROOT credentials
cloudinary.config({
    cloud_name: 'dqjv09qfc',
    api_key: '291617337945684',
    api_secret: 'O7zVbWzVeKVAtQ_KSSzkVlMx6g8',
    secure: true
});

// Multer configuration (memory storage)
const storage = multer.memoryStorage();
const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

const uploadToCloudinary = (buffer, folder = 'products') => {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            {
                folder,
                transformation: [{ width: 800, height: 800, crop: 'limit' }, { quality: 'auto' }]
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
