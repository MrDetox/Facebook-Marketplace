const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function uploadToFacebook(photoPaths, listingDetails) {
    const username = process.env.FB_USERNAME;
    const password = process.env.FB_PASSWORD;

    if (!username || !password) {
        throw new Error("Facebook credentials missing in .env");
    }

    // Launch persistent browser context
    const userDataDir = path.join(__dirname, 'browser_data');
    if (!fs.existsSync(userDataDir)) {
        fs.mkdirSync(userDataDir);
    }

    console.log(`Launching persistent browser context from: ${userDataDir}`);
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        // Standard user agent to avoid being easily blocked
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    // Get the first default page from persistent context
    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

    try {
        // 1. Check Login Status
        console.log("Navigating to Facebook...");
        await page.goto('https://www.facebook.com/');

        // Handle cookie consent popup
        try {
            console.log("Checking for cookie consent popup...");
            // Wait up to 5 seconds for the button, as it might fade in
            const allowCookiesBtn = await page.getByRole('button', { name: /allow all cookies/i }).first();
            if (await allowCookiesBtn.isVisible({ timeout: 5000 })) {
                console.log("Found cookie consent popup. Clicking 'Allow all cookies'...");
                await allowCookiesBtn.click();
                await page.waitForTimeout(2000); // Wait for the modal to close and page to stabilize
            }
        } catch (e) {
            console.log("No cookie consent popup found or needed.");
        }

        // Check if login fields exist
        const isLoginFormVisible = await page.isVisible('#email');
        if (isLoginFormVisible) {
            console.log("Not logged in. Entering credentials, but you may need to complete 2FA manually.");
            await page.fill('#email', username);
            await page.fill('#pass', password);
            await page.click('[name="login"]');

            // Wait for main page to load
            try {
                // we'll wait 15 seconds. If that fails, tell user to login manually.
                await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 });
            } catch (e) {
                console.log("Waiting for manual login/2FA completion... Please log in on the opened browser.");
                // Wait indefinitely until the user navigates away from the login page
                await page.waitForURL('**/facebook.com/**', { timeout: 0 });
            }
        }

        // 2. Navigate to Marketplace Create item
        console.log("Navigating to Marketplace Create...");
        await page.goto('https://www.facebook.com/marketplace/create/item', { waitUntil: 'load' });

        // Note: Facebook's DOM changes frequently. We use generic/aria selectors where possible.

        // 3. Upload Photos
        console.log("Uploading photos...");
        const fileInputSelector = 'input[type="file"][accept*="image"]';
        await page.waitForSelector(fileInputSelector, { state: 'attached' });
        // Since input is usually hidden, we just use setInputFiles

        const absolutePhotoPaths = photoPaths.map(p => path.resolve(p));
        await page.setInputFiles(fileInputSelector, absolutePhotoPaths);

        // Wait a moment for photos to process
        await page.waitForTimeout(3000);

        // 4. Fill Title
        console.log("Filling Title...");
        const titleInput = await page.getByLabel('Title', { exact: true });
        if (await titleInput.isVisible()) {
            await titleInput.fill(listingDetails.title);
        }

        // 5. Fill Price
        console.log("Filling Price...");
        const priceInput = await page.getByLabel('Price', { exact: true });
        if (await priceInput.isVisible()) {
            await priceInput.fill(listingDetails.price.toString());
        }

        // 6. Select Category
        console.log('Filling Category...');
        try {
            await page.fill('input[aria-label="Category"]', listingDetails.category);
            await page.waitForTimeout(1500);

            // Wait for the listbox (the dropdown container) to appear
            await page.getByRole('listbox').first().waitFor({ timeout: 5000 });
            await page.waitForTimeout(500);

            const options = await page.evaluate(() => {
                const listbox = document.querySelector('[role="listbox"]');
                if (!listbox) return [];
                // Collect text from all rows/options
                return Array.from(listbox.querySelectorAll('[role="option"], [role="presentation"]'))
                    .map(el => el.innerText.trim())
                    .filter(txt => txt.length > 0 && !txt.includes('\n'));
            });

            console.log(`Found ${options.length} category suggestions:`, options);

            const bestIndex = findBestCategoryIndex(listingDetails.category, options);
            console.log(`Best category match index: ${bestIndex} (${options[bestIndex]})`);

            // Click the matched option
            const listbox = page.getByRole('listbox').first();
            await listbox.getByText(options[bestIndex], { exact: true }).first().click();
        } catch (catError) {
            console.error(`Could not auto-fill category. Error: ${catError.message}`);
            // Fallback: try to just press Enter if we can't find the dropdown
            await page.keyboard.press('Enter');
        }

        // 7. Select Condition
        console.log("Filling Condition...");
        try {
            const conditionDropdown = await page.getByLabel('Condition', { exact: true });
            await conditionDropdown.click();
            await page.waitForTimeout(1000);

            const textToMatch = listingDetails.condition.toLowerCase().replace(/[^a-z0-9]/g, '.*');
            const conditionRegex = new RegExp(textToMatch, 'i');
            const conditionOption = page.getByRole('option', { name: conditionRegex }).first();

            if (await conditionOption.isVisible()) {
                await conditionOption.click();
            } else {
                console.log(`Could not find condition matching: ${listingDetails.condition}`);
            }
        } catch (e) {
            console.log("Could not auto-fill condition. Error:", e.message);
        }

        // 8. Check Description visibility and Click "More details" if needed
        console.log("Checking Description visibility...");
        try {
            const descriptionInput = page.getByLabel('Description', { exact: true });
            const isDescriptionVisible = await descriptionInput.isVisible({ timeout: 2000 }).catch(() => false);

            if (!isDescriptionVisible) {
                console.log("Description box not visible. Looking for 'More details' button...");
                const moreDetailsBtn = page.getByRole('button', { name: /More details/i }).first();
                if (await moreDetailsBtn.isVisible({ timeout: 3000 })) {
                    console.log("Clicking 'More details' button...");
                    await moreDetailsBtn.click();
                    // Wait for it to expand
                    await page.waitForTimeout(2000);
                } else {
                    console.log("'More details' button not found or already expanded.");
                }
            } else {
                console.log("Description box is already visible.");
            }
        } catch (e) {
            console.log("Error during 'More details' check:", e.message);
        }

        // 9. Fill Description
        console.log("Filling Description...");
        try {
            const descriptionInput = await page.getByLabel('Description', { exact: true });
            if (await descriptionInput.isVisible()) {
                await descriptionInput.fill(listingDetails.description);
            }
        } catch (e) {
            console.log("Could not fill description. Error:", e.message);
        }

        // 10. Hide from friends toggle
        try {
            console.log("Toggling Hide from Friends...");
            const hideFriendsContainer = page.locator('div').filter({ hasText: /^Hide from friends$/ }).first();
            const switchCheckbox = hideFriendsContainer.locator('..').locator('..').locator('input[role="switch"][type="checkbox"]').first();

            if (await switchCheckbox.count() > 0) {
                const isChecked = await switchCheckbox.evaluate(node => node.checked || node.getAttribute('aria-checked') === 'true');
                if (!isChecked) {
                    await switchCheckbox.click({ force: true });
                    console.log("Toggled 'Hide from friends' ON.");
                } else {
                    console.log("'Hide from friends' is already ON.");
                }
            } else {
                const hideText = page.getByText('Hide from friends', { exact: false }).first();
                if (await hideText.isVisible()) {
                    await hideText.click();
                    console.log("Toggled 'Hide from friends' via text label.");
                }
            }
        } catch (e) {
            console.log("Could not find 'Hide from friends' toggle. Error:", e.message);
        }

        console.log("Draft complete! Leaving browser open for user to review and hit Publish.");

    } catch (error) {
        console.error("Playwright Error:", error);
        throw error;
    }
}

