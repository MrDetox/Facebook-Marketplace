// --- Camera Logic ---
const video = document.getElementById('cameraStream');
const captureBtn = document.getElementById('captureBtn');
const shutterLabel = document.getElementById('shutterLabel');
const nativeCameraInput = document.getElementById('nativeCameraInput');
const doneBtn = document.getElementById('doneBtn');
const finishBtn = document.getElementById('finishBtn');
const backBtn = document.getElementById('backBtn');
const gallery = document.getElementById('cameraGallery');
const currentGroupCountSpan = document.getElementById('currentGroupCount');
const nativeInfo = document.getElementById('nativeInfo');
const proBtn = document.getElementById('proBtn');
const highQualCameraInput = document.getElementById('highQualCameraInput');

let currentStream = null;
let currentPhotos = []; // Array of blobs

async function initCamera() {
    // If we're on HTTP or an unsupported browser, we don't even try getUserMedia
    // to avoid scary permission/security errors if unnecessary.
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || (location.protocol !== 'https:' && location.hostname !== 'localhost' && !location.hostname.endsWith('.localliner.io'))) {
        showFallback();
        return;
    }

    // Stop existing stream if any to avoid locked resources
    stopCamera();

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' } // Prefer back camera
        });
        currentStream = stream;
        video.srcObject = stream;

        // Use JS Shutter if we have the stream
        captureBtn.style.display = 'block';
        shutterLabel.style.display = 'none';

        // Ensure video actually plays
        video.play().catch(e => console.warn("Video play failed:", e));
    } catch (err) {
        console.error("Error accessing camera stream:", err);
        showFallback();
    }
}

// Re-init camera when user comes back from native app
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        initCamera();
    }
});

function showFallback() {
    video.style.display = 'none';
    // Hide JS button, show the label that triggers the native camera input
    captureBtn.style.display = 'none';
    shutterLabel.style.display = 'flex';
    if (nativeInfo) nativeInfo.style.display = 'block';
}

function stopCamera() {
    if (currentStream) {
        currentStream.getTracks().forEach(track => track.stop());
    }
}

// Draw video frame to canvas and get Blob
async function takePhoto() {
    if (!currentStream) return;

    const canvas = document.createElement('canvas');
    // Use videoWidth/Height for the true resolution of the stream
    const w = video.videoWidth;
    const h = video.videoHeight;

    if (w === 0 || h === 0) {
        console.error("Video dimensions not ready");
        return;
    }

    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');

    console.log(`Capturing photo at ${w}x${h}`);
    ctx.drawImage(video, 0, 0, w, h);

    canvas.toBlob((blob) => {
        if (blob) {
            currentPhotos.push(blob);
            updateGalleryUI();

            // Visual feedback
            video.style.opacity = '0.3';
            setTimeout(() => video.style.opacity = '1', 100);
        }
    }, 'image/jpeg', 0.92); // Increased quality for better results on FB
}

function updateGalleryUI() {
    currentGroupCountSpan.textContent = currentPhotos.length;
    gallery.innerHTML = '';

    currentPhotos.forEach((blob, index) => {
        const img = document.createElement('img');
        img.src = URL.createObjectURL(blob);
        img.className = 'camera-thumb';

        // Optional: click to remove
        img.onclick = () => {
            currentPhotos.splice(index, 1);
            updateGalleryUI();
        };

        gallery.appendChild(img);
    });
}

// --- Event Listeners ---

captureBtn.addEventListener('click', takePhoto);

nativeCameraInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        Array.from(e.target.files).forEach(file => {
            currentPhotos.push(file);
        });
        updateGalleryUI();
    }
    // Reset so same file can be selected again
    e.target.value = '';
});

proBtn.addEventListener('click', () => {
    highQualCameraInput.click();
});

highQualCameraInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        Array.from(e.target.files).forEach(file => {
            currentPhotos.push(file);
        });
        updateGalleryUI();
    }
    // Reset
    e.target.value = '';
});

// Group photos into an item and save to server
doneBtn.addEventListener('click', async () => {
    if (currentPhotos.length === 0) {
        alert("Take some photos first!");
        return;
    }

    // UI Feedback
    const originalText = doneBtn.textContent;
    doneBtn.textContent = "Saving...";
    doneBtn.disabled = true;

    const formData = new FormData();
    currentPhotos.forEach((blob, idx) => {
        formData.append('photos', blob, `camera_${Date.now()}_${idx}.jpg`);
    });

    try {
        const response = await fetch('/api/queue', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) throw new Error("Upload failed");

        // Clear current state for next item
        currentPhotos = [];
        updateGalleryUI();

        // Brief success feedback
        doneBtn.textContent = "Saved!";
        setTimeout(() => {
            doneBtn.textContent = originalText;
            doneBtn.disabled = false;
        }, 1500);

    } catch (e) {
        console.error("Failed to save to Server:", e);
        alert("Failed to save item to server queue.");
        doneBtn.textContent = originalText;
        doneBtn.disabled = false;
    }
});

function goBackToMain() {
    stopCamera();
    window.location.href = 'index.html';
}

finishBtn.addEventListener('click', () => {
    if (currentPhotos.length > 0) {
        const res = confirm("You have unsaved photos for current item. Discard them?");
        if (!res) return;
    }
    goBackToMain();
});

backBtn.addEventListener('click', () => {
    goBackToMain();
});

// --- Initialization ---
window.addEventListener('DOMContentLoaded', async () => {
    try {
        initCamera();
    } catch (e) {
        console.error("App init failed", e);
    }
});
