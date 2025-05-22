const fs = require('fs');
const https = require('https');
const express = require('express');
const socketIo = require('socket.io');
const mediasoup = require('mediasoup');
const path = require('path');

const app = express();
const server = https.createServer({
  key: fs.readFileSync('key.pem'),
  cert: fs.readFileSync('cert.pem')
}, app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// Serve static files from public
app.use(express.static(path.join(__dirname, 'public')));

// Mediasoup variables
let worker;
let router;
const peers = new Map(); // socketId => { transports, producers, consumers }

async function startMediasoup() {
  worker = await mediasoup.createWorker();
  router = await worker.createRouter({
    mediaCodecs: [
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2
      },
      {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: {}
      }
    ]
  });
  console.log('Mediasoup worker and router created');
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  peers.set(socket.id, { transports: [], producers: [], consumers: [] });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    // Cleanup
    const peer = peers.get(socket.id);
    if (peer) {
      peer.transports.forEach(t => t.close());
      peer.producers.forEach(p => p.close());
      peer.consumers.forEach(c => c.close());
    }
    peers.delete(socket.id);
  });

  // --- mediasoup signaling events will go here ---

  socket.on('getRtpCapabilities', (cb) => {
    cb(router.rtpCapabilities);
  });

  socket.on('createWebRtcTransport', async (cb) => {
    try {
      const transport = await router.createWebRtcTransport({
        listenIps: [{ ip: '0.0.0.0', announcedIp: '192.168.2.7' }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
      });
      transport.appType = 'send'; // Tag as send transport
      peers.get(socket.id).transports.push(transport);
      cb({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      });

      transport.on('dtlsstatechange', (state) => {
        if (state === 'closed') transport.close();
      });
    } catch (err) {
      cb({ error: err.message });
    }
  });

  socket.on('connectTransport', async ({ transportId, dtlsParameters }, cb) => {
    const transport = peers.get(socket.id).transports.find(t => t.id === transportId);
    if (!transport) return cb({ error: 'Transport not found' });
    await transport.connect({ dtlsParameters });
    cb({ connected: true });
  });

  socket.on('produce', async ({ transportId, kind, rtpParameters }, cb) => {
    const transport = peers.get(socket.id).transports.find(t => t.id === transportId);
    if (!transport) return cb({ error: 'Transport not found' });
    const producer = await transport.produce({ kind, rtpParameters });
    peers.get(socket.id).producers.push(producer);
    cb({ id: producer.id });
    // Inform other peers
    socket.broadcast.emit('newProducer', { socketId: socket.id, producerId: producer.id, kind });
  });

  socket.on('consume', async ({ producerId, rtpCapabilities }, cb) => {
    if (!router.canConsume({ producerId, rtpCapabilities })) {
      return cb({ error: 'Cannot consume' });
    }
    const peer = peers.get(socket.id);
    const transport = peer.transports.find(t => t.appType === 'recv');
    if (!transport) return cb({ error: 'No receiving transport found' });
    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
      paused: false,
    });
    await consumer.resume();
    peer.consumers.push(consumer);
    cb({
      id: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
    });
  });

  socket.on('getProducers', (cb) => {
    const producerList = [];
    for (const [id, peer] of peers.entries()) {
      if (id !== socket.id) {
        for (const producer of peer.producers) {
          producerList.push({ socketId: id, producerId: producer.id, kind: producer.kind });
        }
      }
    }
    cb(producerList);
  });

  socket.on('createRecvTransport', async (cb) => {
    try {
      const transport = await router.createWebRtcTransport({
        listenIps: [{ ip: '0.0.0.0', announcedIp: '192.168.2.7' }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
      });
      transport.appType = 'recv'; // Tag as recv transport
      peers.get(socket.id).transports.push(transport);
      cb({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      });

      transport.on('dtlsstatechange', (state) => {
        if (state === 'closed') transport.close();
      });
    } catch (err) {
      cb({ error: err.message });
    }
  });
});

startMediasoup().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    console.log('If you are on a LAN, open http://YOUR_LAN_IP:3000 on other devices.');
  });
}); 