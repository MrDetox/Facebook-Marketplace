const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { researchItem, detectImageMime } = require('./ai_researcher');
const { uploadToFacebook, closeBrowser } = require('./facebook_uploader');
const { spawn } = require('child_process');
const QRCode = require('qrcode');

dotenv.config();

const app = express();
const port = Number(process.env.PORT) || 3000;
const accessToken = process.env.ACCESS_TOKEN || crypto.randomBytes(32).toString('base64url');
const accessCookie = 'fb_marketplace_access';
const maxPhotos = 10;
const maxFileSize = 12 * 1024 * 1024;
const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const extensionByMime = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/heic': '.heic',
    'image/heif': '.heif'
};

const uploadDir = path.join(__dirname, 'uploads');
const queueFile = path.join(__dirname, '.queue.json');
fs.mkdirSync(uploadDir, { recursive: true });

function queueFilename(value) {
    return path.basename(String(value || '').replace(/\\/g, '/'));
}

function loadQueue() {
    try {
        const saved = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
        if (!Array.isArray(saved)) return [];

        return saved.map(item => ({
            id: String(item.id),
            timestamp: Number(item.timestamp) || Date.now(),
            photoPaths: Array.isArray(item.photoPaths)
                ? item.photoPaths.map(queueFilename).filter(filename => fs.existsSync(path.join(uploadDir, filename)))
                : []
        })).filter(item => item.photoPaths.length > 0);
    } catch (error) {
        if (error.code !== 'ENOENT') console.error('Could not load the saved queue:', error.message);
        return [];
    }
}

let globalQueue = loadQueue();
let tunnelUrl = '';
let tunnelQrDataUrl = '';
let cloudflaredProcess = null;
let server = null;
let uploadInProgress = false;

