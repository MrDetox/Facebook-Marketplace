const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { researchItem } = require('./ai_researcher');
const { uploadToFacebook } = require('./facebook_uploader');
const { spawn } = require('child_process');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Global in-memory queue for Photography Mode
// Stores objects: { id: string, timestamp: number, photoPaths: string[] }
let globalQueue = [];
let tunnelUrl = '';
let tunnelQrDataUrl = '';

// Setup upload directory
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
        // Use timestamp + random string + index-friendly suffix to prevent collisions
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ storage: storage });

app.use(express.static('public'));
app.use(express.json());

app.post('/api/upload', upload.array('photos', 10), async (req, res) => {
    try {
        let photoPaths = [];

        // Check if we are uploading from the queue
        if (req.body.queueId) {
            const queueItem = globalQueue.find(item => item.id === req.body.queueId);
            if (!queueItem) {
                return res.status(404).json({ error: 'Queue item not found.' });
            }
            photoPaths = queueItem.photoPaths;
        } else {
            // Otherwise, we are doing a direct single upload
            if (!req.files || req.files.length === 0) {
                return res.status(400).json({ error: 'No photos uploaded.' });
            }
            photoPaths = req.files.map(file => file.path);
        }

        const aiPhotoIndex = parseInt(req.body.aiPhotoIndex, 10) || 0;

        console.log(`Processing ${photoPaths.length} photos. Using photo index ${aiPhotoIndex} for AI research...`);

        // 1. Send photos to Gemini to get listing details
        const listingDetails = await researchItem(photoPaths, aiPhotoIndex);
        console.log('AI Research Complete:', listingDetails);

        // 2. Launch Playwright to upload to Facebook Marketplace
        console.log('Starting Facebook Automation...');
        await uploadToFacebook(photoPaths, listingDetails);

        // If it was a queued item, remove it from the queue after successful upload
        if (req.body.queueId) {
            globalQueue = globalQueue.filter(item => item.id !== req.body.queueId);
        }

        res.json({ success: true, message: 'Item successfully listed on Facebook Marketplace!', details: listingDetails });

    } catch (error) {
        console.error('Error during processing:', error);
        res.status(500).json({ error: error.message });
    }
});

// --- Server-Side Queue API ---

// 1. Add item to queue (from Photography Mode phone)
app.post('/api/queue', upload.array('photos', 10), (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No photos uploaded to queue.' });
    }

    const item = {
        id: Date.now().toString(),
        timestamp: Date.now(),
        photoPaths: req.files.map(file => file.path)
    };

    globalQueue.push(item);
    console.log(`Added item ${item.id} to queue with ${item.photoPaths.length} photos.`);
    res.json({ success: true, item: item });
});

// 2. Get all queue items (for main index.html tab)
app.get('/api/queue', (req, res) => {
    // Only send metadata, not the full files (thumbnails could be tricky, 
    // but we can serve the files statically if needed via a route, or just send paths)
    // To make it easy, we will send the paths, and the frontend will fetch them
    res.json({ queue: globalQueue });
});

// 3. Delete an item from queue
app.delete('/api/queue/:id', (req, res) => {
    const id = req.params.id;
    const initialLength = globalQueue.length;
    globalQueue = globalQueue.filter(item => item.id !== id);

    // Note: In a production app, we should also delete the files from the disk here!

    if (globalQueue.length < initialLength) {
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Item not found' });
    }
});

// 4. Serve uploaded files so frontend can show thumbnails of the queue
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// 5. Get tunnel info
app.get('/api/tunnel-info', (req, res) => {
    res.json({ url: tunnelUrl, qr: tunnelQrDataUrl });
});

app.listen(port, async () => {
    console.log(`Auto-Lister app listening at http://localhost:${port}`);

    // Start Cloudflare Tunnel via npx for maximum reliability
    try {
        console.log('Starting Cloudflare Tunnel (npx)...');

        // Use npx to avoid installation issues with the npm package
        const cloudflared = spawn('npx', ['cloudflared', 'tunnel', '--url', `http://localhost:${port}`], { shell: true });

        cloudflared.stderr.on('data', (data) => {
            const output = data.toString();
            // Cloudflare outputs the URL in stderr
            const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
            if (match && !tunnelUrl) {
                tunnelUrl = match[0];
                console.log(`\n-----------------------------------------`);
                console.log(`Tunnel link: ${tunnelUrl}`);
                console.log(`No password or warning screen!`);

                // Generate QR Code for Terminal
                qrcodeTerminal.generate(tunnelUrl, { small: true }, (qrcode) => {
                    console.log(qrcode);
                });
                console.log(`-----------------------------------------\n`);

                // Generate QR Code Data URL for Frontend
                QRCode.toDataURL(tunnelUrl).then(qr => {
                    tunnelQrDataUrl = qr;
                });
            }
        });

        cloudflared.on('close', (code) => {
            console.log(`Cloudflare Tunnel closed with code ${code}`);
            tunnelUrl = '';
            tunnelQrDataUrl = '';
        });

        process.on('exit', () => cloudflared.kill());

    } catch (err) {
        console.error('Error starting Cloudflare tunnel:', err);
    }
});
