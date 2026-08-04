const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

process.env.ACCESS_TOKEN = 'test-access-token';

const { detectImageMime, normalizeListingDetails } = require('../ai_researcher');
const { findBestCategoryIndex } = require('../facebook_uploader');
const { app } = require('../server');

function request(server, pathname, headers = {}) {
    return new Promise((resolve, reject) => {
        const address = server.address();
        const req = http.request({
            host: '127.0.0.1',
            port: address.port,
            path: pathname,
            headers
        }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => resolve({ body, headers: response.headers, status: response.statusCode }));
        });
        req.on('error', reject);
        req.end();
    });
}

test('detects supported image signatures instead of trusting extensions', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-marketplace-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    const jpeg = path.join(directory, 'photo.txt');
    const invalid = path.join(directory, 'fake.jpg');
    fs.writeFileSync(jpeg, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    fs.writeFileSync(invalid, 'not an image');

    assert.equal(detectImageMime(jpeg), 'image/jpeg');
    assert.equal(detectImageMime(invalid), null);
});

test('normalizes and validates AI listing output', () => {
    const listing = normalizeListingDetails({
        title: 'Intermezzo by Sally Rooney hardback',
        price: '5.00',
        category: 'Books',
        condition: 'Used - good',
        description: 'Sally Rooney hardback copy.\\n\\nIn good used condition and selling after reading.\\n\\nCollection from LS6, Holborn Approach street.'
    });

    assert.equal(listing.description.split('\n\n').length, 3);
    assert.match(listing.description, /Collection from LS6, Holborn Approach street\.$/);
    assert.throws(() => normalizeListingDetails({ ...listing, price: '£5' }), /invalid price/);
});

test('matches the closest Facebook category', () => {
    assert.equal(findBestCategoryIndex('Books and magazines', ['Furniture', 'Books & magazines']), 1);
    assert.equal(findBestCategoryIndex('Books', []), 0);
});

test('requires the QR token for non-local requests', async t => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));

    const remoteHeaders = { Host: 'example.trycloudflare.com' };
    const denied = await request(server, '/api/queue', remoteHeaders);
    assert.equal(denied.status, 401);

    const spoofedLocalHost = await request(server, '/api/queue', {
        Host: 'localhost:3000',
        'CF-Connecting-IP': '203.0.113.10'
    });
    assert.equal(spoofedLocalHost.status, 401);

    const accepted = await request(server, '/?token=test-access-token', remoteHeaders);
    assert.equal(accepted.status, 302);
    assert.equal(accepted.headers.location, '/');

    const cookie = accepted.headers['set-cookie'][0].split(';')[0];
    const authorized = await request(server, '/api/queue', { ...remoteHeaders, Cookie: cookie });
    assert.equal(authorized.status, 200);
});
