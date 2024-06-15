// for github build workflow, extract version to use in build name

const fs = require('fs');
const path = require('path');

if (process.env.GITHUB_ENV) {
    // Read package.json
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));

    // Get the version from package.json
    const version = packageJson.version || `manual-${new Date().toISOString().replace(/[:.]/g, '-')}`;

    // Write the version to GITHUB_ENV file for further steps
    fs.appendFileSync(process.env.GITHUB_ENV, `TAG_NAME=${version}\n`);

    console.log(`Extracted version: ${version}`);
}