function saveQueue() {
    const temporaryFile = `${queueFile}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(globalQueue, null, 2));
    fs.renameSync(temporaryFile, queueFile);
}

function removeFiles(filePaths) {
    for (const filePath of filePaths || []) {
        const resolvedPath = path.resolve(filePath);
        if (path.dirname(resolvedPath) !== uploadDir) continue;

        try {
            fs.rmSync(resolvedPath, { force: true });
        } catch (error) {
            console.error(`Could not remove ${resolvedPath}:`, error.message);
        }
    }
}

function validateUploadedFiles(files) {
    for (const file of files || []) {
        if (!detectImageMime(file.path)) {
            throw Object.assign(new Error('One of the uploaded files is not a supported image.'), { statusCode: 400 });
        }
    }
}

function tokensMatch(candidate) {
    if (typeof candidate !== 'string') return false;
    const actual = Buffer.from(accessToken);
    const supplied = Buffer.from(candidate);
    return actual.length === supplied.length && crypto.timingSafeEqual(actual, supplied);
}

function cookieValue(req, name) {
    for (const part of (req.headers.cookie || '').split(';')) {
        const separator = part.indexOf('=');
        if (separator === -1 || part.slice(0, separator).trim() !== name) continue;
        try {
            return decodeURIComponent(part.slice(separator + 1).trim());
        } catch {
            return '';
        }
    }
    return '';
}

function isLocalRequest(req) {
    return !req.headers['cf-connecting-ip'] && ['localhost', '127.0.0.1', '::1'].includes(req.hostname);
}

app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
    const headerToken = req.get('x-access-token');
    if (isLocalRequest(req) || tokensMatch(cookieValue(req, accessCookie)) || tokensMatch(headerToken)) return next();

    const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
    if (tokensMatch(queryToken)) {
        res.cookie(accessCookie, accessToken, {
            httpOnly: true,
            maxAge: 24 * 60 * 60 * 1000,
            sameSite: 'lax',
            secure: true
        });
        return next();
    }

    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Access denied. Scan the QR code shown on the local main page.' });
    }
    return res.status(401).send('Access denied. Scan the QR code shown on the local main page.');
});

const storage = multer.diskStorage({
    destination: uploadDir,
    filename(req, file, callback) {
        const uniqueName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
        callback(null, uniqueName + extensionByMime[file.mimetype]);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: maxFileSize, files: maxPhotos },
    fileFilter(req, file, callback) {
        if (allowedImageTypes.has(file.mimetype)) return callback(null, true);
        callback(Object.assign(new Error('Only JPEG, PNG, WebP, HEIC, and HEIF images are supported.'), { statusCode: 400 }));
    }
});

app.use(express.json());

function singleUpload(req, res, next) {
    if (uploadInProgress) {
        return res.status(409).json({ error: 'Another listing is already being prepared. Please wait for it to finish.' });
    }

    // ponytail: one global lock is enough for one Facebook account; use per-account locks if multi-user support is added.
    uploadInProgress = true;
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        uploadInProgress = false;
    };
    res.once('finish', release);
    res.once('close', release);
    next();
}

function queuedPhotoPaths(queueItem, requestedOrder) {
    let filenames = queueItem.photoPaths;

    if (requestedOrder) {
        let parsed;
        try {
            parsed = JSON.parse(requestedOrder);
        } catch {
            throw Object.assign(new Error('The queued photo order is invalid.'), { statusCode: 400 });
        }

        const allowed = new Set(queueItem.photoPaths);
        const normalized = Array.isArray(parsed) ? parsed.map(queueFilename) : [];
        if (!normalized.length || normalized.length > maxPhotos || new Set(normalized).size !== normalized.length || normalized.some(name => !allowed.has(name))) {
            throw Object.assign(new Error('The queued photo order is invalid.'), { statusCode: 400 });
        }
        filenames = normalized;
    }

    return filenames.map(filename => path.join(uploadDir, filename));
}

app.post('/api/upload', singleUpload, upload.array('photos', maxPhotos), async (req, res) => {
    let temporaryPhotoPaths = (req.files || []).map(file => file.path);

    try {
        validateUploadedFiles(req.files);

        let photoPaths;
        if (req.body.queueId) {
            if (req.files?.length) {
                throw Object.assign(new Error('Queued items must use their saved photos.'), { statusCode: 400 });
            }
            const queueItem = globalQueue.find(item => item.id === req.body.queueId);
            if (!queueItem) return res.status(404).json({ error: 'Queue item not found.' });
            photoPaths = queuedPhotoPaths(queueItem, req.body.photoOrder);
        } else {
            if (!req.files?.length) return res.status(400).json({ error: 'No photos uploaded.' });
            photoPaths = temporaryPhotoPaths;
        }

        const requestedIndex = Number.parseInt(req.body.aiPhotoIndex, 10);
        const aiPhotoIndex = Number.isInteger(requestedIndex) && requestedIndex >= 0 && requestedIndex < photoPaths.length
            ? requestedIndex
            : 0;

        console.log(`Processing ${photoPaths.length} photos. Using photo index ${aiPhotoIndex} for AI research...`);
        const listingDetails = await researchItem(photoPaths, aiPhotoIndex);

        console.log('AI research complete. Preparing Facebook draft...');
        await uploadToFacebook(photoPaths, listingDetails);

        res.json({
            success: true,
            published: false,
            message: 'Draft prepared. Review it in the Facebook window and click Publish.',
            details: listingDetails
        });
    } catch (error) {
        console.error('Error during processing:', error);
        res.status(error.statusCode || 500).json({ error: error.message });
    } finally {
        removeFiles(temporaryPhotoPaths);
    }
});

app.post('/api/queue', upload.array('photos', maxPhotos), (req, res) => {
    try {
        validateUploadedFiles(req.files);
        if (!req.files?.length) return res.status(400).json({ error: 'No photos uploaded to queue.' });

        const item = {
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            photoPaths: req.files.map(file => file.filename)
        };

        globalQueue.push(item);
        saveQueue();
        console.log(`Added item ${item.id} to queue with ${item.photoPaths.length} photos.`);
        res.json({ success: true, item });
    } catch (error) {
        removeFiles((req.files || []).map(file => file.path));
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

app.get('/api/queue', (req, res) => {
    res.json({ queue: globalQueue });
});

app.delete('/api/queue/:id', (req, res) => {
    const item = globalQueue.find(queueItem => queueItem.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found.' });

    globalQueue = globalQueue.filter(queueItem => queueItem.id !== req.params.id);
    saveQueue();
    removeFiles(item.photoPaths.map(filename => path.join(uploadDir, filename)));
    res.json({ success: true });
});

app.use('/uploads', express.static(uploadDir));

app.get('/api/tunnel-info', (req, res) => {
    res.json({ url: tunnelUrl, qr: tunnelQrDataUrl });
});

app.use((error, req, res, next) => {
    removeFiles((req.files || []).map(file => file.path));
    if (res.headersSent) return next(error);

    if (error instanceof multer.MulterError) {
        const message = error.code === 'LIMIT_FILE_SIZE'
            ? 'Each photo must be 12 MB or smaller.'
            : `Upload rejected: ${error.message}`;
        return res.status(400).json({ error: message });
    }

    console.error('Unhandled request error:', error);
    res.status(error.statusCode || 500).json({ error: error.message || 'Unexpected server error.' });
});

async function setTunnelUrl(baseUrl) {
    const phoneUrl = new URL('/camera.html', baseUrl);
    phoneUrl.searchParams.set('token', accessToken);
    const protectedUrl = phoneUrl.toString();
    const qrDataUrl = await QRCode.toDataURL(protectedUrl);
    if (!cloudflaredProcess) return;
    tunnelUrl = protectedUrl;
    tunnelQrDataUrl = qrDataUrl;

    console.log('Phone QR is ready on the local main page.');
}

function startTunnel(listenPort) {
    console.log('Starting Cloudflare Tunnel...');
    const cloudflaredCli = path.join(__dirname, 'node_modules', 'cloudflared', 'lib', 'cloudflared.js');
    cloudflaredProcess = spawn(process.execPath, [cloudflaredCli, 'tunnel', '--url', `http://localhost:${listenPort}`]);
    let tunnelOutput = '';

    const handleOutput = data => {
        const output = data.toString();
        tunnelOutput = `${tunnelOutput}${output}`.slice(-8192);
        const match = tunnelOutput.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i);
        if (match && !tunnelUrl) setTunnelUrl(match[0]).catch(error => console.error('Could not create QR code:', error));
    };

    cloudflaredProcess.stdout.on('data', handleOutput);
    cloudflaredProcess.stderr.on('data', handleOutput);
    cloudflaredProcess.on('error', error => {
        console.error('Could not start Cloudflare Tunnel:', error.message);
        tunnelUrl = '';
        tunnelQrDataUrl = '';
    });
    cloudflaredProcess.on('close', code => {
        console.log(`Cloudflare Tunnel closed with code ${code}`);
        cloudflaredProcess = null;
        tunnelUrl = '';
        tunnelQrDataUrl = '';
    });
}

function startServer(listenPort = port) {
    server = app.listen(listenPort, () => {
        console.log(`Auto-Lister app listening at http://localhost:${listenPort}`);
        startTunnel(listenPort);
    });
    return server;
}

async function shutdown() {
    if (cloudflaredProcess) cloudflaredProcess.kill();
    await closeBrowser();
    if (server) await new Promise(resolve => server.close(resolve));
}

if (require.main === module) {
    startServer();
    process.once('SIGINT', () => shutdown().finally(() => process.exit(0)));
    process.once('SIGTERM', () => shutdown().finally(() => process.exit(0)));
}

module.exports = { app, maxFileSize, maxPhotos, tokensMatch };
