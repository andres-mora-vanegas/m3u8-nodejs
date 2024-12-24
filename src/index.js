const axios = require('axios');
const { Parser } = require('m3u8-parser');
const fs = require('fs-extra');
const path = require('path');
const url = require('url');
const ffmpeg = require('fluent-ffmpeg');
const { videoList } = require('./config');

// Create base directories
const BASE_DOWNLOAD_DIR = path.join(process.cwd(), 'downloads');
const TEMP_DIR = path.join(BASE_DOWNLOAD_DIR, 'temp');

async function downloadSegmentWithRetry(url, filename, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await axios({
                method: 'get',
                url: url,
                responseType: 'stream'
            });

            await new Promise((resolve, reject) => {
                const writer = fs.createWriteStream(filename);
                response.data.pipe(writer);
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            return true;
        } catch (error) {
            console.error(`Attempt ${attempt} failed for ${url}: ${error.message}`);
            if (attempt === maxRetries) {
                throw new Error(`Failed to download segment after ${maxRetries} attempts`);
            }
            // Wait for 1 second before retrying
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

async function joinTsFiles(segmentFiles, outputFile) {
    return new Promise(async (resolve, reject) => {
        try {
            // Create a temporary file listing all segments
            const listFile = path.join(path.dirname(outputFile), 'files.txt');
            const fileContent = segmentFiles
                .map(file => `file '${file.replace(/'/g, "'\\''")}'`)
                .join('\n');
            
            await fs.writeFile(listFile, fileContent);

            // Create FFmpeg command using concat demuxer
            const command = ffmpeg()
                .input(listFile)
                .inputOptions(['-f', 'concat', '-safe', '0'])
                .output(outputFile)
                .outputOptions('-c copy');

            command
                .on('end', async () => {
                    console.log('Files have been successfully joined');
                    // Clean up the list file
                    await fs.remove(listFile);
                    resolve();
                })
                .on('error', async (err) => {
                    console.error('Error joining files:', err);
                    // Clean up the list file
                    await fs.remove(listFile);
                    reject(err);
                });

            // Run the command
            command.run();
        } catch (error) {
            reject(error);
        }
    });
}

async function checkExistingSegments(outputDir, totalSegments) {
    const existingFiles = [];
    for (let i = 0; i < totalSegments; i++) {
        const filename = path.join(outputDir, `segment_${i}.ts`);
        if (await fs.pathExists(filename)) {
            existingFiles.push(filename);
        }
    }
    return existingFiles;
}

async function downloadM3U8(videoInfo) {
    const { url: m3u8Url, name } = videoInfo;
    const videoDir = path.join(BASE_DOWNLOAD_DIR, name);
    const tempDir = path.join(TEMP_DIR, name);

    try {
        // Create directories if they don't exist
        await fs.ensureDir(videoDir);
        await fs.ensureDir(tempDir);

        // Download M3U8 file
        const response = await axios.get(m3u8Url);
        const parser = new Parser();
        parser.push(response.data);
        parser.end();

        const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
        const segments = parser.manifest.segments;

        console.log(`[${name}] Found ${segments.length} segments in total`);

        // Check for existing segments
        const existingFiles = await checkExistingSegments(tempDir, segments.length);
        console.log(`[${name}] Found ${existingFiles.length} existing segments`);

        const segmentFiles = [];

        // Download missing segments
        for (let i = 0; i < segments.length; i++) {
            const filename = path.join(tempDir, `segment_${i}.ts`);
            
            if (existingFiles.includes(filename)) {
                console.log(`[${name}] Segment ${i + 1}/${segments.length} already exists, skipping...`);
                segmentFiles.push(filename);
                continue;
            }

            const segment = segments[i];
            const segmentUrl = url.resolve(baseUrl, segment.uri);
            segmentFiles.push(filename);

            console.log(`[${name}] Downloading segment ${i + 1}/${segments.length}`);
            await downloadSegmentWithRetry(segmentUrl, filename);
        }

        console.log(`[${name}] All segments are ready!`);

        // Join the segments into a single MP4 file
        const outputFile = path.join(videoDir, `${name}.mp4`);
        
        // Check if output file already exists
        if (await fs.pathExists(outputFile)) {
            console.log(`[${name}] Output file already exists. Removing...`);
            await fs.remove(outputFile);
        }

        console.log(`[${name}] Joining segments into MP4 file...`);
        await joinTsFiles(segmentFiles, outputFile);

        // Clean up: remove segment files
        console.log(`[${name}] Cleaning up temporary files...`);
        await fs.remove(tempDir);

        console.log(`[${name}] Process completed! Output file saved as: ${outputFile}`);
    } catch (error) {
        console.error(`[${name}] Error:`, error.message);
    }
}

async function processAllVideos() {
    try {
        // Create base directories
        await fs.ensureDir(BASE_DOWNLOAD_DIR);
        await fs.ensureDir(TEMP_DIR);

        // Process each video in the list
        for (const videoInfo of videoList) {
            console.log(`\nStarting download for: ${videoInfo.name}`);
            await downloadM3U8(videoInfo);
        }

        console.log('\nAll videos have been processed!');
    } catch (error) {
        console.error('Error processing videos:', error.message);
    }
}

// Start the download process
processAllVideos(); 