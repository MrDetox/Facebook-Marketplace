const { researchItem } = require('./ai_researcher');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config();

async function runTest() {
    console.log("Starting AI Researcher verification...");
    try {
        // Find first jpg in uploads
        const uploadsDir = path.join(__dirname, 'uploads');
        const files = fs.readdirSync(uploadsDir).filter(f => f.endsWith('.jpg'));

        if (files.length === 0) {
            console.error("No photos found in uploads/ to test with.");
            return;
        }

        const testPhoto = path.join('uploads', files[0]);
        console.log(`Testing with photo: ${testPhoto}`);

        const details = await researchItem([testPhoto], 0);
        console.log("SUCCESS! AI Research Result:");
        console.log(JSON.stringify(details, null, 2));
    } catch (err) {
        console.error("VERIFICATION FAILED:", err);
        process.exit(1);
    }
}

runTest();
