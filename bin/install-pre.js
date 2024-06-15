const os = require('os');
const fs = require('fs-extra');
const fetchr = import('node-fetch');
const path = require('path');

async function download(url, filePath) {
    const fetch = (await fetchr).default;

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
    }

    fs.ensureDir(path.dirname(filePath));
    const fileStream = fs.createWriteStream(filePath);

    return new Promise((resolve, reject) => {
        response.body.pipe(fileStream);
        response.body.on('error', reject);
        fileStream.on('error', error => {
            console.log({ error });
        });
        fileStream.on('finish', () => {
            resolve();
        });
    });
}

async function main() {
    console.log('npm pre running');

    await download(
        "https://static.grid.space/gapp/manifold.js",
        path.join("src", "ext", "manifold.js")
    );

    await download(
        "https://static.grid.space/gapp/manifold.wasm",
        path.join("src", "wasm", "manifold.wasm")
    );

    const links = fs.readFileSync("links.csv")
        .toString()
        .split('\n')
        .map(line => line.split(','));

    console.log({ links, platform: os.platform() });

    if (os.platform() === 'win32')
    for (let [ link, target ] of links) {
        try {
            console.log('unlink', link)
            // Remove existing link if it exists
            if (fs.existsSync(link)) {
                fs.unlinkSync(link);
            }
            // Create the symlink
            console.log(`symlink: ${link} -> ${target}`);
            fs.symlinkSync(target, link, 'junction'); // 'junction' is used for directories on Windows
        } catch (err) {
            console.error(`Error creating symlink: ${link} -> ${target}`, err);
        }
    }
}

main().catch(err => console.error('Error', err));
