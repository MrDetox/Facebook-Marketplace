const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');

async function researchItem(photoPaths, aiPhotoIndex = 0) {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    // Prepare only the specified image for Gemini to save tokens/focus
    const selectedPhoto = photoPaths[aiPhotoIndex] || photoPaths[0];
    const imageParts = [
        {
            inlineData: {
                data: Buffer.from(fs.readFileSync(selectedPhoto)).toString("base64"),
                mimeType: "image/jpeg"
            }
        }
    ];

    const prompt = `
        You are an assistant helping a regular person list items on Facebook Marketplace.
        I am providing you with photos of an item I want to sell. 
        Analyze the images and provide the following details about the item so I can list it automatically.
        
        CRITICAL: The description must sound like an everyday person selling a personal item. It must be short, sweet, practical, and conversational. Do NOT use marketing fluff, artistic analysis, dramatic adjectives (e.g., "stunning", "dive into"), or press-release language. 
        
        Respond STRICTLY in the following JSON format without any markdown or extra text:
        {
        "title": "A clear, accurate title including brand/author and format (max 100 characters)",
        "price": "A competitive price based on what this usually sells for used (JUST THE NUMBER)",
        "category": "The most specific Facebook Marketplace category possible for this exact item (e.g., 'Skateboards & roller skates', 'Women\\'s fragrances', 'Living room furniture'). Do NOT use broad, generic buckets like 'Sporting Goods' or 'Electronics'.",
        "condition": "Use exact text: 'New', 'Used - like new', 'Used - good', or 'Used - fair'",
        "description": "A brief, casual description in the first person. FORMATTING RULE: You MUST separate the text into 3 distinct paragraphs using the literal escaped characters '\\\\n\\\\n' (do NOT use actual raw line breaks). Paragraph 1: Introduce the item. Paragraph 2: State the condition, flaws, and a relatable reason for selling. Paragraph 3: Exactly 'Collection from LS6, Holborn Approach street'."        }
    `;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [prompt, ...imageParts],
        });

        let text = response.text;
        // Clean up markdown quotes if Gemini accidentally adds them
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();

        const details = JSON.parse(text);
        return details;

    } catch (error) {
        console.error("AI Research Error:", error);
        throw new Error("Failed to analyze images with AI. Check API key and quota.");
    }
}

module.exports = { researchItem };