/**
 * Robust string matching for categories
 */
function findBestCategoryIndex(target, options) {
    if (!options || options.length === 0) return 0;

    const stopWords = new Set(['and', 'for', 'with', 'the', 'a', 'an', 'of', 'in', 'to', 'from', 'at', 'by', 'other']);

    const normalize = (str) => {
        return str.toLowerCase()
            .replace(/&/g, 'and')
            .replace(/[^\w\s]/g, '') // strip punctuation
            .replace(/\s+/g, ' ')
            .trim();
    };

    const targetNorm = normalize(target);
    const optionsNorm = options.map(normalize);

    // 1. Exact Match
    const exactIdx = optionsNorm.indexOf(targetNorm);
    if (exactIdx !== -1) return exactIdx;

    // 2. Substring Match (Case Insensitive)
    for (let i = 0; i < optionsNorm.length; i++) {
        if (optionsNorm[i].includes(targetNorm) || targetNorm.includes(optionsNorm[i])) {
            return i;
        }
    }

    // 3. Token Overlap Score (Handling Plurals/Stemming)
    const stem = (word) => (word.endsWith('s') && word.length > 3) ? word.slice(0, -1) : word;
    const getTokens = (str) => normalize(str).split(' ')
        .filter(w => !stopWords.has(w))
        .map(stem);

    const targetTokens = getTokens(target);
    let bestScore = -1;
    let bestIdx = 0;

    options.forEach((opt, idx) => {
        const optTokens = getTokens(opt);
        let overlap = 0;

        targetTokens.forEach(t => {
            if (optTokens.includes(t)) overlap++;
        });

        if (overlap > bestScore) {
            bestScore = overlap;
            bestIdx = idx;
        }
    });

    if (bestScore > 0) return bestIdx;

    // 4. Fuzzy / Levenshtein Distance
    const editDistance = (s1, s2) => {
        let costs = [];
        for (let i = 0; i <= s1.length; i++) {
            let lastValue = i;
            for (let j = 0; j <= s2.length; j++) {
                if (i === 0) costs[j] = j;
                else if (j > 0) {
                    let newValue = costs[j - 1];
                    if (s1.charAt(i - 1) !== s2.charAt(j - 1))
                        newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                    costs[j - 1] = lastValue;
                    lastValue = newValue;
                }
            }
            if (i > 0) costs[s2.length] = lastValue;
        }
        return costs[s2.length];
    };

    const similarity = (s1, s2) => {
        let longer = s1.length > s2.length ? s1 : s2;
        let shorter = s1.length > s2.length ? s2 : s1;
        if (longer.length === 0) return 1.0;
        return (longer.length - editDistance(longer, shorter)) / parseFloat(longer.length);
    };

    bestScore = 0;
    optionsNorm.forEach((opt, idx) => {
        const sim = similarity(targetNorm, opt);
        if (sim > bestScore) {
            bestScore = sim;
            bestIdx = idx;
        }
    });

    return bestIdx || 0;
}

module.exports = { uploadToFacebook };

