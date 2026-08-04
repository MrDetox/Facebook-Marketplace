const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');

const collectionLine = 'Collection from LS6, Holborn Approach street.';
const allowedConditions = new Set(['New', 'Used - like new', 'Used - good', 'Used - fair']);
const listingSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        title: { type: 'string', description: 'Clear item title including author or brand and format when visible.' },
        price: { type: 'string', description: 'Competitive UK used price as digits only, with optional decimal places.' },
        category: { type: 'string', description: 'The most specific Facebook Marketplace category for the item.' },
        condition: { type: 'string', enum: [...allowedConditions] },
        description: { type: 'string', description: 'Exactly three short paragraphs separated by blank lines.' }
    },
    required: ['title', 'price', 'category', 'condition', 'description']
};

function detectImageMime(filePath) {
    const bytes = Buffer.alloc(16);
    const descriptor = fs.openSync(filePath, 'r');
    const length = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    fs.closeSync(descriptor);

    if (length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';

    const brand = length >= 12 ? bytes.toString('ascii', 8, 12) : '';
    if (['heic', 'heix', 'hevc', 'hevx'].includes(brand)) return 'image/heic';
    if (['heif', 'mif1', 'msf1'].includes(brand)) return 'image/heif';
    return null;
}

function normalizeListingDetails(details) {
    if (!details || typeof details !== 'object' || Array.isArray(details)) {
        throw new Error('AI returned an invalid listing.');
    }

    const title = String(details.title || '').trim();
    const price = String(details.price || '').trim();
    const category = String(details.category || '').trim();
    const condition = String(details.condition || '').trim();
    const description = String(details.description || '').replace(/\\n/g, '\n').trim();

    if (!title || title.length > 100) throw new Error('AI returned an invalid title.');
    if (!/^\d+(?:\.\d{1,2})?$/.test(price)) throw new Error('AI returned an invalid price.');
    if (!category) throw new Error('AI returned an invalid category.');
    if (!allowedConditions.has(condition)) throw new Error('AI returned an invalid condition.');

    const bodyParagraphs = description.split(/\n\s*\n/)
        .map(paragraph => paragraph.replace(/\s+/g, ' ').trim())
        .filter(paragraph => paragraph && !/^collection\s+from\s+ls6\b/i.test(paragraph));

    if (bodyParagraphs.length < 2) throw new Error('AI returned an invalid description.');

    return {
        title,
        price,
        category,
        condition,
        description: `${bodyParagraphs[0]}\n\n${bodyParagraphs.slice(1).join(' ')}\n\n${collectionLine}`
    };
}

async function researchItem(photoPaths, aiPhotoIndex = 0) {
    const selectedPhoto = photoPaths[aiPhotoIndex] || photoPaths[0];
    if (!selectedPhoto) throw new Error('No image was provided for AI research.');

    const mimeType = detectImageMime(selectedPhoto);
    if (!mimeType) throw new Error('The selected file is not a supported image.');
    if (!process.env.GEMINI_API_KEY) throw new Error('Gemini API key is missing from .env.');

    const prompt = `You are helping a regular person create a UK Facebook Marketplace listing from an item photo.

Return the title, price, category, condition, and description. The title must include the visible brand or author and format where relevant, and must be no more than 100 characters. Price must be a competitive used price in GBP, expressed as digits only without a currency symbol. Choose the most specific Facebook Marketplace category available. Do not invent flaws or details that are not visible.

The description must sound casual and practical, with no marketing language. It must have exactly three paragraphs separated by blank lines. Paragraph 1 introduces the item. Paragraph 2 states the visible condition and a simple reason for selling. Paragraph 3 must be exactly: ${collectionLine}`;

    try {
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const response = await ai.models.generateContent({
            model: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
            contents: [
                {
                    inlineData: {
                        data: fs.readFileSync(selectedPhoto, { encoding: 'base64' }),
                        mimeType
                    }
                },
                { text: prompt }
            ],
            config: {
                responseMimeType: 'application/json',
                responseJsonSchema: listingSchema
            }
        });

        return normalizeListingDetails(JSON.parse(response.text));
    } catch (error) {
        console.error('AI Research Error:', error);
        throw new Error('Failed to analyze the image with Gemini. Check the image, API key, and quota.', { cause: error });
    }
}

module.exports = { detectImageMime, normalizeListingDetails, researchItem };
