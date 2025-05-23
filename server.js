const fs = require('fs');
const https = require('https');
const express = require('express');
const socketIo = require('socket.io');
const path = require('path');
const mediasoupHandler = require('./mediasoup-handler');
const socketHandler = require('./socket-handler');

const app = express();

// SSL certificate configuration
// Ensure key.pem and cert.pem are in the root directory or update path
// Or use environment variables for production
const options = {
  key: fs.readFileSync(process.env.SSL_KEY_FILE || 'key.pem'),
  cert: fs.readFileSync(process.env.SSL_CERT_FILE || 'cert.pem')
};

const server = https.createServer(options, app);
const io = socketIo(server, {
  // Optional: Configure Socket.IO options if needed
  // Example for CORS if client is on a different port/domain during development:
  // cors: {
  //   origin: "http://localhost:3001", // Adjust to your client's URL
  //   methods: ["GET", "POST"]
  // }
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // Listen on all available network interfaces

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Optional: A catch-all route for Single Page Applications (SPAs)
// This sends index.html for any routes not handled by static files or other routes.
// Ensure this is placed after static middleware and other specific routes.
app.get('*', (req, res, next) => {
  // Exclude Socket.IO paths
  if (req.path.startsWith('/socket.io/')) {
    return next();
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function main() {
  try {
    // Start Mediasoup
    // mediasoupHandler will internally create and manage the worker and router
    await mediasoupHandler.startMediasoup();

    // Initialize Socket.IO event handling
    // Pass the io instance to socketHandler, which will use mediasoupHandler for mediasoup operations
    socketHandler.initSocketHandler(io);

    server.listen(PORT, HOST, () => {
      console.log(`Server listening on https://${HOST}:${PORT}`);
      if (HOST === '0.0.0.0') {
        console.log(`  => Local:   https://localhost:${PORT}`);
        // Attempt to find a local network IP for convenience
        try {
          const { networkInterfaces } = require('os');
          const nets = networkInterfaces();
          for (const name of Object.keys(nets)) {
            for (const net of nets[name]) {
              // Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses
              if (net.family === 'IPv4' && !net.internal) {
                console.log(`  => Network: https://${net.address}:${PORT}`);
                break;
              }
            }
          }
        } catch (e) {
          // ignore, just a helper
        }
      }
      // Attempt to get announced IP more robustly after router is initialized
      let announcedIp = process.env.ANNOUNCED_IP;
      if (!announcedIp) {
        try {
            const router = mediasoupHandler.getRouter();
            // Check if router and its properties exist before accessing them
            if (router && router.appData && router.appData.listenInfos && router.appData.listenInfos[0] && router.appData.listenInfos[0].announcedIp) {
                 announcedIp = router.appData.listenInfos[0].announcedIp;
            } else if (router && router.rtpCapabilities) { // Fallback check, less direct
                 announcedIp = 'using default or router not fully initialized for IP';
            }
             else {
                announcedIp = '127.0.0.1 (default, router not fully ready for IP inspection yet)';
            }
        } catch (e) {
            announcedIp = '127.0.0.1 (default, error fetching router info)';
        }
      }
       console.log(`Mediasoup ANNOUNCED_IP is configured via environment or defaults to: ${process.env.ANNOUNCED_IP || '127.0.0.1'}`);
      console.log('Ensure client is configured to connect to this server address and port.');
      console.log('SSL certificate files are expected to be "key.pem" and "cert.pem" in the root directory, or specify SSL_KEY_FILE and SSL_CERT_FILE env vars.');

    });

  } catch (err) {
    console.error('FATAL ERROR: Failed to start the server or mediasoup:', err);
    process.exit(1);
  }
}

main();