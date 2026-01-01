// Nodejs dependencies
const fs = require('fs');
const http = require('http');

// Local classes
const HotsReplayUploader = require('../hots-replay-uploader.js');

class HotsApiUploader extends HotsReplayUploader {

    static upload(replayFilePath) {
        return new Promise((resolve, reject) => {
            try {
                const fileStream = fs.createReadStream(replayFilePath);
                const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substr(2, 9);
                
                const options = {
                    hostname: 'hotsapi.net',
                    port: 80,
                    path: '/api/v1/replays',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'multipart/form-data; boundary=' + boundary
                    }
                };
                
                const req = http.request(options, (response) => {
                    let data = '';
                    response.on('data', (chunk) => {
                        data += chunk;
                    });
                    response.on('end', () => {
                        try {
                            const result = JSON.parse(data);
                            if (!result.success) {
                                reject(new Error("Upload failed"));
                                return;
                            }
                            switch (result.status) {
                                default:
                                    resolve("success");
                                    return;
                                case "CustomGame":
                                    resolve("custom-game");
                                    return;
                                case "Duplicate":
                                    resolve("duplicate");
                                    return;
                            }
                        } catch (error) {
                            reject(error);
                        }
                    });
                });
                
                req.on('error', (error) => {
                    reject(error);
                });
                
                // Write multipart form data
                req.write('--' + boundary + '\r\n');
                req.write('Content-Disposition: form-data; name="file"; filename="' + 
                    replayFilePath.split(/[\\\/]/).pop() + '"\r\n');
                req.write('Content-Type: application/octet-stream\r\n\r\n');
                
                fileStream.pipe(req);
                
                fileStream.on('end', () => {
                    req.write('\r\n--' + boundary + '--\r\n');
                    req.end();
                });
            } catch (error) {
                reject(error);
            }
        });
    }

};

module.exports = HotsApiUploader;module.exports = HotsApiUploader;
