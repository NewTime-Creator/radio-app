const { Octokit } = require('@octokit/rest');
const config = require('./config');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const octokit = new Octokit({
  auth: config.github.token
});

class UploadService {
  async uploadToGitHub(fileBuffer, originalName, folder = 'songs') {
    try {
      const fileExt = path.extname(originalName);
      const baseName = path.basename(originalName, fileExt);
      const sanitizedName = baseName.replace(/[^a-zA-Z0-9-_]/g, '_');
      const fileName = `${folder}_${sanitizedName}_${uuidv4().slice(0, 8)}${fileExt}`;

      console.log(`📤 Качване на ${fileName} към GitHub...`);

      const { data: release } = await octokit.repos.getReleaseByTag({
        owner: config.github.owner,
        repo: config.github.repo,
        tag: config.github.releaseTag
      });

      await octokit.repos.uploadReleaseAsset({
        owner: config.github.owner,
        repo: config.github.repo,
        release_id: release.id,
        name: fileName,
        data: fileBuffer,
        headers: {
          'content-type': 'audio/mpeg',
          'content-length': fileBuffer.length
        }
      });

      const downloadUrl = `https://github.com/${config.github.owner}/${config.github.repo}/releases/download/${config.github.releaseTag}/${fileName}`;

      console.log(`✅ Файлът е качен: ${downloadUrl}`);
      return downloadUrl;

    } catch (error) {
      console.error('❌ Грешка при качване:', error);
      if (error.status === 404) {
        throw new Error(`Release "${config.github.releaseTag}" не съществува!`);
      } else if (error.status === 401) {
        throw new Error('Невалиден GitHub token!');
      }
      throw new Error(`GitHub грешка: ${error.message}`);
    }
  }

  async getAudioDuration(fileBuffer) {
    return new Promise((resolve) => {
      try {
        const ffmpeg = require('fluent-ffmpeg');
        const { Readable } = require('stream');
        
        const stream = new Readable();
        stream.push(fileBuffer);
        stream.push(null);

        ffmpeg(stream).ffprobe((err, metadata) => {
          if (err) {
            resolve(null);
          } else {
            resolve(Math.round(metadata.format.duration));
          }
        });
      } catch (error) {
        resolve(null);
      }
    });
  }

  async ensureRelease() {
    try {
      await octokit.repos.getReleaseByTag({
        owner: config.github.owner,
        repo: config.github.repo,
        tag: config.github.releaseTag
      });
      console.log(`✅ Release ${config.github.releaseTag} съществува`);
    } catch (error) {
      console.log(`📦 Създаване на Release ${config.github.releaseTag}...`);
      await octokit.repos.createRelease({
        owner: config.github.owner,
        repo: config.github.repo,
        tag_name: config.github.releaseTag,
        name: `Media Files ${config.github.releaseTag}`,
        body: 'Radio media storage',
        draft: false,
        prerelease: false
      });
      console.log('✅ Release създаден!');
    }
  }
}

module.exports = new UploadService();